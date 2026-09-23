/**
 * pi-ai 换库批（门 2，2026-09-23）——PiAiLlmProvider fixture 等价性＋单测。
 *
 * 指令 §四.1 fixture 等价性五组（经 pi-ai onPayload 钩子捕获出站请求体断言；
 * fetchImpl 全注入＋本地回环 base_url——零真实调用，零外连）：
 *   ① 悬空工具调用→合成"[未执行…]"结果且含审批摘要缓冲回填；
 *   ② approval 往返夹在 tool_call 与 tool_result 之间→回填次序＝现语义（先结果后附言）；
 *   ③ 会话内多 assistant 工具轮→每条 assistant 消息带 reasoning_content（空串回填路径）；
 *   ④ effort 四档：none→无 reasoning 字段且 thinking=disabled；low/high/max→reasoning_effort 直传；
 *   ⑤ max_tokens=393216 显式出现在请求体（不取目录缺省）。
 * 指令 §四.2 单测：effort 闭集（配置层见 piAiConfig.test.ts）、length 分型（runner 级见
 * tests/run/piaiLengthRecovery.test.ts）、R3 切换即时生效、N 工具→N 决策、usage/配额/脱敏、
 * walk fail-closed。
 */
import { describe, expect, it } from "vitest";
import {
  HARNESS_SYSTEM_PROMPT,
  PiAiLlmProvider,
  walkAdapterMessagesToPi,
  type LengthTruncationSignal,
} from "../../src/llm/index.js";
import type { AdapterMessage } from "../../src/llm/adapter.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const FAKE_KEY = "fake-piai-test-key-DO-NOT-USE";

/** 修订 v2 解析形态（选中 provider+model；protocol="pi-ai"＝feature flag 生效形态）。 */
const CONFIG = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    provider_id: "deepseek",
    protocol: "pi-ai",
    base_url: "http://127.0.0.1:45327",
    api_key: FAKE_KEY,
    model: "deepseek-flash",
    reasoning: true,
    reasoning_effort: "max",
    max_tokens: 393216,
    context_window: null,
    compat: { supports_developer_role: false, supports_reasoning_effort: true },
    timeout_ms: 5_000,
    max_retries: 1,
    max_calls_per_run: 50,
    ...overrides,
  }) as never;

const TOOLS: ModelVisibleTool[] = [
  { name: "atf_fact_scan", description: "事实索引枚举", parameters: { type: "object", required: [], properties: {} } },
];

const CTX = (events: LlmContextEvent[]): readonly LlmContextEvent[] => events;

const userEvent = (id: number, text: string): LlmContextEvent =>
  ({ id, ts: "2026-09-23T00:00:00Z", type: "user/message", payload: { text } }) as never;
const callEvent = (id: number, tool: string, params: Record<string, unknown>): LlmContextEvent =>
  ({ id, ts: "2026-09-23T00:00:00Z", type: "tool/call", payload: { tool, params } }) as never;
const resultEvent = (id: number, tool: string, ok: boolean, body: Record<string, unknown>): LlmContextEvent =>
  ({ id, ts: "2026-09-23T00:00:00Z", type: "tool/result", payload: { tool, ok, ...body } }) as never;

// ---------------------------------------------------------------- SSE 假端点

type Delta = Record<string, unknown>;
const chunk = (delta: Delta, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-piai-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
const usageChunk = (): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-piai-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "deepseek-flash",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 } },
  })}\n\n`;

const sse = (...chunks: string[]): Response =>
  new Response(`${chunks.join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });

/** 纯文本答复（finish stop）→ final_answer 径。 */
const textFinishStop = (text: string): Response => sse(chunk({ role: "assistant", content: text }), chunk({}, "stop"), usageChunk());
/** 工具调用（finish tool_calls）。 */
const sseToolCall = (id: string, tool: string, args: string): Response =>
  sse(
    chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, "tool_calls"),
    usageChunk(),
  );
