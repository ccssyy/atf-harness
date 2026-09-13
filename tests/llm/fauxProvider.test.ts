import { describe, expect, it } from "vitest";
import { FauxProvider, parseScenario, type ScenarioBranch } from "../../src/llm/index.js";

/**
 * S5 FauxProvider 测试（任务书 §5-1：脚本化线性回放，对上下文无反应、无网络调用）。
 */

const BRANCH: ScenarioBranch = {
  branch_id: "test_branch",
  run_id: "test-branch",
  trigger_instruction: "测试指令",
  purpose: "测试",
  setup: { ledger: [] },
  steps: [
    { type: "assistant_message", text: "第一步" },
    { type: "tool_call", tool: "atf_fact_scan", params: {} },
    { type: "final_answer", text: "收束" },
  ],
  expect: { outcome: "completed", exit_code: 0 },
};

describe("S5 FauxProvider 线性回放", () => {
  it("按脚本顺序弹出决策；context 仅满足接口保真（内容不影响回放）", async () => {
    const provider = FauxProvider.fromBranch(BRANCH);
    const first = await provider.decide([]);
    expect(first.ok && first.value).toEqual({ type: "assistant_message", text: "第一步" });
    const second = await provider.decide([{ id: 1, ts: "t", type: "user/message", payload: { text: "任意上下文" } }]);
    expect(second.ok && second.value).toMatchObject({ type: "tool_call", tool: "atf_fact_scan" });
    expect(provider.exhausted).toBe(false);
    const third = await provider.decide([]);
    expect(third.ok && third.value).toMatchObject({ type: "final_answer" });
    expect(provider.exhausted).toBe(true);
  });

  it("序列耗尽 → ok(null)（runner 据此判分支未收束，不猜测成功）", async () => {
    const provider = FauxProvider.fromBranch(BRANCH);
    for (let i = 0; i < BRANCH.steps.length; i += 1) await provider.decide([]);
    const exhausted = await provider.decide([]);
    expect(exhausted.ok).toBe(true);
    if (exhausted.ok) expect(exhausted.value).toBeNull();
  });

  it("parseScenario 产物可直接驱动 FauxProvider（场景 → 决策链集成）", async () => {
    const scenario = {
      scenario_id: "s",
      version: 1,
      provider: "faux",
      description: "d",
      branches: { test_branch: BRANCH },
    };
    const parsed = parseScenario(scenario);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const provider = FauxProvider.fromBranch(parsed.value.branches["test_branch"] as ScenarioBranch);
    const decision = await provider.decide([]);
    expect(decision.ok && decision.value?.type).toBe("assistant_message");
  });
});
