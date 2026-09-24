/**
 * 门 1a spike（批 P）——最小链场景驱动（裁定停止点：单工具＋三类决策＋审批 hook 走通
 * ＋孤儿/续跑语义演示）。
 *
 * 装配：pi-agent-core Agent（streamFn=faux，零真实模型调用）＋ ATF 工具面（单源投影）
 * ＋ beforeToolCall=审批账本闸 ＋ afterToolCall=TEM 镜像点（占位）＋ JSONL session 树镜像。
 * 桥接对端由调用方注入（tests/演示：mock_atf.mjs 子进程；--peer real：pin 副本真内核）。
 *
 * 场景（一个 Agent、一条桥接连接、四个 prompt 段）：
 *   A 三类决策走通：assistant 文本＋tool_call(atf_workspace_status 经桥)→ toolResult →
 *     final_answer（message 形）；
 *   B 审批拒：atf_gate(action=advance) → 账本空 → approval_missing 拦截（headless 78 锚
 *     语义，terminate 终局）——桥面只见过 ledger_query，atf_gate 零触达；
 *   C 审批放行＋一次性：ledger_record 预录（操作员面等价物）→ hook 查询命中 → consume →
 *     atf_gate 真执行；事后复查账本无可消费记录（一次性语义）；
 *   D 孤儿检测：session 注入崩溃半边（user 指令＋带 toolCall 的 assistant 半边）→
 *     detectOrphanTip 命中 → 库 continue() 对孤儿末边内建拒绝；
 *   E 孤儿恢复/续跑：库级 fork 到孤儿之前（最后完整边 = user 指令）→ 重建转录 →
 *     continue() 续跑到 final_answer。
 *
 * 镜像口径（如实登记）：本 spike 按 run 边界镜像 state.messages 增量；逐拍镜像（事件级）
 * 与 12 类会话事件流的接线归门 2。孤儿半边为显式注入（崩溃等价物）。
 */
