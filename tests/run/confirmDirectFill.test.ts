/**
 * 批 2.5 §一 A2.5（2026-09-22）：确认直填 runner 级验收——核心判据＝确认值 → 落盘
 * tool/call params 逐字节一致（无模型参与）；审计轨＝user/message(ui)＋tool/call(ui)＋
 * approval 链＋tool/result 完整；模型第一拍读到执行结果（决策面收窄为读结果走下一步）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { ScenarioRunner } from "../../src/core/run/index.js";
import type { LlmDecision, LlmProvider, Scenario } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";

const runsRootOf = (): string => `tmp/test-confirm-fill-${randomUUID()}`;
const mockPath = new URL("../../tests/fixtures/mock_atf.mjs", import.meta.url).pathname ?? "tests/fixtures/mock_atf.mjs";

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "confirm-fill",
  version: 1,
  provider: "faux" as const,
  description: "A2.5",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "a2.5",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed" as const, exit_code: 0 as const },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "a25-host" });

/** 捕获 decide 上下文＋按脚本回放决策（模型面桩）。 */
const scriptedProvider = (decisions: LlmDecision[], seen: Array<readonly LlmContextEvent[]>): LlmProvider => {
  let index = 0;
  return {
    providerId: "a25-stub-model",
    decide: async (context) => {
      seen.push(context);
      const next = decisions[index];
      index += 1;
      return ok(next ?? { type: "final_answer", text: "收口。" });
    },
  };
};

describe("A2.5 确认直填（runner 级核心判据）", () => {
  it("continue.pendingAction → 落盘 tool/call params 与确认值逐字节一致＋ui 留痕＋审批链完整＋模型第一拍读到结果", { timeout: 120_000 }, async () => {
    const runsRoot = runsRootOf();
    const runId = `a25-fill-${randomUUID()}`;
    // seed 轮：continue 前置要求流内存在已收口 turn
    const seed = await ScenarioRunner.runBranch(scenarioOf(runId, "首turn"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scriptedProvider([{ type: "final_answer", text: "首turn。" }], []),
      approvalSurface: { stub: grantedStub },
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) throw new Error("unreachable");
    const CONFIRMED_CLUSTER_PARAMS = {
      algorithm_version: "bbox_layout_v1",
      granularity: "page",
      linkage: "average",
      metric: "cosine",
      min_cluster_size: "1",
      threshold: "auto_candidates",
    };
    const seen: LlmContextEvent[][] = [];
    const provider = scriptedProvider([
      { type: "final_answer", text: "已按确认参数完成聚类。" },
    ], seen);
    const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "按确认参数执行聚类"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
      continue: {
        instruction: "【确认卡·聚类参数】已逐项确认。系统将按确认值直接执行（确定性合成，不经模型改写）。",
        pendingAction: {
          tool: "atf_style_cluster_execute",
          params: { dataset_id: "ds-3b7551bca6ec", cluster_params: CONFIRMED_CLUSTER_PARAMS },
          origin: "confirm_card",
        },
      },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;

    // 核心判据：落盘 tool/call params 与确认值逐字节一致（确定性合成——无模型参与）
    const call = report.events.find((event) => event.type === "tool/call");
    expect(call).toBeDefined();
    expect(call?.payload).toMatchObject({ tool: "atf_style_cluster_execute" });
    expect(JSON.stringify((call?.payload as { params: { cluster_params: unknown } }).params.cluster_params))
      .toBe(JSON.stringify(CONFIRMED_CLUSTER_PARAMS));
    // ui 审计位（模型不可见——convertToLlm 恒剥离）
    expect(call?.ui).toMatchObject({ confirm_card: { origin: "confirm_card", synthesized: true } });
    // user/message ui 位（L1c 缺口闭环）
    const userMessages = report.events.filter((event) => event.type === "user/message");
    const confirmMessage = userMessages[userMessages.length - 1]; // 末条＝确认文本（seed 轮在前）
    expect(confirmMessage?.payload).toMatchObject({ text: expect.stringContaining("确定性合成") });
    expect(confirmMessage?.ui).toMatchObject({ confirm_card: { origin: "confirm_card", synthesized: true } });
    // 审批链完整（第二道人审：写动作走 CAS 问答轨）
    expect(report.events.some((event) => event.type === "approval/request")).toBe(true);
    expect(report.events.some((event) => event.type === "approval/response")).toBe(true);
    // 结果回流（mock 无此数据集登记 → 业务拒绝路径同样成立：call_ref 配对、guidance 回流、
    // 循环继续——合成器对“执行成功/业务拒绝”两态的审计链一致）
    const result = report.events.find((event) => event.type === "tool/result");
    expect(result?.payload).toMatchObject({ tool: "atf_style_cluster_execute" });
    expect((result?.payload as { call_ref?: unknown }).call_ref).toBe((call as { id: number }).id);
    // 模型第一拍：decide 上下文包含 tool/call＋tool/result（决策面收窄为读结果）
    expect(seen.length).toBeGreaterThan(0);
    const firstContextTypes = seen[0]?.map((event) => event.type) ?? [];
    expect(firstContextTypes).toContain("tool/call");
    expect(firstContextTypes).toContain("tool/result");
    // 模型上下文不含 ui 审计位
    const contextCall = seen[0]?.find((event) => event.type === "tool/call");
    expect(contextCall && "ui" in contextCall).toBe(false);
  });

  it("无 pendingAction 的 continue 不派发（既有语义零改动）", { timeout: 120_000 }, async () => {
    const runsRoot = runsRootOf();
    const runId = `a25-plain-${randomUUID()}`;
    const seedProvider = scriptedProvider([{ type: "final_answer", text: "首turn。" }], []);
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "首turn"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: seedProvider,
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok).toBe(true);
    const seen: LlmContextEvent[][] = [];
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "普通新指令"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scriptedProvider([{ type: "final_answer", text: "完成。" }], seen),
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "普通新指令" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.events.some((event) => event.type === "tool/call")).toBe(false);
    expect(second.value.events.some((event) => event.type === "approval/request")).toBe(false);
  });
});
