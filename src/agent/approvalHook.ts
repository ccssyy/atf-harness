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
 * 已收口（批㊶-H 丙线共享内核收口）：查询/消费的调用骨架（query→比对→consume）单源
 * core/tools/ledgerGate.ts runLedgerGate——本文件与 ToolExecutor.approve 消费同一骨架；
 * 终态映射（audit verdict／BeforeToolCallResult vs ToolCallOutcome 的词汇面）按批㊱A
 * 结论维持两线并存（骨架面收口，词汇面不合并）。
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { type ScopeRef, proposalApprovalKey, type LedgerRecord } from "../core/tools/approvalKey.js";
import { runLedgerGate } from "../core/tools/ledgerGate.js";
import { requiresApprovalFor, validateCanonicalOutput } from "../core/tools/index.js";
import type { AtfAgentToolDeps, SpikeBridgeTransport } from "./atfAgentTools.js";
import { toolDefinitionFor } from "./atfAgentTools.js";
import { surfaceVerdictToAudit, type ApprovalSurface } from "./approvalSurface.js";
import { buildApprovalAuditStreamEntry, type ApprovalAuditSource, type ApprovalAuditStream } from "./approvalAudit.js";

/**
 * 审批闸审计留痕（双面）：内存数组＝进程内消费面（终局判定/子任务分类/测试断言）；
 * session custom entry 留痕＝持久审计面（批㊳ 1.1，命名空间 approval_audit，best-effort
 * fail-open——写失败不阻断审批流，见 approvalAudit.ts 文件头；欠账③闭合）。
 */
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
  /** 批㊳ 1.1：审批留痕入流（过闸判定 → approval_audit custom entry；best-effort
   *  fail-open）。缺省不注入＝纯内存留痕（既有行为零变化；装配线经 cli.ts 注入）。 */
  auditStream?: ApprovalAuditStream;
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

/** 批㊳ 段 1.2（丙线欠账①）：denial 升级阈值——同 proposalApprovalKey 的 denied 计数达
 *  2 → terminate:true 终局 aborted（exit 79），回填文本注明「同一提案多次被拒，已终止」。
 * 计数源＝hook 内存计数（选型依据登记执行报告：①1.1 留痕面为 best-effort fail-open
 * 辅助面，升级判定（治理控制流）不建立在可能丢失的流上——fail-open 不外溢进判定；
 * ②转录面自 1.1 起有 verdict 载体，但其权威性不及甲线 12 事件流（写入失败＝运行失败），
 * 纯推导口径的前提不成立；③子装配（subagent/deferred）各自独立 session 树，转录重放
 * 跨执行体维度同样不可聚合，与内存计数同界）。内存计数与 1.1 留痕入流互补：计数面供
 * 升级判定（进程内精确），流面供审计追溯（持久 best-effort）。 */
export const DENIAL_ESCALATION_LIMIT = 2;

