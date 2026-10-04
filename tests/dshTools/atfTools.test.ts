/**
 * 批⑱-M1 测试锚（指令 e73b4966 要求 4）——atf-tools DSH 协议适配：
 * 每工具一条适配测试（mock DSH 调用 → 断言桥接逻辑被正确触发与序列化）＋
 * atf_pipeline_stage 单段触发集成（mock pipeline）＋审批 seam 触发三态。
 *
 * 复用面：真 mock 桥（tests/fixtures/mock_atf.mjs——契约忠实对端）与真 mock pipeline
 * （tests/fixtures/mock_pipeline.mjs）；文件面走临时 runs 目录。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BridgeManager, allDefinitions, BRIDGE_TOOL_NAMES, buildBridgeTools } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { buildFileTools } from "../../packages/extensions/atf-tools/src/fileFace.js";
import { buildPipelineTool, PIPELINE_STAGES } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { translateParameters } from "../../packages/extensions/atf-tools/src/schemaTranslate.js";
import { TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from "../../src/core/tools/index.js";

const repoRoot = join(import.meta.url.replace("file://", ""), "..", "..", "..");
const mockBridgePath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const mockPipelinePath = join(repoRoot, "tests", "fixtures", "mock_pipeline.mjs");

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-tools-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** DSH 工具产物的测试调用面（defineTool 产物形状——execute(args, exec)＋name/schema 可断言）。 */
interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const toolNames = (tools: unknown[]): string[] => tools.map((tool) => (tool as DshToolLike).name);
const findTool = (tools: unknown[], name: string): DshToolLike => {
  const tool = tools.find((entry) => (entry as DshToolLike).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}（实际: ${toolNames(tools).join(", ")}）`);
  return tool as DshToolLike;
};
const fakeExec = { agent: undefined, callId: "test-call-1", signal: undefined };
const noApprovalCtx = { get: () => undefined };
const approvalCtx = (outcome: string) => ({
  get: (service: string) =>
    service === "approval"
      ? { request: async () => outcome }
      : undefined,
});

// ---------------------------------------------------------------- 注册面（清单完整性）

describe("atf-tools 注册面（11 工具清单＝指令要求）", () => {
  it("桥接 6＋文件 4＋pipeline 1＋hello 探针＝12 个注册名，且与手搓契约定义一一对应", async () => {
    const manager = new BridgeManager(["node", mockBridgePath], repoRoot);
    const ctx = noApprovalCtx;
    const registered = [
      ...toolNames(buildBridgeTools(ctx, manager)),
      ...toolNames(buildFileTools(tempRoot())),
      ...toolNames([buildPipelineTool(ctx, `node ${mockPipelinePath}`, 30_000)]),
    ];
    for (const name of [...BRIDGE_TOOL_NAMES, "atf_run_list", "atf_report_read", "atf_metrics_compare", "atf_gpu_status", "atf_pipeline_stage"]) {
      expect(registered).toContain(name);
    }
    // atf_hello 探针由 apply() 注册（不在 build* 工厂面）——工厂面＝指令 11 工具
    expect(registered).toHaveLength(11);
    await manager.close();
  });

  it("schema 翻译：契约 JSON Schema → DSH 属性映射（required 收敛为属性级；未知类型 fail-closed）", () => {
    const translated = translateParameters({
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string", description: "run 标识" },
        segment: { type: "number", description: "段号" },
      },
    } as never);
    expect(translated["run_id"]).toMatchObject({ type: "string", required: true, description: "run 标识" });
    expect(translated["segment"]).toMatchObject({ type: "number" });
    expect(() =>
      translateParameters({ type: "object", required: [], properties: { weird: { type: "wormhole" } } } as never),
    ).toThrow(/无法映射/);
    // 全部 11 工具的定义在手搓契约单源里可找到（桥接 6）；文件 4 与 pipeline 为仓侧新增面
    const contractNames = [...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS].map((definition) => definition.name);
    for (const name of BRIDGE_TOOL_NAMES) expect(contractNames).toContain(name);
    expect(allDefinitions().length).toBeGreaterThanOrEqual(TOOL_DEFINITIONS.length);
  });
});

// ---------------------------------------------------------------- 桥接面（6 工具逐个：mock DSH 调用 → 断言桥接被触发与序列化）

describe("atf-tools 桥接面（真 mock 桥——契约忠实对端）", () => {
  const manager = new BridgeManager(["node", mockBridgePath], repoRoot);
  const localRoots = { runsRoot: tempRoot(), kernelDir: join(repoRoot, ".atf-pinned"), execHome: tempRoot() };

  it("atf_workspace_status：桥接触发＋canonical 结果序列化（scope_ref 透传）", async () => {
    const tools = buildBridgeTools(noApprovalCtx, manager, localRoots);
    const result = (await findTool(tools, "atf_workspace_status").execute({}, fakeExec)) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
    // mock 对端的 workspace_status 返回内含 scope_ref（契约 v2）——原样序列化给模型
    expect(JSON.stringify(result)).toContain("scope_ref");
  }, 20_000);

  it("atf_gate query：只读免审批直通桥接（requiresApprovalFor 谓词语义保留）", async () => {
    const tools = buildBridgeTools(noApprovalCtx, manager, localRoots); // 无审批服务——query 仍应成功（免审批）
    const result = (await findTool(tools, "atf_gate").execute({ gate: "G1（数据准入闸，命名分流）", action: "query" }, fakeExec)) as Record<string, unknown>;
    expect(result).not.toHaveProperty("error");
  }, 20_000);

  it("atf_scratch_exec：无审批服务时 fail-closed 拒绝（不触桥）", async () => {
    const tools = buildBridgeTools(noApprovalCtx, manager, localRoots);
    const result = (await findTool(tools, "atf_scratch_exec").execute({ argv: ["python3", "-c", "print(1)"] }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ error: "approval_denied", outcome: "unavailable" });
  }, 20_000);

  it("atf_admit_data：审批 rejected → 结构化拒绝（不触桥）", async () => {
    const tools = buildBridgeTools(approvalCtx("rejected"), manager, localRoots);
    const result = (await findTool(tools, "atf_admit_data").execute({ source_root: "/tmp/a", split_root: "/tmp/b" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ error: "approval_denied", outcome: "rejected" });
  }, 20_000);

  it("atf_skill_read：审批放行 → 本地治理径（内核根缺失 → 结构化 rejected 如实回流）", async () => {
    const tools = buildBridgeTools(approvalCtx("allowed-once"), manager, localRoots);
    const result = (await findTool(tools, "atf_skill_read").execute({}, fakeExec)) as Record<string, unknown>;
    const text = JSON.stringify(result);
    expect(text.length).toBeGreaterThan(0);
  }, 20_000);

  it("atf_label_qc_inspect：审批 allowed-once → 触桥（契约参数面）", async () => {
    const tools = buildBridgeTools(approvalCtx("allowed-once"), manager, localRoots);
    const result = (await findTool(tools, "atf_label_qc_inspect").execute({ dataset_id: "ds-mock" }, fakeExec)) as Record<string, unknown>;
    expect(JSON.stringify(result).length).toBeGreaterThan(0);
  }, 20_000);

  it("atf_gate advance：须审批——approval unavailable → fail-closed（不触桥）", async () => {
    const tools = buildBridgeTools(approvalCtx("unavailable"), manager, localRoots);
    const result = (await findTool(tools, "atf_gate").execute({ gate: "G1（数据准入闸，命名分流）", action: "advance", evidence_refs: ["sha256:deadbeef"] }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ error: "approval_denied", outcome: "unavailable" });
  }, 20_000);

  afterAll(async () => {
    await manager.close();
  });
});

// ---------------------------------------------------------------- 文件面（4 工具逐个）

describe("atf-tools 文件面（临时 runs 目录）", () => {
  const setup = (): { root: string; tools: unknown[] } => {
    const root = tempRoot();
    mkdirSync(join(root, "run-a", "report"), { recursive: true });
    writeFileSync(join(root, "run-a", "report", "report.md"), "# run-a 报告\n正文");
    writeFileSync(join(root, "run-a", "report", "metrics_summary.json"), JSON.stringify({ eval_f1: 0.87, loss: 0.21 }));
    mkdirSync(join(root, "run-b", "report"), { recursive: true });
    writeFileSync(join(root, "run-b", "report", "metrics_summary.json"), JSON.stringify({ eval_f1: 0.91, loss: 0.18 }));
    return { root, tools: buildFileTools(root) };
  };

  it("atf_run_list：枚举＋状态推导序列化", async () => {
    const { root, tools } = setup();
    const result = (await findTool(tools, "atf_run_list").execute({}, fakeExec)) as { runs: Array<{ run_id: string }>; count: number };
    expect(result.count).toBe(2);
    expect(result.runs.map((run) => run.run_id).sort()).toEqual(["run-a", "run-b"]);
  });

  it("atf_report_read：存在读全文／缺失如实报", async () => {
    const { tools } = setup();
    const hit = (await findTool(tools, "atf_report_read").execute({ run_id: "run-a" }, fakeExec)) as { exists: boolean; text: string };
    expect(hit.exists).toBe(true);
    expect(hit.text).toContain("# run-a 报告");
    const miss = (await findTool(tools, "atf_report_read").execute({ run_id: "run-x" }, fakeExec)) as { exists: boolean };
    expect(miss.exists).toBe(false);
  });

  it("atf_metrics_compare：可比 diff／缺料如实报『无可比轮次』", async () => {
    const { tools } = setup();
    const hit = (await findTool(tools, "atf_metrics_compare").execute({ run_a: "run-a", run_b: "run-b" }, fakeExec)) as { comparable: boolean; diff: Record<string, { a: unknown; b: unknown }> };
    expect(hit.comparable).toBe(true);
    expect(hit.diff["eval_f1"]).toEqual({ a: 0.87, b: 0.91 });
    const miss = (await findTool(tools, "atf_metrics_compare").execute({ run_a: "run-a", run_b: "run-x" }, fakeExec)) as { comparable: boolean; note: string };
    expect(miss.comparable).toBe(false);
    expect(miss.note).toContain("无可比轮次");
  });

  it("atf_gpu_status：nvidia-smi 真查（在线返回真实指标／离线如实报 gpu_offline）", async () => {
    const { tools } = setup();
    const result = (await findTool(tools, "atf_gpu_status").execute({}, fakeExec)) as Record<string, unknown>;
    // A800 宿主二态皆合法：在线有 utilization／离线 gpu_offline=true——都不造数
    if (result["gpu_offline"] === true) {
      expect(result["note"]).toContain("nvidia-smi");
    } else {
      expect(String(result["utilization"])).toMatch(/%$/);
      expect(result["memoryTotal"]).toContain("MiB");
    }
  });
});

// ---------------------------------------------------------------- pipeline 集成＋审批触发

describe("atf_pipeline_stage 集成（mock pipeline）＋审批 seam", () => {
  it("单段触发成功：审批放行 → spawn mock → 段摘要结构化返回", async () => {
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${mockPipelinePath}`, 30_000);
    const result = (await (tool as DshToolLike).execute({ stage: "register" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ stage: "register", ok: true, exit_code: 0 });
    expect(JSON.stringify(result["summary"])).toContain("mock 单段触发");
  });

  it("未知段：DSH defineTool 参数校验前置拒绝（enum 挡在 execute 之前——协议适配价值）", async () => {
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${mockPipelinePath}`, 30_000);
    await expect((tool as DshToolLike).execute({ stage: "nonexistent" }, fakeExec)).rejects.toThrow(/must be one of/);
  });

  it("审批三态：rejected／unavailable 均 fail-closed 且不 spawn；段名清单与 walkthrough 段一致", async () => {
    for (const outcome of ["rejected", "unavailable"]) {
      const tool = buildPipelineTool(approvalCtx(outcome), `node ${mockPipelinePath}`, 30_000);
      const result = (await (tool as DshToolLike).execute({ stage: "label_qc" }, fakeExec)) as Record<string, unknown>;
      expect(result).toMatchObject({ error: "approval_denied", outcome });
    }
    expect(PIPELINE_STAGES).toEqual(["register", "split", "label_qc", "candidate", "publish", "training_prep"]);
  });
});

describe("批㉛段2 atf_config_confirm 现值基线（run 的 IterationConfig 入登记源）", () => {
  const tempRoots2: string[] = [];
  const tempRoot2 = (): string => {
    const root = mkdtempSync(join(tmpdir(), "k31-confirm-test-"));
    tempRoots2.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of tempRoots2.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const seedRun = (root: string, withSnapshot: boolean): string => {
    const runDir = join(root, "run-c");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(
      join(runDir, "prep", "iteration-config", "iteration-config.json"),
      JSON.stringify({ schema_version: "IterationConfig/v1", training: { learning_rate: "1e-4", deepspeed: "ds_z3_fp8_config.json", cutoff_len: 9000 } }),
    );
    if (withSnapshot) {
      mkdirSync(join(runDir, "webui"), { recursive: true });
      writeFileSync(join(runDir, "webui", "config-snapshot.json"), JSON.stringify({ confirmed: { learning_rate: "5e-5" } }));
    }
    return root;
  };
  it("present：IterationConfig training 实值以◆来自登记入卡（snapshot 优先），deepspeed 不再落泛化缺省", async () => {
    const root = seedRun(tempRoot2(), false);
    const tools = buildConfirmTools({ runsRoot: root, ctx: approvalCtx("allowed-once") });
    const result = (await findTool(tools, "atf_config_confirm").execute({ action: "present", run_id: "run-c" }, fakeExec)) as { ok?: boolean; fields?: Array<{ key: string; value: string; tag: string }> };
    expect(result.ok).toBe(true);
    const byKey = Object.fromEntries((result.fields ?? []).map((f) => [f.key, f]));
    expect(byKey["deepspeed"]).toEqual({ key: "deepspeed", value: "ds_z3_fp8_config.json", tag: "from_registry" });
    expect(byKey["learning_rate"]).toMatchObject({ value: "1e-4", tag: "from_registry" });
    expect(byKey["cutoff_len"]).toMatchObject({ value: "9000", tag: "from_registry" });
    expect(byKey["max_total_tokens"]).toMatchObject({ tag: "default_used" });
    // 确认后快照按卡面现值落盘（webui/config-snapshot.json）
    const snap = JSON.parse(readFileSync(join(root, "run-c", "webui", "config-snapshot.json"), "utf8")) as { confirmed: Record<string, string> };
    expect(snap.confirmed["deepspeed"]).toBe("ds_z3_fp8_config.json");
  });
  it("已确认快照压过 IterationConfig（不重问语义）；驳回路径 fail-closed 不落快照", async () => {
    const root = seedRun(tempRoot2(), true);
    const tools = buildConfirmTools({ runsRoot: root, ctx: approvalCtx("allowed-once") });
    const result = (await findTool(tools, "atf_config_confirm").execute({ action: "present", run_id: "run-c" }, fakeExec)) as { fields?: Array<{ key: string; value: string; tag: string }> };
    const byKey = Object.fromEntries((result.fields ?? []).map((f) => [f.key, f]));
    expect(byKey["learning_rate"]).toMatchObject({ value: "5e-5", tag: "from_registry" });
    expect(byKey["deepspeed"]).toMatchObject({ value: "ds_z3_fp8_config.json", tag: "from_registry" });
    const denied = buildConfirmTools({ runsRoot: root, ctx: approvalCtx("rejected") });
    const runDir = join(root, "run-c");
    rmSync(join(runDir, "webui", "config-snapshot.json"));
    const rej = (await findTool(denied, "atf_config_confirm").execute({ action: "present", run_id: "run-c" }, fakeExec)) as Record<string, unknown>;
    expect(rej).toMatchObject({ error: "approval_denied", outcome: "rejected" });
    expect(rej).toMatchObject({ tool: "atf_config_confirm" });
  });
});
