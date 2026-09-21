/**
 * 快修批 D-a/D-b 门 2（门 1 裁定 R-1～R-5；《ATF-Harness_指令_快修批门1裁定与门2启动_20260920.md》）：
 * 工具错误回流分流——E1（对端业务拒绝 rejected）/E2（入参违规 input_violation）对模型面
 * provider 非终局回流（模型修参重试或转述），连续达 REJECT_LOOP_LIMIT → 终局；
 * 脚本执行器豁免（Faux 断言路径维持终局，R-5 哨兵）；E3（canonical 输出失败）恒终局锁定；
 * resume 重派同口径；D-b dataset_id 描述层约束存在性。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "../../src/core/run/index.js";
import { ToolRegistry } from "../../src/core/tools/index.js";
import { checkSchema } from "../../src/core/tools/canonical.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "da-db-quickfix",
  version: 1,
  provider: "faux",
  description: "快修批 D-a/D-b 门 2 测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "da-db-tool-error-backfill",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

/** 模型面 provider 桩（无 decisionFace 字段 = 模型面；捕获 decide 上下文供回流可见性断言）。 */
const modelStub = (decisions: LlmDecision[], contexts?: string[]): LlmProvider => {
  return {
    providerId: "da-stub-model",
    decide: async (context) => {
      contexts?.push(JSON.stringify(context));
      return ok(decisions.shift() ?? null);
    },
  };
};

const grantedStub = async (): Promise<ApprovalStubResponse> => ({ verdict: "granted", actor: "stub-host" });
const timeoutStub = async (): Promise<ApprovalStubResponse> => ({ verdict: "timeout" });

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `da-${randomUUID()}`);

const PATH_ID = "datasets/external/ds-da/swb";
const GOOD_ID = "ds-da-20260920";

describe("D-a E1：对端业务拒绝回流（模型面非终局）", () => {
  it("invalid_params → 回流模型（上下文可见）→ 修参重调 → turn completed exit 0", async () => {
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`da-flow-${randomUUID()}`, "准入 ds-da"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: PATH_ID, source_ref: "datasets/external/ds-da" } },
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: GOOD_ID, source_ref: "datasets/external/ds-da" } },
        { type: "final_answer", text: "已按标识符准入登记。" },
      ], contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    // 错误回填在前：invalid_params 结构化回填（R-3 零加工——detail 透传对端 code）
    const bad = report.events.find((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false);
    expect(bad).toBeDefined();
    const badPayload = (bad?.payload ?? {}) as { reason?: string; detail?: { code?: string } };
    expect(badPayload.reason).toBe("invalid_params");
    expect(badPayload.detail?.code).toBe("invalid_params");
    // 修参重调在后且成功
    const good = report.events.find((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === true && JSON.stringify(event.payload).includes("atf_admit_data"));
    expect(good).toBeDefined();
    expect((good?.id ?? 0)).toBeGreaterThan(bad?.id ?? 0);
    // 模型可见性：第二次 decide 上下文含错误 tool_result
    expect(contexts.length).toBe(3);
    expect(contexts[1]).toContain("invalid_params");
  });

  it("连续 rejected 达 REJECT_LOOP_LIMIT=3 → turn 级失败收口（turn_failed，run 未终局；D-1）", async () => {
    let asked = 0;
    const provider: LlmProvider = {
      providerId: "da-stub-model",
      decide: async () => {
        asked += 1;
        return ok({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: PATH_ID } });
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`da-loop-${randomUUID()}`, "准入"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("reject_loop_exhausted");
    expect(summary.limit).toBe(3);
    expect(summary.rejected?.length ?? 0).toBe(3);
    for (const call of summary.rejected ?? []) {
      expect(call.tool).toBe("atf_admit_data");
      expect(call.reason).toBe("invalid_params");
      expect(call.params_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(summary.hint.gate_ids).toBeUndefined(); // 非 gate 场景不带清单
    expect(summary.hint.note).toContain("继续本会话");
    const rejects = report.events.filter((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false);
    expect(rejects.length).toBe(3);
    expect(asked).toBe(3); // 第 3 次拒绝即收口，模型不再被询问
    // turn/end 落盘 failure_summary（审计面）
    const turnEnd = report.events.find((event) => event.type === "turn/end");
    const endPayload = (turnEnd?.payload ?? {}) as { reason?: string; failure_summary?: { reason?: string } };
    expect(endPayload.reason).toBe("failed");
    expect(endPayload.failure_summary?.reason).toBe("reject_loop_exhausted");
  });

  it("D-1：阈值收口后同 run-id continue 续跑成功（同会话可继续；禁止 turn failed→退出路径）", async () => {
    const runsRoot = runsRootOf();
    const runId = `da-continue-${randomUUID()}`;
    const loopProvider: LlmProvider = {
      providerId: "da-stub-model",
      decide: async () => ok({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: PATH_ID } }),
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: loopProvider,
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("turn_failed");
    // 同会话续跑：正确参数（显式登记即可成功登记；B4 continue 前置＝末 turn 已收口）
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "修正后重试"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: GOOD_ID } },
        { type: "final_answer", text: "修正后登记成功。" },
      ]),
      approvalSurface: { stub: grantedStub },
      continue: { instruction: "修正后重试" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
    expect(second.value.exit_code).toBe(0);
  });

  it("D-1：atf_gate 场景阈值收口 → hint.gate_ids 携带合法清单（unknown_gate×3）", async () => {
    let asked = 0;
    const provider: LlmProvider = {
      providerId: "da-stub-model",
      decide: async () => {
        asked += 1;
        return ok({ type: "tool_call", tool: "atf_gate", params: { gate: `G${asked + 4}`, action: "query" } });
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`da-gate-${randomUUID()}`, "查询闸门"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    expect(report.outcome.summary.hint.gate_ids).toBeDefined();
    expect(report.outcome.summary.hint.gate_ids?.some((id) => id.startsWith("G1"))).toBe(true);
    expect(report.outcome.summary.hint.gate_ids?.filter((id) => id.includes("valid")).length).toBe(7);
    for (const call of report.outcome.summary.rejected ?? []) {
      expect(call.reason).toBe("unknown_gate");
    }
  });

  it("R-5 哨兵：脚本执行器 rejected 维持终局（Faux 断言路径零回归）", async () => {
    const scenario = scenarioOf(`da-script-${randomUUID()}`, "脚本径");
    const mainBranch = scenario.branches.main;
    if (mainBranch === undefined) throw new Error("unreachable");
    mainBranch.steps = [
      { type: "tool_call", tool: "atf_workspace_status", params: {} },
      { type: "final_answer", text: "不应到达" },
    ];    const ran = await ScenarioRunner.runBranch(scenario, "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--reject-method=atf_workspace_status"],
      // 不注 modelProvider = 脚本执行器（decisionFace=script）
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "failed") throw new Error("unreachable");
    expect(report.outcome.error.message).toContain("对端业务拒绝");
    // 终局即收口：final_answer 未被执行
    expect(report.events.some((event) => event.type === "assistant/message")).toBe(false);
  });
});

