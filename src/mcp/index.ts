/**
 * G5 跨进程通道层（src/mcp/——旧 src/bridge/ 退役后的承接位）。
 *
 * 组成：connection（MCP stdio 连接器——内核 `python -m agentic_training_flow.mcp`
 * 的调用方自持传输）/ bridgeCommand（对端装配与版本交叉核对）/ atfCommand（一次性
 * CLI 派生与 pin 常量）/ errors+result（Result 边界纪律的通用件，供 src/core、
 * src/agent、src/llm、src/webui 消费）。
 */
export { AtfBridgeConnection, AtfMcpConnection, MCP_REQUEST_TIMEOUT_MS, MCP_HANDSHAKE_TIMEOUT_MS, MCP_MAX_FRAME_BYTES, MCP_PROTOCOL_VERSION, type AtfMcpConnection as AtfMcpConnectionType, type McpSpawnOptions, type McpCloseInfo, type McpServerVersion, type McpToolDescriptor } from "./connection.js";
export { bridgeError, stringifyCause, STDERR_TAIL_LIMIT, takeStderrTail, type BridgeError, type BridgeErrorCode, type BridgeErrorInit } from "../core/rpc.js";
export { err, ok, type Result } from "../core/rpc.js";
export { resolveMcpDeployment, parseCommandWithEnvPrefix, kernelVersionSync, kernelRootOf, type McpDeployment, type BridgeDeployment } from "./bridgeCommand.js";
export { ATF_UPSTREAM_TAG, ATF_UPSTREAM_COMMIT_SHA, deriveAtfCommand, mcpInvocation, atfCliPathFromEnv, readGitHeadSha, probeAtfHelp, type AtfCliInvocation } from "./atfCommand.js";
