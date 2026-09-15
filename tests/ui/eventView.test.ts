/**
 * TUI 事件行格式化单测（T02）：行 = SessionEvent 本体的纯展示推导（VERIFY 项 2 呈现侧）——
 * `#id` 前缀与日志逐条对应；history 标记；tool/result ok/非 ok、审批 verdict/advice、
 * 长文本截断。脱敏：仅格式化既有 payload，不新增来源。
 */
import { describe, expect, it } from "vitest";
import { formatEventLine } from "../../src/ui/eventView.js";
import type { SessionEvent } from "../../src/core/session/index.js";

let nextId = 1;
const ev = (type: SessionEvent["type"], payload: unknown, domainRefs?: unknown): SessionEvent =>
  ({
    id: nextId++,
    type,
    ts: "2026-09-15T00:00:00.000Z",
    payload,
    ...(domainRefs !== undefined ? { domain_refs: domainRefs } : {}),
  }) as unknown as SessionEvent;

describe("formatEventLine（T02）", () => {
  it("id 前缀补零 + history 标记", () => {
    const line = formatEventLine(ev("turn/start", { scenario_id: "s", branch_id: "b" }), "history");
    expect(line).toMatch(/^#000\d+ \[历史\] turn\/start/);
    expect(line).toContain("scenario=s branch=b");
  });

  it("tool/call 与 tool/result(ok=true) 行形态（smoke:l1ui 断言依赖）", () => {
    const call = formatEventLine(ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-x" } }), "live");
    expect(call).toContain("tool/call");
    expect(call).toContain("atf_admit_data");
    expect(call).toContain('"dataset_id":"ds-x"');

    const ok = formatEventLine(ev("tool/result", { tool: "atf_admit_data", ok: true, result: { ok: true, journal_type: "dataset", fact_id: "f1", sha256_digest: "a".repeat(64) }, call_ref: 3 }), "live");
    expect(ok).toContain("ok=true");
    expect(ok).toContain("atf_admit_data");
    expect(ok).toContain("fact_id");

    const blocked = formatEventLine(ev("tool/result", { tool: "atf_admit_data", ok: false, reason: "approval_denied", call_ref: 3, block: { reason: "approval_denied", message: "拒绝" } }), "live");
    expect(blocked).toContain("ok=false");
    expect(blocked).toContain("approval_denied");
  });

  it("approval/response：verdict/actor/备注（reason 与 advice_text 两形态）", () => {
    const granted = formatEventLine(ev("approval/response", { verdict: "granted", actor: "tui-operator", reason: "同意" }), "live");
    expect(granted).toContain("verdict=granted actor=tui-operator 备注=同意");
    const advised = formatEventLine(ev("approval/response", { verdict: "advised", actor: "tui-operator", advice_text: "先改参数" }), "live");
    expect(advised).toContain("verdict=advised");
    expect(advised).toContain("备注=先改参数");
  });

  it("长文本截断且压成单行（日志本体不受影响）", () => {
    const long = `很长文本 ${"字".repeat(300)}\n换行也要压平`;
    const line = formatEventLine(ev("assistant/message", { text: long }), "live");
    expect(line).not.toContain("\n");
    expect(line).toContain("…(截断)");
    expect(line.length).toBeLessThan(300);
  });

  it("turn/end 收口形态（reason + stop_reason）", () => {
    const line = formatEventLine(ev("turn/end", { reason: "completed", stop_reason: "final_answer", step_count: 2, decision_count: 2 }), "live");
    expect(line).toContain("reason=completed stop_reason=final_answer");
  });
});
