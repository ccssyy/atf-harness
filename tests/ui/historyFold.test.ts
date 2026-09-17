/**
 * L1b B6 D2：历史重放折叠单测——HistoryFolder 批次状态机。
 * 折叠仅展示层：历史行由 formatEventLine 派生（[历史] 标记＋事件 id），展开后与日志
 * 逐条对应；「由事实日志重放重建」措辞合规保留。
 */
import { describe, expect, it } from "vitest";
import { DiffRenderer } from "../../src/ui/renderer.js";
import { HistoryFolder } from "../../src/ui/historyFold.js";
import { formatEventLine } from "../../src/ui/eventView.js";
import type { SessionEvent } from "../../src/core/session/index.js";

let nextId = 1;
const ev = (type: string, payload: unknown): SessionEvent =>
  ({ id: nextId++, type, ts: "2026-09-17T00:00:00.000Z", payload }) as unknown as SessionEvent;

const make = (): { renderer: DiffRenderer; chunks: () => string } => {
  const collected: string[] = [];
  const stream = {
    isTTY: false,
    write: (text: string): boolean => {
      collected.push(text);
      return true;
    },
  };
  return { renderer: new DiffRenderer({ out: stream }), chunks: () => collected.join("") };
};

const labels = { scenario: "l1b-tui", run: "run-hist-1" };

describe("HistoryFolder（B6 D2）", () => {
  it("history 批次默认只出一行摘要（含 N/scenario/run）；live 前自动落摘要", () => {
    const { renderer, chunks } = make();
    const folder = new HistoryFolder(renderer, labels);
    folder.handle(ev("turn/start", { scenario_id: "s", branch_id: "b" }), "history", formatEventLine);
    folder.handle(ev("user/message", { text: "第一问" }), "history", formatEventLine);
    folder.handle(ev("assistant/message", { text: "答" }), "history", formatEventLine);
    folder.handle(ev("turn/start", { scenario_id: "s", branch_id: "b" }), "live", formatEventLine);
    const text = chunks();
    const summaryLines = text.split("\n").filter((line) => line.includes("已由事实日志重建"));
    expect(summaryLines.length).toBe(1);
    expect(summaryLines[0]).toContain("3 条事件");
    expect(summaryLines[0]).toContain("scenario=l1b-tui run=run-hist-1");
    expect(summaryLines[0]).toContain("按 h 展开");
    // 历史行未逐条直出（第 2/3 轮不刷屏）
    expect(text.split("\n").filter((line) => line.startsWith("#0001 [历史]")).length).toBe(0);
  });

  it("h 展开为逐条（与日志逐条对应，[历史] 标记保留）；再次 h 幂等返回 false", () => {
    const { renderer, chunks } = make();
    const folder = new HistoryFolder(renderer, labels);
    const historyEvents = [ev("turn/start", { scenario_id: "s", branch_id: "b" }), ev("user/message", { text: "第一问" })];
    for (const event of historyEvents) folder.handle(event, "history", formatEventLine);
    folder.handle(ev("assistant/message", { text: "答" }), "live", formatEventLine);
    expect(folder.reveal()).toBe(true);
    const text = chunks();
    expect(text).toContain("展开重放（由事实日志重放重建，共 2 条）");
    // 逐条与日志一致（id + [历史] 标记）
    for (const event of historyEvents) {
      expect(text).toContain(formatEventLine(event, "history"));
    }
    expect(folder.reveal()).toBe(false);
  });

  it("多轮：新批次（重放全流）落新摘要；runBranch 收口 flushSummary 幂等", () => {
    const { renderer, chunks } = make();
    const folder = new HistoryFolder(renderer, labels);
    // 第 2 轮：重放全流（3 条）→ 无 live（runBranch 立即收口）→ flushSummary 补摘要
    for (const _ of [1, 2, 3]) folder.handle(ev("assistant/message", { text: "历史" }), "history", formatEventLine);
    folder.flushSummary();
    folder.flushSummary(); // 幂等
    const text = chunks();
    const summaries = text.split("\n").filter((line) => line.includes("已由事实日志重建"));
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("3 条事件");
  });

  it("全新会话无历史 → 无摘要行", () => {
    const { renderer, chunks } = make();
    const folder = new HistoryFolder(renderer, labels);
    folder.handle(ev("turn/start", { scenario_id: "s", branch_id: "b" }), "live", formatEventLine);
    folder.flushSummary();
    expect(chunks()).not.toContain("已由事实日志重建");
  });
});
