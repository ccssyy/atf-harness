import { stubEvalRound } from "./evalRoundStub.js";
/**
 * E5（链路收口 20261025）测试锚——授权件 cc08a7ccdb7ac343 三 H 验收锚：
 *
 *   H1（D139）training_overrides 随段命令 argv 下传（内核 b10 接线）——E4-乙补的
 *      「返回体 json＋next_step 指引 agent 走 atf_scratch_exec 直调生成器」主路径
 *      撤销：模型可见面（工具 description＋返回体全文）零 atf_scratch_exec 指引、
 *      零 training_overrides_json／training_overrides_next_step 键；返回体仅留
 *      delivery 对账键＋兼容说明（零指令性措辞）。
 *   H2（D142/D143）atf_evaluate 实例根显式传递——resolveEvalInstanceRoot 单源
 *      （ATF_HOME ＞ HOME ＞ 系统家 getpwuid 锚）；start 链内核子步 env 显式收
 *      HOME＝实例根（env 隔离下子步解析不漂移——实锚 genService 子步）；status
 *      返回体带 instance_root（实际解析根＋来源）。
 *   H3（D140）training_prep 段 output_dir 终值呈现——盘上 IterationConfig 的
 *      output.output_dir 单源（live＞legacy 双形态）；缺席按内核 ADR-0005 run 布局
 *      预期 join(runDir,"training") 标注来源；返回体与审批卡双呈现。
 *
 * mock 对端＝mock_pipeline_params.mjs（argv 回显）＋E5 专属 mini mock pin
 * （genService 落 child_home 实锚 env 传递；prelaunch 非零快出——零审批消耗）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPipelineTool,
  trainingOutputDirApprovalLine,
  trainingOutputDirOf,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import {
  buildEvalTools,
  evalStatus,
  resolveEvalInstanceRoot,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const fakeExec = { agent: undefined, callId: "e5-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } }
      : undefined),
});
const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
const toolOf = (record: string[] = []): DshToolLike => {
  const tool = buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike;
  return {
    ...tool,
    // 夹具建模「run 已在场」：管道只定位不建树（run 必属实验、register 段才 create_run），
    // 本套件断言 output_dir 终值/来源，不测落点创建。
    execute: async (args: unknown, exec: unknown) => {
      const a = args as { workspace_path?: unknown; run_id?: unknown };
      const ws = typeof a.workspace_path === "string" ? a.workspace_path : "";
      const runId = typeof a.run_id === "string" ? a.run_id : "";
      if (ws !== "" && runId !== "") mkdirSync(join(ws, "runs", runId), { recursive: true });
      return tool.execute(args, exec);
    },
  };
};

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

/** 落盘 IterationConfig（legacy 深层形态——内核 walkthrough 产出位）。 */
const writeIterationConfig = (runDir: string, outputDir: string): void => {
  mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
  writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), `${JSON.stringify({ schema_version: "IterationConfig/v1", output: { run_name: "r", output_dir: outputDir } } , null, 1)}\n`, "utf8");
};

// ══ H1（D139）：零 atf_scratch_exec——模型可见面撤注入指引 ══

describe("E5-H1 training_overrides 段命令直传（零 scratch 面）", () => {
  it("带 overrides 跑 training_prep：返回体全文零 atf_scratch_exec／training_overrides_json／next_step；argv 直传＋delivery 对账键在", async () => {
    const record: string[] = [];
    const ws = tempRoot("e5-ws-");
    const result = (await toolOf(record).execute(
      { stage: "training_prep", run_id: "e5-direct", workspace_path: ws, base_model_path: join(ws, "model"), training_overrides: { learning_rate: "2e-4", lora_rank: 32 } },
      fakeExec,
    )) as Record<string, unknown>;
    // argv 直传（段命令通路）
    const argv = summaryArgv(result);
    expect(argv).toContain("--training-overrides");
    expect(JSON.parse(argv[argv.indexOf("--training-overrides") + 1] ?? "{}")).toEqual({ learning_rate: "2e-4", lora_rank: 32 });
    // 零 scratch：返回体全文（JSON 序列化——含 note/兼容说明）零直调指引字样与旧键
    const fullText = JSON.stringify(result);
    expect(fullText).not.toContain("atf_scratch_exec");
    expect(fullText).not.toContain("training_overrides_json");
    expect(fullText).not.toContain("training_overrides_next_step");
    expect(result["training_overrides_delivery"]).toBe("segment_argv");
    // 兼容说明保留（零指令性措辞——只陈述历史形态已下线，不导流任何后续步骤）
    expect(String(result["training_overrides_note"])).toContain("已随本段命令直接下传");
  });

  it("工具参数面零 atf_scratch_exec 指引（模型可见 description 与参数描述同纪律）", () => {
    const tool = toolOf();
    expect(tool.description).not.toContain("atf_scratch_exec");
    const paramsText = JSON.stringify(tool.parameters);
    expect(paramsText).toContain("--training-overrides"); // 参数描述记载段命令直传通路
    expect(paramsText).not.toContain("atf_scratch_exec");
  });

  it("同 run 快照兜底重跑形态：快照九键构造随 argv 下传（全程零 scratch 断言同上）", async () => {
    const ws = tempRoot("e5-ws-");
    const runDir = join(ws, "runs", "e5-snap");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "config-snapshot.json"), `${JSON.stringify({ schema_version: "WebUiConfigSnapshot/v1", confirmed: { learning_rate: "1e-4", lora_rank: "32" } }, null, 1)}\n`, "utf8");
    const result = await toolOf().execute(
      { stage: "training_prep", run_id: "e5-snap", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(JSON.parse(argv[argv.indexOf("--training-overrides") + 1] ?? "{}")).toEqual({ learning_rate: "1e-4", lora_rank: 32 });
    expect(JSON.stringify(result)).not.toContain("atf_scratch_exec");
  });
});

