/**
 * R-3 接线批（2026-09-23）：ui/labelQcCard 单测——卡面「依据/条款/出处」展示（含裁定 B
 * 整图引用/外部来源如实标注）、九项闭集应答解析（含检查类约束与非法应答就地重问语义）、
 * 处置必填字段追问、A2.5 确定性合成形态。
 */
import { describe, expect, it } from "vitest";
import {
  applyLabelQcField,
  labelQcCardLines,
  labelQcConfirmationText,
  labelQcFieldPrompt,
  labelQcItemLines,
  labelQcItemPrompt,
  parseLabelQcAnswer,
  requiredFieldsOf,
  synthesizeLabelQcResolveAction,
  type LabelQcAnswer,
} from "../../src/ui/labelQcCard.js";
import type { LabelQcDecisionDraft, LabelQcItem, LabelQcReportFile } from "../../src/core/workspace/index.js";

const q2Item: LabelQcItem = {
  item_id: "qc-q2-aaaaaaaaaaaa",
  check_class: "q2_same_box_same_value_diff_field",
  human_label: "同一位置、同样的值，却标给了不同字段（需确认归属）",
  suggested_action: { action_hint: "dispose", disposition_hint: "keep_first", target_candidate_id: "cand-1" },
  locator: { sample_id: "img-0001", field: "date", page: "3" },
  evidence: [{ kind: "annotation_slice", ref: "datasets/ds@pin/label-qc/qc-q2-aaaaaaaaaaaa.json", digest: "0123456789abcdef" }],
  candidates: [
    { candidate_id: "cand-1", value: "2026-01-01", source: "field_a" },
    { candidate_id: "cand-2", value: "2026-01-01", source: "field_b" },
  ],
};

const report: LabelQcReportFile = {
  schema_version: "LabelQcReport/v1",
  dataset_id: "ds-3b7551bca6ec",
  pin: "5fe2a8c9a98b",
  report_digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  counts: { total_items: 3, pending: 3, resolved: 0 },
  items: [q2Item],
};

describe("labelQcItemLines：依据/条款/出处展示（裁定 B 口径）", () => {
  it("含人读标签/出处（样本·字段·页）/整图引用/证据切片/候选/建议", () => {
    const lines = labelQcItemLines(q2Item, 1, 2, "source/img-0001.png").join("\n");
    expect(lines).toContain("待确认项 1/2 · qc-q2-aaaaaaaaaaaa（q2）");
    expect(lines).toContain("同一位置、同样的值，却标给了不同字段");
    expect(lines).toContain("样本 img-0001 · 字段 date · 页 3");
    expect(lines).toContain("整图 source/img-0001.png（Q2 按整图理解，可自行打开查看）");
    expect(lines).toContain("annotation_slice:datasets/ds@pin/label-qc/qc-q2-aaaaaaaaaaaa.json（0123456789ab…）");
    expect(lines).toContain("A=cand-1 值=2026-01-01（来源 field_a）");
    expect(lines).toContain("keep_first");
  });
  it("外部来源（无整图引用）如实标注，不造引用", () => {
    const lines = labelQcItemLines(q2Item, 1, 1, null).join("\n");
    expect(lines).toContain("外部来源样本（无工作区整图引用）");
  });
  it("应答菜单：按检查类闭集出选项；有建议才出 1", () => {
    const prompt = labelQcItemPrompt(q2Item);
    expect(prompt).toContain("1=按建议");
    expect(prompt).toContain("keep_first/keep_second/keep_both/drop_both/set_value");
    expect(prompt).toContain("s=暂不处置");
    const noHintItem: LabelQcItem = { ...q2Item, suggested_action: { action_hint: "review" } };
    expect(labelQcItemPrompt(noHintItem)).not.toContain("1=按建议");
  });
});

describe("parseLabelQcAnswer：九项闭集应答解析", () => {
  const parse = (text: string): LabelQcAnswer => parseLabelQcAnswer(q2Item, text);
  it("1=按建议（无建议 → invalid）；2=维持原状；3+处置码=自选", () => {
    expect(parse("1")).toEqual({ kind: "suggest" });
    expect(parse("2")).toEqual({ kind: "reject" });
    expect(parse("3 keep_second")).toEqual({ kind: "dispose", disposition: "keep_second" });
    expect(parse("s")).toEqual({ kind: "skip" });
    expect(parse("S")).toEqual({ kind: "skip" });
  });
  it("非法应答：越出闭集/裸 3/乱输入 → invalid（就地重问语义）", () => {
    expect(parse("3")?.kind).toBe("invalid");
    expect(parse("3 dedupe")?.kind).toBe("invalid"); // dedupe 不在 q2 允许组合
    expect(parse("9")?.kind).toBe("invalid");
    const noHintItem: LabelQcItem = { ...q2Item, suggested_action: { action_hint: "review" } };
    expect(parseLabelQcAnswer(noHintItem, "1")?.kind).toBe("invalid");
  });
});

describe("必填字段追问与应答落草案", () => {
  it("字段序＝内核 REQUIRED_DECISION_FIELDS；target_candidate_id 接受候选字母", () => {
    expect(requiredFieldsOf("keep_first")).toEqual(["target_candidate_id"]);
    expect(requiredFieldsOf("keep_both")).toEqual(["reason_text"]);
    expect(requiredFieldsOf("clip_to_bounds")).toEqual([]);
    const prompt = labelQcFieldPrompt("keep_first", "target_candidate_id", q2Item);
    expect(prompt).toContain("A=cand-1");
    expect(prompt).toContain("B=cand-2");
    let draft: LabelQcDecisionDraft = { item_id: q2Item.item_id, action: "modify", disposition: "keep_first" };
    draft = applyLabelQcField(draft, "target_candidate_id", "B", q2Item);
    expect(draft.target_candidate_id).toBe("cand-2");
    draft = applyLabelQcField(draft, "target_candidate_id", "cand-1", q2Item);
    expect(draft.target_candidate_id).toBe("cand-1");
  });
});

describe("卡头/确认文本/确定性合成", () => {
  it("卡头含数据集身份与进度；确认文本含提交/未决数", () => {
    const header = labelQcCardLines(report, [q2Item], 1).join("\n");
    expect(header).toContain("ds-3b7551bca6ec@5fe2a8c9a98b");
    expect(header).toContain("已确认 1 项，本次待处置 1 项");
    expect(header).toContain("绝不默认处置");
    const text = labelQcConfirmationText(report, 1, 2);
    expect(text).toContain("逐项确认 1 项");
    expect(text).toContain("尚有 2 项未决");
    expect(labelQcConfirmationText(report, 1, 0)).toContain("可重新请求数据准入");
  });
  it("synthesizeLabelQcResolveAction：A2.5 同构（tool/origin 恒定；params 逐字透传）", () => {
    const params = { dataset_id: "ds", actor: "tui-operator", report_digest: "sha256:x", decisions: [{ item_id: "i", action: "reject" }] };
    const action = synthesizeLabelQcResolveAction(params);
    expect(action.tool).toBe("atf_label_qc_resolve");
    expect(action.origin).toBe("confirm_card");
    expect(action.params).toBe(params);
  });
});
