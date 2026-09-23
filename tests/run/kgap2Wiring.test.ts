/**
 * K-Gap-2 接线批门 2（门 1 放行件 §三 新增用例五条；owner《两批门2放行》§二）：
 * propose 纯读（免审批）／execute 写（需审批）／split_policy 透传与非法 payload 内核回流／
 * human_summary 负向断言（见 tests/ui/humanSummary.test.ts）／拒绝码 → 缺口卡收口。
 * mock 证据口径（pin 未升级 v0.7.3b0 前唯一宣称面）；mock 新语义旗标 --kgap2-split-policy。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import { ToolRegistry } from "../../src/core/tools/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "kgap2-wiring",
  version: 1,
  provider: "faux",
  description: "K-Gap-2 接线批门 2 测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "kgap2-wiring",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "stub-host" });

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `k2-${randomUUID()}`);

const CLUSTER_PARAMS = {
  algorithm_version: "bbox_layout_v1",
  granularity: "page",
  metric: "cosine",
  linkage: "average",
  threshold: "auto_candidates",
  min_cluster_size: "1",
};

const VALID_POLICY = {
  schema_version: "DatasetSplitPolicy/v2",
  policy_id: "df-e2e-policy",
  target_ratios: { train: 0.8, test: 0.2 },
  seed: 7,
  assignment_mode: "recompute_with_policy",
  split_strategy: "cluster_content_family_seeded",
  auto_style_cluster: true,
};

const resultsOf = (report: BranchRunReport): Array<{ tool?: string; ok?: boolean; reason?: string; result?: unknown }> =>
  report.events
    .filter((event) => event.type === "tool/result")
    .map((event) => event.payload as { tool?: string; ok?: boolean; reason?: string; result?: unknown });

/** 首拍执行自动形态登记，随后按序回放决策——占位 dataset_id "ds-x"（或任意 ds- 前缀）
 *  以上下文中登记返回的派生 id（ds-<digest12>）替换（与真实模型同源：fact_id 出返回值）。 */
const registerThen = (decisions: LlmDecision[], dirs: { sourceRoot: string; splitRoot: string }): LlmProvider => {
  const queue = [...decisions];
  let first = true;
  return {
    providerId: "k2-stub-model",
    decide: async (context) => {
      if (first) {
        first = false;
        return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: dirs.sourceRoot, split_root: dirs.splitRoot } });
      }
      const next = queue.shift();
      if (next === undefined) return ok(null);
      if (next.type === "tool_call") {
        const derived = /ds-[0-9a-f]{12}/.exec(JSON.stringify(context))?.[0] ?? "ds-unresolved";
        const params = next.params as Record<string, unknown> | undefined;
        if (params !== undefined && typeof params["dataset_id"] === "string" && params["dataset_id"].startsWith("ds-")) {
          return ok({ type: "tool_call", tool: next.tool, params: { ...params, dataset_id: derived } });
        }
      }
      return ok(next);
    },
  };
};

const tempDirs = () => ({ sourceRoot: mkdtempSync(join(tmpdir(), "k2-src-")), splitRoot: mkdtempSync(join(tmpdir(), "k2-split-")) });

describe("K-Gap-2 接线：工具面 5→7（模型可见面与审批矩阵）", () => {
  it("模型可见面含两新工具；propose 免审批、execute 需审批（requiresApprovalFor 矩阵）", async () => {
    const visible = ToolRegistry.createDefault().modelVisible();
    const names = visible.map((tool) => tool.name);
    expect(names).toContain("atf_preparation_propose");
    expect(names).toContain("atf_style_cluster_execute");
    expect(names).toHaveLength(9); // R-3 接线批（2026-09-23）：工具面 7→9（label_qc 两工具）
    const registry = ToolRegistry.createDefault();
    const propose = registry.get("atf_preparation_propose");
    const execute = registry.get("atf_style_cluster_execute");
    expect(propose.ok && propose.value.requires_approval).toBe(false);
    expect(execute.ok && execute.value.requires_approval).toBe(true);
  });
});

