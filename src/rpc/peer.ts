/**
 * 共享 JSON-RPC 2.0 传输层——对等体（L1 门 2 T03；D3/D8）。
 *
 * RpcPeer 是 ACP 外壳（T04：agent 角色服务 client 的 session/* 请求，并反向发
 * session/request_permission 请求）与 MCP 外壳（T05：server 角色服务 tools/*）以及
 * 两者冒烟客户端的**同一个**传输面——双向对称：每端既可发请求（出站配对）也可服务
 * 请求（入站分派）。
 *
 * 纪律：
 * - 分帧 = LF 分隔单行 JSON（增量解码，容忍任意字节切分与多帧合包，经验复用 bridge
 *   frames.ts）；单行超限 = 静默丢弃该行＋onProtocolError 留痕（不回包、不放大，fail-closed）；
 * - 配对 = 出站单调 id ↔ 挂起表；入站响应按 id 配对，配不上 = onProtocolError 留痕；
 * - JSON-RPC 2.0 标准错误码（message.ts）；入站请求 handler 缺席 = -32601；handler
 *   抛出 = -32603（不跨传输边界裸抛）；
 * - 超时/对端关闭 = -32000（transportFailure），挂起请求全部收敛，不悬挂。
 */
import {
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
} from "./message.js";

/** 入站请求处理结论（handler 返回；Result 形态，永不抛出跨边界）。 */
export type RpcHandlerOutcome = { ok: true; result: unknown } | { ok: false; error: JsonRpcError };

export interface RpcPeerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** 入站请求处理（缺省 = 一律 -32601 method not found） */
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<RpcHandlerOutcome> | RpcHandlerOutcome;
  /** 入站通知（对端→我方单向） */
  onNotification?: (method: string, params: unknown) => void;
  /** 对端流关闭（input end/close） */
  onPeerClose?: () => void;
  /** 协议异常留痕（解析失败已回包的、单行超限丢弃的、配不上 id 的响应等） */
  onProtocolError?: (error: JsonRpcError) => void;
  /** 单行字节上限（缺省 1 MiB，与 bridge frames 同量级） */
  maxLineBytes?: number;
  /** 出站请求缺省超时（缺省 60s；可按请求覆盖） */
  requestTimeoutMs?: number;
}

