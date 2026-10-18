/**
 * A2/A3/A2.2b 测试锚——atf_pipeline_stage 段模式（落点单源＋八段闭集＋映射表＋三态退出语义）。
 *
 * 指令件验收面：
 * - A2.2b：参数面 stage（八段原文闭集）＋run_id＋workspace_path（必填绝对路径）＋source_root
 *   （register 必填）；argv 只传 --workspace/--run-id/--stage（＋register 的 --source-root）；
 *   落点单源 <workspace_path>/runs/<run_id>（工具内 resolveRunDir 退役）；映射表落常量；
 *   exit 0 落事实＋binding，exit 2/3 一律零写入；workspace_path 缺失 fail-closed；
 *   越序负例（mock blocked）零写入且 rejections 原样回传；旧六段名别名不保留。
 * - A2：成功路径 appendBinding(runDir, sessionId)（sessionId 取 exec.agent.session.id，
 *   取不到如实跳过）。
 * - A3：每段 exit_code===0 后 appendSegmentFact(runDir, 映射键, "atf_pipeline_stage")；
 *   非零退出不写（不造完成事实）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool, PIPELINE_STAGES, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { readSegmentFacts } from "../../src/core/workspace/segmentFacts.js";
import { readBindings } from "../../src/core/workspace/runFacts.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "a22b-pipeline-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const approvalCtx = (outcome: string): { get: (service: string) => unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async () => outcome } : undefined),
});

const execWithSession = (sessionId: string, cwd?: string): { agent?: unknown; callId?: string; signal?: unknown } => ({
  agent: { session: { id: sessionId, ...(cwd !== undefined ? { header: { cwd } } : {}) } },
  callId: "call-1",
  signal: undefined,
});

/** 假管线脚本（stdout JSON＋退出码可控——三态语义真 spawn）。 */
const writeScript = (root: string, name: string, body: string): string => {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  return path;
};

const OK_SCRIPT = (root: string): string => writeScript(root, "ok.mjs", 'process.stdout.write("{}")\n');
const BLOCKED_SCRIPT = (root: string): string =>
  writeScript(
    root,
    "blocked.mjs",
    'process.stdout.write(JSON.stringify({mode:"stage",stage:"family_split",rejections:{reason_codes:["walkthrough_upstream_not_ok"],missing:["publish"]}}))\nprocess.exit(2)\n',
  );
const ENVFAIL_SCRIPT = (root: string): string => writeScript(root, "envfail.mjs", "process.stderr.write('ModuleNotFoundError: pandas')\nprocess.exit(3)\n");

describe("A2.2b——段模式闭集与映射表", () => {
  it("段名闭集＝内核八段原文（顺序权威，禁增删改序；旧六段名不保留）", () => {
    expect(PIPELINE_STAGES).toEqual([
      "register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission", "training_prep",
    ]);
    expect(PIPELINE_STAGES).not.toContain("split");
    expect(PIPELINE_STAGES).not.toContain("candidate");
  });

  it("映射表落常量：八项全覆——experiment_setup→experiment_config／candidate_build→candidate／family_split→split／training_prep→null", () => {
    expect(SEGMENT_FACT_BY_KERNEL_STAGE).toEqual({
      register: "register",
      label_qc: "label_qc",
      experiment_setup: "experiment_config",
      candidate_build: "candidate",
      publish: "publish",
      family_split: "split",
      admission: "admission",
      training_prep: null,
    });
  });
});

describe("A2.2b——fail-closed 参数面（先于审批，坏参数不消耗放行）", () => {
  it("workspace_path 缺失 → 参数校验层 fail-closed（ToolArgsError，不触审批、零 spawn）", async () => {
    const root = tempRoot();
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    await expect(tool.execute({ stage: "label_qc", run_id: "r1" }, execWithSession("s1"))).rejects.toThrow(/workspace_path/);
  });

  it("workspace_path 空串 → execute 面 workspace_path_missing（穿透 schema 的空白形态兜底）", async () => {
    const root = tempRoot();
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "label_qc", run_id: "r1", workspace_path: "   " }, execWithSession("s1"));
    expect(result).toMatchObject({ ok: false, error: "workspace_path_missing" });
  });

  it("workspace_path 非绝对路径 → workspace_path_not_absolute fail-closed", async () => {
    const root = tempRoot();
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "label_qc", run_id: "r1", workspace_path: "relative/ws" }, execWithSession("s1"));
    expect(result).toMatchObject({ ok: false, error: "workspace_path_not_absolute" });
  });

  it("register 缺 source_root → source_root_missing 明确指路；非 register 省 source_root 正常下传", async () => {
    const root = tempRoot();
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const missing = await tool.execute({ stage: "register", run_id: "r1", workspace_path: root }, execWithSession("s1"));
    expect(missing).toMatchObject({ ok: false, error: "source_root_missing" });
    expect(String(missing["note"])).toContain("register");
    const ok = await tool.execute({ stage: "label_qc", run_id: "r1", workspace_path: root }, execWithSession("s1"));
    expect(ok).toMatchObject({ ok: true, exit_code: 0 });
  });
});

