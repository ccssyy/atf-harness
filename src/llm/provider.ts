/**
 * LLM Provider 接口（任务书 §5-1 / P2-S3 多 provider 扩展）。
 *
 * 边界纪律与全仓一致：decide 永不抛出，一切失败走 Result err。
 * Phase 2 实现注册面 = FauxProvider（"faux"）+ FauxVariantProvider（"faux-alt"），
 * 均为脚本化 Faux（零网络调用）；真实 Provider 不在本阶段（C9：B 自管基线）。
 */
import { type Result } from "../bridge/index.js";
import { type LlmContextEvent } from "../session/index.js";
import { type ScenarioStep } from "./scenario.js";

/**
 * 一次模型决策 = 场景脚本的一个步骤（ScenarioStep 即决策面：
 * tool_call / 输出消息 / 工作区动作 / 收束）。
 */
export type LlmDecision = ScenarioStep;

export type LlmErrorCode = "provider_failure";

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

export interface LlmProvider {
  /** 注册面内的 provider 标识（P2-S3：切换事件 from/to 与报告 turn 归属的依据）。 */
  readonly providerId: string;
  /**
   * 依据模型可见上下文产出下一个决策。
   * - ok(decision) —— 下一个决策步骤
   * - ok(null)     —— 决策序列耗尽（单 provider 分支 = runner 判未收束；多 provider 段
   *                   分支 = 段边界，runner 按 segments 推进切换）
   * - err          —— provider 自身故障
   */
  decide(context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>>;
}
