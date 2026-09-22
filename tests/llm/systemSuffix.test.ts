/**
 * 批 3 §二：技能清单常驻（systemSuffix）——Pi lazy skills 注入面。
 * 判据：suffix 追加于系统提示之后（模型可见）；缺省不注入＝系统提示逐字节不变。
 */
import { describe, expect, it } from "vitest";
import { HARNESS_SYSTEM_PROMPT, HttpLlmProvider } from "../../src/llm/index.js";
import { skillsSuffixText } from "../../src/core/workspace/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const CONFIG = (() => ({
  provider_id: "fake-provider",
  protocol: "openai-chat",
  base_url: "http://127.0.0.1:45331",
  api_key: "fake-key",
  model: "fake-model",
  reasoning: false,
  reasoning_effort: "low",
  max_tokens: 4096,
  context_window: null,
  compat: { supports_developer_role: false, supports_reasoning_effort: true },
  timeout_ms: 5_000,
  max_retries: 1,
  max_calls_per_run: 50,
}) ) as () => never;

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];
const CTX: readonly LlmContextEvent[] = [
  { id: 1, ts: "2026-09-22T00:00:00Z", type: "user/message", payload: { text: "任务" } },
] as never;

const captureBody = async (options: ConstructorParameters<typeof HttpLlmProvider>[0]): Promise<Record<string, unknown>> => {
  let body: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = new HttpLlmProvider({ ...options, fetchImpl });
  await provider.decide(CTX);
  return body;
};

describe("批 3 §二：systemSuffix 技能常驻清单", () => {
  it("suffix 追加在系统提示之后（openai-chat：messages[0].role=system）；无 suffix＝逐字节不变", async () => {
    const suffix = skillsSuffixText([
      { name: "atf-run-training", description: "启动编排", dir: "/skills/atf-run-training" },
    ]);
    const withSuffix = await captureBody({ config: CONFIG(), tools: TOOLS, systemSuffix: suffix });
    const withMessages = withSuffix["messages"] as Array<{ role: string; content: string }>;
    expect(withMessages[0]?.role).toBe("system");
    expect(withMessages[0]?.content).toBe(`${HARNESS_SYSTEM_PROMPT}\n${suffix}`);
    expect(withMessages[0]?.content).toContain("- atf-run-training — 启动编排");

    const without = await captureBody({ config: CONFIG(), tools: TOOLS });
    const withoutMessages = without["messages"] as Array<{ role: string; content: string }>;
    expect(withoutMessages[0]?.content).toBe(HARNESS_SYSTEM_PROMPT);
  });
});
