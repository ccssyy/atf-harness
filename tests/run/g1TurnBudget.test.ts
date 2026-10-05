/** G1 拆解单元①最小单测（批㉞H-H3）：turnBudget.ts——预算层纯函数独立可测锚。
 *  既有 runner 全量断言零改动（零行为变化由全量回归承载）；本文件只钉迁出单元的独立语义。 */
import { describe, expect, it } from "vitest";
import { budgetWarnedThisTurnOf, BUDGET_WARN_MARKER, turnEstimateTokensOf, withBudgetWarningNudge } from "../../src/core/run/turnBudget.js";
import type { SessionEvent } from "../../src/core/session/index.js";

const ev = (id: number, type: string, payload: unknown): SessionEvent =>
  ({ id, type, payload }) as unknown as SessionEvent;

describe("G1 单元① turnBudget（上下文组装·预算层——事件流纯推导）", () => {
  it("turnEstimateTokensOf：自末次 turn/start 起增量；compaction/repair/attempt 不计", () => {
    const events: SessionEvent[] = [
      ev(1, "turn/start", { a: "x".repeat(20) }),
      ev(2, "session/compaction", { big: "y".repeat(1000) }),
      ev(3, "assistant/attempt", { big: "z".repeat(1000) }),
      ev(4, "tool/result", { r: "x".repeat(20) }),
      ev(5, "turn/start", { b: "x".repeat(10) }),
      ev(6, "tool/result", { r: "x".repeat(30) }),
    ];
    // 只计事件 5+6（末次 turn/start 后的实质增量）；chars/2 向上取整
    const expected = Math.ceil(JSON.stringify(events[5]!.payload).length / 2) + Math.ceil(JSON.stringify(events[4]!.payload).length / 2);
    expect(turnEstimateTokensOf(events)).toBe(expected);
    expect(turnEstimateTokensOf([])).toBe(0); // 无 turn/start → 全量计（空流=0）
  });
  it("budgetWarnedThisTurnOf：末次 turn/start 后 tool/result nudge 含标记即 true；前 turn 不算", () => {
    const events: SessionEvent[] = [
      ev(1, "turn/start", {}),
      ev(2, "tool/result", { nudge: `${BUDGET_WARN_MARKER}：…` }),
      ev(3, "turn/start", {}),
      ev(4, "tool/result", { nudge: "无进展提示" }),
    ];
    expect(budgetWarnedThisTurnOf(events)).toBe(false);
    (events[3] as { payload: { nudge?: string } }).payload["nudge"] = `其他；${BUDGET_WARN_MARKER}：80%`;
    expect(budgetWarnedThisTurnOf(events)).toBe(true);
  });
  it("withBudgetWarningNudge：达 80% 注入（百分比封顶 100＋既有 nudge 拼接在后）；未达不动", () => {
    type Payload = Record<string, unknown> & { nudge?: unknown };
    const filler = "x".repeat(200);
    const events: SessionEvent[] = [ev(1, "turn/start", { f: filler })];
    const budget = turnEstimateTokensOf(events) + Math.ceil(JSON.stringify({ ok: true }).length / 2) + 10;
    const at80: Payload = { ok: true, result: "y".repeat(budget) };
    const injected = withBudgetWarningNudge(events, at80, budget) as { nudge?: string };
    expect(typeof injected["nudge"] === "string" && injected["nudge"]!.includes(BUDGET_WARN_MARKER)).toBe(true);
    const preexisting: Payload = { ok: false, nudge: "既有附注" };
    const injected2 = withBudgetWarningNudge(events, preexisting, 1) as { nudge?: string }; // budget=1 必达阈值
    expect(injected2["nudge"]!.startsWith(BUDGET_WARN_MARKER)).toBe(true);
    expect(injected2["nudge"]!.endsWith("既有附注")).toBe(true);
    const small: Payload = { ok: true };
    expect(withBudgetWarningNudge(events, small, 1_000_000)).toBe(small); // 未达 80% 原对象返回（零加工）
    expect(small["nudge"]).toBeUndefined();
  });
});
