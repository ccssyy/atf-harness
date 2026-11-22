/**
 * G5 MCP 切换——atf-tools 自持 MCP stdio 连接器（内核 `python -m agentic_training_flow.mcp`）。
 *
 * 职责（任务书「连接器自写合规性」段：~150 行薄层）：spawn → initialize 握手 →
 * tools/list → tools/call；行分帧（LF JSON）、请求 id 关联、请求级超时、单连接
 * 复用、优雅关闭。传输归调用方是 vendor 明示设计（mcp-client tools.ts 工厂注释），
 * 本层即调用方自持传输。
 *
 * 并发口径（候裁默认动作①）：**串行队列化**——同一连接上同一时刻只允许一条
 * 在途请求（promise 链排队），并发调用者按 FIFO 等待。杜绝「两请求响应串包
 * 关联错乱」这类对抗面；真正的并发分片留候裁。
 *
 * request() 结果折叠（与旧 AtfBridgeConnection 语义逐字对齐，消费面
 * SpikeBridgeTransport / toAtfAgentTools / atf-subagent 零改动）：
 * - `tools/call` 成功 → ok(structuredContent)（内核 result 原样——G1 契约同层）；
 * - `isError: true` → request_rejected，detail=内核线缆错误体 `{code,message,detail}`
 *   （G1 server 保证与旧 JSONL error 响应逐字同形，故 reason=detail.code 逐字不变）；
 * - JSON-RPC `-32602` → request_rejected，detail 折 `{code:"invalid_params",…}`
 *   （保持旧 invalid_params 错误的 reason 语义）；
 * - 其余 JSON-RPC error → request_rejected，detail=错误体原样。
 *
 * 阶段 1 落位 atf-tools 包内；阶段 3 删 src/bridge 时迁 src/mcp/ 并承接
 * AtfBridgeConnection 的 webui/agent-cli 消费面。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  bridgeError,
  stringifyCause,
  STDERR_TAIL_LIMIT,
  takeStderrTail,
  type BridgeError,
} from "./errors.js";
import { err, ok, type Result } from "./result.js";

/** 请求级超时（沿用旧桥 REQUEST_TIMEOUT_MS 语义，harness 内部细节）。 */
export const MCP_REQUEST_TIMEOUT_MS = 30_000;

/** initialize 握手超时（固定值——握手不受 requestTimeoutMs 收紧影响：慢启动的
 *  真内核（依赖导入）不应被短超时误杀；短超时仅约束业务请求）。 */
export const MCP_HANDSHAKE_TIMEOUT_MS = 30_000;

/** 单帧上限（与内核 session.contract.MAX_FRAME_BYTES 同源值 1 MiB）。 */
export const MCP_MAX_FRAME_BYTES = 1_048_576;

/** 本端宣告的 MCP 协议修订版本（G1 server 支持三版本协商，报最新）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** tools/list 单项声明（形态字段按需读取；schema 三件套零复制经此面流动）。 */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: unknown;
}

/** initialize 握手结果（serverInfo）。contract_version 为旧桥 API 兼容位（恒 1——
 *  会话协议版本轴已随旧 JSONL 桥退役，字段仅为 webui/agent-cli 的打印链保形）。 */
export interface McpServerVersion {
  name: string;
  version: string;
  protocolVersion: string;
  /** 旧 AtfVersionInfo 形态兼容（恒 1，语义已退役）。 */
  contract_version: number;
}

export interface McpSpawnOptions {
  /** argv 形式的子进程命令（如 ["python3","-m","agentic_training_flow.mcp"]）。 */
  command: readonly string[];
  cwd?: string;
  /** 覆盖在 process.env 之上的附加环境变量（如 PYTHONPATH）。 */
  env?: Readonly<Record<string, string>>;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface McpCloseInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

interface PendingRequest {
  settle: (result: Result<unknown, BridgeError>) => void;
  timer: NodeJS.Timeout | undefined;
  label: string;
}

/** JSON-RPC 请求/响应关联 id（规范允许 string | number；本端发 number）。 */
type RequestId = number | string;

interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

interface CallToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

const textOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
};

/** stderr 尾部追加（体量有界）。 */
const appendStderr = (chunks: string[], text: string): void => {
  chunks.push(text);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total > STDERR_TAIL_LIMIT * 2) {
    chunks.splice(0, chunks.length - 1);
    const head = chunks[0] ?? "";
    chunks[0] = head.slice(head.length - STDERR_TAIL_LIMIT);
  }
};

