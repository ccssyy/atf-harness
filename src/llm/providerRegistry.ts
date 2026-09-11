/**
 * Provider 注册表（P2-S3，任务书 §4「provider 注册与切换」/ 启动决议口径 #2/#3 / ADR-09
 * §1.4 C9——B 自管基线：provider 由 harness 本地声明，S3 不实现宿主注入）。
 *
 * - 注册面至少两个 provider_id（Phase 2 = "faux" / "faux-alt"，均脚本化 Faux，零网络、
 *   零依赖）；注册面外的 id 一律结构化拒绝（fail-closed，不猜测回退）。
 * - 工厂以步骤序列为参：多 provider 段（segments）各自的决策脚本在场景分支内声明，
 *   注册表只负责「id → 实现例示」。
 */
import { FauxProvider } from "./fauxProvider.js";
import { FauxVariantProvider } from "./fauxVariantProvider.js";
import { type LlmProvider } from "./provider.js";
import { type ScenarioStep } from "./scenario.js";

export type ProviderFactory = (branchId: string, steps: readonly ScenarioStep[]) => LlmProvider;

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  public register(providerId: string, factory: ProviderFactory): this {
    this.factories.set(providerId, factory);
    return this;
  }

  public has(providerId: string): boolean {
    return this.factories.has(providerId);
  }

  public ids(): string[] {
    return [...this.factories.keys()];
  }

  /** 注册面未命中 = null（调用方结构化拒绝，不猜测回退）。 */
  public create(providerId: string, branchId: string, steps: readonly ScenarioStep[]): LlmProvider | null {
    const factory = this.factories.get(providerId);
    if (factory === undefined) return null;
    return factory(branchId, steps);
  }
}

/** 默认注册面（Phase 2）：两个脚本化 Faux 实现。 */
export const createDefaultProviderRegistry = (): ProviderRegistry =>
  new ProviderRegistry()
    .register("faux", (branchId, steps) => FauxProvider.fromSteps(branchId, steps))
    .register("faux-alt", (branchId, steps) => FauxVariantProvider.fromSteps(branchId, steps));
