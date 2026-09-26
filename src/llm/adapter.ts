/**
 * B1 adapter 契约 ＋ A3 多工具展开（切片 2——《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》§1.1/§1.2；
 * 依据《agent-loop 设计（已升格）》§5 B1 / §4 A3）。
 *
 * B1：白名单投影（LlmContextEvent[]）→ 模型消息序列——**纯函数**（同输入同输出）、
 *     顺序稳定（事件流顺序 → 消息顺序）、**fail-closed**（未声明事件类型 / 未声明字段一律拒绝）、
 *     **不含预算/治理内部字段**（延续切片 1 模型不可见约束）。
 * A3：模型响应含 N 个工具调用 → 展开为 **N 个顺序 LlmDecision**——loop 语义仍为
 *     "一次决策一个工具"；每个决策各自过守卫（切片 0）与各自过审批检查点（禁止共享授权，
 *     ADR-07 无配额复用红线）。具体 provider 的响应解析属 L1a；本模块定义中性契约并以桩验证。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { type LlmDecision } from "./provider.js";
import { type LlmContextEvent } from "../core/session/index.js";
import { renderGuidanceText } from "../core/run/blockGuidance.js";
import {
  SUMMARY_ARRAY_MAX_ITEMS,
  SUMMARY_RESULT_FALLBACK_CHARS,
  SUMMARY_STRING_VALUE_MAX_CHARS,
} from "../core/session/constantsBudget.js";

// ---------------------------------------------------------------------------
// B1：投影 → 模型消息（adapter 映射）
// ---------------------------------------------------------------------------

/** 模型消息（中性词汇；具体 provider 消息格式的最终映射属 L1a adapter 实现层）。 */
export type AdapterMessage =
  | { role: "user"; text: string; source_event_id: number }
  | { role: "assistant"; text: string; source_event_id: number }
  | { role: "assistant_tool_call"; tool: string; params: Record<string, unknown>; source_event_id: number }
  | { role: "tool_result"; tool: string; ok: boolean; summary: string; source_event_id: number }
  | { role: "approval"; phase: "request" | "response"; summary: string; source_event_id: number };

export interface AdapterError {
  code: "adapter_schema_violation";
  message: string;
}

export const adapterError = (message: string): { code: "adapter_schema_violation"; message: string } => ({
  code: "adapter_schema_violation",
  message,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 未声明字段检查（properties 即白名单——与全仓 schema 同哲学）。 */
const rejectUndeclared = (payload: Record<string, unknown>, declared: readonly string[], path: string): string | null => {
  for (const key of Object.keys(payload)) {
    if (!declared.includes(key)) return `${path} 含未声明字段 "${key}"`;
  }
  return null;
};

/**
 * B1 映射表（声明式；表外事件类型一律拒绝——fail-closed）。
 * - 映射四类语义内容：user/message、assistant/message、tool/call、tool/result；
 * - approval/request|response 映射为审批消息（问答轨历史对模型可见）；
 * - turn/start|end、provider/switch、session/repair、session/compaction：声明为结构/审计标记，
 *   不产生模型消息（skip——显式声明决策，非遗漏）。
 */
const ADAPTER_MAPPINGS: Readonly<Record<string, "map" | "skip">> = {
  "user/message": "map",
  "assistant/message": "map",
  "tool/call": "map",
  "tool/result": "map",
  "approval/request": "map",
  "approval/response": "map",
  "turn/start": "skip",
  "turn/end": "skip",
  "provider/switch": "skip",
  "session/repair": "skip",
  "session/compaction": "skip",
};

const readableSummary = (value: unknown, limit = 160): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "" : text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/**
 * A1 投影摘要改造（L1c 提前批，设计要点 §(一).2 丙·体量纪律）：成功 tool/result 的结构化
 * JSON 不再 160 截断——三档确定性降级（工具无关，不认字段名）：
 *  ① 全文 ≤ capChars → 全量透传（内核模板类返回体整条可读——五跑 #18 缺陷即截在关键字段半截）；
 *  ② 超限 → 保键降级后重试：逐顶层键遍历，长字符串值截至 512＋余量标记、长数组保留前 50 项
 *     ＋计数标记（键集与结构恒保全——「关键字段全量」由结构保证而非清单保证）；
 *  ③ 仍超限（病态体）→ 硬切至 capChars＋知情尾标——模型始终知情拿到的是残缺体。
 * capChars 由调用方注入（resolveSummaryResultCapChars(config.context_window)，未配置回退
 * 6_000；tokens→chars ×2 口径见 constantsBudget）；失败回流 reason 串与 approval 轨的
 * readableSummary(160) 紧凑语义零改。
 */
const truncateStringValue = (value: string): string =>
  value.length > SUMMARY_STRING_VALUE_MAX_CHARS
    ? `${value.slice(0, SUMMARY_STRING_VALUE_MAX_CHARS)}…[截断${String(value.length - SUMMARY_STRING_VALUE_MAX_CHARS)}字符]`
    : value;

/**
 * B5 修复（走查修复批 2026-09-23，指令 7158bf43）：审批 advised 意见正文提取。
 * 走查 run-full-v0762 实录核验（#2274/#2275）：operator 意见（advice_text）在 approval/response
 * 消息摘要中被 readableSummary(160) 截断、在 tool_result(ok=false) 摘要中完全缺席（block 字段
 * 在白名单但不参与摘要拼接）——模型只看到 reason=approval_advised 通用码，意见正文未透传。
 * 修复：ok:false 摘要增加意见段（block.detail.advice_text，approvalTrack 建议回填的权威落点），
 * 无该字段时与旧规则逐字节一致（零回归）。对应测试：adapter.test.ts 走查修复批 B5 describe。
 */
const adviceTextOf = (payload: Record<string, unknown>): string | undefined => {
  const block = payload["block"];
  if (!isPlainObject(block)) return undefined;
  const detail = block["detail"];
  if (!isPlainObject(detail)) return undefined;
  const advice = detail["advice_text"];
  return typeof advice === "string" && advice !== "" ? advice : undefined;
};

const degradeTopLevel = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = truncateStringValue(item);
    } else if (Array.isArray(item) && item.length > SUMMARY_ARRAY_MAX_ITEMS) {
      out[key] = [...item.slice(0, SUMMARY_ARRAY_MAX_ITEMS), `…[共${String(item.length)}项已折叠]`];
    } else {
      out[key] = item;
    }
  }
  return out;
};

