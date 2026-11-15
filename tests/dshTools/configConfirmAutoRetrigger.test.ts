// @Time   : 2026/11/15
// @Author : SamChen
// @File   : configConfirmAutoRetrigger.test.ts
// 编排硬化三期批 1a 组件锚(verdict 偏差清偿):确认落账自动重触发 training_prep 的行为合同。
// 锚面:未装配 skipped(两条改法,真调)+映射函数 trainingPrepAutoOf 三态(成功/失败带因/纯测)。
import { describe, expect, it } from "vitest";
import { autoRetriggerTrainingPrep, trainingPrepAutoOf } from "../../packages/extensions/atf-tools/src/confirmFace.js";

const ctx = { get: (_service: string) => undefined };

describe("批1-1a 确认落账自动重触发 training_prep(组件锚)", () => {
  it("pipeline 未装配:skipped 且两条改法(报错即修复指令)", async () => {
    const result = await autoRetriggerTrainingPrep(
      { runsRoot: "/tmp", ctx }, undefined as never, {} as never, "run-x", undefined,
    );
    expect("skipped" in result && result.skipped).toBeTruthy();
    const note = (result as { skipped: string }).skipped;
    expect(note).toContain("改法一");
    expect(note).toContain("改法二");
    expect(note).toContain("快照已落盘");
  });

  it("映射:段成功 ok=true 确认值进启动件", () => {
    const r = trainingPrepAutoOf({ ok: true });
    expect(r.ok).toBe(true);
    expect(r.note).toContain("iteration-config");
  });

  it("映射:段失败 ok=false 不遮蔽确认+显式重调指引+失败原因透传", () => {
    const r = trainingPrepAutoOf({ ok: false, note: "upstream_missing:label_qc" });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("快照已落盘");
    expect(r.note).toContain("atf_pipeline_stage");
    expect(r.note).toContain("upstream_missing");
  });

  it("映射:无 note 的失败体以 JSON 快照呈现原因(不静默)", () => {
    const r = trainingPrepAutoOf({ ok: false, error: "stage_blocked" });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("stage_blocked");
  });
});
