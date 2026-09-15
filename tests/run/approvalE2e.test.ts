import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Scenario } from "../../src/llm/index.js";
import {
  ScenarioRunner,
  resolveRunExitCode,
  type ApprovalStubResponse,
  type BranchRunReport,
} from "../../src/core/run/index.js";
import type { ScenarioStep } from "../../src/llm/index.js";

/**
 * P2-S2 问答轨 runner 端到端测试(决议 §3 验收:六类应答正反例 / supersedes 链 /
 * 拒绝循环升级 / headless 等价性 / 退出码单出口)。桩对端为测试注入,非运行时依赖路径。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const ADMIT = { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-p2s2" } } as const;
const STATUS = { type: "tool_call", tool: "atf_workspace_status", params: {} } as const;
const DONE = { type: "final_answer", text: "收束" } as const;

let runSeq = 0;
const makeScenario = (steps: readonly ScenarioStep[]): Scenario => ({
  scenario_id: `p2s2-e2e-${++runSeq}`,
  version: 1,
  provider: "faux",
  description: "P2-S2 问答轨 e2e",
  branches: {
    main: {
      branch_id: "main",
      run_id: `run-p2s2-e2e-${runSeq}`,
      trigger_instruction: "问答轨端到端",
      purpose: "P2-S2",
      setup: { ledger: [] }, // 无预录:审批走问答轨(账本轨优先,未命中)
      steps: [...steps],
      // 类型必填的占位期望;问答轨分支的实际断言见各用例(直接断言 outcome/exit_code/事件)
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const scriptStub = (responses: ApprovalStubResponse[]) => {
  let i = 0;
  return async (): Promise<ApprovalStubResponse> => {
    const next = responses[i];
    i += 1;
    return next ?? { verdict: "timeout" };
  };
};

const runBranch = async (scenario: Scenario, stub?: (input: never) => Promise<ApprovalStubResponse>): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    ...(stub !== undefined ? { approvalSurface: { stub: stub as never } } : {}),
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

const approvalEvents = (report: BranchRunReport): { requests: number; responses: number; payloads: Record<string, unknown>[] } => {
  const approval = report.events.filter((event) => event.type === "approval/request" || event.type === "approval/response");
  return {
    requests: approval.filter((event) => event.type === "approval/request").length,
    responses: approval.filter((event) => event.type === "approval/response").length,
    payloads: approval.map((event) => event.payload as Record<string, unknown>),
  };
};

describe("P2-S2 e2e——granted 主路径(凭据成立 → 执行 → exit 0)", () => {
  it("无预录 + 审批面声明 + granted:call_ref 结果回填,退出码 0", async () => {
    const report = await runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "granted", actor: "stub-host" }]));
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const approval = approvalEvents(report);
    expect(approval.requests).toBe(1);
    const call = report.events.find((event) => event.type === "tool/call");
    const result = report.events.find((event) => event.type === "tool/result");
    expect((result?.payload as { call_ref?: number }).call_ref).toBe(call?.id); // A1/R3 精确配对
    expect((result?.payload as { ok?: boolean }).ok).toBe(true);
    expect(report.replay?.kind).toBe("replayed"); // 全流可重建
  });
});

describe("P2-S2 e2e——advised 重提案(supersedes 演化链)", () => {
  it("advised → 意见回填 → 模型重提(同 params)→ granted → exit 0;链可审计", async () => {
    const report = await runBranch(
      makeScenario([ADMIT, ADMIT, DONE]),
      scriptStub([
        { verdict: "advised", actor: "stub-host", advice_text: "用正式编号重提" },
        { verdict: "granted", actor: "stub-host" },
      ]),
    );
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const { requests, payloads } = approvalEvents(report);
    expect(requests).toBe(2);
    const requestEvents = report.events.filter((event) => event.type === "approval/request");
    expect(requestEvents[1]?.payload).toMatchObject({ attempt: 2, supersedes: requestEvents[0]?.id });
    const advised = payloads.find((payload) => payload["verdict"] === "advised");
    expect((advised?.["advice_text"] as string).length).toBeGreaterThan(0); // 意见原文必留
    // S2a 区分性:advised 轮的结构化回填 reason = approval_advised(≠ denied 的 approval_denied)
    const advisedResult = report.events.find((event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "approval_advised");
    expect(advisedResult).toBeDefined();
    // 审计可回答:最终执行的 request2 基于 request1 的意见(supersedes 指回)
  });
});

describe("P2-S2 e2e——denied 换路径(非终局)", () => {
  it("denied → 结构化回填 → 模型换路径(免审批工具)→ exit 0", async () => {
    const report = await runBranch(
      makeScenario([ADMIT, STATUS, DONE]),
      scriptStub([{ verdict: "denied", actor: "stub-host", reason: "数据集未备案" }]),
    );
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const deniedResult = report.events.find((event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "approval_denied");
    expect(deniedResult).toBeDefined(); // 结构化回填在流内
    const statusResult = report.events.filter((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === true);
    expect(statusResult.length).toBeGreaterThanOrEqual(1); // 换路径后继续执行
  });
});

describe("P2-S2 e2e——aborted 终态(79)", () => {
  it("应答 verdict=abort → run 终态 aborted,exit 79", async () => {
    const report = await runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "aborted", actor: "stub-host", reason: "任务取消" }]));
    expect(report.outcome.kind).toBe("aborted");
    expect(report.exit_code).toBe(79);
  });
});

describe("P2-S2 e2e——clarification 多轮(同一审批会话)", () => {
  it("clarification → 同 session 重发 → granted → exit 0", async () => {
    const report = await runBranch(
      makeScenario([ADMIT, DONE]),
      scriptStub([
        { verdict: "clarification", actor: "stub-host", question: "来源?" },
        { verdict: "granted", actor: "stub-host" },
      ]),
    );
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const { requests, payloads } = approvalEvents(report);
    expect(requests).toBe(2);
    const sessions = new Set(payloads.filter((payload) => "approval_session_id" in payload).map((payload) => payload["approval_session_id"]));
    expect(sessions.size).toBe(1); // 多轮配对同一审批会话
  });
});

describe("P2-S2 e2e——timeout 挂起(75,超时非否决)", () => {
  it("timeout → suspended,exit 75;response actor = harness", async () => {
    const report = await runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "timeout" }]));
    expect(report.outcome.kind).toBe("suspended");
    expect(report.exit_code).toBe(75);
    const response = report.events.find((event) => event.type === "approval/response");
    expect(response?.payload).toMatchObject({ verdict: "timeout", actor: "harness" });
  });
});

describe("P2-S2 e2e——拒绝循环升级(阈值 2,第 3 次提案)", () => {
  it("三次同提案:第 1/2 次 denied,第 3 次升级 aborted → exit 79", async () => {
    const report = await runBranch(
      makeScenario([ADMIT, ADMIT, ADMIT, DONE]),
      scriptStub([
        { verdict: "denied", actor: "stub-host", reason: "r1" },
        { verdict: "denied", actor: "stub-host", reason: "r2" },
      ]),
    );
    expect(report.outcome.kind).toBe("aborted");
    expect(report.exit_code).toBe(79);
    const { requests } = approvalEvents(report);
    expect(requests).toBe(2); // 第 3 次提案未落 request(升级拦截)
  });
});

describe("P2-S2 e2e——headless 等价性(口径 #7)", () => {
  it("审批面未声明 + 无预录 → blocked(approval_missing) exit 78(Phase 1 逐位一致)", async () => {
    const report = await runBranch(makeScenario([ADMIT, DONE])); // 无 approvalSurface
    expect(report.outcome.kind).toBe("approval_missing");
    expect(report.exit_code).toBe(78);
    expect(approvalEvents(report).requests).toBe(0); // 不发问答 request
  });
});

describe("P2-S2 退出码单出口(A3)", () => {
  it("resolveRunExitCode:suspended→75 / aborted→79 / failed(credential_indeterminate)→1", () => {
    expect(resolveRunExitCode({ kind: "suspended", block: { reason: "approval_timeout", message: "m", tool: "atf_admit_data", exit_code: 75 } })).toBe(75);
    expect(resolveRunExitCode({ kind: "aborted", block: { reason: "approval_aborted", message: "m", tool: "atf_admit_data", exit_code: 79 } })).toBe(79);
    expect(resolveRunExitCode({ kind: "failed", error: { code: "credential_indeterminate", message: "m" } })).toBe(1);
  });
});
