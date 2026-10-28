/**
 * F6-a/F6-b——工具回执的用户面摘要（user_summary）与连续失败升级（escalate_to_user）。
 *
 * 方案 §3-1 修正的核心：用户可见的三句话结论**不得靠提示词承载**——由工具回执结构
 * 携带（T 面），并在工具执行侧直接投影成会话可见事件（L 面），用户不依赖 agent 转述。
 *
 * 两个面：
 *   T 面（回执字段）：`user_summary{conclusion,stage,next}` 随工具回执落盘；
 *     连续失败计数达阈值时回执追加 `escalate_to_user:true` ＋ `failure_count`。
 *   L 面（会话投影）：`projectUserNotice()` 经 ToolRunContext.deferContext 注入一条
 *     `form:"notice"` 的 user/message（vendor 既有通道，tool-goal 同款用法——会话流里
 *     渲染成一行 context 行＋可展开正文，不经 agent 转述）。
 *
 * 计数口径：键＝`<sessionKey|null>::<tool>`；同一会话同一工具的连续失败累加，任一成功
 * 即清零（跨会话互不污染；sessionKey 缺席＝单独一档，不与其他会话混算）。
 */

/** 用户面三句话：一句话结论＋当前阶段＋下一步。 */
export type UserSummary = { conclusion: string; stage: string; next: string };

/** 连续失败达此数即升级（要求用户介入，不再自动重试）。 */
export const ESCALATION_FAILURE_THRESHOLD = 2;

/** 会话可见通知的 summary 上限（与 vendor CONTEXT_SUMMARY_MAX_CHARS 同值）。 */
const NOTICE_SUMMARY_MAX_CHARS = 120;

/** 无会话身份时的计数档（不与其他会话混算）。 */
const UNSCOPED_KEY = "__unscoped__";

/** 计数表（进程内；键＝会话档＋工具名）。 */
const failureCounts = new Map<string, number>();

const countKeyOf = (sessionKey: string | null, tool: string): string =>
  `${sessionKey === null || sessionKey === "" ? UNSCOPED_KEY : sessionKey}::${tool}`;

/** 回执挂 `user_summary`（不改原回执的其他键；返回新对象）。 */
export const withUserSummary: <T extends Record<string, unknown>>(receipt: T, summary: UserSummary) => T & { user_summary: UserSummary } =
  (receipt, summary) => ({ ...receipt, user_summary: summary });

/** 记一次工具失败，返回该会话该工具的连续失败次数。 */
export const recordToolFailure: (sessionKey: string | null, tool: string) => number = (sessionKey, tool) => {
  const key = countKeyOf(sessionKey, tool);
  const next = (failureCounts.get(key) ?? 0) + 1;
  failureCounts.set(key, next);
  return next;
};

/** 记一次工具成功（连续失败计数清零）。 */
export const recordToolSuccess: (sessionKey: string | null, tool: string) => void = (sessionKey, tool) => {
  failureCounts.delete(countKeyOf(sessionKey, tool));
};

/** 失败次数 → 升级字段（未达阈值＝null，回执保持原样）。 */
export const escalationOf: (count: number) => { escalate_to_user: true; failure_count: number } | null = (count) =>
  count >= ESCALATION_FAILURE_THRESHOLD ? { escalate_to_user: true, failure_count: count } : null;

/** 当前连续失败次数（只读观测；无记录＝0）。 */
export const failureCountOf = (sessionKey: string | null, tool: string): number => failureCounts.get(countKeyOf(sessionKey, tool)) ?? 0;

/** 清空计数（测试/会话结束用）。 */
export const resetToolFailureCounts = (): void => {
  failureCounts.clear();
};

/**
 * 按工具与成败给出缺省三句话（工具未细分业务语言时的兜底；调用方应优先给具体结论）。
 * @param tool - 工具名（只用于措辞，不进结论正文）。
 * @param ok - 是否成功。
 * @param detail - 可选的一句补充（业务语言，不含内部码）。
 */
export const suggestUserSummary = (tool: string, ok: boolean, detail?: string): UserSummary => {
  const stage = ok ? "已执行完成" : "执行未成功";
  const conclusion = ok ? `${tool} 已完成` : `${tool} 未完成${detail !== undefined && detail !== "" ? `：${detail}` : ""}`;
  return {
    conclusion,
    stage,
    next: ok ? "按回执里的下一步继续，或回复要改的项" : "按回执提示补齐条件后重试；连续失败会升级到用户",
  };
};

/** 回执成败判定（工具回执约定：`ok === false` 或带 `error` 键即失败；`started === false` 亦为失败）。 */
export const receiptIsFailure = (receipt: Record<string, unknown>): boolean =>
  receipt["ok"] === false || receipt["started"] === false || receipt["error"] !== undefined;

/**
 * 记成败并装饰回执（成功＝挂 user_summary；失败＝挂 user_summary，累计到阈值再加
 * escalate_to_user＋failure_count）。回执内容零改写——只增键。
 */
export const decorateOutcome = <T extends Record<string, unknown>>(
  receipt: T,
  sessionKey: string | null,
  tool: string,
  ok: boolean,
  summary: UserSummary,
): T & { user_summary: UserSummary } & { escalate_to_user?: true; failure_count?: number } => {
  if (ok) {
    recordToolSuccess(sessionKey, tool);
    return withUserSummary(receipt, summary);
  }
  const count = recordToolFailure(sessionKey, tool);
  const escalated = escalationOf(count);
  const withSummary = withUserSummary(receipt, summary);
  return escalated === null ? withSummary : { ...withSummary, ...escalated };
};

/** 会话可见通知的载体形态（vendor user/message 的 data 形状；source 为 merge-extensible producer 标签）。 */
export interface UserNoticeMessage {
  id: string;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  source: { kind: string; form: "notice"; summary: string };
}

/** atf 工具通知的 producer 标签（会话流里作为 context 行的来源标识）。 */
export const ATF_NOTICE_KIND = "atf-notice";

const boundSummary = (text: string): string =>
  text.length <= NOTICE_SUMMARY_MAX_CHARS ? text : `${text.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`;

/**
 * 构造一条会话可见的 user/message（form=notice）：正文三句（结论/阶段/下一步），
 * summary 取结论一句（会话流收起态一行）。纯函数——id 可由调用方给定（测试确定性）。
 */
export const userNoticeOf = (summary: UserSummary, opts?: { id?: string; kind?: string }): UserNoticeMessage => ({
  id: opts?.id ?? randomId(),
  role: "user",
  content: [{ type: "text", text: `${summary.conclusion}\n当前阶段：${summary.stage}\n下一步：${summary.next}` }],
  source: { kind: opts?.kind ?? ATF_NOTICE_KIND, form: "notice", summary: boundSummary(summary.conclusion) },
});

const randomId = (): string => {
  // 只用于消息身份（vendor createMessage 用 randomUUID 同源）；不引 vendor 依赖。
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `atf-notice-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
};

/**
 * L 层投影：把摘要直接推进会话流（ToolRunContext.deferContext）。
 * 上下文缺席（裸装配/旧测试）或抛错＝不投影（返回 false），绝不影响工具主流程。
 */
export const projectUserNotice = (
  exec: { deferContext?: (context: unknown) => void } | null | undefined,
  summary: UserSummary,
  opts?: { id?: string; kind?: string },
): boolean => {
  if (exec === null || exec === undefined || typeof exec.deferContext !== "function") return false;
  try {
    exec.deferContext(userNoticeOf(summary, opts));
    return true;
  } catch {
    return false;
  }
};
