/** P1-8 锚:escalate 失败计数按段+doc 分键。
 * 真机实锚 11-06:failureCounts 键=会话::工具名,ci 类 experiment_setup 的失败
 * 与 bl 类互相累计——bl 首次失败即被带上「连续两次没成功」升级用户。
 * 修复=decorateOutcome 增 scope(段:doc),分键后各类各段独立计数。
 */
import { describe, expect, it } from "vitest";
import { resetToolFailureCounts, recordToolFailure, recordToolSuccess, failureCountOf } from "../../packages/extensions/atf-tools/src/receiptSummary.js";

describe("P1-8——escalate 计数分键(段+doc)", () => {
  it("ci 两次失败不影响 bl 计数(跨类不再累计)", () => {
    resetToolFailureCounts();
    expect(recordToolFailure("s1", "atf_pipeline_stage", "experiment_setup:ci")).toBe(1);
    expect(recordToolFailure("s1", "atf_pipeline_stage", "experiment_setup:ci")).toBe(2);
    expect(failureCountOf("s1", "atf_pipeline_stage", "experiment_setup:bl")).toBe(0);
    expect(recordToolFailure("s1", "atf_pipeline_stage", "experiment_setup:bl")).toBe(1);
  });
  it("同 scope 成功清零,旧 scope 不受影响", () => {
    resetToolFailureCounts();
    recordToolFailure("s2", "atf_pipeline_stage", "experiment_setup:ci");
    recordToolSuccess("s2", "atf_pipeline_stage", "experiment_setup:ci");
    expect(failureCountOf("s2", "atf_pipeline_stage", "experiment_setup:ci")).toBe(0);
    recordToolFailure("s2", "atf_pipeline_stage", "label_qc:bl");
    expect(failureCountOf("s2", "atf_pipeline_stage", "label_qc:bl")).toBe(1);
  });
  it("无 scope 兼容旧形态(键不含尾段)", () => {
    resetToolFailureCounts();
    expect(recordToolFailure("s3", "atf_evaluate")).toBe(1);
    expect(failureCountOf("s3", "atf_evaluate")).toBe(1);
  });
});
