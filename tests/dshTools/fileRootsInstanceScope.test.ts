/**
 * b11-A/B 测试锚——注册工作区定域闸（F16 定域纪律在文件白名单层的落点）。
 *
 * 现场依据（2026-10-28 dev 实测）：注册表 15 条记录里 14 条落在实例根外
 * （/data/sam、/root/a4-hotws、/root/awb-trial、/tmp/b18-ws-r2、/data/atf/prodtest/*），
 * 而 ⑦ 派生面按 exists 无条件纳入 → 围栏把实例根外目录全部放行。
 *
 * 判据三条：①实例根内纳入；②已被其它派生面覆盖的纳入（白名单只增不减）；
 * ③其余排除并进 excluded（无静默）；ATF_INSTANCE_ROOT 缺席＝闸不启用（fail-open）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveFileToolRoots, withinRootOf, WORKSPACE_OUT_OF_INSTANCE } from "../../src/agent/fileRoots.js";
import { startFileRootsHotReload } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";
import { registryPathOf } from "../../src/core/workspace/workspaceRegistry.js";
import { writeFileSync } from "node:fs";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "file-roots-scope-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const registryDoc = (records: Record<string, unknown>): string =>
  JSON.stringify(
    {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(records), archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: records },
    },
    null,
    2,
  ) + "\n";

describe("b11-A 注册工作区定域闸", () => {
  it("实例根内的工作区纳入白名单（正常路径零变化）", () => {
    const home = tempRoot();
    const instanceRoot = join(home, "instance");
    const inside = join(instanceRoot, "workspaces", "ws-a");
    mkdirSync(inside, { recursive: true });
    const derived = deriveFileToolRoots({
      env: { HOME: home, ATF_INSTANCE_ROOT: instanceRoot },
      listRegistryWorkspaces: () => [{ path: inside }],
    });
    expect(derived.roots).toContain(inside);
    expect(derived.sources[derived.roots.indexOf(inside)]).toBe("registry:workspace");
    expect(derived.excluded).toEqual([]);
  });

  it("实例根外的工作区排除且原因可查（不再静默变成白名单根）", () => {
    const home = tempRoot();
    const instanceRoot = join(home, "instance");
    mkdirSync(instanceRoot, { recursive: true });
    const outside = join(home, "someone-else-project");
    mkdirSync(outside, { recursive: true });
    const derived = deriveFileToolRoots({
      env: { HOME: home, ATF_INSTANCE_ROOT: instanceRoot },
      listRegistryWorkspaces: () => [{ path: outside }],
    });
    expect(derived.roots).not.toContain(outside);
    expect(derived.excluded).toEqual([{ path: outside, reason: WORKSPACE_OUT_OF_INSTANCE }]);
    expect(WORKSPACE_OUT_OF_INSTANCE).toBe("workspace_out_of_instance");
  });

  it("已被 ATF_V1_FILE_TOOL_ROOTS 声明覆盖的实例根外工作区仍纳入（声明面＝例外通道）", () => {
    const home = tempRoot();
    const instanceRoot = join(home, "instance");
    mkdirSync(instanceRoot, { recursive: true });
    const declaredParent = join(home, "declared-evidence");
    const declaredWs = join(declaredParent, "ws-x");
    mkdirSync(declaredWs, { recursive: true });
    const derived = deriveFileToolRoots({
      env: { HOME: home, ATF_INSTANCE_ROOT: instanceRoot, ATF_V1_FILE_TOOL_ROOTS: declaredParent },
      listRegistryWorkspaces: () => [{ path: declaredWs }],
    });
    expect(derived.roots).toContain(declaredWs);
    expect(derived.excluded).toEqual([]);
  });

  it("实例根未声明（非实例形态）→ 闸不启用，全量纳入（fail-open 保旧行为）", () => {
    const home = tempRoot();
    const outside = join(home, "anywhere");
    mkdirSync(outside, { recursive: true });
    const derived = deriveFileToolRoots({
      env: { HOME: home },
      listRegistryWorkspaces: () => [{ path: outside }],
    });
    expect(derived.roots).toContain(outside);
    expect(derived.excluded).toEqual([]);
  });

  it("目录名前缀不作数：<根>/ws2 不算在 <根>/ws 内，<根>/ws/sub 才算", () => {
    const home = tempRoot();
    const instanceRoot = join(home, "ws");
    const sibling = join(home, "ws2");
    const child = join(instanceRoot, "sub");
    mkdirSync(sibling, { recursive: true });
    mkdirSync(child, { recursive: true });
    const derived = deriveFileToolRoots({
      env: { HOME: home, ATF_INSTANCE_ROOT: instanceRoot },
      listRegistryWorkspaces: () => [{ path: sibling }, { path: child }],
    });
    expect(derived.roots).toContain(child);
    expect(derived.roots).not.toContain(sibling);
    expect(derived.excluded.map((item) => item.path)).toEqual([sibling]);
  });

  it("realpath 归一：软链指向实例根内视作根内（同一性按真实路径判）", () => {
    const home = tempRoot();
    const instanceRoot = join(home, "instance");
    const real = join(instanceRoot, "real-ws");
    mkdirSync(real, { recursive: true });
    const link = join(home, "link-to-ws");
    symlinkSync(real, link);
    const derived = deriveFileToolRoots({
      env: { HOME: home, ATF_INSTANCE_ROOT: instanceRoot },
      listRegistryWorkspaces: () => [{ path: link }],
    });
    expect(derived.roots).toContain(link);
    expect(derived.excluded).toEqual([]);
  });

  it("withinRootOf 纯函数边界：根本身计入、尾斜杠归一、跨根不误判", () => {
    const identity = (value: string): string | null => value;
    expect(withinRootOf("/a/b", "/a/b", identity)).toBe(true);
    expect(withinRootOf("/a/b/", "/a/b", identity)).toBe(true);
    expect(withinRootOf("/a/b/c", "/a/b", identity)).toBe(true);
    expect(withinRootOf("/a/bc", "/a/b", identity)).toBe(false);
    expect(withinRootOf("/a", "/a/b", identity)).toBe(false);
  });

  it("热加载日志如实列出被排除的工作区（可诊断，不静默丢根）", async () => {
    const home = tempRoot();
    mkdirSync(join(home, "storages"), { recursive: true });
    const instanceRoot = join(home, "instance");
    const inside = join(instanceRoot, "ws-in");
    const outside = join(home, "ws-out");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      registryPathOf(home),
      registryDoc({
        w1: { path: inside, title: "一", sessionIds: [], createdAt: "", updatedAt: "" },
        w2: { path: outside, title: "二", sessionIds: [], createdAt: "", updatedAt: "" },
      }),
      "utf8",
    );
    const env = { DSH_HOME: home, ATF_INSTANCE_ROOT: instanceRoot, ATF_DSH_RUNS_ROOT: join(home, "runs") };
    const initial = deriveFileToolRoots({ env });
    expect(initial.roots).toContain(inside);
    expect(initial.roots).not.toContain(outside);
    const roots: string[] = [...initial.roots];
    const logs: string[] = [];
    const handle = startFileRootsHotReload(roots, { env }, { log: (line) => logs.push(line) });
    try {
      // 触发一次重派生：注册表新增一条根内工作区
      const third = join(instanceRoot, "ws-third");
      mkdirSync(third, { recursive: true });
      writeFileSync(
        registryPathOf(home),
        registryDoc({
          w1: { path: inside, title: "一", sessionIds: [], createdAt: "", updatedAt: "" },
          w2: { path: outside, title: "二", sessionIds: [], createdAt: "", updatedAt: "" },
          w3: { path: third, title: "三", sessionIds: [], createdAt: "", updatedAt: "" },
        }),
        "utf8",
      );
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !roots.includes(third)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(roots).toContain(third);
      expect(roots).not.toContain(outside);
      const joined = logs.join("\n");
      expect(joined).toContain("白名单根热加载");
      expect(joined).toContain("实例根外已排除");
      expect(joined).toContain(outside);
    } finally {
      handle.close();
    }
  });
});
