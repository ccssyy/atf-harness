/**
 * D-f 批门 2（门 2 放行件 §一；《ATF-Harness_指令_Df批非终局失败全覆盖_草案待裁_20260921.md》v4）：
 * 非终局 turn 失败全覆盖＋无进展检测三档＋guidance 回填＋缺口卡收口。
 *
 * 用例覆盖（门 1 放行件 §二 五条＋门 2 补正 3 项）：
 *   budget_exhausted → 收口 → 存活语义 → 同会话续跑；provider_failure 同款；
 *   exact repeat → nudge → 切断 → 收口；轮询白名单不误报；缺关键输入 → 缺口卡收口 → 可续；
 *   补正#1 切断回填隔离（3 次切断不触 reject 阈值）；补正#2 :943 显式带 summary 收口。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import {
  NoProgressDetector,
  ScenarioRunner,
  type BranchRunReport,
} from "../../src/core/run/index.js";
import { collapseLines } from "../../src/ui/collapseView.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "df-collapse",
  version: 1,
  provider: "faux",
  description: "D-f 批门 2 测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "df-turn-collapse",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

/** 模型面 provider 桩（无 decisionFace 字段 = 模型面；捕获 decide 上下文供 nudge 可见性断言）。 */
const modelStub = (decisions: LlmDecision[], contexts?: string[]): LlmProvider => ({
  providerId: "df-stub-model",
  decide: async (context) => {
    contexts?.push(JSON.stringify(context));
    return ok(decisions.shift() ?? null);
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "stub-host" });

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `df-${randomUUID()}`);

const turnEndPayload = (report: BranchRunReport): Record<string, unknown> => {
  const turnEnd = report.events.find((event) => event.type === "turn/end");
  return (turnEnd?.payload ?? {}) as Record<string, unknown>;
};

