/**
 * D181 机检锚:prompt 确认卡选项表的用户语义忠实性(T10 同类二发——UAT
 * 「航空运单解析模型训练」实锤:用户已提供 prompt 且会话指明,卡仍推荐内置)。
 */
import { describe, expect, it } from "vitest";
import { promptChoiceOptionsOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

describe("D181 prompt 卡选项表机检", () => {
  it("用户/材料信号在场:「用材料里的抽取说明」排首位,且任何选项不得带「推荐——没有材料时的缺省」", () => {
    const options = promptChoiceOptionsOf("用户在对话中提供的抽取说明");
    const labels = options.map((o) => o.label);
    expect(labels).toContain("用材料里的抽取说明");
    expect(labels.indexOf("用材料里的抽取说明")).toBeLessThan(labels.indexOf("用产品内置模板"));
    expect(options.some((o) => o.description.includes("推荐——没有材料时的缺省"))).toBe(false);
  });

  it("无信号时:才允许「用产品内置模板」带推荐缺省标注(缺省语义保留)", () => {
    const options = promptChoiceOptionsOf(null);
    expect(options.some((o) => o.label === "用产品内置模板" && o.description.includes("推荐"))).toBe(true);
  });
});
