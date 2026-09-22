/**
 * 走查修复小批 §二.3/§三.3（2026-09-23）：extraction_contract_bundle_missing 缺料指引条目
 * ——命中即出可行动文案（含「勿遍历文件系统找料」，直接治走查 A4 全盘扫描）；material gap
 * 形态与既有 split_policy_missing 同构（缺口卡四段＋options ≤3 首条推荐＋停止出口）。
 */
import { describe, expect, it } from "vitest";
import { gapCardFor, guidanceFor, guidanceLineFor, isMaterialGapCode } from "../../src/core/run/blockGuidance.js";

describe("走查修复小批：extraction_contract_bundle_missing 缺料指引", () => {
  const code = "extraction_contract_bundle_missing";

  it("回流附注：命中即出指引，含「勿遍历文件系统找料」与补齐路径（atf-validate-extraction-contract publish）", () => {
    const line = guidanceLineFor(code);
    expect(line).toBeDefined();
    expect(line).toContain(code);
    expect(line).toContain("勿遍历文件系统找料");
    expect(line).toContain("atf-validate-extraction-contract");
    expect(line).toContain("ExtractionContractBundle");
  });

  it("material gap 同构：isMaterialGapCode=true；缺口卡四段＋options ≤3 首条推荐＋停止出口", () => {
    expect(isMaterialGapCode(code)).toBe(true);
    const entry = guidanceFor(code);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("unreachable");
    expect(entry.meaning.length).toBeGreaterThan(0);
    expect(entry.missing.length).toBeGreaterThan(0);
    expect(entry.producedBy).toContain("atf-validate-extraction-contract");
    expect(entry.why.length).toBeGreaterThan(0);
    const card = gapCardFor("atf_admit_data", code);
    expect(card.stuck).toContain(code);
    expect(card.missing).toBe(entry.missing);
    expect(card.why).toBe(entry.why);
    expect(card.options.length).toBeGreaterThanOrEqual(1);
    expect(card.options.length).toBeLessThanOrEqual(3);
    expect(card.options[0]?.recommended).toBe(true);
    expect(card.options[card.options.length - 1]?.text).toContain("停止");
  });

  it("登记面既有条目零扰动（split_policy_missing 仍命中既有文案）", () => {
    expect(guidanceLineFor("split_policy_missing")).toContain("划分");
  });
});
