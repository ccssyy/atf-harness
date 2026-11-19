/**
 * 阶段2-1 判据：卡面限时等待（askWithTimeout）。
 *
 * 断言的是「行为」而非实现：超时转 pending、无 askTimed 回落 ask、关闭限时回落 ask。
 * 解 zcode A3「resolve 挂起 25 分钟无超时无告警」。
 */
import { describe, expect, it, vi } from "vitest";
import { ASK_TIMEOUT_MS_DEFAULT, askTimeoutMsOf, askWithTimeout, type FormAskService } from "../../packages/extensions/atf-tools/src/confirmFace.js";

const answer = { answers: [{ id: "q1", selected: ["A"] }] };

const svcWith = (over: Partial<FormAskService>): FormAskService => ({
  ask: vi.fn(async () => answer),
  ...over,
});

const REQ = { questions: [{ id: "q1", question: "选哪个？" }], agent: { id: "agent-1" } };

describe("askWithTimeout — 卡面限时等待", () => {
  it("有 askTimed 且开启限时 → 走限时通道并返回答案", async () => {
    const askTimed = vi.fn(async () => answer);
    const svc = svcWith({ askTimed });
    const r = await askWithTimeout(svc, REQ, { callId: "call-1" }, { ATF_ASK_TIMEOUT_MS: "5000" });
    expect(r).toEqual({ answers: answer.answers });
    expect(askTimed).toHaveBeenCalledWith(expect.objectContaining({ agent: REQ.agent }), "call-1", 5000);
    expect(svc.ask).not.toHaveBeenCalled();
  });

  it("askTimed 超时 → 返回 pending 标记（不阻塞、不当作未作答）", async () => {
    const svc = svcWith({ askTimed: vi.fn(async () => ({ pending: true as const, callId: "call-1" })) });
    const r = await askWithTimeout(svc, REQ, { callId: "call-1" }, {});
    expect(r).toEqual({ answers: [], pending: true, callId: "call-1" });
  });

  it("无 askTimed 能力 → 回落 ask（行为逐字不变）", async () => {
    const svc = svcWith({});
    const r = await askWithTimeout(svc, REQ, { callId: "call-1" }, {});
    expect(r).toEqual({ answers: answer.answers });
    expect(svc.ask).toHaveBeenCalledOnce();
  });

  it("关闭限时（0）→ 回落阻塞通道", async () => {
    const askTimed = vi.fn(async () => answer);
    const svc = svcWith({ askTimed });
    await askWithTimeout(svc, REQ, { callId: "call-1" }, { ATF_ASK_TIMEOUT_MS: "0" });
    expect(askTimed).not.toHaveBeenCalled();
    expect(svc.ask).toHaveBeenCalledOnce();
  });

  it("无 callId → 回落 ask（限时通道需 tool call 身份）", async () => {
    const askTimed = vi.fn(async () => answer);
    const svc = svcWith({ askTimed });
    await askWithTimeout(svc, REQ, {}, {});
    expect(askTimed).not.toHaveBeenCalled();
    expect(svc.ask).toHaveBeenCalledOnce();
  });
});

describe("askTimeoutMsOf — 配置解析", () => {
  it("缺省 120s", () => {
    expect(askTimeoutMsOf({})).toBe(ASK_TIMEOUT_MS_DEFAULT);
  });
  it("显式 0 = 关闭（null）", () => {
    expect(askTimeoutMsOf({ ATF_ASK_TIMEOUT_MS: "0" })).toBeNull();
  });
  it("非法值回落缺省", () => {
    expect(askTimeoutMsOf({ ATF_ASK_TIMEOUT_MS: "abc" })).toBe(ASK_TIMEOUT_MS_DEFAULT);
    expect(askTimeoutMsOf({ ATF_ASK_TIMEOUT_MS: "-5" })).toBe(ASK_TIMEOUT_MS_DEFAULT);
  });
  it("显式值生效", () => {
    expect(askTimeoutMsOf({ ATF_ASK_TIMEOUT_MS: "30000" })).toBe(30000);
  });
});
