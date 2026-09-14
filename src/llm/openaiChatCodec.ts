/**
 * L1a 门 2——openai-chat codec（任务书 §1.2 / D6；默认协议）。
 *
 * 线缆形状（v1）：
 *   请求：POST {base}/v1/chat/completions，Authorization: Bearer <api_key>（key 唯一出现处）；
 *         body = { model, messages:[{role:"system"},…], tools:[{type:"function",function:{…}}],
 *                  tool_choice:"auto", reasoning_effort（**显式携带**——GPT-5.4 起 chat 面
 *                  reasoning:none 下工具调用不受支持，任务书 §1.2）}。
 *   消息映射：user → role:"user"；assistant → role:"assistant"；assistant_tool_call →
 *         role:"assistant" + tool_calls[]（arguments = JSON 字符串，id = call_<source_event_id>）；
 *         tool_result → role:"tool"（tool_call_id 配对）；approval → 缓冲，随配对 tool_result
 *         之后作为一条 user 附言；悬空工具调用（挂起尾）以审批摘要合成 role:"tool" 结果。
 *   响应解析：choices[0].message.content → message；tool_calls[]（arguments JSON.parse → params）
 *         → tool_calls；**仅 content 无 tool_calls → final_answer**（loop 收敛语义：
 *         纯文本答复即收束，防止"再问一次同答"空转；登记于设计文档 codec 契约）。
 * 只做形状转换：无业务判断；形状非法 → err（fail-closed）。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { type AdapterMessage, type ModelResponse } from "./adapter.js";
import {
  approvalAnnotationText,
  approvalSummaryLine,
  codecError,
  danglingToolResultContent,
  PROTOCOL_REQUEST_PATHS,
  wireToolCallId,
  type CodecError,
  type CodecRequestInput,
  type ProtocolCodec,
  type WireToolCallRef,
} from "./codecWire.js";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 单条 canonical 消息 → wire 消息（walk 副作用：pending/annotations 维护）。 */
const encodeMessage = (
  message: AdapterMessage,
  state: { pending: WireToolCallRef[]; annotations: string[] },
  out: Record<string, unknown>[],
): Result<null, CodecError> => {
  switch (message.role) {
    case "user": {
      flushDangling(state, out);
      out.push({ role: "user", content: message.text });
      return ok(null);
    }
    case "assistant": {
      flushDangling(state, out);
      out.push({ role: "assistant", content: message.text });
      return ok(null);
    }
    case "assistant_tool_call": {
      flushDangling(state, out);
      const id = wireToolCallId(message.source_event_id);
      out.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: { name: message.tool, arguments: JSON.stringify(message.params) },
          },
        ],
      });
      state.pending.push({ id, tool: message.tool });
      return ok(null);
    }
    case "tool_result": {
      const paired = state.pending[0];
      if (paired === undefined) {
        return err(codecError("wire_shape_invalid", `tool_result 无配对的 assistant_tool_call（tool=${message.tool}，source_event_id=${String(message.source_event_id)}）`));
      }
      if (paired.tool !== message.tool) {
        return err(codecError("wire_shape_invalid", `tool_result 与配对工具调用不一致（期望 ${paired.tool}，实得 ${message.tool}）`));
      }
      state.pending.shift();
      out.push({ role: "tool", tool_call_id: paired.id, content: message.summary });
      flushAnnotations(state, out);
      return ok(null);
    }
    case "approval": {
      // 线缆次序要求：tool_call 与 tool_result 之间不得插入 user——缓冲后随结果回填
      state.annotations.push(approvalSummaryLine(message));
      return ok(null);
    }
  }
};

/** 悬空工具调用收尾：合成 role:"tool" 结果（形状要求；内容 = 审批事实摘要，非放行）。 */
const flushDangling = (state: { pending: WireToolCallRef[]; annotations: string[] }, out: Record<string, unknown>[]): void => {
  if (state.pending.length === 0) return;
  const calls = state.pending.splice(0, state.pending.length);
  const annotations = state.annotations.splice(0, state.annotations.length);
  for (const call of calls) {
    out.push({ role: "tool", tool_call_id: call.id, content: danglingToolResultContent(annotations) });
  }
  flushAnnotations(state, out);
};

/** 审批附言回填（缓冲非空时，作为一条 user 消息）。 */
const flushAnnotations = (state: { pending: WireToolCallRef[]; annotations: string[] }, out: Record<string, unknown>[]): void => {
  if (state.annotations.length === 0) return;
  const lines = state.annotations.splice(0, state.annotations.length);
  out.push({ role: "user", content: approvalAnnotationText(lines) });
};

/** 相邻 assistant 合并（thinking 回传适配的线缆形状前提）：内容型 assistant 紧随 tool_calls 型
 *  assistant 时（同一模型轮次经 A3 展开为两条决策的线缆投影），把文本并入 tool_calls 消息的
 *  content——OpenAI 规范形态（content+tool_calls 同体），协议等价；仅线缆投影，canonical 不变。
 *  注意：历史重建的 assistant 消息可能带显式 tool_calls:null，按"无 tool_calls"处理。 */
const mergeAdjacentAssistantText = (wire: Record<string, unknown>[]): void => {
  for (let i = wire.length - 2; i >= 0; i -= 1) {
    const current = wire[i];
    const next = wire[i + 1];
    if (
      current === undefined ||
      next === undefined ||
      current["role"] !== "assistant" ||
      next["role"] !== "assistant" ||
      current["tool_calls"] != null ||
      next["tool_calls"] == null ||
      typeof current["content"] !== "string" ||
      current["content"] === ""
    ) {
      continue;
    }
    const merged = next as { content?: unknown };
    merged["content"] = typeof merged["content"] === "string" && merged["content"] !== ""
      ? `${current["content"] as string}\n${merged["content"]}`
      : current["content"];
    wire.splice(i, 1);
  }
};