export const structuredResultSummary = (result: unknown, capChars: number = SUMMARY_RESULT_FALLBACK_CHARS): string => {
  const text = JSON.stringify(result);
  if (text === undefined) return "";
  if (text.length <= capChars) return text;
  if (!isPlainObject(result)) {
    return `${text.slice(0, capChars)}…[已截断，原文${String(text.length)}字符]`;
  }
  const degraded = JSON.stringify(degradeTopLevel(result));
  if (degraded.length <= capChars) return degraded;
  return `${degraded.slice(0, capChars)}…[已截断，原文${String(text.length)}字符]`;
};

const mapEvent = (event: LlmContextEvent, toolResultSummaryCapChars: number): Result<AdapterMessage | null, AdapterError> => {
  const mapping = ADAPTER_MAPPINGS[event.type];
  if (mapping === undefined) {
    return err(adapterError(`adapter 未声明的事件类型: ${event.type}（fail-closed，不猜测映射）`));
  }
  if (mapping === "skip") return ok(null);
  if (!isPlainObject(event.payload)) return err(adapterError(`${event.type}.payload 不是 JSON 对象`));
  switch (event.type) {
    case "user/message":
    case "assistant/message": {
      const violation = rejectUndeclared(event.payload, ["text"], event.type);
      if (violation !== null) return err(adapterError(violation));
      if (typeof event.payload["text"] !== "string") return err(adapterError(`${event.type}.text 非法`));
      return ok({
        role: event.type === "user/message" ? "user" : "assistant",
        text: event.payload["text"],
        source_event_id: event.id,
      });
    }
    case "tool/call": {
      const violation = rejectUndeclared(event.payload, ["tool", "params"], event.type);
      if (violation !== null) return err(adapterError(violation));
      if (typeof event.payload["tool"] !== "string") return err(adapterError("tool/call.tool 非法"));
      if (!isPlainObject(event.payload["params"])) return err(adapterError("tool/call.params 非法"));
      return ok({
        role: "assistant_tool_call",
        tool: event.payload["tool"],
        params: event.payload["params"],
        source_event_id: event.id,
      });
    }
    case "tool/result": {
      // D-f 补正批登记（2026-09-21）：tool/result 增可选附注 nudge（无进展指引，runner.ts
      // ok:true/ok:false 两注入点）／guidance（业务阻断码一行文案，ok:false 注入点）。
      // 切片 2 白名单未含 → 真实流投影被拦（provider_failure；第二次同类事故，测试盲区＝
      // 脚本面 provider 不经本投影）。纯增量补登；摘要化语义见下（B4·裁定甲）。
      // F5 改动二同步（2026-09-26，投影三同步之二·摘要化路径）：guidance 允许结构化形态
      // （内核三段式 guidance 段），摘要渲染走 renderGuidanceText 单源——字符串零回归，
      // 对象人读展开，绝不静默丢段。
      const violation = rejectUndeclared(event.payload, ["tool", "ok", "result", "reason", "call_ref", "block", "detail", "nudge", "guidance"], event.type);
      if (violation !== null) return err(adapterError(violation));
      if (typeof event.payload["tool"] !== "string") return err(adapterError("tool/result.tool 非法"));
      const okFlag = event.payload["ok"];
      if (typeof okFlag !== "boolean") return err(adapterError("tool/result.ok 非法"));
      // B4·摘要化定向扩展（D-f 补正批，owner 裁定甲 2026-09-21）：nudge/guidance 追加进
      // 模型可见摘要尾部——空段滤除后以"｜"连接。附注字段缺省时与旧规则逐字节一致
      // （零回归硬要求）；主体语义（reason／readableSummary(result)）不变，模型看到的
      // 是旧信息的超集。
      // A1（L1c 提前批 2026-09-22）：ok:true 第一段升级为 structuredResultSummary（成功
      // 结构化体取消 160 截断，capChars 数据驱动）。
      // B5（走查修复批 2026-09-23）：ok:false = [reason, advice, guidance, nudge]——新增
      // advice 段（block.detail.advice_text，仅 advised 回流携带，缺省时逐字节不变）。
      // B3（走查修复批 2026-09-23）：ok:true 增 guidance 段——runner 对完整性闸门 blocked
      // 结果（executed 径）回填的三段式指引（ok:true 此前恒无 payload.guidance，缺省时
      // 逐字节不变）。
      const parts: (string | undefined)[] =
        okFlag === true
          ? [structuredResultSummary(event.payload["result"], toolResultSummaryCapChars), renderGuidanceText(event.payload["guidance"]), event.payload["nudge"] as string | undefined]
          : [String(event.payload["reason"] ?? ""), adviceTextOf(event.payload), renderGuidanceText(event.payload["guidance"]), event.payload["nudge"] as string | undefined];
      const summary = parts.filter((part): part is string => typeof part === "string" && part !== "").join("｜");
      return ok({ role: "tool_result", tool: event.payload["tool"], ok: okFlag, summary, source_event_id: event.id });
    }
    case "approval/request":
    case "approval/response": {
      // L1a 门 2 修正登记：白名单对齐 approvalTrack 实际写入形态——approval/request 含
      // tool_call_id/params/approval_key/attempt/supersedes；approval/response 含
      // request_event_ref/verdict/actor/reason/advice_text/question/approval_session_id。
      // 切片 2 桩测试未覆盖真实流形态（真实流投影被旧白名单拦截）；纯增量补登，
      // 映射语义不变（payload 整体以摘要进模型上下文——问答轨历史对模型可见，B1 既定）。
      const violation = rejectUndeclared(
        event.payload,
        [
          "tool",
          "question",
          "advice_text",
          "verdict",
          "actor",
          "reason",
          "approval_session_id",
          "attempt",
          "request_event_ref",
          "tool_call_id",
          "params",
          "approval_key",
          "supersedes",
          // D4 通道留痕（L1 门 2 T04/T05）：宿主/客户端通道应答三字段，白名单对齐实际写入形态
          "channel",
          "host_id",
          "requires_human_review",
          // F5 4.2（2026-09-26）：内容摘要随 request 落账（脚本类提案；白名单对齐实际写入
          // 形态——投影三同步之一；摘要化路径见 approval 分支 readableSummary 全 payload 透传）
          "content_digest",
        ],
        event.type,
      );
      if (violation !== null) return err(adapterError(violation));
      return ok({
        role: "approval",
        phase: event.type === "approval/request" ? "request" : "response",
        summary: readableSummary(event.payload),
        source_event_id: event.id,
      });
    }
  }
  // 防御收尾：mapping 表与 switch 分支一致性由上方 undefined 检查保证（不可达）
  return ok(null);
};

