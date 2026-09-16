/**
 * L1a 门 2——通道纯函数测试（任务书 §1.3；list pending / submit answer / CLI 参数面 / 流解析）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAnswerPayload,
  listPendingApprovals,
  parseResumeArgs,
  parseSessionStream,
  resolveAnswerTarget,
} from "../../src/core/run/index.js";
import type { SessionEvent } from "../../src/core/session/index.js";

let seq = 0;
const ev = (type: SessionEvent["type"], payload: unknown): SessionEvent => {
  seq += 1;
  return { id: seq, ts: "2026-09-14T00:00:00Z", type, payload, projection: { evidence_event: null } };
};
const resetSeq = (): void => {
  seq = 0;
};

beforeEach(() => {
  resetSeq();
});

describe("listPendingApprovals", () => {
  it("无应答请求 → 待办（unanswered）", () => {
    const pending = listPendingApprovals([
      ev("turn/start", {}),
      ev("tool/call", { tool: "atf_admit_data", params: {} }),
      ev("approval/request", { approval_session_id: "aps-1", tool: "atf_admit_data", params: {}, approval_key: "k1", attempt: 1, tool_call_id: 2 }),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("unanswered");
    expect(pending[0]?.approval_key).toBe("k1");
  });

  it("仅 timeout 应答 → 仍待人工（超时非否决）", () => {
    const pending = listPendingApprovals([
      ev("approval/request", { approval_session_id: "aps-1", tool: "t", params: {}, approval_key: "k1", attempt: 1, tool_call_id: 1 }),
      ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 1, verdict: "timeout", actor: "harness" }),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("timeout_awaiting_human");
  });

  it("denied/granted 应答 → 不再待办", () => {
    const pending = listPendingApprovals([
      ev("approval/request", { approval_session_id: "aps-1", tool: "t", params: {}, approval_key: "k1", attempt: 1, tool_call_id: 1 }),
      ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 1, verdict: "denied", actor: "cli-operator", reason: "未备案" }),
    ]);
    expect(pending).toHaveLength(0);
  });

  it("同会话多候选 → 仅最新候选为待办（更早者视为已被替代）", () => {
    resetSeq();
    const pending = listPendingApprovals([
      ev("approval/request", { approval_session_id: "aps-1", tool: "t", params: {}, approval_key: "k1", attempt: 1, tool_call_id: 1 }),
      ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 1, verdict: "advised", actor: "cli-operator", advice_text: "改编号" }),
      // advised 后模型重提（attempt 2，无应答）
      ev("approval/request", { approval_session_id: "aps-1", tool: "t", params: {}, approval_key: "k1", attempt: 2, tool_call_id: 2, supersedes: 1 }),
    ]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempt).toBe(2);
    expect(pending[0]?.request_event_id).toBe(3);
  });
});

describe("resolveAnswerTarget", () => {
  const pending = [
    { request_event_id: 5, approval_session_id: "aps-1", tool: "t", params: {}, approval_key: "k", attempt: 1, tool_call_id: 2, status: "unanswered" as const },
    { request_event_id: 9, approval_session_id: "aps-2", tool: "t", params: {}, approval_key: "k2", attempt: 1, tool_call_id: 3, status: "timeout_awaiting_human" as const },
  ];

  it("无待办 → no_pending", () => {
    expect(resolveAnswerTarget([], undefined).ok).toBe(false);
    const result = resolveAnswerTarget([], undefined);
    if (!result.ok) expect(result.error.code).toBe("no_pending");
  });

  it("多待办缺省 → ambiguous（fail-closed）", () => {
    const result = resolveAnswerTarget(pending, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ambiguous");
  });

  it("显式 id 不在待办 → not_pending（已答/被替代/不存在）", () => {
    const result = resolveAnswerTarget(pending, 6);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_pending");
  });

  it("恰一个待办可缺省；显式 id 命中", () => {
    expect(resolveAnswerTarget([pending[0] as never], undefined).ok).toBe(true);
    const hit = resolveAnswerTarget(pending, 9);
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value.request_event_id).toBe(9);
  });
});

describe("buildAnswerPayload（复用 approval/response 字段闭集）", () => {
  const target = { request_event_id: 5, approval_session_id: "aps-1", tool: "atf_admit_data", params: {}, approval_key: "k", attempt: 1, tool_call_id: 2, status: "unanswered" as const };

  it("granted + note → verdict granted / actor cli-operator / reason", () => {
    expect(buildAnswerPayload(target, "granted", "同意")).toEqual({
      approval_session_id: "aps-1",
      request_event_ref: 5,
      verdict: "granted",
      actor: "cli-operator",
      reason: "同意",
    });
  });

  it("abort → 问答轨 verdict aborted；advised → advice_text 承载建议", () => {
    expect(buildAnswerPayload(target, "abort", "取消")).toMatchObject({ verdict: "aborted", reason: "取消" });
    expect(buildAnswerPayload(target, "advised", "改编号重提")).toMatchObject({ verdict: "advised", advice_text: "改编号重提" });
    expect(buildAnswerPayload(target, "denied")).toEqual({
      approval_session_id: "aps-1",
      request_event_ref: 5,
      verdict: "denied",
      actor: "cli-operator",
    });
  });
});

describe("parseResumeArgs（CLI 参数面 fail-closed）", () => {
  it("list 合法", () => {
    const parsed = parseResumeArgs(["--list", "--runs-root", "/tmp/r", "--run-id", "run-1"]);
    expect(parsed.ok && parsed.value.mode).toBe("list");
  });

  it("answer 非法值拒绝；未知参数拒绝；缺 scenario-id 拒绝", () => {
    expect(parseResumeArgs(["--answer", "maybe", "--runs-root", "/r", "--run-id", "x", "--scenario-id", "s"]).ok).toBe(false);
    expect(parseResumeArgs(["--list", "--oops"], ).ok).toBe(false);
    expect(parseResumeArgs(["--answer", "granted", "--runs-root", "/r", "--run-id", "x"]).ok).toBe(false);
  });

  it("answer 完整形态（含 note/request/mock）", () => {
    const parsed = parseResumeArgs(["--answer", "denied", "--note", "未备案", "--request", "12", "--runs-root", "/r", "--run-id", "run-1", "--scenario-id", "s1", "--mock", "/m.mjs"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.verdict).toBe("denied");
    expect(parsed.value.note).toBe("未备案");
    expect(parsed.value.requestEventId).toBe(12);
  });
});

describe("parseSessionStream（resume 前置流读取 fail-closed）", () => {
  it("合法流解析；坏 JSON 行拒绝；id 断裂拒绝", () => {
    const good = `${JSON.stringify({ id: 1, ts: "2026-09-14T00:00:00Z", type: "turn/start", payload: {}, projection: { evidence_event: null } })}\n`;
    const parsed = parseSessionStream(good);
    expect(parsed.ok).toBe(true);
    expect(parseSessionStream("非法行\n").ok).toBe(false);
    const gap = `${good}${JSON.stringify({ id: 5, ts: "2026-09-14T00:00:01Z", type: "turn/end", payload: {}, projection: { evidence_event: null } })}\n`;
    expect(parseSessionStream(gap).ok).toBe(false);
  });
});
