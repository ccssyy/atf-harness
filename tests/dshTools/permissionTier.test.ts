/**
 * D90 权限分档回归锚（owner 2026-10-29「方案一」）。
 *
 * 三档语义的判据面与后果面各锁一遍：
 *  ① `permissionTierOf`：只看 sandbox 值 + 预设 id（档位名可改、语义不可改）；
 *  ② 审批面：全自动档全免，但破坏性命令通道（atf_bash）不免——不可逆数据丢失不随档位放松；
 *  ③ 提问面：完全权限档**必须还能问人**（本次事故就是审批免了、卡也没了、样本没生成）；
 *     全自动档不问人，但必须落账 `decided_by: agent`（不许把「没人回答」当成用户默认）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ATF_UNATTENDED_PRESET,
  approvalBypassed,
  permissionTierOf,
  questionsAllowed,
} from "../../packages/extensions/atf-tools/src/permissionTier.js";
import { makeApprovalExemptAnswerer, type ApprovalExemptPolicy } from "../../packages/extensions/atf-tools/src/approvalExempt.js";
import {
  constructionGapOf,
  decideConstructionParams,
} from "../../packages/extensions/atf-tools/src/constructionGate.js";
import {
  registerUnattendedQuestionGuard,
  UNATTENDED_DECIDE_MESSAGE,
} from "../../packages/extensions/atf-tools/src/unattendedGuard.js";
import { ATF_TRAINING_PRESET } from "../../packages/extensions/atf-tools/src/trainingPreset.js";

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface AskCall {
  questions: ReadonlyArray<{ id: string; options?: ReadonlyArray<{ label: string }> }>;
}

/** ctx 桩：permissionPresets＝权限档轴；sessionProjections＝预设轴；userQuestions＝提问面。 */
const fakeCtx = (
  axes: { preset?: string | null; sandbox: string },
  hooks: { ask?: (request: AskCall) => Promise<unknown>; asked?: AskCall[] } = {},
) => ({
  get: (service: string): unknown => {
    if (service === "permissionPresets") {
      return { current: (): string => "tier", resolve: (): { sandbox: string } => ({ sandbox: axes.sandbox }) };
    }
    if (service === "sessionProjections") {
      return {
        stateOf: (_session: unknown, key: string): unknown =>
          key === "agentPreset" ? (axes.preset ?? undefined) : undefined,
      };
    }
    if (service === "userQuestions") {
      if (hooks.ask === undefined) return undefined;
      return {
        ask: async (request: AskCall): Promise<unknown> => {
          hooks.asked?.push(request);
          return hooks.ask!(request);
        },
      };
    }
    return undefined;
  },
});

const exec = { agent: { session: { id: "sess-d90" } }, callId: "call-d90", signal: undefined };

const policy: ApprovalExemptPolicy = { preset: ATF_TRAINING_PRESET, chainTools: ["atf_pipeline_stage"] };

describe("D90 权限三档判据（sandbox 值 + 预设 id 两轴）", () => {
  it("未开完全权限＝guarded（预设不改变结论）；完全权限＝full-access；完全权限＋全自动预设＝unattended", () => {
    expect(permissionTierOf(fakeCtx({ sandbox: "workspace-write", preset: ATF_TRAINING_PRESET }), exec)).toBe("guarded");
    expect(permissionTierOf(fakeCtx({ sandbox: "read-only", preset: ATF_UNATTENDED_PRESET }), exec)).toBe("guarded");
    expect(permissionTierOf(fakeCtx({ sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET }), exec)).toBe("full-access");
    expect(permissionTierOf(fakeCtx({ sandbox: "danger-full-access", preset: null }), exec)).toBe("full-access");
    expect(permissionTierOf(fakeCtx({ sandbox: "danger-full-access", preset: ATF_UNATTENDED_PRESET }), exec)).toBe("unattended");
  });

  it("档位→两条独立后果：审批免（两档都免）／问题卡（只有全自动档不问）", () => {
    expect([approvalBypassed("guarded"), approvalBypassed("full-access"), approvalBypassed("unattended")])
      .toEqual([false, true, true]);
    expect([questionsAllowed("guarded"), questionsAllowed("full-access"), questionsAllowed("unattended")])
      .toEqual([true, true, false]);
  });
});

