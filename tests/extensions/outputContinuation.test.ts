import { describe, expect, it } from "vitest";
import {
  CONTINUE_PROMPT,
  exhaustedNotice,
  makeContinuationCoordinator,
  type ContinuationAgent,
} from "../../packages/extensions/atf-continuation/src/coordinator.js";

/**
 * D250 输出截断自动续写——预算/边界/对抗契约测试（任务书对抗 4 例+K3/K4/K7）。
 * 断言面=协调器对 followup/inject 的调用行为（纯逻辑单测，mock getAgent）。
 * 对抗锚：实现若退化为「无限续写」「工具调用步也续写」「预算外继续续写」，
 * 下列断言全红——契约本身即对抗。
 */

interface Harness {
  coordinator: ReturnType<typeof makeContinuationCoordinator>;
  calls: { sessionId: string; kind: "followup" | "inject"; text: string }[];
}

/** 搭一个带假 agent 的测试环境：喂事件后检查 followup/inject 调用序列。 */
function setup(max = 3, agent?: Partial<ContinuationAgent>): Harness {
  const calls: Harness["calls"] = [];
  const fakeAgent: ContinuationAgent = {
    followup: (message) => {
      calls.push({
        sessionId: "s1",
        kind: "followup",
        text: (message as { content: { text: string }[] }).content[0]!.text,
      });
    },
    inject: (message) => {
      calls.push({
        sessionId: "s1",
        kind: "inject",
        text: (message as { content: { text: string }[] }).content[0]!.text,
      });
    },
    ...agent,
  };
  const coordinator = makeContinuationCoordinator({
    max,
    getAgent: (id) => (id === "s1" ? (fakeAgent as ContinuationAgent) : undefined),
  });
  return { coordinator, calls };
}

/** 合成一轮「无工具调用的 max-tokens turn」事件序列。 */
function turnWithMaxTokens(
  coordinator: Harness["coordinator"],
  turn: number,
): void {
  coordinator.onSessionEvent({ id: "s1" }, { type: "turn/start", data: { turn } });
  coordinator.onSessionEvent(
    { id: "s1" },
    { type: "turn/end", data: { turn, reason: { kind: "max-tokens" } } },
  );
}

describe("D250 自动续写协调器", () => {
  it("对抗1：连续 max-tokens 前 3 次各注入一条续写，第 4 次注入告警而非续写", () => {
    const { coordinator, calls } = setup(3);
    for (let turn = 1; turn <= 4; turn += 1) turnWithMaxTokens(coordinator, turn);
    const followups = calls.filter((c) => c.kind === "followup");
    const injects = calls.filter((c) => c.kind === "inject");
    expect(followups).toHaveLength(3);
    expect(followups.every((c) => c.text === CONTINUE_PROMPT)).toBe(true);
    expect(injects).toHaveLength(1);
    expect(injects[0]!.text).toContain("3 次");
    expect(injects[0]!.text).toContain("拆成更小的步骤");
    expect(injects[0]!.text).toContain("Medium/Low");
  });

  it("对抗2：本 turn 有工具调用的截断不续写（K4，dsh 原生路径接管）", () => {
    const { coordinator, calls } = setup(3);
    coordinator.onSessionEvent({ id: "s1" }, { type: "turn/start", data: { turn: 1 } });
    coordinator.onSessionEvent(
      { id: "s1" },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
    );
    coordinator.onSessionEvent(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
    );
    expect(calls).toHaveLength(0);
  });

  it("对抗3：续写消息自身引发的下一轮再撞顶计入同一预算（不重置、不死循环）", () => {
    const { coordinator, calls } = setup(3);
    // turn1 撞顶 → 续写1；turn2（续写引发的轮）再撞顶 → 续写2；turn3 → 续写3；turn4 → 告警
    for (let turn = 1; turn <= 4; turn += 1) turnWithMaxTokens(coordinator, turn);
    expect(calls.filter((c) => c.kind === "followup")).toHaveLength(3);
    expect(calls.filter((c) => c.kind === "inject")).toHaveLength(1);
    // 第 5 次撞顶：预算已耗尽且告警已发——不再注入任何消息（告警也不重复刷屏）
    turnWithMaxTokens(coordinator, 5);
    expect(calls).toHaveLength(4);
  });

  it("对抗4：正常 completed turn 零注入、零预算消耗", () => {
    const { coordinator, calls } = setup(3);
    coordinator.onSessionEvent({ id: "s1" }, { type: "turn/start", data: { turn: 1 } });
    coordinator.onSessionEvent(
      { id: "s1" },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    );
    coordinator.onSessionEvent({ id: "s1" }, { type: "turn/start", data: { turn: 2 } });
    coordinator.onSessionEvent(
      { id: "s1" },
      { type: "turn/end", data: { turn: 2, reason: { kind: "blocked" } } },
    );
    expect(calls).toHaveLength(0);
    expect(coordinator.stateOfForTest("s1")?.continuations).toBe(0);
  });

  it("预算跨 turn 不重置：3 次续写分布在多个 completed turn 间隔后仍耗尽", () => {
    const { coordinator, calls } = setup(3);
    turnWithMaxTokens(coordinator, 1);
    coordinator.onSessionEvent({ id: "s1" }, { type: "turn/start", data: { turn: 2 } });
    coordinator.onSessionEvent(
      { id: "s1" },
      { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
    );
    turnWithMaxTokens(coordinator, 3);
    turnWithMaxTokens(coordinator, 4);
    turnWithMaxTokens(coordinator, 5);
    expect(calls.filter((c) => c.kind === "followup")).toHaveLength(3);
    expect(calls.filter((c) => c.kind === "inject")).toHaveLength(1);
  });

  it("agent 已释放（getAgent 返回 undefined）时不注入、不抛错", () => {
    const calls: Harness["calls"] = [];
    const coordinator = makeContinuationCoordinator({ max: 3, getAgent: () => undefined });
    expect(() =>
      coordinator.onSessionEvent(
        { id: "gone" },
        { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
      ),
    ).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("session/disposed 清理会话状态（防泄漏）", () => {
    const { coordinator } = setup(3);
    turnWithMaxTokens(coordinator, 1);
    expect(coordinator.stateOfForTest("s1")).toBeDefined();
    coordinator.onSessionDisposed({ id: "s1" });
    expect(coordinator.stateOfForTest("s1")).toBeUndefined();
  });

  it("告警文案含会话已续写次数与两条改法（报错即修复指令）", () => {
    const notice = exhaustedNotice(3);
    expect(notice).toContain("3 次");
    expect(notice).toContain("拆成更小的步骤");
    expect(notice).toContain("Medium/Low");
  });
});