/** adaptProjectionToMessages 的可选注入（A1：成功体摘要上限数据驱动；缺省回退 6_000 字符）。 */
export interface AdaptProjectionOptions {
  /** 成功 tool/result 结构化体摘要的字符上限（provider 按 resolveSummaryResultCapChars(context_window) 注入）。 */
  toolResultSummaryCapChars?: number;
}

/** B1：投影 → 模型消息序列（纯函数；顺序稳定；单条失败即整体拒绝——不产残缺上下文）。 */
export const adaptProjectionToMessages = (
  context: readonly LlmContextEvent[],
  options?: AdaptProjectionOptions,
): Result<AdapterMessage[], AdapterError> => {
  const capChars = options?.toolResultSummaryCapChars ?? SUMMARY_RESULT_FALLBACK_CHARS;
  const messages: AdapterMessage[] = [];
  for (const event of context) {
    const mapped = mapEvent(event, capChars);
    if (!mapped.ok) return mapped;
    if (mapped.value !== null) messages.push(mapped.value);
  }
  return ok(messages);
};

// ---------------------------------------------------------------------------
// A3：模型响应 → 顺序 LlmDecision（多工具展开）
// ---------------------------------------------------------------------------

/**
 * 模型响应（中性形态；真实 provider 响应的解析/归一属 L1a adapter 实现层）。
 * 三类内容可组合，但有确定性展开顺序：message → tool_calls（按声明序）→ final_answer；
 * final_answer 与 tool_calls 并存 = 契约冲突（fail-closed 拒绝——终止语义与待执行动作并存不可判定）。
 */
