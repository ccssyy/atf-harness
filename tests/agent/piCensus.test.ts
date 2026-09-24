/**
 * 批 P 增补 §四（指令 56170242）——挂接完整性复核法守卫：pi 系 census 基线比对。
 *
 * 机制：pi-agent-core 的导出面（根导出＋子路径导出＋dist 文件清单）已归档为基线
 * （tests/fixtures/pi-census-baseline-0.87.1.json）；本测试逐项比对现状——
 *   ① 版本锁 exact 守卫：升级必须显式换基线（save-exact 纪律的静态前提）；
 *   ② 新增导出 ⊄ 基线 → fail＝自动触发增量评估（杜绝"评估时不知道、用时才发现"）；
 *   ③ 基线中的既有导出被移除 → fail（breaking 变更同样过门）。
 * 基线随批复归档（docs/_owner/ATF-Harness_批P增补_census基线归档_20260924.md 三档清单）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "@earendil-works/pi-agent-core/package.json" with { type: "json" };

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const baselinePath = join(repoRoot, "tests", "fixtures", "pi-census-baseline-0.87.1.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
  version: string;
  rootExports: string[];
  subpathExports: Record<string, string[]>;
  distFileCount: number;
};

describe("批 P 增补 §四：pi 系 census 基线比对（挂接完整性复核法）", () => {
  it("① 版本锁 exact：pi-agent-core 必须仍为基线版本（升级＝显式换基线＋增量评估）", () => {
    expect(pkg.version).toBe(baseline.version);
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(rootPkg.dependencies["@earendil-works/pi-agent-core"]).toBe(baseline.version);
  });

  it("② 新增根导出 ⊄ 基线 → fail（pi 系升级新增导出自动触发增量评估）", async () => {
    const current = Object.keys(await import("@earendil-works/pi-agent-core")).sort();
    const known = new Set(baseline.rootExports);
    const added = current.filter((name) => !known.has(name));
    expect(added, `pi-agent-core 新增导出（须增量评估后更新基线）：${added.join(", ")}`).toEqual([]);
  });

  it("③ 基线根导出无缺失（breaking 变更同样过门）", async () => {
    const current = new Set(Object.keys(await import("@earendil-works/pi-agent-core")));
    const missing = baseline.rootExports.filter((name) => !current.has(name));
    expect(missing, `基线导出被移除（breaking）：${missing.join(", ")}`).toEqual([]);
  });

  it("④ 子路径导出面与基线一致（新增/删除子路径均触发比对）", async () => {
    const pkgExports = Object.keys(pkg.exports ?? {}).filter((name) => name !== "." && name !== "./package.json").sort();
    const baselinePaths = Object.keys(baseline.subpathExports).sort();
    const addedPaths = pkgExports.filter((name) => !baselinePaths.includes(name));
    expect(addedPaths, `新增子路径导出（须增量评估）：${addedPaths.join(", ")}`).toEqual([]);
    for (const path of baselinePaths) {
      if (!pkgExports.includes(path)) {
        throw new Error(`基线子路径导出被移除（breaking）: ${path}`);
      }
    }
  });
});
