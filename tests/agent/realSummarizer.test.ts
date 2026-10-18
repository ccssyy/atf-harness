// 批C1-2 B2——真摘要器（同 provider 单发；有界输入/输出/超时；失败回落 faux＋零静默通报）。
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createRealSummarizer, tailBoundDropped, type CompleteFn } from "../../src/agent/realSummarizer.js";
import { fauxSummarizer } from "../../src/agent/agentCapabilities.js";
import { resolveSummaryResultCapChars } from "../../src/core/session/constantsBudget.js";

const msg = (role: string, text: string): AgentMessage => ({ role, content: text, timestamp: 1 }) as AgentMessage;

describe("批C1-2 B2 有界输入（tailBoundDropped——按水位预算自尾截取）", () => {
  it("预算内全保留；预算外自头截断（保最新）＋truncated 标注", () => {
    const dropped = [msg("user", "a".repeat(400)), msg("assistant", "b".repeat(400)), msg("user", "最新一条")];
    const inside = tailBoundDropped(dropped, 100_000);
    expect(inside.truncated).toBe(false);
    expect(inside.lines).toHaveLength(3);
    const tight = tailBoundDropped(dropped, 40); // est tokens（chars/2~chars/4 口径）——仅容尾部短消息
    expect(tight.truncated).toBe(true);
    expect(tight.lines[tight.lines.length - 1]).toContain("最新一条");
    expect(tight.lines.length).toBeLessThan(3);
  });
});

describe("批C1-2 B2 真摘要器（成功/降级双路）", () => {
  const baseDeps = {
    models: {} as never,
    model: {} as never,
    apiKey: "test-key",
    contextWindowTokens: 1_048_576 as number | null,
    inputTokenBudget: 100_000,
  };

  it("成功路：模型产出＝摘要正文（真摘要非占位）", async () => {
    const summarize = createRealSummarizer(baseDeps, async (context) => {
      expect(context.systemPrompt).toContain("压缩");
      expect(context.messages[0]?.content).toContain("早期指令");
      return { stopReason: "stop", content: [{ type: "text", text: "任务：完成 X；关键决定：lr=2e-4；结论：Y 就绪。" }] };
    });
    const out = await summarize([msg("user", "早期指令：完成 X"), msg("assistant", "决定 lr=2e-4")]);
    expect(out).toContain("任务：完成 X");
    expect(out).not.toContain("faux");
  });

  it("有界输出：超过 resolveSummaryResultCapChars 截断带省略号", async () => {
    const cap = resolveSummaryResultCapChars(baseDeps.contextWindowTokens);
    const summarize = createRealSummarizer(baseDeps, async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "x".repeat(cap + 500) }],
    }));
    const out = await summarize([msg("user", "a")]);
    expect(out.length).toBe(cap + 1); // cap 字符＋省略号
    expect(out.endsWith("…")).toBe(true);
  });

  it("降级三路（stopReason=error／空产出／异常）：回落 faux＋onDegrade 零静默", async () => {
    const dropped = [msg("user", "a"), msg("assistant", "b")];
    for (const complete of [
      (async () => ({ stopReason: "error", content: [] })) as CompleteFn,
      (async () => ({ stopReason: "stop", content: [{ type: "text", text: "  " }] })) as CompleteFn,
      (async () => { throw new Error("boom"); }) as CompleteFn,
    ]) {
      const reasons: string[] = [];
      const summarize = createRealSummarizer({ ...baseDeps, onDegrade: (reason) => reasons.push(reason) }, complete);
      const out = await summarize(dropped);
      expect(out).toBe(await fauxSummarizer(dropped));
      expect(reasons).toHaveLength(1);
    }
  });

  it("超时路：AbortSignal 到点即降级（不无限等模型）", async () => {
    const reasons: string[] = [];
    const summarize = createRealSummarizer(
      { ...baseDeps, timeoutMs: 20, onDegrade: (reason) => reasons.push(reason) },
      (_context, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => { reject(new Error("timeout_signal")); });
      }),
    );
    const out = await summarize([msg("user", "a")]);
    expect(out).toContain("faux");
    expect(reasons[0]).toContain("timeout_signal");
  });
});
