// -*- coding: utf-8 -*-
// StageIoContract C2：atf_write 写时校验纯函数测试。
// 判据（任务书 C2）：已登记 schema 的段产物件，落盘即校验 schema_version；
// 不合契约当场拒（回执带差缺点位与修复指令）；raw:/非 JSON/未声明路径零打扰放行。
import { describe, expect, it } from "vitest";
import { ioContractViolationOf, type IoDecl } from "../../src/agent/ioContractCheck.js";

const DECLS: IoDecl[] = [
  { stage: "label_qc", name: "qc_visual_checklist", schemaRef: "schema:LabelQcVisualChecklist/v1", pathPattern: "datasets/<dataset>/qc-visual-checklist.json" },
  { stage: "style_split", name: "field_visual_signals", schemaRef: "schema:FieldVisualSignals/v1", pathPattern: "data/risk-signals/<doc_type>/field-visual-signals.json" },
  { stage: "style_split", name: "visual_sample_plan", schemaRef: "raw:visual-sample-plan.json", pathPattern: "data/risk-signals/<doc_type>/visual-sample-plan.json" },
];

describe("ioContractViolationOf（写时校验）", () => {
  it("schema: 件缺 schema_version → 拒且指认差缺点位", () => {
    const run = "/ws/experiments/e/run/datasets/ds@abc/qc-visual-checklist.json";
    const v = ioContractViolationOf(run, JSON.stringify({ items: [] }), DECLS);
    expect(v).not.toBeNull();
    expect(v?.reason).toBe("io_contract_violation");
    expect(v?.message).toContain("schema_version");
    expect(v?.message).toContain("LabelQcVisualChecklist/v1");
  });

  it("schema: 件 schema_version 与声明不符 → 拒且两端值都展示", () => {
    const run = "/ws/datasets/ds@abc/qc-visual-checklist.json";
    const v = ioContractViolationOf(run, JSON.stringify({ schema_version: "Wrong/v9" }), DECLS);
    expect(v).not.toBeNull();
    expect(v?.message).toContain("Wrong/v9");
    expect(v?.message).toContain("LabelQcVisualChecklist/v1");
  });

  it("schema_version 与声明一致 → 放行（null）", () => {
    const run = "/ws/data/risk-signals/bl/field-visual-signals.json";
    expect(ioContractViolationOf(run, JSON.stringify({ schema_version: "FieldVisualSignals/v1", fields: [] }), DECLS)).toBeNull();
  });

  it("raw: 件不校验内容 → 零打扰放行", () => {
    const run = "/ws/data/risk-signals/ci/visual-sample-plan.json";
    expect(ioContractViolationOf(run, "not json at all", DECLS)).toBeNull();
  });

  it("未声明路径 → 零打扰放行（scratch 自由）", () => {
    expect(ioContractViolationOf("/ws/scratch/notes.json", "{}", DECLS)).toBeNull();
  });

  it("非 JSON 内容写 schema: 件 → 拒（声明件必须 JSON）", () => {
    const run = "/ws/datasets/ds/qc-visual-checklist.json";
    const v = ioContractViolationOf(run, "{{{", DECLS);
    expect(v).not.toBeNull();
    expect(v?.message).toContain("JSON");
  });
});
