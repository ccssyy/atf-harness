// D243 防回潮锚:user_decision 类任何情况下都必须走确认卡（ADR-0022 后无档位轴——
// 该类恒 true）。四验实锚:atf_label_qc_resolve 曾被 chain_advance 兜底免审,确认卡
// 整段跳过,用户凭据不可达(label_qc 无法闭环)。
import { describe, expect, it } from "vitest";
import { APPROVAL_SEMANTICS_BY_TOOL, requiresUserConfirmationOf, TOOL_DEFINITIONS } from "../../src/core/tools/toolDefinition.js";

const resolveDef = TOOL_DEFINITIONS.find((d) => d.name === "atf_label_qc_resolve");

describe("D243 user_decision 确认卡兜底（ADR-0022 后）", () => {
  it("atf_label_qc_resolve 归类 user_decision", () => {
    expect(APPROVAL_SEMANTICS_BY_TOOL["atf_label_qc_resolve"]).toBe("user_decision");
  });

  it("user_decision 恒走确认卡（无免审口）", () => {
    expect(resolveDef).toBeTruthy();
    expect(requiresUserConfirmationOf(resolveDef!, {})).toBe(true);
  });

  it("对照:chain_advance 类恒直通（ADR-0022 拦截退役;直通留痕在消费点）", () => {
    const admit = TOOL_DEFINITIONS.find((d) => d.name === "atf_admit_data");
    expect(admit).toBeTruthy();
    expect(requiresUserConfirmationOf(admit!, {})).toBe(false);
  });
});
