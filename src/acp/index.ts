/**
 * 前端二（ACP agent 外壳）公开出口（L1 门 2 T04）。
 * 协议（轴三单一文件见 protocol.ts）· 投影 · 授权 · 外壳主体；入口 main.ts。
 */
export { AcpShell, type AcpShellOptions } from "./shell.js";
export { buildPermissionRequest, mapPermissionOutcome, ACP_PERMISSION_OPTIONS } from "./permission.js";
export { projectSessionEvent, toolKindFor } from "./projection.js";
export {
  ACP_AGENT_NAME,
  ACP_AGENT_TITLE,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpInitializeParams,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpSessionLoadResult,
  type AcpSessionNewResult,
  type AcpSessionPromptResult,
  type AcpSessionUpdate,
  type AcpToolCallStatus,
  type AcpToolKind,
} from "./protocol.js";
