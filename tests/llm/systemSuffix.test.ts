/**
 * 批 3 §二：技能清单常驻（systemSuffix）——Pi lazy skills 注入面。
 * 判据：suffix 追加于系统提示之后（模型可见）；缺省不注入＝系统提示逐字节不变。
 * 批甲-BUILD T4：断言载体由 HttpLlmProvider（openai-chat wire，已删）切 PiAiLlmProvider
 * onPayload 观察缝（pi-ai 即唯一装配路径；断言语义逐条不变）。
 */
import { describe, expect, it } from "vitest";
import { HARNESS_SYSTEM_PROMPT, PiAiLlmProvider } from "../../src/llm/index.js";
import { skillsSuffixText } from "../../src/core/workspace/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const CONFIG = (() => ({
  provider_id: "deepseek",
  protocol: "pi-ai",
  base_url: "http://127.0.0.1:45331",
  api_key: "fake-key",
  model: "deepseek-flash",
  reasoning: false,
  reasoning_effort: "low",
  max_tokens: 4096,
  context_window: null,
  compat: { supports_developer_role: false, supports_reasoning_effort: true },
  timeout_ms: 5_000,
  max_retries: 1,
  max_calls_per_run: 50,
})) as () => never;

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];
const CTX: readonly LlmContextEvent[] = [
  { id: 1, ts: "2026-09-22T00:00:00Z", type: "user/message", payload: { text: "任务" } },
] as never;

const sseReply = (): string =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
  "data: [DONE]\n\n";

const captureBody = async (options: { systemSuffix?: string }): Promise<Record<string, unknown>> => {
  const payloads: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = async () => new Response(sseReply(), { status: 200, headers: { "content-type": "text/event-stream" } });
  const provider = new PiAiLlmProvider({
    config: CONFIG(),
    tools: TOOLS,
    fetchImpl,
    onPayload: (payload) => {
      payloads.push(payload as Record<string, unknown>);
    },
    ...(options.systemSuffix !== undefined ? { systemSuffix: options.systemSuffix } : {}),
  });
  const decided = await provider.decide(CTX);
  expect(decided.ok).toBe(true);
  return payloads[0] as Record<string, unknown>;
};

describe("批 3 §二：systemSuffix 技能常驻清单", () => {
  it("suffix 追加在系统提示之后（messages[0].role=system）；无 suffix＝逐字节不变", async () => {
    const suffix = skillsSuffixText([
      { name: "atf-run-training", description: "启动编排", dir: "/skills/atf-run-training" },
    ]);
    const withSuffix = await captureBody({ systemSuffix: suffix });
    const withMessages = withSuffix["messages"] as Array<{ role: string; content: string }>;
    expect(withMessages[0]?.role).toBe("system");
    expect(withMessages[0]?.content).toBe(`${HARNESS_SYSTEM_PROMPT}\n${suffix}`);
    expect(withMessages[0]?.content).toContain("- atf-run-training — 启动编排");

    const without = await captureBody({});
    const withoutMessages = without["messages"] as Array<{ role: string; content: string }>;
    expect(withoutMessages[0]?.content).toBe(HARNESS_SYSTEM_PROMPT);
  });
});
