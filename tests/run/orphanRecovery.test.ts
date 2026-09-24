/**
 * 走查修复批 B2（2026-09-23，指令 7158bf43；走查报告 8628d036 §三 B2）：孤儿 turn
 * 受控修复通道——进程异常退出致末 turn 无 turn/end 的恢复面。
 * 覆盖：CLI 参数面（显式旗标＋与 --answer 互斥）／诊断纯函数（实计口径）／E2E 三态：
 * 孤儿流无旗标仍拒收（fail-closed 回归）→ 旗标修复（合成事件带 projection 位＋note 留痕）
 * → continue 走通；孤儿＋待办审批 → 拒绝并指引（流零改动）。
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import {
  ScenarioRunner,
  diagnoseOrphanTurn,
  parseResumeArgs,
  parseSessionStream,
  readSessionStream,
  recoverOrphanTurn,
  sessionLogPathFor,
  ORPHAN_RECOVERED_REASON,
  type BranchRunReport,
} from "../../src/core/run/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "walkthrough-fix-b2",
  version: 1,
  provider: "faux",
  description: "走查修复批 B2 孤儿 turn 恢复面测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "b2-orphan-recovery",
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

const timeoutStub = async (): Promise<{ verdict: "timeout" }> => ({ verdict: "timeout" });

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `b2-${randomUUID()}`);

/** 模拟崩溃孤儿：物理删除流尾最后一个 turn/end 行（= 该收口从未写盘）。 */
const truncateLastTurnEnd = async (sessionLogPath: string): Promise<void> => {
  const text = await readFile(sessionLogPath, "utf8");
  const lines = text.split("\n");
  const lastEventIndex = lines.map((line) => line.trim() !== "").lastIndexOf(true);
  if (lastEventIndex < 0 || !lines[lastEventIndex]?.includes('"turn/end"')) {
    throw new Error("测试前置失败：流尾末行不是 turn/end");
  }
  lines.splice(lastEventIndex, 1);
  await writeFile(sessionLogPath, lines.join("\n"));
};

