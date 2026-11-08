// R2.5(D237 防回潮锚):atf_pipeline_stage 工具面的段级参数三件套在场。
// 事故:内核加 --visual-check(1de9f10d)而 Face 工具面未跟,真机 agent 被迫
// 源码考古 2.2M token(黑盒验收 #20/21)。工具定义在工厂函数内无独立导出,
// 本锚为组件级源码锚:参数键/CLI 透传/两段式指路三处任一被删即红。
// (端到端由真机复验承载:label_qc 带 visual_check 直通。)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts"),
  "utf-8",
);

describe("R2.5 段级参数 Face 面在场(D237 防回潮)", () => {
  it("visual_check 参数键在工具 parameters", () => {
    expect(SOURCE).toContain("      visual_check: {");
  });

  it("visual_check 透传内核 --visual-check(写盘转发形态)", () => {
    expect(SOURCE).toContain('argv.push("--visual-check", checkPath)');
    expect(SOURCE).toContain('args.stage === "label_qc" && args.visual_check !== undefined');
  });

  it("工具描述含两段式指路(裸跑导清单→核查件→带参重跑)", () => {
    expect(SOURCE).toContain("双通道完整体检");
    expect(SOURCE).toContain("LabelQcVisualCheck/v1");
  });

  it("内核快照的段级参数未被裁撤(fixture 单源对账)", () => {
    const surface = JSON.parse(
      readFileSync(resolve(process.cwd(), "tests/fixtures/kernel-stage-arg-surface.json"), "utf-8"),
    ) as { options?: string[] };
    for (const opt of ["--visual-check", "--visual-readings", "--visual-sample-plan"]) {
      expect(surface.options, `内核快照缺 ${opt}——内核参数面已变,先重摘 fixture`).toContain(opt);
    }
  });
});