describe("D-a E2：入参违规回流（R-1 锚定入参点位）", () => {
  it("缺 required dataset_id → schema_violation 回流 → 修参 → completed", async () => {
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`da-e2-${randomUUID()}`, "准入"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_admit_data", params: { evil_param: "somewhere" } },
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-da-e2" } },
        { type: "final_answer", text: "done" },
      ], contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const bad = report.events.find((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false);
    expect((bad?.payload as { reason?: string }).reason).toBe("schema_violation");
    expect(contexts[1]).toContain("schema_violation");
  });

  it("E3 锁定：canonical 输出校验失败恒终局（模型面亦不回流，R-1 另一半）", async () => {
    let asked = 0;
    const provider: LlmProvider = {
      providerId: "da-stub-model",
      decide: async () => {
        asked += 1;
        return ok(asked === 1 ? { type: "tool_call", tool: "atf_workspace_status", params: {} } : { type: "final_answer", text: "不应到达" });
      },
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(`da-e3-${randomUUID()}`, "x"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--corrupt-output=atf_workspace_status"],
      modelProvider: provider,
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("failed");
    if (report.outcome.kind !== "failed") throw new Error("unreachable");
    expect(report.outcome.error.message).toContain("工具执行故障");
    expect(asked).toBe(1); // 终局：模型不再被询问
  });
});

describe("D-a：resume 重派 rejected 续跑（同口径）", () => {
  it("挂起 → resume granted → 重派吃 invalid_params → 非终局 → 模型修参 → completed", async () => {
    const runsRoot = runsRootOf();
    const suspended = await ScenarioRunner.runBranch(scenarioOf("da-resume-fix", "准入"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: modelStub([{ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: PATH_ID } }]),
      approvalSurface: { stub: timeoutStub },
    });
    expect(suspended.ok).toBe(true);
    if (!suspended.ok) throw new Error("unreachable");
    expect(suspended.value.outcome.kind).toBe("suspended");
    expect(suspended.value.exit_code).toBe(75);

    const resumed = await ScenarioRunner.runBranch(scenarioOf("da-resume-fix", "(resume)"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--invalid-params-on-path-dataset-id"],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: GOOD_ID } },
        { type: "final_answer", text: "已按标识符准入。" },
      ]),
      approvalSurface: { stub: grantedStub },
      resume: { verdict: "granted" },
    });
    expect(resumed.ok, !resumed.ok ? JSON.stringify(resumed.error) : "").toBe(true);
    if (!resumed.ok) throw new Error("unreachable");
    const report: BranchRunReport = resumed.value;
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const rejects = report.events.filter((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false);
    expect(rejects.length).toBe(1); // 重派拒绝一次（回流），随后修参成功
    expect(report.events.some((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === true)).toBe(true);
  });
});

describe("D-b：dataset_id 描述层约束存在性", () => {
  it("atf_admit_data：工具描述与参数 schema 携带标识符形态指引（透传模型面）", () => {
    const visible = ToolRegistry.createDefault().modelVisible();
    const admit = visible.find((tool) => tool.name === "atf_admit_data");
    expect(admit).toBeDefined();
    // 双形态补丁后：description 为双形态口径（自动形态推荐＋显式形态口径并存）
    expect(admit?.description).toContain("注册标识符");
    expect(admit?.description).toContain("非文件路径");
    expect(admit?.description).toContain("自动形态");
    const datasetId = admit?.parameters.properties?.dataset_id;
    expect(datasetId?.description).toContain("非文件路径");
    expect(datasetId?.type).toBe("string");
  });

  it("描述层不引入运行时强校验：路径形态 dataset_id 仍过模型可见 schema（内核是唯一校验方）", () => {
    const visible = ToolRegistry.createDefault().modelVisible();
    const admit = visible.find((tool) => tool.name === "atf_admit_data");
    expect(checkSchema({ dataset_id: PATH_ID }, admit?.parameters ?? {}, "admit")).toBeNull();
  });
});
