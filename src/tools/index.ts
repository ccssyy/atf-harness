/**
 * S3 工具层公开出口。后续 slice（S4 工作区 / S5 冒烟）只从这里 import。
 */
export { checkSchema, validateCanonicalOutput, type SchemaNode } from "./canonical.js";
export {
  approvalMissingBlock,
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
  type LedgerEntry,
} from "./approvalKey.js";
export { TOOL_DEFINITIONS, TOOL_NAMES, toModelVisible, type ModelVisibleTool, type ToolDefinition } from "./toolDefinition.js";
export { ToolRegistry } from "./registry.js";
export type { BridgeTransport } from "./executor.js";
export { ToolExecutor, resolveHeadlessExitCode, type ToolCallOutcome } from "./executor.js";
