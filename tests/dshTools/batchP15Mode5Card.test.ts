/** P1-5 锚:倍数确认卡时机断言(分析先于确认卡)。
 * 真机实锚 11-06:倍数行是 experiment_setup 段审批卡常驻附加行,第一次触发
 * 段(尚未看图/无风险件)就呈现「未确认——按建议倍数额度默认生成」——分析没做
 * 就问倍数,owner 反复点名。修复=analysisReady 缺席时倍数行改为「图像分析未完成,
 * 本轮不确认倍数」+指路;分析在场才出建议/确认形态。
 * 双锚:行为锚(constructionParamsApprovalLines 三态)+源码锚(调用点传 analysisReady)。
 */
import { describe, expect, it } from "vitest";
import { constructionParamsApprovalLines } from "../../packages/extensions/atf-tools/src/pipelineFace.js";


describe("P1-5——倍数卡时机断言(分析先于确认卡)", () => {
  const base = { groupingConfirm: false, mode5Random: undefined, targetedAdvice: undefined };

  it("行为锚:分析未完成→「本轮不确认倍数」+指路(不预设默认生成)", () => {
    const lines = constructionParamsApprovalLines({ ...base, analysisReady: false } as never);
    expect(lines).toContain("图像分析未完成");
    expect(lines).toContain("本轮不确认倍数");
    expect(lines).not.toContain("按建议倍数额度默认生成");
  });
  it("行为锚:分析在场且统计件带建议→呈现建议倍数(默认生成形态回归)", () => {
    const lines = constructionParamsApprovalLines({ ...base, analysisReady: true, mode5Suggested: 2 } as never);
    expect(lines).toContain("建议 2 倍");
    expect(lines).toContain("按建议倍数额度默认生成");
  });
  it("行为锚:分析在场且用户显式给倍数→「N 倍(已确认)」", () => {
    const lines = constructionParamsApprovalLines({ ...base, analysisReady: true, mode5Random: 3 } as never);
    expect(lines).toContain("3 倍（已确认）");
  });
  // 源码锚退役说明：原锚「调用点接入 mode5AnalysisReadyOf」的载体＝experiment_setup 段
  // 审批卡的构造参数行调用点，ADR-0022 段审批轴退役后调用点消失（负向断言批 4 另装）；
  // 时机语义由上方行为锚三态（文案单源）继续锁定。
});
