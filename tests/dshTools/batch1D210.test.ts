/** 批1-D210 锚:构造缺口与守护状态上用户面(训练启动卡+内核回执双侧)。
 *
 * 源码面 grep 锚:
 * 1. bridgeFace 训练启动卡「数据集组成」段读 mode5 shortfall(targeted guard 同)
 *    ——增强卡承诺「如实披露实产条数与原因」的最后一公里。
 * 2. 内核 walkthrough_pipeline construction_report 带 augmentation_face 键
 *    (mode5_status/mode5_shortfall/targeted 守护)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("批1-D210——构造缺口与守护披露上用户面", () => {
  it("harness 训练启动卡含缺口行与守护缺席行", () => {
    const src = readFileSync(join(process.cwd(), "packages/extensions/atf-tools/src/bridgeFace.ts"), "utf8");
    expect(src).toContain('"completed_with_shortfall"');
    expect(src).toContain("增强缺口：请求");
    expect(src).toContain("guard_unavailable");
    expect(src).toContain("重点增强守护缺席");
  });
  it("内核回执 construction_report 带 augmentation_face", () => {
    const src = readFileSync(
      join(process.cwd(), "../AgenticTrainingFlow/skills/atf-admit-training-data/scripts/walkthrough_pipeline.py"),
      "utf8",
    );
    expect(src).toContain('"augmentation_face": augmentation_face');
    expect(src).toContain('"mode5_shortfall": shortfall');
  });
});
