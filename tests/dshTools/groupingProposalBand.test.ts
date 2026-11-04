/**
 * D173 对抗锚：分组候选组数区间机检（出卡前拦截，owner 2026-11-04 裁定）。
 * 真机形态复现：候选 6 组（业务语义）/1 组（平铺全字段）曾照常出卡（卡面只
 * 标注「超出建议组数区间」）——本断言锚定 parseGroupingProposal 出卡前拦截。
 */
import { describe, expect, it } from "vitest";
import { parseGroupingProposal } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const candidateOf = (groupCount: number, fieldsPerGroup: number) => ({
  name: `${String(groupCount)} 组候选`,
  recommended: true,
  groups: Array.from({ length: groupCount }, (_, i) => ({
    name: `g${String(i + 1)}`,
    fields: Array.from({ length: fieldsPerGroup }, (_, j) => `f${String(i)}_${String(j)}`),
  })),
});

describe("D173 分组候选组数区间机检", () => {
  it("6 组候选拒（真机 ci-bl-test-1104-1 形态复现）", () => {
    const verdict = parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(6, 5)],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.includes("超过最多 5 组"))).toBe(true);
  });

  it("1 组（平铺全字段）拒——字段总数≥4 可两全时", () => {
    const verdict = parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(1, 25)],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.includes("没分组"))).toBe(true);
  });

  it("2-3 组候选放行；小字段集（<4 字段）单组豁免", () => {
    expect(parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(3, 4)],
    }).ok).toBe(true);
    expect(parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(1, 3)],
    }).ok).toBe(true);
  });
});