export interface RpcRequestOptions {
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (outcome: RpcHandlerOutcome) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_LINE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class RpcPeer {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly onRequest: NonNullable<RpcPeerOptions["onRequest"]>;
  private readonly options: RpcPeerOptions;
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number;
  private buffer = "";
  private overflow = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private started = false;
  private closed = false;

  private constructor(options: RpcPeerOptions) {
    this.input = options.input;
    this.output = options.output;
    this.options = options;
    this.onRequest = options.onRequest ?? (async (): Promise<RpcHandlerOutcome> => ({
      ok: false,
      error: jsonRpcError(JSON_RPC_ERROR_CODES.methodNotFound, "本端不提供该方法（handler 缺席）"),
    }));
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public static create(options: RpcPeerOptions): RpcPeer {
    return new RpcPeer(options);
  }

  /** 开始读取对端流（幂等；close 后不可再 start）。 */
  public start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.input.setEncoding("utf8");
    this.input.on("data", this.boundFeed);
    this.input.on("end", this.boundPeerClose);
    this.input.on("close", this.boundPeerClose);
    this.input.on("error", this.boundPeerClose);
  }

  /** 出站请求（id 自增配对；超时/关闭/编码失败折算 -32000/-32603，不悬挂不抛出）。 */
  public request(method: string, params?: unknown, options?: RpcRequestOptions): Promise<RpcHandlerOutcome> {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: jsonRpcError(JSON_RPC_ERROR_CODES.transportFailure, "本端已关闭") });
    }
    const id = ++this.nextId;
    let line: string;
    try {
      line = encodeJsonRpcLine(buildRequest(id, method, params));
    } catch (cause) {
      return Promise.resolve({
        ok: false,
        error: jsonRpcError(JSON_RPC_ERROR_CODES.internalError, `请求序列化失败（params 不可 JSON 化）: ${String(cause)}`),
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: jsonRpcError(JSON_RPC_ERROR_CODES.transportFailure, `请求超时（method=${method}）`, { method, id }),
        });
      }, options?.timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      this.write(line);
    });
  }

  /** 出站通知（单向、无配对；序列化失败静默折算 onProtocolError 留痕）。 */
  public notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.write(encodeJsonRpcLine(buildNotification(method, params)));
    } catch (cause) {
      this.options.onProtocolError?.(jsonRpcError(JSON_RPC_ERROR_CODES.internalError, `通知序列化失败: ${String(cause)}`));
    }
  }

  /** 关闭本端：收敛全部挂起请求（-32000）、解除监听。对端流不代管关闭。 */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: jsonRpcError(JSON_RPC_ERROR_CODES.transportFailure, "本端已关闭") });
      this.pending.delete(id);
    }
    this.input.removeListener("data", this.boundFeed);
    this.input.removeListener("end", this.boundPeerClose);
    this.input.removeListener("close", this.boundPeerClose);
    this.input.removeListener("error", this.boundPeerClose);
  }

  private readonly boundFeed = (chunk: string | Buffer): void => {
    this.feed(typeof chunk === "string" ? chunk : String(chunk));
  };
  private readonly boundPeerClose = (): void => {
    this.handlePeerClose();
  };

  private handlePeerClose(): void {
    if (this.closed) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: jsonRpcError(JSON_RPC_ERROR_CODES.transportFailure, "对端已关闭") });
      this.pending.delete(id);
    }
    this.options.onPeerClose?.();
  }

  /** 增量解码（LF 分帧；容忍切分与合包；超限行连同其残尾静默丢弃至下一 LF）。 */
  private feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    for (;;) {
      const lfIndex = this.buffer.indexOf("\n");
      if (lfIndex === -1) {
        if (this.buffer.length > this.maxLineBytes) {
          // 无 LF 且已超限：丢弃并置溢出标记——后续同一逻辑行的残尾一并丢弃
          this.overflow = true;
          this.buffer = "";
          this.options.onProtocolError?.(
            jsonRpcError(JSON_RPC_ERROR_CODES.parseError, `缓冲超限未见 LF（>${String(this.maxLineBytes)} 字节）——丢弃至下一 LF`),
          );
        }
        break;
      }
      const line = this.buffer.slice(0, lfIndex);
      this.buffer = this.buffer.slice(lfIndex + 1);
      if (this.overflow) {
        this.overflow = false; // 超限行的残尾：丢弃至本 LF 为止，不解析、不回包（不放大）
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        // 超限帧处理与 bridge frames 同口径：丢弃该行，不回包，留痕
        this.options.onProtocolError?.(
          jsonRpcError(JSON_RPC_ERROR_CODES.parseError, `单行超限（${String(Buffer.byteLength(line, "utf8"))} 字节）——丢弃`),
        );
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line === "\r" || line === "") return; // 空行容忍；CRLF 尾在此剥除（下方 slice）
    const parsed = parseJsonRpcLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    if (!parsed.ok) {
      // JSON-RPC 2.0：解析失败（-32700，id=null）与结构非法（-32600，回显可提取 id）
      // 均按规范回错误响应——本层为互操作面，沉默会让规范客户端悬挂。
      this.options.onProtocolError?.(parsed.error.error);
      this.write(encodeJsonRpcLine(buildErrorResponse(parsed.error.id, parsed.error.error)));
      return;
    }
    this.dispatch(parsed.value);
  }

  private dispatch(message: JsonRpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        void this.handleIncomingRequest(message.method, message.params, message.id);
      } else {
        this.options.onNotification?.(message.method, message.params);
      }
      return;
    }
    // 响应面：出站请求配对
    const id = message.id;
    if (typeof id !== "number" || !this.pending.has(id)) {
      this.options.onProtocolError?.(
        jsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, `响应 id 配不上任何出站请求: ${JSON.stringify(id) ?? "null"}`),
      );
      return;
    }
    const pending = this.pending.get(id) as PendingRequest;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.resolve({ ok: false, error: message.error });
    } else {
      pending.resolve({ ok: true, result: message.result });
    }
  }

  private async handleIncomingRequest(method: string, params: unknown, id: JsonRpcId): Promise<void> {
    let outcome: RpcHandlerOutcome;
    try {
      outcome = await this.onRequest(method, params, id);
    } catch (cause) {
      outcome = { ok: false, error: jsonRpcError(JSON_RPC_ERROR_CODES.internalError, `handler 异常: ${String(cause)}`) };
    }
    if (this.closed) return;
    this.write(encodeJsonRpcLine(outcome.ok ? buildResultResponse(id, outcome.result) : buildErrorResponse(id, outcome.error)));
  }

  private write(line: string): void {
    if (this.closed) return;
    this.output.write(line);
  }
}