describe("K-Gap-2 用例 1：propose 纯读（免审批——零审批事件）", () => {
  it("登记后 propose → cluster_confirmation（缺料），human_summary 六键齐备，无 approval/request", async () => {
    const dirs = tempDirs();
    const ran = await ScenarioRunner.runBranch(scenarioOf(`k2-propose-${randomUUID()}`, "看准备阶段"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: registerThen(
        [{ type: "tool_call", tool: "atf_preparation_propose", params: { dataset_id: "ds-x" } }, { type: "final_answer", text: "阶段已判定。" }],
        dirs,
      ),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("completed");
    // 免审批：propose 本身零审批事件（登记步骤的 admit 属写动作、其审批不在本断言面）
    const proposeApprovals = report.events.filter(
      (event) => event.type === "approval/request" && (event.payload as { tool?: string }).tool === "atf_preparation_propose",
    );
    expect(proposeApprovals).toHaveLength(0);
    const proposeResult = resultsOf(report).find((result) => result.tool === "atf_preparation_propose" && result.ok === true);
    expect(proposeResult).toBeDefined();
    const value = (proposeResult?.result ?? {}) as Record<string, unknown>;
    expect(value["stage"]).toBe("cluster_confirmation");
    expect(value["cluster_material"]).toBe("absent");
    expect(value["cluster_params_template"]).toMatchObject({ algorithm_version: "bbox_layout_v1", granularity: "page" });
    // human_summary 六字段冻结表（方案 A）
    const summary = value["human_summary"] as Record<string, unknown>;
    for (const key of ["headline", "sections", "metrics", "actions", "pending_confirmations", "notes"]) {
      expect(summary[key], `human_summary 缺 ${key}`).toBeDefined();
    }
  });
});

describe("K-Gap-2 用例 2：execute 写（需审批——审批链在场）", () => {
  it("execute 触发审批弹窗 → granted → 执行落料（含 clusters/source=kernel 六段返回）", async () => {
    const dirs = tempDirs();
    const ran = await ScenarioRunner.runBranch(scenarioOf(`k2-execute-${randomUUID()}`, "执行聚类"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: registerThen(
        [
          { type: "tool_call", tool: "atf_style_cluster_execute", params: { dataset_id: "ds-x", cluster_params: CLUSTER_PARAMS } },
          { type: "final_answer", text: "聚类完成。" },
        ],
        dirs,
      ),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    if (report.outcome.kind !== "completed") console.log("DBG-EXEC", JSON.stringify(report.outcome));
    expect(report.outcome.kind).toBe("completed");
    // 需审批：admit 与 execute 各触发一次问答轨审批（approval/request 在场）
    const approvals = report.events.filter((event) => event.type === "approval/request");
    expect(approvals.length).toBeGreaterThanOrEqual(2);
    const executeResult = resultsOf(report).find((result) => result.tool === "atf_style_cluster_execute" && result.ok === true);
    expect(executeResult).toBeDefined();
    const value = (executeResult?.result ?? {}) as Record<string, unknown>;
    expect(value["source"]).toBe("kernel");
    expect(value["cluster_count"]).toBe(1);
    expect(Array.isArray(value["clusters"])).toBe(true);
    expect(typeof value["cluster_digest"]).toBe("string");
    expect((value["human_summary"] as Record<string, unknown>)["headline"]).toBeDefined();
  });

  it("非法 cluster_params → 回流（值越出闭集＝内核 invalid_params；缺键＝harness E2 schema_violation），修参后成功", async () => {
    const dirs = tempDirs();
    const ran = await ScenarioRunner.runBranch(scenarioOf(`k2-exec-bad-${randomUUID()}`, "执行聚类"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: registerThen(
        [
          { type: "tool_call", tool: "atf_style_cluster_execute", params: { dataset_id: "ds-x", cluster_params: { ...CLUSTER_PARAMS, metric: "euclidean" } } },
          { type: "tool_call", tool: "atf_style_cluster_execute", params: { dataset_id: "ds-x", cluster_params: { algorithm_version: "bbox_layout_v1" } } },
          { type: "tool_call", tool: "atf_style_cluster_execute", params: { dataset_id: "ds-x", cluster_params: CLUSTER_PARAMS } },
          { type: "final_answer", text: "修参后聚类完成。" },
        ],
        dirs,
      ),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const rejects = resultsOf(report).filter((result) => result.tool === "atf_style_cluster_execute" && result.ok === false);
    expect(rejects.length).toBe(2);
    // 第一拍：键齐全但值越出内核能力闭集 → 内核 invalid_params（校验归内核）
    expect(rejects[0]?.reason).toBe("invalid_params");
    // 第二拍：缺五键 → harness 入参校验点位拒绝（E2 schema_violation，未触桥接——R-1 精度约束）
    expect(rejects[1]?.reason).toBe("schema_violation");
  });
});

describe("K-Gap-2 用例 3：split_policy 透传与非法 payload 内核回流", () => {
  it("非法 target_ratios → invalid_params 回流；合法确认态 → 执行成功（policy.source=confirmed）", async () => {
    const dirs = tempDirs();
    const ran = await ScenarioRunner.runBranch(scenarioOf(`k2-policy-${randomUUID()}`, "确认划分"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--kgap2-split-policy"],
      modelProvider: registerThen(
        [
          {
            type: "tool_call",
            tool: "atf_data_admission_request",
            params: { dataset_id: "ds-x", split_policy: { ...VALID_POLICY, target_ratios: { train: 0.9, test: 0.2 } } },
          },
          { type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: "ds-x", split_policy: VALID_POLICY } },
          { type: "final_answer", text: "划分已按确认策略执行。" },
        ],
        dirs,
      ),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const bad = resultsOf(report).find((result) => result.tool === "atf_data_admission_request" && result.ok === false);
    expect(bad?.reason).toBe("invalid_params");
    const good = resultsOf(report).find((result) => result.tool === "atf_data_admission_request" && result.ok === true);
    expect(good).toBeDefined();
    const value = (good?.result ?? {}) as Record<string, unknown>;
    expect((value["policy"] as Record<string, unknown>)["source"]).toBe("confirmed");
    expect(value["human_summary"]).toBeDefined();
  });
});

describe("K-Gap-2 用例 5：拒绝码 → D-f 缺口卡收口 → 会话可续", () => {
  it("split_policy_missing×3 → reject 收口自动出缺口卡（缺划分策略），续跑成功", async () => {
    const dirs = tempDirs();
    const runsRoot = runsRootOf();
    const runId = `k2-gap-${randomUUID()}`;
    // 桩模型从上下文取登记派生 dataset_id（与真实模型同源：fact_id 出返回值）
    let calls = 0;
    const provider: LlmProvider = {
      providerId: "k2-stub-model",
      decide: async (context) => {
        calls += 1;
        if (calls === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: dirs.sourceRoot, split_root: dirs.splitRoot } });
        const derived = /ds-[0-9a-f]{12}/.exec(JSON.stringify(context))?.[0] ?? "ds-unresolved";
        return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: derived } });
      },
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "执行准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--kgap2-split-policy"],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const report = first.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(report.outcome.summary.reason).toBe("reject_loop_exhausted");
    const rejects = resultsOf(report).filter((result) => result.reason === "split_policy_missing");
    expect(rejects.length).toBe(3);
    // D-f-3 guidance 回填与 D-f-6 缺口卡（K-Gap-2 注册表新键）
    const card = report.outcome.summary.gap_card;
    expect(card?.missing ?? "").toContain("划分策略");
    expect(card?.options[0]?.recommended).toBe(true);
    expect(card?.options.length ?? 0).toBeLessThanOrEqual(3);
    // 会话可续
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "先查状态，划分稍后确认"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: {
        providerId: "k2-stub-model",
        decide: async () => ok({ type: "final_answer", text: "已停止等指示。" }),
      },
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "先查状态，划分稍后确认" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
  });
});
