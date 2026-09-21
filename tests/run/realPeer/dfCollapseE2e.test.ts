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
    "(c) 缺关键输入：合成对登记后准入缺 split 清单 → split_manifest_missing×3 → 缺口卡收口＋会话可续",
    { timeout: 240_000 },
    async () => {
      const fixture = await createRealPeerFixture(`df-e2e-gap-${randomUUID().slice(0, 8)}`);
      openFixtures.push(fixture);
      // 合成最小成对样本（1×1 PNG 字节＋同名 json；零真实业务内容）——split_root 无
      // global_assignment.csv/global_plan.json ⇒ 准入按内核 fail-closed 语义诚实拒绝。
      const sourceRoot = await mkdtemp(join(tmpdir(), "df-e2e-src-"));
      const splitRoot = await mkdtemp(join(tmpdir(), "df-e2e-split-"));
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(splitRoot, { recursive: true });
      await writeFile(join(sourceRoot, "df-e2e-pair-1.png"), png);
      await writeFile(join(sourceRoot, "df-e2e-pair-1.json"), `${JSON.stringify({ pairs: [{ image: "df-e2e-pair-1.png", label: "df-e2e-pair-1.json" }] })}\n`);
      let calls = 0;
      const provider: LlmProvider = {
        providerId: "df-e2e-model",
        decide: async (context) => {
          calls += 1;
          if (calls === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } });
          const derived = /ds-[0-9a-f]{12}/.exec(JSON.stringify(context))?.[0] ?? "ds-unresolved";
          return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: derived } });
        },
      };
      const runsRoot = await mkdtemp(join(tmpdir(), "df-e2e-runs-"));
      tempRoots.push(runsRoot);
      const report = await runAgainstRealPeer(fixture, provider, "对合成对数据执行真实数据校验", { runsRoot });
      expect(report.outcome.kind).toBe("turn_failed");
      if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
      const summary = report.outcome.summary;
      expect(summary.reason).toBe("reject_loop_exhausted");
      const rejects = report.events.filter(
        (event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "split_manifest_missing",
      );
      expect(rejects.length).toBe(3);
      for (const reject of rejects) {
        expect((reject.payload as { guidance?: string }).guidance ?? "").toContain("global_assignment.csv");
      }
      expect(summary.gap_card?.stuck).toContain("atf_data_admission_request");
      expect(summary.gap_card?.missing).toContain("global_plan.json");
      expect(summary.gap_card?.options[0]?.recommended).toBe(true);
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