describe("D-f-1/D-f-2：budget_exhausted → turn 级收口 → 存活 → 同会话续跑", () => {
  it("token 预算耗尽（批 2.5 层一，注入小预算）→ turn_failed(reason=budget_exhausted)＋stop_reason 保留（原 32 步径迁移）", async () => {
    let asked = 0;
    const provider: LlmProvider = {
      providerId: "df-stub-model",
      decide: async () => {
        asked += 1;
        // 逐拍互异参数（evidence_refs 变化）→ 不触无进展检测，纯预算耗尽路径
        return ok({ type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query", evidence_refs: [`df-ref-${String(asked)}`] } });
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`df-budget-${randomUUID()}`, "查询"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
      budgets: { turnTokenBudget: 500 }, // 注入小预算（est tokens）——token 径触达，先于 fuse
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("budget_exhausted");
    expect(summary.limit).toBe(500);
    expect(summary.blocked_description?.turns_used).toBe(1);
    expect(summary.blocked_description?.stuck_at).toContain("token 预算");
    expect(summary.blocked_description?.stuck_at).toContain("atf_gate");
    // 走查修复小批 §三.1：「疑似异常循环／安全熔断线」文案仅限 fuse 径——token 预算径不得携带
    expect(summary.blocked_description?.stuck_at).not.toContain("疑似异常循环");
    expect(summary.blocked_description?.stuck_at).not.toContain("安全熔断线");
    // 补正#2 同口径：收口显式落 turn/end（stop_reason 保留＋failure_summary 在场）
    expect(turnEndPayload(report)).toMatchObject({
      reason: "failed",
      stop_reason: "budget_exhausted",
      failure_summary: { reason: "budget_exhausted", limit: 500 },
    });
  });

  it("预算收口后同 run-id continue 续跑成功（会话可继续；TUI 存活语义的 runner 契约面）", async () => {
    const runsRoot = runsRootOf();
    const runId = `df-budget-cont-${randomUUID()}`;
    let asked = 0;
    const endless: LlmProvider = {
      providerId: "df-stub-model",
      decide: async () => {
        asked += 1;
        return ok({ type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query", evidence_refs: [`df-c-${String(asked)}`] } });
      },
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "查询"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: endless,
      approvalSurface: { stub: grantedStub },
      budgets: { turnTokenBudget: 500 },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("turn_failed");
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "收窄后再来"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_workspace_status", params: {} },
        { type: "final_answer", text: "已按收窄请求完成。" },
      ]),
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "收窄后再来" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
    expect(second.value.exit_code).toBe(0);
  });
});

describe("D-f-1：provider_failure（decide err）→ turn 级收口 → 同会话续跑", () => {
  it("decide 恒 err → turn_failed(reason=provider_failure)，stop_reason=error 保留", async () => {
    const failing: LlmProvider = {
      providerId: "df-stub-model",
      decide: async () => err({ code: "provider_failure", message: "上游过载（仿真 http_503）" }),
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`df-pvf-${randomUUID()}`, "干活"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: failing,
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(report.outcome.summary.reason).toBe("provider_failure");
    expect(report.outcome.summary.blocked_description?.stuck_at).toContain("上游过载");
    expect(turnEndPayload(report)).toMatchObject({
      reason: "failed",
      stop_reason: "error",
      failure_summary: { reason: "provider_failure" },
    });
  });

  it("provider 收口后同 run-id continue 续跑成功", async () => {
    const runsRoot = runsRootOf();
    const runId = `df-pvf-cont-${randomUUID()}`;
    const failing: LlmProvider = {
      providerId: "df-stub-model",
      decide: async () => err({ code: "provider_failure", message: "上游过载（仿真 http_503）" }),
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "干活"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: failing,
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok && first.value.outcome.kind === "turn_failed").toBe(true);
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "再试一次"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([{ type: "final_answer", text: "恢复后完成。" }]),
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "再试一次" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
  });

  it("补正#2：模型面 null 未收束（runner.ts:943 家族）→ 收口显式带 summary 的 turn/end（stop_reason 缺省）", async () => {
    const r = await ScenarioRunner.runBranch(scenarioOf(`df-null-${randomUUID()}`, "干活"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([{ type: "assistant_message", text: "我做完了" }]),
      approvalSurface: { stub: grantedStub },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.outcome.kind).toBe("turn_failed");
    if (r.value.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(r.value.outcome.summary.reason).toBe("provider_failure");
    const payload = turnEndPayload(r.value);
    expect(payload["reason"]).toBe("failed");
    expect(payload["stop_reason"]).toBeUndefined();
    expect(payload["failure_summary"]).toMatchObject({ reason: "provider_failure" });
    expect(payload["step_count"]).toBe(1);
  });
});

describe("D-f-4：exact repeat → nudge → 切断 → 收口", () => {
  it("fact_scan×4 ＋ workspace_status×3：nudge 回流可见、双工具切断、收口 reason=same_call_repeat", async () => {
    const contexts: string[] = [];
    const decisions: LlmDecision[] = [];
    for (let i = 0; i < 4; i += 1) decisions.push({ type: "tool_call", tool: "atf_fact_scan", params: {} });
    for (let i = 0; i < 3; i += 1) decisions.push({ type: "tool_call", tool: "atf_workspace_status", params: {} });
    const ran = await ScenarioRunner.runBranch(scenarioOf(`df-repeat-${randomUUID()}`, "查一查"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub(decisions, contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("same_call_repeat");
    expect(summary.cut_tools).toEqual(["atf_fact_scan", "atf_workspace_status"]);
    expect(summary.blocked_description?.stuck_at).toContain("切断");
    // nudge 模型可见性：第 2 拍 fact_scan 的下一 decide 上下文含 nudge 文案
    const nudged = contexts.find((context) => context.includes("控制面提示"));
    expect(nudged).toBeDefined();
    // 回流面：第 2 次 fact_scan 的 tool/result 携 nudge 字段
    const results = report.events.filter((event) => event.type === "tool/result");
    const nudgeResults = results.filter((event) => typeof (event.payload as { nudge?: string }).nudge === "string");
    expect(nudgeResults.length).toBeGreaterThanOrEqual(2);
  });

  it("补正#1：切断后 3 次重调被短路回填，不计入 reject 计数（未触发 reject_loop_exhausted）", async () => {
    const decisions: LlmDecision[] = [];
    for (let i = 0; i < 6; i += 1) decisions.push({ type: "tool_call", tool: "atf_fact_scan", params: {} });
    for (let i = 0; i < 3; i += 1) decisions.push({ type: "tool_call", tool: "atf_workspace_status", params: {} });
    const ran = await ScenarioRunner.runBranch(scenarioOf(`df-isolate-${randomUUID()}`, "查一查"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub(decisions),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    // 第 4–6 次 fact_scan = 切断短路回填（恰 3 次；reason=tool_cut_no_progress）
    const cutRefusals = report.events.filter(
      (event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "tool_cut_no_progress",
    );
    expect(cutRefusals.length).toBe(3);
    for (const refusal of cutRefusals) {
      expect((refusal.payload as { detail?: { control_plane?: boolean } }).detail?.control_plane).toBe(true);
    }
    // 若短路回填误入 reject 计数，第 6 拍即以 reject_loop_exhausted 收口——收口原因证隔离
    expect(report.outcome.summary.reason).toBe("same_call_repeat");
    expect(report.outcome.summary.rejected).toBeUndefined();
    expect(report.outcome.summary.cut_tools).toEqual(["atf_fact_scan", "atf_workspace_status"]);
  });
});

describe("D-f-4：轮询白名单不误报（判据化豁免）", () => {
  it("同 pair 重复之间发生状态变化（admit 成功执行）→ 豁免，无 nudge、无切断、正常收尾", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "df-src-"));
    const splitRoot = mkdtempSync(join(tmpdir(), "df-split-"));
    const decisions: LlmDecision[] = [
      { type: "tool_call", tool: "atf_fact_scan", params: {} },
      { type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } },
      { type: "tool_call", tool: "atf_fact_scan", params: {} },
      { type: "final_answer", text: "登记完成，事实索引已更新。" },
    ];
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`df-poll-${randomUUID()}`, "登记后复查"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub(decisions, contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    expect(ran.value.outcome.kind).toBe("completed");
    // 两次 fact_scan 同 pair——中间被 state-changer（admit 成功）隔开 → 合法重询
    expect(contexts.some((context) => context.includes("控制面提示"))).toBe(false);
    const results = ran.value.events.filter((event) => event.type === "tool/result");
    expect(results.some((event) => typeof (event.payload as { nudge?: string }).nudge === "string")).toBe(false);
  });
});

describe("D-f-3/D-f-6：缺关键输入 → guidance 回填 → 缺口卡收口 → 会话可续", () => {
  it("split_manifest_missing×3 → reject 收口自动出缺口卡（四段齐、推荐项标注、可续跑）", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "df-gap-src-"));
    const splitRoot = mkdtempSync(join(tmpdir(), "df-gap-split-"));
    const runId = `df-gap-${randomUUID()}`;
    const runsRoot = runsRootOf();
    // 桩模型读上下文取登记派生 dataset_id（ds-<digest12>）——与真实模型同源（fact_id 出返回值）
    let calls = 0;
    const provider: LlmProvider = {
      providerId: "df-stub-model",
      decide: async (context) => {
        calls += 1;
        if (calls === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } });
        const derived = /ds-[0-9a-f]{12}/.exec(JSON.stringify(context))?.[0] ?? "ds-unresolved";
        return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: derived } });
      },
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "做真实数据校验"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--admission-reason=split_manifest_missing"],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const report = first.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("reject_loop_exhausted");
    // D-f-3：拒绝回流附 guidance 一行文案
    const rejects = report.events.filter(
      (event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "split_manifest_missing",
    );
    expect(rejects.length).toBe(3);
    for (const reject of rejects) {
      expect((reject.payload as { guidance?: string }).guidance ?? "").toContain("global_assignment.csv");
    }
    // D-f-6：缺口卡四段（卡在哪/缺什么/为什么需要/可选项≤3 标推荐）
    const card = summary.gap_card;
    expect(card).toBeDefined();
    expect(card?.stuck).toContain("atf_data_admission_request");
    expect(card?.missing).toContain("global_plan.json");
    expect(card?.why.length ?? 0).toBeGreaterThan(0);
    expect((card?.options.length ?? 0)).toBeLessThanOrEqual(3);
    expect(card?.options[0]?.recommended).toBe(true);
    // 会话可续：材料缺口如实请示后，新指令换路径成功收尾
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "先不校验了，只做状态查询"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_workspace_status", params: {} },
        { type: "final_answer", text: "已如实汇报现状，等待指示。" },
      ]),
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "先不校验了，只做状态查询" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
  });
});

describe("D-f-4 单元：NoProgressDetector（no-op 形态与豁免判据）", () => {
  it("no-op（不同动作同结果）：第 2 拍 nudge、第 3 拍切断；双工具切断 → collapseReason=no_progress", () => {
    const detector = new NoProgressDetector();
    const result = { ok: true, count: 0, facts: [] };
    expect(detector.record("a", {}, { kind: "executed", result })).toEqual({ tier: "none" });
    expect(detector.record("b", {}, { kind: "executed", result })).toEqual({ tier: "nudge", form: "noop" });
    expect(detector.record("c", {}, { kind: "executed", result })).toEqual({ tier: "cut", form: "noop", tool: "c" });
    expect(detector.collapseReady()).toBe(false);
    expect(detector.record("d", { k: 1 }, { kind: "executed", result })).toEqual({ tier: "cut", form: "noop", tool: "d" });
    expect(detector.collapseReady()).toBe(true);
    expect(detector.collapseReason()).toBe("no_progress");
  });

  it("exact repeat 三次 → 切断；collapseReason=same_call_repeat；切断工具不重复登记", () => {
    const detector = new NoProgressDetector();
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result: { count: 0 } }).tier).toBe("none");
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result: { count: 0 } }).tier).toBe("nudge");
    const third = detector.record("atf_fact_scan", {}, { kind: "executed", result: { count: 0 } });
    expect(third).toEqual({ tier: "cut", form: "repeat", tool: "atf_fact_scan" });
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result: { count: 0 } }).tier).toBe("cut");
    expect(detector.cutTools()).toEqual(["atf_fact_scan"]);
  });

  it("轮询豁免：状态变化置时钟，同 pair 计数重置（第 2 次出现视为首次）", () => {
    const detector = new NoProgressDetector();
    const result = { ok: true, count: 0 };
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result }).tier).toBe("none");
    // 状态变化源（POLLING_STATE_CHANGERS）成功执行 → 时钟推进
    expect(detector.record("atf_admit_data", { x: 1 }, { kind: "executed", result: { ok: true } }).tier).toBe("none");
    // 同 pair 重现，但中间发生过状态变化 → 合法重询（计数重置）
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result }).tier).toBe("none");
    // 此后无状态变化的重复照常升级
    expect(detector.record("atf_fact_scan", {}, { kind: "executed", result }).tier).toBe("nudge");
  });
});

