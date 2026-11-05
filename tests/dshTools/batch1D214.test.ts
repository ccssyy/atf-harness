/** 批1-D214 锚:产品内置模板=不写 template 键(走骨架)——回执结构化指令在位。
 *
 * 源码面 grep 锚:resolved_via=builtin_default 时回执携带 instructions 字段
 * (不传 --prompt-template+template 保持空+禁手写冒充)——真机曾把「选内置」
 * 执行成手写 217 字短句,骨架(1126 句式:文档类型句+平铺语义+全字段名列出+
 * 格式规范段)全部丢失。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts");

describe("批1-D214——prompt 卡 builtin_default 回执带机器语义指令", () => {
  it("instructions 字段在位且三要素齐(不传参/留空/禁冒充)", () => {
    const src = readFileSync(SRC, "utf8");
    expect(src).toContain('resolvedVia === "builtin_default"');
    expect(src).toContain("后续 experiment_setup 段【不传】--prompt-template");
    expect(src).toContain("field-config.template 保持空");
    expect(src).toContain("禁止把任何手写模板文本写进 template 键冒充内置");
  });
});
