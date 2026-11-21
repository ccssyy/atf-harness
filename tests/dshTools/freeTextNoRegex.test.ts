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

/**
 * 事故锚迁移（2026-11-21，B3 批；原 fieldChoiceParse.test.ts 退役）。
 *
 * 原事故（复验#24）：用户写「除 awb_title 外的 16 个都要」→ 旧正则没认出
 * → 静默吞掉，卡消失、凭据不落，agent 完全不知道用户说过话。
 *
 * 原解法：把正则写强，专治这个说法（`parseFieldChoiceInput`）。该函数已被
 * 本批判据明令退役——更强的正则仍覆盖不了「分两拨」「一半一半」这类说法。
 *
 * 新方向：不猜，原话一律留底回传 agent。故事故锚从「必须解析对」
 * 改为「绝不能静默吞」——只要用户说了话，那句话就必须在回传面里。
 * 事故的防护强度只增不减：原锚守的是「一种说法能被认出」，
 * 新锚守的是「任何说法都不会被丢掉」。
 */
describe("事故锚（复验#24）：用户写的话绝不被静默吞掉", () => {
  /** 从 pipelineFace.ts 源码里抽出字段卡回落分支，验证原话留底。 */
  const pipelineSrc = read("pipelineFace.ts");

  it("字段卡回落必须把原话放进 user_words（而非空数组静默丢弃）", () => {
    // 旧实现：解析失败 return [] → 调用方当用户没说
    // 新实现：无论能否理解，原文进 user_words
    expect(pipelineSrc, "字段卡回落分支缺 user_words——原话会被静默吞").toContain("user_words:");
  });

  it("解析函数 parseFieldChoiceInput 已退役（不再有「猜自由文本」的入口）", () => {
    expect(pipelineSrc.includes("parseFieldChoiceInput")).toBe(false);
  });

  it("回落分支给出重调指引（agent 知道该怎么补）", () => {
    expect(pipelineSrc, "缺 retry_hint——agent 收到原话却不知下一步").toContain("retry_hint:");
    expect(pipelineSrc, "缺 field_config 重调指引").toContain("field_config");
  });

  it("回落分支附带全量字段名（agent 才有对照表理解用户说的人名）", () => {
    expect(pipelineSrc, "缺 all_field_names——agent 无法把口语对上字段").toContain("all_field_names:");
  });

  it("构造参数卡未解析的作答也留底（card_answers）", () => {
    const gateSrc = read("constructionGate.ts");
    expect(gateSrc, "构造卡缺 card_answers 留底——作答会被静默丢").toContain("card_answers");
  });
});

/**
 * 事故锚迁移（B3c，2026-11-21 owner 裁定）：N5 回归锁。
 *
 * 原事故（N5）：WebUI 把 selected 回传成整行文字时，「2 倍」被吞成「不增强」。
 * 原解法：写 `augmentFromText` 做闭集查表把 label 翻回数字。
 * 该函数已随 B3c 删除——工具不再做 label→value 翻译（vendor 官方 tool-ask-user
 * 明写「答案原样回 agent」）。
 *
 * 新方向：答案原样回传，由 agent 理解。故事故锚从「必须解析对」改为
 * 「作答必须原样照录，不得被任何解析层吞掉或改写」。
 */
describe("事故锚（N5/B3c）：作答原样照录，不被解析层吞改", () => {
  const gateSrc = read("constructionGate.ts");

  it("构造卡不再有任何 label→value 查表（spellingIndex / TEXT_INDEX 全族不得存在）", () => {
    expect(gateSrc.includes("spellingIndexOf"), "闭集查表工厂仍在").toBe(false);
    expect(gateSrc.includes("TEXT_INDEX"), "查表常量仍在").toBe(false);
    expect(gateSrc.includes("numericSpellingsOf"), "拼写生成器仍在").toBe(false);
  });

  it("构造卡不再有 xxxFromText 解析入口", () => {
    expect(gateSrc.includes("augmentFromText"), "augmentFromText 仍在").toBe(false);
    expect(gateSrc.includes("cutoffFromText"), "cutoffFromText 仍在").toBe(false);
  });

  it("用户作答必须原样照录进返回体（card_answers）", () => {
    expect(gateSrc, "缺 card_answers——作答会被静默吞").toContain("card_answers");
  });

  it("返回体不含指令式话术（工具只交数据，不指挥 agent 怎么做）", () => {
    expect(gateSrc.includes("不解析"), "返回体仍带「不解析」类工具视角话术").toBe(false);
    expect(gateSrc.includes("请理解他的意思后"), "返回体仍带命令式指令").toBe(false);
  });
});
