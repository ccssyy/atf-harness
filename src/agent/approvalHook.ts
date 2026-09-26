/**
 * 门 1a spike（批 P）——审批 before_tool hook（方案丙 §三「hook 挂接层」第一条）。
 *
 * 语义继承主线账本闸（ADR-07 + 契约 v2 审批链键模型，与 core/tools/executor.ts approve()
 * 逐条对应；非重写——canonical schema/键模型/一次性消费纪律全部复用既有导出）：
 *   ① 判定单一出口：requiresApprovalFor（与 executor 消费点同一谓词，含 atf_gate
 *      action 分流谓词）；
 *   ② 账本轨优先：ledger_query 以 scope_ref 定位（链首 = 可消费记录）；命中 →
 *      {approval_ref, record_id} 逐值一致消费（一次性语义对端强制）→ 放行；
 *   ③ fail-closed：无可消费记录 → approval_missing 拦截（headless = exit 78 锚语义，
 *      spike 以 terminate:true 承载 run 级终止——库的 run 终局映射，报告登记）；账本面
 *      故障/消费失败/scope_ref 缺失/未注册工具 → 一律拦截，不猜测授权；
 *   ④ 问答轨（request → 人审 → granted/denied/suspended/aborted）：headless spike 不挂
 *      交互面，缺席即 ③——问答轨编排与挂起/中止的 hook 映射为门 2 工单（report §边界）。
 *
 * 已知最小分叉（如实登记）：查询/消费的调用骨架在本文件内联（约 30 行），复用
 * LEDGER_QUERY_CANONICAL／LEDGER_CONSUME_CANONICAL／approvalKeyFor 既有导出；与
 * ToolExecutor.approve 的合并收口归门 2（不反向改 runner 线文件）。
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { type ScopeRef, proposalApprovalKey, type LedgerRecord } from "../core/tools/approvalKey.js";
import { LEDGER_CONSUME_CANONICAL, LEDGER_QUERY_CANONICAL } from "../core/tools/executor.js";
import { requiresApprovalFor, validateCanonicalOutput } from "../core/tools/index.js";
import type { AtfAgentToolDeps, SpikeBridgeTransport } from "./atfAgentTools.js";
import { toolDefinitionFor } from "./atfAgentTools.js";
import { surfaceVerdictToAudit, type ApprovalSurface } from "./approvalSurface.js";

/** 审批闸审计留痕（spike 演示/测试断言面；门 2 起入会话事件流）。 */
export interface ApprovalAuditEntry {
  tool: string;
  verdict:
    | "allow_readonly"
    | "allow_ledger"
    | "allow_surface_ledger"
    | "blocked_unknown_tool"
    | "blocked_scope_ref_missing"
    | "blocked_ledger_failure"
    | "blocked_approval_missing"
    | "blocked_consume_failure"
    | "blocked_denied"
    | "blocked_track_failed"
    | "suspended"
    | "aborted";
  /** requiresApprovalFor 判定（true = 高危动作过闸；false = 只读直通）。 */
  requiresApproval: boolean;
  detail?: unknown;
}

export interface ApprovalHookDeps extends AtfAgentToolDeps {
  /** 审计数组（调用方持有；spike 演示打印/测试断言）。 */
  audit: ApprovalAuditEntry[];
  /** 问答轨确认卡 surface（批 P 增补 A2）——缺省无＝headless approval_missing（78）。 */
  surface?: ApprovalSurface;
  /** 豁免面（装配期本地工具——如 dispatch_training_subtask：派发动作本身免审批，
   *  治理点在子任务内写动作过同一账本闸；不在 TOOL_DEFINITIONS 的本地工具须显式登记）。 */
  exemptTools?: readonly string[];
  /** 账本闸临界区锁（v2 并行 fan-out 前提）：共享同一 bridge/scope_ref 的并发执行体
   *  （主链＋并行子任务）经同一 lock 串行化「query→(问答轨预录)→consume」临界段——
   *  并发不破坏账本 watermark 语义（逐条确认卡、逐条消费、授权对象不错位）。
   *  缺省无锁＝单执行体顺序执行（既有语义零变化）。锁不放行任何动作——只串行化闸段。 */
  gateLock?: GateLock;
  /** F5 4.2（2026-09-26）：脚本类提案问答轨 key 的内容摘要解析器（fs 半边由装配线按
   *  FileToolHost roots 注入，proposalContent.createProposalContentDigestFor）。缺省不
   *  注入＝key 派生与既有逐位一致（零回归）。只改提案 key，不改任何放行判定。 */
  contentDigestFor?: (tool: string, params: unknown) => Promise<string | undefined>;
}

/** 账本闸临界区锁（task-of-once 互斥；错误不滞留锁队列）。 */
export interface GateLock {
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>;
}

export const createGateLock = (): GateLock => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn, fn);
      tail = next.catch(() => undefined);
      return next;
    },
  };
};

