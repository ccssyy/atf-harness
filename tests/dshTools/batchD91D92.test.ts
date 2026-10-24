/**
 * D91/D92 测试锚（指令《ATF_指令_参数面增补_harness_20261023》）。
 *
 * D91——评估 lane 从任务事实取值：resolveEvalLaneFrom 判定序逐态（显式覆盖＞任务事实
 * training-data-manifest lanes 键集恰一 lane；缺失/多键/空/非法一律 fail-closed）＋
 * atf_analyze_badcases 链级（non_goods 任务不传 lane → 冻结账本 argv 收 --lane non_goods）＋
 * atf_evaluate 卡前快败代码锚（坏条件不消耗放行——判定先于 requestApproval）。
 * mock pin 形态沿 trainingFace.test.ts（真 python3 子进程面）。
 *
 * D92——dataset_keys 改只读展示：只读键单源（READONLY_CONFIG_KEYS 双键全滤输入框）＋
 * CONFIG_CONFIRM_KEYS 新 label/空 default＋confirmFace baseline 注入内核实算值
 * （IterationConfig dataset 段）＋卡面只读行（值在＝实算值；值缺＝如实未产出）＋
 * Web 摘要 buildLaunchSurface dataset_keys 顶层展平（learning_rate 等既有路径不变）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EVAL_LANE_UNRESOLVED_NOTE_OF,
  resolveEvalLaneFrom,
  buildEvalTools,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";
import {
  CONFIG_CONFIRM_KEYS,
  READONLY_CONFIG_KEYS,
  buildConfigConfirmFields,
} from "../../src/webui/configConfirm.js";
import { configFormFieldsOf } from "../../packages/extensions/atf-tools/src/confirmFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d91-d92-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };
const fakeExec = { callId: "t" };

/** 训练数据 manifest 写入（任务事实权威源——lanes 键即 lane 原文名）。 */
const writeManifest = (runDir: string, lanes: unknown): void => {
  mkdirSync(join(runDir, "l1"), { recursive: true });
  writeFileSync(join(runDir, "l1", "training-data-manifest.json"), `${JSON.stringify({ schema_version: "TrainingDataArtifact/v1", lanes }, null, 1)}\n`);
};

describe("D91——resolveEvalLaneFrom 判定序逐态（显式＞任务事实；坏条件 fail-closed）", () => {
  it("显式覆盖：trim 非空即采纳（source=explicit），优先于任务事实", () => {
    const runDir = tempRoot();
    writeManifest(join(runDir, "r"), { goods: {}, non_goods: {} });
    expect(resolveEvalLaneFrom(join(runDir, "r"), "  non_goods  ")).toEqual({ ok: true, lane: "non_goods", source: "explicit" });
  });
  it("explicit 空串/全空白 → explicit_empty（显式给了空值不静默忽略）", () => {
    expect(resolveEvalLaneFrom(tempRoot(), "   ")).toEqual({ ok: false, reason: "explicit_empty" });
  });
  it("task_fact 命中：恰一非空键 → lane=该键（source=task_fact）", () => {
    const runDir = tempRoot();
    writeManifest(runDir, { non_goods: { samples: 3 } });
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: true, lane: "non_goods", source: "task_fact" });
  });
  it("文件缺失/坏 JSON → task_fact_missing（fail-closed 不猜缺省）", () => {
    expect(resolveEvalLaneFrom(tempRoot(), undefined)).toEqual({ ok: false, reason: "task_fact_missing" });
    const runDir = tempRoot();
    mkdirSync(join(runDir, "l1"), { recursive: true });
    writeFileSync(join(runDir, "l1", "training-data-manifest.json"), "{ not json");
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: false, reason: "task_fact_missing" });
  });
  it("lanes 多键 → lanes_ambiguous＋lanesSeen 全列", () => {
    const runDir = tempRoot();
    writeManifest(runDir, { goods: {}, non_goods: {} });
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: false, reason: "lanes_ambiguous", lanesSeen: ["goods", "non_goods"] });
  });
  it("lanes 空对象 → lanes_empty；lanes 非对象（null/数组/键缺失）→ lanes_field_invalid", () => {
    const write = (lanes: unknown): string => {
      const runDir = tempRoot();
      writeManifest(runDir, lanes);
      return runDir;
    };
    expect(resolveEvalLaneFrom(write({}), undefined)).toEqual({ ok: false, reason: "lanes_empty", lanesSeen: [] });
    expect(resolveEvalLaneFrom(write(null), undefined)).toEqual({ ok: false, reason: "lanes_field_invalid" });
    expect(resolveEvalLaneFrom(write(["goods"]), undefined)).toEqual({ ok: false, reason: "lanes_field_invalid" });
    const runDir = tempRoot();
    mkdirSync(join(runDir, "l1"), { recursive: true });
    writeFileSync(join(runDir, "l1", "training-data-manifest.json"), `${JSON.stringify({ schema_version: "TrainingDataArtifact/v1" })}\n`);
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: false, reason: "lanes_field_invalid" });
  });
  it("业务文案单源：缺席态与多键态均零内部码，多键态列键名", () => {
    const missing = EVAL_LANE_UNRESOLVED_NOTE_OF(undefined);
    expect(missing).toContain("无法从任务事实判定");
    expect(missing).toContain("训练数据 lane 记录缺席");
    expect(missing).toContain("显式指定 lane");
    expect(missing).not.toContain("lanes_ambiguous");
    const ambiguous = EVAL_LANE_UNRESOLVED_NOTE_OF(["goods", "non_goods"]);
    expect(ambiguous).toContain("goods、non_goods");
    expect(ambiguous).not.toContain("task_fact_missing");
  });
});

