/**
 * E4-乙（微批·训练参数单源桥 20261024）测试锚——owner 指令《ATF_指令_微批E4_
 * training_overrides_20261024》（授权件 47d0d1ba61dc0911）四处改动的验收锚：
 *
 *   1.（H1）pipelineFace 增 training_overrides：仅 training_prep 段（其它段忽略记
 *      note）；九键白名单（像素对＋TokenBudget 三键禁入——卡前快败）；未显式给时读
 *      <runDir>/webui/config-snapshot.json confirmed 九键子集构造；accum 缺而 bs×nproc
 *      在场按 global_batch=256 派生（除不尽停点）；bs 缺按内核缺省分档
 *      （cutoff<10000→2）、deepspeed 缺按 ds_z3_offload——convention 态只呈现不下传
 *      （缺省单源在内核）；逐键来源 user_confirmed|config_snapshot|derived|convention
 *      审批卡与返回体双呈现；argv --training-overrides <json>（内核 b9 将声明——
 *      D94 参数面前瞻豁免，re-pin 对账）。
 *   2.（H2）confirmFace 停止回写 prep/iteration-config（快照是唯一出口——param_sources
 *      由内核 training_prep 段写 user_confirmed(ref=stage:training_overrides)）；删卡面
 *      per_device_train_batch_size 的 ?? 2 硬编码（内核缺省分档单源 kernelBsDefaultOf，
 *      标 convention）；deepspeed 缺省与内核统一 ds_z3_offload。
 *   3.（改动 3）build_prelaunch_report 来源校验接受内核写的
 *      user_confirmed(ref=stage:training_overrides) 不误拒（H3 工具零第二套来源闸门；
 *      mock 脚本模拟 b9 宽松校验形态——re-pin 后可切真件）。
 *   4.（H3）atf_prelaunch_report 新工具：run_id＋workspace_path 只读生成/返回
 *      <run>/launch/prelaunch-report.md 路径与摘要；不承担审批（材料不是闸）。
 *
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（argv 回显）＋
 * mock_prelaunch_report.py（E4b 新增——b9 前瞻形态）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPipelineTool,
  resolveTrainingOverrides,
  trainingOverridesApprovalLine,
  TRAINING_OVERRIDE_KEYS,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { domainHintOf } from "../../packages/extensions/atf-tools/src/confirmFace.js";

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
});

const fakeExec = { agent: undefined, callId: "e4b-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } }
      : undefined),
});
const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
const toolOf = (record: string[] = []): DshToolLike =>
  buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike;

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

/**  argv 里 --training-overrides 的值（单值形态；缺席＝null）。 */
const overridesJsonOf = (argv: readonly string[]): Record<string, string> | null => {
  const index = argv.indexOf("--training-overrides");
  if (index < 0) return null;
  return JSON.parse(argv[index + 1] ?? "{}") as Record<string, string>;
};

/** 落九要素形态确认快照（confirmed 值全字符串面——与 saveConfigSnapshot 落盘形态同源）。 */
const writeSnapshot = (runDir: string, confirmed: Record<string, string>): void => {
  mkdirSync(join(runDir, "webui"), { recursive: true });
  writeFileSync(join(runDir, "webui", "config-snapshot.json"), `${JSON.stringify({ schema_version: "WebUiConfigSnapshot/v1", confirmed }, null, 1)}\n`, "utf8");
};

