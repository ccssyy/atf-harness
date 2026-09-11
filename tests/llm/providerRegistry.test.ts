import { describe, expect, it } from "vitest";
import { FauxProvider } from "../../src/llm/fauxProvider.js";
import { FauxVariantProvider } from "../../src/llm/fauxVariantProvider.js";
import { createDefaultProviderRegistry, ProviderRegistry } from "../../src/llm/providerRegistry.js";
import { type LlmContextEvent } from "../../src/session/index.js";

/**
 * P2-S3 provider 注册表与第二实现（任务书 §4 / 启动决议口径 #2/#3：至少注册两个
 * provider_id，脚本化 Faux 变体，零网络零依赖；B 自管基线，无宿主注入）。
 */

const ctx: LlmContextEvent[] = [];
const steps = [
  { type: "assistant_message", text: "a" },
  { type: "final_answer", text: "b" },
] as const;

describe("ProviderRegistry（口径 #3：至少两个 provider_id）", () => {
  it("默认注册面：faux 与 faux-alt 均可例示，返回实现带正确 providerId", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.ids().sort()).toEqual(["faux", "faux-alt"]);

    const primary = registry.create("faux", "b1", steps);
    const variant = registry.create("faux-alt", "b1", steps);
    expect(primary).toBeInstanceOf(FauxProvider);
    expect(variant).toBeInstanceOf(FauxVariantProvider);
    expect(primary?.providerId).toBe("faux");
    expect(variant?.providerId).toBe("faux-alt");
  });

  it("注册面外 id = null（fail-closed，不猜测回退）；自定义注册可扩", () => {
    const registry = createDefaultProviderRegistry();
    expect(registry.create("unknown-llm", "b1", steps)).toBeNull();
    expect(registry.has("unknown-llm")).toBe(false);

    const custom = new ProviderRegistry();
    expect(custom.ids()).toEqual([]);
    custom.register("x", () => FauxProvider.fromSteps("b1", steps));
    expect(custom.create("x", "b1", steps)).not.toBeNull();
  });
});

describe("第二 Provider 实现（FauxVariantProvider）", () => {
  it("线性回放与 FauxProvider 同构；序列耗尽 = ok(null)", async () => {
    const variant = FauxVariantProvider.fromSteps("b1", steps);
    const first = await variant.decide(ctx);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toEqual({ type: "assistant_message", text: "a" });
    const second = await variant.decide(ctx);
    if (second.ok) expect(second.value).toEqual({ type: "final_answer", text: "b" });
    const exhausted = await variant.decide(ctx);
    expect(exhausted.ok).toBe(true);
    if (exhausted.ok) expect(exhausted.value).toBeNull();
    expect(variant.exhausted).toBe(true);
  });

  it("两实现互不串段：各自实例独立回放（切换后新实例从段首开始）", async () => {
    const a = FauxProvider.fromSteps("b1", steps);
    const b = FauxVariantProvider.fromSteps("b1", steps);
    await a.decide(ctx); // a 消费第一条
    const bFirst = await b.decide(ctx);
    expect(bFirst.ok).toBe(true);
    if (bFirst.ok) expect(bFirst.value).toEqual({ type: "assistant_message", text: "a" }); // b 从段首开始
  });
});
