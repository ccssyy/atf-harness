/** D173 必分组机检锚(1106 晚补批三,owner 指正「落盘早有裁定」)。
 * owner 两周前裁定(D173 已验关闭+返修 F):字段默认必须分组、1 组候选剔除、
 * 候选区间 2-3 优先上限 5——「无候选且配置无分组」不得静默平铺过闸。
 * D225 机械派生件不产 group 键后,该形态成了主路默认态,补批曾把它当「待裁矛盾」
 * 呈报=没读落盘。本锚机检:source=none 即拦+指路两条改法。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("D173 必分组——无分组输入不静默平铺", () => {
  const src = readFileSync(SRC, "utf8");
  it("源码锚:grouping_candidates_missing 拦截在场且带两条改法与区间", () => {
    expect(src).toContain('"grouping_candidates_missing"');
    const note = src.match(/grouping_candidates_missing[\s\S]{0,600}?note: "([^"]*)"/);
    const noteText = note?.[1] ?? "";
    expect(noteText).toContain("必须分组");
    expect(noteText).toContain("2-3 组");
    expect((noteText.match(/①|②/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("源码锚:平铺兜底 note 与未确认文案不再承诺「默认生成」", () => {
    expect(src).not.toContain("按数据事实分组默认生成");
    expect(src).toContain("不静默平铺");
  });
});