describe("D91——atf_analyze_badcases 链级（non_goods 任务不传 lane → 冻结账本收 --lane non_goods）", () => {
  /** mock pin：两脚本把各自 argv 追加进 argvLog（调用面断言用——形态沿 trainingFace.test.ts）。 */
  const writeMockPin = (pin: string, argvLog: string): void => {
    const record = `import json as _json, sys as _sys\nopen(${JSON.stringify(argvLog)}, "a").write(_json.dumps(_sys.argv[1:]) + "\\n")\n`;
    const freezeScript = join(pin, "skills", "atf-evaluate-checkpoints", "scripts", "build_raw_badcase_input.py");
    const chainScript = join(pin, "skills", "atf-analyze-badcases", "scripts", "run_analysis_chain.py");
    mkdirSync(join(pin, "skills", "atf-evaluate-checkpoints", "scripts"), { recursive: true });
    mkdirSync(join(pin, "skills", "atf-analyze-badcases", "scripts"), { recursive: true });
    writeFileSync(freezeScript, `#!/usr/bin/env python3
${record}import json, os, sys
args = sys.argv[1:]
out_dir = args[args.index("--out-dir") + 1]
os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, "raw-badcase-analysis.v1.json"), "w").write("{}")
print(json.dumps({"argv": args}))`);
    writeFileSync(chainScript, `#!/usr/bin/env python3
${record}import json, os, sys
args = sys.argv[1:]
out_dir = args[args.index("--output-dir") + 1]
os.makedirs(os.path.join(out_dir, "viewer"), exist_ok=True)
os.makedirs(os.path.join(out_dir, "report"), exist_ok=True)
open(os.path.join(out_dir, "viewer", "viewer.html"), "w").write("<html></html>")
open(os.path.join(out_dir, "report", "report.md"), "w").write("# report")
print(json.dumps({"argv": args}))`);
  };
  /** 评估四件套＋L1 eval 资产（images 布局＝assets 上级 images/，m12 同款）。 */
  const writeEvalFixtures = (root: string): { assets: string } => {
    const evalDir = join(root, "r1", "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "badcases.jsonl"), "{}\n");
    writeFileSync(join(evalDir, "raw_predictions.jsonl"), "{}\n");
    const assets = join(root, "r1", "l1", "eval");
    mkdirSync(join(root, "r1", "l1", "images"), { recursive: true });
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(root, "r1", "l1", "images", "p1.png"), "png");
    writeFileSync(join(assets, "eval_labels.jsonl"), JSON.stringify({ page_id: "p1", image: "images/p1.png" }) + "\n");
    return { assets };
  };
  const analyzeOf = (runsRoot: string, kernelDir: string): Tool =>
    (buildEvalTools({ get: () => undefined }, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_analyze_badcases") as Tool);
  const flagValue = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1] as string;

  it("non_goods 任务不传 lane → 任务事实判定 non_goods（冻结账本 argv --lane non_goods）＋链 ok", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    const argvLog = join(pin, "argv.jsonl");
    writeMockPin(pin, argvLog);
    const { assets } = writeEvalFixtures(root);
    writeManifest(join(root, "r1"), { non_goods: {} });
    const result = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(result.ok).toBe(true);
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls).toHaveLength(2); // freeze＋chain 各一次
    expect(flagValue(calls[0] as string[], "--lane")).toBe("non_goods");
  });
  it("显式 lane 覆盖任务事实（--lane goods 显式传入）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    const argvLog = join(pin, "argv.jsonl");
    writeMockPin(pin, argvLog);
    const { assets } = writeEvalFixtures(root);
    writeManifest(join(root, "r1"), { non_goods: {} });
    const result = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets, lane: "goods" }, fakeExec);
    expect(result.ok).toBe(true);
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(flagValue(calls[0] as string[], "--lane")).toBe("goods");
  });
  it("无 manifest 不传 lane → eval_lane_unresolved＋业务文案（不进冻结账本）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, join(pin, "argv.jsonl"));
    const { assets } = writeEvalFixtures(root);
    const result = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("eval_lane_unresolved");
    expect(String(result.note)).toContain("无法从任务事实判定这批数据的评估 lane");
    expect(String(result.note)).toContain("显式指定 lane");
    expect(existsSync(join(root, "r1", "analysis"))).toBe(false); // 零账本落盘
  });
  it("多键任务不传 lane → eval_lane_unresolved＋lanes_seen 对账键＋文案列键名", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, join(pin, "argv.jsonl"));
    const { assets } = writeEvalFixtures(root);
    writeManifest(join(root, "r1"), { goods: {}, non_goods: {} });
    const result = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(result).toMatchObject({ ok: false, error: "eval_lane_unresolved", lanes_seen: ["goods", "non_goods"] });
    expect(String(result.note)).toContain("goods、non_goods");
  });
});

