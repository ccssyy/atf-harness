import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/bridge/index.js";
import {
  type LlmDecision,
  type LlmProvider,
  type Scenario,
} from "../../src/llm/index.js";
import {
  LOOP_STOP_REASONS,
  ScenarioRunner,
  resolveExhaustionStop,
  type BranchRunReport,
} from "../../src/core/run/index.js";
import { LOOP_MAX_STEPS_PER_TURN, LOOP_MAX_TURNS } from "../../src/core/session/constants.js";

/**
 * 切片 1 验收测试（任务书 §3 VERIFY 1–6、8）：loop 骨架——终止判据、轮次预算、step 元数据、不变量。
 *
 * - 判据来源确定性：stopReason 判定为纯函数/常量驱动（同输入同结果），状态只落本侧事件流；
 * - 预算模型不可见：常量收在 src/core/session/constants.ts，注入上下文/工具参数/决策对象三处皆无；
 * - INV-1/2/3 断言：turn 成对不嵌套 / 可写终局收口 turn / switch 仅在 turn 边界。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const branchOf = (steps: Scenario["branches"][string]["steps"], overrides?: { segments?: Scenario["branches"][string]["segments"] }): Scenario => ({
  scenario_id: "slice1-loop",
  version: 1,
  provider: "faux",
  description: "切片 1 loop 骨架测试场景",
  branches: {
    guard: {
      branch_id: "guard",
      run_id: "slice1-loop-run",
      trigger_instruction: "切片 1 loop 骨架测试触发指令",
      purpose: "终止判据 + 轮次预算 + step 元数据验收",
      setup: { ledger: [] },
      steps,
      expect: { outcome: "completed", exit_code: 0 },
      ...(overrides?.segments !== undefined ? { segments: overrides.segments } : {}),
    },
  },
});

const runWith = async (
  provider: LlmProvider | undefined,
  steps: Scenario["branches"][string]["steps"],
  segments?: Scenario["branches"][string]["segments"],
  budgets?: { turnTokenBudget?: number; hardStepFuse?: number },
): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(branchOf(steps, { segments }), "guard", {
    runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    ...(provider !== undefined ? { modelProvider: provider } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

const seenContexts: string[] = [];
/** 捕获 decide 收到的注入上下文（预算不可见性断言的采样面）。 */
const contextCapturingProvider = (queue: (LlmDecision | null)[], failAt?: number): LlmProvider => {
  let index = 0;
  return {
    providerId: "faux",
    decide: async (context) => {
      seenContexts.push(JSON.stringify(context));
      if (failAt !== undefined && index === failAt) return err({ code: "provider_failure", message: "模拟截断故障（切片 1 VERIFY 5）" });
      const next = queue[index];
      index += 1;
      return ok(next ?? null);
    },
  };
};

const assertTurnPairing = (types: string[]): void => {
  // INV-1：turn/start 与 turn/end 严格成对、不嵌套（任意前缀 end 数 ≤ start 数，终态相等）
  let depth = 0;
  for (const type of types) {
    if (type === "turn/start") depth += 1;
    if (type === "turn/end") depth -= 1;
    expect(depth, `turn 配对被破坏（depth=${String(depth)}）`).toBeGreaterThanOrEqual(0);
  }
  expect(depth, "turn 未收口（INV-2）").toBe(0);
};

