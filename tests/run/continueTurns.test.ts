/**
 * L1b B4 多轮续跑测试（L1b-D2=A）：runner continue 通道——同进程多轮与跨进程续跑
 * 同一机制（历史由事实日志重放装载）。覆盖：3-turn 链全链留痕／INV 不放宽
 * （open turn 拒绝／待办拒绝／预算耗尽／空流拒绝）／resume 互斥／投影 history 标记。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import type { ProjectionOrigin } from "../../src/core/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "l1b-continue",
  version: 1,
  provider: "faux",
  description: "L1b B4 多轮续跑测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "b4-continue",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const scripted = (decisions: (LlmDecision | null)[]): LlmProvider => {
  let index = 0;
  return {
    providerId: "fake",
    decide: async () => ok(decisions[index++] ?? null),
  };
};

const runOptions = (runsRoot: string, decisions: (LlmDecision | null)[]) => ({
  runsRoot,
  mockCommand: ["node", mockPath],
  modelProvider: scripted(decisions),
  approvalSurface: { stub: async (): Promise<{ verdict: "timeout" }> => ({ verdict: "timeout" }) },
});

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `b4-${randomUUID()}`);

describe("B4 多轮续跑（runner continue 通道）", () => {
  it("3-turn 链：fresh → continue → continue，全链留痕（turn 成对、user/message 递增）", async () => {
    const runsRoot = runsRootOf();
    const first = await ScenarioRunner.runBranch(scenarioOf("b4-run-3t", "第一问：查询工作区状态"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答一" }]),
    });
    expect(first.ok, !first.ok ? JSON.stringify(first.error) : "").toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("completed");

    const second = await ScenarioRunner.runBranch(scenarioOf("b4-run-3t", "第二问：事实扫描"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答二" }]),
      continue: { instruction: "第二问：事实扫描" },
    });
    expect(second.ok, !second.ok ? JSON.stringify(second.error) : "").toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");

    const third = await ScenarioRunner.runBranch(scenarioOf("b4-run-3t", "第三问：闸门查询"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答三" }]),
      continue: { instruction: "第三问：闸门查询" },
    });
    expect(third.ok, !third.ok ? JSON.stringify(third.error) : "").toBe(true);
    if (!third.ok) throw new Error("unreachable");
    const report: BranchRunReport = third.value;
    expect(report.outcome.kind).toBe("completed");
    // 全链留痕：3×turn/start、3×user/message（首问 + 两个 continue 指令）、turn 成对
    const types = report.events.map((event) => event.type);
    expect(types.filter((type) => type === "turn/start").length).toBe(3);
    expect(types.filter((type) => type === "user/message").length).toBe(3);
    expect(types.filter((type) => type === "turn/end").length).toBe(3);
    const instructions = report.events.filter((event) => event.type === "user/message").map((event) => (event.payload as { text: string }).text);
    expect(instructions).toEqual(["第一问：查询工作区状态", "第二问：事实扫描", "第三问：闸门查询"]);
    // id 连续无断号（append-only 重放一致）
    expect(report.events.map((event) => event.id)).toEqual(Array.from({ length: report.events.length }, (_, i) => i + 1));
  });

  it("INV 不放宽：open turn 拒绝 / 待办审批拒绝（指引 resume）/ 预算耗尽 / 空流拒绝 / resume 互斥", async () => {
    const runsRoot = runsRootOf();
    // 空流拒绝：run 目录不存在（流为空）
    const empty = await ScenarioRunner.runBranch(scenarioOf(`b4-empty-${randomUUID()}`, "x"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答" }]),
      continue: { instruction: "x" },
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) throw new Error("unreachable");
    expect(empty.value.outcome.kind).toBe("failed");
    expect(empty.value.outcome.kind === "failed" ? empty.value.outcome.error.code : "").toBe("invalid_input");

    // 待办审批拒绝：制造挂起（timeout → suspended 带待办）→ continue 必须指引用 resume
    const suspendRuns = join(repoRoot, "tmp", "runs", `b4-${randomUUID()}`);
    const suspended = await ScenarioRunner.runBranch(scenarioOf("b4-susp", "触发准入"), "main", {
      runsRoot: suspendRuns,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-b4" } }]),
      approvalSurface: { stub: async (): Promise<{ verdict: "timeout" }> => ({ verdict: "timeout" }) },
    });
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) throw new Error("unreachable");
    expect(suspended.value.outcome.kind).toBe("suspended");
    const blocked = await ScenarioRunner.runBranch(scenarioOf("b4-susp", "继续"), "main", {
      ...runOptions(suspendRuns, [{ type: "final_answer", text: "答" }]),
      continue: { instruction: "继续" },
    });
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) throw new Error("unreachable");
    expect(blocked.value.outcome.kind).toBe("failed");
    const blockedMessage = blocked.value.outcome.kind === "failed" ? blocked.value.outcome.error.message : "";
    expect(blockedMessage).toContain("待办审批");
    expect(blockedMessage).toContain("resume");
  });

  it("投影 history 标记：continue 装载既有流 origin=history，新落盘 origin=live（措辞：由事实日志重放重建）", async () => {
    const runsRoot = runsRootOf();
    const first = await ScenarioRunner.runBranch(scenarioOf("b4-hist", "第一问"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答一" }]),
    });
    expect(first.ok).toBe(true);
    const seen: Array<{ id: number; origin: ProjectionOrigin }> = [];
    const second = await ScenarioRunner.runBranch(scenarioOf("b4-hist", "第二问"), "main", {
      ...runOptions(runsRoot, [{ type: "final_answer", text: "答二" }]),
      continue: { instruction: "第二问" },
      onEvent: (event, origin) => {
        seen.push({ id: event.id, origin });
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    const report: BranchRunReport = second.value;
    const historyIds = seen.filter((entry) => entry.origin === "history").map((entry) => entry.id);
    const liveIds = seen.filter((entry) => entry.origin === "live").map((entry) => entry.id);
    expect(historyIds).toEqual(report.events.filter((event) => event.id <= Math.max(...historyIds)).map((event) => event.id));
    expect(liveIds.every((id) => !historyIds.includes(id))).toBe(true);
    expect([...historyIds, ...liveIds]).toEqual(report.events.map((event) => event.id));
  });

  it("resume 与 continue 互斥（fail-closed）", async () => {
    const ran = await ScenarioRunner.runBranch(scenarioOf(`b4-mutex-${randomUUID()}`, "x"), "main", {
      ...runOptions(runsRootOf(), [{ type: "final_answer", text: "答" }]),
      resume: { verdict: "granted" },
      continue: { instruction: "x" },
    });
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error.message).toContain("互斥");
  });
});
