// -*- coding: utf-8 -*-
/** D284 形态①下沉:exemptOutcomeOf 的 headless env basis 测试（env+chainTools 双确认）。 */
import { afterEach, describe, expect, it } from "vitest";
import { exemptOutcomeOf } from "../../packages/extensions/atf-tools/src/approvalExempt.js";

const ORIGINAL = process.env.ATF_HEADLESS_PRESET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ATF_HEADLESS_PRESET;
  else process.env.ATF_HEADLESS_PRESET = ORIGINAL;
});

describe("exemptOutcomeOf headless env basis(D284)", () => {
  const policy = { preset: "atf-training", chainTools: ["atf_pipeline_stage", "atf_create_experiment"] };

  it("env 开关+chainTools 命中 → allowed-once(basis unattended,ctx 缺席也放行)", () => {
    process.env.ATF_HEADLESS_PRESET = "atf-unattended";
    const hit = exemptOutcomeOf({ toolName: "atf_create_experiment" }, { policy });
    expect(hit).toEqual({ outcome: "allowed-once", basis: "unattended" });
  });

  it("env 开关但工具不在 chainTools → null(清单外照旧 fail-closed)", () => {
    process.env.ATF_HEADLESS_PRESET = "atf-unattended";
    expect(exemptOutcomeOf({ toolName: "atf_run_training" }, { policy })).toBeNull();
  });

  it("无 env 开关 → 不走本 basis(既有语义零变化)", () => {
    delete process.env.ATF_HEADLESS_PRESET;
    expect(exemptOutcomeOf({ toolName: "atf_create_experiment" }, { policy })).toBeNull();
  });

  it("env 值不符 → 不走本 basis", () => {
    process.env.ATF_HEADLESS_PRESET = "atf-training";
    expect(exemptOutcomeOf({ toolName: "atf_create_experiment" }, { policy })).toBeNull();
  });
});
