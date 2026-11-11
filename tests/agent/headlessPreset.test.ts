// -*- coding: utf-8 -*-
/** D284 形态①+开关:buildHeadlessApproval 三形态测试(缺省不变/自动 granted/未知值拒)。 */
import { describe, expect, it } from "vitest";
import { ATF_HEADLESS_UNATTENDED_PRESET, buildHeadlessApproval } from "../../src/agent/cli.js";

describe("buildHeadlessApproval(D284 形态①+开关)", () => {
  it("未设 env → headless(现行为零变化,exit 78 fail-closed 语义保留)", () => {
    const approval = buildHeadlessApproval("headless", undefined, {});
    expect(approval).toEqual({ kind: "headless" });
  });

  it("interactive 模式优先于 env 开关(交互卡语义不被开关覆盖)", () => {
    const approval = buildHeadlessApproval("interactive", 1234, { ATF_HEADLESS_PRESET: ATF_HEADLESS_UNATTENDED_PRESET });
    expect(approval).toEqual({ kind: "interactive", timeoutMs: 1234 });
  });

  it(`env=${ATF_HEADLESS_UNATTENDED_PRESET} → 自动 granted surface(D90 全自动档语义)`, async () => {
    const approval = buildHeadlessApproval("headless", undefined, { ATF_HEADLESS_PRESET: ATF_HEADLESS_UNATTENDED_PRESET });
    expect(approval.kind).toBe("surface");
    if (approval.kind !== "surface") return;
    const verdict = await approval.surface.ask({ tool: "atf_admit_data", params_digest: "d", audit_key: "k" });
    expect(verdict).toEqual({ kind: "granted" });
  });

  it("未知值 → 显式拒绝按 headless(防拼写错误静默获得免审面)", () => {
    const approval = buildHeadlessApproval("headless", undefined, { ATF_HEADLESS_PRESET: "atf-traning" });
    expect(approval).toEqual({ kind: "headless" });
  });
});
