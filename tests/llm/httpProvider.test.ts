/**
 * L1a 门 2——HTTP provider 单元级测试（任务书 §1.1/§1.2/§3.3/§3.7）。
 * 决策缓冲 / 成本护栏（可区分原因）/ 重试（网络/5xx）/ 不重试（4xx）/ 脱敏漏斗 /
 * 零外连断言（fetch 注入面：全部请求命中回环 base_url）。fetchImpl 全注入（零真实网络）。
 */
import { describe, expect, it } from "vitest";
import { HttpLlmProvider, HARNESS_SYSTEM_PROMPT } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const FAKE_KEY = "fake-provider-test-key-DO-NOT-USE";

/** 修订 v2 解析形态（选中 provider+model；与 loadLlmProviderConfig 产物同构）。 */
const CONFIG = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    provider_id: "fake-provider",
    protocol: "openai-chat",
    base_url: "http://127.0.0.1:45321",
    api_key: FAKE_KEY,
    model: "fake-model-provider",
    reasoning: false,
    reasoning_effort: "low",
    max_tokens: 4096,
    context_window: null,
    compat: { supports_developer_role: false, supports_reasoning_effort: true },
    timeout_ms: 5_000,
    max_retries: 1,
    max_calls_per_run: 50,
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

  it("VERIFY 4——compat 抑制：supports_reasoning_effort=false → 请求体不含 reasoning_effort", async () => {
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(completion({ content: "答" }));
    };
    const provider = new HttpLlmProvider({
      config: CONFIG({ compat: { supports_developer_role: false, supports_reasoning_effort: false } }) as never,
      tools: TOOLS,
      fetchImpl,
    });
    expect((await provider.decide(CTX)).ok).toBe(true);
    expect(capturedBody as Record<string, unknown>).not.toBeNull();
    expect((capturedBody as Record<string, unknown>)["reasoning_effort"]).toBeUndefined();
  });

  it("VERIFY 4——compat 缺省（协议标准）：请求体显式携带 reasoning_effort", async () => {
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(completion({ content: "答" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    await provider.decide(CTX);
    expect((capturedBody as Record<string, unknown>)["reasoning_effort"]).toBe("low");
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

  // 走查修复批 B5（2026-09-23，指令 7158bf43）投影三同步之三：http 投影用例——
  // advised 意见正文经真实 provider 出站路径可见（wire 层 tool 消息 content 含意见全文）。
  it("advised 回流出站投影：wire 层 tool 消息 content 含意见正文（B5 修复可见性断言）", async () => {
    const ADVICE = "operator 意见：改走技能面 publish 链，产出契约包后再 advance 闸门。";
    const advisedCtx = [
      ...CTX,
      { id: 2, ts: "t", type: "tool/call", payload: { tool: "atf_scratch_exec", params: { argv: ["python3", "p.py"] } } },
      {
        id: 3, ts: "t", type: "tool/result",
        payload: {
          tool: "atf_scratch_exec", ok: false, reason: "approval_advised", call_ref: 2,
          block: {
            reason: "approval_advised", message: `问答轨修改意见(重新提案):${ADVICE}`, tool: "atf_scratch_exec", exit_code: 1,
            detail: { approval_session_id: "aps-1", request_event_ref: 2, advice_text: ADVICE },
          },
        },
      },
    ] as never;
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse(completion({ content: "收到意见" }));
    };
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await provider.decide(advisedCtx);
    expect(decided.ok).toBe(true);
    const serialized = JSON.stringify(capturedBody);
    expect(serialized).toContain("approval_advised");
    expect(serialized).toContain(ADVICE); // 意见正文全文出站（非截断残段）
  });
});

// ---------------------------------------------------------------------------
// L1c 提前批 C（2026-09-22）：provider quota/用量上限错误映射
// （429 ／ body 配额类标记 → provider_quota_or_rate_limited＋人读一行；不重试——
//   无退避机制，重试计入预算只白烧；runner provider_failure 收口径自然携带人读行。）
// ---------------------------------------------------------------------------
describe("L1c 提前批 C：provider quota/用量上限错误映射", () => {
  it("HTTP 429 → provider_quota_or_rate_limited＋人读提示；不重试（调用计数=1）", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return jsonResponse({ error: { code: "rate_limit", message: "rate limit reached" } }, 429);
    };
    const provider = new HttpLlmProvider({ config: CONFIG({ max_retries: 3 }), tools: TOOLS, fetchImpl });
    const result = await provider.decide(CTX);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("provider_quota_or_rate_limited");
    expect(result.error.message).toContain("用量已达上限");
    expect(result.error.message).toContain("输入新指令即可继续");
    expect(attempts).toBe(1);
    expect(provider.calls).toBe(1);
  });

  it("403＋body insufficient_quota（配额/欠费类）→ 同码同提示；非 429 也命中 body 标记", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts += 1;
      return jsonResponse({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }, 403);
    };
    const provider = new HttpLlmProvider({ config: CONFIG({ max_retries: 3 }), tools: TOOLS, fetchImpl });
    const result = await provider.decide(CTX);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("provider_quota_or_rate_limited");
    expect(result.error.message).toContain("用量已达上限");
    expect(attempts).toBe(1);
  });

  it("对照：非配额 4xx（401）维持既有通用文案与 provider_failure 码（零行为漂移）", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: "bad key" } }, 401);
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const result = await provider.decide(CTX);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("provider_failure");
    expect(result.error.message).toContain("不重试");
    expect(result.error.message).not.toContain("用量已达上限");
  });
});