import { Agent, BACKGROUND_CONTEXT, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { HARNESS_SYSTEM_PROMPT } from "../llm/systemPrompt.js";
import { approvalParamsDigest, type ScopeRef } from "../core/tools/approvalKey.js";
import { buildSpikeAgentTools, type AtfAgentToolDeps, type SpikeBridgeTransport } from "./atfAgentTools.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "./approvalHook.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "./fauxStream.js";
import {
  createJsonlSessionRepo,
  detectOrphanTip,
  mirrorEvidenceEvent,
  mirrorMessage,
  readBranchEntries,
  recoverFromOrphan,
  transcriptFromEntries,
  type SessionLike,
} from "./sessionMirror.js";

export interface SpikeResult {
  /** 全部 Agent 事件（订阅序，A–E 各段累计）。 */
  events: AgentEvent[];
  /** 审批闸审计（beforeToolCall 判定序）。 */
  approvalAudit: ApprovalAuditEntry[];
  /** 场景断言面（演示输出/测试）。 */
  checks: Record<string, unknown>;
}

export interface SpikeDeps {
  bridge: SpikeBridgeTransport;
  /** session 落盘根（演示/测试传临时目录）。 */
  sessionsRoot: string;
  /** TEM 镜像开关（缺省开——afterToolCall 占位演示）。 */
  temMirror?: boolean;
}

export const runGate1aSpike = async (deps: SpikeDeps): Promise<SpikeResult> => {
  const events: AgentEvent[] = [];
  const approvalAudit: ApprovalAuditEntry[] = [];
  const scopeRefBox: { current: ScopeRef | undefined } = { current: undefined };

  const repo = createJsonlSessionRepo(deps.sessionsRoot);
  const session = await repo.create({ cwd: deps.sessionsRoot }, BACKGROUND_CONTEXT);

  const toolDeps: AtfAgentToolDeps = { bridge: deps.bridge, scopeRefBox };
  const tools: AgentTool[] = buildSpikeAgentTools(toolDeps);

  const agent = new Agent({
    initialState: { systemPrompt: HARNESS_SYSTEM_PROMPT, tools },
    streamFn: createFauxStreamFn([
      // ---- A：文本＋tool_call(status) → final_answer（三类决策；两段模型请求）----
      fauxMessageWithToolCalls("先查询工作区状态。", [{ id: "call-status", name: "atf_workspace_status", arguments: {} }]),
      fauxFinalAnswer("工作区状态已确认：run 就绪、事实计数与 scope_ref 已取得。"),
      // ---- B：高危动作（gate advance）→ 审批闸拒绝（终局；循环不再发起请求）----
      fauxMessageWithToolCalls("尝试推进闸门 G1。", [{ id: "call-gate-deny", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      // ---- C：预录后重试同参 → 账本放行 → 结果回流 → final_answer ----
      fauxMessageWithToolCalls("再次推进闸门 G1（已获授权预录）。", [{ id: "call-gate-allow", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
      fauxFinalAnswer("闸门查询已执行完毕（经账本授权放行，记录一次性消费）。"),
    ]),
    beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox, audit: approvalAudit }),
    afterToolCall:
      deps.temMirror === false
        ? undefined
        : async (toolContext) => {
            await mirrorEvidenceEvent(session, {
              kind: "evidence_event",
              tool: toolContext.toolCall.name,
              ok: !toolContext.isError,
              mirrored_at: new Date().toISOString(),
            });
            return undefined; // 不改写工具结果（镜像只读旁路）
          },
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    events.push(event);
  });

  // ---- A：三类决策走通（单工具经桥）----
  await agent.prompt("启动门 1a 最小链演示：先查询工作区状态。");
  let mirrored = await mirrorTranscriptDelta(session, agent, 0);

  // ---- B：审批拒（approval_missing → 78 锚语义，terminate 终局）----
  await agent.prompt("现在推进 G1 闸门。");
  mirrored = await mirrorTranscriptDelta(session, agent, mirrored);

  // ---- C：账本预录（操作员面等价物经同一桥面）→ 放行 → 一次性消费 ----
  const recorded = await recordApprovalViaBridge(deps.bridge, scopeRefBox);
  if (!recorded.ok) throw new Error(`账本预录失败（fail-closed）: ${recorded.message}`);
  await agent.prompt("已获授权，再次推进 G1 闸门。");
  mirrored = await mirrorTranscriptDelta(session, agent, mirrored);

  const checks: Record<string, unknown> = {
    scenario_a_three_decisions: decisionFormsSeen(events),
    scenario_b_denied: approvalAudit.some((entry) => entry.verdict === "blocked_approval_missing"),
    scenario_c_allowed: approvalAudit.some((entry) => entry.verdict === "allow_ledger"),
    scenario_c_one_shot: await verifyNoConsumableRecords(deps.bridge, scopeRefBox),
  };

  // ---- D：孤儿注入（崩溃等价物）＋库级拒绝判据 ----
  const orphanUserId = await mirrorMessage(session, { role: "user", content: "（崩溃前指令）继续推进闸门。", timestamp: Date.now() });
  void orphanUserId;
  const orphanMessage = fauxMessageWithToolCalls("（崩溃半边）正在执行工具。", [{ id: "call-orphan", name: "atf_workspace_status", arguments: {} }]);
  await mirrorMessage(session, orphanMessage);
  const entriesWithOrphan = await readBranchEntries(session);
  const orphanVerdict = detectOrphanTip(entriesWithOrphan);
  checks["scenario_d_orphan_detected"] = orphanVerdict;

  if (orphanVerdict.orphan) {
    // 库级拒绝判据：转录末边 = assistant 半边 → continue() 抛错（内建层孤儿拒绝）
    const orphanTailAgent = new Agent({ initialState: { tools: [] }, streamFn: createFauxStreamFn([]) });
    orphanTailAgent.state.messages = transcriptFromEntries(entriesWithOrphan);
    let refusal: string | null = null;
    try {
      await orphanTailAgent.continue();
    } catch (cause) {
      refusal = cause instanceof Error ? cause.message : String(cause);
    }
    checks["scenario_d_continue_refusal"] = refusal;

    // ---- E：fork 到孤儿之前（最后完整边 = user 指令）→ 重建转录 → continue() 续跑 ----
    const recovered = await recoverFromOrphan(repo, session.metadata, orphanVerdict.orphanEntryId);
    const recoveredTranscript = transcriptFromEntries(await readBranchEntries(recovered));
    const recoveredTail = recoveredTranscript[recoveredTranscript.length - 1] as { role?: string } | undefined;
    checks["scenario_e_recovered_tail_role"] = recoveredTail?.role ?? null;

    const resumedAgent = new Agent({
      initialState: { systemPrompt: HARNESS_SYSTEM_PROMPT, tools, messages: recoveredTranscript },
      streamFn: createFauxStreamFn([fauxFinalAnswer("孤儿恢复成功：从最后完整边续跑，收束。")]),
      beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox, audit: approvalAudit }),
      toolExecution: "sequential",
    });
    const beforeCount = events.length;
    resumedAgent.subscribe((event) => {
      events.push(event);
    });
    await resumedAgent.continue();
    checks["scenario_e_resumed_events"] = events.length - beforeCount;
    checks["scenario_e_resumed_final"] = lastAssistantText(resumedAgent.state.messages);
    checks["scenario_e_recovered_transcript_roles"] = recoveredTranscript.map((message) => (message as { role?: string }).role ?? "unknown");
  }

  await session.close(BACKGROUND_CONTEXT);

  return { events, approvalAudit, checks };
};

// ---------------------------------------------------------------- 内部

/** run 边界镜像：把 state.messages 的未镜像增量落 session 树。返回新镜像水位。
 *  （spike 口径：按 run 边界镜像；事件级逐拍镜像归门 2——见文件头注记。） */
const mirrorTranscriptDelta = async (session: SessionLike, agent: Agent, waterLine: number): Promise<number> => {
  const messages = agent.state.messages;
  let next = waterLine;
  while (next < messages.length) {
    const message = messages[next];
    if (message === undefined) break;
    await mirrorMessage(session, message);
    next += 1;
  }
  return next;
};

/** 三类决策断言：事件序中已出现 final_answer（纯文本收尾）、tool_call（经桥执行）、
 *  assistant 文本＋工具调用同消息（message＋tool_calls 形）。 */
const decisionFormsSeen = (events: readonly AgentEvent[]): Record<string, boolean> => {
  let finalAnswer = false;
  let toolCallExecuted = false;
  let textWithToolCalls = false;
  for (const event of events) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const content = event.message.content;
      const hasText = content.some((block) => block.type === "text" && block.text.trim() !== "");
      const hasCalls = content.some((block) => block.type === "toolCall");
      if (hasText && hasCalls) textWithToolCalls = true;
    }
    if (event.type === "tool_execution_end" && !event.isError) toolCallExecuted = true;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== "message_end" || event.message.role !== "assistant") continue;
    const content = event.message.content;
    if (content.some((block) => block.type === "toolCall")) break;
    finalAnswer = content.some((block) => block.type === "text" && block.text.trim() !== "");
    break;
  }
  return { message_final_answer: finalAnswer, tool_call_executed: toolCallExecuted, text_with_tool_calls: textWithToolCalls };
};

