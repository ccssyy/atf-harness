import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D256 泛化对账围栏（无机检不立规；事故=1109-2 style_split visual_readings 断链）：
 * 内核 walkthrough_pipeline.py 消费 `args.visual_readings` 的段（--agent-signals
 * 风险步），harness pipelineFace 必须存在对应 stage 的写盘转发分支——散点转发
 * 模式「加段漏段」第三次复发（D237 label_qc → 本次 style_split），由此测试钉住
 * 全部消费段。内核源码断言仅作对账导航（开发批白盒）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const kernelWalkthrough = join(
  repoRoot, "..", "AgenticTrainingFlow",
  "skills", "atf-admit-training-data", "scripts", "walkthrough_pipeline.py",
);
const harnessPipelineFace = join(
  repoRoot, "packages", "extensions", "atf-tools", "src", "pipelineFace.ts",
);

describe("D256 visual_readings 段消费×转发覆盖对账", () => {
  it("内核消费 args.visual_readings 的段，harness 必有对应转发（形态随段块惯例）", () => {
    const kernel = readFileSync(kernelWalkthrough, "utf8");
    const harness = readFileSync(harnessPipelineFace, "utf8");
    // 内核消费点形态：cmd += ["--agent-signals", str(self.args.visual_readings)]
    // （style_split 风险步——当前唯一消费点；内核新增消费段时本断言同步扩面）
    expect(kernel).toContain('cmd += ["--agent-signals", str(self.args.visual_readings)]');
    // style_split/experiment_setup：stage&&字段字面形态（同段独立转发分支）
    for (const stage of ["style_split", "experiment_setup"]) {
      expect(
        harness.includes(`args.stage === "${stage}" && args.visual_readings !== undefined`),
        `harness 缺 ${stage} 段的 visual_readings 写盘转发分支（D256 断链同族）`,
      ).toBe(true);
    }
    // candidate_build：stage 块内 plan_only/visual_readings else-if 对偶形态
    expect(harness.includes('args.stage === "candidate_build"')).toBe(true);
    expect(
      harness.includes("args.visual_plan_only === true") &&
        harness.includes("} else if (args.visual_readings !== undefined) {"),
      "harness 缺 candidate_build 的 plan_only/readings 对偶转发分支",
    ).toBe(true);
  });

  it("style_split/experiment_setup/training_prep 转发形态同款（统一走 forwardReadingObject 写盘传路径——D294 重构后语义不变）", () => {
    const harness = readFileSync(harnessPipelineFace, "utf8");
    // 三段独立转发分支仍在（D256 围栏语义：加段漏段拦截面——新增消费段必须同款接线）
    for (const stage of ["style_split", "experiment_setup", "training_prep"]) {
      expect(
        harness.includes(`args.stage === "${stage}" && args.visual_readings !== undefined`),
        `harness 缺 ${stage} 段的 visual_readings 转发分支`,
      ).toBe(true);
      const block = harness.slice(harness.indexOf(`args.stage === "${stage}" && args.visual_readings`));
      expect(block.slice(0, 400)).toContain("forwardReadingObject");
    }
    // 转发必须是写盘+传路径（对象直传内核 argparse Path 参数不识别——1109-2 实锚）；
    // D294 重构：写盘细节收敛进 forwardReadingObject 单源（三处同构消重），本断言钉住单源本体
    const helper = harness.slice(harness.indexOf("const forwardReadingObject"));
    expect(helper.slice(0, 800)).toContain("writeFileSync");
    expect(helper.slice(0, 800)).toContain('"runtime", "webui", "visual-readings.json"');
    expect(harness).toContain('argv.push("--visual-readings", fr.file)');
  });
});
