/**
 * F2 批（2026-09-26；指令 docs/_owner/ATF-Harness_指令_F2_跨turn无进展检测_20260925.md）：
 * 跨 turn 无进展检测——同类行为跨 turn 连续重复达阈值时按既有三档控制介入
 * （档 1 nudge → 档 2 切断 → 档 3 run 级收口）。
 *
 * 用例覆盖（指令硬约束 4：正常重试不误伤／绕圈命中 nudge／持续绕圈到收口，各≥1）：
 *   纯函数面：env 非法 fail-closed 回退／状态变化 turn 打断窗口（合法重试不误伤的机查面）／
 *   gate pass 计进展・blocked 不计／低相似打断窗口／update 幂等；
 *   E2E 面（runner 接线，env N=2 收紧档位便于短流复现）：绕圈命中 nudge（非终局）／
 *   admission 落账打断窗口（不误伤）／持续绕圈到切断（turn 链终止，可观测性优先）／
 *   切断后仍绕圈到 run 级收口／低相似换路径不触发。
 *   走查回放：/tmp/wt077-session-final.jsonl.bak（只读引用，存在时才跑——v077 实证素材）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import {
  CrossTurnNoProgressDetector,
  CROSS_TURN_NUDGE_NOTE,
  CROSS_TURNS_DEFAULT,
  CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT,
  resolveCrossTurnNoProgressConfig,
  ScenarioRunner,
  parseSessionStream,
  type BranchRunReport,
  type CrossTurnNoProgressConfig,
} from "../../src/core/run/index.js";
import type { SessionEvent } from "../../src/core/session/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const walkthroughBak = "/tmp/wt077-session-final.jsonl.bak";

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "f2-cross-turn",
  version: 1,
  provider: "faux",
  description: "F2 跨 turn 无进展检测测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "f2-cross-turn-noprogress",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

/** 模型面 provider 桩（无 decisionFace = 模型面；平铺决策队列逐拍 shift，
 *  耗尽返回 null＝turn 收束。每 runBranch 调用各建一个实例——脚本即本轮决策）。 */
const modelStub = (queue: LlmDecision[]): LlmProvider => {
  const rest = [...queue];
  return {
    providerId: "f2-stub-model",
    decide: async () => ok(rest.shift() ?? null),
  };
};

const timeoutStub = async (): Promise<{ verdict: "timeout" }> => ({ verdict: "timeout" });
const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "stub-host" });

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `f2-${Math.random().toString(36).slice(2)}`);

/** 同一 run 上的逐轮 continue（跨 turn 窗口靠共享 runsRoot 累积；decisions = 本轮决策脚本）。 */
const continueRun = async (
  runsRoot: string,
  runId: string,
  instruction: string,
  decisions: LlmDecision[],
  stub: typeof timeoutStub | typeof grantedStub = timeoutStub,
) =>
  await ScenarioRunner.runBranch(scenarioOf(runId, instruction), "main", {
    runsRoot,
    mockCommand: ["node", mockPath],
    modelProvider: modelStub(decisions),
    approvalSurface: { stub },
    continue: { instruction },
  });

const probe = (): LlmDecision => ({ type: "tool_call", tool: "atf_workspace_status", params: {} });
const probeAndAnswer = (): LlmDecision[] => [probe(), { type: "final_answer", text: "已探查。" }];

const nudgeTextsOf = (report: BranchRunReport): string[] =>
  report.events
    .filter((event) => event.type === "tool/result")
    .map((event) => (event.payload as { nudge?: unknown }).nudge)
    .filter((nudge): nudge is string => typeof nudge === "string");

// ---------------------------------------------------------------------------
// 纯函数面（检测器单测——合成事件流；阈值判据与窗口打断语义机查）
// ---------------------------------------------------------------------------

const ev = (id: number, type: string, payload: Record<string, unknown>): SessionEvent =>
  ({ id, ts: "t", type, payload, projection: { evidence_event: null } }) as unknown as SessionEvent;

/** 造一个「探针 turn」的事件区间（tool/call + tool/result ok=true）。 */
const probeTurn = (startId: number, params: Record<string, unknown> = {}): SessionEvent[] => [
  ev(startId, "turn/start", {}),
  ev(startId + 1, "tool/call", { tool: "atf_workspace_status", params }),
  ev(startId + 2, "tool/result", { tool: "atf_workspace_status", ok: true, result: {}, call_ref: startId + 1 }),
  ev(startId + 3, "turn/end", { reason: "completed" }),
];

