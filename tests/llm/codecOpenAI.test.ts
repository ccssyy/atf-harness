/**
 * L1a 门 2 VERIFY 2——openai-chat codec fixture 级测试（任务书 §3.2）。
 * 请求构造 / 响应解析 / 工具调用与结果回填形状 / reasoning 参数显式携带 / 非法响应 fail-closed。
 * 全部 fixture 构造（不依赖网络）。
 */
import { describe, expect, it } from "vitest";
import { openaiChatCodec } from "../../src/llm/index.js";
import type { AdapterMessage, ModelResponse } from "../../src/llm/index.js";
import type { ModelVisibleTool } from "../../src/tools/index.js";

const TOOLS: ModelVisibleTool[] = [
  { name: "atf_fact_scan", description: "事实索引枚举", parameters: { type: "object", required: [], properties: {} } },
];

const msg = (partial: AdapterMessage): AdapterMessage => partial;

describe("openai-chat——请求构造", () => {
  it("system 首条 + tools function 形态 + reasoning_effort 显式携带（任务书 §1.2）", () => {
    const body = openaiChatCodec.encodeRequestBody({
      model: "fake-model",
      system: "SYS",
      messages: [msg({ role: "user", text: "任务", source_event_id: 1 })],
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    }) as Record<string, unknown>;
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(messages[1]).toEqual({ role: "user", content: "任务" });
    expect(body["model"]).toBe("fake-model");
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["tool_choice"]).toBe("auto");
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({
      type: "function",
      function: { name: "atf_fact_scan", description: "事实索引枚举", parameters: { type: "object", required: [], properties: {} } },
    });
  });

  it("修订 v2 规则 4——reasoningEffort=null（compat 抑制）→ 请求体整体省略该字段", () => {
    const body = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: [msg({ role: "user", text: "任务", source_event_id: 1 })],
      tools: TOOLS,
      reasoningEffort: null,
      developerRole: false,
      maxTokens: 4096,
    }) as Record<string, unknown>;
    expect("reasoning_effort" in body).toBe(false);
  });

  it("修订 v2 规则 4——developerRole=true → 首条指令消息 role:developer；false → system（缺省不变）", () => {
    const mk = (developerRole: boolean) =>
      openaiChatCodec.encodeRequestBody({
        model: "m",
        system: "S",
        messages: [msg({ role: "user", text: "任务", source_event_id: 1 })],
        tools: TOOLS,
        reasoningEffort: "low",
        developerRole,
        maxTokens: 4096,
      }) as Record<string, unknown>;
    expect((mk(true)["messages"] as Array<Record<string, unknown>>)[0]?.["role"]).toBe("developer");
    expect((mk(false)["messages"] as Array<Record<string, unknown>>)[0]?.["role"]).toBe("system");
  });

  it("认证头 = Authorization Bearer（key 唯一出现处）", () => {
    const headers = openaiChatCodec.authHeaders("fake-key-x");
    expect(headers["Authorization"]).toBe("Bearer fake-key-x");
  });

  it("assistant_tool_call → tool_calls（arguments 为 JSON 字符串）；tool_result → role:tool 配对", () => {
    const body = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: [
        msg({ role: "user", text: "任务", source_event_id: 1 }),
        msg({ role: "assistant_tool_call", tool: "atf_fact_scan", params: { a: 1 }, source_event_id: 7 }),
        msg({ role: "tool_result", tool: "atf_fact_scan", ok: true, summary: "2 facts", source_event_id: 8 }),
      ],
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    }) as Record<string, unknown>;
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const assistant = messages[2] as { role: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls[0]?.id).toBe("call_7");
    expect(assistant.tool_calls[0]?.function.name).toBe("atf_fact_scan");
    expect(JSON.parse(assistant.tool_calls[0]?.function.arguments as string)).toEqual({ a: 1 });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_7", content: "2 facts" });
  });

  it("approval 往返缓冲：随配对 tool_result 之后以 user 附言回填（线缆次序）", () => {
    const body = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: [
        msg({ role: "user", text: "任务", source_event_id: 1 }),
        msg({ role: "assistant_tool_call", tool: "atf_admit_data", params: {}, source_event_id: 7 }),
        msg({ role: "approval", phase: "request", summary: "req", source_event_id: 8 }),
        msg({ role: "approval", phase: "response", summary: "denied", source_event_id: 9 }),
        msg({ role: "tool_result", tool: "atf_admit_data", ok: false, summary: "审批被拒", source_event_id: 10 }),
      ],
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    }) as Record<string, unknown>;
    const messages = body["messages"] as Array<Record<string, unknown>>;
    // 次序：assistant(tool_calls) → tool(结果) → user(审批附言)
    expect((messages[2] as { role: string }).role).toBe("assistant");
    expect((messages[3] as { role: string }).role).toBe("tool");
    const annotation = messages[4] as { role: string; content: string };
    expect(annotation.role).toBe("user");
    expect(annotation.content).toContain("[审批往返]");
    expect(annotation.content).toContain("req");
    expect(annotation.content).toContain("denied");
  });

  it("挂起尾悬空工具调用：以审批摘要合成 role:tool 结果（线缆形状要求）", () => {
    const body = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: [
        msg({ role: "user", text: "任务", source_event_id: 1 }),
        msg({ role: "assistant_tool_call", tool: "atf_admit_data", params: {}, source_event_id: 7 }),
        msg({ role: "approval", phase: "request", summary: "req#1", source_event_id: 8 }),
      ],
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    }) as Record<string, unknown>;
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const synth = messages[3] as { role: string; tool_call_id: string; content: string };
    expect(synth.role).toBe("tool");
    expect(synth.tool_call_id).toBe("call_7");
    expect(synth.content).toContain("req#1");
    expect(synth.content).toContain("未执行");
  });

  it("tool_result 无配对 / 工具名不一致 → 整体拒绝（fail-closed，不产残缺请求）", () => {
    const input = {
      model: "m",
      system: "S",
      messages: [msg({ role: "tool_result", tool: "atf_fact_scan", ok: true, summary: "x", source_event_id: 3 })] as AdapterMessage[],
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    };
    const body = openaiChatCodec.encodeRequestBody(input) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("wire_shape_invalid");
  });
});

