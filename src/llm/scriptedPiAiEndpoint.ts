/**
 * 批甲-BUILD T4——脚本化 pi-ai 本地端点（旧 FakeLlmEndpoint 随自研 codec 路径删除后的
 * 冒烟/测试基建替身；与被删件零代码关系——SSE wire 形态以 tests/llm/piAiProvider.test.ts
 * fixture 为唯一蓝本）。
 *
 * 形态：127.0.0.1 回环 node:http 服务器（零依赖）；POST 路径以 `/chat/completions` 结尾
 * （pi-ai OpenAI SDK 在 baseURL 后追加，路径前缀不挑）→ 按脚本回放 openai-completions
 * SSE chunk 流；脚本耗尽 → 500（脚本与用例步调不一致的显式失败信号，不猜测续供）。
 *
 * 请求台账（脱敏沿用旧件纪律）：认证头判定布尔（ok/missing/mismatch）；key 值不落记录、
 * 只记"请求体是否含 key"（必须恒 false——key 只进头）；台账即零外连与脱敏断言的证据面。
 *
 * 纪律：仅测试/冒烟基建（与 fauxProvider/scenario 同性质，不进生产决策路径）；零真实网络
 * （只绑回环）；expectedApiKey 由调用方注入**显式标注 fake 的假 key**，等值比对不回显。
 */
import { createServer, type Server } from "node:http";

/** 回放响应（canonical 语义面——与被删 FakeEndpointScriptItem 的 response 项同形状，冒烟脚本零改写）。 */
export interface ScriptedPiAiResponse {
  tool_calls?: ReadonlyArray<{ tool: string; params: Record<string, unknown> }>;
  final_answer?: string;
}

/** 脚本项（回放面）。 */
export type ScriptedPiAiItem =
  | { kind: "response"; response: ScriptedPiAiResponse }
  | { kind: "http_status"; status: number; body?: unknown }
  | { kind: "raw_body"; status: number; body: unknown }
  | { kind: "invalid_json"; status: number }
  | { kind: "delay_ms"; ms: number };

/** 请求台账条目（脱敏：只有认证判定布尔，无 key 值）。 */
export interface ScriptedPiAiRequestRecord {
  index: number;
  path: string;
  /** 认证头判定：ok = 形态与期望值一致；missing / mismatch = 形态或值不符 */
  auth: "ok" | "missing" | "mismatch";
  /** 请求体字符串是否包含期望 key（必须恒 false——key 只进头，不进体） */
  apiKeyInBody: boolean;
  /** 解析后的请求体（非 JSON 时为 null） */
  body: unknown;
}

// ---------------------------------------------------------------- SSE 构造（导出：in-process fetchImpl 测试桩同源复用）

