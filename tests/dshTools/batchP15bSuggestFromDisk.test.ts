/** P1-5b/D230b 锚(1106 晚补批):建议值盘面取数+聚类摘要透传用户面。
 * owner 质询「改的时候每次都不看全代码」后的全量载体核对补漏:
 *  ①倍数卡(mode5)建议值从盘面统计件取(已 P1-5 补);
 *  ②targeted 建议值同款断链——同从统计件 suggested_basis.derived_multiplier 取(本批);
 *  ③聚类摘要行此前只落 stage 文件,stageUserSummaryOf 成功态通用文案——本批透传。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageUserSummaryOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("P1-5b/D230b——载体补漏", () => {
  it("行为锚:family_split 成功回执带聚类摘要行→用户面 conclusion 呈现聚类结果", () => {
    const receipt = {
      ok: true, stage: "family_split",
      summary: { results: [{ status: "ok", missing: ["版式聚类结果:13 簇(最大 5 簇: c1(12 页)、c2(7 页);单页簇 1 个,degenerate=否)——切分按簇分层,小簇已按守恒规则处理;对簇数或分组有异议,直接说,可调聚类重切"] }] },
    };
    const summary = stageUserSummaryOf(receipt, true, "family_split");
    expect(summary.conclusion).toContain("聚类结果");
    expect(summary.conclusion).toContain("13 簇");
    expect(summary.conclusion).toContain("degenerate=否");
    expect(summary.next).toContain("可调聚类重切");
  });
  it("行为锚:无聚类行的 family_split/其他段成功回执保持通用文案(零回归)", () => {
    const plain = stageUserSummaryOf({ ok: true, stage: "family_split", summary: { results: [{ status: "ok", missing: [] }] } }, true, "family_split");
    expect(plain.conclusion).toBe("版式划分跑完了");
    const other = stageUserSummaryOf({ ok: true, stage: "publish", summary: { results: [] } }, true, "publish");
    expect(other.conclusion).toBe("发布跑完了");
  });
  it("源码锚:targeted 建议值同源取盘面统计件 derived_multiplier", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain("suggested_basis?.derived_multiplier");
    expect(src).toContain("mode5StatsPathOf");
  });
});
