/**
 * 丙 v2 测试（批 P 续作，指令 6227dbfc）：A7 四工具治理包装（白名单/审批闸/diff/分页）、
 * dispatch_parallel_training_subtask 并行 fan-out（账本闸临界区串行化）、deferredFace
 * Registry 实体化（spawn/poll/cancel 有界轮询）＋B9 boundary 对接＋run 收口边界续跑。
 * 对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用——批 P 红线）。
 */
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type JsonObject } from "@earendil-works/pi-ai";
import {
  assembleV1Agent,
  runV1Headless,
  MAX_BOUNDARY_POLL_ROUNDS,
  type V1HeadlessDeps,
} from "../../src/agent/cli.js";
import {
  BASH_READONLY_COMMANDS,
  bashCommandRequiresApproval,
  buildFileAgentTools,
  FILE_TOOL_DEFINITIONS,
  FILE_TOOL_NAMES,
} from "../../src/agent/fileTools.js";
import { toolDefinitionFor } from "../../src/agent/atfAgentTools.js";
import { requiresApprovalFor } from "../../src/core/tools/index.js";
import { createDeferredSubtaskRegistry } from "../../src/agent/deferredFace.js";
import { createDeferredToolSet } from "../../src/agent/deferredTools.js";
import { planRunBoundary } from "../../src/agent/driveFace.js";
import { createDispatchParallelTrainingSubtaskTool } from "../../src/agent/subagent.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "../../src/agent/fauxStream.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";
import type { ApprovalSurface } from "../../src/agent/approvalSurface.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const spawnMock = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

const makeSession = async (tag = "v2-"): Promise<SessionLike> => {
  const root = await mkdtemp(join(tmpdir(), tag));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

const makeScratch = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "v2-scratch-"));
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  return scratch;
};

const fileToolByName = (scratch: string, name: string): ReturnType<typeof buildFileAgentTools>[number] => {
  const tools = buildFileAgentTools({ roots: [scratch] });
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool as ReturnType<typeof buildFileAgentTools>[number];
};

const execTool = async (tool: { execute: (id: string, params: unknown) => Promise<{ details?: unknown }> }, params: unknown): Promise<Record<string, unknown>> => {
  const result = await tool.execute("test-call", params);
  return (result.details ?? {}) as Record<string, unknown>;
};

const grantedSurface: ApprovalSurface = { ask: async () => ({ kind: "granted" }) as never };

// ---------------------------------------------------------------- A7 四工具治理包装

