/**
 * LLM Provider 接口（任务书 §5-1 / 顺延项登记"LLM 接口已抽象，单实现即可"）。
 *
 * 边界纪律与全仓一致：decide 永不抛出，一切失败走 Result err。
 * Phase 1 唯一实现 = FauxProvider（脚本化决策序列，零网络调用）；
 * 多 provider / 热切换 = Phase 2 顺延项，接口面本 slice 定死不再扩。
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
  /**
   * 依据模型可见上下文产出下一个决策。
   * - ok(decision) —— 下一个决策步骤
   * - ok(null)     —— 决策序列耗尽（runner 视为分支未正常收束 → failed，不猜测成功）
   * - err          —— provider 自身故障
   */
  decide(context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>>;
}