describe("D90 审批面：全自动档全免，破坏性命令通道除外", () => {
  const answerer = makeApprovalExemptAnswerer({
    ctx: fakeCtx({ sandbox: "danger-full-access", preset: ATF_UNATTENDED_PRESET }) as never,
    policy,
  });

  it("治理点在全自动档也免审（不弹卡）；atf_bash 仍走人工面板（数据丢失护栏不随档位放松）", async () => {
    for (const toolName of ["atf_pipeline_stage", "atf_run_training", "atf_evaluate", "atf_publish_confirm", "atf_gate"]) {
      let nextCalled = false;
      const outcome = await answerer({ toolName, reason: "全自动档", agent: exec.agent } as never, async () => {
        nextCalled = true;
        return "rejected";
      });
      expect(outcome).toBe("allowed-once");
      expect(nextCalled).toBe(false);
    }
    let nextCalled = false;
    const bashOutcome = await answerer({ toolName: "atf_bash", reason: "递归删除确认", agent: exec.agent } as never, async () => {
      nextCalled = true;
      return "rejected";
    });
    expect(nextCalled).toBe(true);
    expect(bashOutcome).toBe("rejected");
  });

  it("完全权限档沿用旧语义：chainTools 命中才免，治理点与未声明工具仍 next()", async () => {
    const full = makeApprovalExemptAnswerer({
      ctx: fakeCtx({ sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET }) as never,
      policy,
    });
    expect(await full({ toolName: "atf_pipeline_stage", reason: "段", agent: exec.agent } as never, async () => "rejected")).toBe("allowed-once");
    let nextCalled = false;
    await full({ toolName: "atf_evaluate", reason: "评估", agent: exec.agent } as never, async () => {
      nextCalled = true;
      return "rejected";
    });
    expect(nextCalled).toBe(true);
  });
});

