/** D224 锚:字段确认闸 doc_type 键错位误报。
 * 真机实锚 11-06 ci-bl-test1106-1:register 后用户已在卡上确认 per-doc 账本
 * (field-choice.ci.json, source=user_confirmed, 15:43:27),agent 裸调(无 doc_type)
 * experiment_setup(16:06)仍被拦 field_choice_unconfirmed——闸读 run 级账本恒缺席。
 * 报错假指路「重跑 register/聊天确认」引发用户不必要的二次确认+把 agent 推上
 * 手抄 field-config 歧路(ci 25 字段抄漏 vessel_name)。
 *
 * 修复=裸调不在 harness 拦(交内核多类裸调拦截带真因);只拦「带 doc_type 且该类
 * 无账本」的真未确认;报错文案带 doc_type 与逐类调用指引。
 * 本文件源码锚:闸判定必须含 fieldChoiceDoc !== undefined 分支;文案必须含
 * 逐类 doc_type 指引(防退回无差别拦形态)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("D224——字段确认闸裸调不误拦", () => {
  const src = readFileSync(SRC, "utf8");
  it("闸判定三态:带 doc_type 查该类;裸调盘账本(fieldChoiceAnyLedgerOf);fresh run 仍 fail-closed", () => {
    expect(src).toMatch(/fieldChoiceDoc !== undefined\s*\? readFieldChoice\(runDir, fieldChoiceDoc\) !== null\s*: fieldChoiceAnyLedgerOf\(runDir\)/);
    // fresh run 兜底语义在 fieldChoice.ts:无账本 false(闸拦),不造无凭据放行
    const fc = readFileSync(join(process.cwd(), "packages/extensions/atf-tools/src/fieldChoice.ts"), "utf8");
    expect(fc).toContain("export const fieldChoiceAnyLedgerOf");
    expect(fc).toMatch(/fresh run.*返回 false|无任何账本.*false/s);
  });
  it("报错文案:带 doc_type 真因与逐类调用指引(不再是假指路重跑 register)", () => {
    const m = src.match(/field_choice_unconfirmed[\s\S]{0,900}?note: `([^`]*)`/);
    expect(m, "field_choice_unconfirmed 文案须为模板串(带 doc_type)").toBeTruthy();
    expect(m?.[1]).toContain("逐类带 doc_type");
    expect(m?.[1]).toContain("doc_type=");
  });
  it("报错只发生在真未确认形态(文案带 doc_type 真因)", () => {
    const m = src.match(/field_choice_unconfirmed[\s\S]{0,900}?note: `([^`]*)`/);
    expect(m, "文案须为模板串").toBeTruthy();
    expect(m?.[1]).toContain("逐类带 doc_type");
  });
});
