/**
 * FauxProvider——脚本化假 LLM（任务书 §5-1）：按场景分支预编排的决策序列线性回放，
 * 对工具结果无反应、无任何网络调用（owner 口径 #5：Faux 无智能理解，
 * "自纠"由脚本顺序表达）。真实 Provider = Phase 2 顺延项。
 */
import { ok, type Result } from "../bridge/index.js";
import { type LlmContextEvent } from "../session/index.js";
import { type LlmDecision, type LlmError, type LlmProvider } from "./provider.js";
import { type ScenarioBranch, type ScenarioStep } from "./scenario.js";

export class FauxProvider implements LlmProvider {
  public readonly providerId = "faux";

  private constructor(
    public readonly branchId: string,
    private readonly script: readonly ScenarioStep[],
    private next: number,
  ) {}

  /** 以场景分支构造：决策序列 = branch.steps 原样回放。 */
  public static fromBranch(branch: ScenarioBranch): FauxProvider {
    return new FauxProvider(branch.branch_id, branch.steps, 0);
  }

  /** 以步骤序列构造（P2-S3：provider 注册面 / segments 段使用）。 */
  public static fromSteps(branchId: string, steps: readonly ScenarioStep[]): FauxProvider {
    return new FauxProvider(branchId, steps, 0);
  }

  /** 线性回放：每次调用弹出下一个预编排决策；context 仅满足接口保真（Faux 不读）。 */
  public async decide(_context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>> {
    const decision = this.script[this.next];
    if (decision === undefined) return ok(null); // 序列耗尽——由 runner 判定分支未收束
    this.next += 1;
    return ok(decision);
  }

  /** 已回放完（供诊断/测试）。 */
  public get exhausted(): boolean {
    return this.next >= this.script.length;
  }
}
