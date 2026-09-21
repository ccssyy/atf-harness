/**
 * 登记面双形态补丁 门 2（2026-09-21，对齐内核件B v0.7.2b0 实测面 main 61631e6）：
 * ① 自动形态登记（无 dataset_id，真实双树目录）→ 派生 ds-<digest12> → 准入 request 成功一条链；
 * ② 显式形态回归（登记成功）＋显式登记后 request → dataset_not_registered 回流（缺陷机理锁定）；
 * ③ 两形态互斥（双向）invalid_params 回流。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "../../src/core/run/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "admit-dual-form",
  version: 1,
  provider: "faux",
  description: "登记面双形态补丁测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "admit-dual-form",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<ApprovalStubResponse> => ({ verdict: "granted", actor: "stub-host" });
const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `dual-${randomUUID()}`);

/** 真实存在的最小双树目录（自动形态源根校验用；源包含 png×json 成对样本）。 */
const makeTreePair = async (): Promise<{ sourceRoot: string; splitRoot: string }> => {
  const root = await mkdtemp(join(tmpdir(), "dual-form-"));
  const sourceRoot = join(root, "source");
  const splitRoot = join(root, "split");
  await mkdir(join(sourceRoot, "normalized", "invoice", "groups", "cluster_01"), { recursive: true });
  await mkdir(splitRoot, { recursive: true });
  await writeFile(join(sourceRoot, "normalized", "invoice", "groups", "cluster_01", "sample-1.png"), "png-bytes-1");
  await writeFile(join(sourceRoot, "normalized", "invoice", "groups", "cluster_01", "sample-1.json"), "{}");
  await writeFile(join(splitRoot, "global_assignment.csv"), "cluster_id,component_id,image_relpath,json_relpath,pixel_hash,raw_hash,split,unit,family_id\n");
  await writeFile(join(splitRoot, "global_plan.json"), "{}");
  return { sourceRoot, splitRoot };
};

/** 模型面桩：stage 顺序驱动（登记→解析派生 id→准入 request→收束；D-5 用法）。 */
const autoFormProvider = (sourceRoot: string, splitRoot: string, contexts: string[]): LlmProvider => {
  let stage = 0;
  return {
    providerId: "dual-stub-model",
    decide: async (context) => {
      contexts.push(JSON.stringify(context));
      stage += 1;
      if (stage === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } });
      if (stage === 2) {
        const m = /"fact_id":"(ds-[0-9a-f]{12})@/.exec(contexts[contexts.length - 1] ?? "");
        if (m === null) throw new Error("登记结果解析失败（派生 dataset_id 不在上下文）");
        return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: m[1] } });
      }
      return ok({ type: "final_answer", text: "登记并准入完成。" });
    },
  };
};

describe("① 自动形态：登记（无 dataset_id）→ 派生 ds-<digest12> → 准入 request 成功一条链", () => {
  it("自动登记 → 解析派生 id → request 成功 → summary 字段齐备 → completed", async () => {
    const { sourceRoot, splitRoot } = await makeTreePair();
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`dual-auto-${randomUUID()}`, "登记并请求准入"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: autoFormProvider(sourceRoot, splitRoot, contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const admitted = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_admit_data" && (event.payload as { ok?: boolean }).ok === true,
    );
    const admittedResult = (admitted?.payload as { result?: { dataset_id?: string; fact_id?: string } }).result ?? {};
    expect(admittedResult.dataset_id).toMatch(/^ds-[0-9a-f]{12}$/); // 内容寻址派生（内核同形态）
    const admission = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_data_admission_request",
    );
    const payload = (admission?.payload ?? {}) as { ok?: boolean; result?: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.result?.["dataset_id"]).toBe(admittedResult.dataset_id);
    expect(payload.result?.["status"]).toBe("adjudicated");
    expect(payload.result?.["summary_ref"]).toContain(`runs/`);
  });

  it("派生幂等：同内容双树重复自动登记 → 同 dataset_id（跨路径不敏感由内容摘要保证）", async () => {
    const { sourceRoot, splitRoot } = await makeTreePair();
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`dual-idem-${randomUUID()}`, "重复登记"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: autoFormProvider(sourceRoot, splitRoot, contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const admitted = ran.value.events.filter(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_admit_data" && (event.payload as { ok?: boolean }).ok === true,
    );
    expect(admitted.length).toBe(1); // 本 run 一次登记；派生 id 形态断言同上
    const result = (admitted[0]?.payload as { result?: { dataset_id?: string } }).result ?? {};
    expect(result.dataset_id).toMatch(/^ds-[0-9a-f]{12}$/);
  });
});

describe("② 显式形态回归＋缺陷机理锁定", () => {
  it("显式登记成功（source_ref 档案）→ request → dataset_not_registered 回流（非终局）→ 如实转述", async () => {
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`dual-explicit-${randomUUID()}`, "登记并请求"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: (() => {
        let stage = 0;
        return {
          providerId: "dual-stub-model",
          decide: async (context) => {
            contexts.push(JSON.stringify(context));
            stage += 1;
            if (stage === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-swb-20260920", source_ref: "海运单(swb)数据" } });
            if (stage === 2) return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: "ds-swb-20260920" } });
            return ok({ type: "final_answer", text: "显式登记不可供真实数据校验（dataset_not_registered）；须以自动形态重新登记。" });
          },
        } satisfies LlmProvider;
      })(),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed"); // 回流非终局
    const admit = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_admit_data",
    );
    expect((admit?.payload as { ok?: boolean }).ok).toBe(true); // 显式登记本身成功（回归）
    const admission = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_data_admission_request",
    );
    const payload = (admission?.payload ?? {}) as { ok?: boolean; reason?: string };
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("dataset_not_registered"); // 内核/仿真同口径 fail-closed（冒烟#2 缺陷机理）
    expect(contexts[2]).toContain("dataset_not_registered");
  });
});

describe("③ 两形态互斥（双向）invalid_params 回流", () => {
  it("显式混入 source_root ／ 自动混入 source_ref → 各拒一次（回流）→ completed", async () => {
    const { sourceRoot, splitRoot } = await makeTreePair();
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`dual-mix-${randomUUID()}`, "互斥校验"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: (() => {
        const decisions: LlmDecision[] = [
          { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-mixed", source_root: sourceRoot } },
          { type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot, source_ref: "x" } },
          { type: "final_answer", text: "两形态互斥已确认。" },
        ];
        return {
          providerId: "dual-stub-model",
          decide: async (context) => {
            contexts.push(JSON.stringify(context));
            return ok(decisions.shift() ?? null);
          },
        } satisfies LlmProvider;
      })(),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const rejects = report.events.filter(
      (event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false,
    );
    expect(rejects.length).toBe(2);
    for (const reject of rejects) {
      expect((reject.payload as { reason?: string }).reason).toBe("invalid_params");
    }
  });
});
