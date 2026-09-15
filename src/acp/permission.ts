/**
 * 前端二（ACP agent 外壳）——授权面（L1 门 2 T04，§2.3 授权行）。
 *
 * D5（门 1 裁定）：只提供 allow_once / reject_once 两个选项；宿主返回未提供的
 * optionId（含 allow_always / reject_always）→ **视为非法响应，fail-closed**——
 * 折算为拒绝（非终局）且 reason 原文留痕「非法 optionId」，绝不静默降级为放行，
 * 也不静默当作普通拒绝（审计可辨）。
 *
 * D4（B＋C 组合）：接受宿主应答但留痕——stub 应答恒带 channel:"acp" ＋ host_id，
 * approval/response 落盘 payload 增 requires_human_review:true（core 侧 T04 增量）；
 * 宿主的自动允许设置＝人的一次显式预授权（C），但账本一次性消费语义不受影响。
 */
import { jsonRpcError, type JsonRpcError } from "../rpc/index.js";
import {
  ACP_METHODS,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpRequestPermissionParams,
} from "./protocol.js";
import type { ApprovalStubResponse } from "../core/run/index.js";
import type { RpcHandlerOutcome } from "../rpc/index.js";

/** 我方提供的授权选项（D5：恰两个，闭集）。 */
export const ACP_PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "allow_once", name: "Allow once（仅本次放行）", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject once（仅本次拒绝）", kind: "reject_once" },
] as const;

/** 构建 session/request_permission 请求参数。 */
export const buildPermissionRequest = (args: {
  sessionId: string;
  toolCallId: string;
}): AcpRequestPermissionParams => ({
  sessionId: args.sessionId,
  toolCall: { toolCallId: args.toolCallId },
  options: ACP_PERMISSION_OPTIONS,
});

export interface PermissionResolution {
  response: ApprovalStubResponse;
  /** D5 非法响应标记（审计面：非法 optionId 折算拒绝时置位） */
  illegalOptionId?: string;
}

/** 宿主应答 → 问答轨 stub 应答（D5 fail-closed ＋ D4 留痕）。 */
export const mapPermissionOutcome = (outcome: AcpPermissionOutcome, hostId: string): PermissionResolution => {
  const channel = { channel: "acp" as const, host_id: hostId };
  if (outcome.outcome === "cancelled") {
    // 宿主取消授权对话框＝拒绝本次提案（ACP 官方语义）；非终局，模型可换路径
    return { response: { verdict: "denied", actor: "acp-host", reason: "宿主取消授权对话框（cancelled）", ...channel } };
  }
  switch (outcome.optionId) {
    case "allow_once":
      return { response: { verdict: "granted", actor: "acp-host", ...channel } };
    case "reject_once":
      return { response: { verdict: "denied", actor: "acp-host", ...channel } };
    default:
      // D5：未提供的 optionId（allow_always / reject_always / 任意值）＝非法响应——
      // fail-closed：不放行、折算拒绝，reason 原文留痕供审计（不静默降级）
      return {
        response: {
          verdict: "denied",
          actor: "acp-host",
          reason: `非法 optionId「${outcome.optionId}」（我方未提供该选项）——fail-closed 不放行`,
          ...channel,
        },
        illegalOptionId: outcome.optionId,
      };
  }
};

/** 经 RpcPeer 发送 request_permission 并等待宿主应答（问答轨 stub 的 ACP 实现）。
 *  cancelledDueToSessionCancel：宿主以 session/cancel 收口本 turn 时由 shell 置位——
 *  此时折算挂起（verdict=timeout 机制位，reason 记录取消事实，非否决、可续）。 */
export const requestPermissionOverPeer = async (deps: {
  peer: { request(method: string, params?: unknown): Promise<RpcHandlerOutcome> };
  params: AcpRequestPermissionParams;
  hostId: string;
  cancelledDueToSessionCancel?: { current: boolean };
}): Promise<ApprovalStubResponse | { error: JsonRpcError }> => {
  const sent = await deps.peer.request(ACP_METHODS.sessionRequestPermission, deps.params);
  if (deps.cancelledDueToSessionCancel?.current === true) {
    // session/cancel 已收口本 turn：不再消费迟到的宿主应答（原请求留 tombstone，迟到应答静默丢弃）
    return { verdict: "timeout", actor: "acp-host", reason: "会话取消（session/cancel）——立即挂起（非否决，可经后续 prompt 续答）", channel: "acp", host_id: deps.hostId };
  }
  if (!sent.ok) {
    // 传输层失败：不猜测宿主意图，折算拒绝（fail-closed；ledger 未消费、动作未执行）
    return { verdict: "denied", actor: "acp-host", reason: `授权请求失败（${sent.error.message}）——fail-closed 未执行`, channel: "acp", host_id: deps.hostId };
  }
  const outcome = sent.result as AcpPermissionOutcome | undefined;
  if (outcome === undefined || typeof outcome !== "object" || !("outcome" in outcome)) {
    return { verdict: "denied", actor: "acp-host", reason: "宿主应答形状非法（缺 outcome）——fail-closed 未执行", channel: "acp", host_id: deps.hostId };
  }
  return mapPermissionOutcome(outcome, deps.hostId).response;
};

/** JSON-RPC 错误构造（ACP 面 method not found 等共用；code 取服务器域）。 */
export const acpRpcError = (message: string): JsonRpcError => jsonRpcError(-32000, message);
