/**
 * 门 1b PoC 走通演示（批 P；owner 指令验收第 4 项）——"run A 产经验 → run B 注入 run A
 * 经验"，faux 全程（零真实模型/embedding 调用）。
 *
 * 链路（一个 mock 桥接对端、一个 JSONL session 库）：
 *   run A：status 经桥 → EvidenceEvent 镜像（run_id 捕获）→ gate 账本预录→放行→经桥执行
 *     （blocked 业务态也是经验）→ run 收尾 ExperienceCase 落库（Value 寻址）；
 *   人工提炼面：PatternClaim 追加（ValueList；来源引用＝run A 证据 id）；
 *   run B（新 session）：transform_context 以 run A 的 session 为检索源（同库历史经验；
 *     跨 session 服务化检索归 TEM 服务——设计文档 §五），faux streamFn 捕获 provider 请求
 *     上下文，断言注入 section 到达（含 [tem:<id>] 来源引用）。
 */
import { Agent, BACKGROUND_CONTEXT, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { HARNESS_SYSTEM_PROMPT } from "../../llm/systemPrompt.js";
import type { ScopeRef } from "../../core/tools/approvalKey.js";
import { buildSpikeAgentTools, type SpikeBridgeTransport } from "../atfAgentTools.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "../approvalHook.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls, type FauxStreamFn } from "../fauxStream.js";
import { createJsonlSessionRepo, type SessionLike } from "../sessionMirror.js";
import { envFingerprint, scanEvidenceEvents } from "./evidence.js";
import {
  appendPatternClaim,
  ensureTemBranch,
  readExperienceCase,
  readPatternClaims,
  writeExperienceCase,
  type ExperienceCase,
} from "./store.js";
import { createTemAfterToolMirror, createTemTransformContext, TEM_SECTION_HEADER } from "./retrieval.js";

export interface Gate1bPocResult {
  run_a_evidence_count: number;
  run_a_case: ExperienceCase | undefined;
  claim_written: boolean;
  run_b_injected_section: string | null;
  run_b_events: number;
  all_passed: boolean;
}

/** provider 请求上下文捕获（faux streamFn 缝——断言注入到达模型请求面）。 */
interface CapturingFauxStreamFn extends FauxStreamFn {
  readonly seenContexts: TranscriptContext[];
}

const createCapturingFauxStreamFn = (script: readonly Parameters<typeof createFauxStreamFn>[0][number][]): CapturingFauxStreamFn => {
  const inner = createFauxStreamFn(script);
  const seenContexts: TranscriptContext[] = [];
  const fn = ((model, context, options) => {
    seenContexts.push(context);
    return inner(model, context, options);
  }) as CapturingFauxStreamFn;
  Object.defineProperty(fn, "seenContexts", { get: () => seenContexts, configurable: false });
  Object.defineProperty(fn, "issued", { get: () => inner.issued, configurable: false });
  return fn;
};

