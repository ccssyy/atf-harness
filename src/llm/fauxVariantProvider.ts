/**
 * FauxVariantProvider——第二 Provider 实现（P2-S3，任务书 §4 设计要求 1 / 启动决议口径 #3）：
 * 脚本化 Faux 变体，注册 id = "faux-alt"。与 FauxProvider 同为线性脚本回放、零网络调用、
 * 零依赖；独立类承载注册面内的第二 provider_id（"不同决策序列"由场景 segments 的脚本
 * 差异表达，本类提供归属标识与实现区分）。真实 Provider 不在本阶段（C9：B 自管基线）。
 */
import { ok, type Result } from "../bridge/index.js";
import { type LlmContextEvent } from "../session/index.js";
import { type LlmDecision, type LlmError, type LlmProvider } from "./provider.js";
import { type ScenarioStep } from "./scenario.js";

export class FauxVariantProvider implements LlmProvider {
  public readonly providerId = "faux-alt";

  private constructor(
    public readonly branchId: string,
    private readonly script: readonly ScenarioStep[],
    private next: number,
  ) {}

  /** 以步骤序列构造（provider 注册面 / segments 段使用）。 */
  public static fromSteps(branchId: string, steps: readonly ScenarioStep[]): FauxVariantProvider {
    return new FauxVariantProvider(branchId, steps, 0);
  }

  /** 线性回放：每次调用弹出下一个预编排决策；context 仅满足接口保真（Faux 不读）。 */
  public async decide(_context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>> {
    const decision = this.script[this.next];
    if (decision === undefined) return ok(null); // 段序列耗尽——由 runner 按段边界/收束语义处置
    this.next += 1;
    return ok(decision);
  }

  /** 已回放完（供诊断/测试）。 */
  public get exhausted(): boolean {
    return this.next >= this.script.length;
  }
}