describe("D91——atf_evaluate 锚（卡前快败代码锚＋selections 判定值单源）", () => {
  it("代码锚：lane 判定先于 requestApproval（坏条件零消耗放行）；selections lane 用判定值 evalLane", () => {
    const source = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/trainingFace.ts"), "utf8");
    const laneCheck = source.indexOf("resolveEvalLaneFrom(runDir, args.lane)");
    const approval = source.indexOf('requestApproval(ctx, exec, "atf_evaluate"');
    expect(laneCheck).toBeGreaterThan(-1);
    expect(approval).toBeGreaterThan(laneCheck); // 判定先于审批卡——fail-closed 不消耗放行
    expect(source).toContain("error: \"eval_lane_unresolved\", run_id: runId");
    expect(source).toContain("lane: evalLane, checkpoint_dir: args.adapter_path");
    expect(source).not.toContain('lane: "goods"'); // 硬编码 goods 退役
    // 参数面：evaluate/analyze 双工具描述均不再宣称缺省 goods
    expect(source).not.toContain("缺省 goods，与冻结账本/链一致");
  });
});

// ── D92——dataset_keys 改只读展示（内核实算单源 IterationConfig；禁可编辑不消费）──

describe("D92——只读键单源与卡面字段构造", () => {
  it("READONLY_CONFIG_KEYS 恰双键；CONFIG_CONFIRM_KEYS dataset_keys 条目 default 空串、label 含只读", () => {
    expect([...READONLY_CONFIG_KEYS].sort()).toEqual(["dataset_keys", "max_model_len"]);
    const entry = CONFIG_CONFIRM_KEYS.find((e) => e.key === "dataset_keys");
    expect(entry?.default).toBe("");
    expect(entry?.label).toContain("只读");
    expect(entry?.label).toContain("内核实算");
  });
  it("configFormFieldsOf 不生成只读双键输入框（dataset_keys 与 max_model_len 都滤）", () => {
    const fields = buildConfigConfirmFields({}, {});
    const rows = configFormFieldsOf(fields, 4);
    expect(rows.some((row) => row.key === "dataset_keys")).toBe(false);
    expect(rows.some((row) => row.key === "max_model_len")).toBe(false);
    // 其余键输入框不受牵连（learning_rate 仍在）
    expect(rows.some((row) => row.key === "learning_rate")).toBe(true);
  });
  it("buildConfigConfirmFields 带 fromRegistry.dataset_keys 时值＝实算值（from_registry 通道）", () => {
    const fields = buildConfigConfirmFields({}, { fromRegistry: { dataset_keys: "pl_goods、non_goods" } });
    const row = fields.find((f) => f.key === "dataset_keys");
    expect(row?.value).toBe("pl_goods、non_goods");
    expect(row?.tag).toBe("from_registry");
    // 缺省态（无实算值）：default 空串——占位文案「（由登记面推导）」退役
    const bare = buildConfigConfirmFields({}, {}).find((f) => f.key === "dataset_keys");
    expect(bare).toEqual({ key: "dataset_keys", value: "", tag: "default_used" });
  });
});