/** 拦截结果（terminate = run 级终止意图：headless 78 锚语义的库内映射——单调用批次下
 *  terminate 即整批终局。门 2 引入问答轨后 suspended/denied 类不再 terminate）。 */
const block = (reason: string): BeforeToolCallResult => ({ block: true, reason, terminate: true });

/** 组装 beforeToolCall hook（Agent 构造参数 beforeToolCall 直用）。 */
export const createApprovalBeforeToolCall =
  (deps: ApprovalHookDeps) =>
  async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    const params = context.args;
    if ((deps.exemptTools ?? []).includes(toolName)) {
      deps.audit.push({ tool: toolName, verdict: "allow_readonly", requiresApproval: false, detail: { why: "装配期本地工具（豁免面）" } });
      return undefined;
    }
    // 全 face 查找单点（丙 v2 A7 起：桥接面＋本地治理面——本地工具同样入闸，不脱治理）
    const definition = toolDefinitionFor(toolName);
    if (definition === undefined) {
      deps.audit.push({ tool: toolName, verdict: "blocked_unknown_tool", requiresApproval: true, detail: { why: "工具面收敛（fail-closed）" } });
      return block(`未注册工具（工具面收敛，fail-closed）: ${toolName}`);
    }
    const requiresApproval = requiresApprovalFor(definition, params);
    if (!requiresApproval) {
      deps.audit.push({ tool: toolName, verdict: "allow_readonly", requiresApproval: false });
      return undefined; // 只读直通（与 executor：requiresApprovalFor=false 时跳过审批一致）
    }

    // ---- 高危动作审批闸（主线 approve() 的 hook 形态；v2 起闸段封装为临界段）----
    // 并发执行体（主链＋并行 fan-out 子任务）共享闸锁时串行化「query→(问答轨预录)→
    // consume」——锁不放行任何动作，只防并发交叉消费破坏账本 watermark 语义（逐条
    // 确认卡、授权对象不错位）。缺省无锁＝单执行体顺序执行，语义零变化。
    const runGate = async (): Promise<BeforeToolCallResult | undefined> => {
    // F5 4.2：问答轨提案 key 派生纳入脚本内容摘要（同路径重写 → key 必变）；缺省/非脚本类
    // 与既有 approvalKeyFor 逐位一致。params_digest（审计/账本 evidence_refs 消费面）不变。
    const proposalKey = proposalApprovalKey(
      toolName,
      params,
      deps.contentDigestFor !== undefined ? await deps.contentDigestFor(toolName, params) : undefined,
    );
    const auditKey = { tool: toolName, params_digest: proposalKey.params_digest };
    if (deps.scopeRefBox.current === undefined) {
      deps.audit.push({ tool: toolName, verdict: "blocked_scope_ref_missing", requiresApproval: true, detail: { audit_key: auditKey.params_digest } });
      return block(`审批账本查询缺少 scope_ref（契约 v2 定位键）——先经 atf_workspace_status 获取；fail-closed 不猜测: ${toolName}`);
    }
    const queried = await requestCanonical(deps.bridge, "ledger_query", { scope_ref: deps.scopeRefBox.current }, LEDGER_QUERY_CANONICAL);
    if (!queried.ok) {
      // 账本面故障/schema 违规 = 无法确认授权状态 → fail-closed（主线同语义）
      deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { code: queried.code } });
      return block(`账本查询失败（${queried.code}）——无法确认授权状态，fail-closed: ${toolName}`);
    }
    const records = queried.value.records;
    const live = records[0];
    if (live === undefined && deps.surface !== undefined) {
      // ---- 问答轨（批 P 增补 A2）：确认卡四 verdict；granted 经账本预录→消费统一径 ----
      let verdict: Awaited<ReturnType<ApprovalSurface["ask"]>>;
      try {
        verdict = await deps.surface.ask({
          tool: toolName,
          params_digest: auditKey.params_digest,
          audit_key: proposalKey.approval_key,
          ...(proposalKey.content_digest !== undefined ? { content_digest: proposalKey.content_digest } : {}),
        });
      } catch {
        deps.audit.push({ tool: toolName, verdict: "blocked_track_failed", requiresApproval: true, detail: { why: "surface 故障" } });
        return { block: true, reason: `问答轨 surface 故障——fail-closed 不放行: ${toolName}` };
      }
      deps.audit.push({ tool: toolName, verdict: surfaceVerdictToAudit(verdict), requiresApproval: true, detail: { audit_key: auditKey.params_digest } });
      if (verdict.kind === "denied") {
        // 否决＝结构化回填非终局（模型可换路径；DENIAL_LOOP_LIMIT 语义归门 2）
        return { block: true, reason: `操作员否决（denied）: ${toolName}——请如实转述并停止该路径` };
      }
      if (verdict.kind === "suspended" || verdict.kind === "aborted") {
        // 挂起（75）/中止（79）＝run 级终局（terminate；问答轨语义的库内映射）
        return block(
          verdict.kind === "suspended"
            ? `审批挂起（suspended）：操作员未决——run 以 exit 75 收口（超时/未决非否决）: ${toolName}`
            : `审批中止（aborted）：操作员中止——run 以 exit 79 收口: ${toolName}`,
        );
      }
      // granted：持久化前置＝账本预录（操作员面经同一账本；一次性消费语义不变）
      const recorded = await requestCanonical(
        deps.bridge,
        "ledger_record",
        {
          scope_ref: deps.scopeRefBox.current,
          command_id: `surface-${Date.now()}`,
          actor: "surface-operator",
          operation_id: toolName,
          attempt_id: "1",
          subject_ref: `${toolName}:${auditKey.params_digest.slice(0, 12)}`,
          evidence_refs: [auditKey.params_digest],
        },
        LEDGER_RECORD_CANONICAL,
      );
      if (!recorded.ok) {
        deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { code: recorded.code, why: "granted 预录失败" } });
        return block(`放行预录失败（${recorded.code}）——fail-closed 不放行: ${toolName}`);
      }
      const reQueried = await requestCanonical(deps.bridge, "ledger_query", { scope_ref: deps.scopeRefBox.current }, LEDGER_QUERY_CANONICAL);
      const reLive = reQueried.ok ? reQueried.value.records[0] : undefined;
      if (!reQueried.ok || reLive === undefined) {
        deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { why: "granted 预录后无可消费记录" } });
        return block(`放行预录后账本无可消费记录——fail-closed: ${toolName}`);
      }
      const reConsumed = await requestCanonical(deps.bridge, "ledger_consume", { approval_ref: reLive.approval_id, record_id: reLive.record_id }, LEDGER_CONSUME_CANONICAL);
      if (!reConsumed.ok) {
        deps.audit.push({ tool: toolName, verdict: "blocked_consume_failure", requiresApproval: true, detail: { code: reConsumed.code } });
        return block(`审批消费失败（${reConsumed.code}）——一次性语义 fail-closed: ${toolName}`);
      }
      return undefined; // 问答轨放行 → 工具执行
    }
    if (live === undefined) {
      deps.audit.push({
        tool: toolName,
        verdict: "blocked_approval_missing",
        requiresApproval: true,
        detail: { audit_key: auditKey.params_digest, ledger_records: records },
      });
      return block(
        `审批缺失：账本无可消费记录（tool=${toolName}）——headless 下进程须以 exit 78 终止（ADR-07；无有效授权的高危动作一律拒绝）`,
      );
    }
    const consumed = await requestCanonical(deps.bridge, "ledger_consume", { approval_ref: live.approval_id, record_id: live.record_id }, LEDGER_CONSUME_CANONICAL);
    if (!consumed.ok) {
      // 预录存在但消费失败（已被吃/不匹配/不存在/schema 违规）→ 授权不可用 → fail-closed（主线同语义）
      deps.audit.push({ tool: toolName, verdict: "blocked_consume_failure", requiresApproval: true, detail: { code: consumed.code } });
      return block(`审批消费失败（${consumed.code}）——一次性语义 fail-closed: ${toolName}`);
    }
    deps.audit.push({ tool: toolName, verdict: "allow_ledger", requiresApproval: true, detail: { record_id: live.record_id } });
    return undefined; // 账本放行 → 工具执行
    };
    return deps.gateLock !== undefined ? deps.gateLock.run(runGate) : runGate();
  };

/** ledger_record canonical（契约 v2 审批链 §13.8 形态；问答轨 granted 持久化前置消费）。 */
const LEDGER_RECORD_CANONICAL = {
  type: "object",
  required: ["ok", "command_id", "record_id", "state"],
  properties: {
    ok: { const: true },
    command_id: { type: "string" },
    record_id: { type: "string" },
    state: { type: "string" },
  },
} as const;

/** 桥接请求 + canonical 校验（与 executor.request 同型；失败折叠 {ok:false, code}）。 */
const requestCanonical = async (
  bridge: SpikeBridgeTransport,
  method: string,
  params: unknown,
  canonical: Parameters<typeof validateCanonicalOutput>[1],
): Promise<{ ok: true; value: { records: LedgerRecord[]; ok: true; record_id: string; state: string } } | { ok: false; code: string }> => {
  const response = await bridge.request(method, params);
  if (!response.ok) return { ok: false, code: response.error.code };
  const canonicalCheck = validateCanonicalOutput(method, canonical, response.value);
  if (!canonicalCheck.ok) return { ok: false, code: canonicalCheck.error.code };
  return { ok: true, value: response.value as { records: LedgerRecord[]; ok: true; record_id: string; state: string } };
};
