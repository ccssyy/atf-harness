/** 批1-D210 终版锚:分析必经(owner 定论「默认就是要做分析」)——
 * 视觉判读缺席时 experiment_setup 段完成即引导看图闭环,两倍数建议值独立。
 *
 * 源码面 grep 锚:
 * 1. experiment_setup 段读风险件 visual_channel,pending_agent_readings 时
 *    projectUserNotice 引导看图(plan_only→看图→回传→重跑)——智能分析是
 *    必经步,不把「没看图」当正常分支沉在产物 json。
 * 2. 引导文案点名「两个倍数建议值(各自独立)」——mode5 每图条数与 targeted
 *    倍数不共用。
 * 3. 首版 fail-closed 错向(不出 target+how-to-fix)不得回归——内核侧
 *    targeted_skipped_no_analysis 已随 revert 撤除。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PIPELINE = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");
const VARIANTS = join(process.cwd(), "../AgenticTrainingFlow/skills/atf-admit-training-data/scripts/build_training_variants.py");

describe("批1-D210终版——分析必经引导(非 fail-closed)", () => {
  it("experiment_setup 视觉 pending 引导看图闭环", () => {
    const src = readFileSync(PIPELINE, "utf8");
    expect(src).toContain('"pending_agent_readings"');
    expect(src).toContain("智能分析不完整：agent 未看图");
    expect(src).toContain("两个倍数建议值（各自独立）随确认卡供选");
    expect(src).toContain("plan_only 导看图清单");
  });
  it("首版 fail-closed 错向已撤(内核 targeted 不再 skip+how-to-fix)", () => {
    const src = readFileSync(VARIANTS, "utf8");
    expect(src).not.toContain("targeted_skipped_no_analysis");
    expect(src).not.toContain('targeted_rules_declared_by == "builtin_default"');
  });
});

describe("批1-D210终版——mode5 建议值独立接通卡面", () => {
  it("state.mode5Suggested 消费:建议在场题面呈现分析值,缺席如实标未经分析", () => {
    const src = readFileSync(PIPELINE, "utf8");
    expect(src).toContain("mode5Suggested: constructionParams.mode5Suggested");
  });
  it("constructionGate 卡面双态文案+建议档标注", () => {
    const src = readFileSync(join(process.cwd(), "packages/extensions/atf-tools/src/constructionGate.ts"), "utf8");
    expect(src).toContain("智能分析建议每图");
    expect(src).toContain("未经智能分析——产品默认");
    expect(src).toContain("这是产品默认值不是分析建议");
    expect(src).toContain("智能分析建议档");
  });
});
