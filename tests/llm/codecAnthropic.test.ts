/**
 * L1a 门 2 VERIFY 2——anthropic-messages codec fixture 级测试（任务书 §3.2）。
 * 请求构造（顶层 system / input_schema / tool_use input 对象 / tool_result user 回填 /
 * max_tokens 必填）/ 响应解析（stop_reason 语义）/ 非法响应 fail-closed。全 fixture 构造。
 */
import { describe, expect, it } from "vitest";
import { anthropicMessagesCodec, ANTHROPIC_VERSION } from "../../src/llm/index.js";
import type { AdapterMessage, ModelResponse } from "../../src/llm/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const TOOLS: ModelVisibleTool[] = [
  { name: "atf_workspace_status", description: "工作区状态", parameters: { type: "object", required: [], properties: {} } },
];

const msg = (partial: AdapterMessage): AdapterMessage => partial;

const encode = (messages: AdapterMessage[]) => {
  const encoded = anthropicMessagesCodec.encodeRequestBody({
    model: "fake-model",
    system: "SYS",
    messages,
    tools: TOOLS,
    reasoningEffort: "low",
    developerRole: false,
    maxTokens: 8192,
  });
  expect(encoded.ok, encoded.ok ? "" : encoded.error.message).toBe(true);
  if (!encoded.ok) throw new Error("unreachable");
  return encoded.value as Record<string, unknown>;
}

describe("anthropic-messages——请求构造", () => {
  it("顶层 system + max_tokens（线缆必填）+ tools input_schema 形态", () => {
    const body = encode([msg({ role: "user", text: "任务", source_event_id: 1 })]);
    expect(body["system"]).toBe("SYS");
    expect(body["max_tokens"]).toBe(8192);
    expect(body["model"]).toBe("fake-model");
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({
      name: "atf_workspace_status",
      description: "工作区状态",
      input_schema: { type: "object", required: [], properties: {} },
    });
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "任务" }] }]);
  });

  it("认证头 = x-api-key + anthropic-version（key 唯一出现处）", () => {
    const headers = anthropicMessagesCodec.authHeaders("fake-key-a");
    expect(headers["x-api-key"]).toBe("fake-key-a");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
  });

  it("assistant_tool_call → tool_use（input 为对象）；tool_result → user 消息内 tool_result 回填", () => {
    const body = encode([
      msg({ role: "user", text: "任务", source_event_id: 1 }),
      msg({ role: "assistant_tool_call", tool: "atf_workspace_status", params: { a: 1 }, source_event_id: 7 }),
      msg({ role: "tool_result", tool: "atf_workspace_status", ok: false, summary: "失败原因", source_event_id: 8 }),
    ]);
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_7", name: "atf_workspace_status", input: { a: 1 } }],
    });
    // 协议要求角色交替：tool_result 并入 user 消息，is_error 回填
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_7", content: "失败原因", is_error: true }],
    });
  });

  it("approval 往返合并进配对 tool_result 的同一条 user 消息（附言后置）", () => {
    const body = encode([
      msg({ role: "assistant_tool_call", tool: "atf_admit_data", params: {}, source_event_id: 7 }),
      msg({ role: "approval", phase: "request", summary: "req", source_event_id: 8 }),
      msg({ role: "approval", phase: "response", summary: "advised", source_event_id: 9 }),
      msg({ role: "tool_result", tool: "atf_admit_data", ok: false, summary: "意见回填", source_event_id: 10 }),
    ]);
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("user");
    const blocks = messages[1]?.content ?? [];
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_7" });
    expect(blocks[1]).toMatchObject({ type: "text" });
    expect(String(blocks[1]?.["text"])).toContain("advised");
  });

  it("挂起尾悬空工具调用：合成 tool_result 块（审批摘要内容）", () => {
    const body = encode([
      msg({ role: "assistant_tool_call", tool: "atf_admit_data", params: {}, source_event_id: 7 }),
      msg({ role: "approval", phase: "request", summary: "req#1", source_event_id: 8 }),
    ]);
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const blocks = messages[1]?.content ?? [];
    expect(blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_7" });
    expect(String(blocks[0]?.["content"])).toContain("req#1");
  });
});

describe("anthropic-messages——响应解析", () => {
  it("tool_use 块 → tool_calls（input 即 params）；text 块并存 → message", () => {
    const parsed = anthropicMessagesCodec.parseResponse({
      content: [
        { type: "text", text: "查询中" },
        { type: "tool_use", id: "toolu_1", name: "atf_workspace_status", input: {} },
      ],
      stop_reason: "tool_use",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ message: "查询中", tool_calls: [{ tool: "atf_workspace_status", params: {} }] });
  });

  it("修订 v2 规则 5——thinking/redacted_thinking 思考块剥离（不进决策解析）；其余未知类型仍 fail-closed", () => {
    const stripped = anthropicMessagesCodec.parseResponse({
      content: [
        { type: "thinking", thinking: "推理过程…" },
        { type: "text", text: "结论" },
        { type: "redacted_thinking", data: "xxx" },
      ],
      stop_reason: "end_turn",
    });
    expect(stripped.ok).toBe(true);
    if (stripped.ok) expect(stripped.value).toEqual({ final_answer: "结论" });
    const unknown = anthropicMessagesCodec.parseResponse({
      content: [{ type: "mystery_block", x: 1 }],
      stop_reason: "end_turn",
    });
    expect(unknown.ok).toBe(false);
  });

  it('仅 text + stop_reason=end_turn → final_answer', () => {
    const parsed = anthropicMessagesCodec.parseResponse({
      content: [{ type: "text", text: "完成" }],
      stop_reason: "end_turn",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ final_answer: "完成" });
  });

  it('仅 text + stop_reason=max_tokens → fail-closed（截断非完整语义）', () => {
    const parsed = anthropicMessagesCodec.parseResponse({
      content: [{ type: "text", text: "半截" }],
      stop_reason: "max_tokens",
    });
    expect(parsed.ok).toBe(false);
  });

  const INVALID: Array<[string, unknown]> = [
    ["content 缺失", {}],
    ["content 空", { content: [] }],
    ["未知块类型", { content: [{ type: "thinking", thinking: "x" }], stop_reason: "end_turn" }],
    ["text 非字符串", { content: [{ type: "text", text: 5 }], stop_reason: "end_turn" }],
    ["tool_use.name 缺失", { content: [{ type: "tool_use", id: "t", input: {} }], stop_reason: "tool_use" }],
    ["tool_use.input 缺失（截断形态）", { content: [{ type: "tool_use", id: "t", name: "n" }], stop_reason: "tool_use" }],
    ["input 非对象", { content: [{ type: "tool_use", id: "t", name: "n", input: [1] }], stop_reason: "tool_use" }],
    ["无 text 无 tool_use", { content: [{ type: "text", text: "" }], stop_reason: "end_turn" }],
  ];
  for (const [name, body] of INVALID) {
    it(`非法响应 fail-closed：${name}`, () => {
      expect(anthropicMessagesCodec.parseResponse(body).ok).toBe(false);
    });
  }
});

describe("anthropic-messages——回放编码往返（假端点用）", () => {
  it("encodeWireResponse → parseResponse 保形", () => {
    const responses: ModelResponse[] = [
      { tool_calls: [{ tool: "atf_workspace_status", params: {} }] },
      { message: "查询中", tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "d" } }] },
      { final_answer: "完成" },
    ];
    for (const response of responses) {
      const wire = anthropicMessagesCodec.encodeWireResponse(response, "fake-model");
      const parsed = anthropicMessagesCodec.parseResponse(wire);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(response);
    }
  });
});
