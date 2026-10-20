/**
 * 批D14——评测参数继承测试锚：field_config 缺省自动继承（命中/漂移拒/无指纹拒/缺文件拒/
 * 显式覆盖仅告警）＋prompt_mode 缺省与显式（真 tmux 命令断言——编排脚本 "$@" 落盘＋
 * pane_start_command 双面）＋卡面修复（headline 评估放行/绑卡精确键单行/无参数名无绝对
 * 路径/cost 占卡行）＋评测口径行（25/13 夹具→训练字段 25·GT 覆盖 8；GT 外字段只进返回体）。
 * mock pin 形态沿 trainingFace.test.ts（真 python3 子进程面），tmux 走全局测试 socket fixture。
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEvalTools,
  computeEvalCaliber,
  resolveEvalPromptMode,
  summarizeEvalPrelaunchReport,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { evalOrchSessionBase, resolveLaunchSessionName } from "../../src/core/workspace/tmuxLiveness.js";
import { tmuxTest, tmuxTestOk } from "../fixtures/tmuxTestSocket.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d14-eval-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { callId: "t" };
type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const RUN_ID = "run-d14";

/** mock pin：服务件/确认报告（含真实键面的生效服务参数表——绑卡＋绑卡差异两行齐）/编排件
 *  （"$@" 落盘 argv-capture.txt＋sleep 2 保活——pane_start_command 可断言）。
 *  D20h：--record-eval-release 分支落 argv 快照（pin 根 record-argv.json）＋
 *  recordStdout＝print 的 python 表达式（缺省 {"recorded": true}；测试注入 approval_id/坏 JSON）。 */
const writeMockPin = (pin: string, opts: { recordStdout?: string } = {}): void => {
  const recordExpr = opts.recordStdout ?? 'json.dumps({"recorded": True})';
  const dir = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(pin, "skills", "atf-admit-training-data", "scripts"), { recursive: true });
  writeFileSync(join(pin, "skills", "atf-admit-training-data", "scripts", "render_prompt.py"), "# renderer\n");
  writeFileSync(join(dir, "generate_eval_service.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if "--record-eval-release" in args:
    cap = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "record-argv.json")
    open(cap, "w").write(json.dumps(args))
    print(${recordExpr}); sys.exit(0)
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({
  "expected_model_names": ["test-awq-base", "${RUN_ID}_ckpt141"], "config_sha256": "a" * 64,
  "argv": ["vllm", "serve", "--tensor-parallel-size", "4"],
  "request_defaults": {"port": 5031, "temperature": 0}}))
print(json.dumps({"out": out}))`);
  writeFileSync(join(dir, "run_formal_eval.py"), "# runner mock\n");
  writeFileSync(join(dir, "generate_checkpoint_plan.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "ckpt_plan.json"), "w").write("{}")
open(os.path.join(out, "stage_checkpoints.sh"), "w").write("#!/bin/bash\\nexit 0\\n")
print("{}")`);
  writeFileSync(join(dir, "generate_eval_orchestration.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "eval_orchestration.sh"), "w").write(f"#!/bin/bash\\nprintf '%s\\\\n' \\"$@\\" > {out}/argv-capture.txt\\nsleep 2\\nexit 0\\n")
print("{}")`);
  writeFileSync(join(dir, "build_service_prelaunch_report.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
open(out, "w").write("""# 推理服务接入确认报告

- 环境档案:\`b25-eval-a800\` | 接入形态:**编排自起新服务**

## 生效服务参数(反生成自 service_manifest.json,来源列即产物字段,无人工叙述)

| 参数 | 值 | 来源 |
|---|---|---|
| manifest | \`service_manifest.json\` | sha256 \`abc123…\` |
| 环境来源 | env-profile:b25-eval-a800 | deploy_effective.source |
| eval_env | \`/data/venv/torch291_vllm016_bnb_qwen3vl\` | deploy_effective.eval_env |
| 绑卡 | \`0,2,3,4\`(可见 4 卡) | deploy_effective.visible_devices |
| 端口/TP/gpu_mem_util | 5031 / 4(实用 4 卡) / 0.85 | argv |
| 绑卡差异 | 可见 4 卡 vs TP 实用 4 卡——一致 ✓ | visible_devices×argv 同屏对账 |
| max_model_len/max_num_seqs/batched_tokens | 12800 / 8 / 8192 | argv |
| adapters | ['${RUN_ID}_ckpt141'] | manifest.adapters |
| request_defaults | {'temperature': 0} | manifest |
""")
print("{}")`);
};

