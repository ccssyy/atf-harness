/**
 * 系统提示"训练流程编排者"重写小批（2026-09-23，指令 `640c2827`）——单源与内容断言。
 *
 * - 同源不漂移：HttpLlmProvider（openai-chat wire）与 PiAiLlmProvider（pi-ai wire，
 *   onPayload 捕获）两装配路径的出站系统提示**逐字节等于** systemPrompt.ts 单源常量——
 *   feature flag 切换前后模型看到的提示零漂移；
 * - 内容六要求抽检（指令 §2.1）：角色定位（编排代理＋K1 阶段闭集锚词）、管线纪律、
 *   阶段感知、自由聊天姿态、审批语义、长度 ≤1200 字；
 * - 治理内部字段负面断言（§2.2）：max_calls/账本/G 门 id/数据形态示例不得入提示词。
 */
import { describe, expect, it } from "vitest";
import { HARNESS_SYSTEM_PROMPT, HttpLlmProvider, PiAiLlmProvider } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];
const CTX: readonly LlmContextEvent[] = [
  { id: 1, ts: "t", type: "user/message", payload: { text: "hi" } },
] as never;

const HTTP_CONFIG = {
  provider_id: "fake", protocol: "openai-chat", base_url: "http://127.0.0.1:45333",
  api_key: "k", model: "m", reasoning: false, reasoning_effort: "low", max_tokens: 4096,
  context_window: null, compat: { supports_developer_role: false, supports_reasoning_effort: false },
  timeout_ms: 5000, max_retries: 1, max_calls_per_run: 50,
} as never;

const PIAI_CONFIG = {
  provider_id: "deepseek", protocol: "pi-ai", base_url: "http://127.0.0.1:45335",
  api_key: "k", model: "deepseek-flash", reasoning: true, reasoning_effort: "max",
  max_tokens: 393216, context_window: null,
  compat: { supports_developer_role: false, supports_reasoning_effort: true },
  timeout_ms: 5000, max_retries: 1, max_calls_per_run: 50,
} as never;

describe("系统提示单源（两 provider 同源不漂移）", () => {
  it("HttpLlmProvider 出站系统提示逐字节等于单源常量", async () => {
    let systemContent: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> };
      systemContent = body.messages[0]?.["content"];
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "好" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const provider = new HttpLlmProvider({ config: HTTP_CONFIG, tools: TOOLS, fetchImpl });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(true);
    expect(systemContent).toBe(HARNESS_SYSTEM_PROMPT);
  });

  it("PiAiLlmProvider 出站系统提示逐字节等于单源常量", async () => {
    const payloads: Record<string, unknown>[] = [];
    const sse =
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant", content: "好" }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n";
    const fetchImpl: typeof fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    const provider = new PiAiLlmProvider({
      config: PIAI_CONFIG,
      tools: TOOLS,
      fetchImpl,
      onPayload: (payload) => {
        payloads.push(payload as Record<string, unknown>);
      },
    });
    const decided = await provider.decide(CTX);
    expect(decided.ok).toBe(true);
    const messages = (payloads[0]?.["messages"] ?? []) as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe(HARNESS_SYSTEM_PROMPT);
  });
});

describe("系统提示内容要求（指令 §2.1 六条抽检＋§2.2 负面断言）", () => {
  it("角色定位与 K1 阶段闭集锚词在位（防误删）", () => {
    for (const keyword of ["编排代理", "data_pending", "iteration_closed", "K2", "准入", "切分", "训练", "评估", "真推理", "11 个阶段"]) {
      expect(HARNESS_SYSTEM_PROMPT.includes(keyword), `缺关键词: ${keyword}`).toBe(true);
    }
  });

  it("阶段感知/自由聊天/审批语义约定在位", () => {
    for (const keyword of ["先判断当前所处阶段", "禁止臆测", "翻译为管线动作序列", "不强制动作", "审批往返以消息形式", "依据意见调整", "指引行修正"]) {
      expect(HARNESS_SYSTEM_PROMPT.includes(keyword), `缺约定关键词: ${keyword}`).toBe(true);
    }
  });

  it("产品用户视角约定在位（走查修复批 D1，指令 7158bf43 原文措辞）——黑盒纪律防源码考古回归", () => {
    for (const keyword of ["产品用户", "工具面与技能面文档", "黑盒", "禁止阅读或推断其内部实现"]) {
      expect(HARNESS_SYSTEM_PROMPT.includes(keyword), `缺 D1 关键词: ${keyword}`).toBe(true);
    }
    // 措辞照指令原文（逐句整段在位，防改写漂移）
    expect(HARNESS_SYSTEM_PROMPT).toContain(
      "你以产品用户身份使用本系统：一切操作走工具面与技能面文档；内核与框架的源码实现对你是黑盒，禁止阅读或推断其内部实现。",
    );
  });

  it("长度纪律：≤1200 字（原提示 ≈400 的 3 倍上限）", () => {
    expect(HARNESS_SYSTEM_PROMPT.length).toBeLessThanOrEqual(1200);
    expect(HARNESS_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it("治理内部字段不入提示词（§2.2 负面断言）", () => {
    for (const forbidden of ["max_calls", "账本", "G1", "G5", "scope_ref", "approval_key"]) {
      expect(HARNESS_SYSTEM_PROMPT.includes(forbidden), `提示词含治理内部字段: ${forbidden}`).toBe(false);
    }
  });
});
