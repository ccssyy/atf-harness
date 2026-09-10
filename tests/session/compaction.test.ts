import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPACTION_CHUNK,
  COMPACTION_KEEP_RECENT,
  COMPACTION_TRIGGER_EVENTS,
  MockDigestResolver,
  SessionLog,
  computeCompactionWhitelist,
  estimateTokens,
  materialOf,
  planCompaction,
  transformContext,
  type SessionEvent,
  type SessionEventType,
} from "../../src/session/index.js";

/**
 * P2-S1 compaction 测试（任务书 §2 验收 1–3 / owner 口径 #2–#3 / ADR-09 C4/C5）：
 * 触发正反例、白名单豁免（domain_refs + 相邻因果链）、压缩事件重建（replay 后投影逐条一致）、
 * 审计事件可审计且对计划透明。
 */

const DIGEST_A = "a".repeat(64);

let seq = 0;
const ev = (
  type: SessionEventType,
  payload: unknown,
  extra: Partial<SessionEvent> = {},
): SessionEvent => ({
  id: ++seq,
  ts: "2026-09-10T00:00:00.000Z",
  type,
  payload,
  projection: { evidence_event: null },
  ...extra,
});

beforeEach(() => {
  seq = 0;
});

describe("压缩触发（双指标，先到者生效）", () => {
  it("正例：实质事件数达 128 → 触发，折叠前 96 条（保留窗 32，粒度 32）", () => {
    const events = Array.from({ length: COMPACTION_TRIGGER_EVENTS }, (_, i) => ev("user/message", { seq: i }));
    const plan = planCompaction(events);
    expect(plan.triggered).toBe(true);
    expect(plan.trigger.reason).toBe("event_count");
    expect(plan.boundary).toBe(96);

    const view = transformContext(events);
    expect(view[0]?.type).toBe("session/compaction");
    expect(view).toHaveLength(1 + (COMPACTION_TRIGGER_EVENTS - 96)); // 摘要 + 保留窗
    const summary = view[0]?.payload as { folded_count: number; covers: { from_id: number; to_id: number }; text: string };
    expect(summary.folded_count).toBe(96);
    expect(summary.covers).toEqual({ from_id: 1, to_id: 96 });
    expect(summary.text).toContain("96 条");
  });

  it("反例：未达阈值（127 条）→ 不触发，投影 = v0 语义原样（无摘要）", () => {
    const events = Array.from({ length: COMPACTION_TRIGGER_EVENTS - 1 }, (_, i) => ev("user/message", { seq: i }));
    const plan = planCompaction(events);
    expect(plan.triggered).toBe(false);
    expect(plan.boundary).toBe(0);

    const view = transformContext(events);
    expect(view).toHaveLength(COMPACTION_TRIGGER_EVENTS - 1);
    expect(view.every((item) => item.type !== "session/compaction")).toBe(true);
  });

  it("token 兜底：事件少但单条超长 → 估算 token 达标触发（reason = token_budget）", () => {
    const fat = "x".repeat(4000); // 单事件 ≈ 2000 估算 token
    const events = Array.from({ length: 70 }, (_, i) => ev("user/message", { seq: i, text: fat }));
    expect(estimateTokens(materialOf(events))).toBeGreaterThanOrEqual(24000);
    const plan = planCompaction(events);
    expect(plan.triggered).toBe(true);
    expect(plan.trigger.reason).toBe("token_budget");
    expect(plan.boundary).toBe(COMPACTION_CHUNK); // usable = 70-32 = 38 → 32
  });

  it("滞后推进：边界按 chunk 粒度跳跃（128→96，129→96，160→128），保留窗永不折叠", () => {
    const mk = (n: number): SessionEvent[] => Array.from({ length: n }, (_, i) => ev("user/message", { seq: i }));
    expect(planCompaction(mk(COMPACTION_TRIGGER_EVENTS)).boundary).toBe(96);
    expect(planCompaction(mk(COMPACTION_TRIGGER_EVENTS + 1)).boundary).toBe(96);
    expect(planCompaction(mk(160)).boundary).toBe(128);
    // 保留窗：任何事件都至少在最近 KEEP_RECENT 条之外才可能被折叠
    expect(planCompaction(mk(COMPACTION_KEEP_RECENT)).boundary).toBe(0);
  });
});