/** 25 字段 field_config 内容（夹具口径：训练字段 25）。 */
const fieldConfig25 = (): string => `${JSON.stringify({
  schema_version: "PromptFieldConfig/v1", document_type: "pl", document_zh: "装箱单",
  fields: Array.from({ length: 25 }, (_, i) => ({ field_id: `f${String(i + 1).padStart(2, "0")}`, group: `g${String(i + 1).padStart(2, "0")}`, zh: `字段${i + 1}`, definition: "d", locators: [] })),
  training_excluded_fields: [],
}, null, 1)}\n`;

/** 评估资产夹具：GT 13 字段——8 个在训练字段集内（f01..f08）＋5 个在外（g01..g05）。 */
const evalLabelsFixture = (): string => {
  const rows = [];
  for (let i = 1; i <= 8; i += 1) rows.push({ page_id: `p${i}`, labels: { [`f${String(i).padStart(2, "0")}`]: [{ value: "v" }] } });
  rows.push({ page_id: "p9", labels: { g01: [{ value: "v" }], g02: [{ value: "v" }] } });
  rows.push({ page_id: "p10", labels: { g03: [{ value: "v" }], g04: [{ value: "v" }], g05: [{ value: "v" }] } });
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
};

/** run 夹具：experiment-setup/field-config.json（内容由调用方注入——漂移用例改写）＋
 *  prep/iteration-config/iteration-config.json（dataset.digest_provenance.field_config_sha256
 *  按文件实算）＋评估资产＋checkpoint＋service config（tensor_parallel_size 4——cost 行数据源）。 */
const seedRun = (root: string, opts: { fieldConfigText?: string; dropFingerprint?: boolean; dropFieldConfig?: boolean } = {}): { assets: string; serviceConfig: string; ckpt: string } => {
  const runDir = join(root, RUN_ID);
  mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
  const fcText = opts.fieldConfigText ?? fieldConfig25();
  if (!opts.dropFieldConfig) writeFileSync(join(runDir, "experiment-setup", "field-config.json"), fcText);
  mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
  const sha = createHash("sha256").update(Buffer.from(fcText, "utf8")).digest("hex");
  writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), `${JSON.stringify({
    run_id: RUN_ID,
    dataset: opts.dropFingerprint === true ? { modes: [] } : { modes: [], digest_provenance: { field_config_sha256: sha } },
  }, null, 1)}\n`);
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "eval_labels.jsonl"), evalLabelsFixture());
  writeFileSync(join(assets, "test_images.json"), "{}");
  const serviceConfig = join(root, "EvalServiceConfig.v1.json");
  writeFileSync(serviceConfig, JSON.stringify({ schema_version: "EvalServiceConfig/v1", run_id: RUN_ID, port: 5031, tensor_parallel_size: 4 }));
  const ckpt = join(runDir, "training", "checkpoint-141");
  mkdirSync(ckpt, { recursive: true });
  writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
  return { assets, serviceConfig, ckpt };
};

const baseArgs = (root: string, f: { assets: string; serviceConfig: string; ckpt: string }): Record<string, unknown> => ({
  action: "start", run_id: RUN_ID, adapter_path: f.ckpt,
  eval_assets_dir: f.assets, service_config: f.serviceConfig, env_profile: "a800-local", deploy: join(root, "deploy.local.yaml"),
  assets_external_confirm: true,
});

const orchName = (): string => resolveLaunchSessionName(evalOrchSessionBase(RUN_ID));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询等待探测值非空（tmux new-session 异步起 bash——argv 落盘/pane 出现有竞态窗口）。 */
const waitNonEmpty = async (probe: () => string, timeoutMs = 4_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== "") return value;
    if (Date.now() >= deadline) return "";
    await sleep(100);
  }
};

