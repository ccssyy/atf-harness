// D243 防回潮锚:user_decision 类任何档位/任何 autopilot 组合都必须走确认卡。
// 四验实锚:atf_label_qc_resolve 在「完全权限+训练自动驾驶」下被 chain_advance
// 兜底免审,确认卡整段跳过,用户凭据不可达(label_qc 无法闭环)。
import { describe, expect, it } from "vitest";
import { APPROVAL_SEMANTICS_BY_TOOL, requiresApprovalFor, TOOL_DEFINITIONS } from "../../src/core/tools/toolDefinition.js";

const resolveDef = TOOL_DEFINITIONS.find((d) => d.name === "atf_label_qc_resolve");

describe("D243 user_decision 类审批兜底", () => {
  it("atf_label_qc_resolve 归类 user_decision", () => {
    expect(APPROVAL_SEMANTICS_BY_TOOL["atf_label_qc_resolve"]).toBe("user_decision");
  });

  it("完全权限+训练自动驾驶(双轴齐备)仍须确认卡——旧缺陷复现形态", () => {
    expect(resolveDef).toBeTruthy();
    expect(
      requiresApprovalFor(resolveDef!, {}, { tier: "full-access", trainingAutopilot: true }),
    ).toBe(true);
  });

  it("全部四档组合(user_decision 无免审口)", () => {
    expect(resolveDef).toBeTruthy();
    for (const tier of ["guarded", "full-access"] as const) {
      for (const autopilot of [true, false]) {
        expect(
          requiresApprovalFor(resolveDef!, {}, { tier, trainingAutopilot: autopilot }),
        ).toBe(true);
      }
    }
  });

  it("对照:chain_advance 类在双轴齐备时仍免审(行为不回归)", () => {
    const admit = TOOL_DEFINITIONS.find((d) => d.name === "atf_admit_data");
    expect(admit).toBeTruthy();
    expect(
      requiresApprovalFor(admit!, {}, { tier: "full-access", trainingAutopilot: true }),
    ).toBe(false);
  });
});
