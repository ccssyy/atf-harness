// -*- coding: utf-8 -*-
/** D277 裁决卡分组摘要测试:resolveCardGroupSummary 三类归组与计数。 */
import { describe, expect, it } from "vitest";
import { resolveCardGroupSummary } from "../../packages/extensions/atf-tools/src/bridgeFace.js";

describe("resolveCardGroupSummary(D277)", () => {
  it("keep_* 归归属保留类并计数", () => {
    const s = resolveCardGroupSummary([
      { disposition: "keep_both" },
      { disposition: "keep_second" },
    ]);
    expect(s).toContain("归属保留类 2 项");
    expect(s).not.toContain("值修正类");
  });

  it("set_value 归值修正类", () => {
    const s = resolveCardGroupSummary([{ disposition: "set_value" }]);
    expect(s).toBe("值修正类 1 项");
  });

  it("混合形态分组计数与顺序", () => {
    const s = resolveCardGroupSummary([
      { disposition: "keep_both" },
      { disposition: "set_value" },
      { disposition: "set_value" },
      { disposition: "keep_first" },
      { disposition: "drop" },
      { disposition: "" },
    ]);
    expect(s).toContain("归属保留类 2 项");
    expect(s).toContain("值修正类 2 项");
    expect(s).toContain("其他(drop) 1 项");
    expect(s).toContain("未分类 1 项");
  });

  it("空数组返回空串", () => {
    expect(resolveCardGroupSummary([])).toBe("");
  });
});