describe("E4b-H1 training_overrides（training_prep 段训练参数单源桥）", () => {
  it("显式键透传：argv --training-overrides 只含显式键＋来源 user_confirmed；convention 键呈现不下传；审批卡行含逐键来源", async () => {
    const record: string[] = [];
    const ws = tempRoot("e4b-ws-");
    const result = await toolOf(record).execute(
      { stage: "training_prep", run_id: "e4b-explicit", workspace_path: ws, base_model_path: join(ws, "model"), training_overrides: { learning_rate: "2e-4", lora_rank: 32 } },
      fakeExec,
    );
    const argv = summaryArgv(result);
    const passed = overridesJsonOf(argv);
    expect(passed).toEqual({ learning_rate: "2e-4", lora_rank: "32" });
    const resolution = (result as Record<string, unknown>)["training_overrides_resolution"] as Record<string, { value: string | null; source: string }>;
    expect(resolution["learning_rate"]).toEqual({ value: "2e-4", source: "user_confirmed" });
    // convention 态：bs 无显式无快照 → 内核缺省分档 2（cutoff 缺席按惯例基线 9000 判档）；
    // deepspeed → ds_z3_offload——只呈现（resolution 在场）不下传（argv JSON 不含）
    expect(resolution["per_device_train_batch_size"]).toEqual({ value: "2", source: "convention" });
    expect(resolution["deepspeed"]).toEqual({ value: "ds_z3_offload", source: "convention" });
    expect(passed).not.toHaveProperty("per_device_train_batch_size");
    expect(passed).not.toHaveProperty("deepspeed");
    // 审批卡行：逐键终值＋来源中文标签（convention 明示只呈现不下传）
    expect(record.join("\n")).toContain("训练参数覆盖（training_prep）");
    expect(record.join("\n")).toContain("learning_rate=2e-4（用户确认）");
    expect(record.join("\n")).toContain("per_device_train_batch_size=2（内核惯例·只呈现不下传）");
  });

  it("禁入键（像素对/TokenBudget 三键）与白名单外键一律卡前快败——审批未消耗", async () => {
    for (const bad of [{ image_min_pixels: 65536 }, { max_total_tokens: 9000 }, { cutoff_len: 9000 }, { max_model_len: 12800 }, { brand_new_key: "x" }, { base_model_path: "/m" }, { negative_ratio_target: "0.02,0.05" }]) {
      const record: string[] = [];
      const ws = tempRoot("e4b-ws-");
      const result = await toolOf(record).execute(
        { stage: "training_prep", run_id: "e4b-bad", workspace_path: ws, base_model_path: join(ws, "model"), training_overrides: bad },
        fakeExec,
      );
      expect((result as Record<string, unknown>)["ok"]).toBe(false);
      expect(record).toEqual([]); // 卡前快败不进审批
    }
    const forbidden = await toolOf([]).execute(
      { stage: "training_prep", run_id: "e4b-bad2", workspace_path: tempRoot("e4b-ws-"), base_model_path: "/m", training_overrides: { image_min_pixels: 65536 } },
      fakeExec,
    );
    expect((forbidden as Record<string, unknown>)["error"]).toBe("training_overrides_forbidden_key");
    expect((forbidden as Record<string, unknown>)["note"]).toContain("像素对");
  });

  it("未显式给 → 读确认快照构造：九键 passDown 全下传＋来源 config_snapshot；resolution 九键恒在场", async () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = join(ws, "runs", "e4b-snap");
    mkdirSync(runDir, { recursive: true });
    const snapshotNine: Record<string, string> = {
      learning_rate: "1e-4",
      nproc_per_node: "8",
      visible_devices: "0,1,2,3,4,5,6,7",
      num_train_epochs: "3",
      per_device_train_batch_size: "2",
      gradient_accumulation_steps: "16",
      deepspeed: "ds_z3_offload",
      lora_rank: "32",
      lora_alpha: "64",
    };
    writeSnapshot(runDir, snapshotNine);
    const result = await toolOf([]).execute(
      { stage: "training_prep", run_id: "e4b-snap", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    );
    const passed = overridesJsonOf(summaryArgv(result));
    expect(passed).toEqual(snapshotNine);
    const resolution = (result as Record<string, unknown>)["training_overrides_resolution"] as Record<string, { value: string | null; source: string }>;
    for (const key of TRAINING_OVERRIDE_KEYS) {
      expect(resolution[key]?.source).toBe("config_snapshot");
    }
  });

  it("accum 缺而 bs×nproc 终值在场 → 按 global_batch=256 派生（derived）；除不尽组合停点拒绝", async () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = join(ws, "runs", "e4b-derive");
    mkdirSync(runDir, { recursive: true });
    writeSnapshot(runDir, { per_device_train_batch_size: "2", nproc_per_node: "8" });
    const result = await toolOf([]).execute(
      { stage: "training_prep", run_id: "e4b-derive", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    );
    const passed = overridesJsonOf(summaryArgv(result));
    expect(passed).toEqual({ nproc_per_node: "8", per_device_train_batch_size: "2", gradient_accumulation_steps: "16" });
    const resolution = (result as Record<string, unknown>)["training_overrides_resolution"] as Record<string, { value: string | null; source: string }>;
    expect(resolution["gradient_accumulation_steps"]).toEqual({ value: "16", source: "derived" });

    // 除不尽（bs=3×nproc=8=24，256%24≠0）→ 卡前停点（禁静默取整），审批未消耗
    const record: string[] = [];
    const failed = await toolOf(record).execute(
      { stage: "training_prep", run_id: "e4b-nondiv", workspace_path: ws, base_model_path: join(ws, "model"), training_overrides: { per_device_train_batch_size: 3, nproc_per_node: 8 } },
      fakeExec,
    );
    expect((failed as Record<string, unknown>)["error"]).toBe("training_overrides_derive_failed");
    expect(record).toEqual([]);
  });

  it("其它段收到 training_overrides → 忽略记 note（argv 零追加，段外传参不报错）", async () => {
    const ws = tempRoot("e4b-ws-");
    const result = await toolOf([]).execute(
      { stage: "experiment_setup", run_id: "e4b-ignore", workspace_path: ws, training_overrides: { learning_rate: "2e-4" } },
      fakeExec,
    );
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    expect((result as Record<string, unknown>)["training_overrides_ignored"]).toBe(true);
    expect(summaryArgv(result)).not.toContain("--training-overrides");
  });

  it("纯函数锚：resolveTrainingOverrides 值形态宽松面（number/boolean 收敛字符串）＋非对象拒；卡行空态文案", () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = join(ws, "runs", "e4b-pure");
    mkdirSync(runDir, { recursive: true });
    const resolved = resolveTrainingOverrides({ training_overrides: { nproc_per_node: 4, deepspeed: "off", lora_rank: 64 } }, runDir);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.values["nproc_per_node"]).toBe("4");
      expect(resolved.values["lora_rank"]).toBe("64");
      expect(resolved.sources["deepspeed"]).toBe("user_confirmed");
      expect(resolved.passDown["per_device_train_batch_size"]).toBeUndefined(); // convention 不下传
    }
    const badShape = resolveTrainingOverrides({ training_overrides: [1, 2] }, runDir);
    expect(badShape.ok).toBe(false);
    const badValue = resolveTrainingOverrides({ training_overrides: { learning_rate: { nested: true } } }, runDir);
    expect(badValue.ok).toBe(false);
    // 卡行空态：快照缺席且显式空 → convention 两键仍在卡行（bs/deepspeed 恒有终值呈现）
    expect(trainingOverridesApprovalLine({ per_device_train_batch_size: "2", deepspeed: "ds_z3_offload" }, { per_device_train_batch_size: "convention", deepspeed: "convention" })).toContain("内核惯例·只呈现不下传");
  });

  it("cutoff≥10000 快照 → bs 内核缺省分档取 1（convention 只呈现）；<10000 取 2", async () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = join(ws, "runs", "e4b-bs");
    mkdirSync(runDir, { recursive: true });
    writeSnapshot(runDir, { cutoff_len: "12800" });
    const result = await toolOf([]).execute(
      { stage: "training_prep", run_id: "e4b-bs", workspace_path: ws, base_model_path: join(ws, "model") },
      fakeExec,
    );
    const resolution = (result as Record<string, unknown>)["training_overrides_resolution"] as Record<string, { value: string | null; source: string }>;
    expect(resolution["per_device_train_batch_size"]).toEqual({ value: "1", source: "convention" });
    const passed = overridesJsonOf(summaryArgv(result));
    expect(passed).toBeNull(); // 全 convention → argv 零追加
  });
});

