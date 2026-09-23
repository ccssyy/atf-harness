/**
 * 修复批 3（2026-09-23）：compaction 切点对齐测试（指令 §三.1）——
 * 长会话 fixture 中配对（tool/call↔tool/result、approval/request↔response）恰好横跨
 * CHUNK 折叠边界 → 对齐后投影消息序合法（无孤儿闭合半边），且全链路可编码（adapter →
 * 两协议 codec 逐级验收，等价「mock provider 接受」）；审计 payload 携带切点对齐结果
 * （boundary_before/after、reason_aligned）；事件数触发门缺省 512＋进程级可配。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACTION_CHUNK,
  COMPACTION_KEEP_RECENT,
  COMPACTION_TRIGGER_TOKENS,
  buildCompactionRecord,
  materialOf,
  planCompaction,
  projectContext,
  setCompactionTriggerEvents,
  type SessionEvent,
} from "../../src/core/session/index.js";
import { adaptProjectionToMessages } from "../../src/llm/index.js";
import { anthropicMessagesCodec, openaiChatCodec } from "../../src/llm/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const DIGEST_A = "a".repeat(64);
const TOOLS: ModelVisibleTool[] = [{ name: "atf_scratch_exec", description: "d", parameters: { type: "object", required: [], properties: {} } }];

let seq = 0;
const ev = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id: ++seq,
  ts: "2026-09-23T00:00:00.000Z",
  type,
  payload,
  projection: { evidence_event: null },
  ...extra,
});

beforeEach(() => {
  seq = 0;
  // 事件数门注入 128：构造跨界的最小长会话（缺省常量 512 的语义另测）
  setCompactionTriggerEvents(128);
});

afterEach(() => {
  setCompactionTriggerEvents(null);
});

/** 130 条会话：位置 95/96 为一对（type 由调用方定）——raw CHUNK 边界 96 恰切在配对中间。 */
const straddlingSession = (makeCall: () => SessionEvent[], makeResult: () => SessionEvent): SessionEvent[] => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 95; i += 1) events.push(ev("user/message", { text: `前段 ${String(i)}` }));
  events.push(...makeCall()); // 位置 95（raw boundary 96 的前半边）
  events.push(makeResult()); // 位置 96（raw boundary 的保留侧 = 孤儿闭合半边）
  for (let i = 0; i < 33; i += 1) events.push(ev("user/message", { text: `后段 ${String(i)}` })); // 共 130
  return events;
};

const usableOf = (events: SessionEvent[]): number => materialOf(events).length - COMPACTION_KEEP_RECENT;
const rawBoundaryOf = (events: SessionEvent[]): number => Math.floor(usableOf(events) / COMPACTION_CHUNK) * COMPACTION_CHUNK;

