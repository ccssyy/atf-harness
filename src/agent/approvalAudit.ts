/**
 * 批㊳ 段 1.1（丙线欠账③）——审批留痕入流：approvalHook audit → session custom entry。
 *
 * 沿 tem/evidence.ts 的 custom entry 先例（appendCustomEntry＋best-effort 不反压），命名空间
 * approval_audit。ADR-07 审计面闭合：headless 无人值守场景下审批裁定不再随进程消失——
 * run 结束后可从 session 树转录回溯（scanApprovalAudit）。
 *
 * fail-open 语义（如实登记，与甲线 fail-closed 的差异是场景性的）：丙线审计留痕为辅助面——
 * 写失败不阻断审批流（best-effort＋stderr 记录），判定本身仍由 approvalHook 的既有序列
 * （账本 fail-closed / surface 四 verdict）承载。甲线 12 事件流是权威持久面（写入失败＝
 * 运行失败），本面不具该地位；凡以审批计数为前提的治理判定（如 denial 升级）不得建立
 * 在本流上（批㊳ 1.2 计数源选型依据，见 approvalHook）。
 *
 * 流面范围（字段闭集纪律）：仅承载过闸判定（proposal 承载的裁定）——只读直通/豁免面/
 * 未注册工具拦截无提案键可承载，不入流面（内存 audit 数组保留其记录）。
 */
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core";
import { ensureMainBranch, type SessionLike } from "./sessionMirror.js";
import type { ApprovalAuditEntry } from "./approvalHook.js";

const context: Context = BACKGROUND_CONTEXT;

/** customType（session 树内审批审计留痕命名空间）。 */
export const APPROVAL_AUDIT_CUSTOM_TYPE = "approval_audit";

/** 留痕来源面（闭集）：surface＝问答轨裁定；ledger＝账本轨交互（含闸段故障）。 */
export type ApprovalAuditSource = "surface" | "ledger";

/**
 * 留痕条目（字段闭集）：proposal key／verdict／时间戳／来源——四字段之外不加
 * （tool 名经 proposal key 的 params_digest 锚定审计检索，不另立字段）。
 */
export interface ApprovalAuditStreamEntry {
  proposal_key: string;
  verdict: ApprovalAuditEntry["verdict"];
  ts: string;
  source: ApprovalAuditSource;
}

export interface ApprovalAuditStream {
  /** best-effort 写入：返回是否成功（失败侧自行记 stderr；永不 throw）。 */
  write(entry: ApprovalAuditStreamEntry): Promise<boolean>;
}

/** 组装留痕条目（纯函数；ts 缺省当前时刻 ISO）。 */
export const buildApprovalAuditStreamEntry = (
  proposalKey: string,
  verdict: ApprovalAuditEntry["verdict"],
  source: ApprovalAuditSource,
  ts?: Date,
): ApprovalAuditStreamEntry => ({ proposal_key: proposalKey, verdict, ts: (ts ?? new Date()).toISOString(), source });

/** 镜像：留痕条目 → session custom entry（追加；失败不反压审批流——返回 null 交调用方记 stderr）。 */
export const mirrorApprovalAudit = async (session: SessionLike, entry: ApprovalAuditStreamEntry): Promise<string | null> => {
  try {
    const branch = await ensureMainBranch(session);
    return await branch.appendCustomEntry(APPROVAL_AUDIT_CUSTOM_TYPE, entry as never, context);
  } catch {
    return null; // fail-open：审计留痕为辅助面，写失败不阻断（见文件头）
  }
};

/** 标准装配：session 留痕流（写失败 → stderr 记录；返回 false 供调用方观测）。 */
export const createSessionApprovalAuditStream = (session: SessionLike): ApprovalAuditStream => ({
  write: async (entry) => {
    const id = await mirrorApprovalAudit(session, entry);
    if (id === null) {
      console.error(`[v1] 审批留痕入流失败（fail-open 不阻断审批流）：verdict=${entry.verdict} proposal_key=${entry.proposal_key}`);
      return false;
    }
    return true;
  },
});

/** 扫描当前 session 的全部审批留痕（时间升序；读取失败 = 空集合——审计检索辅助面）。 */
export const scanApprovalAudit = async (session: SessionLike): Promise<ApprovalAuditStreamEntry[]> => {
  try {
    const branch = await session.branch("main", context);
    if (branch === undefined) return [];
    const entries = await branch.findEntries(
      { type: "custom", customType: APPROVAL_AUDIT_CUSTOM_TYPE, order: "oldestFirst" },
      context,
    );
    return entries
      .map((entry) => (entry as { data?: unknown }).data)
      .filter((data): data is ApprovalAuditStreamEntry =>
        typeof data === "object" && data !== null && typeof (data as ApprovalAuditStreamEntry).proposal_key === "string",
      );
  } catch {
    return [];
  }
};
