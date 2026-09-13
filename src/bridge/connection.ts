import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { bridgeError, STDERR_TAIL_LIMIT, takeStderrTail, stringifyCause, type BridgeError } from "./errors.js";
import { DEFAULT_MAX_FRAME_BYTES, encodeRequestFrame, LineFrameDecoder, type KernelFrame } from "./frames.js";
import { err, ok, type Result } from "./result.js";

/** 请求超时初值（任务书 S1：常量定义，harness 内部实现细节，永不进入模型可见 schema）。 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 期望的契约版本（与 bridge.contract.yaml contract_version 一致；不一致 = 握手失败）。
 *  契约 v2（2026-09-13 契约修订）：1 → 2；对端 mock 握手同步回 2，
 *  内核侧批次二实现时按契约头部登记同步其握手 contract_version。 */
export const EXPECTED_CONTRACT_VERSION = 2;

/** 握手 atf.version 的结果 schema。 */
export interface AtfVersionInfo {
  name: string;
  version: string;
  contract_version: number;
}

export interface BridgeSpawnOptions {
  /** argv 形式的子进程命令，如 ["node", "/path/to/peer.mjs"] */
  command: readonly string[];
  cwd?: string;
  /** 覆盖在 process.env 之上的附加环境变量（如 PYTHONPATH） */
  env?: Readonly<Record<string, string>>;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
}

export interface BridgeCloseInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface AtfBridgeEventData {
  name: string;
  payload?: unknown;
}

interface PendingRequest {
  settle: (result: Result<unknown, BridgeError>) => void;
  timer: NodeJS.Timeout | undefined;
  method: string;
}

/**
 * stdio JSONL 桥接连接（Pi RPC 范式）。
 * 生命周期：spawn → 握手（atf.version）→ 就绪 → 优雅关闭。
 * 纪律：公开 API 全部返回 Result / Promise<Result>，禁止异常穿越边界；
 *       失败一律 fail-closed——不重试、不猜测成功。
 */
