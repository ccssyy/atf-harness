/** G1 拆解单元②最小单测（批㉞H-H3）：turnCollapse.ts——控制面三级处置收口面独立可测锚。 */
import { describe, expect, it } from "vitest";
import {
  buildCollapseSummaryOf,
  consecutiveProviderFailuresOf,
  firstLineOf,
  providerErrorDetailOf,
  type CollapseState,
} from "../../src/core/run/turnCollapse.js";
import type { SessionEvent } from "../../src/core/session/index.js";

const ev = (id: number, type: string, payload: unknown): SessionEvent =>
  ({ id, type, payload }) as unknown as SessionEvent;

const baseState: CollapseState = { turnsOpened: 2, turnStepCount: 7, turnRejectCalls: [] };

describe("G1 单元② turnCollapse（控制面三级处置·收口面）", () => {
  it("buildCollapseSummaryOf：阻塞说明取快照值＋reject 径 hint.note 与 D-1 文案逐字一致", () => {
    const summary = buildCollapseSummaryOf(baseState, {
      reason: "reject_loop_exhausted",
      limit: 3,
      rejected: [{ tool: "atf_admit_data", reason: "dataset_missing", params_digest: "abc" }],
      stuckAt: "连续 3 次工具调用被拒（最近：atf_admit_data）",
    });
    expect(summary.blocked_description).toEqual({ stuck_at: "连续 3 次工具调用被拒（最近：atf_admit_data）", turns_used: 2, steps_used: 7 });
    expect(summary.hint.note).toContain("修正参数后输入新指令即可继续本会话");
    expect(summary.hint.gate_ids).toBeUndefined(); // 无 atf_gate 被拒不携带
    expect(summary.rejected).toHaveLength(1);
  });
  it("buildCollapseSummaryOf：被拒清单含 atf_gate → gate_ids 携带；material-gap 快照自动出缺口卡", () => {
    const withGate = buildCollapseSummaryOf(
      { ...baseState, turnRejectCalls: [{ tool: "atf_gate", reason: "x", params_digest: "d" }] },
      { reason: "reject_loop_exhausted", stuckAt: "s" },
    );
    expect(Array.isArray(withGate.hint.gate_ids)).toBe(true);
    expect(withGate.hint.gate_ids!.length).toBeGreaterThan(0);
    const withGap = buildCollapseSummaryOf(
      { ...baseState, turnLastMaterialGap: { tool: "atf_admit_data", reason: "dataset_missing" } },
      { reason: "no_progress", stuckAt: "s" },
    );
    expect(withGap.gap_card).toBeDefined(); // gapCardFor 注册表命中即出卡（blockGuidance 同源）
  });
  it("providerErrorDetailOf：白名单提取（status/body_excerpt≤500/request_summary）；request_body 永不入摘要", () => {
    const detail = providerErrorDetailOf({
      detail: { status: 429, body_excerpt: "x".repeat(600), request_summary: { max_tokens: 8 }, request_body: { secret: 1 } },
    });
    expect(detail["status"]).toBe(429);
    expect((detail["body_excerpt"] ?? "").length).toBeLessThanOrEqual(501); // 500＋省略号
    expect(detail["request_summary"]).toEqual({ max_tokens: 8 });
    expect(JSON.stringify(detail)).not.toContain("request_body");
    expect(providerErrorDetailOf({ detail: "flat" })).toEqual({});
    expect(firstLineOf("first\nsecond", 120)).toBe("first");
  });
  it("consecutiveProviderFailuresOf：流尾连续 provider_failure 计数（含本拍起算 1），非该类即截断", () => {
    const pf = (id: number) => ev(id, "turn/end", { failure_summary: { reason: "provider_failure" } });
    const other = (id: number) => ev(id, "turn/end", { failure_summary: { reason: "budget_exhausted" } });
    expect(consecutiveProviderFailuresOf([])).toBe(1);
    expect(consecutiveProviderFailuresOf([pf(1), pf(2)])).toBe(3);
    expect(consecutiveProviderFailuresOf([pf(1), other(2)])).toBe(1); // 流尾 turn/end 非 provider_failure 即截断
    expect(consecutiveProviderFailuresOf([ev(1, "tool/result", {}), pf(2)])).toBe(2); // 非 turn/end 事件跳过不截断
  });
});