// ══ H3（D140）：output_dir 终值呈现（落点可见） ══

describe("E5-H3 output_dir 终值呈现", () => {
  it("首跑无配置：审批卡行内核 run 布局预期＋返回体 output_dir=<runDir>/training（source=kernel_layout）", async () => {
    const record: string[] = [];
    const ws = tempRoot("e5-ws-");
    const result = (await toolOf(record).execute(
      { stage: "training_prep", run_id: "e5-layout", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    )) as Record<string, unknown>;
    const runDir = join(ws, "runs", "e5-layout");
    expect(result["output_dir"]).toBe(join(runDir, "training"));
    expect(result["output_dir_source"]).toBe("kernel_layout");
    expect(record.join("\n")).toContain("训练输出目录（output_dir）");
    expect(record.join("\n")).toContain(join(runDir, "training"));
    expect(record.join("\n")).toContain("段产出后以落盘终值为准");
  });

  it("重跑盘上配置在场：返回体与审批卡均呈现配置终值（source=iteration_config）——live＞legacy 双形态同序", async () => {
    const record: string[] = [];
    const ws = tempRoot("e5-ws-");
    const runDir = join(ws, "runs", "e5-term");
    writeIterationConfig(runDir, join(runDir, "training"));
    const result = (await toolOf(record).execute(
      { stage: "training_prep", run_id: "e5-term", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["output_dir"]).toBe(join(runDir, "training"));
    expect(result["output_dir_source"]).toBe("iteration_config");
    expect(record.join("\n")).toContain("盘上迭代配置终值");

    // live 形态优先：live 在场时 legacy 同在也读 live
    const runDirLive = join(ws, "runs", "e5-live");
    mkdirSync(join(runDirLive, "prep"), { recursive: true });
    writeFileSync(join(runDirLive, "prep", "iteration-config.json"), `${JSON.stringify({ output: { output_dir: join(runDirLive, "training") } })}\n`, "utf8");
    writeIterationConfig(runDirLive, "/stale/legacy/value");
    expect(trainingOutputDirOf(runDirLive)).toEqual({ outputDir: join(runDirLive, "training"), source: "iteration_config" });
  });

  it("纯函数锚：两形态缺席＝布局预期；output.output_dir 非串不采信（不猜值）", () => {
    const runDir = tempRoot("e5-ws-");
    expect(trainingOutputDirOf(runDir)).toEqual({ outputDir: join(runDir, "training"), source: "kernel_layout" });
    mkdirSync(join(runDir, "prep"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config.json"), JSON.stringify({ output: { output_dir: 123 } }));
    expect(trainingOutputDirOf(runDir)).toEqual({ outputDir: join(runDir, "training"), source: "kernel_layout" }); // 非串＝不采信
    expect(trainingOutputDirApprovalLine({ outputDir: "/x/training", source: "iteration_config" })).toContain("/x/training");
  });
});

// ══ H2（D142/D143）：atf_evaluate 实例根显式传递 ══

describe("E5-H2 实例根单源与子步 env 显式传递", () => {
  it("resolveEvalInstanceRoot 解析序：ATF_HOME ＞ HOME ＞ 系统家（getpwuid 锚——env -i 下仍解析）", () => {
    expect(resolveEvalInstanceRoot({ ATF_HOME: "/inst-root", HOME: "/isolated" })).toEqual({ root: "/inst-root", source: "atf_home_env" });
    expect(resolveEvalInstanceRoot({ HOME: "/isolated" })).toEqual({ root: "/isolated", source: "home_env" });
    // env -i 形态（HOME 缺席）：系统家单锚——不受进程 env 漂移影响
    expect(resolveEvalInstanceRoot({}, () => "/sys/real-home")).toEqual({ root: "/sys/real-home", source: "system_home" });
    // 空白串＝未设（trim 语义）
    expect(resolveEvalInstanceRoot({ ATF_HOME: "  ", HOME: "/h" }).source).toBe("home_env");
  });

  it("start 链内核子步 env 实锚：ATF_HOME 隔离下 genService 子步收 HOME＝实例根（子进程解析不漂移）", async () => {
    vi.stubEnv("ATF_HOME", "/e5-inst-root");
    vi.stubEnv("HOME", "/e5-isolated-home");
    const pin = tempRoot("e5-pin-");
    const scripts = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(pin, "skills", "atf-admit-training-data", "scripts"), { recursive: true });
    writeFileSync(join(pin, "skills", "atf-admit-training-data", "scripts", "render_prompt.py"), "# renderer\n");
    // genService mock：落 manifest 携 child_home（子进程实收 HOME——env 传递实锚面）
    writeFileSync(join(scripts, "generate_eval_service.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({
  "expected_model_names": ["test-awq-base"], "config_sha256": "a" * 64,
  "argv": ["vllm", "serve"], "request_defaults": {"port": 5031, "temperature": 0},
  "child_home": os.environ.get("HOME")}))
print(json.dumps({"out": out}))`);
    writeFileSync(join(scripts, "build_service_prelaunch_report.py"), "import sys\nsys.exit(1)\n"); // 非零快出——零审批消耗
    for (const stub of ["generate_checkpoint_plan.py", "generate_eval_orchestration.py", "run_formal_eval.py"]) {
      writeFileSync(join(scripts, stub), "# stub\n");
    }
    const runsRoot = tempRoot("e5-runs-");
    const runDir = join(runsRoot, "e5-env");
    mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
    writeFileSync(join(runDir, "experiment-setup", "field-config.json"), "{}\n");
    const adapterDir = join(runDir, "checkpoint-123");
    mkdirSync(adapterDir, { recursive: true }); // 固定编号 adapter 目录在场（validateFixedCheckpoint 前置校验）
    writeFileSync(join(adapterDir, "adapter_model.safetensors"), "x");
    const assets = tempRoot("e5-assets-");
    writeFileSync(join(assets, "test_images.json"), "[]\n");
    writeFileSync(join(assets, "eval_labels.jsonl"), "\n");
    const serviceConfig = tempRoot("e5-svc-");
    writeFileSync(join(serviceConfig, "svc.json"), JSON.stringify({ port: 5031, max_num_seqs: 4 }));
    const tools = buildEvalTools({ get: () => undefined }, { resolveEvalRound: stubEvalRound, runsRoot, logDir: tempRoot("e5-logs-"), kernelDir: pin }) as unknown as DshToolLike[];
    const evaluate = tools.find((t) => t.name === "atf_evaluate");
    if (evaluate === undefined) throw new Error("atf_evaluate 未注册");
    const result = (await evaluate.execute(
      { action: "start", run_id: "e5-env", adapter_path: adapterDir, eval_assets_dir: assets, field_config: join(runDir, "experiment-setup", "field-config.json"), service_config: join(serviceConfig, "svc.json"), env_profile: "torch291", lane: "goods", assets_external_confirm: true },
      fakeExec,
    )) as Record<string, unknown>;
    // prelaunch 快出（快败面在审批卡前）——genService 产物已落盘，child_home 实锚 env 传递
    expect(result["error"]).toBe("prelaunch_report_failed");
    const manifest = JSON.parse(readFileSync(join(String(result["eval_round"]), "service", "service_manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest["child_home"]).toBe("/e5-inst-root"); // 实例根（非隔离 HOME）——子步 Path.home() 解析稳定
  });

  it("status 返回体带 instance_root（实际解析根＋来源）——三分支恒在", async () => {
    const runsRoot = tempRoot("e5-runs-");
    vi.stubEnv("ATF_HOME", "/e5-inst-root");
    vi.stubEnv("HOME", "/e5-isolated-home");
    // 分支一：无评估轮目录
    const none = (await evalStatus("e5-none", { runsRoot, kernelDir: runsRoot })) as Record<string, unknown>;
    expect(none["instance_root"]).toBe("/e5-inst-root");
    expect(none["instance_root_source"]).toBe("atf_home_env");
    // 分支二：有轮无完成轮
    const runDir = join(runsRoot, "e5-partial");
    mkdirSync(join(runDir, "eval", "1-20260101"), { recursive: true });
    const partial = (await evalStatus("e5-partial", { runsRoot, kernelDir: runsRoot })) as Record<string, unknown>;
    expect(partial["instance_root"]).toBe("/e5-inst-root");
    // 分支三：完成轮在场
    mkdirSync(join(runDir, "eval", "2-20260102", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "eval", "2-20260102", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "test-awq-base" }));
    const done = (await evalStatus("e5-partial", { runsRoot, kernelDir: runsRoot })) as Record<string, unknown>;
    expect(done["instance_root"]).toBe("/e5-inst-root");
    expect(done["instance_root_source"]).toBe("atf_home_env");
  });

  it("env -i HOME 缺席形态：status 仍解析系统家（getpwuid 锚——不因 env 清空失根）", async () => {
    const runsRoot = tempRoot("e5-runs-");
    vi.stubEnv("ATF_HOME", "");
    vi.stubEnv("HOME", "");
    const none = (await evalStatus("e5-envi", { runsRoot, kernelDir: runsRoot })) as Record<string, unknown>;
    expect(none["instance_root_source"]).toBe("system_home");
    expect(String(none["instance_root"])).not.toBe("");
    expect(existsSync(String(none["instance_root"]))).toBe(true); // 系统家真实在盘
  });
});
