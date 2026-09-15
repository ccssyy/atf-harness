/**
 * core 投影面 × ScenarioRunner 同源测试（L1 门 2 T01，《ATF独立Harness_L1门2任务书_20260915.md》
 * §3 T01 / §4 验收项 2 的 core 侧支撑）：options.onEvent 投出的事件序列与分支报告 events
 * （= append-only 日志回读序）逐条一致——「三层前端共享同一条真相」的投影侧判据。
 *
 * 场景：live 轨（全新 run，含 turn/start→assistant/message→final_answer→turn/end）与
 * history 轨（挂起 run 的 resume 装载：先收到既有流 origin=history，再续投 live）。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "../../src/core/run/index.js";
import type { ProjectionOrigin, RunEventSubscriber } from "../../src/core/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const finalAnswerScenario = (): Scenario => ({
  scenario_id: "core-projection",
  version: 1,
  provider: "faux",
  description: "core 投影同源测试场景",
  branches: {
    main: {
      branch_id: "main",
      run_id: `core-projection-${randomUUID()}`,
      trigger_instruction: "core 投影同源测试触发指令",
      purpose: "onEvent 投影与日志逐条一致",
      setup: { ledger: [] },
      steps: [
        { type: "assistant_message", text: "过程消息" },
        { type: "final_answer", text: "完成" },
      ],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const scriptedProvider = (decisions: (LlmDecision | null)[]): LlmProvider => {
  let index = 0;
  return {
    providerId: "faux",
    decide: async () => {
      const next = decisions[index];
      index += 1;
      return ok(next ?? null);
    },
  };
};

const recorder = (): { subscriber: RunEventSubscriber; seen: Array<{ id: number; origin: ProjectionOrigin }> } => {
  const seen: Array<{ id: number; origin: ProjectionOrigin }> = [];
  return {
    seen,
    subscriber: (event, origin) => {
      seen.push({ id: event.id, origin });
    },
  };
};

describe("core 投影同源（T01）", () => {
  it("live 轨：onEvent 投出的 id 序列 = 报告 events 序列，全部 origin=live", async () => {
    const { subscriber, seen } = recorder();
    const ran = await ScenarioRunner.runBranch(finalAnswerScenario(), "main", {
      runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
      mockCommand: ["node", mockPath],
      modelProvider: scriptedProvider([{ type: "final_answer", text: "完成" }]),
      onEvent: subscriber,
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    expect(seen.map((item) => item.id)).toEqual(report.events.map((event) => event.id));
    expect(seen.every((item) => item.origin === "live")).toBe(true);
  });

  it("history 轨：resume 先投既有流（history）再续投 live，拼接后与全流一致", async () => {
    const runsRoot = join(repoRoot, "tmp", "runs", `test-${randomUUID()}`);
    // 第一段：制造挂起 run（atf_admit_data 无账本预录 → 问答轨；stub timeout → suspended, exit 75）
    const suspendedScenario = finalAnswerScenario();
    suspendedScenario.branches.main!.steps = [
      { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-core-proj" } },
    ];
    const first = await ScenarioRunner.runBranch(suspendedScenario, "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scriptedProvider([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-core-proj" } }]),
      approvalSurface: { stub: async (): Promise<ApprovalStubResponse> => ({ verdict: "timeout" }) },
    });
    expect(first.ok, !first.ok ? JSON.stringify(first.error) : "").toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("suspended");
    const firstEventIds = first.value.events.map((event) => event.id);

    // 第二段：resume（granted 放行重派）——先收 history 再收 live
    const { subscriber, seen } = recorder();
    const second = await ScenarioRunner.runBranch(suspendedScenario, "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scriptedProvider([{ type: "final_answer", text: "完成" }]),
      approvalSurface: { stub: async (): Promise<ApprovalStubResponse> => ({ verdict: "granted" }) },
      resume: { verdict: "granted", note: "投影同源测试放行" },
      onEvent: subscriber,
    });
    expect(second.ok, !second.ok ? JSON.stringify(second.error) : "").toBe(true);
    if (!second.ok) throw new Error("unreachable");
    const report = second.value;
    expect(report.outcome.kind).toBe("completed");
    const historyIds = seen.filter((item) => item.origin === "history").map((item) => item.id);
    const liveIds = seen.filter((item) => item.origin === "live").map((item) => item.id);
    // history 段 = 上进程已落盘全流（含本进程应答前装载的挂起流）
    expect(historyIds).toEqual(firstEventIds);
    // 拼接序 = 报告全流序（INV-A：恢复只读本侧事件流，投影与其逐条一致）
    expect([...historyIds, ...liveIds]).toEqual(report.events.map((event) => event.id));
  });
});