/** 思考吞预算截断（仅 reasoning_content，finish length）。 */
const sseLengthThinkingOnly = (): Response => sse(chunk({ reasoning_content: "思考中…" }), chunk({}, "length"), usageChunk());
/** 文本产出截断（content 非空，finish length）。 */
const sseLengthWithText = (text: string): Response => sse(chunk({ role: "assistant", content: text }), chunk({}, "length"), usageChunk());

interface CapturedRequest {
  url: string;
  authorization: string | null;
  payload: Record<string, unknown>;
}

interface Harness {
  requests: CapturedRequest[];
  /** 出站 wire 参数（onPayload 捕获，按调用序与 requests 一一对应） */
  payloads: Record<string, unknown>[];
  provider: PiAiLlmProvider;
}

/** 组装被测 provider：fetch 脚本化回放＋onPayload 捕获（零真实网络）。
 *  onPayload 先于 fetch 发出（pi-ai 组装参数后、SDK 发送前回调），payloads 与 requests
 *  按调用序一一对应（payloads[i] ↔ requests[i]）。 */
const harness = (options: { responses: Response[]; config?: Record<string, unknown> }): Harness => {
  const requests: CapturedRequest[] = [];
  const responses = options.responses;
  const payloads: Record<string, unknown>[] = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const captured: CapturedRequest = {
      url: String(input),
      authorization: headers.get("authorization"),
      payload: {},
    };
    requests.push(captured);
    const response = responses[Math.min(call, responses.length - 1)] as Response;
    call += 1;
    return response;
  };
  const provider = new PiAiLlmProvider({
    config: CONFIG(options.config ?? {}) as never,
    tools: TOOLS,
    fetchImpl,
    onPayload: (payload) => {
      payloads.push(payload as Record<string, unknown>);
    },
  });
  return { requests, payloads, provider };
};

const messagesOf = (payload: Record<string, unknown>): Record<string, unknown>[] => payload["messages"] as Record<string, unknown> [];

// ---------------------------------------------------------------- fixture 五组