export interface ModelResponse {
  message?: string;
  tool_calls?: ReadonlyArray<{ tool: string; params: Record<string, unknown> }>;
  final_answer?: string;
}

/** A3 展开：一次模型响应 → N 个顺序 LlmDecision（N ≥ 1；loop 逐个消费，一次决策一个工具）。 */
export const expandModelResponse = (response: unknown): Result<LlmDecision[], AdapterError> => {
  if (!isPlainObject(response)) return err(adapterError("模型响应不是 JSON 对象"));
  const violation = rejectUndeclared(response, ["message", "tool_calls", "final_answer"], "response");
  if (violation !== null) return err(adapterError(violation));
  const hasMessage = response["message"] !== undefined;
  const hasToolCalls = response["tool_calls"] !== undefined;
  const hasFinal = response["final_answer"] !== undefined;
  if (!hasMessage && !hasToolCalls && !hasFinal) return err(adapterError("模型响应为空（三类内容至少其一）"));
  if (hasFinal && hasToolCalls) {
    return err(adapterError("final_answer 与 tool_calls 并存（终止语义与待执行动作冲突，fail-closed）"));
  }
  const decisions: LlmDecision[] = [];
  if (hasMessage) {
    if (typeof response["message"] !== "string" || response["message"] === "") {
      return err(adapterError("response.message 非法（须为非空字符串）"));
    }
    decisions.push({ type: "assistant_message", text: response["message"] });
  }
  if (hasToolCalls) {
    const calls = response["tool_calls"];
    if (!Array.isArray(calls) || calls.length === 0) return err(adapterError("response.tool_calls 非法（须为非空数组）"));
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      if (!isPlainObject(call)) return err(adapterError(`tool_calls[${String(i)}] 不是 JSON 对象`));
      const callViolation = rejectUndeclared(call, ["tool", "params"], `tool_calls[${String(i)}]`);
      if (callViolation !== null) return err(adapterError(callViolation));
      if (typeof call["tool"] !== "string" || call["tool"] === "") return err(adapterError(`tool_calls[${String(i)}].tool 非法`));
      if (!isPlainObject(call["params"])) return err(adapterError(`tool_calls[${String(i)}].params 非法`));
      decisions.push({ type: "tool_call", tool: call["tool"], params: call["params"] });
    }
  }
  if (hasFinal) {
    if (typeof response["final_answer"] !== "string" || response["final_answer"] === "") {
      return err(adapterError("response.final_answer 非法（须为非空字符串）"));
    }
    decisions.push({ type: "final_answer", text: response["final_answer"] });
  }
  return ok(decisions);
};
