/** D216 锚:装饰链键位根修——firstResultKeyOf 双形态(summary 包裹/顶层 results)。
 *
 * 真机实锚(复验 11-05,owner 三连点名「报告/裁决卡/分组卡全没出」):
 * 段工具返回体把内核 document 包在 summary 键下,旧实现只读顶层
 * receipt.results → 恒 undefined → label_qc 裁决卡/质检呈现/D209 聚类披露
 * 整条装饰链从未触发(此前 agent 走 CLI 绕过掩盖)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstResultKeyOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("D216——firstResultKeyOf 键位双形态", () => {
  it("summary 包裹形态(段工具返回体真实现状)取到键", () => {
    const receipt = { ok: true, stage: "label_qc", summary: { results: [{ raw_response: { counts: { pending: 1 } } }] } };
    expect((firstResultKeyOf(receipt, "counts") as { pending: number }).pending).toBe(1);
  });
  it("顶层 results 形态(既有兼容)仍取到", () => {
    const receipt = { results: [{ raw_response: { report_digest: "sha256:abc" } }] };
    expect(firstResultKeyOf(receipt, "report_digest")).toBe("sha256:abc");
  });
  it("两形态均缺 → undefined(不猜)", () => {
    expect(firstResultKeyOf({ ok: true }, "counts")).toBeUndefined();
  });
  it("源码面:nested summary 分支在位", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain('nested !== null && typeof nested === "object" && Array.isArray(nested["results"])');
  });
});
