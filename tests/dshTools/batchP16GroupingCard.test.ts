/** P1-6b 锚:配置自带分组未确认→合成单候选走原生分组卡(卡必弹)。
 * 真机实锚 11-06:agent 把 6 组写进 field-config,harness 只在审批卡上给
 * 「没在卡上确认过」note,分组选择卡从未弹出,用户被迫聊天裁决「ci可以,bl也要3组」。
 * 修复=proposalRaw 缺席而配置自带 ≥2 组时,合成单候选注入完整出卡链
 * (D185 字段全集校验+svc.ask 原生卡+grouping-choice 落账)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("P1-6b——配置自带分组合成候选走出卡链", () => {
  const src = readFileSync(SRC, "utf8");
  it("源码锚:合成注入在场(proposalRaw 缺席+配置 ≥2 组→单候选)", () => {
    expect(src).toContain("P1-6b:agent 没传候选而字段配置自带分组");
    expect(src).toMatch(/candidates: \[\{ name: "配置自带分组", groups: providedGroups, recommended: true \}\]/);
  });
  it("源码锚:agent_written 不再提前 return(走出卡链);degenerate 保持拦截", () => {
    expect(src).toMatch(/mustAskGrouping && registrationSource === "degenerate"/);
    expect(src).toContain("agent_written(助手写进配置的分组)不再提前 return");
  });
  it("源码锚:parse 消费合成变量(旧 input.proposalRaw 引用不残留)", () => {
    expect(src).toContain("parseGroupingProposal(proposalRaw)");
  });
});
