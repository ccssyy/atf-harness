/**
 * 走查修复批 B2（2026-09-23，指令 7158bf43；走查报告 8628d036 §三 B2）：孤儿 turn
 * 受控修复通道——进程异常退出致末 turn 无 turn/end 的恢复面。
 * 覆盖：CLI 参数面（显式旗标＋与 --answer 互斥）／诊断纯函数（实计口径）／E2E 三态：
 * 孤儿流无旗标仍拒收（fail-closed 回归）→ 旗标修复（合成事件带 projection 位＋note 留痕）
 * → continue 走通。
 * F4 批（2026-09-26，指令 docs/_owner/ATF-Harness_指令_F4_孤儿turn审批恢复死锁_20260925.md）：
 * 孤儿＋待办审批死锁修复——待办批处理合成 denied（origin=orphan_recovery_batch 机器来源
 * 标记，非人工应答；--note 传真实处置）；恢复后 continue 走通（死锁出口）；孤儿＋resume
 * answer 仍拒（suspended 前置零放松，防回归）。
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
  listPendingApprovals,
  parseResumeArgs,
  parseSessionStream,
  readSessionStream,
  recoverOrphanTurn,
  sessionLogPathFor,
  ORPHAN_RECOVERED_REASON,
  ORPHAN_RECOVERY_ACTOR,
  ORPHAN_RECOVERY_DENY_REASON,
  ORPHAN_RECOVERY_ORIGIN,
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

  it("F4 死锁出口：孤儿＋待办审批 → 批处理恢复成功（denied＋机器来源标记）→ continue 走通；重跑幂等（no_orphan）", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-orphan-pending";
    // 挂起流：turn/end(suspended) + 流内待办审批（timeout 应答非终态）——事故形态
    // （走查 v077g run-regress-v077g 同构：审批挂起窗口内进程被终止 → 孤儿 turn ＋ 待办）
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
    const pendingBefore = orphanStream.ok ? listPendingApprovals(orphanStream.value).length : -1;
    expect(pendingBefore).toBe(1);
    const beforeCount = orphanStream.ok ? orphanStream.value.length : 0;

    // F4 死锁出口实锤：修复前 answer 与 recover 互斥拒收（见下一用例），修复通道现一并批处理待办
    const recovered = await recoverOrphanTurn(sessionLogPath);
    expect(recovered.ok, !recovered.ok ? JSON.stringify(recovered.error) : "").toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    const { event, diagnosis, batch_responses } = recovered.value;
    // 批处理应答形态：恰 1 条、verdict=denied（恒 denied 不伪造授权）、机器来源标记、缺省 reason
    expect(batch_responses.length).toBe(1);
    const batchPayload = batch_responses[0]?.payload as Record<string, unknown>;
    expect(batch_responses[0]?.type).toBe("approval/response");
    expect(batch_responses[0]?.id).toBe(beforeCount + 1); // 应答先于收口落盘（账本时序）
    expect(batchPayload["verdict"]).toBe("denied");
    expect(batchPayload["actor"]).toBe(ORPHAN_RECOVERY_ACTOR);
    expect(batchPayload["origin"]).toBe(ORPHAN_RECOVERY_ORIGIN);
    expect(batchPayload["reason"]).toBe(ORPHAN_RECOVERY_DENY_REASON);
    expect(String(batchPayload["reason"])).toContain("非人工应答");
    // 合成收口：reason=orphan_recovered、note 带批处理留痕、id 连续
    expect(event.id).toBe(beforeCount + 2);
    expect((event.payload as { reason?: string }).reason).toBe(ORPHAN_RECOVERED_REASON);
    expect((event.payload as { note?: string }).note).toContain("批处理");
    expect((event.payload as { note?: string }).note).toContain("1 条已合成 denied");
    // 待办清零 + 全流解析通过（id 连续无断号）
    const after = await readSessionStream(sessionLogPath);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(listPendingApprovals(after.value).length).toBe(0);
      expect(after.value.map((item) => item.id)).toEqual(Array.from({ length: after.value.length }, (_, i) => i + 1));
    }
    // 死锁出口闭环：恢复后 run 回到干净收口态，continue 开新 turn 至 completed
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
    // 重跑幂等：孤儿已收口 → no_orphan 结构化拒绝（流零改动）
    const rerun = await recoverOrphanTurn(sessionLogPath);
    expect(rerun.ok).toBe(false);
    if (!rerun.ok) {
      expect(rerun.error.code).toBe("no_orphan");
      expect(rerun.error.message).toContain("已收口");
    }
  });

  it("F4：--note 传真实处置 → 批处理应答 reason=note（机器标记 origin 不变）", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-orphan-note";
    const suspended = await ScenarioRunner.runBranch(scenarioOf(runId, "触发准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-note" } }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) throw new Error("unreachable");
    expect(suspended.value.outcome.kind).toBe("suspended");
    const sessionLogPath = sessionLogPathFor(runsRoot, runId);
    await truncateLastTurnEnd(sessionLogPath);
    const recovered = await recoverOrphanTurn(sessionLogPath, { note: "真实处置：该提案已过时，勿重提" });
    expect(recovered.ok, !recovered.ok ? JSON.stringify(recovered.error) : "").toBe(true);
    if (!recovered.ok) throw new Error("unreachable");
    expect(recovered.value.batch_responses.length).toBe(1);
    const payload = recovered.value.batch_responses[0]?.payload as Record<string, unknown>;
    expect(payload["reason"]).toBe("真实处置：该提案已过时，勿重提");
    expect(payload["origin"]).toBe(ORPHAN_RECOVERY_ORIGIN); // 机器来源标记恒在（审计可分辨）
    expect(payload["verdict"]).toBe("denied");
  });

  it("F4 防回归：孤儿＋待办审批 → resume --answer 仍拒（suspended 前置零放松，流零改动）", async () => {
    const runsRoot = runsRootOf();
    const runId = "b2-orphan-answer";
    const suspended = await ScenarioRunner.runBranch(scenarioOf(runId, "触发准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-ans" } }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) throw new Error("unreachable");
    expect(suspended.value.outcome.kind).toBe("suspended");
    const sessionLogPath = sessionLogPathFor(runsRoot, runId);
    await truncateLastTurnEnd(sessionLogPath);
    const orphanStream = await readSessionStream(sessionLogPath);
    const beforeCount = orphanStream.ok ? orphanStream.value.length : 0;
    expect(orphanStream.ok && diagnoseOrphanTurn(orphanStream.value) !== null).toBe(true);
    // answer 通道对孤儿流照旧 fail-closed：末 turn 未以 suspended 收口（死锁半边护栏不动）
    const refused = await ScenarioRunner.runBranch(scenarioOf(runId, "应答续跑"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: scripted([{ type: "final_answer", text: "不应到达" }]),
      approvalSurface: { stub: timeoutStub },
      resume: { verdict: "denied", note: "不应被执行的应答" },
    });
    expect(refused.ok).toBe(true);
    if (!refused.ok) throw new Error("unreachable");
    expect(refused.value.outcome.kind).toBe("failed");
    const message = refused.value.outcome.kind === "failed" ? refused.value.outcome.error.message : "";
    expect(message).toContain("末 turn 未以 suspended 收口");
    expect(message).toContain("仅挂起 run 可恢复");
    // 流零改动：事件数不变、仍为孤儿＋待办
    const after = await readSessionStream(sessionLogPath);
    expect(after.ok && after.value.length === beforeCount).toBe(true);
    expect(after.ok && diagnoseOrphanTurn(after.value) !== null).toBe(true);
    expect(after.ok && listPendingApprovals(after.value).length).toBe(1);
  });

  it("对照：已收口流（无孤儿）→ no_orphan 拒绝；流不存在 → invalid_input", async () => {
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
