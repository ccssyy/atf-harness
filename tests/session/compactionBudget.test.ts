/**
 * L1c 提前批 A1.5（2026-09-22）：模型面体量预算——数据驱动 compaction 触发水位＋单条摘要上限。
 *
 * 放行件 v7（`b2ae6b36…` ★段）三铁律之二＝**行为中立回退**：未配置 context_window 时
 * 触发水位与单条上限逐字节回退既有值（24K／6_000）；三铁律之一＝**同源**：runner seam
 * （投影径）与 sessionLog:463（审计径）经同一 compactionTriggerTokens() 解析（本文件测
 * 解析器与 planCompaction 参数化；同源由"两径共用同一函数"保证）。
 * 事件数双门（≥128）与常量层既有取值保留（A1.5.4）。
 */
import { describe, expect, it } from "vitest";
import { planCompaction, projectContext } from "../../src/core/session/compaction.js";
import { COMPACTION_TRIGGER_EVENTS, COMPACTION_TRIGGER_TOKENS } from "../../src/core/session/constants.js";
import {
  COMPACTION_RESERVE_TOKENS,
  compactionTriggerTokens,
  getCompactionContextWindow,
  resolveCompactionTriggerTokens,
  resolveSummaryResultCapChars,
  setCompactionContextWindow,
} from "../../src/core/session/constantsBudget.js";
import { type SessionEvent } from "../../src/core/session/index.js";

const materialEvent = (id: number, text: string): SessionEvent => ({
  id,
  ts: "2026-09-22T00:00:00Z",
  type: "user/message",
  payload: { text },
  projection: { evidence_event: null },
});

describe("A1.5 预算解析器（constantsBudget）", () => {
  it("未配置回退（行为中立）：触发=既有常量 24K；单条上限=6_000 字符", () => {
    expect(resolveCompactionTriggerTokens(null)).toBe(COMPACTION_TRIGGER_TOKENS);
    expect(resolveCompactionTriggerTokens(null)).toBe(24_000);
    expect(resolveSummaryResultCapChars(null)).toBe(6_000);
  });

  it("reserve 推导式：max(压缩摘要输出预算 20K, 单条绝对上限 25K) = 25K tokens", () => {
    expect(COMPACTION_RESERVE_TOKENS).toBe(25_000);
  });

  it("1M 窗口（deepseek-flash／v4-pro／glm-5.3 系实测配置）：水位 975_000；单条上限 50_000 字符", () => {
    expect(resolveCompactionTriggerTokens(1_000_000)).toBe(975_000);
    expect(resolveSummaryResultCapChars(1_000_000)).toBe(50_000); // min(125K, 25K) tokens × 2
  });

  it("128K 窗口：水位 103_000；单条上限 32_000 字符（16K tokens × 2）", () => {
    expect(resolveCompactionTriggerTokens(128_000)).toBe(103_000);
    expect(resolveSummaryResultCapChars(128_000)).toBe(32_000);
  });

  it("只升不降（小窗口不比历史更激进）：折算低于现值时维持现值", () => {
    expect(resolveCompactionTriggerTokens(30_000)).toBe(24_000); // 30K−25K=5K → floor 24K
    expect(resolveSummaryResultCapChars(24_000)).toBe(6_000); // 3K tokens → 6_000 chars（恰回退值）
    expect(resolveSummaryResultCapChars(8_000)).toBe(6_000); // 1K tokens → 2_000 → floor 6_000
  });
});

describe("A1.5.4 数据驱动触发：配置 1M 生效／未配置回退／事件双门保留", () => {
  const bigPayload = "x".repeat(60_000); // est tokens ≈ 30_000 > 既有 24K 门

  it("未配置（回退 24K）：>24K est token 的实质事件照旧触发压缩", () => {
    const events = [materialEvent(1, bigPayload)];
    expect(planCompaction(events).triggered).toBe(true);
    expect(planCompaction(events).trigger.reason).toBe("token_budget");
  });

  it("配置 1M：同一事件不再触发（水位 975K）——数据驱动生效", () => {
    const events = [materialEvent(1, bigPayload)];
    const plan = planCompaction(events, resolveCompactionTriggerTokens(1_000_000));
    expect(plan.triggered).toBe(false);
    expect(plan.boundary).toBe(0);
  });

  it("回退逐字节一致：planCompaction(events) ≡ planCompaction(events, 24_000)", () => {
    const events = [materialEvent(1, bigPayload), materialEvent(2, "后续消息")];
    expect(JSON.stringify(planCompaction(events))).toBe(JSON.stringify(planCompaction(events, COMPACTION_TRIGGER_TOKENS)));
    expect(JSON.stringify(projectContext(events))).toBe(JSON.stringify(projectContext(events, COMPACTION_TRIGGER_TOKENS)));
  });

  it("事件数双门保留：大水位下事件计数仍触发（修复批 3 后缺省门＝512；128 不再过早触发）", () => {
    const events = Array.from({ length: COMPACTION_TRIGGER_EVENTS }, (_, i) => materialEvent(i + 1, `事件${String(i)}`));
    const plan = planCompaction(events, resolveCompactionTriggerTokens(1_000_000));
    expect(plan.triggered).toBe(true);
    expect(plan.trigger.reason).toBe("event_count");
    // 128 事件在新缺省门下不触发（512 前移修复：128 过早折叠——重跑① 实证）
    const small = Array.from({ length: 128 }, (_, i) => materialEvent(i + 1, `事件${String(i)}`));
    expect(planCompaction(small, resolveCompactionTriggerTokens(1_000_000)).triggered).toBe(false);
  });

  it("projectContext 透传：小预算（100）触发 → 投影头部为合成压缩摘要", () => {
    // 边界推进需 usable = n−32 ≥ 32（保留窗/粒度常量既有语义）→ 至少 65 条实质事件；
    // 首条大 payload 令估算 token 远超预算 100。
    const events: SessionEvent[] = [materialEvent(1, "x".repeat(10_000))];
    for (let i = 2; i <= 65; i += 1) events.push(materialEvent(i, `事件${String(i)}`));
    const projected = projectContext(events, 100);
    expect(projected[0]?.type).toBe("session/compaction");
    expect(projected[0]?.synthetic).toBe(true);
  });

  it("进程级 holder（两径同源读取位）：set → 同值；null 复位回退", () => {
    try {
      setCompactionContextWindow(1_000_000);
      expect(getCompactionContextWindow()).toBe(1_000_000);
      expect(compactionTriggerTokens()).toBe(975_000);
    } finally {
      setCompactionContextWindow(null);
    }
    expect(compactionTriggerTokens()).toBe(COMPACTION_TRIGGER_TOKENS);
  });
});