describe("B2 CLI 参数面（parseResumeArgs）", () => {
  it("--recover-orphan-turn 显式旗标 → mode=recover-orphan；runs-root/run-id 必填", () => {
    const parsed = parseResumeArgs(["--recover-orphan-turn", "--runs-root", "/tmp/r", "--run-id", "run-1"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode).toBe("recover-orphan");
    expect(parseResumeArgs(["--recover-orphan-turn", "--runs-root", "/tmp/r"]).ok).toBe(false);
  });

  it("--recover-orphan-turn 与 --answer 互斥（fail-closed）", () => {
    const parsed = parseResumeArgs([
      "--recover-orphan-turn", "--answer", "granted", "--runs-root", "/tmp/r", "--run-id", "run-1", "--scenario-id", "s",
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("互斥");
  });
});

describe("B2 诊断纯函数（diagnoseOrphanTurn）", () => {
  it("末 turn 未收口 → 诊断（turn_index/step_count/decision_count 按流内实计）", () => {
    const events = [
      { id: 1, ts: "t", type: "turn/start", payload: {}, projection: { evidence_event: null } },
      { id: 2, ts: "t", type: "tool/call", payload: { tool: "atf_fact_scan", params: {} }, projection: { evidence_event: null } },
      { id: 3, ts: "t", type: "tool/result", payload: { tool: "atf_fact_scan", ok: true, result: {}, call_ref: 2 }, projection: { evidence_event: null } },
    ] as const;
    const diagnosis = diagnoseOrphanTurn(events);
    expect(diagnosis).not.toBeNull();
    expect(diagnosis?.turn_index).toBe(1);
    expect(diagnosis?.step_count).toBe(1); // tool/call 实计（tool/result 不计步）
    expect(diagnosis?.decision_count).toBe(1);
    expect(diagnosis?.last_event_id).toBe(3);
  });

  it("末 turn 已收口 / 流内无 turn → null（无孤儿）", () => {
    const closed = [
      { id: 1, ts: "t", type: "turn/start", payload: {}, projection: { evidence_event: null } },
      { id: 2, ts: "t", type: "turn/end", payload: { reason: "completed" }, projection: { evidence_event: null } },
    ] as const;
    expect(diagnoseOrphanTurn(closed)).toBeNull();
    expect(diagnoseOrphanTurn([])).toBeNull();
  });
});

describe("B2 E2E：孤儿流修复 → continue 走通（无旗标仍拒收）", () => {
  it("构造孤儿流 → 无旗标 continue 拒收（fail-closed 回归）→ 旗标修复 → continue completed", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-orphan-main";
    // 1 turn：只读查询 + 收尾答复（turn 内 2 内容步、2 决策）
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "查询工作区状态"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([
        { type: "tool_call", tool: "atf_workspace_status", params: {} },
        { type: "final_answer", text: "状态已查询。" },
      ]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(first.ok, !first.ok ? JSON.stringify(first.error) : "").toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("completed");

    const sessionLogPath = sessionLogPathFor(runsRoot, runId);
    await truncateLastTurnEnd(sessionLogPath);

    // fail-closed 回归：无旗标 → continue 仍拒收（末 turn 未收口）
    const refused = await ScenarioRunner.runBranch(scenarioOf(runId, "续跑新指令"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "final_answer", text: "不应到达" }]),
      approvalSurface: { stub: timeoutStub },
      continue: { instruction: "续跑新指令" },
    });
    expect(refused.ok).toBe(true);
    if (!refused.ok) throw new Error("unreachable");
    expect(refused.value.outcome.kind).toBe("failed");
    const refusedMessage = refused.value.outcome.kind === "failed" ? refused.value.outcome.error.message : "";
    expect(refusedMessage).toContain("末 turn 未收口");
    expect(refusedMessage).toContain("fail-closed");
    // 拒收不写盘：流仍为孤儿
    const stillOrphan = await readSessionStream(sessionLogPath);
    expect(stillOrphan.ok && diagnoseOrphanTurn(stillOrphan.value) !== null).toBe(true);

    // 旗标修复（core 恢复通道，与 CLI --recover-orphan-turn 同一实现）
    const beforeCount = stillOrphan.ok ? stillOrphan.value.length : 0;
    const recovered = await recoverOrphanTurn(sessionLogPath);
    expect(recovered.ok, !recovered.ok ? JSON.stringify(recovered.error) : "").toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    const { event, diagnosis } = recovered.value;
    // 合成事件形态：id 连续、projection 字段位（schema v1 必需）、reason=orphan_recovered、
    // step_count 按流内实计（本流 = 1 tool/call + 1 assistant/message）、note 留痕
    expect(event.id).toBe(beforeCount + 1);
    expect(event.type).toBe("turn/end");
    expect(event.projection).toEqual({ evidence_event: null });
    expect(diagnosis.turn_index).toBe(1);
    expect(diagnosis.step_count).toBe(2);
    expect(diagnosis.decision_count).toBe(2);
    expect((event.payload as { reason?: string }).reason).toBe(ORPHAN_RECOVERED_REASON);
    expect((event.payload as { step_count?: number }).step_count).toBe(2);
    expect((event.payload as { decision_count?: number }).decision_count).toBe(2);
    expect((event.payload as { note?: string }).note).toContain("孤儿 turn 受控修复");
    // 修复后流完整性：全量解析通过（id 连续无断号）
    const after = await readSessionStream(sessionLogPath);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value.map((item) => item.id)).toEqual(Array.from({ length: after.value.length }, (_, i) => i + 1));

    // resume 走通：修复后 continue 开新 turn 至 completed
    const resumed = await ScenarioRunner.runBranch(scenarioOf(runId, "续跑新指令"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "final_answer", text: "续跑完成。" }]),
      approvalSurface: { stub: timeoutStub },
      continue: { instruction: "续跑新指令" },
    });
    expect(resumed.ok, !resumed.ok ? JSON.stringify(resumed.error) : "").toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    const report: BranchRunReport = resumed.value;
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
  });

  it("孤儿 + 待办审批 → 拒绝并给指引（流零改动）；无孤儿（已收口）→ no_orphan 拒绝", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-orphan-pending";
    // 挂起流：turn/end(suspended) + 流内待办审批（timeout 应答非终态）
    const suspended = await ScenarioRunner.runBranch(scenarioOf(runId, "触发准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-b2" } }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) throw new Error("unreachable");
    expect(suspended.value.outcome.kind).toBe("suspended");

    const sessionLogPath = sessionLogPathFor(runsRoot, runId);
    await truncateLastTurnEnd(sessionLogPath);
    const orphanStream = await readSessionStream(sessionLogPath);
    expect(orphanStream.ok && diagnoseOrphanTurn(orphanStream.value) !== null).toBe(true);
    const beforeCount = orphanStream.ok ? orphanStream.value.length : 0;

    const refused = await recoverOrphanTurn(sessionLogPath);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("pending_approvals");
    expect(refused.error.message).toContain("待办审批");
    expect(refused.error.message).toContain("--list"); // 指引先经应答通道
    // 流零改动（fail-closed）：事件数不变、仍为孤儿
    const after = await readSessionStream(sessionLogPath);
    expect(after.ok && after.value.length === beforeCount).toBe(true);

    // 对照：已收口流（无孤儿）→ no_orphan
    const closedRefusal = await recoverOrphanTurn(sessionLogPathFor(runsRootOf(), "b2-nonexistent"));
    expect(closedRefusal.ok).toBe(false);
    if (!closedRefusal.ok) expect(closedRefusal.error.code).toBe("invalid_input"); // 流不存在
    const closedRunRoot = runsRootOf();
    const closedRunId = "b2-closed";
    const closed = await ScenarioRunner.runBranch(scenarioOf(closedRunId, "查询"), "main", {
      runsRoot: closedRunRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "final_answer", text: "答" }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(closed.ok).toBe(true);
    const closedRefusal2 = await recoverOrphanTurn(sessionLogPathFor(closedRunRoot, closedRunId));
    expect(closedRefusal2.ok).toBe(false);
    if (!closedRefusal2.ok) {
      expect(closedRefusal2.error.code).toBe("no_orphan");
      expect(closedRefusal2.error.message).toContain("已收口");
    }
  });

  it("合成事件经落盘格式核验（parseSessionStream 全量通过＝envelope/projection 合规）", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-envelope";
    const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "问"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "final_answer", text: "答" }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(ran.ok).toBe(true);
    const sessionLogPath = sessionLogPathFor(runsRoot, runId);
    await truncateLastTurnEnd(sessionLogPath);
    const recovered = await recoverOrphanTurn(sessionLogPath);
    expect(recovered.ok).toBe(true);
    // 全量信封校验（含 projection 字段位与 evidence_event=null 白名单）零违例
    const text = await readFile(sessionLogPath, "utf8");
    const parsed = parseSessionStream(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const last = parsed.value[parsed.value.length - 1];
      expect(last?.type).toBe("turn/end");
      expect((last?.payload as { reason?: string }).reason).toBe(ORPHAN_RECOVERED_REASON);
    }
  });
});