export const runGate1bPoc = async (deps: { bridge: SpikeBridgeTransport; sessionsRoot: string }): Promise<Gate1bPocResult> => {
  const repo = createJsonlSessionRepo(deps.sessionsRoot);
  const modelTag = envFingerprint("faux-spike").model;

  // ---- run A：产经验（镜像＋Case 落库）----
  const sessionA = await repo.create({ cwd: deps.sessionsRoot }, BACKGROUND_CONTEXT);
  await ensureTemBranch(sessionA);
  const scopeRefBoxA: { current: ScopeRef | undefined } = { current: undefined };
  const auditA: ApprovalAuditEntry[] = [];
  const toolsA: AgentTool[] = buildSpikeAgentTools({ bridge: deps.bridge, scopeRefBox: scopeRefBoxA });
  const streamFnA = createFauxStreamFn([
    // prompt 1：status call → final（run 结束，scope_ref 已捕获）
    fauxMessageWithToolCalls("查询工作区状态。", [{ id: "poc-call-status", name: "atf_workspace_status", arguments: {} }]),
    fauxFinalAnswer("run A 第一段完成：状态已查。"),
    // prompt 2（预录后）：gate call（账本放行→经桥执行）→ final
    fauxMessageWithToolCalls("推进 G1（已预录授权）。", [{ id: "poc-call-gate", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }]),
    fauxFinalAnswer("run A 完成：闸门已推进。"),
  ]);
  const agentA = new Agent({
    initialState: { systemPrompt: HARNESS_SYSTEM_PROMPT, tools: toolsA },
    streamFn: streamFnA,
    beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox: scopeRefBoxA, audit: auditA }),
    afterToolCall: createTemAfterToolMirror({
      session: sessionA,
      runId: () => scopeRefBoxA.current?.scope_id ?? null,
      model: modelTag,
    }),
    toolExecution: "sequential",
  });
  await agentA.prompt("查询工作区状态。");
  // 账本预录（操作员面等价物；C 径同型）
  const preRecorded = await deps.bridge.request("ledger_record", {
    scope_ref: scopeRefBoxA.current,
    command_id: `poc-gate-${Date.now()}`,
    actor: "poc-operator",
    operation_id: "atf_gate.advance",
    attempt_id: "1",
    subject_ref: "atf_gate:poc-G1",
    evidence_refs: ["poc-evidence"],
  });
  if (!preRecorded.ok) throw new Error(`PoC 账本预录失败（fail-closed）: ${preRecorded.error.message}`);
  await agentA.prompt("推进 G1（已预录授权）。");

  const evidenceA = await scanEvidenceEvents(sessionA);
  const runIdA = scopeRefBoxA.current?.scope_id ?? "unknown-run";
  const caseA: ExperienceCase = {
    kind: "experience_case",
    case_id: `case-${runIdA}`,
    run_id: runIdA,
    closed_at: new Date().toISOString(),
    outcome: "pending",
    evidence_event_ids: evidenceA.map((event) => event.event_id),
    cost: { model_calls: streamFnA.issued },
    env_fingerprint: envFingerprint(modelTag),
  };
  await writeExperienceCase(sessionA, caseA);
  const caseReadBack = await readExperienceCase(sessionA, runIdA);

  // ---- 人工提炼面：PatternClaim 追加（ValueList；来源引用＝run A 证据 id）----
  await appendPatternClaim(sessionA, {
    kind: "pattern_claim",
    claim_id: "claim-poc-g1",
    claim: "G1 准入推进前先经 atf_workspace_status 取 scope_ref，账本预录一次性消费后推进。",
    lane: "data-admission",
    structural_preconditions: ["scope_ref 已捕获", "账本存在可消费记录"],
    source_refs: evidenceA.map((event) => event.event_id).slice(0, 2),
  });

  // ---- run B：新 session；transform_context 以 run A session 为检索源（同库历史经验）----
  const sessionB = await repo.create({ cwd: deps.sessionsRoot }, BACKGROUND_CONTEXT);
  await ensureTemBranch(sessionB);
  const auditB: ApprovalAuditEntry[] = [];
  const scopeRefBoxB: { current: ScopeRef | undefined } = { current: undefined };
  const toolsB: AgentTool[] = buildSpikeAgentTools({ bridge: deps.bridge, scopeRefBox: scopeRefBoxB });
  const streamFnB = createCapturingFauxStreamFn([
    fauxMessageWithToolCalls("准备推进 G1，先看历史经验。", [{ id: "poc-b-status", name: "atf_workspace_status", arguments: {} }]),
    fauxFinalAnswer("已参考历史经验（G1 推进路径）。"),
  ]);
  const retrievalSource: SessionLike = sessionA;
  const agentB = new Agent({
    initialState: { systemPrompt: HARNESS_SYSTEM_PROMPT, tools: toolsB },
    streamFn: streamFnB,
    beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox: scopeRefBoxB, audit: auditB }),
    afterToolCall: createTemAfterToolMirror({
      session: sessionB,
      runId: () => scopeRefBoxB.current?.scope_id ?? null,
      model: modelTag,
    }),
    transformContext: createTemTransformContext({ session: retrievalSource }),
    toolExecution: "sequential",
  });
  const eventsB: AgentEvent[] = [];
  agentB.subscribe((event) => {
    eventsB.push(event);
  });
  await agentB.prompt("准备推进 G1，先看历史经验。");

  // 断言：注入 section 到达 provider 请求面（首请求即应命中——指令含 g1/atf 关键词）
  let injectedSection: string | null = null;
  for (const context of streamFnB.seenContexts) {
    const tem = context.messages.find(
      (message) => message.role === "system" && typeof message.content === "string" && message.content.includes(TEM_SECTION_HEADER),
    );
    if (tem !== undefined && typeof tem.content === "string") {
      injectedSection = tem.content;
      break;
    }
  }

  const claims = await readPatternClaims(retrievalSource);
  const allPassed =
    evidenceA.length >= 2 &&
    caseReadBack !== undefined &&
    caseReadBack.evidence_event_ids.length === evidenceA.length &&
    claims.length === 1 &&
    injectedSection !== null &&
    injectedSection.includes("[tem:") &&
    eventsB.length > 0;

  await sessionA.close(BACKGROUND_CONTEXT);
  await sessionB.close(BACKGROUND_CONTEXT);

  return {
    run_a_evidence_count: evidenceA.length,
    run_a_case: caseReadBack,
    claim_written: claims.length === 1,
    run_b_injected_section: injectedSection,
    run_b_events: eventsB.length,
    all_passed: allPassed === true,
  };
};