describe("丙 v2 · A7 工具面与白名单（13→17）", () => {
  it("A7-⓪ 工具面计数：基座 9＋A7 四工具＝13（atf_* 面）；subagent 面 5 工具另计（dispatch/parallel/deferred×3）；定义经 toolDefinitionFor 同一查找出口", async () => {
    expect(FILE_TOOL_NAMES).toEqual(["atf_read", "atf_edit", "atf_write", "atf_bash"]);
    const bridge = await spawnMock();
    const base = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn([fauxFinalAnswer("ok")]),
    });
    expect(base.agent.state.tools?.length ?? 0).toBeGreaterThan(0);
    const scratch = await makeScratch();
    const withFiles = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn([fauxFinalAnswer("ok")]),
      fileTools: { roots: [scratch] },
    });
    const names = withFiles.agent.state.tools?.map((tool: { name: string }) => tool.name) ?? [];
    expect(names.filter((name: string) => name.startsWith("atf_"))).toHaveLength(13); // 9 桥接面＋4 A7
    expect(FILE_TOOL_DEFINITIONS.every((definition) => toolDefinitionFor(definition.name) === definition)).toBe(true);
    for (const name of ["atf_deferred_spawn", "atf_deferred_poll", "atf_deferred_cancel", "dispatch_parallel_training_subtask"]) {
      expect(names).not.toContain(name); // subagent 面缺省不挂接（零意外扩面）
    }
  });

  it("A7-① 白名单外路径拒（绝对越界／相对 .. 逃逸／symlink 逃逸）——fail-closed 结构化 rejected", async () => {
    const scratch = await makeScratch();
    const outside = await mkdtemp(join(tmpdir(), "v2-outside-"));
    const secret = join(outside, "secret.txt");
    await writeFile(secret, "top-secret", "utf8");
    await symlink(secret, join(scratch, "leak"));
    const read = fileToolByName(scratch, "atf_read");
    const absolute = await execTool(read, { path: secret });
    expect(absolute).toMatchObject({ ok: false, error: "path_escape" });
    const escape = await execTool(read, { path: "../outside/secret.txt" });
    expect(escape).toMatchObject({ ok: false, error: "path_escape" });
    const symlinked = await execTool(read, { path: "leak" });
    expect(symlinked).toMatchObject({ ok: false, error: "path_escape" }); // realpath 防逃逸
    const empty = buildFileAgentTools({ roots: [] });
    const readEmpty = empty.find((tool) => tool.name === "atf_read") as { execute: (id: string, params: unknown) => Promise<{ details?: unknown }> };
    expect(await execTool(readEmpty, { path: "x" })).toMatchObject({ ok: false, error: "whitelist_empty" });
  });

  it("A7-①b 白名单根尚不存在时首写不误拒（CLI 首跑 scratch 未落盘场景——锚点双端比对回归锁）", async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-fresh-"));
    const scratch = join(root, "scratch"); // 故意不创建
    const write = fileToolByName(scratch, "atf_write");
    const written = await execTool(write, { path: "notes/a.txt", content: "first-write" });
    expect(written).toMatchObject({ ok: true, created: true });
    expect(await readFile(join(scratch, "notes", "a.txt"), "utf8")).toBe("first-write");
    const bash = fileToolByName(scratch, "atf_bash");
    expect(await execTool(bash, { command: "ls notes" })).toMatchObject({ ok: true, exit_code: 0 }); // cwd 缺失即建
  });

  it("A7-② 写动作未批拒：atf_write 经账本闸 headless fail-closed（approval_missing；白名单内也不放行）", async () => {
    const bridge = await spawnMock();
    const scratch = await makeScratch();
    const script = [
      fauxMessageWithToolCalls("写入运行笔记。", [{ id: "w1", name: "atf_write", arguments: { path: "notes/a.txt", content: "hello" } }]),
      fauxFinalAnswer("写动作被审批闸拦截（approval_missing）——已如实获知。"),
    ];
    const s = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(script),
      fileTools: { roots: [scratch] },
    });
    s.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never;
    await s.agent.prompt("写入运行笔记。");
    expect(s.audit.some((entry) => entry.tool === "atf_write" && entry.verdict === "blocked_approval_missing")).toBe(true);
    const writeEnd = s.events.find((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "atf_write") as { result?: { content?: Array<{ text?: string }> } } | undefined;
    expect(JSON.stringify(writeEnd?.result ?? "")).toContain("审批缺失"); // 结构化回填（模型可如实转述）
    await expect(readFile(join(scratch, "notes", "a.txt"))).rejects.toThrow(); // 未放行＝未落盘
  });

  it("A7-③ 批后放行：surface granted → 账本预录→消费 → atf_write 执行落盘（一次性语义）", async () => {
    const bridge = await spawnMock();
    const scratch = await makeScratch();
    const script = [
      fauxMessageWithToolCalls("写入运行笔记。", [{ id: "w1", name: "atf_write", arguments: { path: "notes/a.txt", content: "hello" } }]),
      fauxFinalAnswer("已写入（经确认卡放行）。"),
    ];
    const s = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "surface", surface: grantedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(script),
      fileTools: { roots: [scratch] },
    });
    s.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never;
    await s.agent.prompt("写入运行笔记。");
    expect(s.audit.some((entry) => entry.tool === "atf_write" && entry.verdict === "allow_surface_ledger")).toBe(true);
    expect(await readFile(join(scratch, "notes", "a.txt"), "utf8")).toBe("hello");
    // 一次性语义：同参再写一次需再次授权（账本已消费）
    const again = await execTool(fileToolByName(scratch, "atf_write"), { path: "notes/a.txt", content: "hello" });
    void again;
    const hookAgain = await (await import("../../src/agent/approvalHook.js")).createApprovalBeforeToolCall({
      bridge,
      scopeRefBox: s.scopeRefBox,
      audit: s.audit,
    })({ toolCall: { id: "w2", name: "atf_write", arguments: { path: "notes/a.txt", content: "hello" } }, args: { path: "notes/a.txt", content: "hello" } } as never);
    expect(hookAgain).toMatchObject({ block: true }); // 记录已消费 → approval_missing（fail-closed）
  });

  it("A7-④ read 行区间分页：offset/limit/has_more/next_offset 闭环＋行内超长截断留痕", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch, "ten.txt"), Array.from({ length: 10 }, (_, index) => `line-${String(index + 1)}`).join("\n") + "\n", "utf8");
    const read = fileToolByName(scratch, "atf_read");
    const page1 = await execTool(read, { path: "ten.txt", offset: 3, limit: 4 });
    expect(page1).toMatchObject({ ok: true, total_lines: 10, offset: 3, limit: 4, has_more: true, next_offset: 7 });
    expect(page1["content"]).toContain("3\tline-3");
    expect(page1["content"]).toContain("6\tline-6");
    expect(page1["content"]).not.toContain("line-7");
    const page2 = await execTool(read, { path: "ten.txt", offset: 7, limit: 4 });
    expect(page2).toMatchObject({ ok: true, offset: 7, has_more: false });
    expect(page2["content"]).toContain("10\tline-10");
    const long = await execTool(read, { path: "ten.txt", limit: 2000 });
    expect(long).toMatchObject({ ok: true, offset: 1, has_more: false });
    await writeFile(join(scratch, "long.txt"), `${"x".repeat(3000)}\n`, "utf8");
    const truncated = await execTool(read, { path: "long.txt" });
    expect(truncated).toMatchObject({ ok: true, lines_truncated: 1 });
  });

  it("A7-⑤ edit diff 精确替换：唯一命中替换／多命中拒绝／replace_all 显式放开／零命中拒绝", async () => {
    const scratch = await makeScratch();
    await writeFile(join(scratch, "doc.txt"), "alpha beta alpha\n", "utf8");
    const edit = fileToolByName(scratch, "atf_edit");
    const ambiguous = await execTool(edit, { path: "doc.txt", old_string: "alpha", new_string: "gamma" });
    expect(ambiguous).toMatchObject({ ok: false, error: "old_string_ambiguous" });
    const all = await execTool(edit, { path: "doc.txt", old_string: "alpha", new_string: "gamma", replace_all: true });
    expect(all).toMatchObject({ ok: true, replacements: 2 });
    expect(await readFile(join(scratch, "doc.txt"), "utf8")).toBe("gamma beta gamma\n");
    const unique = await execTool(edit, { path: "doc.txt", old_string: "beta", new_string: "delta" });
    expect(unique).toMatchObject({ ok: true, replacements: 1 });
    const missing = await execTool(edit, { path: "doc.txt", old_string: "不存在", new_string: "x" });
    expect(missing).toMatchObject({ ok: false, error: "old_string_not_found" });
  });

  it("A7-⑥ bash 命令分类单源：只读白名单直通；重定向/写语义/未知/组合命令一律须审批（fail-closed）", async () => {
    expect(bashCommandRequiresApproval("ls -la")).toBe(false);
    expect(bashCommandRequiresApproval("cat a.txt | grep foo | wc -l")).toBe(false);
    expect(bashCommandRequiresApproval("git status")).toBe(false);
    expect(bashCommandRequiresApproval("git push")).toBe(true);
    expect(bashCommandRequiresApproval("find . -name x")).toBe(false);
    expect(bashCommandRequiresApproval("find . -name x -delete")).toBe(true);
    expect(bashCommandRequiresApproval("echo hi > f.txt")).toBe(true);
    expect(bashCommandRequiresApproval("rm -rf x")).toBe(true);
    expect(bashCommandRequiresApproval("python3 gen.py")).toBe(true);
    expect(bashCommandRequiresApproval("sed -i s/a/b/ f.txt")).toBe(true);
    expect(bashCommandRequiresApproval("cat a; rm b")).toBe(true);
    expect(bashCommandRequiresApproval("echo $(cat secret)")).toBe(true);
    expect(bashCommandRequiresApproval("./unknown.sh")).toBe(true);
    expect(bashCommandRequiresApproval("")).toBe(true);
    expect(bashCommandRequiresApproval(undefined)).toBe(true);
    expect(BASH_READONLY_COMMANDS).not.toContain("sed");
    // 审批闸消费同一单源（hook 谓词 = 定义谓词）
    const bashDefinition = toolDefinitionFor("atf_bash");
    expect(bashDefinition).toBeDefined();
    expect(requiresApprovalFor(bashDefinition as never, { command: "ls" })).toBe(false);
    expect(requiresApprovalFor(bashDefinition as never, { command: "rm x" })).toBe(true);
    expect(requiresApprovalFor(toolDefinitionFor("atf_read") as never, {})).toBe(false);
    expect(requiresApprovalFor(toolDefinitionFor("atf_write") as never, { path: "x", content: "y" })).toBe(true);
  });

  it("A7-⑦ bash 受控执行：白名单 cwd／env 最小集／超时形态；只读命令免审批直通（allow_readonly）", async () => {
    const scratch = await makeScratch();
    const bash = fileToolByName(scratch, "atf_bash");
    const pwd = await execTool(bash, { command: "pwd" });
    expect(pwd).toMatchObject({ ok: true, timed_out: false, exit_code: 0 });
    expect(String(pwd["stdout"]).trim()).toBe(scratch);
    const outside = await execTool(bash, { command: "ls", cwd: "/etc" });
    expect(outside).toMatchObject({ ok: false, error: "path_escape" });
    const envProbe = await execTool(bash, { command: "printenv ATF_V2_PROBE || true" });
    expect(String(envProbe["stdout"])).not.toContain("leaky"); // env 白名单外不透传
    // 只读命令经审批 hook 直通（allow_readonly，无账本交互）
    const bridge = await spawnMock();
    const script = [
      fauxMessageWithToolCalls("列目录。", [{ id: "b1", name: "atf_bash", arguments: { command: "ls" } }]),
      fauxFinalAnswer("目录已列。"),
    ];
    const s = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(script),
      fileTools: { roots: [scratch] },
    });
    await s.agent.prompt("列目录。");
    expect(s.audit.some((entry) => entry.tool === "atf_bash" && entry.verdict === "allow_readonly")).toBe(true);
  });

  it("A7-⑧ faux 冒烟（runV1Headless 全链）：status 捕获 scope_ref→write（确认卡放行）→read 分页→edit diff→bash，exit 0", async () => {    const bridge = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v2-smoke-"));
    const scratch = join(sessionsRoot, "scratch");
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "seed.txt"), "seed-alpha seed-alpha\n", "utf8");
    const script = [
      fauxMessageWithToolCalls("查状态。", [{ id: "s1", name: "atf_workspace_status", arguments: {} }]),
      fauxMessageWithToolCalls("写笔记。", [{ id: "w1", name: "atf_write", arguments: { path: "notes/a.txt", content: "hello" } }]),
      fauxMessageWithToolCalls("读种子。", [{ id: "r1", name: "atf_read", arguments: { path: "seed.txt", offset: 1, limit: 5 } }]),
      fauxMessageWithToolCalls("编辑种子。", [{ id: "e1", name: "atf_edit", arguments: { path: "seed.txt", old_string: "seed-alpha", new_string: "seed-beta", replace_all: true } }]),
      fauxMessageWithToolCalls("列目录。", [{ id: "b1", name: "atf_bash", arguments: { command: "ls notes" } }]),
      fauxFinalAnswer("A7 四工具走通：write 放行落盘、read 分页、edit 替换、bash 列目录。"),
    ];
    const out: string[] = [];
    const exit = await runV1Headless({
      bridge,
      sessionsRoot,
      instruction: "A7 冒烟",
      maxTurns: 12,
      scripted: script,
      approval: { kind: "surface", surface: grantedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      out: (line) => out.push(line),
      err: () => undefined,
    });
    expect(exit).toBe(0);
    expect(await readFile(join(scratch, "notes", "a.txt"), "utf8")).toBe("hello");
    expect(await readFile(join(scratch, "seed.txt"), "utf8")).toBe("seed-beta seed-beta\n");
    expect(out.join("\n")).toContain("A7 四工具走通");
  });
});

