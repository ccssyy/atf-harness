/**
 * 批 P 增补 §一（指令 56170242）——GLM 目录参数化 fixture：
 *   ① 工厂闭集：deepseek/zai-coding-cn 命中；未知 id fail-closed throw；
 *   ② compat 地板：zai-coding-cn thinkingFormat=zai——supports_reasoning_effort 地板
 *      false 不可被配置开启 → glm-5.3-flash 非推理路径零 effort 下发（wire 断言：
 *      payload 无 reasoning_effort 字段）；配置显式开 true 也被地板压制；
 *   ③ baseUrl 与用户配置一致（R4 配置保真——目录缺省被覆盖）；
 *   ④ DeepSeek 路径回归：effort 直传语义零改（地板不干预）。
 * 经 pi-ai onPayload 捕获出站请求体断言；fetchImpl 全注入＋本地回环 base_url——零真实调用。
 */
import { describe, expect, it } from "vitest";
import { PiAiLlmProvider } from "../../src/llm/index.js";
import { applyPiaiCompatFloor, piaiProviderFactory, PIAI_PROVIDER_COMPAT_FLOOR, PIAI_PROVIDER_IDS } from "../../src/llm/piaiProviders.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const FAKE_KEY = "fake-piai-test-key-DO-NOT-USE";

const CONFIG = (overrides: Record<string, unknown> = {}) =>
  ({
    provider_id: "zai-coding-cn",
    protocol: "pi-ai",
    base_url: "http://127.0.0.1:45328",
    api_key: FAKE_KEY,
    model: "glm-5.3-flash",
    reasoning: false,
    reasoning_effort: "low", // 故意给 low——证明地板压制（零 effort 下发）
    max_tokens: 131072,
    context_window: 1000000,
    compat: { supports_developer_role: false, supports_reasoning_effort: true }, // 配置显式开 true
    timeout_ms: 5_000,
    max_retries: 1,
    max_calls_per_run: 50,
    ...overrides,
  }) as never;

const TOOLS: ModelVisibleTool[] = [
  { name: "atf_fact_scan", description: "事实索引枚举", parameters: { type: "object", required: [], properties: {} } },
];

const userCtx = [
  { id: 1, ts: "2026-09-24T00:00:00Z", type: "user/message", payload: { text: "hi" } },
] as never;

const sse = (body: string): Response =>
  new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-glm-fixture",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "glm-5.3-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
const textStop = (text: string): Response => sse(`${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}`);

const harness = (config: Record<string, unknown>) => {
  const payloads: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return textStop("ok");
  };
  const provider = new PiAiLlmProvider({
    config: CONFIG(config) as never,
    tools: TOOLS,
    fetchImpl,
    onPayload: (payload) => {
      payloads.push(payload as Record<string, unknown>);
    },
  });
  return { payloads, urls, provider };
};

describe("批 P 增补 §一：GLM 目录参数化（两线同路径）", () => {
  it("① 工厂闭集：deepseek/zai-coding-cn 命中；未知 id fail-closed", () => {
    expect(PIAI_PROVIDER_IDS).toEqual(["deepseek", "zai-coding-cn"]);
    expect(piaiProviderFactory("deepseek").id).toBe("deepseek");
    expect(piaiProviderFactory("zai-coding-cn").id).toBe("zai-coding-cn");
    expect(() => piaiProviderFactory("openai")).toThrow(/fail-closed/);
  });

  it("② GLM 非推理路径零 effort 下发：配置显式开 supports_reasoning_effort=true 也被地板压制", async () => {
    const wire = harness({});
    const decided = await wire.provider.decide(userCtx);
    expect(decided.ok).toBe(true);
    expect(wire.payloads.length).toBeGreaterThan(0);
    const payload = wire.payloads[0] as Record<string, unknown>;
    expect(payload["model"]).toBe("glm-5.3-flash");
    expect(payload["reasoning_effort"]).toBeUndefined(); // 零 effort 下发（地板压制；配置 compat=true 无效）
  });

  it("③ compat 地板单元：zai-coding-cn false 恒胜出；deepseek 不干预", () => {
    expect(PIAI_PROVIDER_COMPAT_FLOOR["zai-coding-cn"]).toEqual({ supports_reasoning_effort: false });
    expect(applyPiaiCompatFloor("zai-coding-cn", { supports_developer_role: false, supports_reasoning_effort: true })).toEqual({
      supports_developer_role: false,
      supports_reasoning_effort: false,
    });
    expect(applyPiaiCompatFloor("zai-coding-cn", { supports_developer_role: false, supports_reasoning_effort: false })).toEqual({
      supports_developer_role: false,
      supports_reasoning_effort: false,
    });
    expect(applyPiaiCompatFloor("deepseek", { supports_developer_role: false, supports_reasoning_effort: true })).toEqual({
      supports_developer_role: false,
      supports_reasoning_effort: true,
    });
  });

  it("④ baseUrl 与用户配置一致（R4 配置保真）；GLM 目录 glm-5.3/5.3-flash/5.3-highspeed 内建", async () => {
    const wire = harness({});
    await wire.provider.decide(userCtx);
    expect(wire.urls[0]).toBe("http://127.0.0.1:45328/chat/completions");
    const { assembleProviderModel } = await import("../../src/agent/providerStreamFn.js");
    for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed"]) {
      const { model } = assembleProviderModel({ provider_id: "zai-coding-cn", model: id, base_url: "https://open.bigmodel.cn/api/coding/paas/v4", api_key: "" });
      expect(model.id).toBe(id);
      expect(model.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    }
  });

  it("⑤ DeepSeek 回归：effort 直传语义零改（地板不干预）", async () => {
    const wire = harness({ provider_id: "deepseek", model: "deepseek-flash", reasoning_effort: "max" });
    const decided = await wire.provider.decide(userCtx);
    expect(decided.ok).toBe(true);
    const payload = wire.payloads[0] as Record<string, unknown>;
    expect(payload["model"]).toBe("deepseek-flash");
    expect(payload["reasoning_effort"]).toBe("max");
  });
});
