/**
 * L1a 门 2——anthropic-messages codec（任务书 §1.2 / D6）。
 *
 * 线缆形状（v1）：
 *   请求：POST {base}/v1/messages，x-api-key: <api_key> ＋ anthropic-version: 2023-06-01
 *         （key 唯一出现处）；body = { model, max_tokens（线缆必填）, system（顶层字符串）,
 *         tools:[{name, description, input_schema}], messages:[{role:"user"|"assistant", content:[…]}] }。
 *   消息映射：user/assistant 文本 → content:[{type:"text"}]；assistant_tool_call →
 *         assistant content 内 {type:"tool_use", id, name, input（对象）}；tool_result →
 *         user 消息 content 内 {type:"tool_result", tool_use_id, content, is_error}（协议要求
 *         全部 tool_use 在紧随的 user 消息内回填，审批附言与同批 tool_result 合并同一条 user）；
 *         approval → 缓冲后随配对 tool_result 合并；悬空工具调用（挂起尾）以审批摘要合成
 *         tool_result 块。相邻 user 消息合并为一条（协议要求角色交替）。
 *   响应解析：content[] 内 text 块 → message；tool_use 块 → tool_calls（input 即 params 对象）；
 *         仅 text ＋ stop_reason="end_turn" → final_answer；仅 text ＋ 其他 stop_reason →
 *         fail-closed（截断/拒绝等非完整语义，不猜测——登记于设计文档 codec 契约）。
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

/** anthropic-version（线缆协议头；登记于设计文档 codec 契约）。 */
export const ANTHROPIC_VERSION = "2023-06-01";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** wire content 块（本 codec 用到的三类 + 合并逻辑承载）。 */
type ContentBlock = Record<string, unknown>;

interface WalkState {
  pending: WireToolCallRef[];
  annotations: string[];
}

/** 悬空工具调用收尾：产出 tool_result 块（形状要求；内容 = 审批事实摘要，非放行）。 */
const danglingToolResultBlocks = (state: WalkState): ContentBlock[] => {
  if (state.pending.length === 0) return [];
  const calls = state.pending.splice(0, state.pending.length);
  const annotations = state.annotations.splice(0, state.annotations.length);
  return calls.map((call) => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: danglingToolResultContent(annotations),
  }));
};

const annotationTextBlocks = (state: WalkState): ContentBlock[] => {
  if (state.annotations.length === 0) return [];
  const lines = state.annotations.splice(0, state.annotations.length);
  return [{ type: "text", text: approvalAnnotationText(lines) }];
};

/**
 * 用户侧消息并入最后一条 user（协议要求角色交替）；返回 wire messages。
 * userPush：新的用户侧内容块（tool_result / 用户文本 / 审批附言）。
 */
const encodeMessage = (
  message: AdapterMessage,
  state: WalkState,
  wire: Array<{ role: "user" | "assistant"; content: ContentBlock[] }>,
): Result<null, CodecError> => {
  switch (message.role) {
    case "user": {
      const blocks = [...danglingToolResultBlocks(state), { type: "text", text: message.text }, ...annotationTextBlocks(state)];
      pushUserSide(wire, blocks);
      return ok(null);
    }
    case "assistant": {
      const dangling = danglingToolResultBlocks(state);
      if (dangling.length > 0) pushUserSide(wire, dangling);
      wire.push({ role: "assistant", content: [{ type: "text", text: message.text }] });
      return ok(null);
    }
    case "assistant_tool_call": {
      const dangling = danglingToolResultBlocks(state);
      if (dangling.length > 0) pushUserSide(wire, dangling);
      const id = wireToolCallId(message.source_event_id);
      wire.push({
        role: "assistant",
        content: [{ type: "tool_use", id, name: message.tool, input: message.params }],
      });
      state.pending.push({ id, tool: message.tool });
      return ok(null);
    }
    case "tool_result": {
      const paired = state.pending[0];
      if (paired === undefined) {
        return err(codecError("wire_shape_invalid", `tool_result 无配对的 tool_use（tool=${message.tool}，source_event_id=${String(message.source_event_id)}）`));
      }
      if (paired.tool !== message.tool) {
        return err(codecError("wire_shape_invalid", `tool_result 与配对工具调用不一致（期望 ${paired.tool}，实得 ${message.tool}）`));
      }
      state.pending.shift();
      pushUserSide(wire, [
        { type: "tool_result", tool_use_id: paired.id, content: message.summary, is_error: !message.ok },
        ...annotationTextBlocks(state),
      ]);
      return ok(null);
    }
    case "approval": {
      // 缓冲：随配对 tool_result 合并进同一条 user（线缆次序：结果先于附言）
      state.annotations.push(approvalSummaryLine(message));
      return ok(null);
    }
  }
};

