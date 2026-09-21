import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../../src/core/run/index.js";
import { createRealPeerFixture, realPeerCliPath, type RealPeerFixture } from "./fixture.js";

/**
 * D-f 批真内核 e2e 三情形（门 2 放行件 §一：当前 pin v0.7.2b0 即可；零真实 provider——
 * 决策面为脚本桩，内核对端为真）。情形＝人为制造 (a) 步数耗尽 (b) 同参重复 (c) 缺关键输入，
 * 各自收口形态正确（含缺口卡四段）＋会话可续；结构化禁止 turn failed → 进程退出 的
 * runner 契约面（turn_failed 恒带 summary 落盘、exit 1）。
 * 真实写授权边界（R2 决议 §2.4）：仅 /tmp 夹具根内合成数据（df-e2e-* 标识）。
 */

const cli = realPeerCliPath();
const describeIfPinned = cli.ok ? describe : describe.skip;

const openFixtures: RealPeerFixture[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (openFixtures.length > 0) {
    const fixture = openFixtures.pop();
    if (fixture !== undefined) await fixture.cleanup().catch(() => undefined);
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "df-e2e",
  version: 1,
  provider: "faux",
  description: "D-f 真内核 e2e",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "df-real-peer-collapse",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "df-e2e-host" });

const runAgainstRealPeer = async (
  fixture: RealPeerFixture,
  provider: LlmProvider,
  instruction: string,
  options?: { continue?: boolean; runsRoot?: string },
): Promise<BranchRunReport> => {
  const runsRoot = options?.runsRoot ?? (await mkdtemp(join(tmpdir(), "df-e2e-runs-")));
  try {
    const ran = await ScenarioRunner.runBranch(scenarioOf(fixture.runId, instruction), "main", {
      runsRoot,
      mockCommand: {
        argv: fixture.serveSpawn().argv,
        cwd: fixture.serveSpawn().cwd,
        env: fixture.serveSpawn().env,
      },
      scopeMode: "canonical",
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
      ...(options?.continue === true ? { continue: { instruction } } : {}),
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    return ran.value;
  } finally {
    if (options?.runsRoot === undefined) await rm(runsRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

const turnEndPayload = (report: BranchRunReport): Record<string, unknown> => {
  const turnEnd = report.events.find((event) => event.type === "turn/end");
  return (turnEnd?.payload ?? {}) as Record<string, unknown>;
};

describeIfPinned("D-f 真内核 e2e——三情形收口（当前 pin）", () => {
  it(
    "(a) 步数耗尽：32 个互异 gate query → budget_exhausted turn 级收口＋stop_reason 保留",
    { timeout: 180_000 },
    async () => {
      const fixture = await createRealPeerFixture(`df-e2e-budget-${randomUUID().slice(0, 8)}`);
      openFixtures.push(fixture);
      let asked = 0;
      const provider: LlmProvider = {
        providerId: "df-e2e-model",
        decide: async () => {
          asked += 1;
          return ok({ type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query", evidence_refs: [`df-e2e-${String(asked)}`] } });
        },
      };
      const report = await runAgainstRealPeer(fixture, provider, "逐项核对闸门");
      expect(report.outcome.kind).toBe("turn_failed");
      expect(report.exit_code).toBe(1);
      if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
      expect(report.outcome.summary.reason).toBe("budget_exhausted");
      expect(report.outcome.summary.limit).toBe(32);
      expect(turnEndPayload(report)).toMatchObject({
        reason: "failed",
        stop_reason: "budget_exhausted",
        failure_summary: { reason: "budget_exhausted" },
      });
    },
  );

  it(
    "(b) 同参重复：fact_scan×3 ＋ workspace_status×3 → nudge → 双工具切断 → same_call_repeat 收口",
    { timeout: 180_000 },
    async () => {
      const fixture = await createRealPeerFixture(`df-e2e-repeat-${randomUUID().slice(0, 8)}`);
      openFixtures.push(fixture);
      const decisions: LlmDecision[] = [];
      for (let i = 0; i < 3; i += 1) decisions.push({ type: "tool_call", tool: "atf_fact_scan", params: {} });
      for (let i = 0; i < 3; i += 1) decisions.push({ type: "tool_call", tool: "atf_workspace_status", params: {} });
      const contexts: string[] = [];
      const provider: LlmProvider = {
        providerId: "df-e2e-model",
        decide: async (context) => {
          contexts.push(JSON.stringify(context));
          return ok(decisions.shift() ?? null);
        },
      };
      const report = await runAgainstRealPeer(fixture, provider, "盘点现场");
      expect(report.outcome.kind).toBe("turn_failed");
      if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
      expect(report.outcome.summary.reason).toBe("same_call_repeat");
      expect(report.outcome.summary.cut_tools).toEqual(["atf_fact_scan", "atf_workspace_status"]);
      // nudge 随回流进模型上下文（真内核链路上同样成立）
      expect(contexts.some((context) => context.includes("控制面提示"))).toBe(true);
    },
  );

  it(
    "(c) v0.7.3b0 新语义：无确认态且无合同料 → 准入按推导单元诚实执行（not_required，不再探索烧尽）→ completed＋会话可续（split_policy_missing 缺口卡语义由 mock 组⑤承载）",
    { timeout: 240_000 },
    async () => {
      const fixture = await createRealPeerFixture(`df-e2e-gap-${randomUUID().slice(0, 8)}`);
      openFixtures.push(fixture);
      // 料源＝四跑同源口径：走查批拷入 ws datasets/external/swb（源零写入），登记用相对
      // 路径（v0.7.3b0 实测：外部绝对路径登记 → invalid_params）。无确认态且无 skills 建议
      // → 内核以 split_policy_missing 诚实拒绝（K-Gap-2 口径）；缺口卡由 D-f-6 注册表出卡。
      const sourceRootAbs = join(fixture.wsRoot, "datasets", "external", "swb"); // 拷入夹具 ws（内核按 ws 根解析相对路径）
      const splitRootAbs = sourceRootAbs; // 四跑同根口径（v3b 实况）
      await mkdir(sourceRootAbs, { recursive: true });
      const { cp } = await import("node:fs/promises");
      await cp("/data/sam/atf-walkthrough/ds-multi-doc-20260920/swb", sourceRootAbs, { recursive: true });
      const queue: Array<{ type: "tool_call"; tool: string; params: Record<string, unknown> } | { type: "final_answer"; text: string }> = [
        { type: "tool_call", tool: "atf_admit_data", params: { source_root: "datasets/external/swb", split_root: "datasets/external/swb" } },
        { type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: "ds-x" } },
        { type: "final_answer", text: "工作区已按推导单元完成准入检查，结果已汇报。" },
      ];
      const provider: LlmProvider = {
        providerId: "df-e2e-model",
        decide: async (context) => {
          const next = queue.shift();
          if (next === undefined) return ok({ type: "final_answer", text: "已停止。" });
          if (next.type === "tool_call") {
            const params = { ...next.params } as Record<string, unknown>;
            // 仅准入申请做派生 id 替换（登记为自动形态，不得携带 dataset_id——双形态互斥）
            if (next.tool === "atf_data_admission_request") {
              params["dataset_id"] = /ds-[0-9a-f]{12}/.exec(JSON.stringify(context))?.[0] ?? "ds-unresolved";
            }
            return ok({ type: "tool_call", tool: next.tool, params });
          }
          return ok(next);
        },
      };
      const runsRoot = await mkdtemp(join(tmpdir(), "df-e2e-runs-"));
      tempRoots.push(runsRoot, splitRootAbs);
      const report = await runAgainstRealPeer(fixture, provider, "对合成对数据执行真实数据校验", { runsRoot });
      for (const event of report.events) {
        const p = event.payload as { tool?: string; ok?: boolean; reason?: string; result?: unknown; detail?: unknown };
        if (event.type === "tool/result" && p.ok === false) console.log("RC2", JSON.stringify({ tool: p.tool, reason: p.reason, detail: p.detail }));
      }
      for (const event of report.events) {
        if (event.type === "tool/call") console.log("DBG-CALL", JSON.stringify(event.payload));
      }
      expect(report.outcome.kind).toBe("completed");
      expect(report.exit_code).toBe(0);
      const request = report.events
        .filter((event) => event.type === "tool/result")
        .map((event) => event.payload as { tool?: string; ok?: boolean; reason?: string; result?: unknown })
        .find((entry) => entry.tool === "atf_data_admission_request");
      console.log("DBG-R", JSON.stringify({ ok: request?.ok, reason: request?.reason }));
      expect(request?.ok).toBe(true);
      // 会话可续（同 run 流上新 turn 收尾成功）
      const follow = await runAgainstRealPeer(
        fixture,
        {
          providerId: "df-e2e-model",
          decide: async () => ok({ type: "final_answer", text: "材料缺口已如实请示，等待用户指示。" }),
        },
        "材料未齐，先停止等指示",
        { continue: true, runsRoot },
      );
      expect(follow.outcome.kind).toBe("completed");
    },
  );
});

if (!cli.ok) {
  it("ATF_CLI_PATH 未设置 → D-f 真内核 e2e 组跳过（mock 轨完整可用）", () => {
    expect(cli.ok).toBe(false);
  });
}
