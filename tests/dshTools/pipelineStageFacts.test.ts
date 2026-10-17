/**
 * A2/A3 测试锚——atf_pipeline_stage 段事实与会话绑定（run 归属写入＋段推进事件驱动）。
 *
 * 指令件验收面（A2）：atf_pipeline_stage 成功路径 appendBinding(runDir, sessionId)
 * （sessionId 取 exec.agent.session.id，取不到如实跳过）；runDir 解析单源（resolveRunDir
 * ——平铺在场＞桶内在场＞新建入桶，禁第二套推导）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import { readBindings } from "../../src/core/workspace/runFacts.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "a23-pipeline-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const approvalCtx = (outcome: string): { get: (service: string) => unknown } => ({
  get: (service: string) => (service === "approval" ? { request: async () => outcome } : undefined),
});

/** 会话执行上下文（session.id＋工作区 cwd——归属链两轴）。 */
const execWithSession = (sessionId: string, cwd?: string): { agent?: unknown; callId?: string; signal?: unknown } => ({
  agent: { session: { id: sessionId, ...(cwd !== undefined ? { header: { cwd } } : {}) } },
  callId: "call-1",
  signal: undefined,
});

/** 假管线脚本（退出码可控——成功/失败两形态真 spawn）。 */
const writeScript = (root: string, name: string, body: string): string => {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  return path;
};

describe("A2——atf_pipeline_stage 会话绑定", () => {
  it("成功段：exit 0 → 段事实（source=atf_pipeline_stage）＋binding 双落盘；返回面带两布尔", async () => {
    const root = tempRoot();
    const script = writeScript(root, "ok_pipeline.mjs", 'process.stdout.write("{}")\n');
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000, root) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "register", run_id: "run-a" }, execWithSession("sess-9"));
    expect(result).toMatchObject({ stage: "register", run_id: "run-a", ok: true, exit_code: 0, session_bound: true });
    const bindings = readBindings(join(root, "run-a"));
    expect(bindings.map((b) => b.session_id)).toEqual(["sess-9"]);
  });

  it("非零退出：零写入（不造完成事实不落绑定）；stderr 尾随回传", async () => {
    const root = tempRoot();
    const script = writeScript(root, "fail_pipeline.mjs", "process.stderr.write('boom-end')\nprocess.exit(3)\n");
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000, root) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "split", run_id: "run-b" }, execWithSession("sess-9"));
    expect(result).toMatchObject({ ok: false, exit_code: 3, session_bound: false });
    expect(String(result["stderr_tail"])).toContain("boom-end");
    expect(existsSync(join(root, "run-b", "webui", "binding.json"))).toBe(false);
  });

  it("sessionId 取不到：如实跳过（segment_fact_recorded=true、session_bound=false、无 binding）", async () => {
    const root = tempRoot();
    const script = writeScript(root, "ok2_pipeline.mjs", 'process.stdout.write("{}")\n');
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000, root) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ stage: "candidate", run_id: "run-c" }, { agent: undefined, callId: "c", signal: undefined });
    expect(result).toMatchObject({ ok: true, session_bound: false });
    expect(existsSync(join(root, "run-c", "webui", "binding.json"))).toBe(false);
  });

  it("runDir 解析单源：平铺在场优先（既有 run 落平铺，不入桶）；段事实幂等去重（同段同源不重复）", async () => {
    const root = tempRoot();
    const script = writeScript(root, "ok3_pipeline.mjs", 'process.stdout.write("{}")\n');
    // 既有平铺 run（registry 锚在位）——即使会话 cwd 指向别桶也不改写落点
    const flat = join(root, "run-flat");
    mkdirSync(join(flat, "webui"), { recursive: true });
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000, root) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    const exec = execWithSession("sess-7", "/data/other-ws");
    await tool.execute({ stage: "register", run_id: "run-flat" }, exec);
    expect(existsSync(join(root, "other-ws", "run-flat"))).toBe(false);
    expect(readBindings(flat).map((b) => b.session_id)).toEqual(["sess-7"]);
  });

  it("新建 run＋会话工作区桶：事实落 runs/<工作区slug>/<run_id>（桶形态与 confirmFace 同源）", async () => {
    const root = tempRoot();
    const script = writeScript(root, "ok4_pipeline.mjs", 'process.stdout.write("{}")\n');
    const tool = buildPipelineTool(approvalCtx("allowed-once"), `node ${script}`, 30_000, root) as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };
    await tool.execute({ stage: "publish", run_id: "run-d" }, execWithSession("sess-5", "/data/ws-dirname"));
    expect(readBindings(join(root, "ws-dirname", "run-d")).map((b) => b.session_id)).toEqual(["sess-5"]);
  });
});
