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

// ---------------------------------------------------------------------------
// F5 改动四 4.2（2026-09-26）：审批 key 派生纳入内容摘要。
// 缺陷（走查 v077g4 实证）：peek.py 同路径重写 30 次，问答轨提案 key 仅由 argv 派生，
// 30 次提案共用同一 key——操作员卡面无法区分内容已变的提案（审批语义盲区）。
// 修法：脚本类提案（atf_scratch_exec/atf_bash）的 approval_key 派生纳入引用脚本内容的
// sha256（key 派生用全量摘要，卡面展示前缀）——同路径重写后 key 必变。非脚本类提案/
// 内容不可读（文件缺失等）时 digest 缺省 → key 与既有逐位一致（零回归）。
// 纪律：approval_key 是 harness 内部状态键（问答轨提案键，见文件头），非账本键——
// 账本预录/消费的 subject_ref/evidence_refs 仍用 params_digest，本批零触碰。
// ---------------------------------------------------------------------------

/** 内容绑定提案键的脚本类工具（引用脚本内容不在 params 内——params digest 覆盖不到；
 *  atf_write/atf_edit 的内容在 params 里，既有 digest 已覆盖，不入本清单）。 */
export const PROPOSAL_CONTENT_BOUND_TOOLS: readonly string[] = ["atf_scratch_exec", "atf_bash"];

const SCRIPT_SUFFIXES: readonly string[] = [".py", ".sh", ".js", ".mjs"];

/** 提案参数中引用的脚本路径记号（纯函数；出现序去重）。
 *  atf_scratch_exec → argv 逐 token；atf_bash → command 按空白与 ; && || | 换行切段后逐 token。
 *  只取脚本后缀记号（.py/.sh/.js/.mjs）——保守闭集，不猜无后缀可执行物。 */
export const scriptTokensFromParams = (tool: string, params: unknown): string[] => {
  const tokens: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string" || value === "") return;
    if (!SCRIPT_SUFFIXES.some((suffix) => value.endsWith(suffix))) return;
    if (!tokens.includes(value)) tokens.push(value);
  };
  if (tool === "atf_scratch_exec" && typeof params === "object" && params !== null && !Array.isArray(params)) {
    const argv = (params as { argv?: unknown }).argv;
    if (Array.isArray(argv)) for (const token of argv) push(token);
    return tokens;
  }
  if (tool === "atf_bash" && typeof params === "object" && params !== null && !Array.isArray(params)) {
    const command = (params as { command?: unknown }).command;
    if (typeof command === "string") {
      for (const segment of command.split(/;|&&|\|\||\||\n/)) {
        for (const token of segment.trim().split(/\s+/)) push(token);
      }
    }
    return tokens;
  }
  return tokens;
};

/** 内容摘要（token 序 → `<path>\0<content>\0` 串联 sha256；无可读内容 → undefined）。
 *  contents 与 tokens 按位对应；undefined 位（缺失/越界/不可读）跳过——全部缺失时整体
 *  undefined（key 退回既有形态，零回归）。 */
export const proposalContentDigestFromContents = (entries: ReadonlyArray<{ token: string; content?: string }>): string | undefined => {
  const readable = entries.filter((entry): entry is { token: string; content: string } => typeof entry.content === "string");
  if (readable.length === 0) return undefined;
  return createHash("sha256")
    .update(readable.map((entry) => `${entry.token}\0${entry.content}\0`).join(""), "utf8")
    .digest("hex");
};

/** 内容绑定提案键（问答轨提案 key 单源）：
 *  digest 缺省 → approval_key = params_digest（既有形态逐位一致）；
 *  digest 存在 → approval_key = `${params_digest}:${digest}`（同路径重写 → key 必变）。
 *  params_digest 恒为既有算法值（审计检索辅助/账本 evidence_refs 消费面零漂移）。 */
export const proposalApprovalKey = (
  tool: string,
  params: unknown,
  contentDigest?: string,
): { approval_key: string; params_digest: string; content_digest?: string } => {
  const base = approvalKeyFor(tool, params);
  if (contentDigest === undefined) return { approval_key: base.params_digest, params_digest: base.params_digest };
  return { approval_key: `${base.params_digest}:${contentDigest}`, params_digest: base.params_digest, content_digest: contentDigest };
};

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
