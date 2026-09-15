/**
 * 共享 JSON-RPC 2.0/stdio 传输层公开出口（L1 门 2 T03）。
 * 前端二（src/acp/）与前端三（src/mcp/）以及两者冒烟客户端只从这里 import。
 */
export {
  buildErrorResponse,
  buildNotification,
  buildRequest,
  buildResultResponse,
  encodeJsonRpcLine,
  JSON_RPC_ERROR_CODES,
  jsonRpcError,
  parseJsonRpcLine,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcParseFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./message.js";
export { RpcPeer, type RpcHandlerOutcome, type RpcPeerOptions, type RpcRequestOptions } from "./peer.js";
