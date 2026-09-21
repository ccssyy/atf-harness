/**
 * R1 接线批 S3（D-6，2026-09-20）：atf_data_admission_request 接线测试——
 * ① 账本轨预录→放行→方法执行→summary 闭集字段断言；
 * ② waiting_on_human 成功执行（非终局）＋requests 载荷；
 * ③ invalid_params 回流（快修批链路在新工具上复测）；
 * ⑤ fact_id 解析指引断言（D-5 schema description 存在性）。
 * mock 仿真：--admission-status=<adjudicated|waiting_on_human>（缺省 adjudicated）。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "../../src/core/run/index.js";
import { ToolRegistry } from "../../src/core/tools/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string, ledger: Array<{ tool: string; params: Record<string, unknown> }> = []): Scenario => ({
  scenario_id: "r1-admission-wiring",
  version: 1,
  provider: "faux",
  description: "R1 接线批测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "r1-admission-request",
      setup: { ledger },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const modelStub = (decisions: LlmDecision[], contexts?: string[]): LlmProvider => ({
  providerId: "r1-stub-model",
  decide: async (context) => {
    contexts?.push(JSON.stringify(context));
    return ok(decisions.shift() ?? null);
  },
});

const grantedStub = async (): Promise<ApprovalStubResponse> => ({ verdict: "granted", actor: "stub-host" });
const forbiddenStub = async (): Promise<ApprovalStubResponse> => {
  throw new Error("问答轨不应被调用（账本轨应命中预录）");
};

const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `r1-${randomUUID()}`);

/** 双形态测试夹具：真实存在的最小双树目录（自动形态 source_root/split_root 校验用）。 */
const makeTreePair = async (): Promise<{ sourceRoot: string; splitRoot: string }> => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "r1-dual-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  const sourceRoot = join(root, "source");
  const splitRoot = join(root, "split");
  await mkdir(join(sourceRoot, "normalized", "cluster_01"), { recursive: true });
  await mkdir(splitRoot, { recursive: true });
  await writeFile(join(sourceRoot, "normalized", "cluster_01", "sample-1.png"), "png-bytes");
  await writeFile(join(sourceRoot, "normalized", "cluster_01", "sample-1.json"), "{}");
  await writeFile(join(splitRoot, "global_assignment.csv"), "cluster_id,component_id,image_relpath,json_relpath,pixel_hash,raw_hash,split,unit,family_id\n");
  await writeFile(join(splitRoot, "global_plan.json"), "{}");
  return { sourceRoot, splitRoot };
};

describe("R1 ①：自动形态登记→准入 request→summary 闭集断言（双形态补丁后正确用法）", () => {
  it("自动形态登记（无 dataset_id，双树目录）→ 解析派生 id → admission_request → 全字段 canonical 结果", async () => {
    const { sourceRoot, splitRoot } = await makeTreePair();
    const contexts: string[] = [];
    let stage = 0;
    const provider: LlmProvider = {
      providerId: "r1-stub-model",
      decide: async (context) => {
        contexts.push(JSON.stringify(context));
        stage += 1;
        if (stage === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } });
        if (stage === 2) {
          const m = /"fact_id":"(ds-[0-9a-f]{12})@/.exec(contexts[contexts.length - 1] ?? "");
          if (m === null) throw new Error("登记结果解析失败（派生 dataset_id 不在上下文）");
          return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: m[1] } });
        }
        return ok({ type: "final_answer", text: "准入申请已完成。" });
      },
    };
    const ran = await ScenarioRunner.runBranch(
      scenarioOf(`r1-ledger-${randomUUID()}`, "登记并请求准入"),
      "main",
      {
        runsRoot: runsRootOf(),
        mockCommand: ["node", mockPath],
        modelProvider: provider,
        approvalSurface: { stub: grantedStub },
      },
    );
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const admission = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_data_admission_request",
    );
    expect(admission).toBeDefined();
    const payload = (admission?.payload ?? {}) as { ok?: boolean; result?: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    const result = payload.result ?? {};
    // 闭集逐字段（契约登记段）：ok/run_id/dataset_id/pin/fact_id/status/summary_ref/summary_sha256/gates
    for (const key of ["ok", "run_id", "dataset_id", "pin", "fact_id", "status", "summary_ref", "summary_sha256", "gates"]) {
      expect(result, `缺字段 ${key}`).toHaveProperty(key);
    }
    expect(result["status"]).toBe("adjudicated");
    expect(result["fact_id"]).toBe(`${String(result["dataset_id"])}@${String(result["pin"])}`);
    expect(String(result["dataset_id"])).toMatch(/^ds-[0-9a-f]{12}$/); // 内容寻址派生（件B）
    expect(result["summary_ref"]).toContain(`runs/${String(result["run_id"])}/l1/${String(result["fact_id"])}`);
    expect(String(result["summary_sha256"])).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.isArray(result["gates"])).toBe(true);
    expect(result["gates"]).toHaveLength(4);
    // RPC method 映射（D-1）：runner 侧 audit 由 tool/result tool 名承载工具名；
    // 点号方法名不出现在会话流 payload（模型面只见下划线工具名）
    expect(JSON.stringify(admission?.payload)).not.toContain("atf_data_admission.request");
  });
});

