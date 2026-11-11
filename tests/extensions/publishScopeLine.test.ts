// -*- coding: utf-8 -*-
/** A4(D280) 契约卡确认范围行 eval:三形态文本断言(多类合并/单类/legacy)。 */
import { describe, expect, it } from "vitest";
import { publishScopeLine } from "../../packages/extensions/atf-tools/src/confirmFace.js";

describe("publishScopeLine(D280 确认范围行)", () => {
  it("多类合并卡:全部类一次确认+账本逐类落账提示", () => {
    const s = publishScopeLine(true, null, ["bl", "ci"], 2);
    expect(s).toContain("全部 2 类契约件一次确认");
    expect(s).toContain("bl、ci");
    expect(s).toContain("账本逐类落账");
  });

  it("单类:此卡后无后续契约确认", () => {
    const s = publishScopeLine(false, "bl", ["bl"], 1);
    expect(s).toContain("bl 类契约件");
    expect(s).toContain("无后续契约确认");
    expect(s).not.toContain("将各自出卡");
  });

  it("legacy:无类型标注不冒充单类", () => {
    const s = publishScopeLine(false, null, [], 1);
    expect(s).toContain("legacy");
    expect(s).not.toContain("类契约件（本 run 单类");
  });
});