describe("openai-chat——响应解析", () => {
  it("tool_calls：arguments JSON 串 → params 对象；content 并存 → message", () => {
    const parsed = openaiChatCodec.parseResponse({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "查询中",
            tool_calls: [{ id: "c1", type: "function", function: { name: "atf_fact_scan", arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ message: "查询中", tool_calls: [{ tool: "atf_fact_scan", params: { a: 1 } }] });
  });

  it("仅 content → final_answer（loop 收敛语义；登记于 codec 契约）", () => {
    const parsed = openaiChatCodec.parseResponse({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "任务完成" } }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ final_answer: "任务完成" });
  });

  const INVALID: Array<[string, unknown]> = [
    ["choices 缺失", {}],
    ["choices 空", { choices: [] }],
    ["message 缺失", { choices: [{ index: 0 }] }],
    ["content 非字符串", { choices: [{ message: { content: 3 } }] }],
    ["tool_calls 空数组", { choices: [{ message: { content: null, tool_calls: [] } }] }],
    ["tool_calls.name 缺失", { choices: [{ message: { content: null, tool_calls: [{ function: { arguments: "{}" } }] } }] }],
    ["arguments 非法 JSON", { choices: [{ message: { content: null, tool_calls: [{ function: { name: "t", arguments: "{bad" } }] } }] }],
    ["arguments 解析非对象", { choices: [{ message: { content: null, tool_calls: [{ function: { name: "t", arguments: "[1]" } }] } }] }],
    ["finish_reason=length 截断", { choices: [{ finish_reason: "length", message: { content: "半截" } }] }],
    ["无 tool_calls 且无 content", { choices: [{ finish_reason: "stop", message: { content: null } }] }],
  ];
  for (const [name, body] of INVALID) {
    it(`非法响应 fail-closed：${name}`, () => {
      const parsed = openaiChatCodec.parseResponse(body);
      expect(parsed.ok).toBe(false);
    });
  }
});

describe("openai-chat——回放编码往返（假端点用）", () => {
  it("encodeWireResponse → parseResponse 保形（canonical ↔ wire 双向）", () => {
    const responses: ModelResponse[] = [
      { tool_calls: [{ tool: "atf_fact_scan", params: {} }] },
      { message: "查询中", tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "d" } }] },
      { final_answer: "完成" },
    ];
    for (const response of responses) {
      const wire = openaiChatCodec.encodeWireResponse(response, "fake-model");
      const parsed = openaiChatCodec.parseResponse(wire);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(response);
    }
  });
});
