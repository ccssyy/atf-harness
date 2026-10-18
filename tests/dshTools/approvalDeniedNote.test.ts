/**
 * A1.2 测试锚——approvalDeniedResult 取消措辞分支。
 *
 * 依据：核验件 47aff1bd §二①——用户点「取消」后工具 note 被写成「审批面板拦截」
 * （取消复用了审批拒绝的通用文案）。三态文案互不相同且各自含关键词；
 * error/tool/outcome 三字段逐字不动（审计链与既有断言依赖）。
 */
import { describe, expect, it } from "vitest";
import { approvalDeniedResult } from "../../packages/extensions/atf-tools/src/approvalFace.js";

describe("A1.2——approvalDeniedResult 取消措辞分支", () => {
  it("cancelled：专属文案（含「取消」，不含「审批面板」），error/tool/outcome 逐字不动", () => {
    const r = approvalDeniedResult("atf_config_confirm", "cancelled") as unknown as Record<string, string>;
    expect(r.error).toBe("approval_denied");
    expect(r.tool).toBe("atf_config_confirm");
    expect(r.outcome).toBe("cancelled");
    expect(r.note).toContain("取消");
    expect(r.note).toContain("取消≠拒绝授权");
    expect(r.note).not.toContain("审批面板");
  });

  it("unavailable：专属文案（含「未挂审批服务」）", () => {
    const r = approvalDeniedResult("atf_run_training", "unavailable") as unknown as Record<string, string>;
    expect(r.error).toBe("approval_denied");
    expect(r.outcome).toBe("unavailable");
    expect(r.note).toContain("未挂审批服务");
    expect(r.note).not.toBe(approvalDeniedResult("atf_run_training", "cancelled").note);
  });

  it("rejected／未知 outcome：回落通用文案（含「未获放行」），三支互不相同", () => {
    const rejected = approvalDeniedResult("atf_pipeline_stage", "rejected").note;
    const unknown = approvalDeniedResult("atf_pipeline_stage", "mystery").note;
    const cancelled = approvalDeniedResult("atf_pipeline_stage", "cancelled").note;
    const unavailable = approvalDeniedResult("atf_pipeline_stage", "unavailable").note;
    expect(rejected).toContain("未获放行");
    expect(rejected).toBe(unknown);
    expect(new Set([rejected, cancelled, unavailable]).size).toBe(3);
  });
});
