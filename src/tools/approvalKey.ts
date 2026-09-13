/**
 * 审批键与账本记录模型——harness 侧与对端 MockLedger 同构
 * （bridge.contract.yaml methods 段登记）。
 *
 * 契约 v2（2026-09-13 契约修订，变更 #6）：{tool, params_digest, consumed} 配额式键
 * 不再是账本键——账本查询以 scope_ref(+operation_id) 定位、消费以 {approval_ref, record_id}
 * 逐值一致校验（内核 Approval Ledger 审批链为规范）。tool + params_digest 降级为
 * 审计检索辅助信息（stableParamsJson digest 算法保留，防审计键漂移；问答轨提案键
 * approval_key = params_digest 亦为 harness 内部状态键，不属账本键）。
 */
import { createHash } from "node:crypto";

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
};

export const approvalParamsDigest = (params: unknown): string =>
  createHash("sha256").update(stableStringify(params), "utf8").digest("hex");

/** 作用域引用（契约 v2：ledger_query 定位键；atf_workspace_status 同构透出）。 */
export interface ScopeRef {
  project_id: string;
  scope_type: string;
  scope_id: string;
  scope_mode: string;
}

/** 审计检索辅助键（契约 v2：不再是账本键；setup 预录与审计对账用）。 */
export interface ApprovalKey {
  tool: string;
  params_digest: string;
}

export const approvalKeyFor = (tool: string, params: unknown): ApprovalKey => ({
  tool,
  params_digest: approvalParamsDigest(params),
});

/** 账本记录（ledger_query 返回项的 harness 侧形态，契约 v2 审批链模型）。 */
export interface LedgerRecord {
  record_id: string;
  approval_id: string;
  sequence: number;
  state: string;
  command_id?: string;
  actor?: string;
  operation_id?: string;
  attempt_id?: string;
  evidence_refs?: string[];
}