describe("D-f-2：收口呈现（collapseLines 纯函数）", () => {
  it("阻塞说明只显示轮次不显示步数；缺口卡四段文字分行；无交互控件语义", () => {
    const lines = collapseLines({
      reason: "reject_loop_exhausted",
      limit: 3,
      rejected: [{ tool: "atf_data_admission_request", reason: "split_manifest_missing", params_digest: "a".repeat(64) }],
      blocked_description: { stuck_at: "准入被拒", turns_used: 3, steps_used: 17 },
      gap_card: {
        stuck: "atf_data_admission_request 调用被内核以 split_manifest_missing 拒绝（业务阻断，非链路错误）",
        missing: "global_assignment.csv 与 global_plan.json",
        why: "缺清单则准入无法建立样本→分区的指派",
        options: [{ text: "补齐 split 料后重试", recommended: true }, { text: "如实停止并等待用户指示" }],
      },
      hint: { note: "修正参数后输入新指令即可继续本会话" },
    });
    const text = lines.join("\n");
    expect(text).toContain("已用 3 轮");
    expect(text).not.toContain("steps_used");
    expect(text).not.toContain("17");
    expect(text).toContain("① 卡在哪：");
    expect(text).toContain("② 缺什么：");
    expect(text).toContain("③ 为什么需要：");
    expect(text).toContain("④ 可选项：");
    expect(text).toContain("（推荐）");
  });
});
