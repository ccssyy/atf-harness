/**
 * #27 跨仓接口变更全调用方排查机制化（批4 ③面——harness 调用参数 vs 内核
 * argparse 面跨仓对照）：r2 实锤 B5/AL-1 删 --inputs-file 后 harness 段驱动
 * 仍在传参（unrecognized 拒绝零写入）——跨层接口删除漏调用方。
 *
 * 锚点=tests/fixtures/kernel-stage-arg-surface.json（内核仓 tools/
 * argparse_surface.json 的 walkthrough_pipeline.py 段级参数闭集快照，
 * 双副本一致实测后摘录）。内核参数面变更时随部署序列同步锚点；
 * harness 段驱动/jointTrain 出现锚点外传参即红（教了内核不存在的参数）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ANCHOR_PATH = join(HERE, "..", "fixtures", "kernel-stage-arg-surface.json");
const HARNESS_CALLER_FILES = [
  "packages/extensions/atf-tools/src/pipelineFace.ts",
  "packages/extensions/atf-tools/src/jointTrainFace.ts",
] as const;

const anchorOf = (): Set<string> =>
  new Set(JSON.parse(readFileSync(ANCHOR_PATH, "utf8")) as string[]);

const usedOptionsOf = (repoRoot: string): Set<string> => {
  const used = new Set<string>();
  for (const rel of HARNESS_CALLER_FILES) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    for (const match of text.matchAll(/"(--[a-z0-9-]+)"/g)) used.add(match[1] ?? "");
  }
  return used;
};

describe("#27 harness 调用参数 vs 内核 argparse 面跨仓对照", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

  it("锚点快照可解析且非空（漂移对照的前提）", () => {
    const anchor = anchorOf();
    expect(anchor.size).toBeGreaterThan(0);
    expect(anchor.has("--run-id")).toBe(true);
    expect(anchor.has("--stage")).toBe(true);
  });

  it("harness 段驱动传参全部落在内核参数面内（锚点外传参=漂移即红）", () => {
    const anchor = anchorOf();
    const used = usedOptionsOf(repoRoot);
    expect(used.size).toBeGreaterThan(0);
    const drift = [...used].filter((opt) => opt !== "" && !anchor.has(opt));
    expect(drift, `锚点外传参（内核不认识——参数已删/改名/笔误，对照内核 tools/argparse_surface.json 重新生成锚点或改 harness 调用面）: ${drift.join(" ")}`).toEqual([]);
  });
});