describe("切片 1 · VERIFY 1 终止判据各自收敛", () => {
  it("final_answer → completed(0)，turn/end 携 stop_reason=final_answer", { timeout: 60_000 }, async () => {
    const r = await runWith(undefined, [{ type: "final_answer", text: "done" }]);
    expect(r.outcome.kind).toBe("completed");
    expect(r.exit_code).toBe(0);
    const turnEnd = r.events.find((event) => event.type === "turn/end");
    expect(turnEnd?.payload).toMatchObject({ reason: "completed", stop_reason: "final_answer" });
  });

  it("no_more_tools 判据（单元）：null 且已产出 final_answer → completed；否则未收束（null）", () => {
    expect(resolveExhaustionStop(true)).toEqual({ ok: true, stopReason: "no_more_tools" });
    expect(resolveExhaustionStop(false)).toBeNull();
    expect(LOOP_STOP_REASONS).toContain("no_more_tools");
    // 实施口径说明：final_answer 决策分派即收口（判据 1），故判据 2 在 runner 层为
    // null 分支的防御形态——由 resolveExhaustionStop 纯函数承载并在此直测。
  });

  it("error → turn 级收口(1)：stop_reason=error 保留＋failure_summary（D-f-1 改 turn_failed；脚本径仍终局）", { timeout: 60_000 }, async () => {
    const r = await runWith(contextCapturingProvider([], 0), [{ type: "final_answer", text: "irrelevant" }]);
    expect(r.outcome.kind).toBe("turn_failed");
    expect(r.exit_code).toBe(1);
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.type).toBe("turn/end");
    expect(turnEnd?.payload).toMatchObject({ reason: "failed", stop_reason: "error", failure_summary: { reason: "provider_failure" } });
    assertTurnPairing(r.events.map((event) => event.type));
  });

  it("aborted → aborted(79)，stop_reason=aborted（P2-S2 abort 路径贯通）", { timeout: 60_000 }, async () => {
    // 问答轨 abort：无预录 → atf_admit_data 走问答轨 → 桩应答 verdict=aborted（既有 P2-S2 语义零改动）
    const scenario = branchOf([
      { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "r2-fixture-ds-abort" } },
      { type: "final_answer", text: "irrelevant" },
    ]);
    const ran = await ScenarioRunner.runBranch(scenario, "guard", {
      runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
      mockCommand: ["node", mockPath],
      approvalSurface: {
        stub: async () => ({ verdict: "aborted", actor: "stub-host", reason: "任务取消" }),
      },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) return;
    const r = ran.value;
    expect(r.outcome.kind).toBe("aborted");
    expect(r.exit_code).toBe(79);
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.type).toBe("turn/end");
    expect(turnEnd?.payload).toMatchObject({ reason: "aborted", stop_reason: "aborted" });
    assertTurnPairing(r.events.map((event) => event.type));
  });
});

describe("切片 1 · VERIFY 2 预算耗尽（确定性，复用 exit 1）", () => {
  it(`兜底保险丝（批 2.5 §二 层四）：模型面步数触达 hardStepFuse → turn 级收口(1)：stop_reason 保留＋summary（原 32 步硬切断迁移；注入 fuse=${String(LOOP_MAX_STEPS_PER_TURN)} 保持触发点）`, { timeout: 120_000 }, async () => {
    const endless: LlmDecision[] = Array.from({ length: LOOP_MAX_STEPS_PER_TURN + 5 }, (_, index) => ({
      type: "assistant_message",
      text: `步骤 ${String(index)}`,
    }));
    const r = await runWith(contextCapturingProvider(endless), [{ type: "final_answer", text: "irrelevant" }], undefined, { hardStepFuse: LOOP_MAX_STEPS_PER_TURN });
    expect(r.outcome.kind).toBe("turn_failed");
    if (r.outcome.kind === "turn_failed") {
      expect(r.outcome.summary.reason).toBe("budget_exhausted");
      expect(r.outcome.summary.limit).toBe(LOOP_MAX_STEPS_PER_TURN);
      expect(r.outcome.summary.blocked_description?.turns_used).toBe(1);
    }
    expect(r.exit_code).toBe(1);
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.payload).toMatchObject({ reason: "failed", stop_reason: "budget_exhausted", failure_summary: { reason: "budget_exhausted" } });
  });

  it(`超 max_turns(${String(LOOP_MAX_TURNS)})：9 段分支在第 9 个 turn 前被拒 → failed(budget_exhausted)`, { timeout: 120_000 }, async () => {
    const segments = Array.from({ length: LOOP_MAX_TURNS + 1 }, (_, index) => ({
      provider_id: index % 2 === 0 ? "faux" : "faux-alt",
      steps: [{ type: "assistant_message", text: `段 ${String(index)}` }] as Scenario["branches"][string]["steps"],
    }));
    const r = await runWith(undefined, [], segments);
    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") expect(r.outcome.error.code).toBe("budget_exhausted");
    expect(r.exit_code).toBe(1);
    // 预算耗尽发生在第 9 个 turn 开启之前：恰 8 个 turn/start，且最后一个事件为预算收口 turn/end
    expect(r.events.filter((event) => event.type === "turn/start")).toHaveLength(LOOP_MAX_TURNS);
    expect(r.events[r.events.length - 1]?.payload).toMatchObject({ reason: "failed", stop_reason: "budget_exhausted" });
  });
});

describe("切片 1 · VERIFY 3 预算不可见（模型面无法感知）", () => {
  it("注入上下文中不出现预算常量名或值；决策对象类型面无预算字段", { timeout: 60_000 }, async () => {
    seenContexts.length = 0;
    await runWith(contextCapturingProvider([{ type: "assistant_message", text: "hi" }, { type: "final_answer", text: "done" }]), [
      { type: "final_answer", text: "irrelevant" },
    ]);
    expect(seenContexts.length).toBeGreaterThanOrEqual(2);
    for (const context of seenContexts) {
      expect(context).not.toContain("max_steps_per_turn");
      expect(context).not.toContain("max_turns");
      expect(context).not.toContain("budget");
      expect(context).not.toContain("stop_reason");
    }
    // 类型面：LlmDecision 三成员无预算字段（编译期由 tsc 保证；此处运行时复核决策对象键集）
    const decision: LlmDecision = { type: "tool_call", tool: "atf_workspace_status", params: {} };
    expect(Object.keys(decision).sort()).toEqual(["params", "tool", "type"]);
  });
});