describe("pi-ai fixture 等价性（指令 §四.1 五组）", () => {
  it("① 悬空工具调用→合成[未执行…]结果且审批摘要并入；② approval 夹层→先结果后附言", async () => {
    // ②：tool/call → approval/request → approval/response → tool_result（审批夹在中间）
    const ctx = CTX([
      userEvent(1, "查询现场"),
      callEvent(2, "atf_fact_scan", {}),
      { id: 3, ts: "t", type: "approval/request", payload: { tool: "atf_fact_scan", question: "放行？" } } as never,
      { id: 4, ts: "t", type: "approval/response", payload: { verdict: "granted", actor: "tui-operator" } } as never,
      resultEvent(5, "atf_fact_scan", true, { result: { ok: true, facts: [], count: 0 }, call_ref: 2 }),
    ]);
    const h = harness({ responses: [textFinishStop("完成")] });
    const decided = await h.provider.decide(ctx);
    expect(decided.ok && decided.value).toEqual({ type: "final_answer", text: "完成" });
        const wire = messagesOf(h.payloads[0] as Record<string, unknown>);
    // 形态：system｜user｜assistant(tool_calls)｜tool(结果)｜user(审批附言)
    expect(wire).toHaveLength(5);
    expect(wire[0]?.["role"]).toBe("system");
    expect(wire[1]).toMatchObject({ role: "user", content: "查询现场" });
    expect(wire[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_2", type: "function", function: { name: "atf_fact_scan" } }] });
    expect(wire[3]).toMatchObject({ role: "tool", tool_call_id: "call_2" });
    expect(String(wire[3]?.["content"])).toContain('"count":0');
    // 回填次序＝现语义：附言在结果之后，先结果后附言
    expect(wire[4]).toMatchObject({ role: "user" });
    expect(String(wire[4]?.["content"])).toContain("[审批往返]");
    expect(String(wire[4]?.["content"])).toContain('请求：{"tool":"atf_fact_scan","question":"放行？"}');
    expect(String(wire[4]?.["content"])).toContain("应答：");

    // ①：悬空（run 挂起无 tool_result，审批摘要缓冲中）→ 末尾合成[未执行…]结果
    const dangling = CTX([
      userEvent(1, "查询现场"),
      callEvent(2, "atf_admit_data", { dataset_id: "ds-x" }),
      { id: 3, ts: "t", type: "approval/request", payload: { tool: "atf_admit_data", question: "放行？" } } as never,
    ]);
    const h2 = harness({ responses: [textFinishStop("好")] });
    await h2.provider.decide(dangling);
    const wire2 = messagesOf(h2.payloads[0] as Record<string, unknown>);
    expect(wire2).toHaveLength(4); // system｜user｜assistant(tool_calls)｜tool(合成)
    const synthetic = wire2[3] as Record<string, unknown>;
    expect(synthetic).toMatchObject({ role: "tool", tool_call_id: "call_2" });
    const syntheticText = String(synthetic["content"]);
    expect(syntheticText).toContain("[未执行：等待人工审批]");
    expect(syntheticText).toContain("工具调用未执行：审批未在进程内完成，动作未发生。");
    expect(syntheticText).toContain("[审批往返]");
    expect(syntheticText).toContain('请求：{"tool":"atf_admit_data","question":"放行？"}');
  });

  it("③ 多 assistant 工具轮→每条 assistant 消息携带 reasoning_content（历史无思考→空串回填）", async () => {
    const ctx = CTX([
      userEvent(1, "两轮工具"),
      callEvent(2, "atf_fact_scan", {}),
      resultEvent(3, "atf_fact_scan", true, { result: { ok: true, facts: [], count: 0 }, call_ref: 2 }),
      callEvent(4, "atf_gate", { gate: "G1", action: "query" }),
      resultEvent(5, "atf_gate", true, { result: { ok: true, gate: "G1", status: "pass" }, call_ref: 4 }),
    ]);
    const h = harness({ responses: [textFinishStop("完成")] });
    await h.provider.decide(ctx);
    const wire = messagesOf(h.payloads[0] as Record<string, unknown>);
    const assistants = wire.filter((message) => message["role"] === "assistant");
    expect(assistants).toHaveLength(2);
    for (const assistant of assistants) {
      expect(assistant["reasoning_content"]).toBe(""); // pi-ai compat 内建回填（DSH 规则语义等价）
      expect(assistant["tool_calls"]).toHaveLength(1);
    }
  });

  it("④ effort 四档：none→无 reasoning 且 thinking=disabled；low/high/max→reasoning_effort 直传＋thinking=enabled", async () => {
    for (const [effort, expectEffort] of [
      ["none", null],
      ["low", "low"],
      ["high", "high"],
      ["max", "max"],
    ] as const) {
      const h = harness({ responses: [textFinishStop("完成")], config: { reasoning_effort: effort } });
      const decided = await h.provider.decide(CTX([userEvent(1, "hi")]));
      expect(decided.ok).toBe(true);
      const payload = { payload: h.payloads[0] as Record<string, unknown> };
      if (expectEffort === null) {
        expect(payload.payload["reasoning_effort"]).toBeUndefined();
        expect(payload.payload["thinking"]).toEqual({ type: "disabled" });
      } else {
        expect(payload.payload["reasoning_effort"]).toBe(expectEffort);
        expect(payload.payload["thinking"]).toEqual({ type: "enabled" });
      }
    }
    // compat 抑制：supports_reasoning_effort=false → effort 整体省略（与旧路径规则 4 同语义）
    const suppressed = harness({
      responses: [textFinishStop("完成")],
      config: { reasoning_effort: "max", compat: { supports_developer_role: false, supports_reasoning_effort: false } },
    });
    await suppressed.provider.decide(CTX([userEvent(1, "hi")]));
    expect((suppressed.payloads[0] as Record<string, unknown>)["reasoning_effort"]).toBeUndefined();
    // effort 被抑制（compat=false）与 none 同形：不传 reasoning → pi-ai 下发 thinking:disabled（关思考）
    expect((suppressed.payloads[0] as Record<string, unknown>)["thinking"]).toEqual({ type: "disabled" });
  });

  it("⑤ max_tokens=393216 显式出现在请求体（R4：不取目录缺省 384000）", async () => {
    const h = harness({ responses: [textFinishStop("完成")] });
    await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect((h.payloads[0] as Record<string, unknown>)["max_tokens"]).toBe(393216);
    expect((h.payloads[0] as Record<string, unknown>)["model"]).toBe("deepseek-flash");
    expect((h.requests[0] as CapturedRequest).url).toBe("http://127.0.0.1:45327/chat/completions"); // 回环，零外连
    expect((h.requests[0] as CapturedRequest).authorization).toBe(`Bearer ${FAKE_KEY}`); // key 只在头
    // 目录缺省未被使用：请求体不含 384000
    expect(JSON.stringify(h.payloads[0])).not.toContain("384000");
  });
});

// ---------------------------------------------------------------- 单测

describe("PiAiLlmProvider——决策展开/usage/length 分型/错误面", () => {
  it("N 工具→N 顺序决策（A3 展开序：message 先于 tool_calls）；单次响应 1 次调用", async () => {
    const h = harness({
      responses: [
        sse(
          chunk({ role: "assistant", content: "查询中" }),
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "atf_fact_scan", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "atf_gate", arguments: "" } }] }),
          chunk({ tool_calls: [{ index: 1, function: { arguments: '{"gate":"G1","action":"query"}' } }] }),
          chunk({}, "tool_calls"),
          usageChunk(),
        ),
      ],
    });
    const first = await h.provider.decide(CTX([userEvent(1, "任务")]));
    expect(first.ok && first.value).toEqual({ type: "assistant_message", text: "查询中" });
    const second = await h.provider.decide(CTX([userEvent(1, "任务")]));
    expect(second.ok && second.value).toEqual({ type: "tool_call", tool: "atf_fact_scan", params: {} });
    const third = await h.provider.decide(CTX([userEvent(1, "任务")]));
    expect(third.ok && third.value).toEqual({ type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query" } });
    expect(h.provider.calls).toBe(1);
    expect(h.requests).toHaveLength(1);
  });

  it("usage 缝：onUsage/lastUsage 携带 reasoning tokens 与 cost（目录峰值价保守计价）", async () => {
    const seen: unknown[] = [];
    const provider = new PiAiLlmProvider({
      config: CONFIG() as never,
      tools: TOOLS,
      fetchImpl: async () => textFinishStop("done"),
      onUsage: (usage) => seen.push(usage),
    });
    const decided = await provider.decide(CTX([userEvent(1, "hi")]));
    expect(decided.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const usage = seen[0] as { output: number; reasoning: number; cost: { total: number } };
    expect(usage.output).toBe(8);
    expect(usage.reasoning).toBe(3);
    expect(usage.cost.total).toBeGreaterThan(0);
    expect(provider.lastUsage?.totalTokens).toBe(20);
  });

  it("length 分型：思考吞预算→信号 contentEmpty=true；文本截断→contentEmpty=false；信号一次性", async () => {
    const h1 = harness({ responses: [sseLengthThinkingOnly()] });
    const decided1 = await h1.provider.decide(CTX([userEvent(1, "hi")]));
    expect(decided1.ok && decided1.value).toBeNull(); // ok(null)：runner 消费信号（现语义通道）
    const signal1 = h1.provider.consumeLengthSignal() as LengthTruncationSignal;
    expect(signal1).toMatchObject({ kind: "length_truncated", contentEmpty: true });
    expect(h1.provider.consumeLengthSignal()).toBeNull(); // 一次性

    const h2 = harness({ responses: [sseLengthWithText("部分产出")] });
    await h2.provider.decide(CTX([userEvent(1, "hi")]));
    const signal2 = h2.provider.consumeLengthSignal() as LengthTruncationSignal;
    expect(signal2).toMatchObject({ kind: "length_truncated", contentEmpty: false });
  });

  it("429/配额→provider_quota_or_rate_limited（max_retries=0，单次调用）；错误信息经脱敏漏斗", async () => {
    const quotaBody = JSON.stringify({ error: { message: `insufficient quota for key ${FAKE_KEY}`, code: "insufficient_quota" } });
    const h = harness({
      responses: [new Response(quotaBody, { status: 429, headers: { "content-type": "application/json" } })],
      config: { max_retries: 0 },
    });
    const decided = await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error("unreachable");
    expect(decided.error.code).toBe("provider_quota_or_rate_limited");
    expect(JSON.stringify(decided.error)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(decided.error)).toContain("[REDACTED]");
    expect(h.provider.calls).toBe(1);
  });

  it("5xx→provider_failure；walk 形状非法（孤儿 tool_result）→本地 fail-closed，零网络请求", async () => {
    const h = harness({
      responses: [new Response('{"error":{"message":"boom"}}', { status: 500, headers: { "content-type": "application/json" } })],
      config: { max_retries: 0 },
    });
    const decided = await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error("unreachable");
    expect(decided.error.code).toBe("provider_failure");

    const orphan = CTX([
      userEvent(1, "hi"),
      { id: 2, ts: "t", type: "tool/result", payload: { tool: "atf_fact_scan", ok: true, result: {}, call_ref: 9 } } as never,
    ]);
    const h2 = harness({ responses: [textFinishStop("done")] });
    const decided2 = await h2.provider.decide(orphan);
    expect(decided2.ok).toBe(false);
    expect(h2.requests).toHaveLength(0); // 未发起网络请求（fail-closed 本地收口）
  });

  it("成本护栏：max_calls_per_run 命中→call_budget_exhausted（length 重试同计入）", async () => {
    const h = harness({ responses: [textFinishStop("done")], config: { max_calls_per_run: 1 } });
    const first = await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect(first.ok).toBe(true);
    const second = await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("call_budget_exhausted");
  });
});

