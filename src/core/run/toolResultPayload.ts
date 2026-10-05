/**
 * G1 拆解单元③（批㉞H-H3，沿门 1 设计稿「守卫管道」（参数校验→审批检查→桥接执行→输出校验）
 * 的**结果回填构造**边界）：ToolCallOutcome → tool/result 事件 payload 的唯一构造器。
 *
 * 原状：主循环 / resume 重派 / 确认直填三处各自内联同构的五类 kind 分流（executed／rejected／
 * input_violation／failed／blocked），字段条件附着的细差易漂移——本单元收口为单源构造，
 * 三调用点语义逐位等价（零行为变化）。附注纪律：
 * - nudge 附 executed/rejected/input_violation/blocked 四类（failed 恒不附——与主循环既有语义一致）；
 * - guidance 附 rejected/input_violation（D-f-3 回流指引）；executedGuidance 附 executed
 *   （B3 atf_gate blocked 三段式指引）。
 * 确认凭据并入（F5 4.1）同源在此：ask_user_for_input 的 granted 应答合成 user_confirmation。
 */
import { findExistingCredential } from "../tools/credentialState.js";
import { synthesizeUserConfirmation } from "../confirmRequest.js";
import type { ToolCallOutcome, ToolBlock } from "../tools/index.js";
import type { ApprovalGate } from "../tools/index.js";
import type { ApprovalHandler } from "./approvalTrack.js";
import type { SessionEvent } from "../session/index.js";

/**
 * tool/result 事件 payload 形态(结构化回填,供 Faux 断言失败路径与 B2 block 回填验证)。
 *  P2-S2(A1/R3):call_ref = 被回填的 tool/call 事件 id——凭据消费事实的显式配对键。
 *  D-f 批:nudge/guidance 为可选回填附注（无进展 nudge 指引／业务阻断码 guidance 行；
 *  payload 自由 JSON,模型经 convertToLlm 可见——零 schema 变更）。
 *  自 runner.ts 迁出（G1 拆解单元③；runner 出口面原位 re-export）。
 */
export type ToolResultPayload =
  | { tool: string; ok: true; result: unknown; call_ref: number; nudge?: string }
  | { tool: string; ok: false; reason: string; call_ref: number; block?: ToolBlock; detail?: unknown; nudge?: string; guidance?: string };

const isPlainRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * F5 改动四 4.1（2026-09-26）：confirm 型请示的确认凭据并入。
 *
 * ask_user_for_input 的本地 handler 只产卡面材料（无账面访问权）；问答轨 granted 落账后，
 * 在 tool/result 落盘前按应答事件合成 user_confirmation 并入结果——随凭据下发：
 *   by/at   ＝ granted 应答事件的 actor/ts（账面事实，非本进程时钟编造）；
 *   candidate_digest ＝ handler 对候选文件的复算值（结果体透传）；
 *   approval_ref ＝ approval_session_id（内核仅透传落账与格式校验，改动一 1.3）。
 * 凭据链缺失（无 request/granted——理论上 gate 已拦，防御径）→ 原结果返回（并入跳过，
 * 不伪造凭据——fail-closed）。自 runner.ts 逐字迁出（零行为变化）。
 */
export const mergeConfirmationCredential = (
  events: readonly SessionEvent[],
  toolCallId: number,
  tool: string,
  result: unknown,
): unknown => {
  if (tool !== "ask_user_for_input" || !isPlainRecordValue(result) || result["ok"] !== true) return result;
  const credential = findExistingCredential(events, toolCallId);
  if (credential === null) return result;
  const granted = events.find(
    (event) =>
      event.type === "approval/response" &&
      (event.payload as Record<string, unknown>)["request_event_ref"] === credential.request_event_ref &&
      (event.payload as Record<string, unknown>)["verdict"] === "granted",
  );
  if (granted === undefined) return result;
  const actor = (granted.payload as Record<string, unknown>)["actor"];
  const userConfirmation = synthesizeUserConfirmation({
    actor: typeof actor === "string" && actor !== "" ? actor : "unknown-operator",
    answeredAt: granted.ts,
    candidateDigest: typeof result["candidate_digest"] === "string" ? result["candidate_digest"] : "",
    approvalSessionId: credential.approval_session_id,
  });
  return { ...result, user_confirmation: userConfirmation, approval_session_id: credential.approval_session_id };
};

/** tool/result payload 单源构造（三调用点语义逐位等价——见单元头注附注纪律）。 */
export const buildToolResultPayload = (input: {
  tool: string;
  callRef: number;
  result: ToolCallOutcome;
  /** 会话事件序列（executed 径确认凭据并入的回溯源） */
  events: readonly SessionEvent[];
  /** 无进展/跨 turn nudge 附注（failed 恒不附） */
  nudge?: string;
  /** D-f-3 回流指引（rejected/input_violation 附） */
  guidance?: string;
  /** B3 executed 径指引（atf_gate blocked 三段式） */
  executedGuidance?: string;
}): ToolResultPayload => {
  const { tool, callRef, result } = input;
  if (result.kind === "executed") {
    return {
      tool,
      ok: true,
      result: mergeConfirmationCredential(input.events, callRef, tool, result.result),
      call_ref: callRef,
      ...(input.nudge !== undefined ? { nudge: input.nudge } : {}),
      ...(input.executedGuidance !== undefined ? { guidance: input.executedGuidance } : {}),
    };
  }
  if (result.kind === "rejected" || result.kind === "input_violation") {
    return {
      tool,
      ok: false,
      reason: result.reason,
      call_ref: callRef,
      detail: result.detail,
      ...(input.nudge !== undefined ? { nudge: input.nudge } : {}),
      ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
    };
  }
  if (result.kind === "failed") {
    return { tool, ok: false, reason: "failed", call_ref: callRef, detail: result.error };
  }
  return {
    tool,
    ok: false,
    reason: result.block.reason,
    call_ref: callRef,
    block: result.block,
    ...(input.nudge !== undefined ? { nudge: input.nudge } : {}),
  };
};

/** 审批双轨接线（G1 拆解单元③）：问答轨 handler → executor ApprovalGate 的固定形态
 *  （tool/call 事件落盘后回填 tool_call_id——凭据配对键）。原主循环/resume 重派/确认直填
 *  三处内联同构收口单源（零行为变化）。 */
export const gateFor = (handler: ApprovalHandler | undefined, toolCallId: number): ApprovalGate | undefined =>
  handler === undefined ? undefined : { handler: (gateInput) => handler({ ...gateInput, tool_call_id: toolCallId }) };