/** 桥面预录审批（操作员/问答轨 granted 持久化前置的等价物；K4 §13.8 wire 形态）。
 *  evidence_refs 取 params 摘要（真内核要求非空数组；与 runner 测试预录同型）。 */
const recordApprovalViaBridge = async (
  bridge: SpikeBridgeTransport,
  scopeRefBox: { current: ScopeRef | undefined },
): Promise<{ ok: true } | { ok: false; message: string }> => {
  const digest = approvalParamsDigest({ gate: "G1", action: "advance" });
  const recorded = await bridge.request("ledger_record", {
    scope_ref: scopeRefBox.current,
    command_id: `spike-gate-${Date.now()}`,
    actor: "spike-operator",
    operation_id: "atf_gate.advance",
    attempt_id: "1",
    subject_ref: `atf_gate:${digest.slice(0, 12)}`,
    evidence_refs: [digest],
  });
  return recorded.ok ? { ok: true } : { ok: false, message: recorded.error.message };
};

/** 一次性消费断言：C 段消费后账本再查应无可消费记录。 */
const verifyNoConsumableRecords = async (bridge: SpikeBridgeTransport, scopeRefBox: { current: ScopeRef | undefined }): Promise<boolean> => {
  const queried = await bridge.request("ledger_query", { scope_ref: scopeRefBox.current });
  if (!queried.ok) return false;
  const records = (queried.value as { records: Array<{ state: string }> }).records;
  return records.length === 0;
};

/** 末条 assistant 的纯文本（E 段收口断言）。 */
const lastAssistantText = (messages: readonly AgentMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
    if (message?.role !== "assistant") continue;
    return (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
  return null;
};