/** 编排脚本 "$@" 落盘内容（真 tmux 命令经 $@ 到达 runner 的实参面）。 */
const probeArgvCapture = (root: string): string => {
  const evalRoot = join(root, RUN_ID, "eval");
  if (!existsSync(evalRoot)) return "";
  const rounds = readdirSync(evalRoot).sort();
  const latest = rounds[rounds.length - 1];
  if (latest === undefined) return "";
  const capture = join(evalRoot, latest, "orch", "argv-capture.txt");
  return existsSync(capture) ? readFileSync(capture, "utf8") : "";
};

/** tmux pane 启动命令（真命令串——mock 编排 sleep 2 保活窗口内可读）。 */
const probePaneStartCommand = (): string => {
  try {
    const out = tmuxTest(`list-panes -a -F "#{pane_start_command}"`);
    return out.trim() === "" ? "" : out;
  } catch {
    return "";
  }
};

describe("批D14——评测参数继承（field_config/prompt_mode 缺省继承＋卡面修复＋口径行）", () => {
  const evalOf = (runsRoot: string, kernelDir: string, ctx: { get: (s: string) => unknown }): Tool =>
    (buildEvalTools(ctx, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_evaluate") as Tool);

  it("缺省解析命中：不传 field_config → run_recorded＋sha 一致＋口径行 25/8＋真 tmux 命令 mode0 单处", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let approvalCalls = 0;
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { approvalCalls += 1; cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    // 解析来源与指纹（run 记录命中）
    expect(result.field_config_source).toBe("run_recorded");
    const expectedSha = createHash("sha256").update(Buffer.from(fieldConfig25(), "utf8")).digest("hex");
    expect(result.field_config_sha256).toBe(expectedSha);
    expect(result.field_config_sha256_prefix12).toBe(expectedSha.slice(0, 12));
    // prompt_mode 缺省继承（训练无声明 → mode0/training_default）
    expect(result.prompt_mode).toBe("mode0");
    expect(result.prompt_mode_source).toBe("training_default");
    // 口径：训练字段 25·GT 覆盖 8；GT 外字段只在返回体（g01..g05）
    const caliber = result.eval_caliber as Record<string, unknown>;
    expect(caliber.training_fields).toBe(25);
    expect(caliber.gt_covered_fields).toBe(8);
    expect(caliber.gt_fields_out_of_scope).toEqual(["g01", "g02", "g03", "g04", "g05"]);
    // 卡面：口径行（数字出自 25/13 夹具）＋字段配置来源行
    expect(cardText).toContain("评测口径：抽取 mode0（继承训练）· 训练字段 25 · GT 覆盖 8");
    expect(cardText).toContain("字段配置：继承训练记录（run_recorded）");
    expect(cardText).not.toContain("g01"); // GT 外字段不上卡
    // 真 tmux 命令：--prompt-mode 单处且为 mode0（argv 落盘＋pane 启动命令双面）
    const argv = await waitNonEmpty(() => probeArgvCapture(root));
    expect(argv.split("\n").filter((l) => l === "--prompt-mode").length).toBe(1);
    expect(argv.split("\n")).toContain("mode0");
    const pane = await waitNonEmpty(probePaneStartCommand);
    expect(pane).toContain("--prompt-mode mode0");
    expect(pane.match(/--prompt-mode/g)?.length).toBe(1);
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("指纹不一致 → eval_field_config_drift＋零编排启动（零轮目录/未进审批/无 tmux 会话）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    // 篡改字段配置文件（训练指纹仍记原内容 sha——形成漂移靶形）
    appendFileSync(join(root, RUN_ID, "experiment-setup", "field-config.json"), "\n");
    let approvalCalls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { approvalCalls += 1; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("eval_field_config_drift");
    expect(String(result.note)).toContain("确认训练配置");
    expect(String(result.note)).toContain("显式传入 field_config");
    expect(approvalCalls).toBe(0);
    expect(existsSync(join(root, RUN_ID, "eval"))).toBe(false); // 零编排启动（零评估轮落盘）
    expect(tmuxTestOk(`has-session -t ${orchName()}`)).toBe(false);
  });

  it("run 无指纹 → eval_field_config_unverified（指引显式传）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root, { dropFingerprint: true });
    const result = await evalOf(root, pin, { get: () => undefined }).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("eval_field_config_unverified");
    expect(String(result.note)).toContain("显式传 field_config");
    expect(existsSync(join(root, RUN_ID, "eval"))).toBe(false);
  });

  it("缺省文件缺失 → eval_field_config_unresolved（指引显式传）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root, { dropFieldConfig: true });
    const result = await evalOf(root, pin, { get: () => undefined }).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("eval_field_config_unresolved");
    expect(String(result.note)).toContain("显式传 field_config");
  });

  it("显式覆盖：漂移仅告警不阻断（field_config_explicit_drift）＋卡面告警行", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    // 显式文件内容与训练记录不一致（10 字段——口径随实际所用文件）
    const altPath = join(root, "field-config-alt.json");
    writeFileSync(altPath, JSON.stringify({
      schema_version: "PromptFieldConfig/v1", document_type: "pl", document_zh: "装箱单",
      fields: Array.from({ length: 10 }, (_, i) => ({ field_id: `a${String(i + 1).padStart(2, "0")}`, group: "a", zh: `字段${i + 1}`, definition: "d", locators: [] })),
      training_excluded_fields: [],
    }));
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute({ ...baseArgs(root, f), field_config: altPath }, fakeExec);
    expect(result.started).toBe(true);
    expect(result.field_config_source).toBe("explicit");
    expect(result.field_config_warning).toBe("field_config_explicit_drift");
    expect((result.eval_caliber as Record<string, unknown>).training_fields).toBe(10);
    expect(cardText).toContain("显式传入（explicit）——与训练记录指纹不一致，按显式覆盖执行");
    expect(cardText).toContain("评测口径：抽取 mode0（继承训练）· 训练字段 10 · GT 覆盖 0");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("prompt_mode 显式 mode1 → 真 tmux 命令含 --prompt-mode mode1（单处）＋口径行显式指定", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute({ ...baseArgs(root, f), prompt_mode: "mode1" }, fakeExec);
    expect(result.started).toBe(true);
    expect(result.prompt_mode).toBe("mode1");
    expect(result.prompt_mode_source).toBe("explicit");
    const argv = await waitNonEmpty(() => probeArgvCapture(root));
    expect(argv.split("\n").filter((l) => l === "--prompt-mode").length).toBe(1);
    expect(argv.split("\n")).toContain("mode1");
    const pane = await waitNonEmpty(probePaneStartCommand);
    expect(pane).toContain("--prompt-mode mode1");
    expect(pane.match(/--prompt-mode/g)?.length).toBe(1);
    expect(cardText).toContain("评测口径：抽取 mode1（显式指定）· 训练字段 25 · GT 覆盖 8");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("prompt_mode 训练声明（dataset.prompt_mode=mode1）→ 继承 mode1（training_declared）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    const iterPath = join(root, RUN_ID, "prep", "iteration-config", "iteration-config.json");
    const iter = JSON.parse(readFileSync(iterPath, "utf8")) as Record<string, unknown>;
    (iter["dataset"] as Record<string, unknown>)["prompt_mode"] = "mode1";
    writeFileSync(iterPath, JSON.stringify(iter));
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    expect(result.prompt_mode).toBe("mode1");
    expect(result.prompt_mode_source).toBe("training_declared");
    const pane = await waitNonEmpty(probePaneStartCommand);
    expect(pane).toContain("--prompt-mode mode1");
    expect(cardText).toContain("评测口径：抽取 mode1（继承训练）· 训练字段 25 · GT 覆盖 8");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("卡面修复四锚：绑卡单行（绑卡差异不重复）/无参数名/无报告绝对路径/cost 占卡实况", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { cardText = req.reason; return "allowed-once"; } } : undefined) };
    await evalOf(root, pin, ctx).execute(baseArgs(root, f), fakeExec);
    const lines = cardText.split("\n");
    // a. 精确键匹配：绑卡一行、绑卡差异不上卡
    expect(lines.filter((l) => l.startsWith("绑卡＝")).length).toBe(1);
    expect(lines.some((l) => l.startsWith("绑卡差异＝"))).toBe(false);
    // b. 无工具参数名（业务话术改参行）
    for (const param of ["adapter_path", "eval_assets_dir", "service_config"]) expect(cardText).not.toContain(param);
    expect(cardText).toContain("如需调整评估数据、adapter 或服务参数，直接回复要改的项");
    // c. 无「完整报告：/data/...」绝对路径行（报告位置改业务表述）
    expect(cardText).not.toContain("完整报告：");
    expect(cardText).toContain("详细报告已生成（评估轮目录内）");
    // d. cost 占卡实况（TP 单源——service_config.tensor_parallel_size=4）
    expect(cardText).toContain("预计代价：占用 4 张 GPU，直到服务停止");
    // headline：评估放行 — <run_id>
    expect(cardText).toContain(`确认摘要：评估放行 — ${RUN_ID}`);
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });
});

describe("批D20h——审批 actor/mode 接入（放行 argv 三参＋approval_id 回传＋卡面 owner 行）", () => {
  const evalOf = (runsRoot: string, kernelDir: string, ctx: { get: (s: string) => unknown }): Tool =>
    (buildEvalTools(ctx, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_evaluate") as Tool);
  const recordArgv = (pin: string): string[] => JSON.parse(readFileSync(join(pin, "record-argv.json"), "utf8")) as string[];
  const flagValue = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1] as string;
  const latestRoundDir = (root: string): string => {
    const rounds = readdirSync(join(root, RUN_ID, "eval")).sort();
    return join(root, RUN_ID, "eval", rounds[rounds.length - 1] as string);
  };
  const ctxWithCard = (card: { text: string }): { get: (s: string) => unknown } => ({
    get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { card.text = req.reason; return "allowed-once"; } } : undefined),
  });

  it("argv 三参：--actor <sessionId>＋--approval-mode ui＋--round-dir <roundDir>", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    const result = await evalOf(root, pin, ctxWithCard({ text: "" })).execute(baseArgs(root, f), { callId: "t", agent: { session: { id: "sess-d20h" } } });
    expect(result.started).toBe(true);
    const argv = recordArgv(pin);
    expect(flagValue(argv, "--actor")).toBe("sess-d20h");
    expect(flagValue(argv, "--approval-mode")).toBe("ui");
    expect(flagValue(argv, "--round-dir")).toBe(latestRoundDir(root));
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("session 缺失 → --actor unattributed（不伪造 owner）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    const result = await evalOf(root, pin, ctxWithCard({ text: "" })).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    const argv = recordArgv(pin);
    expect(flagValue(argv, "--actor")).toBe("unattributed");
    expect(argv).not.toContain("owner"); // 红线：不伪造 owner 字面量
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("账本 approval_id 回传：stdout 带 approval_id → 返回体 approval_entry_id", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, { recordStdout: 'json.dumps({"recorded": True, "approval_id": "appr-20h-uuid"})' });
    const f = seedRun(root);
    const result = await evalOf(root, pin, ctxWithCard({ text: "" })).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    expect(result.approval_entry_id).toBe("appr-20h-uuid");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("stdout 非 JSON → 不阻断（started=true）＋返回体无 approval_entry_id＋stderr 记一条", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, { recordStdout: "'{not-json'" });
    const f = seedRun(root);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await evalOf(root, pin, ctxWithCard({ text: "" })).execute(baseArgs(root, f), fakeExec);
      expect(result.started).toBe(true);
      expect("approval_entry_id" in result).toBe(false);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("approval_entry_id"))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("卡面 reason 含「仅 owner 可点；执行方不得代点」", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    const card = { text: "" };
    const result = await evalOf(root, pin, ctxWithCard(card)).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    expect(card.text).toContain("仅 owner 可点；执行方不得代点");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });
});

