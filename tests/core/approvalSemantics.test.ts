/**
 * D170v2 §4.1 确认卡分派（ADR-0022 后语义）：readonly/chain_advance 直通（留痕义务
 * 在消费点），governance/user_decision 任何档位走业务确认卡；未收编工具维持既有链
 * （谓词优先，退基准旗标）。原档位双轴（训练预设×完全权限档）随审批拦截退役。
 */
import { describe, expect, it } from "vitest";
import { requiresUserConfirmationOf, TOOL_DEFINITIONS } from "../../src/core/tools/index.js";

// 分类表按工具名判定;核心 TOOL_DEFINITIONS 之外的扩展面工具(skill_read/pipeline_stage/
// launch_execute 等)用最小 stub——分类表只消费 name,不依赖定义其余字段。
const defOf = (name: string): Parameters<typeof requiresUserConfirmationOf>[0] => {
  const def = TOOL_DEFINITIONS.find((entry) => entry.name === name);
  return def !== undefined ? def : ({ name } as never);
};

describe("D170v2 §4.1 确认卡语义分类表（ADR-0022 退役后）", () => {
  it("只读面直通", () => {
    for (const name of ["atf_workspace_status", "atf_label_qc_inspect", "atf_skill_read"]) {
      expect(requiresUserConfirmationOf(defOf(name), {})).toBe(false);
    }
  });

  it("链内推进直通（原档位审批轴退役——直通留痕由 bridgeFace 分支承载）", () => {
    expect(requiresUserConfirmationOf(defOf("atf_admit_data"), {})).toBe(false);
    expect(requiresUserConfirmationOf(defOf("atf_pipeline_stage"), { stage: "register" })).toBe(false);
    expect(requiresUserConfirmationOf(defOf("atf_create_experiment"), {})).toBe(false);
    expect(requiresUserConfirmationOf(defOf("atf_rebind_workspace"), {})).toBe(false);
  });

  it("治理点任何档位走业务确认卡", () => {
    expect(requiresUserConfirmationOf(defOf("atf_launch_execute"), {})).toBe(true);
  });

  it("user_decision 任何档位走确认卡（D243 防回潮）", () => {
    expect(requiresUserConfirmationOf(defOf("atf_label_qc_resolve"), {})).toBe(true);
  });

  it("atf_gate 参数面分派：query/advance 均直通（ADR-0022）", () => {
    const def = defOf("atf_gate");
    expect(requiresUserConfirmationOf(def, { action: "query" })).toBe(false);
    expect(requiresUserConfirmationOf(def, { action: "advance" })).toBe(false);
    expect(requiresUserConfirmationOf(def, {})).toBe(false);
  });
});
