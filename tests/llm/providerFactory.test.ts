/**
 * 微补丁（2026-09-23，走查 run-full-v0762 首启发现）——装配工厂分发断言。
 * TUI/ACP 缺省路径补切 createLlmProviderFromConfig 后，pi-ai 配置必须产出
 * PiAiLlmProvider（此前直 new HttpLlmProvider 即拒收——本测试锁分发单点行为）。
 * 批甲-BUILD T4（2026-10-15）：旧自研 codec 路径删除——闭集外 protocol 到达工厂＝
 * 防御性 fail-closed throw（配置层已先行 protocol_unknown 拒绝）。
 */
import { describe, expect, it } from "vitest";
import { createLlmProviderFromConfig, PiAiLlmProvider, type LlmProvider } from "../../src/llm/index.js";
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

  it('protocol="openai-chat"（已下线）→ fail-closed throw 不猜', () => {
    expect(() => createLlmProviderFromConfig({ config: CONFIG("openai-chat"), tools: TOOLS })).toThrow(/已随旧自研 codec 路径下线/);
  });

  it('protocol="anthropic-messages"（已下线）→ fail-closed throw 不猜', () => {
    expect(() => createLlmProviderFromConfig({ config: CONFIG("anthropic-messages"), tools: TOOLS })).toThrow(/已随旧自研 codec 路径下线/);
  });
});
