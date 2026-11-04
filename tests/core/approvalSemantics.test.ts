/**
 * D170v2 §4.1：审批按操作语义分派（readonly/chain_advance/governance 三类，
 * 替代逐工具名枚举）——语义分类表单源 + 档位双轴（训练预设×完全权限档）判定。
 * 链内推进双轴齐备免审（豁免是便利、权限是授权）；治理点任何档位逐次审批；
 * 只读任何档位免审；未收编工具维持既有链（谓词优先，退基准旗标）。
 */
import { describe, expect, it } from "vitest";
import { requiresApprovalFor, TOOL_DEFINITIONS } from "../../src/core/tools/index.js";

// 分类表按工具名判定;核心 TOOL_DEFINITIONS 之外的扩展面工具(skill_read/pipeline_stage/
// launch_execute 等)用最小 stub——分类表只消费 name,不依赖定义其余字段。
const defOf = (name: string): Parameters<typeof requiresApprovalFor>[0] => {
  const def = TOOL_DEFINITIONS.find((entry) => entry.name === name);
  return def !== undefined ? def : ({ name } as never);
};

describe("D170v2 §4.1 审批语义分类表", () => {
  it("只读面任何档位免审（缺省 context 亦免）", () => {
    for (const name of ["atf_workspace_status", "atf_label_qc_inspect", "atf_skill_read"]) {
      expect(requiresApprovalFor(defOf(name), {})).toBe(false);
      expect(requiresApprovalFor(defOf(name), {}, { tier: "guarded" })).toBe(false);
    }
  });

  it("链内推进：双轴齐备（完全权限档+训练预设）免审，任一缺席逐次审批", () => {
    const def = defOf("atf_admit_data");
    expect(requiresApprovalFor(def, {}, { tier: "full-access", trainingAutopilot: true })).toBe(false);
    // 档位缺席（guarded）/ 预设缺席 → 须审批
    expect(requiresApprovalFor(def, {}, { tier: "guarded", trainingAutopilot: true })).toBe(true);
    expect(requiresApprovalFor(def, {}, { tier: "full-access", trainingAutopilot: false })).toBe(true);
    // context 缺省=审慎侧
    expect(requiresApprovalFor(def, {})).toBe(true);
  });

  it("治理点任何档位逐次审批（含双轴齐备）", () => {
    const def = defOf("atf_launch_execute");
    expect(requiresApprovalFor(def, {}, { tier: "full-access", trainingAutopilot: true })).toBe(true);
    expect(requiresApprovalFor(def, {}, { tier: "guarded" })).toBe(true);
    expect(requiresApprovalFor(def, {})).toBe(true);
  });

  it("链内推进语义覆盖 atf_pipeline_stage：双轴齐备免审、缺省须审", () => {
    const def = defOf("atf_pipeline_stage");
    expect(requiresApprovalFor(def, { stage: "register" }, { tier: "full-access", trainingAutopilot: true })).toBe(false);
    expect(requiresApprovalFor(def, { stage: "register" })).toBe(true);
  });

  it("atf_gate 参数面分派：query 恒免审,advance 链内推进语义(双轴免/缺省审)", () => {
    const def = defOf("atf_gate");
    expect(requiresApprovalFor(def, { action: "query" })).toBe(false);
    expect(requiresApprovalFor(def, { action: "query" }, { tier: "guarded" })).toBe(false);
    expect(requiresApprovalFor(def, { action: "advance" }, { tier: "full-access", trainingAutopilot: true })).toBe(false);
    expect(requiresApprovalFor(def, { action: "advance" })).toBe(true);
  });
});
