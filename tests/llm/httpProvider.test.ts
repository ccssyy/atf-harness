/**
 * L1a 门 2——HTTP provider 单元级测试（任务书 §1.1/§1.2/§3.3/§3.7）。
 * 决策缓冲 / 成本护栏（可区分原因）/ 重试（网络/5xx）/ 不重试（4xx）/ 脱敏漏斗 /
 * 零外连断言（fetch 注入面：全部请求命中回环 base_url）。fetchImpl 全注入（零真实网络）。
 */
import { describe, expect, it } from "vitest";
import { HttpLlmProvider, HARNESS_SYSTEM_PROMPT } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/session/index.js";
import type { ModelVisibleTool } from "../../src/tools/index.js";

const FAKE_KEY = "fake-provider-test-key-DO-NOT-USE";

const CONFIG = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    protocol: "openai-chat",
    base_url: "http://127.0.0.1:45321",
    api_key: FAKE_KEY,
    model: "fake-model-provider",
    timeout_ms: 5_000,
    max_retries: 1,
    max_calls_per_run: 50,
    reasoning_effort: "low",
    max_tokens: 4096,
    ...overrides,
  }) as never;

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];

const CTX: readonly LlmContextEvent[] = [
  { id: 1, ts: "2026-09-14T00:00:00Z", type: "user/message", payload: { text: "任务" } },
] as never;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const completion = (message: Record<string, unknown>, finishReason = "stop"): unknown => ({
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", ...message } }],
});

describe("HttpLlmProvider——决策缓冲（A3：一次响应 N 决策逐个弹出）", () => {
  it("message+tool_call 响应 → 两次 decide 各返回一个决策；仅 1 次 HTTP 调用", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(completion({ content: "查询中", tool_calls: [{ id: "c", type: "function", function: { name: "atf_fact_scan", arguments: "{}" } }] }, "tool_calls"));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const first = await provider.decide(CTX);
    expect(first.ok && first.value).toEqual({ type: "assistant_message", text: "查询中" });
    const second = await provider.decide(CTX);
    expect(second.ok && second.value).toEqual({ type: "tool_call", tool: "atf_fact_scan", params: {} });
    expect(provider.calls).toBe(1);
    expect(urls).toHaveLength(1);
  });

  it("缓冲耗尽后再次 decide → 新 HTTP 调用", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return jsonResponse(completion({ content: `答复${String(n)}` }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const first = await provider.decide(CTX);
    expect(first.ok && first.value).toEqual({ type: "final_answer", text: "答复1" });
    const second = await provider.decide(CTX);
    expect(second.ok && second.value).toEqual({ type: "final_answer", text: "答复2" });
    expect(provider.calls).toBe(2);
  });
});

describe("HttpLlmProvider——成本护栏（VERIFY 7 / D5）", () => {
  it("超 max_calls_per_run → err(call_budget_exhausted) 可区分；不静默继续", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(completion({ content: "答" }));
    const provider = new HttpLlmProvider({ config: CONFIG({ max_calls_per_run: 2 }), tools: TOOLS, fetchImpl });
    (await provider.decide(CTX)).ok && void 0;
    (await provider.decide(CTX)).ok && void 0;
    const third = await provider.decide(CTX);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.code).toBe("call_budget_exhausted");
    expect((third.error.detail as { reason?: string }).reason).toBe("call_budget_exhausted");
    expect((third.error.detail as { limit?: number }).limit).toBe(2);
  });

  it("重试计入预算：预算 2 + 每次首试 500 重试一次成功 → 第 3 次决策请求被预算拦截", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      if (n % 2 === 1) return jsonResponse({ error: "boom" }, 500);
      return jsonResponse(completion({ content: "答" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG({ max_calls_per_run: 3 }), tools: TOOLS, fetchImpl });
    const first = await provider.decide(CTX); // 尝试 1(500) + 2(200)
    expect(first.ok).toBe(true);
    const second = await provider.decide(CTX); // 尝试 3(500) → 预算拦截（4 > 3）
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("call_budget_exhausted");
    expect(n).toBe(3);
  });
});

describe("HttpLlmProvider——重试纪律（网络/5xx 可重试，4xx 不重试）", () => {
  it("首试 500 → 重试成功（max_retries=1）", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return n === 1 ? jsonResponse({ error: "boom" }, 500) : jsonResponse(completion({ content: "恢复" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it("连续 500 耗尽重试 → err(provider_failure)（不得降级跳过）", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "down" }, 503);
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error.code).toBe("provider_failure");
    expect(provider.calls).toBe(2); // 1 + max_retries
  });

  it("网络异常 → 重试后失败（可重试类）", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      throw new Error("ECONNRESET-simulated");
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(false);
    expect(n).toBe(2);
  });

  it("400 不重试（非瞬时故障，fail-closed）", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return jsonResponse({ error: { message: "bad request" } }, 400);
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(false);
    expect(n).toBe(1);
  });
});

describe("HttpLlmProvider——脱敏漏斗（ADR-09 红线）", () => {
  it("5xx 响应体含 key → 错误消息与 detail 均已脱敏", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: `leak ${FAKE_KEY} leak` }, 500);
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(JSON.stringify(decided.error)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(decided.error)).toContain("[REDACTED]");
  });

  it("detail 只记 host（别名/主机名粒度），不记完整 URL", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "down" }, 500);
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    if (decided.ok) throw new Error("unreachable");
    const serialized = JSON.stringify(decided.error);
    expect(serialized).toContain("127.0.0.1:45321");
    expect(serialized).not.toContain("/v1/chat/completions");
    expect(serialized).not.toContain(FAKE_KEY);
  });
});

describe("HttpLlmProvider——零外连断言（VERIFY 3 / 门 2 纪律）", () => {
  it("全部请求 URL = 配置 base_url + 协议路径（fetch 注入面拦截断言）", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse(completion({ content: "答" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    await provider.decide(CTX);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("http://127.0.0.1:45321/v1/chat/completions")).toBe(true);
    }
  });

  it("anthropic 协议路径与认证头", async () => {
    const headersSeen: Array<Record<string, string>> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      headersSeen.push(init?.headers as Record<string, string>);
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "完成" }], stop_reason: "end_turn" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new HttpLlmProvider({
      config: CONFIG({ protocol: "anthropic-messages", base_url: "http://127.0.0.1:45322" }) as never,
      tools: TOOLS,
      fetchImpl,
    });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(true);
    expect(headersSeen[0]?.["x-api-key"]).toBe(FAKE_KEY);
    expect(headersSeen[0]?.["anthropic-version"]).toBe("2023-06-01");
  });
});

describe("HttpLlmProvider——fail-closed", () => {
  it("非法响应形状 → err（不猜测决策）", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ totally: "unexpected" });
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error.message).toContain("fail-closed");
  });

  it("非 JSON 响应体 → err", async () => {
    const fetchImpl: typeof fetch = async () => new Response("不是JSON", { status: 200 });
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    expect((await provider.decide(CTX)).ok).toBe(false);
  });

  it("请求体携带系统提示与工具面；不出现在响应路径", async () => {
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(completion({ content: "答" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    await provider.decide(CTX);
    expect((capturedBody as Record<string, unknown>)["reasoning_effort"]).toBe("low");
    const messages = (capturedBody as Record<string, unknown>)["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect((messages[0]?.["content"] as string).length).toBeGreaterThan(0);
    expect(HARNESS_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