describe("承证白名单（domain_refs + 相邻因果链永不折叠）", () => {
  it("折叠区间内的 tool/result(带 domain_refs) 及其配对 tool/call 原文保留，其余折叠", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 10; i += 1) events.push(ev("user/message", { seq: i }));
    events.push(ev("tool/call", { tool: "atf_admit_data", params: {} })); // 位置 10
    events.push(
      ev("tool/result", { tool: "atf_admit_data", ok: true }, {
        domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A }],
      }), // 位置 11
    );
    for (let i = 0; i < 118; i += 1) events.push(ev("user/message", { seq: 100 + i })); // 共 130 条

    const keep = computeCompactionWhitelist(events);
    expect(keep.has(10)).toBe(true);
    expect(keep.has(11)).toBe(true);

    const plan = planCompaction(events); // usable = 98 → boundary 96
    expect(plan.boundary).toBe(96);
    expect(plan.foldedCount).toBe(94); // 96 - 2 条白名单豁免

    const view = transformContext(events);
    const summary = view[0]?.payload as { kept_ids: number[] };
    expect(summary.kept_ids).toEqual([11, 12]); // 位置 10/11 的事件 id（id 从 1 起连续）
    // 豁免原文以原始形态出现在摘要之后
    const keptInView = view.filter((item) => item.id === 11 || item.id === 12);
    expect(keptInView).toHaveLength(2);
    expect(keptInView[0]?.type).toBe("tool/call");
    expect(keptInView[1]?.type).toBe("tool/result");
    expect(keptInView[1]?.domain_refs).toEqual(events[11]?.domain_refs); // 引用字段不可丢弃（ADR-06 细则 2）
  });

  it("保留窗内的事件不折叠（含白名单事件的因果链跨入保留窗的情形）", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 120; i += 1) events.push(ev("user/message", { seq: i }));
    events.push(ev("tool/call", { tool: "t", params: {} }));
    events.push(
      ev("tool/result", { tool: "t", ok: true }, {
        domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A }],
      }),
    ); // 位置 120/121，落在保留窗（130-32=98 之后）——本就不折叠
    for (let i = 0; i < 8; i += 1) events.push(ev("user/message", { seq: 200 + i })); // 共 130
    const plan = planCompaction(events);
    expect(plan.boundary).toBe(96); // 位置 120/121 本就在边界之外（保留窗/尾部），不折叠
    expect(plan.keptPositions.has(121)).toBe(true); // 承证事件命中白名单（因果链配对）
    const view = transformContext(events);
    expect(view.some((item) => item.id === 122)).toBe(true); // 承证事件原文在投影中
  });

  it("投影 id 语义（S1a P1-2）：anchor 命中白名单时，摘要(synthetic)与原文并存且按 (id, synthetic) 唯一识别", () => {
    const events: SessionEvent[] = [];
    for (let i = 0; i < 95; i += 1) events.push(ev("user/message", { seq: i }));
    events.push(ev("tool/call", { tool: "anchor", params: {} })); // 位置 95（id 96）
    events.push(
      ev("tool/result", { tool: "anchor", ok: true }, {
        domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A }],
      }),
    ); // 位置 96（id 97）
    for (let i = 0; i < 33; i += 1) events.push(ev("user/message", { seq: 500 + i })); // 共 130
    const plan = planCompaction(events);
    expect(plan.boundary).toBe(96);
    expect(plan.keptPositions.has(95)).toBe(true); // anchor（配对豁免）在折叠区间内

    const view = transformContext(events);
    const sameId = view.filter((item) => item.id === 96);
    expect(sameId).toHaveLength(2); // 摘要条目 + 白名单豁免原文并存
    expect(sameId[0]?.synthetic).toBe(true); // 摘要 = 投影合成物
    expect(sameId[0]?.type).toBe("session/compaction");
    expect(sameId[1]?.synthetic).toBeUndefined(); // 原文条目不携带该键
    expect(sameId[1]?.type).toBe("tool/call"); // anchor 原文 = 白名单豁免的配对 tool/call

    // 全投影 (id, synthetic) 组合唯一——按 id 消费投影无歧义
    const seen = new Set<string>();
    for (const item of view) {
      const key = `${String(item.id)}|${item.synthetic === true ? "S" : "O"}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("压缩审计与重建一致（端到端：SessionLog 落盘 → replay → 投影逐条一致）", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atf-compact-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("160 条混合事件：审计事件按边界落盘、判重、投影一致且幂等", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
    ]);
    const logPath = join(workDir, "session.jsonl");
    const created = await SessionLog.create(logPath, resolver);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const log = created.value;

    const written: SessionEvent[] = [];
    const push = async (input: Parameters<SessionLog["append"]>[0]): Promise<void> => {
      const appended = await log.append(input);
      expect(appended.ok).toBe(true);
      if (appended.ok) written.push(appended.value.event);
    };

    await push({ type: "turn/start", payload: { turn: 1 } });
    await push({ type: "user/message", payload: { text: "长会话压测" } });
    await push({ type: "assistant/attempt", payload: { error: "boom" } }); // 折叠区间内的失败尝试
    await push({ type: "tool/call", payload: { tool: "atf_admit_data", params: {} } });
    await push({
      type: "tool/result",
      payload: { tool: "atf_admit_data", ok: true },
      domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A }],
    });
    for (let i = 0; i < 155; i += 1) await push({ type: "user/message", payload: { seq: i } });
    expect(written).toHaveLength(160);

    const replayed = await SessionLog.replay(logPath, resolver);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    // 主事件 160 + 审计事件 2 条：material=128 时记边界 96；material=160 时推进到 128（再记一次）
    const audits = replayed.value.events.filter((event) => event.type === "session/compaction");
    expect(audits).toHaveLength(2);
    expect(audits[0]?.id).toBe(129); // 第 128 条实质事件之后立即落盘
    const auditPayload = audits[0]?.payload as { covers: { from_id: number; to_id: number }; folded_count: number; kept_ids: number[] };
    expect(auditPayload.covers).toEqual({ from_id: 1, to_id: 96 });
    expect(auditPayload.folded_count).toBe(94); // 96 条中 2 条白名单豁免（call+result）
    const auditPayload2 = audits[1]?.payload as { covers: { to_id: number }; folded_count: number };
    expect(audits[1]?.id).toBe(162); // 160 主事件 + 前一审计之后
    expect(auditPayload2.covers).toEqual({ from_id: 1, to_id: 128 });
    expect(auditPayload2.folded_count).toBe(126);

    // 重建一致：replay（含审计事件）与内存序列（不含审计）投影逐条一致，且幂等
    const fromMemory = transformContext(written);
    const fromReplay = transformContext(replayed.value.events);
    expect(fromReplay).toEqual(fromMemory);
    expect(transformContext(replayed.value.events)).toEqual(fromReplay);
    // 投影不含落盘审计事件本身（摘要由算法确定性重建）
    expect(fromReplay.filter((item) => item.id === 129)).toHaveLength(0);
    // attempt 恒被过滤（v0 语义保留）
    expect(fromReplay.every((item) => item.type !== "assistant/attempt")).toBe(true);
  });

  it("审计事件对计划透明：手工剥离审计后计划与投影不变", () => {
    const base: SessionEvent[] = [];
    for (let i = 0; i < 128; i += 1) base.push(ev("user/message", { seq: i }));
    const fakeAudit = ev("session/compaction", { kind: "compaction_summary", covers: { from_id: 1, to_id: 96 }, folded_count: 96, kept_ids: [], type_counts: {}, trigger: { events: 128, estimated_tokens: 10, reason: "event_count" }, text: "历史审计" });
    expect(planCompaction(base)).toEqual(planCompaction([...base, fakeAudit]));
    expect(transformContext([...base, fakeAudit])).toEqual(transformContext(base));
  });
});