describe("R3：effort 运行时切换（新请求即时生效）", () => {
  it("setReasoningEffort(low) 后下一次请求 reasoning_effort=low；闭集外拒绝且不生效", async () => {
    const h = harness({ responses: [textFinishStop("a"), textFinishStop("b"), textFinishStop("c")] });
    expect(h.provider.reasoningEffort).toBe("max");

    const rejected = h.provider.setReasoningEffort("medium");
    expect(rejected.ok).toBe(false);
    expect(h.provider.reasoningEffort).toBe("max"); // 拒绝不生效

    const switched = h.provider.setReasoningEffort("low");
    expect(switched.ok && switched.value).toEqual({ from_effort: "max", to_effort: "low" });
    await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect((h.payloads[0] as Record<string, unknown>)["reasoning_effort"]).toBe("low"); // 新请求即时生效

    const toNone = h.provider.setReasoningEffort("none");
    expect(toNone.ok).toBe(true);
    await h.provider.decide(CTX([userEvent(1, "hi")]));
    expect((h.payloads[1] as Record<string, unknown>)["reasoning_effort"]).toBeUndefined(); // none→不传
    expect((h.payloads[1] as Record<string, unknown>)["thinking"]).toEqual({ type: "disabled" });
  });
});

describe("序列 walk 纯函数（walkAdapterMessagesToPi）", () => {
  const scaffold = { api: "openai-completions", provider: "deepseek", model: "deepseek-flash", timestamp: 0 };

  it("工具结果配对失败整体拒绝；FIFO 配对＋工具名一致性校验", () => {
    const okWalk = walkAdapterMessagesToPi(
      [
        { role: "user", text: "t", source_event_id: 1 },
        { role: "assistant_tool_call", tool: "atf_fact_scan", params: {}, source_event_id: 2 },
        { role: "tool_result", tool: "atf_fact_scan", ok: true, summary: "s", source_event_id: 3 },
      ],
      scaffold,
    );
    expect(okWalk.ok).toBe(true);

    const nameMismatch = walkAdapterMessagesToPi(
      [
        { role: "assistant_tool_call", tool: "atf_fact_scan", params: {}, source_event_id: 2 },
        { role: "tool_result", tool: "atf_gate", ok: true, summary: "s", source_event_id: 3 },
      ] as AdapterMessage[],
      scaffold,
    );
    expect(nameMismatch.ok).toBe(false);
  });
});
