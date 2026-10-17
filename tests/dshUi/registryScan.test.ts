/**
 * A2 案 a／A3 测试锚——atf-ui 扫描面视野枚举＋训练段两态。
 *
 * 案 a（owner 2026-10-17 19:05 裁定）：扫描面＝runsRoot（现形态不变）∪ 注册工作区实验树
 * （records[].path＋/experiments/<x>/runs/<id>）。硬约束：仅 exists===true 记录入列；
 * 只读（零写入零建目录）；目录缺失/权限失败静默跳过；去重按 realpath（分桶来源优先，
 * workspace_source=bucket 不因注册表命中改写）；标注＝注册记录 title；additive
 * workspace_source 两键闭集投影（adapter 白名单同批）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateRunEntries, scanRuns, scanRunDir, scanRunDirAt } from "../../packages/extensions/atf-ui/src/server.js";
import { buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "a2-registry-scan-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** run 目录特征（launch_manifest——looksLikeRun 收录判据之一）。 */
const seedRun = (dir: string, rels: ReadonlyArray<string> = ["launch/launch_manifest.json"]): void => {
  for (const rel of rels) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "{}\n", "utf8");
  }
};

describe("A2 案 a——扫描面视野枚举", () => {
  it("注册实验树 run 入视野（标注＝记录 title，workspace_source=registry）；runsRoot 分桶/平铺照旧", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const registryWorkspaces = [{ path: regws, title: "注册甲" }];
    const scans = scanRuns(root, undefined, registryWorkspaces);
    const byId = new Map(scans.map((s) => [s.run_id, s]));
    expect(byId.get("flat-run")).toMatchObject({ workspace: null, workspace_source: "bucket" });
    expect(byId.get("run-bucketed")).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
    expect(byId.get("reg-run")).toMatchObject({ workspace: "注册甲", workspace_source: "registry" });
  });

  it("未注册目录不进视野（负例必测）；exists=false 记录不入列（目录缺失静默跳过）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    // 未注册目录（不进 seeds 清单——注册表判定之外，扫描面不可见）
    const otherws = tempRoot();
    seedRun(join(otherws, "experiments", "exp1", "runs", "hidden-run"));
    const missing = join(root, "no-such-ws");
    const scans = scanRuns(root, undefined, [
      { path: regws, title: "注册甲" },
      { path: missing, title: "目录丢失" },
    ]);
    const ids = scans.map((s) => s.run_id);
    expect(ids).toContain("reg-run");
    expect(ids).not.toContain("hidden-run");
    expect(scans.every((s) => s.run_id !== "no-such-ws")).toBe(true);
  });

  it("重叠去重按 realpath：分桶来源优先（同一 run 两侧在场只出现一次，bucket 标注不改写）", () => {
    const root = tempRoot();
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    // 注册树侧符号链接指向分桶 run（realpath 同源）——桶通道先枚举先占位，registry 通道跳过
    mkdirSync(join(regws, "experiments", "exp2", "runs"), { recursive: true });
    symlinkSync(join(root, "ws-a", "run-bucketed"), join(regws, "experiments", "exp2", "runs", "mirrored-run"), "dir");
    const scans = scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    expect(scans.filter((s) => s.run_id === "run-bucketed")).toHaveLength(1);
    // 镜像名＝同一 realpath（分桶已占位）——registry 通道跳过，不出现第二次也不改写标注
    expect(scans.filter((s) => s.run_id === "mirrored-run")).toHaveLength(0);
    const bucketed = scans.filter((s) => s.run_id === "run-bucketed");
    expect(bucketed[0]).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
  });

  it("平铺 run 注册表前缀归属：记录 path 为 run 目录祖先 → 标注 title；分桶条目不受前缀改写", () => {
    const outer = tempRoot();
    const root = join(outer, "runs");
    mkdirSync(root, { recursive: true });
    seedRun(join(root, "flat-run"));
    seedRun(join(root, "ws-a", "run-bucketed"));
    const scans = scanRuns(root, undefined, [{ path: outer, title: "外层工作区" }]);
    const byId = new Map(scans.map((s) => [s.run_id, s]));
    expect(byId.get("flat-run")).toMatchObject({ workspace: "外层工作区", workspace_source: "registry" });
    expect(byId.get("run-bucketed")).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
  });

  it("只读：枚举零写入零建目录（扫描前后目录清单一致）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const snap = (p: string): string => readdirSync(p, { withFileTypes: true }).map((e) => e.name).sort().join(",");
    const before = snap(regws);
    scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    expect(snap(regws)).toBe(before);
    expect(existsSync(join(regws, "webui"))).toBe(false);
  });

  it("枚举与扫描一一对应（同步器 entries 复用契约：runs[i]↔entries[i]）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const registryWorkspaces = [{ path: regws, title: "注册甲" }];
    const entries = enumerateRunEntries(root, registryWorkspaces);
    const scans = scanRuns(root, undefined, registryWorkspaces, entries);
    expect(scans).toHaveLength(entries.length);
    entries.forEach((entry, i) => {
      expect(scans[i]?.run_id).toBe(entry.runId);
      expect(scans[i]?.workspace).toBe(entry.workspace);
    });
  });
});

describe("A2 投影面——adapter 白名单＋摘要化", () => {
  it("buildMonitorSnapshot：workspace_source additive 投影（registry/bucket 两键闭集）", () => {
    const root = tempRoot();
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const scans = scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    const monitor = buildMonitorSnapshot(scans, { offline: true });
    const byId = new Map(monitor.runs.map((r) => [r.run_id, r]));
    expect(byId.get("reg-run")?.workspace_source).toBe("registry");
    expect(byId.get("run-bucketed")?.workspace_source).toBe("bucket");
    expect(["bucket", "registry"].includes(String(byId.get("reg-run")?.workspace_source))).toBe(true);
  });

  it("摘要化：快照 run 载荷零注册表绝对路径（title 非 path——路径面不入投影）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = join(tempRoot(), "reg-ws-root-7f3a");
    mkdirSync(regws, { recursive: true });
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const monitor = buildMonitorSnapshot(scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]), { offline: true });
    expect(JSON.stringify(monitor.runs)).not.toContain("reg-ws-root-7f3a");
    expect(JSON.stringify(monitor.runs)).toContain("注册甲");
  });
});