const pushUserSide = (wire: Array<{ role: "user" | "assistant"; content: ContentBlock[] }>, blocks: ContentBlock[]): void => {
  const last = wire[wire.length - 1];
  if (last !== undefined && last.role === "user") {
    last.content.push(...blocks);
    return;
  }
  wire.push({ role: "user", content: blocks });
};

export const anthropicMessagesCodec: ProtocolCodec = {
  protocol: "anthropic-messages",
  requestPath: PROTOCOL_REQUEST_PATHS["anthropic-messages"],

  authHeaders(apiKey) {
    return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
  },

  encodeRequestBody(input) {
    const wire: Array<{ role: "user" | "assistant"; content: ContentBlock[] }> = [];
    const state: WalkState = { pending: [], annotations: [] };
    for (const message of input.messages) {
      const encoded = encodeMessage(message, state, wire);
      if (!encoded.ok) return encoded; // 形状非法：整体拒绝（fail-closed，不产残缺请求）
    }
    const dangling = danglingToolResultBlocks(state);
    if (dangling.length > 0) pushUserSide(wire, dangling);
    const annotations = annotationTextBlocks(state);
    if (annotations.length > 0) pushUserSide(wire, annotations);
    return {
      model: input.model,
      max_tokens: input.maxTokens, // 线缆必填（协议要求）
      system: input.system,
      messages: wire,
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    };
  },

  parseResponse(body) {
    if (!isPlainObject(body)) return err(codecError("wire_shape_invalid", "响应不是 JSON 对象"));
    const content = body["content"];
    if (!Array.isArray(content) || content.length === 0) {
      return err(codecError("wire_shape_invalid", "content 缺失或为空（fail-closed）"));
    }
    const texts: string[] = [];
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
    for (let i = 0; i < content.length; i += 1) {
      const block = content[i];
      if (!isPlainObject(block)) return err(codecError("wire_shape_invalid", `content[${String(i)}] 不是 JSON 对象`));
      const type = block["type"];
      if (type === "text") {
        if (typeof block["text"] !== "string") return err(codecError("wire_shape_invalid", `content[${String(i)}].text 非法`));
        if (block["text"] !== "") texts.push(block["text"]);
        continue;
      }
      if (type === "tool_use") {
        if (typeof block["name"] !== "string" || block["name"] === "") {
          return err(codecError("wire_shape_invalid", `content[${String(i)}].name 非法`));
        }
        if (!isPlainObject(block["input"])) {
          return err(codecError("wire_shape_invalid", `content[${String(i)}].input 非法（须为 JSON 对象）`));
        }
        calls.push({ tool: block["name"], params: block["input"] });
        continue;
      }
      // 修订 v2 规则 5（剥离要求；验收决议 §3 实现要求）：reasoning 模型对端可能返回思考块——
      // thinking / redacted_thinking 块**剥离**（不进模型上下文、不参与决策解析），其余未知类型仍 fail-closed
      if (type === "thinking" || type === "redacted_thinking") continue;
      return err(codecError("wire_shape_invalid", `content[${String(i)}].type 不在 codec 解析面（${String(type)}，fail-closed）`));
    }

    if (calls.length > 0) {
      const response: ModelResponse = { tool_calls: calls };
      if (texts.length > 0) response.message = texts.join("\n");
      return ok(response);
    }
    if (texts.length > 0) {
      // 仅文本：stop_reason 决定语义——end_turn = 完整收束；其他 = 非完整语义不猜测
      const stopReason = body["stop_reason"];
      if (stopReason !== "end_turn") {
        return err(codecError("wire_shape_invalid", `仅文本响应且 stop_reason=${String(stopReason)}（非 end_turn，截断/拒绝等非完整语义，fail-closed）`));
      }
      return ok({ final_answer: texts.join("\n") });
    }
    return err(codecError("wire_shape_invalid", "content 无 text 且无 tool_use（三类内容至少其一，fail-closed）"));
  },

  encodeWireResponse(response, model) {
    const content: ContentBlock[] = [];
    if (response.message !== undefined) content.push({ type: "text", text: response.message });
    if (response.tool_calls !== undefined) {
      for (let i = 0; i < response.tool_calls.length; i += 1) {
        const call = response.tool_calls[i] as { tool: string; params: Record<string, unknown> };
        content.push({ type: "tool_use", id: `toolu_${String(i)}`, name: call.tool, input: call.params });
      }
    }
    if (response.final_answer !== undefined) content.push({ type: "text", text: response.final_answer });
    return {
      id: "msg-fake",
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: response.tool_calls !== undefined ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  },
};