const configOf = (windowTurns = 3, overlapPermille = 600): CrossTurnNoProgressConfig => ({ windowTurns, overlapPermille });

describe("F2 纯函数面（CrossTurnNoProgressDetector）", () => {
  afterEach(() => {
    delete process.env["ATF_NO_PROGRESS_CROSS_TURNS"];
    delete process.env["ATF_NO_PROGRESS_OVERLAP_PERMILLE"];
  });

  it("env 覆盖与非法值 fail-closed 回退（ATF_* 纪律同源）", () => {
    const defaults = resolveCrossTurnNoProgressConfig();
    expect(defaults).toEqual({ windowTurns: CROSS_TURNS_DEFAULT, overlapPermille: CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT });
    process.env["ATF_NO_PROGRESS_CROSS_TURNS"] = "5";
    process.env["ATF_NO_PROGRESS_OVERLAP_PERMILLE"] = "800";
    expect(resolveCrossTurnNoProgressConfig()).toEqual({ windowTurns: 5, overlapPermille: 800 });
    process.env["ATF_NO_PROGRESS_CROSS_TURNS"] = "abc";
    process.env["ATF_NO_PROGRESS_OVERLAP_PERMILLE"] = "0";
    const fallback = resolveCrossTurnNoProgressConfig();
    expect(fallback.windowTurns).toBe(CROSS_TURNS_DEFAULT);
    expect(fallback.overlapPermille).toBe(CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT);
  });

  it("状态变化 turn 打断窗口（admission 落账＝合法重试不误伤的机查面）；零调用 turn 透明", () => {
    const detector = new CrossTurnNoProgressDetector(configOf(2, 600));
    const events: SessionEvent[] = [
      ...probeTurn(1),
      ...probeTurn(5),
      // 状态变化 turn（admission 成功落账）——窗口归零
      ev(9, "turn/start", {}),
      ev(10, "tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds" } }),
      ev(11, "tool/result", { tool: "atf_admit_data", ok: true, result: { journal_type: "j", fact_id: "f", sha256_digest: "d" }, call_ref: 10 }),
      ev(12, "approval/response", { verdict: "granted", request_event_ref: 10 }),
      ev(13, "turn/end", { reason: "completed" }),
      ...probeTurn(14),
    ];
    detector.update(events);
    expect(detector.windowLength()).toBe(1);
    expect(detector.verdict()).toMatchObject({ tier: "none", windowTurns: 1 });
    // 零调用 turn（纯答复）透明：不延长亦不打断——窗口继续按行为 turn 连续性度量
    detector.update([
      ...events,
      ev(18, "turn/start", {}),
      ev(19, "assistant/message", { text: "纯答复无调用。" }),
      ev(20, "turn/end", { reason: "completed" }),
      ...probeTurn(21),
    ]);
    expect(detector.windowLength()).toBe(2);
    // 再一个行为 turn 即达 W=3（N+1）
    detector.update([
      ...events,
      ev(18, "turn/start", {}),
      ev(19, "assistant/message", { text: "纯答复无调用。" }),
      ev(20, "turn/end", { reason: "completed" }),
      ...probeTurn(21),
      ...probeTurn(25),
    ]);
    expect(detector.windowLength()).toBe(3);
  });

  it("granted 审批与 admission_request 提交不算状态事实（v077 实证：预授权 granted 高频而零落账）", () => {
    // 判别构造：行为面与纯探针 turn 全同（同工具同参），仅多塞 granted 应答/admission_request
    // 提交——旧口径（granted/提交计状态事实）会把窗口打断，新口径照常链式成窗。
    const probePlusGranted = (startId: number): SessionEvent[] => [
      ev(startId, "turn/start", {}),
      ev(startId + 1, "tool/call", { tool: "atf_workspace_status", params: {} }),
      ev(startId + 2, "tool/result", { tool: "atf_workspace_status", ok: true, result: {}, call_ref: startId + 1 }),
      ev(startId + 3, "approval/response", { verdict: "granted", request_event_ref: startId + 1 }),
      ev(startId + 4, "turn/end", { reason: "completed" }),
    ];
    const admReqTurn = (startId: number): SessionEvent[] => [
      ev(startId, "turn/start", {}),
      ev(startId + 1, "tool/call", { tool: "atf_data_admission_request", params: { dataset_id: "ds" } }),
      ev(startId + 2, "tool/result", { tool: "atf_data_admission_request", ok: true, result: { status: "blocked" }, call_ref: startId + 1 }),
      ev(startId + 3, "turn/end", { reason: "completed" }),
    ];
    const detector = new CrossTurnNoProgressDetector(configOf(5, 600));
    detector.update([...probeTurn(1), ...probePlusGranted(5), ...probeTurn(10)]);
    expect(detector.windowLength()).toBe(3); // granted 不打断
    const detector2 = new CrossTurnNoProgressDetector(configOf(5, 600));
    detector2.update([...admReqTurn(1), ...admReqTurn(5), ...admReqTurn(10)]);
    expect(detector2.windowLength()).toBe(3); // admission_request ok=true 不打断（被 blocked 的重复提交即绕圈本身）
  });

  it("gate advance+pass 计状态变更（配对判定）；query 回显 pass 与 advance blocked 不计", () => {
    const gateTurn = (startId: number, action: string, status: string, withCallRef = true): SessionEvent[] => [
      ev(startId, "turn/start", {}),
      ev(startId + 1, "tool/call", { tool: "atf_gate", params: { gate: "G1", action } }),
      ev(startId + 2, "tool/result", { tool: "atf_gate", ok: true, result: { gate: "G1", status }, ...(withCallRef ? { call_ref: startId + 1 } : {}) }),
      ev(startId + 3, "turn/end", { reason: "completed" }),
    ];
    // 同工具行为链上纯以状态轴判别：query/blocked/query-echo 全不入状态轴 → 链式成窗
    const detector = new CrossTurnNoProgressDetector(configOf(5, 600));
    detector.update([...gateTurn(1, "query", "blocked"), ...gateTurn(5, "advance", "blocked"), ...gateTurn(9, "query", "pass")]);
    expect(detector.windowLength()).toBe(3);
    // advance+pass（配对取回 action）＝gate 状态变更 → 窗口归零
    const detector2 = new CrossTurnNoProgressDetector(configOf(5, 600));
    detector2.update([...gateTurn(1, "query", "blocked"), ...gateTurn(5, "advance", "pass"), ...gateTurn(9, "query", "blocked")]);
    expect(detector2.windowLength()).toBe(1);
    // 配对缺失的退化流（无 call_ref）按状态变化计（宁可漏检不误罚）
    const detector3 = new CrossTurnNoProgressDetector(configOf(5, 600));
    detector3.update([...gateTurn(1, "query", "blocked"), ...gateTurn(5, "advance", "pass", false), ...gateTurn(9, "query", "blocked")]);
    expect(detector3.windowLength()).toBe(1);
  });

  it("名字层判据：同工具换参保持链式成窗（v077 形态）；换工具打断窗口（换路径不误伤）", () => {
    const detector = new CrossTurnNoProgressDetector(configOf(3, 600));
    // 同工具、参数逐 turn 微变（精确指纹互异、名字集合恒同）→ 链式成窗
    detector.update([...probeTurn(1), ...probeTurn(5, { detail: "a" }), ...probeTurn(9, { detail: "b" })]);
    expect(detector.windowLength()).toBe(3);
    // 换工具（不同名字集合）→ 对前 turn 双层包含率不足 → 窗口重建
    const otherToolTurn = (startId: number): SessionEvent[] => [
      ev(startId, "turn/start", {}),
      ev(startId + 1, "tool/call", { tool: "atf_gate", params: { gate: "G1", action: "query" } }),
      ev(startId + 2, "tool/result", { tool: "atf_gate", ok: true, result: { gate: "G1", status: "blocked" }, call_ref: startId + 1 }),
      ev(startId + 3, "turn/end", { reason: "completed" }),
    ];
    const detector2 = new CrossTurnNoProgressDetector(configOf(3, 600));
    detector2.update([...probeTurn(1), ...probeTurn(5, { detail: "a" }), ...otherToolTurn(9), ...otherToolTurn(13)]);
    expect(detector2.windowLength()).toBe(2);
  });

  it("窗口达阈值逐档升级：W=N → nudge；W=N+1 → cut；W=N+2 → run_close", () => {
    const detector = new CrossTurnNoProgressDetector(configOf(2, 600));
    const stream: SessionEvent[] = [...probeTurn(1)];
    detector.update(stream);
    expect(detector.verdict().tier).toBe("none");
    detector.update([...stream, ...probeTurn(5)]);
    expect(detector.verdict()).toMatchObject({ tier: "nudge", windowTurns: 2, thresholdTurns: 2 });
    detector.update([...stream, ...probeTurn(5), ...probeTurn(9)]);
    expect(detector.verdict()).toMatchObject({ tier: "cut", windowTurns: 3 });
    detector.update([...stream, ...probeTurn(5), ...probeTurn(9), ...probeTurn(13)]);
    expect(detector.verdict()).toMatchObject({ tier: "run_close", windowTurns: 4 });
  });
});

