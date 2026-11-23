/**
 * 目录结构 v1 工具链测试锚（设计基线 D4/D5/D6）——工作区身份/DSH 注册表/会话桶三面：
 * 纯函数层（workspaceRegistry.ts 逐语义）＋工具 handler 层（经 buildMcpTools 真装配——
 * 审批 seam/参数折算/结构化回流同链实证）＋投影面护栏（MODEL_TOOL_NAMES ⊆ 工作区分册）。
 *
 * 全程临时目录注入（host.dshHome——装配面同源取值链）；注册表写入前备份、其他 record
 * 零触碰、身份 id 永不改变三条红线逐条断言。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bucketNameForWorkspacePath,
  createExperimentInWorkspace,
  listRegistryRecords,
  readRegistryFile,
  readWorkspaceIdentity,
  registryPathOf,
  resolveDshHome,
  sessionsRootOf,
  updateRegistryRecordPath,
  EXPERIMENT_NAME_PATTERN,
} from "../../src/core/workspace/workspaceRegistry.js";
import { buildMcpTools, MODEL_TOOL_NAMES } from "../../packages/extensions/atf-tools/src/mcpToolFace.js";
import { TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from "../../src/core/tools/index.js";
import { rpcMethodFor } from "../../src/core/tools/methodOverrides.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-wsreg-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 建一个临时 DSH 家（storages/workspace.json 种子可选）。 */
const seedDshHome = (records: Record<string, unknown> = {}, workspaceIds: string[] = []): string => {
  const home = tempRoot();
  mkdirSync(join(home, "storages"), { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  const registry = {
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, workspaceIds, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: records },
  };
  writeFileSync(registryPathOf(home), JSON.stringify(registry, null, 2) + "\n");
  return home;
};

/** 建一个注册过的存量工作区（record＋可选旧桶＋旧位置目录）。 */
const seedRegisteredWorkspace = (home: string, id: string, path: string, title = "ws"): void => {
  const registry = readRegistryFile(registryPathOf(home)) as Record<string, unknown>;
  const tables = registry["tables"] as Record<string, Record<string, Record<string, unknown>>>;
  tables["workspaces"]![id] = {
    path,
    title,
    sessionIds: ["session-aaaa", "session-bbbb"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  (registry["global"] as Record<string, unknown>)["workspaceIds"] = [
    ...((registry["global"] as Record<string, unknown>)["workspaceIds"] as string[]),
    id,
  ];
  writeFileSync(registryPathOf(home), JSON.stringify(registry, null, 2) + "\n");
};

/** 写身份文件（T1 格式）。 */
const seedIdentity = (workspacePath: string, id: string): void => {
  mkdirSync(join(workspacePath, ".atf"), { recursive: true });
  writeFileSync(
    join(workspacePath, ".atf", "workspace.json"),
    JSON.stringify({ id, name: "ws", experiments: [], createdAt: "2026-10-01T00:00:00.000Z" }, null, 2) + "\n",
  );
};

const toolExec = async (host: { dshHome?: string }, outcome: string, name: "atf_create_experiment" | "atf_rebind_workspace") => {
  const ctx = { get: (service: string) => (service === "approval" ? { request: async () => outcome } : undefined) };
  // G5：buildMcpTools 装配面先拉 MCP tools/list——本地治理件测试不 spawn 真对端，
  // 以最小 descriptor 桩供给装配（工厂面〔workspace_status〕不在此测试触达）。
  const tools = await buildMcpTools(ctx, { mcpTools: async () => TOOL_DEFINITIONS.map((definition) => ({ name: rpcMethodFor(definition.name), description: definition.description, inputSchema: { type: "object", properties: {}, additionalProperties: true } })), transport: async () => ({ request: async () => ({ ok: true, value: {} }), close: async () => undefined }) } as never, {
    runsRoot: tempRoot(),
    kernelDir: tempRoot(),
    execHome: tempRoot(),
    ...host,
  });
  const tool = tools.find((entry) => (entry as { name: string }).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}`);
  return tool as { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> };
};

const fakeExec = { agent: undefined, callId: "wsreg", signal: undefined };

// ---------------------------------------------------------------- 纯函数层

describe("workspaceRegistry 纯函数层（身份/注册表/桶编码）", () => {
  it("桶名编码：/data/sam→--data-sam--、/tmp/b18-ws→--tmp-b18-ws--（实证单源）；相对路径拒绝", () => {
    expect(bucketNameForWorkspacePath("/data/sam")).toBe("--data-sam--");
    expect(bucketNameForWorkspacePath("/tmp/b18-ws")).toBe("--tmp-b18-ws--");
    expect(bucketNameForWorkspacePath("/tmp/ws/nested/")).toBe("--tmp-ws-nested--");
    expect(() => bucketNameForWorkspacePath("relative/path")).toThrow(/绝对路径/);
  });

  it("DSH 家解析：显式注入＞DSH_HOME env＞~/.dsh（写读同链单源）", () => {
    expect(resolveDshHome({ DSH_HOME: "/data/dsh-home" }, "/root")).toBe("/data/dsh-home");
    expect(resolveDshHome({}, "/root")).toBe("/root/.dsh");
  });

  it("实验名 slug 闭集：合法通过／大写/下划线/前导连字符拒绝", () => {
    expect(EXPERIMENT_NAME_PATTERN.test("iter-1")).toBe(true);
    expect(EXPERIMENT_NAME_PATTERN.test("0baseline")).toBe(true);
    expect(EXPERIMENT_NAME_PATTERN.test("Iter-1")).toBe(false);
    expect(EXPERIMENT_NAME_PATTERN.test("_x")).toBe(false);
    expect(EXPERIMENT_NAME_PATTERN.test("-x")).toBe(false);
  });

  it("createExperiment：身份初始化（uuid/name/experiments/createdAt）＋实验目录/元数据/runs＋索引追加", () => {
    const ws = tempRoot();
    mkdirSync(ws, { recursive: true });
    const home = seedDshHome();
    const outcome = createExperimentInWorkspace(ws, "iter-1", new Date("2026-10-16T08:00:00Z"), home);
    expect(outcome.registryStatus).toBe("pending_registration");
    expect(outcome.identityCreated).toBe(true);
    expect(outcome.experimentDir).toBe(join(ws, "experiments", "iter-1")); // 轮三单源化:裸名(RunLayout/v3)
    expect(existsSync(join(outcome.experimentDir, "experiment.json"))).toBe(true);
    expect(existsSync(join(outcome.experimentDir, "runs"))).toBe(false); // 轮三:run 直挂,不建 runs/ 中间层
    const identity = readWorkspaceIdentity(ws);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe(outcome.workspaceId);
    expect(identity!.name).toBe(ws.split("/").pop()); // name＝目录名（slug 可改面）
    expect(identity!.experiments).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(outcome.experimentDir, "experiment.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ name: "iter-1", workspaceId: outcome.workspaceId, datasets: [], baseline: null });
  });

  it("createExperiment：路径不存在/非目录/重名（同名——轮三单源化后实验目录=裸名,同名即同实验）→ 指路文案三态；既有身份文件复用（id 不变）", () => {
    const home = seedDshHome();
    expect(() => createExperimentInWorkspace(join(tempRoot(), "nope"), "a", new Date(), home)).toThrow(/不代建顶层工作区目录/);
    const fileWs = tempRoot() + "-f";
    writeFileSync(fileWs, "x");
    expect(() => createExperimentInWorkspace(fileWs, "a", new Date(), home)).toThrow(/不是目录/);
    const ws = tempRoot();
    mkdirSync(ws, { recursive: true });
    const first = createExperimentInWorkspace(ws, "dup", new Date("2026-10-16T08:00:00Z"), home);
    expect(() => createExperimentInWorkspace(ws, "dup", new Date("2026-10-16T09:00:00Z"), home)).toThrow(/重名实验/);
    const identityBefore = readWorkspaceIdentity(ws)!.id;
    const second = createExperimentInWorkspace(ws, "dup2", new Date("2026-10-17T08:00:00Z"), home);
    expect(second.workspaceId).toBe(identityBefore);
    expect(first.workspaceId).toBe(identityBefore);
    expect(readWorkspaceIdentity(ws)!.experiments).toHaveLength(2);
  });

  it("createExperiment 注册表判定：canonical path 已注册＝already_registered（真实目录 realpath）", () => {
    const home = seedDshHome();
    const realRoot = tempRoot();
    const ws = join(realRoot, "ws-real");
    mkdirSync(ws, { recursive: true });
    seedRegisteredWorkspace(home, "11111111-1111-4111-8111-111111111111", ws);
    const outcome = createExperimentInWorkspace(ws, "exp", new Date(), home);
    expect(outcome.registryStatus).toBe("already_registered");
  });

  it("updateRegistryRecordPath：只改目标 record 的 path/updatedAt，其他 record 与全局段保留＋备份落盘", () => {
    const idA = "22222222-2222-4222-8222-222222222222";
    const idB = "33333333-3333-4333-8333-333333333333";
    const home = seedDshHome({
      [idB]: { path: "/data/other", title: "other", sessionIds: ["session-cccc"], createdAt: "t", updatedAt: "t" },
    });
    seedRegisteredWorkspace(home, idA, "/data/old-ws");
    const before = readFileSync(registryPathOf(home), "utf8");
    updateRegistryRecordPath(registryPathOf(home), idA, "/data/new-ws", "2026-10-16T00:00:00.000Z");
    const registry = readRegistryFile(registryPathOf(home)) as { tables: { workspaces: Record<string, Record<string, unknown>> } };
    expect(registry.tables.workspaces[idA]!["path"]).toBe("/data/new-ws");
    expect(registry.tables.workspaces[idA]!["title"]).toBe("ws");
    expect(registry.tables.workspaces[idA]!["sessionIds"]).toEqual(["session-aaaa", "session-bbbb"]);
    expect(registry.tables.workspaces[idB]!["path"]).toBe("/data/other");
    expect(((registry as Record<string, unknown>)["global"] as Record<string, unknown>)["workspaceIds"]).toContain(idA);
    const backups = readdirSync(join(home, "storages")).filter((name) => name.includes(".bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, "storages", backups[0]!), "utf8")).toBe(before);
  });

  it("listRegistryRecords：path 在位/丢失二态如实（ENOENT＝exists:false——目录丢失呈现面数据源）", () => {
    const idA = "44444444-4444-4444-8444-444444444444";
    const present = tempRoot();
    mkdirSync(present, { recursive: true });
    const home = seedDshHome({
      [idA]: { path: present, title: "present", sessionIds: [], createdAt: "t", updatedAt: "t" },
      ["55555555-5555-4555-8555-555555555555"]: { path: join(tempRoot(), "gone"), title: "gone", sessionIds: [], createdAt: "t", updatedAt: "t" },
    });
    const records = listRegistryRecords(home);
    expect(records).toHaveLength(2);
    const byTitle = Object.fromEntries(records.map((record) => [record.title, record]));
    expect(byTitle["present"]!.exists).toBe(true);
    expect(byTitle["gone"]!.exists).toBe(false);
  });
});

// ---------------------------------------------------------------- rebind 纯函数层


// ---------------------------------------------------------------- 工具 handler 层（经 buildMcpTools 真装配）

describe("工作区治理两工具 handler（WebUI 桥装配同链——审批/折算/回流）", () => {
  it("atf_create_experiment：直通真建（canonical 全键）——审批面 rejected 也放行（ADR-0022 拦截退役）", async () => {
    const home = seedDshHome();
    const ws = tempRoot();
    mkdirSync(ws, { recursive: true });
    const allowed = await toolExec({ dshHome: home }, "allowed-once", "atf_create_experiment");
    expect(allowed.name).toBe("atf_create_experiment");
    const result = (await allowed.execute({ workspace_path: ws, experiment_name: "e2e-1" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, registry_status: "pending_registration", experiments_count: 1 });
    expect(existsSync(join(ws, "experiments"))).toBe(true);

    // ADR-0022：授权拦截轨退役——审批面应答 rejected 不再折算 denial，动作照常执行
    const rejected = await toolExec({ dshHome: home }, "rejected", "atf_create_experiment");
    const ws2 = tempRoot();
    mkdirSync(ws2, { recursive: true });
    const rejectedResult = (await rejected.execute({ workspace_path: ws2, experiment_name: "e2e-2" }, fakeExec)) as Record<string, unknown>;
    expect(rejectedResult).toMatchObject({ ok: true, registry_status: "pending_registration", experiments_count: 1 });
    expect(existsSync(join(ws2, ".atf"))).toBe(true);
    expect(existsSync(join(ws2, "experiments"))).toBe(true);
  });

  it("atf_create_experiment：路径不存在→rejected(invalid_params)＋指路文案（不代建目录）", async () => {
    const home = seedDshHome();
    const tool = await toolExec({ dshHome: home }, "allowed-once", "atf_create_experiment");
    const result = (await tool.execute({ workspace_path: join(tempRoot(), "missing"), experiment_name: "x" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ error: "rejected", reason: "invalid_params" });
    expect(String((result as { detail?: { message?: string } }).detail?.message)).toContain("不代建顶层工作区目录");
  });

});

// ---------------------------------------------------------------- 投影面护栏（contract_field_wiring 同族）

describe("投影面护栏：MODEL_TOOL_NAMES ⊆ 契约定义单源（G5 后=TOOL_DEFINITIONS ∪ WORKSPACE_TOOL_DEFINITIONS）", () => {
  it("十四件投影名全部能在契约定义单源找到（MCP 模型面 9＋工作区治理分册）", () => {
    const contractNames = [...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS].map((definition) => definition.name);
    for (const name of MODEL_TOOL_NAMES) expect(contractNames).toContain(name);
    expect(MODEL_TOOL_NAMES).toContain("atf_create_experiment");
    // F14：atf_label_qc_resolve 与 inspect 同面开放（决议入口，见 labelQcResume.test.ts）→ 9→10
    expect(MODEL_TOOL_NAMES).toContain("atf_label_qc_resolve");
    // G5（2026-11-22）：MCP 化模型面全量投影——10→14（fact_scan/data_admission_request/
    // preparation_propose/style_cluster_execute 四件经 MCP tools/list 进 DSH 面）
    expect(MODEL_TOOL_NAMES).toHaveLength(11);
  });
});
