// -*- coding: utf-8 -*-
// C3-C6 批子切片 6（M8·形态丙）：内核单源统计件外部直写拦截测试。
// 分层准则=语义判读归 agent / 事实统计归内核（owner 1107 裁定）；1112 实锚=agent 手跑
// field_risk_signals.py 直写 run 产物（绕段门禁）。闭集=内核单源统计文件名；
// agent 判读件（field-visual-signals 等）与 scratch 放行。
import { describe, expect, it } from "vitest";
import { kernelStatisticWriteViolationOf } from "../../src/agent/ioContractCheck.js";

describe("kernelStatisticWriteViolationOf（子 6 丙形态）", () => {
  it("直写 field_risk_signals（run 数据面）→ 拒+段入口指路", () => {
    const v = kernelStatisticWriteViolationOf("/ws/experiments/e/run-bl/data/risk-signals/bl/field_risk_signals.json");
    expect(v).not.toBeNull();
    expect(v?.message).toContain("段入口");
  });

  it("直写 label-qc-report / visual-sample-plan / registration / iteration-config → 同拒", () => {
    for (const p of [
      "/ws/datasets/ds@x/label-qc-report.json",
      "/ws/datasets/ds@x/qc-parallel-workorders.json",
      "/ws/datasets/ds@x/registration.json",
      "/ws/experiments/e/run-bl/data/family-split/split-manifest.json",
      "/ws/experiments/e/run/prep/iteration-config/iteration-config.json",
    ]) {
      expect(kernelStatisticWriteViolationOf(p)).not.toBeNull();
    }
  });

  it("agent 判读件（field-visual-signals / 核查件 / 决策件）→ 放行", () => {
    for (const p of [
      "/ws/experiments/e/run/data/risk-signals/bl/field-visual-signals.json",
      "/ws/datasets/ds@x/label-qc-visual-check.json",
      "/ws/datasets/ds@x/label-qc-decisions.json",
    ]) {
      expect(kernelStatisticWriteViolationOf(p)).toBeNull();
    }
  });

  it("scratch 自由面 → 放行（即使同名文件）", () => {
    expect(kernelStatisticWriteViolationOf("/ws/scratch/label-qc-report.json")).toBeNull();
    expect(kernelStatisticWriteViolationOf("/tmp/notes.json")).toBeNull();
  });
});
