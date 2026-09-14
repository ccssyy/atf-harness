/**
 * L1a 门 2——本地假端点（任务书 §1.1 D1 / 设计 §0/§1.1：回放式 HTTP echo）。
 *
 * 形态：127.0.0.1 回环上的 node:http 服务器（零依赖），按协议路径收请求——
 *   - 校验并**记录**每笔请求（路径 / 认证头匹配布尔 / 请求体快照；key 值不落记录，
 *     只记录"与期望 key 是否一致"的判定结果——请求台账即零外连与脱敏断言的证据面）；
 *   - **回放**预编排的脚本项：canonical ModelResponse（经 codec encodeWireResponse 编码为
 *     wire 形状）/ HTTP 状态注入 / 非法形状注入 / 非 JSON 注入 / 延迟注入；
 *   - 脚本耗尽 → 500（脚本与用例不一致的显式失败信号，不猜测续供）。
 *
 * 纪律：expectedApiKey 由调用方（测试/冒烟）注入**显式标注 fake 的假 key**；本类只做
 * 等值比对，不存储、不回显；零真实网络（只绑回环）；仅测试/冒烟基建，不进生产决策路径。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getCodec } from "./codec.js";
import { type ModelResponse } from "./adapter.js";
import { type ProtocolCodec } from "./codecWire.js";
import { type ProviderProtocol } from "./providerConfig.js";

/** 脚本项（回放面）。 */
export type FakeEndpointScriptItem =
  | { kind: "response"; response: ModelResponse }
  | { kind: "http_status"; status: number; body?: unknown }
  | { kind: "raw_body"; status: number; body: unknown }
  | { kind: "invalid_json"; status: number }
  | { kind: "delay_ms"; ms: number };

/** 请求台账条目（脱敏：只有认证判定布尔，无 key 值）。 */
export interface FakeEndpointRequestRecord {
  index: number;
  path: string;
  /** 认证头判定：ok = 形态与期望值一致；missing / mismatch = 形态或值不符 */
  auth: "ok" | "missing" | "mismatch";
  /** 协议要求的次级头是否存在（anthropic-version） */
  protocolHeaderOk: boolean;
  /** 请求体字符串是否包含期望 key（必须恒 false——key 只进头，不进体） */
  apiKeyInBody: boolean;
  /** 解析后的请求体（非 JSON 时为 null） */
  body: unknown;
}

export interface FakeLlmEndpointOptions {
  protocol: ProviderProtocol;
  /** 回放脚本（按请求序消费） */
  script: FakeEndpointScriptItem[];
  /** 期望的假 key（显式标注 fake；等值比对用，不回显） */
  expectedApiKey: string;
  model: string;
}

export class FakeLlmEndpoint {
  private constructor(
    private readonly server: Server,
    private readonly options: FakeLlmEndpointOptions,
    private readonly port: number,
    private readonly requestsLog: FakeEndpointRequestRecord[],
  ) {}

  /** 启动（绑定 127.0.0.1 随机端口）。 */
  public static async start(options: FakeLlmEndpointOptions): Promise<FakeLlmEndpoint> {
    const codec = getCodec(options.protocol);
    if (!codec.ok) throw new Error(`FakeLlmEndpoint 配置非法: ${codec.error.message}`);
    const requestsLog: FakeEndpointRequestRecord[] = [];
    const server = createServer((request, response) => {
      void FakeLlmEndpoint.handle(codec.codec, options, requestsLog, request, response);
    });
    const listening = new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", (cause) => reject(cause));
    });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("假端点监听地址异常");
    return new FakeLlmEndpoint(server, options, address.port, requestsLog);
  }

  /** 回环 base_url（配置层 base_url 的注入源）。 */
  public get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** 请求台账（只读）。 */
  public get requests(): readonly FakeEndpointRequestRecord[] {
    return this.requestsLog;
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---------------------------------------------------------------- 内部

  private static async handle(
    codec: ProtocolCodec,
    options: FakeLlmEndpointOptions,
    log: FakeEndpointRequestRecord[],
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const respondJson = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const expectedPath = codec.requestPath;
    const authHeader = request.headers["authorization"];
    const apiKeyHeader = request.headers["x-api-key"];
    const anthropicVersion = request.headers["anthropic-version"];
    const auth: FakeEndpointRequestRecord["auth"] =
      options.protocol === "openai-chat"
        ? authHeader === `Bearer ${options.expectedApiKey}` ? "ok" : authHeader === undefined ? "missing" : "mismatch"
        : apiKeyHeader === options.expectedApiKey ? "ok" : apiKeyHeader === undefined ? "missing" : "mismatch";
    const protocolHeaderOk = options.protocol === "openai-chat" ? true : typeof anthropicVersion === "string" && anthropicVersion !== "";

    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody === "" ? null : JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
    const record: FakeEndpointRequestRecord = {
      index: log.length,
      path: request.url ?? "",
      auth,
      protocolHeaderOk,
      apiKeyInBody: rawBody.includes(options.expectedApiKey),
      body: parsedBody,
    };

    if (request.method !== "POST" || request.url !== expectedPath) {
      log.push(record);
      respondJson(404, { error: { message: `fake-endpoint: 未知路径 ${String(request.url)}（期望 POST ${expectedPath}）` } });
      return;
    }
    log.push(record);

    // 逐项消费脚本（delay 项只延迟不消耗响应位）
    for (;;) {
      const item = options.script.shift();
      if (item === undefined) {
        respondJson(500, { error: { message: "fake-endpoint: 回放脚本耗尽（脚本与用例步调不一致，显式失败信号）" } });
        return;
      }
      if (item.kind === "delay_ms") {
        await new Promise<void>((resolve) => setTimeout(resolve, item.ms));
        continue;
      }
      if (item.kind === "response") {
        respondJson(200, codec.encodeWireResponse(item.response, options.model));
        return;
      }
      if (item.kind === "http_status") {
        respondJson(item.status, item.body ?? { error: { message: `fake-endpoint: 注入 HTTP ${String(item.status)}` } });
        return;
      }
      if (item.kind === "raw_body") {
        respondJson(item.status, item.body);
        return;
      }
      // invalid_json
      response.writeHead(item.status, { "content-type": "application/json" });
      response.end("这不是合法JSON");
      return;
    }
  }
}
