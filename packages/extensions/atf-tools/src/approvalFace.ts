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

/** 审批不过 → 结构化工具结果（模型可读、审计可查；收口同 asToolValue——JSON 安全面）。
 *  note 按 outcome 分支（A1.2）：取消≠拒绝授权，二态共用通用文案会把「用户主动取消」
 *  误转述为「审批面板拦截」——三态各自给行为指引，error/tool/outcome 逐字不动（审计链）。 */
export const approvalDeniedResult = (toolName: string, outcome: string): Record<string, never> => {
  const NOTE_BY_OUTCOME: Record<string, string> = {
    cancelled: "用户已取消本次确认（取消≠拒绝授权）——如实停止本轮，勿绕道重试，也不要用其它工具代偿同一动作。",
    unavailable: "本环境未挂审批服务（fail-closed 未放行）——向用户说明通道不可用，勿绕行。",
  };
  const note =
    NOTE_BY_OUTCOME[outcome] ??
    // rejected／其它未知 outcome：保留通用文案（"用户未批准"语义＋行为指引不变）
    "该动作需要用户审批（DSH 审批面板）；本次未获放行——不要绕行，向用户说明后停止或改用只读路径。";
  return {
    error: "approval_denied",
    tool: toolName,
    outcome,
    note,
  } as unknown as Record<string, never>;
};
