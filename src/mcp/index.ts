/**
 * 前端三（MCP server 外壳）公开出口（L1 门 2 T05）。
 * 协议（MCP 协议版本轴单一归属见 protocol.ts）· 7 工具面 · 外壳主体；入口 main.ts。
 */
export { McpShell, type McpShellOptions } from "./shell.js";
export { MCP_TOOL_NAMES, mcpToolDescriptors, toMcpJsonSchema, type McpToolName } from "./tools.js";
export {
  MCP_LATEST_VERSION,
  MCP_METHODS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_VERSIONS,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolCallResult,
  type McpToolDescriptor,
  type McpToolsCallParams,
} from "./protocol.js";