describe("批D14——纯函数锚（prompt_mode 解析链/口径计算/卡面摘要 runId headline）", () => {
  it("resolveEvalPromptMode：dataset.prompt_mode＞顶层＞缺省 mode0；显式最优先；非法值视同无声明", () => {
    const root = tempRoot();
    const dir = join(root, "r", "prep", "iteration-config");
    mkdirSync(dir, { recursive: true });
    const write = (config: Record<string, unknown>): void => writeFileSync(join(dir, "iteration-config.json"), JSON.stringify(config));
    write({ dataset: { prompt_mode: "mode1" }, prompt_mode: "mode0" });
    expect(resolveEvalPromptMode(join(root, "r"))).toEqual({ mode: "mode1", source: "training_declared" });
    write({ prompt_mode: "mode1" });
    expect(resolveEvalPromptMode(join(root, "r"))).toEqual({ mode: "mode1", source: "training_declared" });
    write({ dataset: { modes: [] } });
    expect(resolveEvalPromptMode(join(root, "r"))).toEqual({ mode: "mode0", source: "training_default" });
    write({ dataset: { prompt_mode: "mode5" } });
    expect(resolveEvalPromptMode(join(root, "r"))).toEqual({ mode: "mode0", source: "training_default" });
    expect(resolveEvalPromptMode(join(root, "r"), "mode1")).toEqual({ mode: "mode1", source: "explicit" });
    rmSync(join(root, "r"), { recursive: true, force: true });
    expect(resolveEvalPromptMode(join(root, "r"))).toEqual({ mode: "mode0", source: "training_default" });
  });

  it("computeEvalCaliber：training_excluded_fields 出集（参与评分口径）＋GT 坏行跳过不阻断", () => {
    const root = tempRoot();
    const fcPath = join(root, "field-config.json");
    writeFileSync(fcPath, JSON.stringify({
      fields: [{ field_id: "a" }, { field_id: "b" }, { field_id: "c" }],
      training_excluded_fields: ["c"],
    }));
    const assets = join(root, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "eval_labels.jsonl"), [
      JSON.stringify({ labels: { a: [1], c: [2] } }),
      "{ 坏行", // 坏行跳过
      JSON.stringify({ labels: { d: [3] } }),
    ].join("\n"));
    const caliber = computeEvalCaliber(fcPath, assets, { mode: "mode0", source: "training_default" });
    expect(caliber.training_fields).toBe(2); // a+b（c 训练排除）
    expect(caliber.gt_covered_fields).toBe(1); // a
    expect(caliber.gt_fields_out_of_scope).toEqual(["c", "d"]);
  });

  it("summarizeEvalPrelaunchReport：runId → headline 评估放行；绑卡差异行不进 metrics（精确键）", async () => {
    const { summarizeEvalPrelaunchReport: summarize } = await import("../../packages/extensions/atf-tools/src/trainingFace.js");
    const report = [
      "# 推理服务接入确认报告",
      "",
      "## 生效服务参数(反生成自 service_manifest.json)",
      "",
      "| 参数 | 值 | 来源 |",
      "|---|---|---|",
      "| 绑卡 | `0,2,3,4`(可见 4 卡) | deploy_effective.visible_devices |",
      "| 绑卡差异 | 可见 4 卡 vs TP 实用 4 卡——一致 ✓ | 对账 |",
      "| 端口/TP/gpu_mem_util | 8200 / 4 / 0.85 | argv |",
      "",
    ].join("\n");
    const withRun = summarize(report, "run-x");
    expect(withRun.headline).toBe("评估放行 — run-x");
    expect(withRun.metrics.filter((m) => m.startsWith("绑卡＝")).length).toBe(1);
    expect(withRun.metrics.some((m) => m.startsWith("绑卡差异＝"))).toBe(false);
    expect(withRun.metrics.some((m) => m.startsWith("端口/TP/gpu_mem_util＝"))).toBe(true);
    // runId 缺席＝旧形态（报告 H1）——纯函数兼容面
    expect(summarize(report).headline).toBe("推理服务接入确认报告");
  });
});
