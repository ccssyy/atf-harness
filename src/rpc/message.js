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
import { err, ok } from "../bridge/result.js";
/** JSON-RPC 2.0 标准 error code（-32700…-32603）＋ 本层传输类自造码（-32000 服务器域）。 */
export const JSON_RPC_ERROR_CODES = {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    /** 服务器域自造码（-32000…-32099）：本层用于超时/对端关闭等传输性失败。 */
    transportFailure: -32000,
};
export const jsonRpcError = (code, message, data) => {
    const error = { code, message };
    if (data !== undefined)
        error.data = data;
    return error;
};
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || value === null;
const hasIdKey = (value) => "id" in value;
const methodOf = (value) => typeof value["method"] === "string" && value["method"] !== "" ? value["method"] : null;
const paramsOk = (value) => !("params" in value) || isPlainObject(value["params"]) || Array.isArray(value["params"]);
/**
 * 单行文本 → JSON-RPC 消息（严格校验，fail-closed）。
 * err 时返回可应答的 {error, id}：JSON 解析失败 = -32700/id null；结构非法 = -32600
 * 并回显可提取的 id（id 字段合法时）。通知无 id、永不触发应答——调用方按类型分流。
 */
export const parseJsonRpcLine = (line) => {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return err({ error: jsonRpcError(JSON_RPC_ERROR_CODES.parseError, "非法 JSON 行"), id: null });
    }
    const failureWith = (message) => {
        const candidate = isPlainObject(parsed) ? parsed : {};
        return err({
            error: jsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, message),
            id: isId(candidate["id"]) ? candidate["id"] : null,
        });
    };
    if (!isPlainObject(parsed))
        return failureWith("消息不是 JSON 对象（批处理数组不支持）");
    if (parsed["jsonrpc"] !== "2.0")
        return failureWith(`jsonrpc 字段须为 "2.0"`);
    const hasMethod = "method" in parsed;
    const hasResult = "result" in parsed;
    const hasError = "error" in parsed;
    if (hasMethod) {
        const method = methodOf(parsed);
        if (method === null)
            return failureWith("method 非法（须为非空字符串）");
        if (!paramsOk(parsed))
            return failureWith("params 非法（须为对象或数组）");
        if (hasIdKey(parsed)) {
            if (!isId(parsed["id"]))
                return failureWith("id 非法（须为 string|number|null）");
            const request = { jsonrpc: "2.0", method, id: parsed["id"] };
            if ("params" in parsed)
                request.params = parsed["params"];
            return ok(request);
        }
        const notification = { jsonrpc: "2.0", method };
        if ("params" in parsed)
            notification.params = parsed["params"];
        return ok(notification);
    }
    // 响应面：id 必须存在，result / error 恰一
    if (!hasIdKey(parsed) || !isId(parsed["id"]))
        return failureWith("响应缺少合法 id");
    const id = parsed["id"];
    if (hasResult === hasError)
        return failureWith("响应须恰有 result 或 error 其一");
    if (hasResult) {
        return ok({ jsonrpc: "2.0", result: parsed["result"], id });
    }
    const errorBody = parsed["error"];
    if (!isPlainObject(errorBody))
        return failureWith("error 须为对象");
    if (typeof errorBody["code"] !== "number" || !Number.isFinite(errorBody["code"])) {
        return failureWith("error.code 非法（须为数值）");
    }
    if (typeof errorBody["message"] !== "string")
        return failureWith("error.message 非法（须为字符串）");
    const error = jsonRpcError(errorBody["code"], errorBody["message"]);
    if ("data" in errorBody)
        error.data = errorBody["data"];
    return ok({ jsonrpc: "2.0", error, id });
};
/** 消息 → 单行线缆文本（含结尾 LF；JSON.stringify 保证字符串内不含裸 LF）。 */
export const encodeJsonRpcLine = (message) => `${JSON.stringify(message)}\n`;
/** 出站请求构造（params undefined 时不带该字段，线缆面最小化）。 */
export const buildRequest = (id, method, params) => {
    const request = { jsonrpc: "2.0", method, id };
    if (params !== undefined)
        request.params = params;
    return request;
};
export const buildNotification = (method, params) => {
    const notification = { jsonrpc: "2.0", method };
    if (params !== undefined)
        notification.params = params;
    return notification;
};
export const buildResultResponse = (id, result) => ({
    jsonrpc: "2.0",
    result,
    id,
});
export const buildErrorResponse = (id, error) => ({
    jsonrpc: "2.0",
    error,
    id,
});