/** 单条 chat.completion.chunk（openai-completions wire；piAiProvider.test 同款形态）。 */
export const piAiSseChunk = (model: string, delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-scripted-endpoint",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

/** usage 收尾 chunk（成本审计面；choices 空）。 */
export const piAiSseUsageChunk = (model: string): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-scripted-endpoint",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })}\n\n`;

/** 纯文本答复（finish stop）→ final_answer 径。 */
export const piAiSseTextReply = (model: string, text: string): string =>
  [piAiSseChunk(model, { role: "assistant", content: text }), piAiSseChunk(model, {}, "stop"), piAiSseUsageChunk(model), "data: [DONE]\n\n"].join("");

/** 工具调用答复（finish tool_calls；N 调用逐 index 全量 delta——pi-ai 编码器按 index 聚合）。 */
export const piAiSseToolCallsReply = (model: string, calls: Array<{ id: string; tool: string; args: string }>): string => {
  const parts: string[] = [piAiSseChunk(model, { role: "assistant", tool_calls: [] })];
  for (const [index, call] of calls.entries()) {
    parts.push(
      piAiSseChunk(model, {
        tool_calls: [{ index, id: call.id, type: "function", function: { name: call.tool, arguments: call.args } }],
      }),
    );
  }
  parts.push(piAiSseChunk(model, {}, "tool_calls"), piAiSseUsageChunk(model), "data: [DONE]\n\n");
  return parts.join("");
};

/** canonical 回放响应 → SSE wire（工具调用 id 确定性派生：call_<序>，与 runner 配对面同型）。 */
export const piAiSseResponseOf = (model: string, response: ScriptedPiAiResponse): string => {
  if (response.final_answer !== undefined) return piAiSseTextReply(model, response.final_answer);
  const calls = (response.tool_calls ?? []).map((call, index) => ({
    id: `call_${String(index)}`,
    tool: call.tool,
    args: JSON.stringify(call.params),
  }));
  return piAiSseToolCallsReply(model, calls);
};

// ---------------------------------------------------------------- 端点本体

export interface ScriptedPiAiEndpointOptions {
  /** 回放脚本（按请求序消费） */
  script: ScriptedPiAiItem[];
  /** 期望的假 key（显式标注 fake；等值比对用，不回显） */
  expectedApiKey: string;
  model: string;
}

export class ScriptedPiAiEndpoint {
  private constructor(
    private readonly server: Server,
    private readonly options: ScriptedPiAiEndpointOptions,
    private readonly port: number,
    private readonly requestsLog: ScriptedPiAiRequestRecord[],
  ) {}

  /** 启动（绑定 127.0.0.1 随机端口）。 */
  public static async start(options: ScriptedPiAiEndpointOptions): Promise<ScriptedPiAiEndpoint> {
    const requestsLog: ScriptedPiAiRequestRecord[] = [];
    const server = createServer((request, response) => {
      void ScriptedPiAiEndpoint.handle(options, requestsLog, request, response);
    });
    const listening = new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", (cause) => reject(cause));
    });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("脚本化端点监听地址异常");
    return new ScriptedPiAiEndpoint(server, options, address.port, requestsLog);
  }

  /** 回环 base_url（配置层 base_url 注入源；pi-ai SDK 语义＝OpenAI baseURL，路径由 SDK 追加）。 */
  public get baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /** 请求台账（只读）。 */
  public get requests(): readonly ScriptedPiAiRequestRecord[] {
    return this.requestsLog;
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private static async handle(
    options: ScriptedPiAiEndpointOptions,
    log: ScriptedPiAiRequestRecord[],
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const respondSse = (status: number, body: string): void => {
      response.writeHead(status, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(body);
    };
    const respondJson = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const authHeader = request.headers["authorization"];
    const auth: ScriptedPiAiRequestRecord["auth"] =
      authHeader === `Bearer ${options.expectedApiKey}` ? "ok" : authHeader === undefined ? "missing" : "mismatch";

    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody === "" ? null : JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
    const record: ScriptedPiAiRequestRecord = {
      index: log.length,
      path: request.url ?? "",
      auth,
      apiKeyInBody: rawBody.includes(options.expectedApiKey),
      body: parsedBody,
    };

    if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
      log.push(record);
      respondJson(404, { error: { message: `scripted-endpoint: 未知路径 ${String(request.url)}（期望 POST */chat/completions）` } });
      return;
    }
    log.push(record);

    // 逐项消费脚本（delay 项只延迟不消耗响应位）
    for (;;) {
      const item = options.script.shift();
      if (item === undefined) {
        respondJson(500, { error: { message: "scripted-endpoint: 回放脚本耗尽（脚本与用例步调不一致，显式失败信号）" } });
        return;
      }
      if (item.kind === "delay_ms") {
        await new Promise<void>((resolve) => setTimeout(resolve, item.ms));
        continue;
      }
      if (item.kind === "response") {
        respondSse(200, piAiSseResponseOf(options.model, item.response));
        return;
      }
      if (item.kind === "http_status") {
        respondJson(item.status, item.body ?? { error: { message: `scripted-endpoint: 注入 HTTP ${String(item.status)}` } });
        return;
      }
      if (item.kind === "raw_body") {
        respondJson(item.status, item.body);
        return;
      }
      // invalid_json
      respondJson(item.status, "这不是合法JSON");
      return;
    }
  }
}