describe("D92——confirmFace 链级（baseline 注入实算值＋卡面只读行）", () => {
  /** 表单卡 ask 假件（捕获请求；空 selected＝零改动提交直达审批卡）。 */
  const makeCtx = (calls: unknown[]): { get: (s: string) => unknown } => ({
    get: (s: string) =>
      s === "permissionPresets"
        ? { current: () => "default", defaultPreset: "default" }
        : s === "approval"
          ? { request: async () => "allowed-once" }
          : s === "userQuestions"
            ? { ask: async (req: { questions: ReadonlyArray<{ id: string }> }) => { calls.push(req); return { answers: [{ id: req.questions[0]?.id ?? "q", selected: [] }] }; } }
            : undefined,
  });
  type AskRequest = { detail?: string; intent: { fields: Array<{ key: string }> } };
  const runConfirm = async (root: string, runId: string): Promise<AskRequest> => {
    const calls: unknown[] = [];
    const { buildConfirmTools } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const tools = buildConfirmTools({ runsRoot: root, ctx: makeCtx(calls) }) as unknown as Array<{ execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> }>;
    const result = await tools[0]!.execute({ action: "present", run_id: runId }, { callId: "d92", agent: { session: { id: "d92", header: { cwd: "/w" } } } });
    expect(result.ok).toBe(true);
    // ask 入参形态＝{ questions: [formAskQuestion(...)], agent, signal }——问题对象在 questions[0]
    return (calls[0] as { questions: AskRequest[] }).questions[0] as AskRequest;
  };
  const seedIter = (root: string, runId: string, iter: Record<string, unknown>): void => {
    const dir = join(root, runId, "prep", "iteration-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "iteration-config.json"), JSON.stringify(iter));
  };

  it("IterationConfig dataset 段实算值 → baseline 入卡＋只读行显值；输入框不再生成", async () => {
    const root = tempRoot();
    seedIter(root, "run-d92a", { training: { learning_rate: "2e-4" }, dataset: { dataset_keys: ["pl_goods", "non_goods"] } });
    const request = await runConfirm(root, "run-d92a");
    expect(request.intent.fields.some((f) => f.key === "dataset_keys")).toBe(false); // 只读滤
    expect(request.detail).toContain("数据集键（实算，只读）：pl_goods、non_goods");
  });
  it("IterationConfig 缺席/无 dataset 段 → 只读行如实「实算值未产出」（不造占位数）", async () => {
    const root = tempRoot();
    const request = await runConfirm(root, "run-d92b");
    expect(request.detail).toContain("数据集键（实算，只读）：实算值未产出（IterationConfig 缺席）");
  });
});

describe("D92——Web 摘要（buildLaunchSurface dataset_keys 顶层展平）", () => {
  it("IterationConfig dataset 段实算值进摘要行（iteration_config 来源）；learning_rate 等既有路径不变", async () => {
    const { buildLaunchSurface } = await import("../../packages/extensions/atf-ui/src/server.js");
    const root = tempRoot();
    const dir = join(root, "run-d92c");
    const iterDir = join(dir, "prep", "iteration-config");
    mkdirSync(iterDir, { recursive: true });
    writeFileSync(join(iterDir, "iteration-config.json"), JSON.stringify({
      training: { learning_rate: "2e-4", num_train_epochs: 3 },
      dataset: { dataset_keys: ["pl_goods", "non_goods"] },
    }));
    const surface = buildLaunchSurface(dir);
    const byKey = new Map(surface.summary.map((row) => [row.key, row]));
    expect(byKey.get("dataset_keys")).toMatchObject({ value: "pl_goods,non_goods", source: "iteration_config" });
    expect(byKey.get("learning_rate")).toMatchObject({ value: "2e-4", source: "iteration_config" });
    expect(byKey.get("num_train_epochs")).toMatchObject({ value: "3", source: "iteration_config" });
  });
});

describe("D113——任务事实多源解析（l1/ 与 publish-* 双源；冲突 fail-closed 报两值）", () => {
  /** 发布区 manifest 写入（walkthrough 实锚形态 publish-ws-<slug>）。 */
  const writePublishManifest = (runDir: string, publishName: string, lanes: unknown): void => {
    mkdirSync(join(runDir, publishName), { recursive: true });
    writeFileSync(join(runDir, publishName, "training-data-manifest.json"), `${JSON.stringify({ schema_version: "TrainingDataArtifact/v1", lanes }, null, 1)}\n`);
  };
  it("publish-* 单源命中（l1/ 缺席）→ lane=发布区值（B7 缺陷⑫：walkthrough manifest 落发布区不再 eval_lane_unresolved）", () => {
    const runDir = tempRoot();
    writePublishManifest(runDir, "publish-ws-7a34020b", { swb_mixed: {} });
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: true, lane: "swb_mixed", source: "task_fact" });
  });
  it("双源同值 → 取该值（源不敏感）", () => {
    const runDir = tempRoot();
    writeManifest(runDir, { swb_mixed: {} });
    writePublishManifest(runDir, "publish-ws-7a34020b", { swb_mixed: {} });
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: true, lane: "swb_mixed", source: "task_fact" });
  });
  it("双源冲突 → lanes_conflict_across_sources fail-closed 报两值（不猜先来后到；显式 lane 可解）", () => {
    const runDir = tempRoot();
    writeManifest(runDir, { goods: {} });
    writePublishManifest(runDir, "publish-ws-7a34020b", { swb_mixed: {} });
    const verdict = resolveEvalLaneFrom(runDir, undefined);
    expect(verdict).toMatchObject({ ok: false, reason: "lanes_conflict_across_sources" });
    if (!verdict.ok) {
      expect(verdict.conflict).toEqual([
        { source: join(runDir, "l1", "training-data-manifest.json"), lanes: ["goods"] },
        { source: join(runDir, "publish-ws-7a34020b", "training-data-manifest.json"), lanes: ["swb_mixed"] },
      ]);
    }
    // 冲突态显式 lane 覆盖可解
    expect(resolveEvalLaneFrom(runDir, "goods")).toEqual({ ok: true, lane: "goods", source: "explicit" });
  });
  it("多个 publish-* 目录同值 → 取该值；单源内多键仍 lanes_ambiguous（不因多源而放宽）", () => {
    const runDir = tempRoot();
    writePublishManifest(runDir, "publish-ws-a", { swb_mixed: {} });
    writePublishManifest(runDir, "publish-ws-b", { swb_mixed: {} });
    expect(resolveEvalLaneFrom(runDir, undefined)).toEqual({ ok: true, lane: "swb_mixed", source: "task_fact" });
    const ambiguous = tempRoot();
    writePublishManifest(ambiguous, "publish-ws-a", { goods: {}, non_goods: {} });
    expect(resolveEvalLaneFrom(ambiguous, undefined)).toEqual({ ok: false, reason: "lanes_ambiguous", lanesSeen: ["goods", "non_goods"] });
  });
});