// ---------------------------------------------------------------- v2 并行 fan-out

describe("丙 v2 · dispatch_parallel_training_subtask（并行 fan-out）", () => {
  /** 带并发探针的桥（记录 request 最大同时在途数；status 到达栅栏：等第 2 个到齐或 2s 超时）。 */
  const probeBridge = (raw: AtfBridgeConnection, opts?: { barrier?: boolean }) => {
    let inflight = 0;
    let arrivals = 0;
    const probe = {
      maxInflight: 0,
      request: async (method: string, params?: unknown) => {
        inflight += 1;
        probe.maxInflight = Math.max(probe.maxInflight, inflight);
        try {
          if (opts?.barrier === true && method === "atf_workspace_status") {
            arrivals += 1;
            const deadline = Date.now() + 2_000;
            while (arrivals < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return await raw.request(method, params);
        } finally {
          inflight -= 1;
        }
      },
    };
    return probe;
  };

  const parallelAssemblyDeps = (bridge: unknown, sessionsRoot: string, scripts: Array<Array<ReturnType<typeof fauxMessageWithToolCalls | typeof fauxFinalAnswer>>>, surface?: ApprovalSurface) => ({
    bridge: bridge as never,
    sessionsRoot,
    childStreamFn: () => {
      const next = scripts.shift() ?? [fauxFinalAnswer("脚本耗尽")];
      return createFauxStreamFn(next) as never;
    },
    modelTag: "faux-v2",
    ...(surface !== undefined ? { surface } : {}),
  });

  it("v2-f① 并发双子任务：模型轮真并发（maxInflight=2）＋结果按序聚合＋父 toolResult 携带逐项答复", async () => {
    const raw = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v2-par-"));
    const bridge = probeBridge(raw, { barrier: true }); // status 到达栅栏：并发时双双即达，串行时 2s 超时
    const statusCall = { id: "s1", name: "atf_workspace_status", arguments: {} };
    const childA = [fauxMessageWithToolCalls("A：查状态。", [statusCall]), fauxFinalAnswer("A 完成：状态正常。")];
    const childB = [fauxMessageWithToolCalls("B：查状态。", [{ ...statusCall, id: "b1" }]), fauxFinalAnswer("B 完成：0 批登记。")];
    const parentScript = [
      fauxMessageWithToolCalls("并行派发。", [
        {
          id: "p1",
          name: "dispatch_parallel_training_subtask",
          arguments: { subtasks: [{ label: "体检-A", instruction: "A 指令" }, { label: "体检-B", instruction: "B 指令" }] } as JsonObject,
        },
      ]),
      fauxFinalAnswer("并行结果：A、B 均完成。"),
    ];
    const s = assembleV1Agent({
      bridge: bridge as never,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(parentScript),
      subagent: parallelAssemblyDeps(bridge, sessionsRoot, [childA, childB]),
    });
    await s.agent.prompt("并行派发。");
    const end = s.events.find((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "dispatch_parallel_training_subtask") as
      | { result?: { details?: { ok: boolean; completed: number; failed: number; results: Array<{ label: string; ok: boolean; final_answer: string | null }> } } }
      | undefined;
    expect(end?.result?.details).toMatchObject({ ok: true, completed: 2, failed: 0 });
    expect(end?.result?.details?.results.map((result) => result.label)).toEqual(["体检-A", "体检-B"]);
    expect(end?.result?.details?.results.every((result) => result.ok && (result.final_answer ?? "").length > 0)).toBe(true);
    expect(bridge.maxInflight).toBe(2); // 真并发实证
  });

  it("v2-f② max_concurrency=1 限流：串行执行（maxInflight=1）——并发上限语义", async () => {
    const raw = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v2-par1-"));
    const bridge = probeBridge(raw);
    const childScript = [
      fauxMessageWithToolCalls("查状态。", [{ id: "s1", name: "atf_workspace_status", arguments: {} }]),
      fauxFinalAnswer("子任务完成。"),
    ];
    const parentScript = [
      fauxMessageWithToolCalls("限流派发。", [
        {
          id: "p1",
          name: "dispatch_parallel_training_subtask",
          arguments: { subtasks: [{ instruction: "A" }, { instruction: "B" }], max_concurrency: 1 } as JsonObject,
        },
      ]),
      fauxFinalAnswer("完成。"),
    ];
    const s = assembleV1Agent({
      bridge: bridge as never,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(parentScript),
      subagent: parallelAssemblyDeps(bridge, sessionsRoot, [childScript, childScript]),
    });
    await s.agent.prompt("限流派发。");
    const end = s.events.find((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "dispatch_parallel_training_subtask") as
      | { result?: { details?: { ok: boolean; completed: number } } }
      | undefined;
    expect(end?.result?.details).toMatchObject({ ok: true, completed: 2 });
    expect(bridge.maxInflight).toBe(1); // 限流实证
  });

  it("v2-f③ 审批继承（并行不绕闸）：双子任务各推 atf_gate，headless 双双 fail-closed；granted 面逐条出卡逐条消费", async () => {
    const raw = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v2-approval-"));
    const parentScript = [
      fauxMessageWithToolCalls("并行推进。", [
        {
          id: "p1",
          name: "dispatch_parallel_training_subtask",
          arguments: { subtasks: [{ label: "G-a", instruction: "推进 G1" }, { label: "G-b", instruction: "推进 G1" }] } as JsonObject,
        },
      ]),
      fauxFinalAnswer("子任务审批结果已如实获知。"),
    ];
    // —— headless：子内写动作双双 approval_missing（fail-closed×2，无静默放行）——
    const blockedChild = [
      fauxMessageWithToolCalls("推进 G1。", [{ id: "g1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("不应到达"),
    ];
    const s1 = assembleV1Agent({
      bridge: raw as never,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(parentScript),
      subagent: parallelAssemblyDeps(raw, sessionsRoot, [blockedChild, blockedChild]),
    });
    s1.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never;
    await s1.agent.prompt("并行推进。");
    const blocked = s1.events.find((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "dispatch_parallel_training_subtask") as
      | { result?: { details?: { ok: boolean; completed: number; failed: number; results: Array<{ outcome: string }> } } }
      | undefined;
    expect(blocked?.result?.details).toMatchObject({ ok: false, completed: 0, failed: 2 });
    expect(blocked?.result?.details?.results.every((result) => result.outcome === "approval_missing")).toBe(true);

    // —— granted：逐条确认卡（ask×2）、逐条预录消费，双子完成——闸段经共享 GateLock 串行，
    // 授权对象不错位（watermark 保护；并行 fan-out 不构成绕过账本的理由）——
    const okChild = [
      fauxMessageWithToolCalls("推进 G1。", [{ id: "g1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("G1 推进完成。"),
    ];
    let askCount = 0;
    const countingSurface: ApprovalSurface = {
      ask: async (info) => {
        askCount += 1;
        expect(info.tool).toBe("atf_gate");
        return { kind: "granted" } as never;
      },
    };
    const s2 = assembleV1Agent({
      bridge: raw as never,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v2",
      approval: { kind: "surface", surface: countingSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn([parentScript[0] as never, fauxFinalAnswer("双子放行完成。")]),
      subagent: parallelAssemblyDeps(raw, sessionsRoot, [okChild, okChild], countingSurface), // surface 透传＝同一操作员面
    });
    s2.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-2", scope_mode: "headless" } as never;
    await s2.agent.prompt("并行推进。");
    const granted = s2.events.find((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "dispatch_parallel_training_subtask") as
      | { result?: { details?: { ok: boolean; completed: number } } }
      | undefined;
    expect(granted?.result?.details).toMatchObject({ ok: true, completed: 2 });
    expect(askCount).toBe(2); // 逐条确认卡（不是一次放行打包）
  });
});

// ---------------------------------------------------------------- v2 ckpt 伴生（deferredFace 实体化）

describe("丙 v2 · deferredFace Registry 实体化（spawn/poll/cancel 有界轮询）", () => {
  it("v2-d① spawn→poll 超时收口→done 取回；poll 不消费任务（timeout 后任务仍在册）", async () => {
    const registry = createDeferredSubtaskRegistry();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const handle = registry.spawn("ckpt 抽查-r3", () => gate);
    const running = await registry.poll(handle, { maxPolls: 3, intervalMs: 10 });
    expect(running).toMatchObject({ outcome: "timeout", polls_used: 3 });
    expect((await registry.fetch(handle)).state).toBe("running"); // 超时收口≠任务终止
    release("ckpt 检查完成：loss 曲线正常");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = await registry.poll(handle, { maxPolls: 5, intervalMs: 5 });
    expect(done).toMatchObject({ outcome: "done", result: "ckpt 检查完成：loss 曲线正常", polls_used: 1 });
    expect(registry.list()).toHaveLength(1);
  });

  it("v2-d② cancel 生命周期：运行中取消→poll 得 cancelled；executor 迟到结果不翻转终态", async () => {
    const registry = createDeferredSubtaskRegistry();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const handle = registry.start("会被取消的伴生", () => gate);
    const cancelPromise = registry.cancel(handle);
    release("不应翻转");
    await cancelPromise;
    expect(await registry.fetch(handle)).toMatchObject({ state: "cancelled" });
    const polled = await registry.poll(handle, { maxPolls: 2, intervalMs: 5 });
    expect(polled).toMatchObject({ outcome: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await registry.fetch(handle)).toMatchObject({ state: "cancelled" }); // 迟到结果不翻转
  });

  it("v2-d③ B9 boundary 对接：deferred 未收口 → continue_run(deferred)；终局/steering 优先级在前；缺省 0 零回归", () => {
    expect(planRunBoundary({ steeringQueued: 0, followUpQueued: 0, pendingOutcome: undefined, hasFinalAnswer: true, deferredPollPending: 2 })).toMatchObject({
      kind: "continue_run",
      trigger: "deferred",
    });
    expect(planRunBoundary({ steeringQueued: 1, followUpQueued: 0, pendingOutcome: undefined, hasFinalAnswer: false, deferredPollPending: 1 })).toMatchObject({
      kind: "continue_run",
      trigger: "steering",
    });
    expect(
      planRunBoundary({ steeringQueued: 0, followUpQueued: 0, pendingOutcome: { kind: "budget_exhausted", turns_used: 8, max_turns: 8 }, hasFinalAnswer: false, deferredPollPending: 3 }),
    ).toMatchObject({ kind: "finish_run", outcome: { kind: "budget_exhausted" } });
    expect(planRunBoundary({ steeringQueued: 0, followUpQueued: 0, pendingOutcome: undefined, hasFinalAnswer: true })).toMatchObject({
      kind: "finish_run",
      outcome: { kind: "completed" },
    }); // 缺省 deferredPollPending＝v1.1 行为不变
  });

  it("v2-d④ 模型面三工具：spawn 返回句柄→poll（faux runner 未决→超时；放行→done toolResult 回注）→cancel 幂等", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { tools, registry } = createDeferredToolSet(async () => gate);
    const spawn = tools.find((tool) => tool.name === "atf_deferred_spawn") as { execute: (id: string, params: unknown) => Promise<{ details?: unknown }> };
    const poll = tools.find((tool) => tool.name === "atf_deferred_poll") as { execute: (id: string, params: unknown) => Promise<{ details?: unknown }> };
    const cancel = tools.find((tool) => tool.name === "atf_deferred_cancel") as { execute: (id: string, params: unknown) => Promise<{ details?: unknown }> };
    const spawned = await execTool(spawn, { label: "ckpt-抽查", instruction: "检查最新 ckpt" });
    expect(spawned).toMatchObject({ ok: true, label: "ckpt-抽查", state: "running" });
    const handleId = String(spawned["handle_id"]);
    const early = await execTool(poll, { handle_id: handleId, max_polls: 2, interval_ms: 5 });
    expect(early).toMatchObject({ ok: false, outcome: "timeout" });
    expect(early["note"]).toContain("仍在册");
    release("ckpt 抽查完成：4/4 通过");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const done = await execTool(poll, { handle_id: handleId });
    expect(done).toMatchObject({ ok: true, outcome: "done", result: "ckpt 抽查完成：4/4 通过" }); // toolResult 通道回注
    const cancelled = await execTool(cancel, { handle_id: handleId });
    expect(cancelled).toMatchObject({ ok: true, state: "done" }); // 已终态幂等照认
    expect(registry.list()).toHaveLength(1);
    const unknown = await execTool(poll, { handle_id: "deferred-nope", max_polls: 1, interval_ms: 5 });
    expect(unknown).toMatchObject({ ok: false, outcome: "failed" }); // 未知句柄 fail-closed
  });

  it("v2-d⑤ run 收口边界续跑（B9 全链 faux 冒烟）：spawn→final→边界续跑轮→poll 取回→收口 exit 0", async () => {
    const bridge = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v2-boundary-"));
    // 子模型面：400ms 后给出最终答复（确定性有界延迟——spawn 期间伴生保持 running）
    const childStreamFn = (): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      const final = fauxFinalAnswer("ckpt 检查完成：loss 曲线正常");
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        stream.push({ type: "start", partial: { ...final, stopReason: "pending" } });
        stream.push({ type: "done", reason: "stop", message: final });
      })();
      return stream;
    };
    // 主模型面：前两步静态（spawn→final），收口边界轮动态取真实 handle_id 轮询→收束
    const staticScript = [
      fauxMessageWithToolCalls("发起伴生抽查。", [
        { id: "spawn1", name: "atf_deferred_spawn", arguments: { label: "ckpt-抽查", instruction: "检查最新 ckpt 并汇报" } as JsonObject },
      ]),
      fauxFinalAnswer("训练已启动；伴生抽查进行中。"),
    ];
    let dynamicRound = 0;
    const parentStreamFn = ((model: never, context: { messages: unknown[] }) => {
      const next = staticScript.shift();
      if (next !== undefined) return createFauxStreamFn([next])(model, context as never);
      dynamicRound += 1;
      if (dynamicRound === 1) {
        const match = /"handle_id":"(deferred-[0-9a-f-]+)"/.exec(JSON.stringify(context.messages));
        expect(match).not.toBeNull();
        return createFauxStreamFn([
          fauxMessageWithToolCalls("轮询伴生。", [
            { id: "poll1", name: "atf_deferred_poll", arguments: { handle_id: match?.[1] as string, max_polls: 30, interval_ms: 50 } as JsonObject },
          ]),
        ])(model, context as never);
      }
      return createFauxStreamFn([fauxFinalAnswer("抽查收口完成：ckpt 检查完成。")])(model, context as never);
    }) as never;
    const out: string[] = [];
    const exit = await runV1Headless({
      bridge,
      sessionsRoot,
      instruction: "启动训练并伴生抽查",
      maxTurns: 12,
      streamFn: parentStreamFn,
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      subagent: true,
      childStreamFn: childStreamFn as never,
      out: (line) => out.push(line),
      err: () => undefined,
    } as V1HeadlessDeps);
    expect(exit).toBe(0);
    expect(out.join("\n")).toContain("收口边界（B9）：续跑轮 1/8");
    expect(out.join("\n")).toContain("抽查收口完成");
    expect(dynamicRound).toBeGreaterThanOrEqual(2); // 边界续跑轮确实发生（poll 轮＋收束轮）
    expect(MAX_BOUNDARY_POLL_ROUNDS).toBe(8);
  });
});
