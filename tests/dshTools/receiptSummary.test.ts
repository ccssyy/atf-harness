/**
 * F6-a/F6-b 单测锚：用户面三句话摘要（user_summary）＋连续失败升级（escalate_to_user）
 * ＋会话可见通知投影（L 面 deferContext 形态）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ATF_NOTICE_KIND,
  decorateOutcome,
  escalationOf,
  failureCountOf,
  projectUserNotice,
  receiptIsFailure,
  recordToolFailure,
  recordToolSuccess,
  resetToolFailureCounts,
  suggestUserSummary,
  userNoticeOf,
  withUserSummary,
} from "../../packages/extensions/atf-tools/src/receiptSummary.js";

const SUMMARY = { conclusion: "评估已启动", stage: "评估编排后台执行中", next: "用 status 查进度" };

describe("F6 receiptSummary：user_summary 与连续失败升级", () => {
  beforeEach(() => { resetToolFailureCounts(); });

  it("withUserSummary：只增 user_summary 键，原回执键逐字保留", () => {
    const receipt = { started: true, run_id: "r1" };
    const decorated = withUserSummary(receipt, SUMMARY);
    expect(decorated.user_summary).toEqual(SUMMARY);
    expect(decorated.run_id).toBe("r1");
    expect(decorated.started).toBe(true);
    expect(Object.keys(receipt)).toEqual(["started", "run_id"]); // 原对象不变
  });

  it("连续失败：第 1 次不升级，第 2 次升级；成功即清零", () => {
    expect(escalationOf(1)).toBeNull();
    expect(recordToolFailure("s1", "atf_evaluate")).toBe(1);
    expect(escalationOf(1)).toBeNull();
    expect(recordToolFailure("s1", "atf_evaluate")).toBe(2);
    expect(escalationOf(2)).toEqual({ escalate_to_user: true, failure_count: 2 });
    expect(failureCountOf("s1", "atf_evaluate")).toBe(2);
    recordToolSuccess("s1", "atf_evaluate");
    expect(failureCountOf("s1", "atf_evaluate")).toBe(0);
    expect(recordToolFailure("s1", "atf_evaluate")).toBe(1); // 清零后重新计
  });

  it("计数按会话隔离：别的会话失败不叠加；无会话身份独立一档", () => {
    expect(recordToolFailure("s1", "atf_evaluate")).toBe(1);
    expect(recordToolFailure("s2", "atf_evaluate")).toBe(1);
    expect(recordToolFailure(null, "atf_evaluate")).toBe(1);
    expect(recordToolFailure("s1", "atf_evaluate")).toBe(2);
    expect(failureCountOf("s2", "atf_evaluate")).toBe(1);
    expect(failureCountOf(null, "atf_evaluate")).toBe(1);
  });

  it("decorateOutcome：失败两次的回执带 escalate_to_user＋failure_count，成功回执只带摘要", () => {
    const first = decorateOutcome({ started: false, error: "x" }, "s1", "atf_evaluate", false, SUMMARY);
    expect(first.user_summary).toEqual(SUMMARY);
    expect(first.escalate_to_user).toBeUndefined();
    const second = decorateOutcome({ started: false, error: "x" }, "s1", "atf_evaluate", false, SUMMARY);
    expect(second.escalate_to_user).toBe(true);
    expect(second.failure_count).toBe(2);
    const ok = decorateOutcome({ started: true }, "s1", "atf_evaluate", true, SUMMARY);
    expect(ok.user_summary).toEqual(SUMMARY);
    expect(ok.escalate_to_user).toBeUndefined();
  });

  it("receiptIsFailure：ok=false／started=false／带 error 键均判失败", () => {
    expect(receiptIsFailure({ ok: false })).toBe(true);
    expect(receiptIsFailure({ started: false })).toBe(true);
    expect(receiptIsFailure({ error: "eval_template_drift" })).toBe(true);
    expect(receiptIsFailure({ started: true, run_id: "r1" })).toBe(false);
  });

  it("suggestUserSummary：成功/失败都给三句（失败带补充，无内部码）", () => {
    const ok = suggestUserSummary("atf_evaluate", true);
    expect(ok.conclusion).toContain("atf_evaluate");
    expect(ok.stage).toBe("已执行完成");
    const bad = suggestUserSummary("atf_evaluate", false, "缺少适配器路径");
    expect(bad.conclusion).toContain("缺少适配器路径");
    expect(bad.next).toContain("重试");
  });
});

describe("F6 L 面：会话可见通知投影（deferContext）", () => {
  it("userNoticeOf：form=notice 的 user/message（summary 收起态取结论一句）", () => {
    const notice = userNoticeOf(SUMMARY, { id: "n1" });
    expect(notice.id).toBe("n1");
    expect(notice.role).toBe("user");
    expect(notice.source.kind).toBe(ATF_NOTICE_KIND);
    expect(notice.source.form).toBe("notice");
    expect(notice.source.summary).toBe(SUMMARY.conclusion);
    const body = notice.content[0]?.text ?? "";
    expect(body).toContain(SUMMARY.conclusion);
    expect(body).toContain(SUMMARY.next);
  });

  it("userNoticeOf：summary 超长截断到 120 字（vendor 契约同界）", () => {
    const long = userNoticeOf({ ...SUMMARY, conclusion: "很".repeat(200) }, { id: "n2" });
    expect(long.source.summary.length).toBe(120);
    expect(long.source.summary.endsWith("…")).toBe(true);
  });

  it("projectUserNotice：有 deferContext 即注入；缺失或抛错＝不投影且不抛", () => {
    const seen: unknown[] = [];
    expect(projectUserNotice({ deferContext: (ctx) => { seen.push(ctx); } }, SUMMARY)).toBe(true);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { source: { form: string } }).source.form).toBe("notice");

    expect(projectUserNotice(undefined, SUMMARY)).toBe(false);
    expect(projectUserNotice({}, SUMMARY)).toBe(false);
    expect(projectUserNotice({ deferContext: () => { throw new Error("boom"); } }, SUMMARY)).toBe(false);
  });
});