describe("切点对齐：配对横跨 CHUNK 边界 → boundary 前移，投影消息序合法", () => {
  it("tool/call↔tool/result 横跨边界（重跑① event 164 同型）→ aligned＋全链路两协议编码通过", () => {
    const events = straddlingSession(
      () => [ev("tool/call", { tool: "atf_scratch_exec", params: {} })],
      () => ev("tool/result", { tool: "atf_scratch_exec", ok: true, result: { exit_code: 0 } }),
    );
    expect(rawBoundaryOf(events)).toBe(96); // 原始边界恰切在 95/96 之间

    const plan = planCompaction(events);
    expect(plan.triggered).toBe(true);
    expect(plan.boundary_before).toBe(96);
    expect(plan.aligned).toBe(true);
    expect(plan.boundary).toBe(95); // 前移到配对起点：call/result 双双保留

    // 全链路（§三.1「可继续收发」的 fixture 级等价）：投影 → adapter → 两协议 codec 均接受
    const projected = projectContext(events);
    const messages = adaptProjectionToMessages(projected, { toolResultSummaryCapChars: 6_000 });
    expect(messages.ok).toBe(true);
    if (!messages.ok) return;
    const openai = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: messages.value,
      tools: TOOLS,
      reasoningEffort: "low",
      developerRole: false,
      maxTokens: 4096,
    });
    expect(openai.ok, openai.ok ? "" : openai.error.message).toBe(true);
    const anthropic = anthropicMessagesCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: messages.value,
      tools: TOOLS,
      reasoningEffort: null,
      developerRole: false,
      maxTokens: 4096,
    });
    expect(anthropic.ok, anthropic.ok ? "" : anthropic.error.message).toBe(true);

    // 审计 payload 携带切点对齐结果（§二.3）
    const record = buildCompactionRecord(materialOf(events), plan);
    expect(record.boundary_before).toBe(96);
    expect(record.boundary_after).toBe(95);
    expect(record.reason_aligned).toBe("pair_alignment");
    const view = projectContext(events);
    const summary = view[0]?.payload as { boundary_before?: number; reason_aligned?: string };
    expect(summary.boundary_before).toBe(96);
    expect(summary.reason_aligned).toBe("pair_alignment");
  });

  it("approval/request↔response 横跨边界（走查 @160/162 同型）→ aligned＋投影无孤儿", () => {
    const events = straddlingSession(
      () => [ev("approval/request", { tool_call_id: "c-1", params: {}, approval_key: "k", attempt: 1 })],
      () => ev("approval/response", { request_event_ref: 96, verdict: "granted", actor: "tui-operator" }),
    );
    expect(rawBoundaryOf(events)).toBe(96);
    const plan = planCompaction(events);
    expect(plan.aligned).toBe(true);
    expect(plan.boundary).toBe(95);

    const projected = projectContext(events);
    const messages = adaptProjectionToMessages(projected, { toolResultSummaryCapChars: 6_000 });
    expect(messages.ok).toBe(true);
    if (!messages.ok) return;
    const openai = openaiChatCodec.encodeRequestBody({
      model: "m",
      system: "S",
      messages: messages.value,
      tools: TOOLS,
      reasoningEffort: null,
      developerRole: false,
      maxTokens: 4096,
    });
    expect(openai.ok, openai.ok ? "" : openai.error.message).toBe(true);
  });

  it("无配对会话：aligned=false（对齐零扰动，原 CHUNK 语义不变）", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 130; i += 1) events.push(ev("user/message", { text: `消息 ${String(i)}` }));
    const plan = planCompaction(events);
    expect(plan.boundary_before).toBe(96);
    expect(plan.boundary).toBe(96);
    expect(plan.aligned).toBe(false);
    const record = buildCompactionRecord(materialOf(events), plan);
    expect(record.reason_aligned).toBe("none");
    expect(record.boundary_after).toBe(96);
  });

  it("承证白名单语义不变：跨界且承证的配对仍原文保留（kept_ids 豁免零回归）", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 95; i += 1) events.push(ev("user/message", { text: `前段 ${String(i)}` }));
    events.push(ev("tool/call", { tool: "atf_admit_data", params: {} })); // 位置 95
    events.push(
      ev("tool/result", { tool: "atf_admit_data", ok: true }, {
        domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A }],
      }), // 位置 96——raw 边界恰在其前（保留侧）+ 白名单豁免
    );
    for (let i = 0; i < 33; i += 1) events.push(ev("user/message", { seq: 500 + i }));
    const plan = planCompaction(events);
    // 白名单本就把 result 及其配对 call 留在投影——无需对齐（aligned=false）且原文双保留
    expect(plan.aligned).toBe(false);
    expect(plan.boundary).toBe(96);
    expect(plan.keptPositions.has(95)).toBe(true);
    expect(plan.keptPositions.has(96)).toBe(true);
  });
});

describe("事件数触发门：缺省 512＋进程级可配（指令 §二.2）", () => {
  afterEach(() => {
    setCompactionTriggerEvents(null);
  });

  it("缺省（null → 常量 512）：256 条不触发；512 条触发且 reason=event_count", () => {
    setCompactionTriggerEvents(null); // 文件级 beforeEach 注入 128 供配对 fixture——本用例归零走常量缺省
    const mk = (n: number): SessionEvent[] => Array.from({ length: n }, (_, i) => ev("user/message", { text: `消息 ${String(i)}` }));
    const small = mk(256);
    const planSmall = planCompaction(small);
    expect(planSmall.triggered).toBe(false);
    expect(planSmall.boundary).toBe(0);
    const plan = planCompaction(mk(512));
    expect(plan.triggered).toBe(true);
    expect(plan.trigger.reason).toBe("event_count");
    expect(plan.boundary_before).toBe(480); // usable=480 → CHUNK 粒度 480
  });

  it("holder 注入投影径与审计径同源（SessionLog 审计随 holder 走）", () => {
    setCompactionTriggerEvents(64);
    const events: SessionEvent[] = [];
    for (let i = 0; i < 96; i += 1) events.push(ev("user/message", { text: `消息 ${String(i)}` }));
    const plan = planCompaction(events, COMPACTION_TRIGGER_TOKENS);
    expect(plan.triggered).toBe(true); // 96 ≥ 64
    expect(plan.trigger.reason).toBe("event_count");
  });
});
