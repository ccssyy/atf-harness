/**
 * B3/D-1/D-4 默认工作区：建骨架→补身份→登记注册表→补实验元数据（幂等、只补缺）。
 *
 * 锚点：①三桶与身份文件在场；②注册表 record 的 path 指向默认工作区、
 * title=「默认工作区」、global.workspaceIds 同步；③二次调用零写（already_registered）；
 * ④注册表文件缺失时如实 registry_missing 且不代建；⑤写前备份存在；
 * ⑥adhoc 实验缺 experiment.json 时补写并进身份索引（displayName 不落盘）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_TITLE,
  defaultWorkspacePathOf,
  ensureDefaultWorkspace,
  registryPathOf,
  readRegistryFile,
  syncWorkspaceExperiments,
} from "../../src/core/workspace/workspaceRegistry.js";

const NOW = "2026-10-26T12:00:00.000Z";

const seedRegistry = (dshHome: string): string => {
  const path = registryPathOf(dshHome);
  mkdirSync(join(dshHome, "storages"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ unit: { name: "workspace", version: 2 }, global: { initialized: true, workspaceIds: [] }, tables: { workspaces: {} } }, null, 2) + "\n",
    "utf8",
  );
  return path;
};

describe("B3 默认工作区", () => {
  it("首次：建三桶+身份+登记注册表，回执 restartRequired", () => {
    const home = mkdtempSync(join(tmpdir(), "atf-home-"));
    const dsh = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const registryPath = seedRegistry(dsh);
    const out = ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "ws-default" });
    const wsPath = defaultWorkspacePathOf(dsh);
    expect(out.path).toBe(wsPath);
    expect(out.id).toBe("ws-default");
    expect(out.created).toBe(true);
    expect(out.registryStatus).toBe("registered");
    expect(out.restartRequired).toBe(true);
    for (const sub of ["datasets", "splits", "experiments"]) {
      expect(existsSync(join(wsPath, sub))).toBe(true);
    }
    const identity = JSON.parse(readFileSync(join(wsPath, ".atf", "workspace.json"), "utf8"));
    expect(identity.id).toBe("ws-default");
    const registry = readRegistryFile(registryPath)!;
    const table = (registry["tables"] as Record<string, Record<string, Record<string, unknown>>>)["workspaces"]!;
    expect(table["ws-default"]).toMatchObject({ path: wsPath, title: DEFAULT_WORKSPACE_TITLE });
    expect((registry["global"] as Record<string, unknown>)["workspaceIds"]).toEqual(["ws-default"]);
    // 写前备份在位
    const backups = readdirSync(join(dsh, "storages")).filter((n) => n.startsWith("workspace.json.bak-"));
    expect(backups.length).toBe(1);
  });

  it("二次调用零写（already_registered，不重复 record）", () => {
    const home = mkdtempSync(join(tmpdir(), "atf-home-"));
    const dsh = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const registryPath = seedRegistry(dsh);
    ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "ws-default" });
    const before = readFileSync(registryPath, "utf8");
    const again = ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "other-id" });
    expect(again.registryStatus).toBe("already_registered");
    expect(again.restartRequired).toBe(false);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  it("旧呈现名（默认工作区）→ 迁移为「任务」并回执 title_updated（幂等）", () => {
    const home = mkdtempSync(join(tmpdir(), "atf-home-"));
    const dsh = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const registryPath = seedRegistry(dsh);
    ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "ws-default" });
    // 手工把呈现名改回旧值,模拟存量记录
    const doc = JSON.parse(readFileSync(registryPath, "utf8"));
    doc.tables.workspaces["ws-default"].title = "默认工作区";
    writeFileSync(registryPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
    const migrated = ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "x" });
    expect(migrated.registryStatus).toBe("title_updated");
    const after = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(after.tables.workspaces["ws-default"].title).toBe(DEFAULT_WORKSPACE_TITLE);
    // 二次调用回到 already_registered
    expect(ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "x" }).registryStatus)
      .toBe("already_registered");
  });

  it("注册表缺失：如实 registry_missing，不代建注册表", () => {
    const home = mkdtempSync(join(tmpdir(), "atf-home-"));
    const dsh = mkdtempSync(join(tmpdir(), "dsh-home-"));
    const out = ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "ws-default" });
    expect(out.registryStatus).toBe("registry_missing");
    expect(existsSync(registryPathOf(dsh))).toBe(false);
  });

  it("adhoc 实验缺元数据：补写 experiment.json 并进身份索引，displayName 不落盘", () => {
    const home = mkdtempSync(join(tmpdir(), "atf-home-"));
    const dsh = mkdtempSync(join(tmpdir(), "dsh-home-"));
    seedRegistry(dsh);
    const out = ensureDefaultWorkspace({ dshHome: dsh, now: NOW, newId: () => "ws-default" });
    const expDir = join(out.path, "experiments", "20261026-adhoc");
    mkdirSync(join(expDir, "runs", "run-1"), { recursive: true });
    const patched = syncWorkspaceExperiments(out.path, new Date(NOW), () => "exp-1");
    expect(patched).toBe(1);
    const meta = JSON.parse(readFileSync(join(expDir, "experiment.json"), "utf8"));
    expect(meta).toMatchObject({ id: "exp-1", name: "20261026-adhoc", workspaceId: "ws-default" });
    expect(meta).not.toHaveProperty("displayName");
    const identity = JSON.parse(readFileSync(join(out.path, ".atf", "workspace.json"), "utf8"));
    expect(identity.experiments).toHaveLength(1);
    // 幂等：再跑为零
    expect(syncWorkspaceExperiments(out.path, new Date(NOW), () => "exp-2")).toBe(0);
  });
});