// ---------------------------------------------------------------------------
// E2E 面（runner 接线；env N=2 收紧档位便于短流复现）
// ---------------------------------------------------------------------------

describe("F2 E2E（runner 接线，模型面）", () => {
  afterEach(() => {
    delete process.env["ATF_NO_PROGRESS_CROSS_TURNS"];
    delete process.env["ATF_NO_PROGRESS_OVERLAP_PERMILLE"];
  });

  const tighten = (): void => {
    process.env["ATF_NO_PROGRESS_CROSS_TURNS"] = "2";
  };

  /** 首轮全新 run（continue 前置：流非空），返回 runsRoot 供逐轮 continue。 */
  const freshRun = async (runId: string, decisions: LlmDecision[], stub: typeof timeoutStub | typeof grantedStub = timeoutStub) => {
    const runsRoot = runsRootOf();
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "初始任务"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: modelStub(decisions),
      approvalSurface: { stub },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    return { runsRoot, firstReport: first.value };
  };

  it("硬约束④①：合法重试不误伤——admission 落账打断窗口，全程零跨 turn nudge", async () => {
    tighten();
    const runId = "f2-legit-retry";
    const { runsRoot } = await freshRun(runId, probeAndAnswer(), grantedStub);
    // t2 探针（W=2 达 N 但档位在下一轮 backfill 才消费）；t3 admission 落账（状态事实，窗口归零）；
    // t4/t5 探针——窗口自 t4 重建，至流尾 W≤2，全程不触发档位
    const t2 = await continueRun(runsRoot, runId, "继续", probeAndAnswer(), grantedStub);
    expect(t2.ok).toBe(true);
    if (!t2.ok) throw new Error("unreachable");
    expect(t2.value.outcome.kind).toBe("completed");
    const t3 = await continueRun(runsRoot, runId, "准入", [
      { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-f2" } },
      { type: "final_answer", text: "已准入。" },
    ], grantedStub);
    expect(t3.ok).toBe(true);
    if (!t3.ok) throw new Error("unreachable");
    expect(t3.value.outcome.kind).toBe("completed");
    const t4 = await continueRun(runsRoot, runId, "继续", probeAndAnswer(), grantedStub);
    const t5 = await continueRun(runsRoot, runId, "继续", probeAndAnswer(), grantedStub);
    expect(t5.ok).toBe(true);
    if (!t5.ok) throw new Error("unreachable");
    expect(t5.value.outcome.kind).toBe("completed");
    // 全程（t1–t5 各轮报告）零跨 turn nudge
    for (const report of [t2, t3, t4, t5]) {
      if (!report.ok) throw new Error("unreachable");
      expect(nudgeTextsOf(report.value).filter((text) => text.includes("连续多轮未见实质进展"))).toEqual([]);
    }
  });

  it("硬约束④②：绕圈命中档 1 nudge（回流文案随拍可见，run 非终局）", async () => {
    tighten();
    const runId = "f2-nudge-hit";
    const { runsRoot } = await freshRun(runId, probeAndAnswer());
    const t2 = await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    expect(t2.ok).toBe(true);
    if (!t2.ok) throw new Error("unreachable");
    expect(t2.value.outcome.kind).toBe("completed");
    const t3 = await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    expect(t3.ok).toBe(true);
    if (!t3.ok) throw new Error("unreachable");
    const report = t3.value;
    // 三轮全部正常收口（nudge 非终局）——t1/t2 零 nudge；t3 携跨 turn 文案（W=2 ≥ N）
    expect(report.outcome.kind).toBe("completed");
    const nudged = nudgeTextsOf(report);
    expect(nudged).toEqual([CROSS_TURN_NUDGE_NOTE]);
  });

  it("硬约束④③：持续绕圈到档 2 切断（turn 链终止；本拍结果先回填——可观测性优先）", async () => {
    tighten();
    const runId = "f2-cut-hit";
    const { runsRoot } = await freshRun(runId, probeAndAnswer());
    const t2 = await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    expect(t2.ok).toBe(true);
    if (!t2.ok) throw new Error("unreachable");
    expect(t2.value.outcome.kind).toBe("completed");
    const t3 = await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    expect(t3.ok).toBe(true);
    if (!t3.ok) throw new Error("unreachable");
    expect(t3.value.outcome.kind).toBe("completed");
    // t4：backfill 时 W=3 ≥ N+1 → 切断（本拍 tool/result 先落盘）
    const t4 = await continueRun(runsRoot, runId, "继续", [probe()]);
    expect(t4.ok).toBe(true);
    if (!t4.ok) throw new Error("unreachable");
    const report = t4.value;
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("no_progress");
    expect(summary.cross_turn).toMatchObject({ window_turns: 3, escalation: "cut" });
    expect(summary.blocked_description?.stuck_at).toContain("跨 turn 无进展");
    // 可观测性优先：切断前本拍 tool/result 已落盘（t1–t4 四轮各一次探针结果）
    const results = report.events.filter((event) => event.type === "tool/result");
    expect(results.length).toBe(4);
    // 收口 turn/end 显式落盘（failure_summary 在场）
    const lastTurnEnd = [...report.events].reverse().find((event) => event.type === "turn/end");
    expect((lastTurnEnd?.payload as { failure_summary?: { reason?: string } }).failure_summary?.reason).toBe("no_progress");
  });

  it("硬约束④③：切断后仍绕圈到档 3 run 级收口（escalation=run_close 机查档位）", async () => {
    tighten();
    const runId = "f2-run-close-hit";
    const { runsRoot } = await freshRun(runId, probeAndAnswer());
    await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    await continueRun(runsRoot, runId, "继续", [probe()]); // t4 切断
    // t5：backfill 时 W=4 ≥ N+2 → run 级收口
    const t5 = await continueRun(runsRoot, runId, "继续", [probe()]);
    expect(t5.ok).toBe(true);
    if (!t5.ok) throw new Error("unreachable");
    const report = t5.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(report.outcome.summary.cross_turn).toMatchObject({ window_turns: 4, escalation: "run_close" });
    expect(report.outcome.summary.blocked_description?.stuck_at).toContain("run 级收口");
  });

  it("换路径（换工具名）不触发——低相似打断窗口", async () => {
    tighten();
    const runId = "f2-path-change";
    const { runsRoot } = await freshRun(runId, probeAndAnswer());
    const t2 = await continueRun(runsRoot, runId, "继续", [
      { type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query" } },
      { type: "final_answer", text: "换路径探查。" },
    ]);
    const t3 = await continueRun(runsRoot, runId, "继续", probeAndAnswer());
    expect(t3.ok).toBe(true);
    if (!t3.ok) throw new Error("unreachable");
    expect(t3.value.outcome.kind).toBe("completed");
    expect(nudgeTextsOf(t3.value)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 走查回放（v077 实证素材；文件在场才跑——只读引用，不改走查 run）
// ---------------------------------------------------------------------------

describe("F2 走查回放（wt077 DeepSeek 线停线收证流）", () => {
  it.skipIf(!existsSync(walkthroughBak))("134 轮绕圈实证流：缺省配置下窗口达档 3（run 级收口判据命中）", async () => {
    const text = await readFile(walkthroughBak, "utf8");
    const parsed = parseSessionStream(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    const detector = new CrossTurnNoProgressDetector(resolveCrossTurnNoProgressConfig());
    detector.update(parsed.value);
    const verdict = detector.verdict();
    expect(verdict.thresholdTurns).toBe(CROSS_TURNS_DEFAULT);
    // v077 形态（连续只读探针＋零账本推进）在缺省阈值下即命中 run 级收口档
    expect(verdict.tier).toBe("run_close");
    expect(verdict.windowTurns).toBeGreaterThanOrEqual(CROSS_TURNS_DEFAULT + 2);
  });
});
