/**
 * 批次B 判据：自由文本不再由工具内正则解析，原话原样回传 agent。
 *
 * 设计锚：DSH 原生 user-questions 只提供 `custom?: string`（原文，不解析）——
 * `vendor/.../user-questions/src/types.ts:87` 注释明写 "Optional free-text 'Other' answer"。
 * 语义理解归 agent，工具不代劳。
 *
 * 现状缺陷（owner 判定）：产品代码里有 parseFieldChoiceInput 等多处正则，
 * 只能覆盖想得到的说法（「分两拨」「一半一半」全漏），且解析失败静默丢弃，
 * agent 无从知道用户到底说了什么。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../../packages/extensions/atf-tools/src");

const read = (f: string): string => readFileSync(join(SRC, f), "utf-8");

describe("B——自由文本不由工具解析", () => {
  it("字段卡不再用正则解析用户输入", () => {
    const src = read("pipelineFace.ts");
    expect(src.includes("parseFieldChoiceInput"), "parseFieldChoiceInput 仍在——工具代 agent 做语义理解").toBe(false);
  });

  it("分组卡不再用正则抓「分N组」", () => {
    const src = read("pipelineFace.ts");
    const regexHit = /customText\.match\(/.test(src) || /分\|改成\?/.test(src);
    expect(regexHit, "仍用正则从自由文本抓组数——覆盖不到的表述会被静默丢弃").toBe(false);
  });

  it("构造参数卡不再用正则抓数字", () => {
    const src = read("constructionGate.ts");
    const numRegex = /trimmed\.match\(\/\(\\d/.test(src);
    expect(numRegex, "仍用正则从自由文本抓数值").toBe(false);
  });

  it("用户原话必须原样回传（不得截断丢弃）", () => {
    const src = read("pipelineFace.ts");
    // 判据：卡应答后，custom 原文要出现在回执 note 里（agent 能读到）
    const hasRawEcho = /custom/.test(src) && /原话|用户说|自述/.test(src);
    expect(hasRawEcho, "自由文本原文未回传 agent——agent 无法据此修正").toBe(true);
  });
});
