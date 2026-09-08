import { bridgeError, type BridgeError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/** 单帧字节上限：超限按协议违规处理（fail-closed）。与 bridge.contract.yaml max_frame_bytes 对应。 */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

/** 对端错误响应体（response ok=false 时的 error 字段）。 */
export interface ResponseErrorBody {
  code: string;
  message: string;
  detail?: unknown;
}

/** TS→内核 请求帧。id 自增，从 1 开始，单连接内唯一（1 被握手占用）。 */
export interface RequestFrame {
  type: "request";
  id: number;
  method: string;
  params?: unknown;
}

/** 内核→TS 成功响应。 */
export interface OkResponseFrame {
  type: "response";
  id: number;
  ok: true;
  result: unknown;
}

/** 内核→TS 错误响应（即任务书所称"错误帧"的线缆表达）。 */
export interface ErrorResponseFrame {
  type: "response";
  id: number;
  ok: false;
  error: ResponseErrorBody;
}

/** 内核→TS 单向通知帧：无 id、不要求应答，不影响请求配对。 */
export interface EventFrame {
  type: "event";
  name: string;
  payload?: unknown;
}

export type ResponseFrame = OkResponseFrame | ErrorResponseFrame;
/** 内核→TS 全部合法帧型。 */
export type KernelFrame = ResponseFrame | EventFrame;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFrameId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/**
 * 校验内核侧来帧（严格白名单：response / event 之外一律拒绝，
 * 内核发 request 视为协议违规）。返回 null 表示合法。
 */
export const validateKernelFrame = (value: unknown): BridgeError | null => {
  const invalid = (message: string): BridgeError => bridgeError({ code: "protocol_error", message });
  if (!isPlainObject(value)) return invalid("帧不是 JSON 对象");
  switch (value["type"]) {
    case "response": {
      if (!isFrameId(value["id"])) return invalid("response.id 非法（须为非负整数）");
      if (value["ok"] === true) {
        if (!("result" in value)) return invalid("response ok=true 缺少 result 字段");
        return null;
      }
      if (value["ok"] === false) {
        const errorBody = value["error"];
        if (!isPlainObject(errorBody)) return invalid("response ok=false 缺少 error 对象");
        if (typeof errorBody["code"] !== "string" || errorBody["code"] === "") {
          return invalid("response.error.code 非法（须为非空字符串）");
        }
        if (typeof errorBody["message"] !== "string") return invalid("response.error.message 非法（须为字符串）");
        return null;
      }
      return invalid("response.ok 非法（须为布尔值）");
    }
    case "event": {
      if (typeof value["name"] !== "string" || value["name"] === "") return invalid("event.name 非法（须为非空字符串）");
      return null;
    }
    default:
      return invalid(`未知帧 type: ${String(value["type"])}`);
  }
};

/** 逐项校验并收敛为 KernelFrame（调用方已先经 validateKernelFrame 判定合法）。 */
export const asKernelFrame = (value: Record<string, unknown>): KernelFrame => {
  if (value["type"] === "event") {
    const frame: EventFrame = { type: "event", name: value["name"] as string };
    if ("payload" in value) frame.payload = value["payload"];
    return frame;
  }
  const id = value["id"] as number;
  if (value["ok"] === true) {
    return { type: "response", id, ok: true, result: value["result"] };
  }
  const errorBody = value["error"] as Record<string, unknown>;
  const error: ResponseErrorBody = {
    code: errorBody["code"] as string,
    message: errorBody["message"] as string,
  };
  if ("detail" in errorBody) error.detail = errorBody["detail"];
  return { type: "response", id, ok: false, error };
};

/** 序列化 TS→内核 请求帧为一行线缆文本（含结尾 LF）。可能失败（循环引用 / 超限），故返回 Result。 */
export const encodeRequestFrame = (
  frame: RequestFrame,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): Result<string, BridgeError> => {
  let text: string;
  try {
    text = JSON.stringify(frame);
  } catch (cause) {
    return err(bridgeError({ code: "protocol_error", message: `请求帧序列化失败（params 可能含循环引用）: ${String(cause)}` }));
  }
  if (Buffer.byteLength(text, "utf8") + 1 > maxFrameBytes) {
    return err(bridgeError({ code: "protocol_error", message: `请求帧超限（>${maxFrameBytes} 字节）: method=${frame.method}` }));
  }
  return ok(`${text}\n`);
};

export type DecodedItem = { kind: "frame"; frame: KernelFrame } | { kind: "protocol_error"; error: BridgeError };

/**
 * 增量式 LF 分帧解码器：容忍任意字节切分与多帧合包（严格 LF 分帧，
 * 与 bridge.contract.yaml framing 一致）。逐块 push，返回本块解码出的
 * 帧与协议违规项——违规不抛异常，由连接层统一折算为 fail-closed 回收。
 */
export class LineFrameDecoder {
  private buffer = "";

  public constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {}

  public push(chunk: string): DecodedItem[] {
    this.buffer += chunk;
    const items: DecodedItem[] = [];
    for (;;) {
      const lfIndex = this.buffer.indexOf("\n");
      if (lfIndex === -1) {
        if (this.buffer.length > this.maxFrameBytes) {
          items.push({
            kind: "protocol_error",
            error: bridgeError({
              code: "protocol_error",
              message: `帧超限：${this.buffer.length} 字节未见 LF 分隔（>${this.maxFrameBytes}），已丢弃`,
            }),
          });
          this.buffer = "";
        }
        break;
      }
      const line = this.buffer.slice(0, lfIndex);
      this.buffer = this.buffer.slice(lfIndex + 1);
      if (line.length > this.maxFrameBytes) {
        items.push({
          kind: "protocol_error",
          error: bridgeError({ code: "protocol_error", message: `单行超限（${line.length} > ${this.maxFrameBytes} 字节）` }),
        });
        continue;
      }
      items.push(this.decodeLine(line));
    }
    return items;
  }

  private decodeLine(line: string): DecodedItem {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const excerpt = line.length > 120 ? `${line.slice(0, 120)}…` : line;
      return {
        kind: "protocol_error",
        error: bridgeError({ code: "protocol_error", message: `非法 JSON 行: ${excerpt || "<空行>"}` }),
      };
    }
    const violation = validateKernelFrame(parsed);
    if (violation !== null) return { kind: "protocol_error", error: violation };
    return { kind: "frame", frame: asKernelFrame(parsed as Record<string, unknown>) };
  }
}