describe("R1 ②：waiting_on_human 非终局（诚实停止）", () => {
  it("status=waiting_on_human＋requests 载荷 → 正常回填 → 模型如实转述 → completed", async () => {
    const contexts: string[] = [];
    const sourceTree = await makeTreePair();
    const ran = await ScenarioRunner.runBranch(scenarioOf(`r1-wait-${randomUUID()}`, "请求准入"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath, "--admission-status=waiting_on_human"],
      modelProvider: (() => {
        const tail: LlmDecision[] = [
          { type: "final_answer", text: "准入申请已执行：判定为 waiting_on_human（标注冲突待人工裁决），已诚实停止，未猜测成功。" },
        ];
        let stage = 0;
        return {
          providerId: "r1-stub-model",
          decide: async (context) => {
            contexts.push(JSON.stringify(context));
            stage += 1;
            if (stage === 1) return ok({ type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceTree.sourceRoot, split_root: sourceTree.splitRoot } });
            if (stage === 2) {
              const m = /"fact_id":"(ds-[0-9a-f]{12})@/.exec(contexts[contexts.length - 1] ?? "");
              if (m === null) throw new Error("登记结果解析失败");
              return ok({ type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: m[1] } });
            }
            return ok(tail.shift() ?? null);
          },
        } satisfies LlmProvider;
      })(),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed"); // 非终局：结果成功回填，run 收束于转述
    const admission = report.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_data_admission_request",
    );
    const payload = (admission?.payload ?? {}) as { ok?: boolean; result?: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.result?.["status"]).toBe("waiting_on_human");
    const requests = payload.result?.["requests"] as Array<Record<string, unknown>>;
    expect(Array.isArray(requests)).toBe(true);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(contexts[2]).toContain("waiting_on_human"); // 模型最终转述前可见
  });
});

describe("R1 ③：invalid_params 回流（快修批链路复测）", () => {
  it("路径形态 dataset_id → rejected invalid_params → 模型修正 → completed", async () => {
    const contexts: string[] = [];
    const ran = await ScenarioRunner.runBranch(scenarioOf(`r1-inv-${randomUUID()}`, "请求准入"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: modelStub([
        { type: "tool_call", tool: "atf_data_admission_request", params: { dataset_id: "datasets/external/ds-r1" } },
        { type: "final_answer", text: "dataset_id 不接受路径；请先登记并以标识符请求。" },
      ], contexts),
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    const bad = report.events.find((event) => event.type === "tool/result" && (event.payload as { ok?: boolean }).ok === false);
    expect((bad?.payload as { reason?: string }).reason).toBe("invalid_params");
    expect(contexts[1]).toContain("invalid_params");
  });
});

describe("R1 ⑤：fact_id 解析指引断言（D-5）", () => {
  it("工具描述与 dataset_id/pin schema description 携带 fact_id 取值指引（透传模型面）", () => {
    const visible = ToolRegistry.createDefault().modelVisible();
    const tool = visible.find((definition) => definition.name === "atf_data_admission_request");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("fact_id");
    expect(tool?.description).toContain("勿要求用户手敲");
    expect(tool?.description).toContain("不接受文件路径");
    const datasetId = tool?.parameters.properties?.dataset_id;
    expect(datasetId?.description).toContain("fact_id");
    const pin = tool?.parameters.properties?.pin;
    expect(pin?.description).toContain("多 pin");
  });
});
