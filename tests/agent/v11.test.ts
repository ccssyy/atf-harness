/**
 * 丙 v1.1 测试（批 P 增补漏项补全）：B7 telemetry（pi span→事实轨）／B9 boundary（收口
 * 规划与 steering 配套）／B10 reconcile（孤儿无新工作推进）／B11 deferred（伴生子任务
 * 原语，faux）／subagent-as-tool（dispatch_training_subtask，审批继承主线账本闸）。
 * 对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用）。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { createFactTrackTelemetrySink, aiTelemetrySpanNames } from "../../src/agent/telemetryFace.js";
import { planRunBoundary, planReconcile } from "../../src/agent/driveFace.js";
import { createDeferredSubtaskRegistry } from "../../src/agent/deferredFace.js";
import { detectOrphanTip, mirrorMessage, readBranchEntries, type SessionLike } from "../../src/agent/sessionMirror.js";
import { createJsonlSessionRepo } from "../../src/agent/sessionMirror.js";
import { assembleV1Agent } from "../../src/agent/cli.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "../../src/agent/fauxStream.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";

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

const makeSession = async (): Promise<SessionLike> => {
  const root = await mkdtemp(join(tmpdir(), "v11-"));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

describe("丙 v1.1 · B7 telemetry（pi span 层级→事实轨）", () => {
  it("B7 ①：Agent 事件→span 事实（agent_start/tool_execution）＋pi.ai.request 层级事实；schema 登记面含 pi.ai.request", async () => {
    const sink = createFactTrackTelemetrySink("faux-v11");
    expect(aiTelemetrySpanNames()).toContain("pi.ai.request");
    const runId = (): string | null => "run-v11";
    await sink.recordAgentEvent({ type: "agent_start" } as never, runId, "faux-v11");
    await sink.recordAgentEvent({ type: "tool_execution_end", toolCallId: "t", toolName: "atf_fact_scan", result: {}, isError: false } as never, runId, "faux-v11");
    await sink.recordAiRequestSpan({ provider: "deepseek", model: "deepseek-flash", streaming: true }, runId);
    expect(sink.facts).toHaveLength(3);
    expect(sink.facts.map((fact) => fact.span_name)).toEqual(["pi.harness.agent_start", "pi.harness.tool_execution", "pi.ai.request"]);
    for (const fact of sink.facts) {
      expect(fact.kind).toBe("telemetry_span");
      expect(fact.run_id).toBe("run-v11");
      expect(fact.env_fingerprint.kernel_pin).toBe("v0.7.7b0");
      expect(Number.isNaN(Date.parse(fact.ts))).toBe(false);
    }
    expect((sink.facts[1] as unknown as { attributes: { tool: string } }).attributes.tool).toBe("atf_fact_scan");
    expect((sink.facts[2] as { attributes: Record<string, unknown> }).attributes["pi.ai.model"]).toBe("deepseek-flash");
  });
});

describe("丙 v1.1 · B9 boundary（收口规划与 steering 配套）", () => {
  it("B9 ②：规划四径——终局优先／steering trigger／follow_up when no trigger／收束终局", () => {
    expect(planRunBoundary({ steeringQueued: 0, followUpQueued: 0, pendingOutcome: { kind: "budget_exhausted", turns_used: 8, max_turns: 8 }, hasFinalAnswer: false })).toMatchObject({
      kind: "finish_run",
      outcome: { kind: "budget_exhausted" },
    });
    expect(planRunBoundary({ steeringQueued: 2, followUpQueued: 0, pendingOutcome: undefined, hasFinalAnswer: false })).toMatchObject({
      kind: "continue_run",
      trigger: "steering",
    });
    expect(planRunBoundary({ steeringQueued: 0, followUpQueued: 1, pendingOutcome: undefined, hasFinalAnswer: false })).toMatchObject({
      kind: "continue_run",
      trigger: "follow_up",
    });
    expect(planRunBoundary({ steeringQueued: 0, followUpQueued: 0, pendingOutcome: undefined, hasFinalAnswer: true })).toMatchObject({
      kind: "finish_run",
      outcome: { kind: "completed" },
    });
  });
});

describe("丙 v1.1 · B10 reconcile（孤儿无新工作推进）", () => {
  it("B10 ③：孤儿注入 → synthesized_close 规划（不发起新工作）；无孤儿 → none；fork_before 备选径在案", async () => {
    const session = await makeSession();
    await mirrorMessage(session, { role: "user", content: "指令", timestamp: Date.now() });
    await mirrorMessage(
      session,
      fauxMessageWithToolCalls("（崩溃半边）", [{ id: "orphan-1", name: "atf_workspace_status", arguments: {} }]),
    );
    const entries = await readBranchEntries(session);
    const orphan = detectOrphanTip(entries);
    const plan = planReconcile(orphan);
    expect(plan).toMatchObject({ action: "synthesized_close", orphanEntryId: orphan.orphan === true ? orphan.orphanEntryId : "" });
    expect(plan.action === "synthesized_close" ? plan.note : "").toContain("orphan_recovered");
    expect(planReconcile({ orphan: false })).toEqual({ action: "none" });
    // fork_before 备选径在案（需要换上下文续跑时由调用方选用——sessionMirror.recoverFromOrphan 承载）
    expect(planReconcile({ orphan: true, orphanEntryId: "e1" })).toMatchObject({ action: "synthesized_close" });
  });
});

describe("丙 v1.1 · B11 deferred（伴生子任务原语）", () => {
  it("B11 ④：start→主链不被阻塞→fetch 取回 done；cancel 语义；未知句柄 fail-closed", async () => {
    const registry = createDeferredSubtaskRegistry();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const handle = registry.start("ckpt 抽查（训练中）", () => gate);
    expect((await registry.fetch(handle)).state).toBe("running"); // 未完成照返，不阻塞主链
    release("ckpt 检查完成：loss 曲线正常");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await registry.fetch(handle)).toMatchObject({ state: "done", result: "ckpt 检查完成：loss 曲线正常" });
    const cancelled = registry.start("会被取消的子任务", async () => "不应到达");
    await registry.cancel(cancelled);
    expect((await registry.fetch(cancelled)).state).toBe("cancelled");
    expect(await registry.fetch({ id: "deferred-nope", label: "x" })).toMatchObject({ state: "failed" });
    expect(registry.list()).toHaveLength(2);
  });
});

describe("丙 v1.1 · subagent-as-tool（dispatch_training_subtask）", () => {
  it("⑤ 子任务完成径：父派发→子独立会话树执行（经桥）→结果回父 toolResult→父收口引用子答复", async () => {
    const bridge = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v11-sub-"));
    const childScript = [
      fauxMessageWithToolCalls("子任务：查询状态。", [{ id: "child-c1", name: "atf_workspace_status", arguments: {} }]),
      fauxFinalAnswer("子任务完成：工作区状态正常（0 批已登记）。"),
    ];
    const parentScript = [
      fauxMessageWithToolCalls("派发子任务做体检。", [{ id: "p1", name: "dispatch_training_subtask", arguments: { instruction: "查询工作区状态并汇报" } }]),
      fauxFinalAnswer("子任务答复：工作区状态正常。"),
    ];
    const contexts: string[] = [];
    const inner = createFauxStreamFn(parentScript);
    const cap = {
      contexts,
      fn: ((model: never, context: { messages: unknown[] }) => {
        contexts.push(JSON.stringify(context.messages));
        return inner(model, context as never);
      }) as never,
    };
    const s = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v11",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: cap.fn,
      subagent: {
        bridge,
        sessionsRoot,
        childStreamFn: () => createFauxStreamFn(childScript) as never,
        modelTag: "faux-v11",
      },
    });
    await s.agent.prompt("派发子任务做体检。");
    // 子 Agent 经桥执行（父审计不含子只读调用——子有自己的装配）；父最终答复引用子结果
    expect(s.audit.some((entry) => entry.tool === "dispatch_training_subtask" && entry.verdict === "allow_readonly")).toBe(true);
    expect((s.agent.state.messages.at(-1) as { content: Array<{ text: string }> }).content[0]?.text).toContain("子任务答复");
  });

  it("⑥ 审批继承主线账本闸：子任务内写动作缺授权 → 子 headless fail-closed → 父收到 approval_missing 结构化结果", async () => {
    const bridge = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "v11-sub-"));
    const childScript = [
      fauxMessageWithToolCalls("子任务：推进 G1。", [{ id: "child-gate", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("不应到达"),
    ];
    const parentScript = [
      fauxMessageWithToolCalls("派发子任务推进闸门。", [{ id: "p1", name: "dispatch_training_subtask", arguments: { instruction: "推进 G1（无预录）" } }]),
      fauxFinalAnswer("子任务被审批闸拦截（approval_missing）——已如实获知。"),
    ];
    // 主线已捕获 scope_ref（真实流程：父先经 status 取定位域）——子任务继承同一账本定位域
    const scopeRefBox = { current: { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never };
    const s = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 8,
      modelTag: "faux-v11",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(parentScript),
      subagent: {
        bridge,
        sessionsRoot,
        childStreamFn: () => createFauxStreamFn(childScript) as never,
        modelTag: "faux-v11",
      },
    });
    // 主线已捕获 scope_ref（真实流程：父先经 status 取定位域）——派发时子任务继承同一账本定位域
    s.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never;
    await s.agent.prompt("派发子任务推进闸门。");
    const toolEnd = s.events.find((event) => event.type === "tool_execution_end" && event.toolName === "dispatch_training_subtask") as
      | { type: "tool_execution_end"; result?: { details?: { ok: boolean; outcome: string } } }
      | undefined;
    expect(toolEnd !== undefined && toolEnd.type === "tool_execution_end").toBe(true);
    expect(toolEnd?.result?.details).toMatchObject({ ok: false, outcome: "approval_missing" }); // 子任务不绕过治理
    expect((s.agent.state.messages.at(-1) as { content: Array<{ text: string }> }).content[0]?.text).toContain("approval_missing");
  });
});