export class AtfBridgeConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<(event: AtfBridgeEventData) => void>();
  private readonly decoder: LineFrameDecoder;
  private readonly stderrChunks: string[] = [];
  private stderrLength = 0;
  private nextId = 2; // id=1 已被握手占用
  private ready = false;
  private failure: BridgeError | undefined;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private closePromise: Promise<Result<BridgeCloseInfo, BridgeError>> | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutDefault: number,
    maxFrameBytes: number,
  ) {
    this.decoder = new LineFrameDecoder(maxFrameBytes);
  }

  /** spawn + 握手。任一步失败：回收子进程并返回 err（含 stderr 尾部摘要）。 */
  public static async spawn(options: BridgeSpawnOptions): Promise<Result<AtfBridgeConnection, BridgeError>> {
    try {
      return await AtfBridgeConnection.doSpawn(options);
    } catch (cause) {
      return err(
        bridgeError({ code: "spawn_failed", message: `spawn 过程出现未预期异常: ${stringifyCause(cause)}`, detail: { cause: String(cause) } }),
      );
    }
  }

  private static async doSpawn(options: BridgeSpawnOptions): Promise<Result<AtfBridgeConnection, BridgeError>> {
    const command = options.command;
    if (command.length === 0) {
      return err(bridgeError({ code: "spawn_failed", message: "spawn 失败：command 为空" }));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command[0] as string, command.slice(1), {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (cause) {
      return err(
        bridgeError({
          code: "spawn_failed",
          message: `spawn 失败（command=${command.join(" ")}）: ${stringifyCause(cause)}`,
          detail: { command: [...command] },
        }),
      );
    }

    const connection = new AtfBridgeConnection(child, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    connection.wire();

    const handshake = await connection.requestInternal("atf.version", undefined);
    if (!handshake.ok) {
      const cause = handshake.error;
      // spawn 级失败保留原语义直通（如 ENOENT = spawn_failed）；其余折算为 handshake_failed
      const error =
        cause.code === "spawn_failed"
          ? cause
          : cause.code === "request_rejected"
            ? bridgeError({ code: "handshake_failed", message: "握手被对端拒绝（atf.version 返回错误响应）", detail: { response_error: cause.detail } })
            : bridgeError({ code: "handshake_failed", message: `握手失败: ${cause.message}`, stderrTail: cause.stderrTail, detail: cause.detail });
      connection.teardown(error);
      await connection.waitForExit(5_000);
      return err(error);
    }
    const version = handshake.value;
    if (
      typeof version !== "object" ||
      version === null ||
      (version as Record<string, unknown>)["name"] !== "atf" ||
      typeof (version as Record<string, unknown>)["version"] !== "string" ||
      !Number.isInteger((version as Record<string, unknown>)["contract_version"])
    ) {
      const error = bridgeError({ code: "handshake_failed", message: "握手结果不符合 atf.version 结果 schema（name/version/contract_version）", detail: { got: version } });
      connection.teardown(error);
      await connection.waitForExit(5_000);
      return err(error);
    }
    const versionInfo: AtfVersionInfo = {
      name: "atf",
      version: (version as Record<string, unknown>)["version"] as string,
      contract_version: (version as Record<string, unknown>)["contract_version"] as number,
    };
    if (versionInfo.contract_version !== EXPECTED_CONTRACT_VERSION) {
      const error = bridgeError({
        code: "handshake_failed",
        message: `契约版本不一致：harness 期望 ${EXPECTED_CONTRACT_VERSION}，对端报告 ${versionInfo.contract_version}（请核对 bridge.contract.yaml 与 atf_upstream pin）`,
        detail: { got: versionInfo },
      });
      connection.teardown(error);
      await connection.waitForExit(5_000);
      return err(error);
    }
    connection.ready = true;
    connection.version = versionInfo;
    return ok(connection);
  }

  /** 握手结果（就绪后可读）。 */
  public version: AtfVersionInfo | undefined;

  /** 订阅内核 event 帧；返回取消订阅函数。监听器异常被 containment，不穿越边界。 */
  public onEvent(listener: (event: AtfBridgeEventData) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 发起请求：按自增 id 配对响应；超时/对端退出/协议违规 → err，永不 reject。 */
  public request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<Result<unknown, BridgeError>> {
    if (!this.ready) {
      return Promise.resolve(
        err(bridgeError({
          code: "closed",
          message: this.failure ? `连接不可用（此前失败: ${this.failure.code}: ${this.failure.message}）` : "连接尚未就绪",
          stderrTail: this.failure?.stderrTail,
        })),
      );
    }
    return this.requestInternal(method, params, options?.timeoutMs);
  }

  /**
   * 优雅关闭：end stdin → 等待对端退出。退出码 0 = ok；其余 = err(peer_exit)。
   * 幂等：重复调用返回同一结果。
   */
  public close(options?: { timeoutMs?: number }): Promise<Result<BridgeCloseInfo, BridgeError>> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (this.exited) {
      this.closePromise = Promise.resolve(this.closeResultFromExit());
      return this.closePromise;
    }
    this.closePromise = new Promise<Result<BridgeCloseInfo, BridgeError>>((resolve) => {
      const onTimeout = (): void => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* 对端可能已退出 */
        }
      };
      const timer = setTimeout(onTimeout, options?.timeoutMs ?? this.requestTimeoutDefault);
      timer.unref?.();
      try {
        this.child.stdin.end();
      } catch (cause) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* 同上 */
        }
        resolve(
          err(bridgeError({ code: "peer_exit", message: `优雅关闭失败（end stdin 异常）: ${stringifyCause(cause)}`, stderrTail: this.stderrTail() })),
        );
        return;
      }
      this.closeSettle = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    return this.closePromise;
  }

  private closeSettle: ((result: Result<BridgeCloseInfo, BridgeError>) => void) | undefined;

  // ------------------------------------------------------------------ 内部

  private requestInternal(method: string, params: unknown, timeoutMs?: number): Promise<Result<unknown, BridgeError>> {
    if (this.failure !== undefined || this.exited) {
      return Promise.resolve(
        err(bridgeError({
          code: "closed",
          message: this.failure
            ? `连接不可用（此前失败: ${this.failure.code}: ${this.failure.message}）`
            : `连接不可用（对端已退出，exit=${this.exitCode} signal=${this.exitSignal ?? "null"}）`,
          stderrTail: this.failure?.stderrTail,
        })),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const requestFrame: { type: "request"; id: number; method: string; params?: unknown } = { type: "request", id, method };
    if (params !== undefined) requestFrame.params = params;
    const encoded = encodeRequestFrame(requestFrame);
    if (!encoded.ok) {
      return Promise.resolve(err(encoded.error));
    }
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutDefault;
    return new Promise<Result<unknown, BridgeError>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeoutError = bridgeError({ code: "timeout", message: `请求超时（${String(effectiveTimeout)}ms）: method=${method} id=${String(id)}` });
        resolve(err(timeoutError));
        // fail-closed：超时说明对端状态不可信，立即回收连接，后续请求全部 err(closed)
        this.teardown(timeoutError);
      }, effectiveTimeout);
      timer.unref?.();
      this.pending.set(id, { settle: resolve, timer, method });
      this.child.stdin.write(encoded.value, (writeError) => {
        const pending = this.pending.get(id);
        if (writeError != null && pending !== undefined) {
          this.pending.delete(id);
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          const error = bridgeError({
            code: "peer_exit",
            message: `请求写入失败（对端可能已退出）: ${writeError.message}`,
            stderrTail: this.stderrTail(),
          });
          pending.settle(err(error));
          this.teardown(error);
        }
      });
    });
  }

  private dispatch(frame: KernelFrame): void {
    if (frame.type === "event") {
      for (const listener of this.eventListeners) {
        try {
          listener({ name: frame.name, payload: frame.payload });
        } catch {
          /* 监听器异常不穿越桥接边界 */
        }
      }
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return; // 迟到/未知 id 的响应：忽略（如超时清理后到达）
    this.pending.delete(frame.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (frame.ok) {
      pending.settle(ok(frame.result));
    } else {
      pending.settle(
        err(bridgeError({
          code: "request_rejected",
          message: `对端返回错误响应: ${frame.error.message}`,
          detail: { code: frame.error.code, detail: frame.error.detail },
        })),
      );
    }
  }

  /** fail-closed 回收：记录失败、flush 全部挂起请求、终止子进程。 */
  private teardown(cause: BridgeError): void {
    this.failure ??= cause;
    for (const [, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.settle(err(cause));
    }
    this.pending.clear();
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* 对端可能已退出 */
    }
  }

  private wire(): void {
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      for (const item of this.decoder.push(chunk)) {
        if (item.kind === "frame") this.dispatch(item.frame);
        else {
          this.teardown(item.error);
          return;
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrChunks.push(chunk);
      this.stderrLength += chunk.length;
      while (this.stderrLength > STDERR_TAIL_LIMIT && this.stderrChunks.length > 1) {
        const dropped = this.stderrChunks.shift();
        this.stderrLength -= dropped?.length ?? 0;
      }
    });
    this.child.stdin.on("error", (cause: Error) => {
      this.teardown(bridgeError({ code: "peer_exit", message: `写 stdin 失败（对端可能已退出）: ${cause.message}`, stderrTail: this.stderrTail() }));
    });
    this.child.on("error", (cause: Error) => {
      this.teardown(
        bridgeError({
          code: "spawn_failed",
          message: `子进程启动失败: ${cause.message}`,
          stderrTail: this.stderrTail(),
          detail: { errno: (cause as NodeJS.ErrnoException).code },
        }),
      );
    });
    this.child.on("close", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      const tail = this.stderrTail();
      const unexpected = bridgeError({
        code: "peer_exit",
        message: `对端意外退出（exit=${String(code)} signal=${signal ?? "null"}）`,
        stderrTail: tail,
      });
      for (const [, pending] of this.pending) {
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.settle(err(unexpected));
      }
      this.pending.clear();
      if (this.closeSettle !== undefined) {
        const settle = this.closeSettle;
        this.closeSettle = undefined;
        settle(this.closeResultFromExit());
      }
    });
  }

  private closeResultFromExit(): Result<BridgeCloseInfo, BridgeError> {
    const info: BridgeCloseInfo = { exitCode: this.exitCode, signal: this.exitSignal, stderrTail: this.stderrTail() };
    if (this.exitCode === 0 && this.exitSignal === null) return ok(info);
    return err(
      bridgeError({
        code: "peer_exit",
        message: `关闭阶段对端未优雅退出（exit=${String(this.exitCode)} signal=${this.exitSignal ?? "null"}）`,
        stderrTail: info.stderrTail,
        detail: { exitCode: this.exitCode, signal: this.exitSignal },
      }),
    );
  }

  private stderrTail(): string {
    return takeStderrTail(this.stderrChunks.join(""));
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