/**
 * MCP stdio 连接（JSON-RPC 2.0 行分帧）。
 * 生命周期：spawn → initialize（含 notifications/initialized）→ 就绪 → 优雅关闭。
 * 纪律与旧桥一致：公开 API 全部返回 Result，禁止异常穿越边界；失败 fail-closed。
 */
export class AtfBridgeConnection {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly stderrChunks: string[] = [];
  private requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 2; // id=1 被 initialize 占用
  private queueTail: Promise<unknown> = Promise.resolve();
  private ready = false;
  private failure: BridgeError | undefined;
  private closed = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private exitWaiters: Array<() => void> = [];
  private toolsCache: McpToolDescriptor[] | undefined;
  private closePromise: Promise<Result<McpCloseInfo, BridgeError>> | undefined;

  /** serverInfo（spawn+initialize 成功后非 null）。 */
  version: McpServerVersion | null = null;

  private constructor(requestTimeoutMs: number, maxFrameBytes: number) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxFrameBytes = maxFrameBytes;
  }

  /** spawn + initialize 握手。任一步失败：回收子进程并返回 err（含 stderr 尾部）。 */
  public static async spawn(options: McpSpawnOptions): Promise<Result<AtfBridgeConnection, BridgeError>> {
    if (options.command.length === 0) {
      return err(bridgeError({ code: "spawn_failed", message: "spawn 失败：command 为空" }));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command[0] as string, options.command.slice(1), {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      return err(
        bridgeError({
          code: "spawn_failed",
          message: `spawn 失败（command=${options.command.join(" ")}）: ${stringifyCause(cause)}`,
          detail: { command: [...options.command] },
        }),
      );
    }
    const connection = new AtfBridgeConnection(
      options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
      options.maxFrameBytes ?? MCP_MAX_FRAME_BYTES,
    );
    connection.child = child;
    connection.wire(child);
    // 握手超时独立（MCP_HANDSHAKE_TIMEOUT_MS）——requestTimeoutMs 只约束业务请求
    const handshakeGuard = connection.withRequestTimeout(MCP_HANDSHAKE_TIMEOUT_MS);
    const initialized = await connection.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "atf-harness", version: "0.1.0" },
    }, "initialize");
    handshakeGuard.restore();
    if (!initialized.ok) {
      const error =
        initialized.error.code === "spawn_failed"
          ? initialized.error
          : bridgeError({
              code: "handshake_failed",
              message: `MCP initialize 失败: ${initialized.error.message}`,
              stderrTail: initialized.error.stderrTail,
              detail: initialized.error.detail,
            });
      connection.failAll(error);
      connection.teardown();
      await connection.waitForExit(5_000);
      return err(error);
    }
    const info = initialized.value as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } };
    const protocolVersion = info.protocolVersion;
    const serverInfo = info.serverInfo;
    if (
      typeof protocolVersion !== "string" || protocolVersion === "" ||
      typeof serverInfo !== "object" || serverInfo === null ||
      typeof serverInfo.name !== "string" || typeof serverInfo.version !== "string"
    ) {
      const error = bridgeError({
        code: "handshake_failed",
        message: "initialize 结果不符合 MCP 形态（protocolVersion/serverInfo）",
        detail: { got: initialized.value },
      });
      connection.failAll(error);
      connection.teardown();
      await connection.waitForExit(5_000);
      return err(error);
    }
    connection.version = { name: serverInfo.name, version: serverInfo.version, protocolVersion, contract_version: 1 };
    // MCP 规范：initialize 应答后客户端发 initialized 通知（server 不回帧）
    const notified = connection.sendFrame({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (!notified.ok) {
      connection.failAll(notified.error);
      connection.teardown();
      await connection.waitForExit(5_000);
      return err(notified.error);
    }
    connection.ready = true;
    return ok(connection);
  }

  /**
   * 内核方法调用（SpikeBridgeTransport 兼容面）：`tools/call` + 结果折叠。
   * method=内核注册名（atf_workspace_status / atf.bind_run / ledger_query …）。
   */
  public async request(method: string, params?: unknown): Promise<Result<unknown, BridgeError>> {
    const raw = await this.rpc("tools/call", {
      name: method,
      arguments: params === undefined ? null : params,
    }, `tools/call ${method}`);
    if (!raw.ok) return raw;
    const result = raw.value as CallToolResult;
    if (result.isError === true) {
      const body = (result.structuredContent ?? {}) as { code?: unknown; message?: unknown };
      return err(
        bridgeError({
          code: "request_rejected",
          message: typeof body.message === "string" && body.message !== "" ? body.message : `工具 ${method} 执行失败`,
          detail: result.structuredContent ?? {},
        }),
      );
    }
    return ok(result.structuredContent ?? null);
  }

  /** tools/list（连接级缓存；force=true 强制重拉）。fail 即 err——不静默降级。 */
  public async listTools(force = false): Promise<Result<McpToolDescriptor[], BridgeError>> {
    if (!force && this.toolsCache !== undefined) return ok(this.toolsCache);
    const raw = await this.rpc("tools/list", {}, "tools/list");
    if (!raw.ok) return raw;
    const tools = (raw.value as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return err(bridgeError({ code: "protocol_error", message: "tools/list 结果缺 tools 数组", detail: { got: raw.value } }));
    }
    const descriptors: McpToolDescriptor[] = [];
    for (const tool of tools) {
      const name = (tool as { name?: unknown }).name;
      if (typeof name !== "string" || name === "") {
        return err(bridgeError({ code: "protocol_error", message: "tools/list 含无名工具项", detail: { got: tool } }));
      }
      descriptors.push(tool as McpToolDescriptor);
    }
    this.toolsCache = descriptors;
    return ok(descriptors);
  }

  /** 优雅关闭：stdin EOF → 等退出；超时强杀。幂等。 */
  public async close(options?: { timeoutMs?: number }): Promise<Result<McpCloseInfo, BridgeError>> {
    if (this.closed) return this.closePromise ?? err(bridgeError({ code: "closed", message: "连接已关闭" }));
    this.closed = true;
    const timeoutMs = options?.timeoutMs ?? 5_000;
    this.closePromise = new Promise<Result<McpCloseInfo, BridgeError>>((resolve) => {
      const finish = (error: BridgeError | null): void => {
        resolve(
          error !== null
            ? err(error)
            : ok({ exitCode: this.exitCode, signal: this.exitSignal, stderrTail: this.stderrTail() }),
        );
      };
      // 主动关闭路径的退出（含对端随 EOF 自退）恒按成功收口——failAll 置入的
      // "closed" failure 只服务在途请求回收，不传染 close 结果本身。
      this.exitWaiters.push(() => finish(null));
      const timer = setTimeout(() => {
        this.teardown();
        finish(bridgeError({ code: "peer_exit", message: `关闭超时（${String(timeoutMs)}ms）强杀`, stderrTail: this.stderrTail() }));
      }, timeoutMs);
      this.exitWaiters.push(() => clearTimeout(timer));
      this.failAll(bridgeError({ code: "closed", message: "连接已主动关闭" }));
      if (this.child !== null && this.child.stdin.writable) this.child.stdin.end();
      else finish(null);
    });
    return this.closePromise;
  }

  /** stderr 尾部摘要（诊断）。 */
  public stderrTail(): string {
    return takeStderrTail(this.stderrChunks.join(""));
  }

  // —— 内部 ——————————————————————————————————————————————

  /** 临时覆写请求超时（握手期专用——restore 恢复）。 */
  private withRequestTimeout(timeoutMs: number): { restore: () => void } {
    const previous = this.requestTimeoutMs;
    this.requestTimeoutMs = timeoutMs;
    return { restore: () => { this.requestTimeoutMs = previous; } };
  }

  /** 串行队列化的 JSON-RPC 请求（候裁默认动作①：同一时刻仅一条在途）。 */
  private rpc(method: string, params: unknown, label: string): Promise<Result<unknown, BridgeError>> {
    const run = async (): Promise<Result<unknown, BridgeError>> => {
      if (this.failure !== undefined) return err(this.failure);
      if (!this.ready && method !== "initialize") {
        return err(bridgeError({ code: "closed", message: `连接未就绪即请求 ${label}` }));
      }
      return await this.sendRpcFrame(method, params, label);
    };
    const next = this.queueTail.then(run, run);
    this.queueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private sendRpcFrame(method: string, params: unknown, label: string): Promise<Result<unknown, BridgeError>> {
    return new Promise<Result<unknown, BridgeError>>((resolve) => {
      const id = this.nextId++;
      const sent = this.sendFrame({ jsonrpc: "2.0", id, method, params });
      if (!sent.ok) {
        resolve(sent);
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolve(err(bridgeError({ code: "timeout", message: `请求超时（${label}，${String(this.requestTimeoutMs)}ms）` })));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { settle: resolve, timer, label });
    });
  }

  /** 写一帧（含尾部 LF）；坏值（不可序列化/超限）折 protocol_error。 */
  private sendFrame(frame: Record<string, unknown>): Result<true, BridgeError> {
    const child = this.child;
    if (child === null || !child.stdin.writable) {
      return err(bridgeError({ code: "closed", message: "连接不可写（子进程不在场）" }));
    }
    let payload: string;
    try {
      payload = `${JSON.stringify(frame)}\n`;
    } catch (cause) {
      return err(bridgeError({ code: "protocol_error", message: `帧不可序列化: ${stringifyCause(cause)}` }));
    }
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > this.maxFrameBytes) {
      return err(
        bridgeError({
          code: "protocol_error",
          message: `帧超限（${String(bytes)} > ${String(this.maxFrameBytes)}）——大 payload 请分批提交`,
        }),
      );
    }
    child.stdin.write(payload);
    return ok(true);
  }

  private wire(child: ChildProcessWithoutNullStreams): void {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt >= 0) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (line.trim() !== "") this.handleLine(line);
        newlineAt = buffer.indexOf("\n");
      }
      if (buffer.length > this.maxFrameBytes) {
        this.failAll(bridgeError({ code: "protocol_error", message: "无 LF 的输出超帧上限（对端疑似发疯）", stderrTail: this.stderrTail() }));
        this.teardown();
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => appendStderr(this.stderrChunks, chunk));
    child.on("error", (cause) => {
      this.failAll(bridgeError({ code: "spawn_failed", message: `子进程错误: ${stringifyCause(cause)}` }));
      this.teardown();
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      const graceful = this.closed;
      this.failAll(
        graceful
          ? bridgeError({ code: "closed", message: "连接已关闭" })
          : bridgeError({
              code: "peer_exit",
              message: `对端退出（code=${String(code)} signal=${String(signal)}）`,
              stderrTail: this.stderrTail(),
            }),
      );
      this.child = null;
      for (const waiter of this.exitWaiters.splice(0)) waiter();
    });
  }

  /** 处理一行响应：JSON 解析 → id 关联 → JSON-RPC error 折叠。 */
  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(bridgeError({ code: "protocol_error", message: `对端输出非 JSON 行（前 120 字符）：${line.slice(0, 120)}`, stderrTail: this.stderrTail() }));
      return;
    }
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id !== "number" && typeof id !== "string") return; // 通知（server 不发；防御忽略）
    const pending = this.pending.get(id);
    if (pending === undefined) return; // 已超时/已关闭的迟到响应：忽略
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const body = (message as { error?: unknown }).error;
    if (body !== undefined) {
      pending.settle(err(this.foldRpcError(body, pending.label)));
      return;
    }
    pending.settle(ok((message as { result?: unknown }).result));
  }

  /** JSON-RPC error → BridgeError（request_rejected 语义保持旧桥对齐）。 */
  private foldRpcError(body: unknown, label: string): BridgeError {
    if (typeof body === "object" && body !== null && typeof (body as JsonRpcErrorBody).code === "number") {
      const rpc = body as JsonRpcErrorBody;
      if (rpc.code === -32602) {
        // 旧桥 invalid_params 错误响应的 reason 语义保持（detail.code="invalid_params"）
        return bridgeError({
          code: "request_rejected",
          message: rpc.message,
          detail: { code: "invalid_params", message: rpc.message, detail: rpc.data },
        });
      }
      return bridgeError({ code: "request_rejected", message: rpc.message, detail: body });
    }
    return bridgeError({ code: "protocol_error", message: `错误响应形态非法（${label}）`, detail: { got: body } });
  }

  /** 全部在途请求失败 + 连接态冻结（fatal 用）。 */
  private failAll(error: BridgeError): void {
    if (this.failure === undefined) this.failure = error;
    this.ready = false;
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.settle(err(this.failure));
      this.pending.delete(id);
    }
  }

  private teardown(): void {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    child.stdin.destroy();
    child.kill("SIGKILL");
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.teardown();
        resolve();
      }, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** 阶段 1-2 过渡名（atf-tools 消费）——与 AtfBridgeConnection 同类。 */
export { AtfBridgeConnection as AtfMcpConnection };