describe("D90 提问面：完全权限档必须还能问人", () => {
  it("构造参数有缺口才触发；齐备时零打扰、零提问", async () => {
    expect(constructionGapOf({ groupingConfirm: true, mode5Random: 2 })).toBe(false);
    expect(constructionGapOf({ groupingConfirm: true, mode5Random: undefined })).toBe(true);
    expect(constructionGapOf({ groupingConfirm: false, mode5Random: 0 })).toBe(true);
    const asked: AskCall[] = [];
    const decision = await decideConstructionParams({
      ctx: fakeCtx({ sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET }, { asked, ask: async () => ({ answers: [] }) }) as never,
      exec: exec as never,
      runId: "run-d90",
      state: { groupingConfirm: true, mode5Random: 3 },
    });
    expect(decision).toMatchObject({ asked: false, decided_by: "user", groupingConfirm: true, mode5Random: 3 });
    expect(asked).toHaveLength(0);
  });

  it("guarded 档不新增打扰（审批卡照弹，行为零变化）", async () => {
    const asked: AskCall[] = [];
    const decision = await decideConstructionParams({
      ctx: fakeCtx({ sandbox: "workspace-write", preset: ATF_TRAINING_PRESET }, { asked, ask: async () => ({ answers: [] }) }) as never,
      exec: exec as never,
      runId: "run-d90",
      state: { groupingConfirm: false, mode5Random: undefined },
    });
    expect(decision.asked).toBe(false);
    expect(asked).toHaveLength(0);
    expect(decision.note).toContain("审批卡");
  });

  it("完全权限档：缺口当场出问题卡（两问一屏），答案落 runtime/webui 并标 decided_by: user", async () => {
    const runDir = tempRoot("d90-run-");
    const asked: AskCall[] = [];
    const decision = await decideConstructionParams({
      ctx: fakeCtx(
        { sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET },
        {
          asked,
          ask: async () => ({
            answers: [
              { id: "construction-grouping-run-d90", selected: ["要（按分组生成）"] },
              { id: "construction-augment-run-d90", selected: ["2 倍"] },
            ],
          }),
        },
      ) as never,
      exec: exec as never,
      runId: "run-d90",
      runDir,
      state: { groupingConfirm: false, mode5Random: undefined },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.questions).toHaveLength(2);
    expect(decision).toMatchObject({ asked: true, decided_by: "user", groupingConfirm: true, mode5Random: 2 });
    const ledger = join(runDir, "runtime", "webui", "construction-choice.json");
    expect(existsSync(ledger)).toBe(true);
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toMatchObject({ decided_by: "user", grouping_confirm: true, mode5_random: 2 });
  });

  it("问题卡通道不可用：如实标为 agent（不假装用户确认过）", async () => {
    const decision = await decideConstructionParams({
      ctx: fakeCtx({ sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET }) as never,
      exec: exec as never,
      runId: "run-d90",
      state: { groupingConfirm: false, mode5Random: undefined },
    });
    expect(decision.decided_by).toBe("agent");
    expect(decision.note).toContain("未获确认");
  });

  it("全自动档：不问人，但把代决写进 decisions-auto.json（decided_by: agent）", async () => {
    const runDir = tempRoot("d90-auto-");
    const asked: AskCall[] = [];
    const decision = await decideConstructionParams({
      ctx: fakeCtx({ sandbox: "danger-full-access", preset: ATF_UNATTENDED_PRESET }, { asked, ask: async () => ({ answers: [] }) }) as never,
      exec: exec as never,
      runId: "run-d90",
      runDir,
      state: { groupingConfirm: false, mode5Random: undefined },
    });
    expect(asked).toHaveLength(0);
    expect(decision).toMatchObject({ asked: false, decided_by: "agent" });
    const ledger = JSON.parse(readFileSync(join(runDir, "runtime", "webui", "decisions-auto.json"), "utf8")) as {
      decided_by: string;
      decisions: ReadonlyArray<{ key: string; decided_by: string }>;
    };
    expect(ledger.decided_by).toBe("agent");
    expect(ledger.decisions.every((entry) => entry.decided_by === "agent")).toBe(true);
  });
});

describe("D90 全自动档提问守卫（对称挂 user-questions/request）", () => {
  it("全自动档：拒发问题卡并交回模型自决（错误文案即行为指引，零档位内部名）", async () => {
    const answerer = registerSpy({ sandbox: "danger-full-access", preset: ATF_UNATTENDED_PRESET });
    await expect(answerer({ questions: [{ id: "q1" }], agent: exec.agent } as never, async () => "native-panel")).rejects.toThrow(UNATTENDED_DECIDE_MESSAGE);
    expect(UNATTENDED_DECIDE_MESSAGE).toContain("自行");
    expect(UNATTENDED_DECIDE_MESSAGE).not.toContain("unattended");
  });

  it("其它档位：一律 next()（原生问题卡照弹）", async () => {
    for (const axes of [
      { sandbox: "workspace-write", preset: ATF_TRAINING_PRESET },
      { sandbox: "danger-full-access", preset: ATF_TRAINING_PRESET },
    ]) {
      let nextCalled = false;
      const outcome = await registerSpy(axes)({ questions: [{ id: "q1" }], agent: exec.agent } as never, async () => {
        nextCalled = true;
        return "native-panel";
      });
      expect(nextCalled).toBe(true);
      expect(outcome).toBe("native-panel");
    }
  });

  it("注册面 prepend 抢 waterfall 头部；裸装配面（无 ctx.on）跳过不抛", () => {
    let captured: { event: string; options?: { prepend?: boolean } } | null = null;
    const registered = registerUnattendedQuestionGuard({
      on: (event, _listener, options) => {
        captured = { event, options };
        return () => true;
      },
    });
    expect(registered).toBe(true);
    expect(captured!.event).toBe("user-questions/request");
    expect(captured!.options?.prepend).toBe(true);
    expect(registerUnattendedQuestionGuard({})).toBe(false);
  });
});

/** 取出注册面真正挂上的 answerer（与 apply() 同路径，避免测试自造第二个实现）。 */
const registerSpy = (axes: { sandbox: string; preset: string | null }): ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
  let listener: ((request: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
  registerUnattendedQuestionGuard({
    on: (_event, registered) => {
      listener = registered as typeof listener;
      return () => true;
    },
    get: fakeCtx(axes).get,
  });
  if (listener === null) throw new Error("守卫未注册");
  return listener;
};
