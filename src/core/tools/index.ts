/**
 * S3 工具层公开出口。后续 slice（S4 工作区 / S5 冒烟 / P2-S2 问答轨）只从这里 import。
 */
export { checkSchema, validateCanonicalOutput, type SchemaNode } from "./canonical.js";
export { approvalCopyFor, CLUSTER_PARAM_LABELS } from "./approvalCopy.js";
export {
  approvalMissingBlock,
  approvalTrackBlock,
  toolError,
  toolErrorFromBridge,
  type ToolBlock,
  type ToolBlockReason,
  type ToolError,
  type ToolErrorCode,
} from "./errors.js";
export {
  approvalKeyFor,
  approvalParamsDigest,
  stableStringify,
  type ApprovalKey,
  type LedgerRecord,
  type ScopeRef,
} from "./approvalKey.js";
export { GATE_LEGAL_IDS, INTEGRITY_GATE_IDS, requiresApprovalFor, TOOL_DEFINITIONS, TOOL_NAMES, toModelVisible, type ModelVisibleTool, type ToolDefinition } from "./toolDefinition.js";
export { ToolRegistry } from "./registry.js";
export type { BridgeTransport } from "./executor.js";
export {
  LEDGER_CONSUME_CANONICAL,
  LEDGER_QUERY_CANONICAL,
  ToolExecutor,
  resolveHeadlessExitCode,
  type ApprovalGate,
  type ApprovalTrackVerdict,
  type ToolCallOutcome,
} from "./executor.js";
export {
  findExistingCredential,
  resolveCredentialState,
  type CredentialContext,
  type CredentialRef,
  type CredentialState,
} from "./credentialState.js";
export {
  WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_HANDLERS,
  buildSkillsSystemSuffix,
  type LocalToolHandler,
  type LocalToolHost,
  type LocalToolResult,
} from "./workspaceTools.js";