// ══ 2.（H2）confirmFace 停写＋bs convention＋deepspeed 统一 ══

const confirmExec = { agent: { session: { id: "sess-e4b-test" } }, callId: "e4b-confirm-1", signal: undefined };

/** ctx 桩：手动档 permissionPresets＋approval（记录 reason）＋userQuestions（提交 max_total_tokens=9000 过预算闸）——batchE3 同款形态。 */
const manualCtx = (askLog: string[], approvals: string[]) => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: () => "danger-full-access",
        defaultPreset: "danger-full-access",
        catalog: () => ({ options: [{ value: "danger-full-access", name: "Full access" }], defaultPreset: "danger-full-access" }),
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { approvals.push(req.reason); return "allowed-once"; } };
    }
    if (service === "userQuestions") {
      return {
        ask: async (req: { questions: ReadonlyArray<{ id: string }> }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }> => {
          const question = req.questions[0];
          if (question === undefined) throw new Error("ask 桩收到空问题集");
          askLog.push(question.id);
          return { answers: [{ id: question.id, selected: ["max_total_tokens=9000"] }] };
        },
      };
    }
    return undefined;
  },
});

const configToolOf = (runsRoot: string, askLog: string[], approvals: string[]): DshToolLike => {
  const tool = (buildConfirmTools({ runsRoot, ctx: manualCtx(askLog, approvals) }) as unknown as DshToolLike[]).find((entry) => entry.name === "atf_config_confirm");
  if (tool === undefined) throw new Error("atf_config_confirm 未注册");
  return tool;
};

