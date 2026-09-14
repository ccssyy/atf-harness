/**
 * L1a 门 2——协议 codec 共享契约（任务书 §1.2 / D6 / 设计 §1.1 多 codec 架构）。
 *
 * 职责边界（硬约束）：codec **只做形状转换**——
 *   canonical 面（`AdapterMessage[]` ↔ `ModelResponse`，切片 2 adapter 契约）↔ wire 面；
 *   工具是否可调、是否需审批等业务判断**一律不在 codec 内**（守卫/展开/逐工具审批零改动）。
 *
 * 三个方向：
 *   ① encodeRequestBody：canonical 消息 + 工具面 → wire 请求体（协议头字段由各 codec 定死）；
 *   ② parseResponse：2xx wire 响应 → canonical `ModelResponse`（经 expandModelResponse 展开、
 *      assertModelDecision 守卫——均在 codec 之外）；
 *   ③ encodeWireResponse：canonical `ModelResponse` → wire 响应体（**仅供本地假端点回放与
 *      fixture 测试**，不参与生产请求路径）。
 *
 * 消息序列的 wire 合法性（两协议共同约束，形状规则在 codecWire 内单点承载）：
 *   assistant 的工具调用必须先于其工具结果出现；审批往返消息（approval）夹在 tool_call 与
 *   tool_result 之间时，为满足「先结果后附言」的线缆次序，approval 摘要**缓冲**到配对
 *   tool_result 之后作为一条 user 附言回填；run 挂起造成的**悬空工具调用**（无 tool_result）
 *   在序列末尾以审批摘要内容合成工具结果——这是线缆协议的形状要求，不是业务放行
 *  （审批事实原样可见于摘要文本；放行判定只读账本/凭据路径，与该文本无关）。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { type AdapterMessage, type ModelResponse } from "../llm/adapter.js";
import { type ModelVisibleTool } from "../tools/index.js";
import { type ProviderProtocol } from "./providerConfig.js";

/** codec 级结构化错误（任务书 §3.2：非法响应 → fail-closed）。 */
export interface CodecError {
  code: "wire_shape_invalid" | "http_error";
  message: string;
  /** HTTP 状态码（http_error 时携带） */
  status?: number;
  /** 响应体摘要（≤200 字符；调用方须再经脱敏漏斗） */
  body_excerpt?: string;
}

export const codecError = (code: CodecError["code"], message: string, extra?: { status?: number; body_excerpt?: string }): CodecError => {
  const error: CodecError = { code, message };
  if (extra?.status !== undefined) error.status = extra.status;
  if (extra?.body_excerpt !== undefined) error.body_excerpt = extra.body_excerpt;
  return error;
};

/** 协议端点路径（设计 §1.1 协议面表格）。 */
export const PROTOCOL_REQUEST_PATHS: Readonly<Record<ProviderProtocol, string>> = {
  "openai-chat": "/v1/chat/completions",
  "anthropic-messages": "/v1/messages",
};

/** 编码输入（canonical 面）。 */
export interface CodecRequestInput {
  model: string;
  /** 系统提示（harness 静态文本；openai-chat = 首条 system 消息，anthropic = 顶层 system） */
  system: string;
  messages: readonly AdapterMessage[];
  tools: readonly ModelVisibleTool[];
  /** openai-chat 显式携带（任务书 §1.2）；anthropic 忽略 */
  reasoningEffort: string;
  /** anthropic 线缆必填；openai-chat 忽略 */
  maxTokens: number;
}

export interface ProtocolCodec {
  readonly protocol: ProviderProtocol;
  readonly requestPath: string;
  /** 出站认证头（api_key 唯一出现处；ADR-09 红线）。 */
  authHeaders(apiKey: string): Record<string, string>;
  /** canonical 消息 + 工具面 → wire 请求体（纯函数）。 */
  encodeRequestBody(input: CodecRequestInput): unknown;
  /** 2xx wire 响应 → canonical ModelResponse（纯函数；形状非法 → err fail-closed）。 */
  parseResponse(body: unknown): Result<ModelResponse, CodecError>;
  /** canonical ModelResponse → wire 响应体（假端点回放与 fixture 专用）。 */
  encodeWireResponse(response: ModelResponse, model: string): unknown;
}

// ---------------------------------------------------------------------------
// 两 codec 共用的消息序列 walk（approval 缓冲 / 悬空工具调用合成）
// ---------------------------------------------------------------------------

export interface WireToolCallRef {
  /** 线缆工具调用 id（确定性派生：call_<source_event_id>） */
  id: string;
  tool: string;
}

/** 遍历状态（各 codec 的 encode 循环共用语义）。 */
export interface SequenceWalkState {
  /** 已发出、尚无线缆结果的工具调用（FIFO 配对） */
  pending: WireToolCallRef[];
  /** 缓冲中的审批附言（在配对 tool_result 之后回填） */
  annotations: string[];
}

export const wireToolCallId = (sourceEventId: number): string => `call_${String(sourceEventId)}`;

export const approvalSummaryLine = (message: AdapterMessage & { role: "approval" }): string =>
  `${message.phase === "request" ? "请求" : "应答"}：${message.summary}`;

/** 审批附言文本（缓冲的 approval 摘要拼接）。 */
export const approvalAnnotationText = (lines: readonly string[]): string =>
  ["[审批往返]", ...lines].join("\n");

/** 悬空工具调用的合成结果内容（形状要求：每个 wire 工具调用必须有结果）。 */
export const danglingToolResultContent = (annotations: readonly string[]): string =>
  annotations.length > 0
    ? `${approvalAnnotationText(annotations)}（工具调用未执行：审批未在进程内完成，动作未发生）`
    : "工具调用未执行：审批等待中，动作未发生";
