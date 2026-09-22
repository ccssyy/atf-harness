/**
 * LLM Provider 接口（任务书 §5-1 / P2-S3 多 provider 扩展 / 切片 0 决策类型拆分）。
 *
 * 切片 0（治理前置，《ATF独立Harness_切片0任务书_决策类型拆分与守卫_20260914.md》）：
 * LlmDecision 独立定义为**模型面契约**——恰好三类（tool_call / 输出消息 / 收束），
 * 脚本专用指令（scratch_write / promote / cite_t0 / provider_switch）**类型不可表达**；
 * 辅以 assertModelDecision 运行时守卫（provider 返回值入口，fail-closed）。
 * "模型触达晋升闸 A"由此由约定变为类型不可表达 ＋ 运行时拒绝。
 *
 * 边界纪律与全仓一致：decide 永不抛出，一切失败走 Result err。
 * Phase 2 实现注册面 = FauxProvider（"faux"）+ FauxVariantProvider（"faux-alt"），
 * 均为脚本化 Faux（零网络调用）——切片 0 起二者不再实现本接口（改实现测试供应商
 * 接口 ScriptedStepSource，见 fauxProvider.ts；明确标注非模型面）。
 */
import { type Result } from "../bridge/index.js";
import { type LlmContextEvent } from "../core/session/index.js";

/**
 * 模型面契约（切片 0）：一次模型决策的合法形态，独立定义、不引用场景脚本类型。
 * 任务书 §2.1 的 "{type:"message"}" 对应既有会话词汇 assistant_message（模型输出消息）——
 * assistant_message 不在脚本专用清单（§0），属模型面。
 */
export type LlmDecision =
  | {
      type: "tool_call";
      /** 工具名（严格 4 工具面） */
      tool: string;
      /** 参数对象（审批键 = tool + stable(params) digest） */
      params: Record<string, unknown>;
    }
  | { type: "assistant_message"; text: string }
  | { type: "final_answer"; text: string };

/** 模型面决策类型闭集（运行时守卫用）。 */
export const LLM_DECISION_TYPES = ["tool_call", "assistant_message", "final_answer"] as const;

/** 守卫拒绝的结构化错误码（任务书 §2.2 建议命名；run 层复用同串）。 */
export const MODEL_DECISION_FORBIDDEN = "model_decision_forbidden";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 运行时守卫（切片 0 §2.2）：作用于 LlmProvider 接口返回值入口（决策进入分派之前）。
 * 结构化白名单校验——恰好三类、字段闭集（未声明字段拒绝，与全仓 schema 同哲学）；
 * 不属于 LlmDecision → ok:false（调用方 fail-closed：failed + 落事件留痕，不吞错、不降级忽略）。
 * 脚本执行器（ScriptedStepSource，测试路径）不经本守卫——守卫作用域 = provider 接口。
 */
export const assertModelDecision = (value: unknown): { ok: true; decision: LlmDecision } | { ok: false; reason: string } => {
  if (!isPlainObject(value)) return { ok: false, reason: `决策不是 JSON 对象（实得 ${typeof value}）` };
  const type = value["type"];
  if (typeof type !== "string" || !(LLM_DECISION_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `决策 type 不在模型面闭集内: ${String(type)}` };
  }
  const decisionType = type as LlmDecision["type"];
  switch (decisionType) {
    case "tool_call": {
      for (const key of Object.keys(value)) {
        if (key !== "type" && key !== "tool" && key !== "params") {
          return { ok: false, reason: `tool_call 含模型面外字段 "${key}"` };
        }
      }
      if (typeof value["tool"] !== "string" || value["tool"] === "") return { ok: false, reason: "tool_call.tool 非法" };
      if (!isPlainObject(value["params"])) return { ok: false, reason: "tool_call.params 非法（须为 JSON 对象）" };
      return { ok: true, decision: { type: "tool_call", tool: value["tool"], params: value["params"] } };
    }
    case "assistant_message":
    case "final_answer": {
      for (const key of Object.keys(value)) {
        if (key !== "type" && key !== "text") {
          return { ok: false, reason: `${decisionType} 含模型面外字段 "${key}"` };
        }
      }
      if (typeof value["text"] !== "string" || value["text"] === "") return { ok: false, reason: `${decisionType}.text 非法` };
      return { ok: true, decision: { type: decisionType, text: value["text"] } };
    }
  }
};

/**
 * LlmErrorCode（L1a 门 2 扩一值；L1c 提前批 C 项再扩一值）：
 * - provider_failure：provider 自身/协议/响应形状故障（既有语义零改动）；
 * - call_budget_exhausted：单 run 调用次数上限命中（门 2 任务书 §1.1 / D5 成本护栏——
 *   与轮次预算是两件事；结构化可区分，调用方按故障终局收敛，不静默继续）；
 * - provider_quota_or_rate_limited：provider 侧配额/限流/欠费（HTTP 429 或 body 配额类
 *   标记）——映射人读提示「用量已达上限」，不重试（L1c 提前批 C 项查证补映射，2026-09-22；
 *   复核点①核验行：本闭集未登记于 bridge/session/workspace 三契约件，扩值零契约 diff）。
 */
export type LlmErrorCode = "provider_failure" | "call_budget_exhausted" | "provider_quota_or_rate_limited";

export interface LlmError {
  code: LlmErrorCode;
  /** 人读摘要（中文，面向 harness 开发者与日志） */
  message: string;
  detail?: unknown;
}

export const llmError = (message: string, detail?: unknown): LlmError => {
  const error: LlmError = { code: "provider_failure", message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** 指定错误码的 LlmError 构造（L1a 门 2：call_budget_exhausted 用）。 */
export const llmErrorOf = (code: LlmErrorCode, message: string, detail?: unknown): LlmError => {
  const error: LlmError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

export interface LlmProvider {
  /** 注册面内的 provider 标识（P2-S3：切换事件 from/to 与报告 turn 归属的依据）。 */
  readonly providerId: string;
  /**
   * 依据模型可见上下文产出下一个决策（模型面契约：LlmDecision，切片 0）。
   * - ok(decision) —— 下一个模型决策
   * - ok(null)     —— 决策序列耗尽（单 provider 分支 = runner 判未收束；多 provider 段
   *                   分支 = 段边界，runner 按 segments 推进切换）
   * - err          —— provider 自身故障
   */
  decide(context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>>;
}