describe("切片 1 · VERIFY 4 step 元数据（与事件流实际计数一致）", () => {
  it("正常收尾 turn/end.payload 含 step_count/decision_count 且可由事件流推导", { timeout: 60_000 }, async () => {
    const r = await runWith(undefined, [
      { type: "assistant_message", text: "第一条" },
      { type: "assistant_message", text: "第二条" },
      { type: "final_answer", text: "done" },
    ]);
    const startIndex = r.events.findIndex((event) => event.type === "turn/start");
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.type).toBe("turn/end");
    const inTurn = r.events.slice(startIndex + 1, r.events.length - 1);
    const messageCount = inTurn.filter((event) => event.type === "assistant/message").length;
    expect(turnEnd?.payload).toMatchObject({
      reason: "completed",
      stop_reason: "final_answer",
      step_count: 3,
      decision_count: 3,
    });
    // 事件流推导：3 个可执行决策 ↔ 3 条 assistant/message（本分支无 tool/工作区步骤）
    expect(messageCount).toBe(3);
  });
});

describe("切片 1 · VERIFY 5 以可执行内容为准", () => {
  it("完整工具请求已产出后 provider 截断故障 → 该请求仍执行（tool/result 在场），随后 turn 级收口（stop_reason=error；D-f-1）", { timeout: 60_000 }, async () => {
    const queue: (LlmDecision | null)[] = [
      { type: "tool_call", tool: "atf_workspace_status", params: {} },
    ];
    const provider: LlmProvider = {
      providerId: "faux",
      decide: async () => {
        const next = queue.shift();
        if (next === undefined) return err({ code: "provider_failure", message: "截断：后续决策不可得" });
        return ok(next);
      },
    };
    const r = await runWith(provider, [{ type: "final_answer", text: "irrelevant" }]);
    expect(r.events.map((event) => event.type)).toContain("tool/result");
    expect(r.outcome.kind).toBe("turn_failed");
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.payload).toMatchObject({ stop_reason: "error", failure_summary: { reason: "provider_failure" } });
  });

  it("声称完成但无 final_answer 且无待处理动作 → turn 级收口（provider_failure，不猜测成功；D-f-1）", { timeout: 60_000 }, async () => {
    const r = await runWith(contextCapturingProvider([{ type: "assistant_message", text: "我做完了" }]), [
      { type: "final_answer", text: "irrelevant" },
    ]);
    expect(r.outcome.kind).toBe("turn_failed");
    if (r.outcome.kind === "turn_failed") expect(r.outcome.summary.reason).toBe("provider_failure");
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.payload).toMatchObject({ reason: "failed", failure_summary: { reason: "provider_failure" } });
    expect((turnEnd?.payload as { stop_reason?: string }).stop_reason).toBeUndefined();
  });
});

describe("切片 1 · VERIFY 6 不变量（INV-1/2/3）", () => {
  it("INV-1/2：段分支终局 turn 成对收口（含挂起外的全部终局）；INV-3：switch 事件仅存在于 turn 边界之间", { timeout: 60_000 }, async () => {
    const segments: Scenario["branches"][string]["segments"] = [
      { provider_id: "faux", steps: [{ type: "assistant_message", text: "段一" }] },
      { provider_id: "faux-alt", steps: [{ type: "final_answer", text: "done" }] },
    ];
    const r = await runWith(undefined, [], segments);
    expect(r.outcome.kind).toBe("completed");
    const types = r.events.map((event) => event.type);
    assertTurnPairing(types);
    // INV-3：switch 事件夹在 turn/end 与下一 turn/start 之间（turn 边界窗口）
    const switchIndex = types.indexOf("provider/switch");
    expect(switchIndex).toBeGreaterThan(-1);
    expect(types[switchIndex - 1]).toBe("turn/end");
    expect(types[switchIndex + 1]).toBe("turn/start");
    // 两 turn 的 step/decision 元数据各自记账（段一 1 步；段二 final_answer 1 步）
    const turnEnds = r.events.filter((event) => event.type === "turn/end");
    expect(turnEnds[0]?.payload).toMatchObject({ reason: "provider_switch", step_count: 1, decision_count: 1 });
    expect(turnEnds[1]?.payload).toMatchObject({ reason: "completed", stop_reason: "final_answer", step_count: 1, decision_count: 1 });
  });
});