/** 组装 beforeToolCall hook（Agent 构造参数 beforeToolCall 直用）。 */
export const createApprovalBeforeToolCall = (deps: ApprovalHookDeps) => {
  // 1.2 denial 计数（闭包态＝本 hook 实例生命周期；跨执行体各计各的——见 DENIAL_ESCALATION_LIMIT 选型③）
  const denialCounts = new Map<string, number>();
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
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
    // 批㊳ 1.1：过闸判定同步留痕入 session 流（与裁定同时落盘——崩溃后转录可回溯）；
    // best-effort fail-open：写失败不阻断审批流（stderr 由流侧记录）。只读直通/豁免面/
    // 未注册工具拦截无提案键，不入流面（字段闭集纪律，见 approvalAudit.ts）。
    const emitAudit = async (proposalKey: string, verdict: ApprovalAuditEntry["verdict"], source: ApprovalAuditSource): Promise<void> => {
      if (deps.auditStream === undefined) return;
      try {
        await deps.auditStream.write(buildApprovalAuditStreamEntry(proposalKey, verdict, source));
      } catch {
        /* fail-open：注入面异常亦不阻断（approvalAudit.ts 文件头语义） */
      }
    };
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
      await emitAudit(proposalKey.approval_key, "blocked_scope_ref_missing", "ledger");
      return block(`审批账本查询缺少 scope_ref（契约 v2 定位键）——先经 atf_workspace_status 获取；fail-closed 不猜测: ${toolName}`);
    }
    // ---- 账本轨骨架单源（批㊶-H）：query→比对→consume 调用序在 core/tools/ledgerGate.ts
    // runLedgerGate（与 ToolExecutor.approve 同源）；本文件保留终态映射——audit verdict/
    // BeforeToolCallResult 词汇面（批㊱A 两线并存）。scope_ref 经 getter 逐次重读 box，
    // 与收口前逐调用读取逐位一致。----
    return runLedgerGate<BeforeToolCallResult | undefined>(
      deps.bridge,
      () => deps.scopeRefBox.current,
      {
        onQueryFailure: async (failure) => {
          // 账本面故障/schema 违规 = 无法确认授权状态 → fail-closed（主线同语义）
          const code = failure.bridgeError?.code ?? failure.canonicalError?.code ?? "bridge_failure";
          deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { code } });
          await emitAudit(proposalKey.approval_key, "blocked_ledger_failure", "ledger");
          return block(`账本查询失败（${code}）——无法确认授权状态，fail-closed: ${toolName}`);
        },
        onNoRecord: async (records) => {
          if (deps.surface !== undefined) {
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
              await emitAudit(proposalKey.approval_key, "blocked_track_failed", "surface");
              return { block: true, reason: `问答轨 surface 故障——fail-closed 不放行: ${toolName}` };
            }
            deps.audit.push({ tool: toolName, verdict: surfaceVerdictToAudit(verdict), requiresApproval: true, detail: { audit_key: auditKey.params_digest } });
            await emitAudit(proposalKey.approval_key, surfaceVerdictToAudit(verdict), "surface");
            if (verdict.kind === "denied") {
              // 批㊳ 1.2：同提案二次被拒 → 升级终止（exit 79；决议「不静默重试」口径闭合）
              const denialCount = (denialCounts.get(proposalKey.approval_key) ?? 0) + 1;
              denialCounts.set(proposalKey.approval_key, denialCount);
              if (denialCount >= DENIAL_ESCALATION_LIMIT) {
                deps.audit.push({
                  tool: toolName,
                  verdict: "aborted",
                  requiresApproval: true,
                  detail: { why: "denial_escalation", denial_count: denialCount, audit_key: auditKey.params_digest },
                });
                await emitAudit(proposalKey.approval_key, "aborted", "surface");
                return block(`同一提案多次被拒，已终止（denied ×${String(denialCount)}）: ${toolName}——run 以 exit 79 收口`);
              }
              // 否决＝结构化回填非终局（模型可换路径；同提案再次被拒即升级终止，批㊳ 1.2）
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
              await emitAudit(proposalKey.approval_key, "blocked_ledger_failure", "ledger");
              return block(`放行预录失败（${recorded.code}）——fail-closed 不放行: ${toolName}`);
            }
            // 预录后骨架复用（批㊶-H）：重查询→消费同走 runLedgerGate 单源——查询失败/
            // 无可消费记录同折叠「granted 预录后无可消费记录」，消费失败同主轨词汇。
            return runLedgerGate<BeforeToolCallResult | undefined>(
              deps.bridge,
              () => deps.scopeRefBox.current,
              {
                onQueryFailure: async () => {
                  deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { why: "granted 预录后无可消费记录" } });
                  await emitAudit(proposalKey.approval_key, "blocked_ledger_failure", "ledger");
                  return block(`放行预录后账本无可消费记录——fail-closed: ${toolName}`);
                },
                onNoRecord: async () => {
                  deps.audit.push({ tool: toolName, verdict: "blocked_ledger_failure", requiresApproval: true, detail: { why: "granted 预录后无可消费记录" } });
                  await emitAudit(proposalKey.approval_key, "blocked_ledger_failure", "ledger");
                  return block(`放行预录后账本无可消费记录——fail-closed: ${toolName}`);
                },
                onConsumeFailure: async (failure) => {
                  const code = failure.bridgeError?.code ?? failure.canonicalError?.code ?? "bridge_failure";
                  deps.audit.push({ tool: toolName, verdict: "blocked_consume_failure", requiresApproval: true, detail: { code } });
                  await emitAudit(proposalKey.approval_key, "blocked_consume_failure", "ledger");
                  return block(`审批消费失败（${code}）——一次性语义 fail-closed: ${toolName}`);
                },
                onGranted: () => undefined, // 问答轨放行 → 工具执行（surface verdict 已留痕，不重复入账）
              },
            );
          }
          deps.audit.push({
            tool: toolName,
            verdict: "blocked_approval_missing",
            requiresApproval: true,
            detail: { audit_key: auditKey.params_digest, ledger_records: records },
          });
          await emitAudit(proposalKey.approval_key, "blocked_approval_missing", "ledger");
          return block(
            `审批缺失：账本无可消费记录（tool=${toolName}）——headless 下进程须以 exit 78 终止（ADR-07；无有效授权的高危动作一律拒绝）`,
          );
        },
        onConsumeFailure: async (failure) => {
          // 预录存在但消费失败（已被吃/不匹配/不存在/schema 违规）→ 授权不可用 → fail-closed（主线同语义）
          const code = failure.bridgeError?.code ?? failure.canonicalError?.code ?? "bridge_failure";
          deps.audit.push({ tool: toolName, verdict: "blocked_consume_failure", requiresApproval: true, detail: { code } });
          await emitAudit(proposalKey.approval_key, "blocked_consume_failure", "ledger");
          return block(`审批消费失败（${code}）——一次性语义 fail-closed: ${toolName}`);
        },
        onGranted: async (recordId) => {
          deps.audit.push({ tool: toolName, verdict: "allow_ledger", requiresApproval: true, detail: { record_id: recordId } });
          await emitAudit(proposalKey.approval_key, "allow_ledger", "ledger");
          return undefined; // 账本放行 → 工具执行
        },
      },
    );
    };
    return deps.gateLock !== undefined ? deps.gateLock.run(runGate) : runGate();
  };
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
