/**
 * pi-ai 换库批（门 2，2026-09-23）——R3 effort 运行时切换编排测试（指令 §3.4/§四.2）。
 *
 * performEffortSwitch 原子序（providerSwitch.ts，口径 #7 同源）：
 * ① 闭集校验（未知值 fail-closed）→ ② 边界复核（仅 turn 边界，口径 #5 同源）→
 * ③ 落盘 provider/switch 事件（零 schema 变更：from/to 同 id，档位记入 reason）→
 * ④ 生效注入。任一前置失败：不落盘、不生效。
 * 幂等切换（同值）：不落事件、不重复生效。
 * 事件词汇投影面纪律零触发：provider/switch 在 B1 adapter 映射为 skip（模型不可见）。
 */
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { performEffortSwitch } from "../../src/core/run/providerSwitch.js";
import { adaptProjectionToMessages } from "../../src/llm/adapter.js";
import { PIAI_REASONING_EFFORTS } from "../../src/llm/index.js";

/** 闭集校验注入（生产装配用 PIAI_REASONING_EFFORTS——llm 层单点；此处同源复刻）。 */
const validateEffort = (effort: string): { ok: true } | { ok: false; message: string } =>
  (PIAI_REASONING_EFFORTS as readonly string[]).includes(effort)
    ? { ok: true }
    : { ok: false, message: `reasoning_effort=${JSON.stringify(effort)} 不在闭集` };

describe("performEffortSwitch——切换原子序", () => {
  it("成功序：校验→落盘→生效；载荷零 schema 变更（from/to 同 id，reason 记档位）", async () => {
    const appended: unknown[] = [];
    let applied: string | null = null;
    const result = await performEffortSwitch({
      providerId: "deepseek",
      toEffort: "low",
      currentEffort: () => "max",
      validateEffort,
      turnOpen: false,
      turnIndex: 2,
      afterEventId: 41,
      appendSwitchEvent: async (payload) => {
        appended.push(payload);
        return { id: 42 };
      },
      apply: (effort) => {
        applied = effort;
        return { ok: true };
      },
    });
    expect(result.ok && result.value).toEqual({ event_id: 42, from_effort: "max", to_effort: "low" });
    expect(applied).toBe("low");
    expect(appended).toHaveLength(1);
    const payload = appended[0] as { from: { provider_id: string }; to: { provider_id: string }; boundary: { turn_index: number; after_event_id: number }; reason: string };
    expect(payload.from.provider_id).toBe("deepseek");
    expect(payload.to.provider_id).toBe("deepseek"); // 同 id：档位切换不改 provider 归属
    expect(payload.boundary).toEqual({ turn_index: 2, after_event_id: 41 });
    expect(payload.reason).toBe("reasoning_effort: max → low");
    // 载荷键闭集与 provider/switch 既有形态一致（零 schema 变更的直接证明）
    expect(Object.keys(payload).sort()).toEqual(["boundary", "from", "reason", "to"]);
  });

  it("未知档位：拒绝且不落盘、不生效", async () => {
    let appended = 0;
    let applied = 0;
    const result = await performEffortSwitch({
      providerId: "deepseek",
      toEffort: "medium",
      currentEffort: () => "max",
      validateEffort,
      turnOpen: false,
      turnIndex: 1,
      afterEventId: 7,
      appendSwitchEvent: async () => {
        appended += 1;
        return { id: 8 };
      },
      apply: () => {
        applied += 1;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(appended).toBe(0);
    expect(applied).toBe(0);
  });

  it("turn 内越界：拒绝（provider_switch_out_of_boundary）且不落盘", async () => {
    let appended = 0;
    const result = await performEffortSwitch({
      providerId: "deepseek",
      toEffort: "low",
      currentEffort: () => "max",
      validateEffort,
      turnOpen: true,
      turnIndex: 1,
      afterEventId: 7,
      appendSwitchEvent: async () => {
        appended += 1;
        return { id: 8 };
      },
      apply: () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("provider_switch_out_of_boundary");
    expect(appended).toBe(0);
  });

  it("落盘失败：不生效（无半生效态）", async () => {
    let applied = 0;
    const result = await performEffortSwitch({
      providerId: "deepseek",
      toEffort: "low",
      currentEffort: () => "max",
      validateEffort,
      turnOpen: false,
      turnIndex: 1,
      afterEventId: 7,
      appendSwitchEvent: async () => null,
      apply: () => {
        applied += 1;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("provider_switch_digest_broken");
    expect(applied).toBe(0);
  });

  it("同值幂等：不落事件、不重复生效", async () => {
    let appended = 0;
    const result = await performEffortSwitch({
      providerId: "deepseek",
      toEffort: "max",
      currentEffort: () => "max",
      validateEffort,
      turnOpen: false,
      turnIndex: 1,
      afterEventId: 7,
      appendSwitchEvent: async () => {
        appended += 1;
        return { id: 8 };
      },
      apply: () => ({ ok: true }),
    });
    expect(result.ok && result.value).toEqual({ event_id: -1, from_effort: "max", to_effort: "max" });
    expect(appended).toBe(0);
  });
});

describe("adapter 白名单回归：provider/switch 仍为 skip（模型不可见）", () => {
  it("switch 事件不产生模型消息（B1 映射零改）", () => {
    const projected = adaptProjectionToMessages([
      { id: 1, ts: "t", type: "provider/switch", payload: { from: { provider_id: "deepseek" }, to: { provider_id: "deepseek" }, boundary: { turn_index: 1, after_event_id: 7 }, reason: "reasoning_effort: max → low" } },
    ] as never);
    expect(projected.ok).toBe(true);
    if (projected.ok) expect(projected.value).toEqual([]);
  });

  it("Result ok 出口形状守卫（防 import 漂移）", () => {
    expect(ok(true).ok).toBe(true);
  });
});
