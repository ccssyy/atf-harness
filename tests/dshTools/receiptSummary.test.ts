// -*- coding: utf-8 -*-
// C3-C6 批子切片 4（C4.1）：升级通知与自愈对账测试。
// 实锚：1112 轮 13 条「需要你介入」全为 agent 自愈（0 次真需介入）——升级即发射不可撤回+文案不分类。
// 判据：①升级发射即标 fired、自愈成功可 clear（对冲依据）；②owner 介入类判别（凭据/白名单/审批类=强文案，其余=软文案+对冲）。
import { describe, expect, it } from "vitest";
import {
  approvalTailLineOf,
} from "../../packages/extensions/atf-tools/src/permissionTier.js";
import {
  decorateOutcome,
  escalationFiredOf,
  clearEscalation,
  ownerInterventionOf,
  escalationKeyOf,
  ESCALATION_FAILURE_THRESHOLD,
} from "../../packages/extensions/atf-tools/src/receiptSummary.js";

describe("escalation fired 标记与对账（C4.1①）", () => {
  it("decorateOutcome 失败达阈值 → fired 键被标记", () => {
    const key = escalationKeyOf("sess-x", "atf_pipeline_stage", "register:");
    const receipt = { ok: false, error: "x" };
    let n = 0;
    for (let i = 0; i < ESCALATION_FAILURE_THRESHOLD; i++) {
      decorateOutcome(receipt, "sess-x", "atf_pipeline_stage", false, { conclusion: "c", stage: "s", next: "n" }, "register:");
      n = i;
    }
    expect(escalationFiredOf(key)).toBe(true);
    expect(n).toBe(ESCALATION_FAILURE_THRESHOLD - 1);
  });

  it("clearEscalation → fired 清除且返回曾发射事实（对冲触发依据）", () => {
    const key = escalationKeyOf("sess-y", "atf_pipeline_stage", "label_qc:bl");
    decorateOutcome({ ok: false }, "sess-y", "atf_pipeline_stage", false, { conclusion: "c", stage: "s", next: "n" }, "label_qc:bl");
    decorateOutcome({ ok: false }, "sess-y", "atf_pipeline_stage", false, { conclusion: "c", stage: "s", next: "n" }, "label_qc:bl");
    expect(escalationFiredOf(key)).toBe(true);
    expect(clearEscalation(key)).toBe(true);
    expect(escalationFiredOf(key)).toBe(false);
    expect(clearEscalation(key)).toBe(false);
  });

  it("未达阈值不标记", () => {
    const key = escalationKeyOf("sess-z", "atf_pipeline_stage", "ok:");
    decorateOutcome({ ok: false }, "sess-z", "atf_pipeline_stage", false, { conclusion: "c", stage: "s", next: "n" }, "ok:");
    expect(escalationFiredOf(key)).toBe(false);
  });
});

describe("ownerInterventionOf（C4.1② 文案与可介入性挂钩）", () => {
  it("凭据/白名单/审批类 → owner 介入（强文案）", () => {
    expect(ownerInterventionOf("missing: 凭据缺失 user_confirmed 不在")).toBe(true);
    expect(ownerInterventionOf("file_path_outside_allowlist 白名单外")).toBe(true);
    expect(ownerInterventionOf("审批拒绝")).toBe(true);
  });
  it("缺件/参数/schema 类 → 非 owner（软文案+自愈对冲）", () => {
    expect(ownerInterventionOf("missing: 缺顶层键 template")).toBe(false);
    expect(ownerInterventionOf("variants 槽位缺席——先完成 candidate_build")).toBe(false);
    expect(ownerInterventionOf("")).toBe(false);
  });
});

describe("approvalTailLineOf 回归锚（切片 2 交付不回退）", () => {
  it("guarded 档保留 owner 措辞", () => {
    expect(approvalTailLineOf("guarded")).toContain("仅 owner 可点");
  });
});
