/**
 * DSH user-approval seam 调用面（指令要求 2：审批走 tool-execution-pipeline seam）。
 *
 * 语义：需要审批的工具在 execute 内先 request——allowed-once 才放行；
 * rejected / cancelled / unavailable 一律结构化拒绝（fail-closed，不 throw——
 * 模型可转述换路径，与手搓主线 rejected 语义一致）。审批服务缺失时敏感动作
 * 直接拒绝（不静默放行）。
 */

/** ctx 取审批服务的形态（@deepseek-ai/dsh-user-approval 的 service 面——结构类型，零 import）。 */
export interface ApprovalFace {
  request(req: {
    agent?: unknown;
    toolName: string;
    callId?: string;
    reason: string;
    displayReason?: { en: string; zh: string };
    signal?: unknown;
  }): Promise<string>;
}

export type ApprovalVerdict = { ok: true } | { ok: false; outcome: string };

/** 向 DSH 审批面板请求一次性放行；无审批服务 → unavailable（fail-closed）。 */
export const requestApproval = async (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; callId?: string; signal?: unknown },
  toolName: string,
  reason: string,
): Promise<ApprovalVerdict> => {
  const approval = ctx.get("approval") as ApprovalFace | undefined;
  if (approval === undefined || typeof approval.request !== "function") {
    return { ok: false, outcome: "unavailable" };
  }
  const outcome = await approval.request({
    ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
    toolName,
    ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
    reason,
    displayReason: { en: reason, zh: reason },
    ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
  });
  return outcome === "allowed-once" ? { ok: true } : { ok: false, outcome };
};

/** 审批不过 → 结构化工具结果（模型可读、审计可查；收口同 asToolValue——JSON 安全面）。 */
export const approvalDeniedResult = (toolName: string, outcome: string): Record<string, never> =>
  ({
    error: "approval_denied",
    tool: toolName,
    outcome,
    note: "该动作需要用户审批（DSH 审批面板）；本次未获放行——不要绕行，向用户说明后停止或改用只读路径。",
  }) as unknown as Record<string, never>;
