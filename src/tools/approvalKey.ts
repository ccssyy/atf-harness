/**
 * 审批键（approval key）计算——harness 侧与对端 MockLedger 同构的 digest 算法
 * （bridge.contract.yaml methods 段登记）：params_digest = sha256( stableParamsJson )，
 * stableParamsJson = JSON.stringify( 键序递归排序后的 params )。算法漂移 = 审批键失配，
 * 双侧必须同步修改（fail-closed：失配表现为 ledger 查不到，审批被拒）。
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

/** 账本查询/预录的请求键。 */
export interface ApprovalKey {
  tool: string;
  params_digest: string;
}

export const approvalKeyFor = (tool: string, params: unknown): ApprovalKey => ({
  tool,
  params_digest: approvalParamsDigest(params),
});

/** 账本条目（ledger_query 返回项的 harness 侧形态）。 */
export interface LedgerEntry {
  record_id: string;
  tool: string;
  params_digest: string;
  consumed: boolean;
}
