/**
 * Loop stopReason（切片 1，A2 终止判据——《agent-loop 设计（已升格）》§4 A2 落地）。
 *
 * 五值枚举**只扩面、不改既有取值**：既有 turn/end.payload.reason（= outcome 收口原因）
 * 取值零改动；stop_reason 为 turn/end.payload 的**新增可选字段**（纯增量，不 bump 任何版本轴）。
 *
 * 确定性纪律：判据是纯函数（同输入同结果），来源不依赖内核内存态——状态只落本侧事件流
 * （durability 公理）。预算常量（LOOP_MAX_STEPS_PER_TURN / LOOP_MAX_TURNS）收在
 * src/session/constants.ts，模型不可见（不进入 prompt、工具参数或决策对象）。
 */

export type LoopStopReason = "final_answer" | "no_more_tools" | "budget_exhausted" | "error" | "aborted";

export const LOOP_STOP_REASONS: readonly LoopStopReason[] = [
  "final_answer",
  "no_more_tools",
  "budget_exhausted",
  "error",
  "aborted",
] as const;

/**
 * A2 null 分支的确定性判定：provider 返回 null（自然结束）时——
 * - 本 turn 已产出 final_answer → completed(no_more_tools)；
 * - 否则 → 未收束（返回 null，由 runner 维持既有 provider_failure 终局：
 *   "以可执行内容为准"——声称完成但无 final_answer 且无待处理动作，不判成功）。
 */
export const resolveExhaustionStop = (
  finalAnswerProduced: boolean,
): { ok: true; stopReason: Extract<LoopStopReason, "no_more_tools"> } | null =>
  finalAnswerProduced ? { ok: true, stopReason: "no_more_tools" } : null;

// ---------------------------------------------------------------------------
// R1：length 截断恢复判据（pi-ai 换库批 2026-09-23，指令 §3.3；纯函数，与 A2 同源纪律）
// ---------------------------------------------------------------------------

/** length 有界自动重试上限（恰 1 次；计入 max_calls_per_run——预算护栏语义不变）。 */
export const LENGTH_RETRY_LIMIT = 1;

export type LengthRecoveryAction =
  | { action: "retry" }
  | { action: "collapse"; cause: "partial_content" | "retry_exhausted" };

/**
 * length 分型恢复决策（R1/R2）：
 * - contentEmpty（仅思考块吞预算）且重试未达上限 → 恰 1 次自动重试（R2 单独计数＋过程流留痕）；
 * - contentEmpty 但重试已耗 → 收口（retry_exhausted），gap_card 引导「降低思考等级／输入新指令」；
 * - content 非空截断 → 不自动重试（已有部分产出，重试性价比低）→ 收口（partial_content），
 *   gap_card 续跑引导（续跑以既有历史重建）。
 * 判据纯函数：同输入同结果；重试计数由 runner 每 turn 重建（durability 公理同源）。
 */
export const resolveLengthRecovery = (
  contentEmpty: boolean,
  retriesUsed: number,
  limit: number = LENGTH_RETRY_LIMIT,
): LengthRecoveryAction => {
  if (!contentEmpty) return { action: "collapse", cause: "partial_content" };
  return retriesUsed < limit ? { action: "retry" } : { action: "collapse", cause: "retry_exhausted" };
};
