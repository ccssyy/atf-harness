/**
 * 批 2.5 §二（2026-09-22）：预算四层——层一 turn 级 token 预算（数据驱动两态）、层二 80%
 * 渐进警告（nudge 通道模型可见）、层四兜底保险丝、层三连续 provider 失败升级。
 * 预算模型不可见约束延续：est tokens/预算值不得进入 decide 上下文。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { adaptProjectionToMessages, llmErrorOf } from "../../src/llm/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import { resolveTurnTokenBudget, TURN_BUDGET_WARN_RATIO, TURN_HARD_STEP_FUSE_DEFAULT } from "../../src/core/session/constantsBudget.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "budget-layers",
  version: 1,
  provider: "faux",
  description: "批 2.5 预算四层测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "budget-layers",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "stub-host" });
const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `bl-${randomUUID()}`);

describe("层一默认两态（数据驱动；单位＝est tokens——处置② 单位标注）", () => {
  it("未配置 context_window → 6_000 est tokens/turn（＝24K 触发门 /4）", () => {
    expect(resolveTurnTokenBudget(null)).toBe(6_000);
  });
  it("配置 1M → 243_750 est tokens/turn（＝975K 水位 /4）", () => {
    expect(resolveTurnTokenBudget(1_000_000)).toBe(243_750);
  });
  it("显式配置优先；fuse 缺省 200 步（可配）；警告水位 0.8", () => {
    expect(resolveTurnTokenBudget(null, 1234)).toBe(1234);
    expect(TURN_HARD_STEP_FUSE_DEFAULT).toBe(200);
    expect(TURN_BUDGET_WARN_RATIO).toBe(0.8);
  });
});

describe("层二：80% 渐进警告（nudge 通道，模型可见）", () => {
  it("估算过 80% → 下一拍 tool/result nudge 注入收敛提示；预算值不进上下文", { timeout: 120_000 }, async () => {
    // 体量自控（实测校准 run-walk 同款 mock）：估算主体＝tool/call 大参数（7_600 字符
    // ≈3_836 est，确定性）＋gate 回流（≈3_945 est，实测算）；总量 ≈8_151。
    // B=8_600 → 警告线 6_880：result 回流候选 ≈7_811 过线触发；总量 <B 不收口。
    const budget = 8_600;
    const decisions: LlmDecision[] = [
      { type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query", filler: "x".repeat(7_600) } },
      { type: "final_answer", text: "已收口。" },
    ];
    const contexts: string[] = [];
    const provider: LlmProvider = {
      providerId: "bl-stub-model",
      decide: async (context) => {
        contexts.push(JSON.stringify(context));
        return ok(decisions.shift() ?? null);
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`bl-warn-${randomUUID()}`, "查询"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
      budgets: { turnTokenBudget: budget },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    // 警告不是收口——层二只提示（总量 <B ⇒ 层一不触）
    expect(report.outcome.kind).toBe("completed");
    const warned = report.events.find(
      (event) =>
        event.type === "tool/result" &&
        typeof (event.payload as { nudge?: unknown }).nudge === "string" &&
        ((event.payload as { nudge: string }).nudge).includes("预算提示"),
    );
    expect(warned).toBeDefined();
    const nudge = (warned?.payload as { nudge: string }).nudge;
    expect(nudge).toContain("请尽快收口");
    // 模型可见性：nudge 进入下一拍 decide 上下文（tool_result 摘要含 nudge）
    expect(contexts.length).toBeGreaterThan(1);
    expect(contexts[1]).toContain("预算提示");
    // 预算模型不可见：上下文不含预算旋钮与收口语
    expect(contexts.some((text) => text.includes("turn_token_budget"))).toBe(false);
    expect(contexts.some((text) => text.includes("est tokens）已用完"))).toBe(false);
  });
});

describe("层四：兜底保险丝（fuse 可配；人读『疑似异常循环』）", () => {
  it("注入 hardStepFuse=3 → 3 步触达收口 budget_exhausted；卡在哪行含熔断警示", { timeout: 120_000 }, async () => {
    let step = 0;
    const provider: LlmProvider = {
      providerId: "bl-fuse-model",
      decide: async () => {
        step += 1;
        return ok({ type: "assistant_message", text: `步骤 ${String(step)}` });
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`bl-fuse-${randomUUID()}`, "跑"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
      budgets: { hardStepFuse: 3 },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    expect(ran.value.outcome.kind).toBe("turn_failed");
    if (ran.value.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(ran.value.outcome.summary.reason).toBe("budget_exhausted");
    expect(ran.value.outcome.summary.limit).toBe(3);
    expect(ran.value.outcome.summary.blocked_description?.stuck_at).toContain("安全熔断线（3 步）触达");
    expect(ran.value.outcome.summary.blocked_description?.stuck_at).toContain("疑似异常循环");
  });
});

describe("层三：连续 provider 失败升级（≥3 轮人读强提示）", () => {
  const failingProvider: LlmProvider = {
    providerId: "bl-fail-model",
    decide: async () => {
      return { ok: false as const, error: { code: "provider_failure" as const, message: "模拟 provider 故障" } };
    },
  };
  const failErr = (message: string) => ({ ok: false as const, error: { code: "provider_failure" as const, message } });
  it("第 3 轮连续失败 → 卡在哪行含『连续 3 轮失败』升级提示；前两轮无", { timeout: 180_000 }, async () => {
    const runsRoot = runsRootOf();
    const runId = `bl-fail-${randomUUID()}`;
    const collapseOf = async (instruction: string, continueMode: boolean): Promise<BranchRunReport> => {
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, instruction), "main", {
        runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: failingProvider,
        approvalSurface: { stub: grantedStub },
        ...(continueMode ? { continue: { instruction } } : {}),
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("turn_failed");
      if (ran.value.outcome.kind !== "turn_failed") throw new Error("unreachable");
      return ran.value;
    };
    const first = await collapseOf("第一轮", false);
    if (first.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(first.outcome.summary.blocked_description?.stuck_at).not.toContain("连续");
    await collapseOf("第二轮", true);
    const third = await collapseOf("第三轮", true);
    if (third.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(third.outcome.summary.blocked_description?.stuck_at).toContain("连续 3 轮失败");
    expect(third.outcome.summary.reason).toBe("provider_failure");
  });
  it("failErr 构造形状自检（错误码结构化可区分）", () => {
    expect(failErr("x").error.code).toBe("provider_failure");
  });
});
