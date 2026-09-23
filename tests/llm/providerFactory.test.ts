/**
 * 微补丁（2026-09-23，走查 run-full-v0762 首启发现）——装配工厂分发断言。
 * TUI/ACP 缺省路径补切 createLlmProviderFromConfig 后，pi-ai 配置必须产出
 * PiAiLlmProvider（此前直 new HttpLlmProvider 即拒收——本测试锁分发单点行为）。
 */
import { describe, expect, it } from "vitest";
import { createLlmProviderFromConfig, HttpLlmProvider, PiAiLlmProvider, type LlmProvider } from "../../src/llm/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];

const CONFIG = (protocol: string) =>
  ({
    provider_id: "deepseek",
    protocol,
    base_url: "http://127.0.0.1:45337",
    api_key: "k",
    model: "deepseek-flash",
    reasoning: true,
    reasoning_effort: "max",
    max_tokens: 393216,
    context_window: null,
    compat: { supports_developer_role: false, supports_reasoning_effort: true },
    timeout_ms: 5000,
    max_retries: 1,
    max_calls_per_run: 50,
  }) as never;

describe("createLlmProviderFromConfig——装配分发单点", () => {
  it('protocol="pi-ai" → PiAiLlmProvider（TUI/ACP 缺省路径同证）', () => {
    const provider: LlmProvider = createLlmProviderFromConfig({ config: CONFIG("pi-ai"), tools: TOOLS });
    expect(provider).toBeInstanceOf(PiAiLlmProvider);
    expect(provider.providerId).toBe("deepseek");
  });

  it('protocol="openai-chat" → HttpLlmProvider（旧路径缺省行为不变）', () => {
    const provider: LlmProvider = createLlmProviderFromConfig({ config: CONFIG("openai-chat"), tools: TOOLS });
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });

  it('protocol="anthropic-messages" → HttpLlmProvider（旧路径缺省行为不变）', () => {
    const provider: LlmProvider = createLlmProviderFromConfig({ config: CONFIG("anthropic-messages"), tools: TOOLS });
    expect(provider).toBeInstanceOf(HttpLlmProvider);
  });
});