describe("A2.2b——argv 面单源（只传内核声明四参）", () => {
  it("register：argv 恰为 --workspace/--run-id/--stage/--source-root（顺序与形态钉死）；落点单源 runs/<run_id>", async () => {
    const root = tempRoot();
    const marker = join(root, "argv.json");
    const script = writeScript(
      root,
      "argv.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));process.stdout.write("{}")\n`,
    );
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "register", run_id: "run-a", workspace_path: ws, source_root: join(root, "src") }, execWithSession("s1"));
    expect(result).toMatchObject({ ok: true, workspace_path: ws, run_dir: join(ws, "runs", "run-a") });
    expect(JSON.parse(readArgv(marker))).toEqual(["--workspace", ws, "--run-id", "run-a", "--stage", "register", "--source-root", join(root, "src")]);
  });

  it("非 register：argv 不含 --source-root", async () => {
    const root = tempRoot();
    const marker = join(root, "argv2.json");
    const script = writeScript(
      root,
      "argv2.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));process.stdout.write("{}")\n`,
    );
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "publish", run_id: "run-b", workspace_path: ws }, execWithSession("s1"));
    expect(result).toMatchObject({ ok: true });
    const argv = JSON.parse(readArgv(marker)) as string[];
    expect(argv).toEqual(["--workspace", ws, "--run-id", "run-b", "--stage", "publish"]);
    expect(argv.some((a) => a === "--source-root")).toBe(false);
  });
});

/** argv marker 读取（缺文件＝空串，断言侧自报）。 */
function readArgv(marker: string): string {
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

describe("A2/A3——exit 三态事实轨与绑定语义", () => {
  it("exit 0：段事实按映射键落盘（experiment_setup→experiment_config）＋binding；返回面带双布尔与落点", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "experiment_setup", run_id: "run-a", workspace_path: ws }, execWithSession("sess-9"));
    expect(result).toMatchObject({
      stage: "experiment_setup", run_id: "run-a", ok: true, exit_code: 0,
      segment_fact_recorded: true, session_bound: true,
      workspace_path: ws, run_dir: join(ws, "runs", "run-a"), fact_segment: "experiment_config",
    });
    const runDir = join(ws, "runs", "run-a");
    const facts = readSegmentFacts(runDir);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ segment: "experiment_config", source: "atf_pipeline_stage" });
    expect(readBindings(runDir).map((b) => b.session_id)).toEqual(["sess-9"]);
  });

  it("candidate_build → fact_segment=candidate（只落事实不点灯——键不在前缀闭包读面）；training_prep → fact_segment=training_prep", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const cb = await tool.execute({ stage: "candidate_build", run_id: "run-cb", workspace_path: ws }, execWithSession("s1"));
    expect(cb).toMatchObject({ ok: true, fact_segment: "candidate", segment_fact_recorded: true });
    expect(readSegmentFacts(join(ws, "runs", "run-cb")).map((f) => f.segment)).toEqual(["candidate"]);
    // A-E14b：training_prep 段 base_model_path 必填（夹具按新契约补显式绝对路径——
    // 缺参即卡前快败 base_model_path_missing，专锚见 batchE14b.test.ts）
    const tp = await tool.execute({ stage: "training_prep", run_id: "run-tp", workspace_path: ws, base_model_path: join(ws, "model") }, execWithSession("s1"));
    expect(tp).toMatchObject({ ok: true, fact_segment: "training_prep", segment_fact_recorded: true });
    expect(readSegmentFacts(join(ws, "runs", "run-tp")).map((f) => f.segment)).toEqual(["training_prep"]);
  });

  it("exit 2（blocked 越序）：零写入＋rejections 原样回传（reason_codes/missing）", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${BLOCKED_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "family_split", run_id: "run-blk", workspace_path: ws }, execWithSession("sess-2"));
    expect(result).toMatchObject({ ok: false, exit_code: 2, segment_fact_recorded: false, session_bound: false, workspace_path: ws });
    expect(result["rejections"]).toEqual({ reason_codes: ["walkthrough_upstream_not_ok"], missing: ["publish"] });
    expect(existsSync(join(ws, "runs", "run-blk", "webui", "segments.json"))).toBe(false);
    expect(existsSync(join(ws, "runs", "run-blk", "webui", "binding.json"))).toBe(false);
  });

  it("exit 3（环境错误）：零写入＋stderr_tail＋环境面指引", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${ENVFAIL_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "register", run_id: "run-e3", workspace_path: ws, source_root: join(root, "src") }, execWithSession("sess-3"));
    expect(result).toMatchObject({ ok: false, exit_code: 3, segment_fact_recorded: false, session_bound: false });
    expect(String(result["stderr_tail"])).toContain("ModuleNotFoundError");
    expect(String(result["note"])).toContain("环境错误");
    expect(existsSync(join(ws, "runs", "run-e3", "webui"))).toBe(false);
  });

  it("A2 回归：sessionId 取不到 → 如实跳过（segment_fact_recorded=true、session_bound=false、无 binding）", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "label_qc", run_id: "run-d", workspace_path: ws }, { agent: undefined, callId: "c", signal: undefined });
    expect(result).toMatchObject({ ok: true, segment_fact_recorded: true, session_bound: false });
    expect(existsSync(join(ws, "runs", "run-d", "webui", "binding.json"))).toBe(false);
  });

  it("A3 回归：审批 rejected → 结构化拒绝且零写入（spawn 不发生）", async () => {
    const root = tempRoot();
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const tool = buildPipelineTool(approvalCtx("rejected"), `node ${OK_SCRIPT(root)}`, 30_000) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "register", run_id: "run-r", workspace_path: ws, source_root: join(root, "src") }, execWithSession("s1"));
    expect(result).toMatchObject({ error: "approval_denied", outcome: "rejected" });
    expect(existsSync(join(ws, "runs"))).toBe(false);
  });
});