/** thinking 回传占位（恢复场景历史思考未留存时的中性占位；登记于复跑报告已知边界）。 */
export const THINKING_PLACEHOLDER = "（该历史轮次的思考内容未留存，此为满足回传校验的占位文本）";

/** thinking 全量回填：≥2 个工具调用轮的会话，每轮 assistant 消息都必须携带 reasoning_content。 */
const fillThinkingEcho = (wire: Record<string, unknown>[], echo: string | null): void => {
  for (const message of wire) {
    if (message["role"] !== "assistant" || message["tool_calls"] == null) continue;
    if (typeof message["reasoning_content"] === "string" && message["reasoning_content"] !== "") continue;
    message["reasoning_content"] = echo ?? THINKING_PLACEHOLDER;
  }
};

export const openaiChatCodec: ProtocolCodec = {
  protocol: "openai-chat",
  requestPath: PROTOCOL_REQUEST_PATHS["openai-chat"],

  authHeaders(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },

  encodeRequestBody(input) {
    // compat.supports_developer_role（修订 v2 规则 4）：true → "developer"（新 OpenAI 约定）；
    // 缺省/false → "system"（协议标准行为，与门 2 v1 逐位一致）
    const instructionRole = input.developerRole ? "developer" : "system";
    const wire: Record<string, unknown>[] = [{ role: instructionRole, content: input.system }];
    const state = { pending: [] as WireToolCallRef[], annotations: [] as string[] };
    for (const message of input.messages) {
      const encoded = encodeMessage(message, state, wire);
      if (!encoded.ok) return encoded; // 形状非法：整体拒绝（fail-closed，不产残缺请求）
    }
    flushDangling(state, wire);
    flushAnnotations(state, wire);
    mergeAdjacentAssistantText(wire);
    const bodyBase: Record<string, unknown> = {
      model: input.model,
      messages: wire,
      tools: input.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: "auto",
    };
    // 门 2 §1.2：显式携带 reasoning 参数（配置层拒绝 "none"）；修订 v2 规则 4：
    // compat.supports_reasoning_effort=false → null → 整体省略（对端不认该参数时不发送）
    if (input.reasoningEffort !== null) bodyBase["reasoning_effort"] = input.reasoningEffort;
    if (input.thinkingEcho !== undefined) fillThinkingEcho(wire, input.thinkingEcho);
    return bodyBase;
  },

  parseResponse(body) {
    if (!isPlainObject(body)) return err(codecError("wire_shape_invalid", "响应不是 JSON 对象"));
    const choices = body["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return err(codecError("wire_shape_invalid", "choices 缺失或为空（fail-closed）"));
    }
    const choice = choices[0];
    if (!isPlainObject(choice)) return err(codecError("wire_shape_invalid", "choices[0] 不是 JSON 对象"));
    const message = choice["message"];
    if (!isPlainObject(message)) return err(codecError("wire_shape_invalid", "choices[0].message 缺失或非法"));
    // 截断响应不得当作完整决策（fail-closed）：length = 上下文/输出上限截断
    if (choice["finish_reason"] === "length") {
      return err(codecError("wire_shape_invalid", "finish_reason=length（响应被截断，不猜测完整语义，fail-closed）"));
    }

    const toolCallsRaw = message["tool_calls"];
    let content: string | undefined;
    if (message["content"] !== null && message["content"] !== undefined) {
      if (typeof message["content"] !== "string") {
        return err(codecError("wire_shape_invalid", "message.content 非法（须为字符串或 null）"));
      }
      if (message["content"] !== "") content = message["content"];
    }

    if (toolCallsRaw !== undefined) {
      if (!Array.isArray(toolCallsRaw) || toolCallsRaw.length === 0) {
        return err(codecError("wire_shape_invalid", "tool_calls 非法（出现时须为非空数组）"));
      }
      const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
      for (let i = 0; i < toolCallsRaw.length; i += 1) {
        const call = toolCallsRaw[i];
        if (!isPlainObject(call)) return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}] 不是 JSON 对象`));
        const fn = call["function"];
        if (!isPlainObject(fn)) return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}].function 缺失或非法`));
        if (typeof fn["name"] !== "string" || fn["name"] === "") {
          return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}].function.name 非法`));
        }
        if (typeof fn["arguments"] !== "string") {
          return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}].function.arguments 非法（须为 JSON 字符串）`));
        }
        let params: unknown;
        try {
          params = JSON.parse(fn["arguments"]);
        } catch (cause) {
          return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}].function.arguments 非法 JSON: ${(cause as Error).message}`));
        }
        if (!isPlainObject(params)) {
          return err(codecError("wire_shape_invalid", `tool_calls[${String(i)}].function.arguments 解析结果须为 JSON 对象`));
        }
        calls.push({ tool: fn["name"], params });
      }
      const response: ModelResponse = { tool_calls: calls };
      if (content !== undefined) response.message = content;
      return ok(response);
    }

    if (content !== undefined) return ok({ final_answer: content });
    return err(codecError("wire_shape_invalid", "响应无 tool_calls 且无 content（三类内容至少其一，fail-closed）"));
  },

  encodeWireResponse(response, model) {
    const message: Record<string, unknown> = {
      role: "assistant",
      content: response.final_answer ?? response.message ?? null,
    };
    if (response.tool_calls !== undefined) {
      message["tool_calls"] = response.tool_calls.map((call, index) => ({
        id: `call_${String(index)}`,
        type: "function",
        function: { name: call.tool, arguments: JSON.stringify(call.params) },
      }));
    }
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      model,
      choices: [{ index: 0, message, finish_reason: response.tool_calls !== undefined ? "tool_calls" : "stop" }],
    };
  },
};
