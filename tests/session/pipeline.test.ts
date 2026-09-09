import { describe, expect, it } from "vitest";
import { convertToLlm, transformContext, type LlmContextEvent } from "../../src/session/pipeline.js";
import type { SessionEvent } from "../../src/session/schema.js";

/**
 * S2 验收用例 3——白名单（含 UI-only 字段的事件在 convertToLlm 输出中不出现该字段）
 * + transformContext 过滤 assistant/attempt（任务书 S2-3 双管道占位）。
 */

const baseEvent = (overrides: Partial<SessionEvent> & { type: SessionEvent["type"] }): SessionEvent => ({
  id: 1,
  ts: "2026-09-09T00:00:00.000Z",
  payload: {},
  projection: { evidence_event: null },
  ...overrides,
});

describe("S2 验收用例 3——convertToLlm 白名单投影（UI-only 字段不出现）", () => {
  it("ui / projection / ref_invalid 一律不进入输出；输出键集 = { id, ts, type, payload, domain_refs? }", () => {
    const event = baseEvent({
      type: "tool/result",
      payload: { ok: true },
      ui: { hint: "只给界面看的提示", collapsed: true },
      domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) }],
      ref_invalid: [{ index: 0, journal_type: "run_journal", fact_id: "fact-1", claimed_digest: "a".repeat(64), cause: "digest_mismatch" }],
    });

    const projected = convertToLlm(event);
    expect(Object.keys(projected).sort()).toEqual(["domain_refs", "id", "payload", "ts", "type"]);
    expect(JSON.stringify(projected)).not.toContain("hint"); // UI-only 字段内容级不泄漏
    expect(JSON.stringify(projected)).not.toContain("digest_mismatch");
    expect(projected.domain_refs).toEqual(event.domain_refs); // 引用字段保留（ADR-06：引用不可丢弃）
  });

  it("无 domain_refs 的事件输出不含 domain_refs 键", () => {
    const projected = convertToLlm(baseEvent({ type: "user/message", payload: { text: "hi" }, ui: { channel: "cli" } }));
    expect(Object.keys(projected).sort()).toEqual(["id", "payload", "ts", "type"]);
    expect(projected.payload).toEqual({ text: "hi" });
  });

  it("projection 字段位恒 null 也不发给模型（内部字段不发模型）", () => {
    const projected = convertToLlm(baseEvent({ type: "turn/start", payload: {} }));
    expect("projection" in projected).toBe(false);
  });
});

describe("transformContext——拼接 + 过滤 assistant/attempt（签名定死，逻辑 Phase 2 再长）", () => {
  it("attempt 被过滤，其余类型按原顺序保留", () => {
    const events: SessionEvent[] = [
      baseEvent({ id: 1, type: "turn/start", payload: {} }),
      baseEvent({ id: 2, type: "user/message", payload: { text: "q" } }),
      baseEvent({ id: 3, type: "assistant/attempt", payload: { error: "boom" }, ui: { suppressed: true } }),
      baseEvent({ id: 4, type: "assistant/message", payload: { text: "a" } }),
      baseEvent({ id: 5, type: "turn/end", payload: {} }),
    ];

    const context = transformContext(events);
    expect(context.map((item) => item.id)).toEqual([1, 2, 4, 5]);
    expect(context.every((item: LlmContextEvent) => item.type !== "assistant/attempt")).toBe(true);
    // 输出同样经白名单投影
    expect(Object.keys(context[1] as LlmContextEvent).sort()).toEqual(["id", "payload", "ts", "type"]);
  });

  it("空输入 → 空上下文；全 attempt 输入 → 空上下文", () => {
    expect(transformContext([])).toEqual([]);
    const onlyAttempts = [baseEvent({ id: 1, type: "assistant/attempt", payload: {} })];
    expect(transformContext(onlyAttempts)).toEqual([]);
  });
});
