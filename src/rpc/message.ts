/**
 * 共享 JSON-RPC 2.0 传输层——消息面（L1 门 2 T03，《ATF独立Harness_L1门2任务书_20260915.md》
 * §3 T03；D8）。前端二（ACP 外壳）与前端三（MCP 外壳）共用：两者同为 JSON-RPC 2.0 over
 * 本地 stdio（D3），分帧（LF 分隔单行 JSON）与请求-响应配对只写一份。
 *
 * 手写纪律（D8）：本层零 npm 依赖（Node 内置）；ACP/MCP 的 schema 类型一律以本仓手写
 * 本地类型表达、编译期擦除——不引任何运行时 SDK（R2a）。分帧/字节上限/违规不抛经验
 * 复用自 src/bridge/frames.ts（内核桥接层，零改动）。
 *
 * 范围裁定：只实现 ACP/MCP 实际使用的单条消息形态——**不支持批处理数组**（两者 stdio
 * 面均单消息往返；遇数组按 -32600 invalid request 处置，fail-closed）。
 */
import { err, ok, type Result } from "../bridge/result.js";

/** JSON-RPC 2.0 标准 error code（-32700…-32603）＋ 本层传输类自造码（-32000 服务器域）。 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 服务器域自造码（-32000…-32099）：本层用于超时/对端关闭等传输性失败。 */
  transportFailure: -32000,
} as const;

export type JsonRpcId = number | string | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 对端→我方 请求（有 id，须应答）。 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: JsonRpcId;
}

/** 对端→我方 通知（无 id 字段，不应答）。 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** 我方→对端 响应（对请求的唯一收口：result 与 error 互斥）。 */
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; result: unknown; id: JsonRpcId }
  | { jsonrpc: "2.0"; error: JsonRpcError; id: JsonRpcId };

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** 解析失败的可应答形态：error 固定携带应答 id（-32600 尽量回显提取到的 id；-32700 恒 null）。 */
export type JsonRpcParseFailure = { error: JsonRpcError; id: JsonRpcId };

export const jsonRpcError = (code: number, message: string, data?: unknown): JsonRpcError => {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return error;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || value === null;

const hasIdKey = (value: Record<string, unknown>): boolean => "id" in value;

const methodOf = (value: Record<string, unknown>): string | null =>
  typeof value["method"] === "string" && value["method"] !== "" ? (value["method"] as string) : null;

const paramsOk = (value: Record<string, unknown>): boolean =>
  !("params" in value) || isPlainObject(value["params"]) || Array.isArray(value["params"]);

/**
 * 单行文本 → JSON-RPC 消息（严格校验，fail-closed）。
 * err 时返回可应答的 {error, id}：JSON 解析失败 = -32700/id null；结构非法 = -32600
 * 并回显可提取的 id（id 字段合法时）。通知无 id、永不触发应答——调用方按类型分流。
 */
export const parseJsonRpcLine = (line: string): Result<JsonRpcMessage, JsonRpcParseFailure> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return err({ error: jsonRpcError(JSON_RPC_ERROR_CODES.parseError, "非法 JSON 行"), id: null });
  }
  const failureWith = (message: string): Result<JsonRpcMessage, JsonRpcParseFailure> => {
    const candidate: Record<string, unknown> = isPlainObject(parsed) ? parsed : {};
    return err({
      error: jsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, message),
      id: isId(candidate["id"]) ? (candidate["id"] as JsonRpcId) : null,
    });
  };
  if (!isPlainObject(parsed)) return failureWith("消息不是 JSON 对象（批处理数组不支持）");
  if (parsed["jsonrpc"] !== "2.0") return failureWith(`jsonrpc 字段须为 "2.0"`);
  const hasMethod = "method" in parsed;
  const hasResult = "result" in parsed;
  const hasError = "error" in parsed;
  if (hasMethod) {
    const method = methodOf(parsed);
    if (method === null) return failureWith("method 非法（须为非空字符串）");
    if (!paramsOk(parsed)) return failureWith("params 非法（须为对象或数组）");
    if (hasIdKey(parsed)) {
      if (!isId(parsed["id"])) return failureWith("id 非法（须为 string|number|null）");
      const request: JsonRpcRequest = { jsonrpc: "2.0", method, id: parsed["id"] as JsonRpcId };
      if ("params" in parsed) request.params = parsed["params"];
      return ok(request);
    }
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
    if ("params" in parsed) notification.params = parsed["params"];
    return ok(notification);
  }
  // 响应面：id 必须存在，result / error 恰一
  if (!hasIdKey(parsed) || !isId(parsed["id"])) return failureWith("响应缺少合法 id");
  const id = parsed["id"] as JsonRpcId;
  if (hasResult === hasError) return failureWith("响应须恰有 result 或 error 其一");
  if (hasResult) {
    return ok({ jsonrpc: "2.0", result: parsed["result"], id } satisfies JsonRpcResponse);
  }
  const errorBody = parsed["error"];
  if (!isPlainObject(errorBody)) return failureWith("error 须为对象");
  if (typeof errorBody["code"] !== "number" || !Number.isFinite(errorBody["code"])) {
    return failureWith("error.code 非法（须为数值）");
  }
  if (typeof errorBody["message"] !== "string") return failureWith("error.message 非法（须为字符串）");
  const error = jsonRpcError(errorBody["code"] as number, errorBody["message"] as string);
  if ("data" in errorBody) error.data = errorBody["data"];
  return ok({ jsonrpc: "2.0", error, id } satisfies JsonRpcResponse);
};

/** 消息 → 单行线缆文本（含结尾 LF；JSON.stringify 保证字符串内不含裸 LF）。 */
export const encodeJsonRpcLine = (message: JsonRpcMessage): string => `${JSON.stringify(message)}\n`;

/** 出站请求构造（params undefined 时不带该字段，线缆面最小化）。 */
export const buildRequest = (id: number, method: string, params?: unknown): JsonRpcRequest => {
  const request: JsonRpcRequest = { jsonrpc: "2.0", method, id };
  if (params !== undefined) request.params = params;
  return request;
};

export const buildNotification = (method: string, params?: unknown): JsonRpcNotification => {
  const notification: JsonRpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) notification.params = params;
  return notification;
};

export const buildResultResponse = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  result,
  id,
});

export const buildErrorResponse = (id: JsonRpcId, error: JsonRpcError): JsonRpcResponse => ({
  jsonrpc: "2.0",
  error,
  id,
});
