/**
 * 授权凭据状态判定(P2-S2 门 1 设计 v1.1 生效版,决议 §3.2 口径 #6 / 门 2 A1–A3)。
 *
 * 消费事实不设显式事件,由会话事件流确定性推导:消费 = 被授权调用的完成事实
 * (tool/result 落盘,经 payload.call_ref === tool/call 事件 id 显式配对,A1/R3)。
 * 判定为 (事件流, 恢复水位线) 的确定性函数——同一水位线下重放恒等;
 * available 仅对恢复后新注入(granted.id > recoveryWatermark,如 resume(answer))可达,
 * 恢复时刻流内既有凭据恒 id ≤ watermark,可判态只有 consumed / indeterminate / invalid。
 *
 * 纯函数:无 I/O、无时钟、无进程态;只依赖事件存在性/引用链/水位线比较。
 */
import { type SessionEvent } from "../session/index.js";

/** 凭据四值判定结果。 */
export type CredentialState = "consumed" | "available" | "indeterminate" | "invalid";

/** 凭据引用(取自 granted 应答事件)。 */
export interface CredentialRef {
  approval_session_id: string;
  request_event_ref: number;
}

/** 判定上下文(A2):恢复水位线 = 恢复/启动时刻流内最大事件 id(全新 run = 0),取值后固定。 */
export interface CredentialContext {
  recoveryWatermark: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numField = (payload: unknown, key: string): number | null => {
  if (!isPlainObject(payload)) return null;
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const strField = (payload: unknown, key: string): string | null => {
  if (!isPlainObject(payload)) return null;
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/** 流内定位事件:id 与 type 双重匹配(引用链回溯的合法性前提)。 */
const findEvent = (events: readonly SessionEvent[], id: number, type: string): SessionEvent | null => {
  const hit = events.find((event) => event.id === id && event.type === type);
  return hit ?? null;
};

/**
 * 在流内查找某 tool_call_id 的既有凭据(granted 应答及其 request):无 → null。
 * 供审批检查点做重入/恢复预检(同一 tool_call_id 已有 granted 时不重复问询)。
 */
export const findExistingCredential = (
  events: readonly SessionEvent[],
  toolCallId: number,
): CredentialRef | null => {
  const request = events.find(
    (event) => event.type === "approval/request" && numField(event.payload, "tool_call_id") === toolCallId,
  );
  if (request === undefined) return null;
  const sessionId = strField(request.payload, "approval_session_id");
  if (sessionId === null) return null;
  const granted = events.find(
    (event) =>
      event.type === "approval/response" &&
      numField(event.payload, "request_event_ref") === request.id &&
      strField(event.payload, "verdict") === "granted",
  );
  if (granted === undefined) return null;
  return { approval_session_id: sessionId, request_event_ref: request.id };
};

/**
 * 凭据四值判定(设计 v1.1 §2):
 * - invalid:granted 不存在/多条,或 request_event_ref → approval/request → tool_call_id →
 *   tool/call 回溯链任一环断裂(fail-closed,宁可错杀);
 * - consumed:存在 payload.call_ref === tool_call_id 的 tool/result(A1:call_ref 指向不存在
 *   或非 tool/call 事件的结果不构成消费事实——本函数先验证 call 事件存在,悬空引用自然落空);
 * - indeterminate:无结果且 granted.id ≤ recoveryWatermark(旧遗留,执行可能已发生);
 * - available:无结果且 granted.id > recoveryWatermark(本次恢复后新注入,如 resume(answer))。
 */
export const resolveCredentialState = (
  events: readonly SessionEvent[],
  credential: CredentialRef,
  context: CredentialContext,
): CredentialState => {
  const grantedList = events.filter(
    (event) =>
      event.type === "approval/response" &&
      numField(event.payload, "request_event_ref") === credential.request_event_ref &&
      strField(event.payload, "approval_session_id") === credential.approval_session_id &&
      strField(event.payload, "verdict") === "granted",
  );
  if (grantedList.length !== 1) return "invalid"; // 不存在或异常多条(审计歧义,保守判死)
  const granted = grantedList[0] as SessionEvent;

  const request = findEvent(events, credential.request_event_ref, "approval/request");
  if (request === null) return "invalid";
  const toolCallId = numField(request.payload, "tool_call_id");
  if (toolCallId === null) return "invalid";
  const call = findEvent(events, toolCallId, "tool/call");
  if (call === null) return "invalid";

  const consumed = events.some(
    (event) => event.type === "tool/result" && numField(event.payload, "call_ref") === toolCallId,
  );
  if (consumed) return "consumed";

  const grantedId = granted.id;
  return grantedId <= context.recoveryWatermark ? "indeterminate" : "available";
};
