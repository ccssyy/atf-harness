/**
 * 批 P 增补 §二测试：A2 问答轨四 verdict（确认卡 surface／75/79）＋B1 steering/followUp
 * 双队列＋B2 生命周期（abort/waitForIdle/reset）＋B3 compaction＋B4 hook 注册面 8 名＋
 * B5 skills 系统提示 sections＋B6 审批窗口输入缓冲。A 档经桥真实链（mock 对端）；
 * B 档 faux（指令 §三.1）。零真实模型调用。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import {
  assembleV1Agent,
  runV1Headless,
  type AssembleV1Deps,
  type AssembledV1Agent,
} from "../../src/agent/cli.js";
import { createInteractiveApprovalSurface, type ApprovalSurface } from "../../src/agent/approvalSurface.js";
import { createCompactionTransform, fauxSummarizer, buildSkillsSystemSuffix } from "../../src/agent/agentCapabilities.js";
import { createHookRegistry, V1_HOOK_NAMES } from "../../src/agent/hooks.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "../../src/agent/fauxStream.js";
import { createJsonlSessionRepo } from "../../src/agent/sessionMirror.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";
import type { AgentEvent, AgentMessage, QueueMode } from "@earendil-works/pi-agent-core";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const spawnMock = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

const makeSession = async (): Promise<{ session: Awaited<ReturnType<ReturnType<typeof createJsonlSessionRepo>["create"]>>; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "v1cap-"));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return { session, root };
};

const userText = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;

/** 请求上下文捕获（provider 请求面断言缝）。 */
const capturing = (script: readonly ReturnType<typeof fauxFinalAnswer>[]) => {
  const contexts: AgentMessage[][] = [];
  const inner = createFauxStreamFn(script);
  const fn = ((model, context) => {
    contexts.push([...context.messages] as AgentMessage[]);
    return inner(model, context);
  }) as AssembleV1Deps["streamFn"];
  return { fn, contexts };
};

const assemble = async (overrides: Partial<AssembleV1Deps> & { streamFn: AssembleV1Deps["streamFn"] }): Promise<AssembledV1Agent & { bridge: AtfBridgeConnection }> => {
  const bridge = await spawnMock();
  const { session } = await makeSession();
  const assembled = assembleV1Agent({
    bridge,
    session,
    maxTurns: 8,
    modelTag: "faux-cap",
    approval: { kind: "headless" },
    steeringMode: "all",
    followUpMode: "all",
    contextTokens: 24_000,
    keepRecentTokens: 8_000,
    ...overrides,
  });
  return { ...assembled, bridge };
};

// ---------------------------------------------------------------- A2 问答轨

