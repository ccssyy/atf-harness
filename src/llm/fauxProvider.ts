/**
 * FauxProvider——脚本化假 LLM（任务书 §5-1）：按场景分支预编排的决策序列线性回放，
 * 对工具结果无反应、无任何网络调用（owner 口径 #5：Faux 无智能理解，
 * "自纠"由脚本顺序表达）。真实 Provider = Phase 2 顺延项。
 *
 * 切片 0（保全路径 b，任务书 §2.3）：Faux 保留"脚本执行器"角色，但**不再实现
 * LlmProvider 接口**（模型面契约）——改实现独立的测试供应商接口 ScriptedStepSource
 * （`decisionFace: "script"` 明确标注非模型面）。runner 据此类型级分流：脚本路径
 * 不经模型面守卫（守卫作用域 = provider 接口返回值），既有场景零回归。
 */
import { ok, type Result } from "../bridge/index.js";
import { type LlmContextEvent } from "../session/index.js";
import { type LlmError } from "./provider.js";
import { type ScenarioBranch, type ScenarioStep } from "./scenario.js";

/**
 * 测试供应商接口（切片 0 (b)）：脚本执行器的消费面——返回**场景步骤**（测试基建面），
 * 非模型面契约；decisionFace = "script" 供 runner 运行时识别分流。
 */
export interface ScriptedStepSource {
  readonly providerId: string;
  /** 非模型面标注（切片 0）：runner 据此豁免模型面守卫（守卫作用域 = provider 接口）。 */
  readonly decisionFace: "script";
  decide(context: readonly LlmContextEvent[]): Promise<Result<ScenarioStep | null, LlmError>>;
}

export class FauxProvider implements ScriptedStepSource {
  public readonly providerId = "faux";
  public readonly decisionFace = "script" as const;

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

  /** 线性回放：每次调用弹出下一个预编排步骤；context 仅满足接口保真（Faux 不读）。 */
  public async decide(_context: readonly LlmContextEvent[]): Promise<Result<ScenarioStep | null, LlmError>> {
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