describe("E4b-H2 confirmFace 停回写＋bs convention＋deepspeed 统一", () => {
  it("手动档确认链停写：快照落盘（唯一出口）＋iteration-config 逐字节零改动（param_sources/training 由内核 training_prep 段写）", async () => {
    const runsRoot = tempRoot("e4b-runs-");
    const runDir = join(runsRoot, "e4b-stop");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    const iterBefore = `${JSON.stringify({ schema_version: "IterationConfig/v1", training: { learning_rate: "1e-4", num_train_epochs: 2, per_device_train_batch_size: 2, cutoff_len: 9000, lora_rank: 32 } }, null, 1)}\n`;
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), iterBefore);
    const askLog: string[] = [];
    const approvals: string[] = [];
    const result = (await configToolOf(runsRoot, askLog, approvals).execute({ action: "present", run_id: "e4b-stop" }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(existsSync(join(runDir, "webui", "config-snapshot.json"))).toBe(true); // 快照＝唯一出口
    expect(readFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), "utf8")).toBe(iterBefore); // 停写锚：内核产物逐字节零改动
    expect(askLog.length).toBeGreaterThan(0); // 表单卡真走（不是免阻塞捷径）
  });

  it("卡面 bs 缺省＝内核缺省分档注入（convention）：无登记无快照时 fields bs=2（cutoff 9000 判档）＋deepspeed=ds_z3_offload", async () => {
    const runsRoot = tempRoot("e4b-runs-");
    const result = (await configToolOf(runsRoot, [], []).execute({ action: "present", run_id: "e4b-bs" }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const fields = result["fields"] as Array<{ key: string; value: string; tag: string }>;
    const bs = fields.find((f) => f.key === "per_device_train_batch_size");
    expect(bs?.value).toBe("2"); // kernelBsDefaultOf(9000)——`?? 2` 硬编码退役为分档单源
    const deepspeed = fields.find((f) => f.key === "deepspeed");
    expect(deepspeed?.value).toBe("ds_z3_offload"); // E4-乙：缺省与内核统一（原 ds_z2_config.json）
    expect(domainHintOf("per_device_train_batch_size", null)).toContain("convention");
  });

  it("快照确认值链路完整（停写不改快照语义）：confirmed 九键全落＋token 预算键在", async () => {
    const runsRoot = tempRoot("e4b-runs-");
    const result = (await configToolOf(runsRoot, [], []).execute({ action: "present", run_id: "e4b-snap2" }, confirmExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const confirmed = JSON.parse(readFileSync(join(runsRoot, "e4b-snap2", "webui", "config-snapshot.json"), "utf8"))["confirmed"] as Record<string, string>;
    for (const key of TRAINING_OVERRIDE_KEYS) {
      if (key === "visible_devices") continue; // 卡位留空不落快照（D76）
      expect(confirmed[key]).toBeDefined();
    }
  });
});

// ══ 3.（H3＋改动 3）atf_prelaunch_report 只读生成工具 ══

import { buildPrelaunchReportTool } from "../../packages/extensions/atf-tools/src/prelaunchFace.js";
import { cpSync } from "node:fs";

/** mock 内核树（kernelDir 面）：skills/atf-prepare-training/scripts/build_prelaunch_report.py＝
 *  mock_prelaunch_report.mjs（b9 前瞻宽松来源文法——user_confirmed(ref=...) 放行）。 */
const mockKernelDir = (): string => {
  const kernel = tempRoot("e4b-kernel-");
  const dir = join(kernel, "skills", "atf-prepare-training", "scripts");
  mkdirSync(dir, { recursive: true });
  cpSync(join(import.meta.dirname, "..", "fixtures", "mock_prelaunch_report.py"), join(dir, "build_prelaunch_report.py"));
  return kernel;
};

const prelaunchToolOf = (kernel: string): DshToolLike =>
  buildPrelaunchReportTool({ get: () => undefined }, { kernelDir: kernel, timeoutMs: 30_000 }) as unknown as DshToolLike;

/** 种 run 树（canonical 形态）：launch/launch.sh 在场＋config（live/legacy 形态可选）。 */
const seedRunTree = (ws: string, runId: string, configForm: "live" | "legacy", paramSources?: Record<string, string>): string => {
  const runDir = join(ws, "workspace", "runs", runId);
  mkdirSync(join(runDir, "launch"), { recursive: true });
  writeFileSync(join(runDir, "launch", "launch.sh"), "#!/bin/bash\nexit 0\n");
  const config = { schema_version: "IterationConfig/v1", training: { learning_rate: "1e-4", per_device_train_batch_size: 2 }, ...(paramSources !== undefined ? { param_sources: paramSources } : {}) };
  if (configForm === "live") {
    mkdirSync(join(runDir, "prep"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config.json"), JSON.stringify(config, null, 1));
  } else {
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), JSON.stringify(config, null, 1));
  }
  return runDir;
};

describe("E4b-H3 atf_prelaunch_report（只读生成/回读——材料不是闸）", () => {
  it("正常链路：canonical run 树＋live config → 报告落 <run>/launch/prelaunch-report.md＋路径/字节/摘要返回", async () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = seedRunTree(ws, "e4b-pl", "live");
    const result = (await prelaunchToolOf(mockKernelDir()).execute({ run_id: "e4b-pl", workspace_path: ws }, fakeExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["run_dir"]).toBe(runDir);
    expect(result["run_dir_layout"]).toBe("canonical");
    expect(result["config_form"]).toBe("live");
    expect(result["report_path"]).toBe(join(runDir, "launch", "prelaunch-report.md"));
    expect(result["report_bytes"]).toBeGreaterThan(0);
    expect(String(result["summary_head"])).toContain("需确认");
  });

  it("改动 3 不误拒锚：param_sources 含 user_confirmed(ref=stage:training_overrides)（内核 training_prep 段落账形态）→ 生成成功且来源串原样进报告", async () => {
    const ws = tempRoot("e4b-ws-");
    const runDir = seedRunTree(ws, "e4b-uc", "legacy", { learning_rate: "user_confirmed(ref=stage:training_overrides)" });
    const result = (await prelaunchToolOf(mockKernelDir()).execute({ run_id: "e4b-uc", workspace_path: ws }, fakeExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true); // harness 零第二套来源校验——该形态不被工具拒
    expect(result["config_form"]).toBe("legacy");
    const report = readFileSync(join(runDir, "launch", "prelaunch-report.md"), "utf8");
    expect(report).toContain("user_confirmed(ref=stage:training_overrides)"); // 来源串原样呈现（内核 b9 文法）
  });

  it("来源闸单源在内核：malformed 来源串 → 工具如实回传脚本拒绝（stderr_tail 含 param_source_invalid，不吞不预判）", async () => {
    const ws = tempRoot("e4b-ws-");
    seedRunTree(ws, "e4b-bad-src", "live", { learning_rate: "沿用上一轮的值" });
    const result = (await prelaunchToolOf(mockKernelDir()).execute({ run_id: "e4b-bad-src", workspace_path: ws }, fakeExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("prelaunch_report_failed");
    expect(String(result["stderr_tail"])).toContain("param_source_invalid");
  });

  it("快败面：run 不存在拒（只读不代建）／无 IterationConfig 拒并指路 training_prep／无 launch.sh 拒并指路 generate_train_launch", async () => {
    const tool = prelaunchToolOf(mockKernelDir());
    const absent = (await tool.execute({ run_id: "no-such", workspace_path: tempRoot("e4b-ws-") }, fakeExec)) as Record<string, unknown>;
    expect(absent["ok"]).toBe(false); // run 不存在：legacy 公式探测不在场即拒（不 mkdir）
    const ws2 = tempRoot("e4b-ws-");
    const runDir2 = join(ws2, "workspace", "runs", "e4b-noconfig");
    mkdirSync(join(runDir2, "launch"), { recursive: true });
    writeFileSync(join(runDir2, "launch", "launch.sh"), "#!/bin/bash\n");
    const noConfig = (await tool.execute({ run_id: "e4b-noconfig", workspace_path: ws2 }, fakeExec)) as Record<string, unknown>;
    expect(noConfig["error"]).toBe("iteration_config_missing");
    expect(String(noConfig["note"])).toContain("training_prep");
    const ws3 = tempRoot("e4b-ws-");
    const runDir3 = join(ws3, "workspace", "runs", "e4b-nolaunch");
    mkdirSync(join(runDir3, "prep"), { recursive: true });
    writeFileSync(join(runDir3, "prep", "iteration-config.json"), JSON.stringify({ training: {} }));
    const noLaunch = (await tool.execute({ run_id: "e4b-nolaunch", workspace_path: ws3 }, fakeExec)) as Record<string, unknown>;
    expect(noLaunch["error"]).toBe("launch_artifacts_missing");
    expect(String(noLaunch["note"])).toContain("generate_train_launch");
  });

  it("免审批锚：全程零 approval 服务消费（ctx.get('approval') 返回 undefined 也不拒）＋幂等重跑", async () => {
    const ws = tempRoot("e4b-ws-");
    seedRunTree(ws, "e4b-idem", "live");
    const tool = prelaunchToolOf(mockKernelDir());
    const first = (await tool.execute({ run_id: "e4b-idem", workspace_path: ws }, fakeExec)) as Record<string, unknown>;
    const second = (await tool.execute({ run_id: "e4b-idem", workspace_path: ws }, fakeExec)) as Record<string, unknown>;
    expect(first["ok"]).toBe(true);
    expect(second["ok"]).toBe(true); // 幂等覆盖重写
  });
});
