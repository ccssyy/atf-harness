// 批C1-2 B2——溢出兜底（vendor 码＋pi-ai 权威判定双路；一次强制压缩重试；可读文案收口）。
import { describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isOverflowAssistantMessage,
  isOverflowErrorMessage,
  OVERFLOW_FINAL_NOTICE_TEXT,
  promptWithOverflowRetry,
} from "../../src/agent/overflowRetry.js";

const overflowAssistant = {
  role: "assistant",
  content: [{ type: "text", text: "" }],
  stopReason: "error",
  errorMessage: "429 prompt is too long: 213462 tokens > 1048576 maximum",
  timestamp: 1,
};

const normalAssistant = { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop", timestamp: 1 };

/** 剧本式假 agent：prompt 逐次消费脚本（每项＝抛错串或压入 state 的 assistant 消息）。 */
const scriptedAgent = (script: Array<{ throw?: string; message?: unknown }>) => {
  let cursor = 0;
  const seenForce: boolean[] = [];
  const agent = {
    promptCount: 0,
    prompt: async (_instruction: string): Promise<void> => {
      agent.promptCount += 1;
      const step = script[Math.min(cursor, script.length - 1)]!;
      cursor += 1;
      if (step.throw !== undefined) throw new Error(step.throw);
      agent.state.messages.push(step.message);
    },
    state: { messages: [] as unknown[] },
    seenForce,
  };
  return agent;
};

describe("批C1-2 B2 溢出判定（双路）", () => {
  it("抛错路：vendor 码与 provider 高频模式命中；普通错误不命中", () => {
    expect(isOverflowErrorMessage(`model request failed: ${CONTEXT_WINDOW_EXCEEDED_CODE}`)).toBe(true);
    expect(isOverflowErrorMessage("400 prompt is too long: 100 tokens")).toBe(true);
    expect(isOverflowErrorMessage("Requested token count exceeds the model's maximum context length of 131072 tokens")).toBe(true);
    expect(isOverflowErrorMessage("network timeout")).toBe(false);
    expect(isOverflowErrorMessage("chat_budget_reached")).toBe(false);
  });
  it("assistant 路：pi-ai 权威判定（error 溢出消息命中；正常完成不命中；非 assistant 不命中）", () => {
    expect(isOverflowAssistantMessage(overflowAssistant, null)).toBe(true);
    expect(isOverflowAssistantMessage(normalAssistant, null)).toBe(false);
    expect(isOverflowAssistantMessage({ role: "user", content: "x" }, null)).toBe(false);
    expect(isOverflowAssistantMessage(null, null)).toBe(false);
  });
});

describe("批C1-2 B2 promptWithOverflowRetry（强制压缩一次＋自动重试该轮）", () => {
  it("首轮溢出（error assistant）→ forceBox 置位→重试成功＝ok（用户无感，两次 prompt）", async () => {
    const agent = scriptedAgent([{ message: overflowAssistant }, { message: normalAssistant }]);
    const forceBox = { current: false };
    const retries: number[] = [];
    const out = await promptWithOverflowRetry(agent, "做某事", {
      forceBox,
      contextWindowTokens: null,
      onOverflowRetry: () => { retries.push(agent.promptCount); },
    });
    expect(out.kind).toBe("ok");
    expect(agent.promptCount).toBe(2);
    expect(forceBox.current).toBe(true); // 置位给重试轮 transform 消费（复位＝transform 契约，见 v1Capabilities 测试）
    expect(retries).toEqual([1]);
  });

  it("首轮抛 vendor 码错 → 同样走重试路", async () => {
    const agent = scriptedAgent([{ throw: `provider rejected: ${CONTEXT_WINDOW_EXCEEDED_CODE}` }, { message: normalAssistant }]);
    const out = await promptWithOverflowRetry(agent, "x", { forceBox: { current: false }, contextWindowTokens: null });
    expect(out.kind).toBe("ok");
    expect(agent.promptCount).toBe(2);
  });

  it("两次都溢出 → overflow_final（可读文案不含原始码）", async () => {
    const agent = scriptedAgent([{ message: overflowAssistant }, { message: overflowAssistant }]);
    const out = await promptWithOverflowRetry(agent, "x", { forceBox: { current: false }, contextWindowTokens: null });
    expect(out.kind).toBe("overflow_final");
    expect(OVERFLOW_FINAL_NOTICE_TEXT).not.toContain(CONTEXT_WINDOW_EXCEEDED_CODE);
    expect(OVERFLOW_FINAL_NOTICE_TEXT).toContain("已尝试压缩");
  });

  it("非溢出异常原样上抛（kind=error 不吞既有错误面）；无溢出直过＝单次 prompt", async () => {
    const agent = scriptedAgent([{ throw: "chat_budget_reached" }]);
    const out = await promptWithOverflowRetry(agent, "x", { forceBox: { current: false }, contextWindowTokens: null });
    expect(out).toEqual({ kind: "error", error: "chat_budget_reached" });
    expect(agent.promptCount).toBe(1);
    const okAgent = scriptedAgent([{ message: normalAssistant }]);
    const okOut = await promptWithOverflowRetry(okAgent, "x", { forceBox: { current: false }, contextWindowTokens: null });
    expect(okOut.kind).toBe("ok");
    expect(okAgent.promptCount).toBe(1);
  });
});
