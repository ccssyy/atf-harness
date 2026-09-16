/**
 * 前端三（MCP server 外壳）——协议面（L1 门 2 T05，《ATF独立Harness_L1门2任务书_20260915.md》§2.4）。
 *
 * ★MCP 协议版本轴归属单一文件（与轴一会话协议版本、轴二桥接契约版本、轴三 ACP 协议
 * 版本并列，各自归属单一文件的防呆口径延续）。MCP 版本为日期串；握手策略＝客户端请求
 * 版本命中我方支持集则回显，否则回我方最新（客户端裁决是否继续）。
 *
 * D8 同口径：线缆类型手写本地转写（不引 SDK，零 npm 依赖）；v1 只转写本批使用面
 * （initialize / notifications/initialized / tools/list / tools/call）。
 */

/** ★MCP 协议版本轴（本文件唯一归属）。 */
export const MCP_SUPPORTED_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
export const MCP_LATEST_VERSION = MCP_SUPPORTED_VERSIONS[0] as string;

export const MCP_SERVER_NAME = "atf-harness-mcp";
export const MCP_SERVER_VERSION = "0.1.0-l1";

/** 方法名（官方原文；notifications/* 为通知）。 */
export const MCP_METHODS = {
  initialize: "initialize",
  initialized: "notifications/initialized",
  toolsList: "tools/list",
  toolsCall: "tools/call",
} as const;

export interface McpInitializeParams {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

/** MCP 工具描述（tools/list 项；inputSchema 为标准 JSON Schema）。 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

/** tools/call 结果（工具执行错误 → isError:true；协议错误走 JSON-RPC error）。 */
export interface McpToolCallResult {
  content: readonly McpTextContent[];
  isError?: boolean;
}
