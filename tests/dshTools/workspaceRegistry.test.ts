/**
 * 目录结构 v1 工具链测试锚（设计基线 D4/D5/D6）——工作区身份/DSH 注册表/会话桶三面：
 * 纯函数层（workspaceRegistry.ts 逐语义）＋工具 handler 层（经 buildBridgeTools 真装配——
 * 审批 seam/参数折算/结构化回流同链实证）＋投影面护栏（BRIDGE_TOOL_NAMES ⊆ 工作区分册）。
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
  rebindWorkspaceToPath,
  registryPathOf,
  resolveDshHome,
  sessionsRootOf,
  updateRegistryRecordPath,
  EXPERIMENT_NAME_PATTERN,
} from "../../src/core/workspace/workspaceRegistry.js";
import { buildBridgeTools, BRIDGE_TOOL_NAMES } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from "../../src/core/tools/index.js";

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

const toolExec = (host: { dshHome?: string }, outcome: string, name: "atf_create_experiment" | "atf_rebind_workspace") => {
  const ctx = { get: (service: string) => (service === "approval" ? { request: async () => outcome } : undefined) };
  const tools = buildBridgeTools(ctx, { transport: async () => ({ request: async () => ({ ok: true, value: {} }), close: async () => undefined }) } as never, {
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
    expect(outcome.experimentDir).toBe(join(ws, "experiments", "20261016-iter-1"));
    expect(existsSync(join(outcome.experimentDir, "experiment.json"))).toBe(true);
    expect(existsSync(join(outcome.experimentDir, "runs"))).toBe(true);
    const identity = readWorkspaceIdentity(ws);
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe(outcome.workspaceId);
    expect(identity!.name).toBe(ws.split("/").pop()); // name＝目录名（slug 可改面）
    expect(identity!.experiments).toHaveLength(1);
    const meta = JSON.parse(readFileSync(join(outcome.experimentDir, "experiment.json"), "utf8")) as Record<string, unknown>;
    expect(meta).toMatchObject({ name: "iter-1", workspaceId: outcome.workspaceId, datasets: [], baseline: null });
  });

  it("createExperiment：路径不存在/非目录/重名（同日同名）→ 指路文案三态；既有身份文件复用（id 不变）", () => {
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
    const second = createExperimentInWorkspace(ws, "dup", new Date("2026-10-17T08:00:00Z"), home);
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

describe("workspaceRegistry rebind（按 id 认领/桶零操作/空锚点清理三红线）", () => {
  const ID = "66666666-6666-4666-8666-666666666666";

  it("全链真做：path 更新＋会话桶零操作（旧桶原样）＋旧空锚点删除；id 不变；其他 record 零触碰", () => {
    const home = seedDshHome();
    const oldPath = join(tempRoot(), "old-ws");
    const newPath = join(tempRoot(), "new-ws");
    const otherId = "77777777-7777-4777-8777-777777777777";
    seedRegisteredWorkspace(home, ID, oldPath);
    seedRegisteredWorkspace(home, otherId, "/data/untouched");
    // 空锚点迁移形态（存量收编同款）：旧目录内容迁走后旧位重建为空目录，
    // 身份文件随内容落在新位置
    mkdirSync(oldPath, { recursive: true });
    mkdirSync(join(newPath, ".atf"), { recursive: true });
    const identityJson = JSON.stringify({ id: ID, name: "ws", experiments: [], createdAt: "2026-10-01T00:00:00.000Z" }, null, 2) + "\n";
    writeFileSync(join(newPath, ".atf", "workspace.json"), identityJson);
    // 旧桶带两会话——桶零操作红线：rebind 后旧桶原样在位（会话文件零触碰）
    const oldBucket = join(sessionsRootOf(home), bucketNameForWorkspacePath(oldPath));
    mkdirSync(join(oldBucket, "session-aaaa"), { recursive: true });
    mkdirSync(join(oldBucket, "session-bbbb"), { recursive: true });

    const outcome = rebindWorkspaceToPath(newPath, home, new Date("2026-10-16T00:00:00Z"));

    expect(outcome.workspaceId).toBe(ID);
    expect(outcome.oldPath).toBe(oldPath);
    expect(outcome.newPath).toBe(newPath);
    expect(outcome.registryUpdated).toBe(true);
    expect(outcome.bucketDisposition).toBe("old_bucket_present_kept");
    expect(outcome.oldAnchorRemoved).toBe(true);
    expect(existsSync(oldPath)).toBe(false);
    const registry = readRegistryFile(registryPathOf(home)) as { tables: { workspaces: Record<string, Record<string, unknown>> } };
    expect(registry.tables.workspaces[ID]!["path"]).toBe(newPath);
    expect(registry.tables.workspaces[ID]!["sessionIds"]).toEqual(["session-aaaa", "session-bbbb"]);
    expect(registry.tables.workspaces[otherId]!["path"]).toBe("/data/untouched");
    // 桶零操作：旧桶目录与会话子目录原样
    expect(existsSync(join(oldBucket, "session-aaaa"))).toBe(true);
    expect(existsSync(join(oldBucket, "session-bbbb"))).toBe(true);
    expect(existsSync(join(sessionsRootOf(home), bucketNameForWorkspacePath(newPath)))).toBe(false);
    // 身份 id 永不改变
    expect(readWorkspaceIdentity(newPath)!.id).toBe(ID);
  });

  it("符号链接旧位＝归属链在用——保留不删（old_anchor_note 说明）", () => {
    const home = seedDshHome();
    const oldPath = join(tempRoot(), "link-ws");
    const newPath = tempRoot();
    mkdirSync(newPath, { recursive: true });
    seedIdentity(newPath, ID);
    seedRegisteredWorkspace(home, ID, oldPath);
    symlinkSync(newPath, oldPath);
    const outcome = rebindWorkspaceToPath(newPath, home, new Date());
    expect(outcome.oldAnchorRemoved).toBe(false);
    expect(outcome.oldAnchorNote).toContain("符号链接");
    expect(readlinkSync(oldPath)).toBe(newPath);
  });

  it("旧桶缺席＝old_bucket_absent 如实盘点；旧目录非空＝不删（old_anchor_removed:false＋说明）", () => {
    const home = seedDshHome();
    const oldPath = join(tempRoot(), "gone-ws");
    const newPath = tempRoot();
    mkdirSync(newPath, { recursive: true });
    seedIdentity(newPath, ID);
    seedRegisteredWorkspace(home, ID, oldPath);
    writeFileSync(join(newPath, "user-file.txt"), "keep");

    const outcome = rebindWorkspaceToPath(newPath, home, new Date());
    expect(outcome.bucketDisposition).toBe("old_bucket_absent");
    expect(outcome.oldAnchorRemoved).toBe(false);
    expect(outcome.oldAnchorNote).toContain("已不在盘上");
  });

  it("幂等：path 未变化＝unchanged 不写注册表（registry_updated:false＋无备份落盘）", () => {
    const home = seedDshHome();
    const ws = tempRoot();
    mkdirSync(ws, { recursive: true });
    seedIdentity(ws, ID);
    seedRegisteredWorkspace(home, ID, ws);
    const beforeFiles = readdirSync(join(home, "storages"));
    const outcome = rebindWorkspaceToPath(ws, home, new Date());
    expect(outcome.bucketDisposition).toBe("unchanged");
    expect(outcome.registryUpdated).toBe(false);
    expect(readdirSync(join(home, "storages"))).toEqual(beforeFiles);
  });

  it("错误回流三态：新位置缺身份文件／注册表缺文件／按 id 无记录——均指路文案", () => {
    const home = seedDshHome();
    const noIdentity = tempRoot();
    mkdirSync(noIdentity, { recursive: true });
    expect(() => rebindWorkspaceToPath(noIdentity, home, new Date())).toThrow(/身份文件/);
    const orphan = tempRoot();
    mkdirSync(orphan, { recursive: true });
    seedIdentity(orphan, "88888888-8888-4888-8888-888888888888");
    expect(() => rebindWorkspaceToPath(orphan, home, new Date())).toThrow(/按 id 无记录/);
    const emptyHome = tempRoot();
    mkdirSync(emptyHome, { recursive: true });
    expect(() => rebindWorkspaceToPath(orphan, emptyHome, new Date())).toThrow(/注册表不存在/);
  });
});

// ---------------------------------------------------------------- 工具 handler 层（经 buildBridgeTools 真装配）

describe("工作区治理两工具 handler（WebUI 桥装配同链——审批/折算/回流）", () => {
  it("atf_create_experiment：审批放行→真建（canonical 全键）＋审批拒绝→结构化 denial 不落盘", async () => {
    const home = seedDshHome();
    const ws = tempRoot();
    mkdirSync(ws, { recursive: true });
    const allowed = toolExec({ dshHome: home }, "allowed-once", "atf_create_experiment");
    expect(allowed.name).toBe("atf_create_experiment");
    const result = (await allowed.execute({ workspace_path: ws, experiment_name: "e2e-1" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, registry_status: "pending_registration", experiments_count: 1 });
    expect(existsSync(join(ws, "experiments"))).toBe(true);

    const denied = toolExec({ dshHome: home }, "rejected", "atf_create_experiment");
    const ws2 = tempRoot();
    mkdirSync(ws2, { recursive: true });
    const deniedResult = (await denied.execute({ workspace_path: ws2, experiment_name: "e2e-2" }, fakeExec)) as Record<string, unknown>;
    expect(deniedResult).toMatchObject({ error: "approval_denied", outcome: "rejected" });
    expect(existsSync(join(ws2, ".atf"))).toBe(false);
  });

  it("atf_create_experiment：路径不存在→rejected(invalid_params)＋指路文案（不代建目录）", async () => {
    const home = seedDshHome();
    const tool = toolExec({ dshHome: home }, "allowed-once", "atf_create_experiment");
    const result = (await tool.execute({ workspace_path: join(tempRoot(), "missing"), experiment_name: "x" }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ error: "rejected", reason: "invalid_params" });
    expect(String((result as { detail?: { message?: string } }).detail?.message)).toContain("不代建顶层工作区目录");
  });

  it("atf_rebind_workspace：放行→真 rebind（registry/bucket/anchor 全链）；无记录→invalid_params 指路", async () => {
    const home = seedDshHome();
    const ID = "99999999-9999-4999-8999-999999999999";
    const oldPath = join(tempRoot(), "h-old");
    const newPath = join(tempRoot(), "h-new");
    seedRegisteredWorkspace(home, ID, oldPath);
    mkdirSync(oldPath, { recursive: true });
    renameSync(oldPath, newPath);
    seedIdentity(newPath, ID);
    const tool = toolExec({ dshHome: home }, "allowed-once", "atf_rebind_workspace");
    expect(tool.name).toBe("atf_rebind_workspace");
    const result = (await tool.execute({ workspace_path: newPath }, fakeExec)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, workspace_id: ID, registry_updated: true, bucket_disposition: "old_bucket_absent", old_anchor_removed: false });
    const registry = readRegistryFile(registryPathOf(home)) as { tables: { workspaces: Record<string, Record<string, unknown>> } };
    expect(registry.tables.workspaces[ID]!["path"]).toBe(newPath);

    const orphan = tempRoot();
    mkdirSync(orphan, { recursive: true });
    seedIdentity(orphan, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const miss = (await tool.execute({ workspace_path: orphan }, fakeExec)) as Record<string, unknown>;
    expect(miss).toMatchObject({ error: "rejected", reason: "invalid_params" });
    expect(String((miss as { detail?: { message?: string } }).detail?.message)).toContain("按 id 无记录");
  });
});

// ---------------------------------------------------------------- 投影面护栏（contract_field_wiring 同族）

describe("投影面护栏：BRIDGE_TOOL_NAMES ⊆ 工作区分册（定义单源对账）", () => {
  it("十件投影名全部能在契约定义单源找到（TOOL_DEFINITIONS ∪ WORKSPACE_TOOL_DEFINITIONS）", () => {
    const contractNames = [...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS].map((definition) => definition.name);
    for (const name of BRIDGE_TOOL_NAMES) expect(contractNames).toContain(name);
    expect(BRIDGE_TOOL_NAMES).toContain("atf_create_experiment");
    expect(BRIDGE_TOOL_NAMES).toContain("atf_rebind_workspace");
    // F14：atf_label_qc_resolve 与 inspect 同面开放（决议入口，见 labelQcResume.test.ts）→ 9→10
    expect(BRIDGE_TOOL_NAMES).toContain("atf_label_qc_resolve");
    expect(BRIDGE_TOOL_NAMES).toHaveLength(10);
  });
});
