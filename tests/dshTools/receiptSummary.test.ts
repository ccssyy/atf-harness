// -*- coding: utf-8 -*-
// C3-C6 批子切片 4（C4.1）：升级通知与自愈对账测试。
// 实锚：1112 轮 13 条「需要你介入」全为 agent 自愈（0 次真需介入）——升级即发射不可撤回+文案不分类。
// 判据：①升级发射即标 fired、自愈成功可 clear（对冲依据）；②owner 介入类判别（凭据/白名单/审批类=强文案，其余=软文案+对冲）。
import { describe, expect, it } from "vitest";
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


// ── 批 5 3c（owner 2026-11-16）：升级文案分类=码级三分表（U-E2/U-E3）──

import { receiptNeedsUser, reasonCodesOfReceipt } from "../../packages/extensions/atf-tools/src/receiptSummary.js";
import { REASON_CODE_CATEGORIES } from "../../src/core/generated/reasonCategories.js";

describe("receiptNeedsUser（批 5 三分判据：码级闭集主判）", () => {
  it("need_user 码 → 呈人强文案（裁决/等人/聚类路线待答类）", () => {
    expect(receiptNeedsUser({ ok: false, reason_codes: ["label_conflict_unresolved"] })).toBe(true);
    expect(receiptNeedsUser({ ok: false, reason_codes: ["cluster_route_choice_pending"] })).toBe(true);
    expect(receiptNeedsUser({ ok: false, error: "vllm_memory_confirmation_required:显存确认" })).toBe(true);
  });

  it("self_heal / record 码 → 软文案+自愈对冲（不稀释真告警）", () => {
    expect(receiptNeedsUser({ ok: false, reason_codes: ["fixture_not_found"] })).toBe(false);
    expect(receiptNeedsUser({ ok: false, reason_codes: ["embedding_cluster_degraded_no_cluster"] })).toBe(false);
  });

  it("越集码（未登记分类的新码）→ 默认呈人 fail-closed（U-E3 演练锚）", () => {
    expect(receiptNeedsUser({ ok: false, reason_codes: ["totally_unknown_new_code"] })).toBe(true);
    expect(REASON_CODE_CATEGORIES["totally_unknown_new_code"]).toBeUndefined();
  });

  it("无码回执 → 文案正则兜底（观测面，非主判）", () => {
    expect(receiptNeedsUser({ ok: false, missing: ["凭据缺失"] })).toBe(true);
    expect(receiptNeedsUser({ ok: false, missing: ["缺顶层键 template"] })).toBe(false);
  });

  it("段回执形态：raw_response.reason_codes 同判（含混合码任一 need_user 即强）", () => {
    expect(receiptNeedsUser({ ok: false, raw_response: { reason_codes: ["fixture_not_found"] } })).toBe(false);
    expect(receiptNeedsUser({ ok: false, raw_response: { reason_codes: ["fixture_not_found", "waiting_on_user"] } })).toBe(true);
    expect(reasonCodesOfReceipt({ error: "cluster_route_choice_pending:待答" })).toEqual(["cluster_route_choice_pending"]);
  });

  it("生成物三分表：内核单源投影在场景内（≥50 码+值域闭集）", () => {
    const entries = Object.entries(REASON_CODE_CATEGORIES);
    expect(entries.length).toBeGreaterThanOrEqual(50);
    const valid = new Set(["need_user", "self_heal", "record"]);
    for (const [, value] of entries) expect(valid.has(value)).toBe(true);
    expect(REASON_CODE_CATEGORIES["label_conflict_unresolved"]).toBe("need_user");
    expect(REASON_CODE_CATEGORIES["embedding_cluster_degraded_no_cluster"]).toBe("record");
  });
});
