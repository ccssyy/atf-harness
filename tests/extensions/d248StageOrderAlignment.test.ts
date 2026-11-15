import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D248 段序文案对账围栏（无机检不立规；事故=1109-2 banner/preset 文案仍是 G1a
 * 旧序、atf-unattended 还停留在八段残）：两个训练预设的段序列表必须与内核
 * walkthrough_pipeline.py 的 STAGE_ORDER 单源逐位一致——段序变更时本测试红，
 * 强制同步全部文案载体（「凡双处一致必配 diff=0 断言」）。内核源码断言仅作
 * 对账导航（开发批白盒）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// AB 归一批:内核源同 codegen 单版本源门——env 覆盖(验收指向 worktree),缺省仓相对路径
const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? join(repoRoot, "..", "AgenticTrainingFlow");
const kernelWalkthrough = join(
  kernelRoot,
  "skills", "atf-admit-training-data", "scripts", "walkthrough_pipeline.py",
);
const presetsDir = join(repoRoot, "packages", "extensions", "atf-ui", "presets");

// AB 归一批 F0b:17 段全表(driver 直驱,九段子序列退役)
const KERNEL_STAGE_ORDER = [
  "contract", "ingest", "inspect", "register", "label_qc", "snapshot",
  "style_split", "experiment_setup", "family_split", "candidate_build",
  "publish", "admission", "training_prep", "training_run", "checkpoint_eval",
  "badcase_analysis", "iteration_proposal",
] as const;

/** 从 preset 文本抽 persona 段序列表里的英文段名（按出现顺序）。 */
function stageOrderIn(text: string): string[] {
  const block = text.match(/段序直驱[^：]*：\n((?:.*\n)+?)(?:\s*真实 GPU)/);
  const body = block?.[1] ?? "";
  return [...body.matchAll(/\b(contract|ingest|inspect|register|label_qc|snapshot|style_split|experiment_setup|family_split|candidate_build|publish|admission|training_prep|training_run|checkpoint_eval|badcase_analysis|iteration_proposal)\b/g)].map((m) => m[1]!);
}

describe("D248 预设段序文案 vs 内核 STAGE_ORDER 对账", () => {
  it("内核 STAGE_ORDER 单源为 17 段全表（导航锚,AB 归一批）", () => {
    const kernel = readFileSync(kernelWalkthrough, "utf8");
    // 三期批 1b：段序单源派生——脚本不再持有手抄元组，锚改为派生调用在场+段名集合对账
    expect(kernel).toContain("STAGE_ORDER = STAGE_REGISTRY_ORDER");
    const order = [...kernel.matchAll(/"(contract|ingest|inspect|register|label_qc|snapshot|style_split|experiment_setup|family_split|candidate_build|publish|admission|training_prep|training_run|checkpoint_eval|badcase_analysis|iteration_proposal)"/g)].map((m) => m[1]!);
    expect(new Set(order)).toEqual(new Set(KERNEL_STAGE_ORDER));
  });

  for (const preset of ["atf-training.patch.yml", "atf-unattended.patch.yml"]) {
    it(`${preset} persona 段序列表逐位一致（17 段、无旧序残留）`, () => {
      const text = readFileSync(join(presetsDir, preset), "utf8");
      const order = stageOrderIn(text);
      expect(order, `${preset} 段序列表与内核 STAGE_ORDER 不一致`).toEqual([...KERNEL_STAGE_ORDER]);
    });

    it(`${preset} 无旧序残留文案（发布段/八段/标注质检 旧称）`, () => {
      const text = readFileSync(join(presetsDir, preset), "utf8");
      expect(text).not.toContain("发布段");
      expect(text).not.toContain("固定八段");
      expect(text).not.toContain("标注质检");
    });
  }
});