describe("批 P 增补 A2：审批问答轨（确认卡四 verdict）", () => {
  it("A2-s surface 解析：allow/deny/suspend/abort 四径＋无法解析/流关闭 → suspended（未决非否决）", async () => {
    const cases: Array<[string, string]> = [
      ["allow", "granted"],
      ["deny", "denied"],
      ["suspend", "suspended"],
      ["abort", "aborted"],
      ["乱输入", "suspended"],
    ];
    for (const [line, expected] of cases) {
      const input = new PassThrough();
      const output = new PassThrough();
      const surface = createInteractiveApprovalSurface({ input, output, timeoutMs: 5_000 });
      const pending = surface.ask({ tool: "atf_gate", params_digest: "d", audit_key: "k" });
      input.write(`${line}\n`);
      expect((await pending).kind).toBe(expected);
    }
    // 流关闭 → suspended
    const input = new PassThrough();
    const surface = createInteractiveApprovalSurface({ input, output: new PassThrough(), timeoutMs: 5_000 });
    const pending = surface.ask({ tool: "atf_gate", params_digest: "d", audit_key: "k" });
    input.end();
    expect((await pending).kind).toBe("suspended");
    // 超时 → suspended（未决非否决）
    const timeoutSurface = createInteractiveApprovalSurface({ input: new PassThrough(), output: new PassThrough(), timeoutMs: 20 });
    expect((await timeoutSurface.ask({ tool: "t", params_digest: "d", audit_key: "k" })).kind).toBe("suspended");
  });

  it("A2-h hook 四 verdict：granted 走账本预录→消费放行；denied 非终局回填；suspended/aborted terminate", async () => {
    const bridge = await spawnMock();
    const audit: import("../../src/agent/approvalHook.js").ApprovalAuditEntry[] = [];
    const { createApprovalBeforeToolCall } = await import("../../src/agent/approvalHook.js");
    const scopeRefBox = { current: { project_id: "p", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never };
    const ctx = {
      toolCall: { id: "t1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } },
      args: { gate: "G1", action: "advance" },
    } as unknown as Parameters<ReturnType<typeof createApprovalBeforeToolCall>>[0];

    const stubSurface = (kind: "granted" | "denied" | "suspended" | "aborted"): ApprovalSurface => ({
      ask: async () => ({ kind }) as never,
    });

    const grantedHook = createApprovalBeforeToolCall({ bridge, scopeRefBox, audit, surface: stubSurface("granted") });
    expect(await grantedHook(ctx)).toBeUndefined(); // 预录→查询→消费→放行
    expect(audit.at(-1)?.verdict).toBe("allow_surface_ledger");

    const deniedHook = createApprovalBeforeToolCall({ bridge, scopeRefBox, audit, surface: stubSurface("denied") });
    const denied = await deniedHook(ctx);
    expect(denied?.block).toBe(true);
    expect(denied?.terminate).toBeUndefined(); // 否决＝非终局结构化回填
    expect(audit.at(-1)?.verdict).toBe("blocked_denied");

    const suspendedHook = createApprovalBeforeToolCall({ bridge, scopeRefBox, audit, surface: stubSurface("suspended") });
    const suspended = await suspendedHook(ctx);
    expect(suspended?.terminate).toBe(true);
    expect(audit.at(-1)?.verdict).toBe("suspended");

    const abortedHook = createApprovalBeforeToolCall({ bridge, scopeRefBox, audit, surface: stubSurface("aborted") });
    const aborted = await abortedHook(ctx);
    expect(aborted?.terminate).toBe(true);
    expect(audit.at(-1)?.verdict).toBe("aborted");
  });

  it("A2-e2e CLI 退出码：interactive granted → 0；suspended → 75；aborted → 79", async () => {
    const script = [
      fauxMessageWithToolCalls("先查状态。", [{ id: "c0", name: "atf_workspace_status", arguments: {} }]),
      fauxMessageWithToolCalls("推进 G1。", [{ id: "c1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("闸门已推进。"),
    ];
    const run = async (verdict: "granted" | "suspended" | "aborted"): Promise<number> => {
      const bridge = await spawnMock();
      const root = await mkdtemp(join(tmpdir(), "v1cap-a2-"));
      return runV1Headless({
        bridge,
        sessionsRoot: root,
        instruction: "推进 G1",
        maxTurns: 8,
        scripted: script,
        approval: { kind: "surface", surface: { ask: async () => ({ kind: verdict }) as never } },
        steeringMode: "all",
        followUpMode: "all",
        contextTokens: 24_000,
        keepRecentTokens: 8_000,
        out: () => undefined,
        err: () => undefined,
      });
    };
    expect(await run("granted")).toBe(0);
    expect(await run("suspended")).toBe(75);
    expect(await run("aborted")).toBe(79);
  });
});

// ---------------------------------------------------------------- B1/B2/B6

describe("批 P 增补 B1/B2/B6：双队列、生命周期、审批窗口输入缓冲", () => {
  it("B1 steer/followUp：steer 队列逐请求注入；followUp 停止前续跑；one-at-a-time 每请求只放行最旧", async () => {
    // steer（all 模式）：prompt 前入队 → 首请求前一次全部注入
    const steerCap = capturing([fauxMessageWithToolCalls("", [{ id: "c", name: "atf_fact_scan", arguments: {} }]), fauxFinalAnswer("完")]);
    const s1 = await assemble({ streamFn: steerCap.fn });
    s1.agent.steer(userText("（steer）中途指令"));
    await s1.agent.prompt("开始");
    expect(JSON.stringify(steerCap.contexts[0])).toContain("（steer）中途指令");

    // followUp：本应停止（final）→ 队列非空续跑
    const followCap = capturing([fauxFinalAnswer("第一收"), fauxFinalAnswer("第二收")]);
    const s2 = await assemble({ streamFn: followCap.fn });
    s2.agent.followUp(userText("（followUp）追加指令"));
    await s2.agent.prompt("开始");
    expect(followCap.contexts.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(followCap.contexts.at(-1))).toContain("（followUp）追加指令");

    // one-at-a-time：每请求 poll 只放行最旧一条（库实证语义——steer 逐请求注入）
    const otcap = capturing([fauxFinalAnswer("收一"), fauxFinalAnswer("收二")]);
    const s3 = await assemble({ streamFn: otcap.fn, steeringMode: "one-at-a-time" as QueueMode });
    s3.agent.steer(userText("（steer-1）"));
    s3.agent.steer(userText("（steer-2）"));
    await s3.agent.prompt("开始");
    const first = JSON.stringify(otcap.contexts[0] ?? "");
    expect(first).toContain("（steer-1）");
    expect(first).not.toContain("（steer-2）"); // 每请求一条：最旧出队，steer-2 留队至下次 poll
    expect(JSON.stringify(otcap.contexts.at(-1))).toContain("（steer-2）"); // 随后放行不丢弃
  });

  it("B2 abort/waitForIdle/reset：中止硬退出（stopReason aborted）、等待空闲、重置回基线", async () => {
    const cap = capturing([fauxFinalAnswer("不应到达")]);
    const s = await assemble({ streamFn: cap.fn });
    const started = s.agent.prompt("开始");
    s.agent.abort();
    await started;
    await s.agent.waitForIdle();
    expect(s.agent.state.isStreaming).toBe(false);
    const before = s.agent.state.messages.length;
    s.agent.reset();
    expect(s.agent.state.messages.length).toBeLessThanOrEqual(before);
    expect(s.agent.hasQueuedMessages()).toBe(false);
  });

  it("B6 审批窗口输入缓冲：surface 未决期间 steer 入队，放行后下一请求不丢弃", async () => {
    let askedResolve: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => {
      askedResolve = resolve;
    });
    let grantResolve: (v: { kind: "granted" }) => void = () => undefined;
    const grant = new Promise<{ kind: "granted" }>((resolve) => {
      grantResolve = resolve;
    });
    const surface: ApprovalSurface = {
      ask: async () => {
        askedResolve?.();
        return grant;
      },
    };
    const cap = capturing([
      fauxMessageWithToolCalls("先查状态。", [{ id: "c0", name: "atf_workspace_status", arguments: {} }]),
      fauxMessageWithToolCalls("推进 G1。", [{ id: "c1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("闸门已推进。"),
    ]);
    const bridge = await spawnMock();
    const { session } = await makeSession();
    const s = assembleV1Agent({
      bridge,
      session,
      maxTurns: 8,
      modelTag: "faux-cap",
      approval: { kind: "surface", surface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: cap.fn,
    });
    const run = s.agent.prompt("推进 G1");
    await asked; // 审批窗口已打开（确认卡未决）
    s.agent.steer(userText("（审批窗口期输入）顺带看事实索引"));
    grantResolve({ kind: "granted" });
    await run;
    const lastCtx = JSON.stringify(cap.contexts.at(-1) ?? {});
    expect(lastCtx).toContain("（审批窗口期输入）"); // B6：窗口期输入入队不丢弃
    expect(s.audit.some((entry) => entry.verdict === "allow_surface_ledger")).toBe(true);
  });
});

// ---------------------------------------------------------------- B3/B4/B5

describe("批 P 增补 B3/B4/B5：compaction、hook 注册面 8 名、skills sections", () => {
  it("B3 compaction：超阈值折叠（faux 摘要头＋尾部保留＋不切 toolResult 半边）＋before_compaction hook 触发；低阈值原样", async () => {
    const registry = createHookRegistry();
    let compactionEvents = 0;
    registry.register("before_compaction", () => {
      compactionEvents += 1;
    });
    const long: AgentMessage[] = [
      userText("早期指令 A"),
      { role: "assistant", content: [{ type: "text", text: "早期回复（较长内容以推高 token 估算）".repeat(5) }], timestamp: 1 } as AgentMessage,
      userText("早期指令 B"),
      { role: "assistant", content: [{ type: "toolCall", id: "t", name: "atf_fact_scan", arguments: {} }], timestamp: 1 } as AgentMessage,
      { role: "toolResult", toolCallId: "t", toolName: "atf_fact_scan", content: [{ type: "text", text: "结果" }], timestamp: 1 } as AgentMessage,
      userText("最新指令"),
    ];
    const { estimateTokens } = await import("@earendil-works/pi-agent-core");
    const total = long.reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(total).toBeGreaterThan(0);
    const transform = createCompactionTransform({ contextTokenLimit: total - 1, keepRecentTokens: 1, registry });
    const compacted = await transform(long);
    expect(compactionEvents).toBe(1);
    expect((compacted[0] as { role: string }).role).toBe("system");
    expect(JSON.stringify(compacted[0])).toContain("compaction 折叠摘要");
    expect((compacted.at(-1) as { content: string }).content).toBe("最新指令");
    // 保留段头部不切 toolResult 半边
    for (const message of compacted.slice(1)) {
      if ((message as { role: string }).role === "toolResult") throw new Error("保留段头部含 toolResult（配对被切）");
      break;
    }
    // 低于阈值原样
    const passthrough = await createCompactionTransform({ contextTokenLimit: 10_000, keepRecentTokens: 100, registry })(long.slice(0, 1));
    expect(passthrough).toEqual(long.slice(0, 1));
    await expect(fauxSummarizer([])).resolves.toContain("faux");
  });

  it("B4 hook 注册面：8 名全注册（缺省观测体）＋before_run 实调（registerHooks 缝）", async () => {
    const cap = capturing([fauxFinalAnswer("完")]);
    const s = await assemble({ streamFn: cap.fn });
    expect(s.registry.names()).toEqual([...V1_HOOK_NAMES]);
    expect(s.registry.registeredCount()).toBeGreaterThanOrEqual(8);
    let beforeRunSeen: unknown;
    const spawned = await spawnMock();
    const root = await mkdtemp(join(tmpdir(), "v1cap-b4-"));
    const code = await runV1Headless({
      bridge: spawned,
      sessionsRoot: root,
      instruction: "hi",
      maxTurns: 8,
      scripted: [fauxFinalAnswer("完")],
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      registerHooks: (registry) => {
        registry.register("before_run", (payload) => {
          beforeRunSeen = payload;
        });
      },
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(0);
    expect(beforeRunSeen).toMatchObject({ instruction: "hi" });
  });

  it("B5 skills：ATF 技能目录（SKILL.md frontmatter）→ formatSkillsForSystemPrompt 进系统提示 sections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "v1cap-skills-"));
    await mkdir(join(dir, "atf-fake-skill"), { recursive: true });
    await writeFile(
      join(dir, "atf-fake-skill", "SKILL.md"),
      "---\nname: atf-fake-skill\ndescription: 走查用伪技能（B5 挂接断言）\n---\n\n# 伪技能正文\n",
      "utf8",
    );
    const suffix = await buildSkillsSystemSuffix(dir);
    expect(suffix).toContain("atf-fake-skill");
    const cap = capturing([fauxFinalAnswer("完")]);
    const s = await assemble({ streamFn: cap.fn, systemSuffix: suffix });
    await s.agent.prompt("开始");
    const systemMessage = cap.contexts[0]?.find((m) => (m as { role: string }).role === "system");
    expect(JSON.stringify(systemMessage)).toContain("atf-fake-skill");
  });
});
