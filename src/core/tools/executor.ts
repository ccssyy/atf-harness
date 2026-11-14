/**
 * ToolExecutor（任务书 S3-3/3-4）：工具执行管线——
 *   定义解析 → 参数白名单校验 →（须审批时）ledger_query → ledger_consume →
 *   桥接执行 → canonical output 校验。
 * 四种终态穷尽互斥（fail-closed，无任何自动应答路径，ADR-07），execute 永不抛出：
 *   - executed：canonical output 已校验通过；
 *   - blocked：审批轨拒绝（approval_missing，headless 退出码锚点 78）；
 *   - rejected：对端业务拒绝（结构化回填，供 Faux 场景断言失败路径）；
 *   - failed：harness/桥接侧故障或 schema 违规（不猜测成功）。
 * 账本经桥接方法查询/消费（不直读文件）；ledger 方法自身 result 也过 canonical 校验。
 * 契约 v2（2026-09-13 契约修订）：审批账本改用内核审批链键模型——ledger_query 以
 * scope_ref(+operation_id) 定位并默认只取可消费记录，ledger_consume 以
 * {approval_ref, record_id} 逐值一致消费；{tool, params_digest} 仅为审计检索辅助
 * （approval_key 沿用为问答轨提案键，harness 内部）。
 */
import { type BridgeError } from "../../bridge/index.js";
import { checkSchema, validateCanonicalOutput, type SchemaNode } from "./canonical.js";
import { rpcMethodFor } from "./methodOverrides.js";
import { type ScopeRef } from "./approvalKey.js";
import { requiresUserConfirmationOf } from "./toolDefinition.js";
import { approvalTrackBlock, toolError, toolErrorFromBridge, type ToolBlock, type ToolError } from "./errors.js";
import { type ToolRegistry } from "./registry.js";
import { type LocalToolHandler, type LocalToolHost } from "./workspaceTools.js";
import type { ToolDefinition } from "./toolDefinition.js";

/** 单次工具执行的结果(Phase 1 四态 + P2-S2 问答轨两终态 + 快修批 D-a 入参违规):
 *  - executed/blocked/rejected/failed:Phase 1 既有语义零改动;
 *  - suspended:问答轨 timeout → run 挂起(exit 75,非终态可恢复,「超时非否决」);
 *  - aborted:应答 verdict=abort 或拒绝循环升级 → run 终态(exit 79);
 *  - input_violation:模型入参违反模型可见 schema(入参校验点位产出,未触桥接请求——
 *    R-1 精度约束:E2 回流判定锚定此点位,禁止与 E3 canonical 输出校验失败按错误码混同)。
 *  blocked 的问答轨子类(denied / credential_consumed / credential_invalid)为结构化回填:
 *  模型可换路径继续,由 runner 按 block.reason 分流,不是 run 终局。 */
export type ToolCallOutcome =
  | { kind: "executed"; tool: string; result: unknown }
  | { kind: "blocked"; block: ToolBlock }
  | { kind: "rejected"; tool: string; reason: string; detail?: unknown }
  | { kind: "input_violation"; tool: string; reason: string; detail?: unknown }
  | { kind: "failed"; error: ToolError }
  | { kind: "suspended"; tool: string; block: ToolBlock }
  | { kind: "aborted"; tool: string; block: ToolBlock };

/** headless 退出码锚点(ADR-07 + 决议 §2.2):0 = 成功;78 = approval_missing(不挪用);
 *  75 = suspended;79 = aborted;其余 block/故障 = 1。S5 冒烟 runner 的进程退出码必须
 *  经由本函数决出——单一出口,防语义漂移。 */
export const resolveHeadlessExitCode = (outcome: ToolCallOutcome): 0 | 1 | 75 | 78 | 79 => {
  switch (outcome.kind) {
    case "executed":
      return 0;
    case "blocked":
      return outcome.block.exit_code; // approval_missing 恒 78;问答轨按原因映射 1/75/79
    case "rejected":
    case "input_violation":
    case "failed":
      return 1;
    case "suspended":
      return 75;
    case "aborted":
      return 79;
  }
};

/**
 * 问答轨审批 gate(P2-S2):由 runner 层编排器实现(handler 闭包持有会话/桩对端/水位线),
 * executor 仅消费其结论。账本轨优先在 approve() 内先行,handler 仅在账本未命中时被调用。
 * 纪律:handler 内部不得使用 setup 基建;granted 放行的持久化前置由 handler 承担(设计 v1.1 R2)。
 */
export type ApprovalTrackVerdict =
  | { kind: "granted" }
  | { kind: "denied"; block: ToolBlock }
  | { kind: "reproposal"; block: ToolBlock }
  | { kind: "blocked"; block: ToolBlock }
  | { kind: "suspended"; block: ToolBlock }
  | { kind: "aborted"; block: ToolBlock };

export interface ApprovalGate {
  handler: (input: { tool: string; params: unknown }) => Promise<ApprovalTrackVerdict>;
}

/** 工具执行所需的桥接最小面（AtfBridgeConnection 结构满足；测试可用桩注入）。 */
export interface BridgeTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

// ADR-0022：ApprovalGate.handler 入参收缩为 {tool, params}——原 approval_key/content_digest
// 提案键面随审批授权轨退役（确认卡不再派生账本定位键）。

// toolName → RPC method 显式映射已单源化至 ./methodOverrides.ts（批㊶-H 共享内核收口；
// 本行 import 的 rpcMethodFor 即唯一折叠出口，守护测试锚两线一致性）。

export class ToolExecutor {
  public constructor(
    private readonly connection: BridgeTransport,
    private readonly registry: ToolRegistry,
    /** 作用域引用（契约 v2）：须审批工具的账本查询定位键；缺省时须审批调用 fail-closed。 */
    private readonly scopeRef?: ScopeRef,
    /** 批 3：本地工具面（工作区工具）——命中分派表则在审批闸后本地执行、不经桥接。
     *  缺省不注入＝既有桥接行为逐位不变（MCP/ACP 零改动）。
     *  F5 4.2：contentDigestFor 可选注入——脚本类提案问答轨 key 的内容摘要解析器
     *  （fs 半边见 proposalContent.ts）；缺省不注入＝key 派生与既有逐位一致。 */
    private readonly local?: {
      handlers: Readonly<Record<string, LocalToolHandler>>;
      host: LocalToolHost;
      contentDigestFor?: (tool: string, params: unknown) => Promise<string | undefined>;
    },
  ) {}

  /**
   * L1b B5（§9⑤ 立项切片）：options.operationId 可选透传——批准账本查询（approve 内
   * ledger_query）以 operation_id 过滤（契约 v2 已登记的可选参数，补登零改动；缺省不传
   * ＝既有行为逐位不变）。过滤语义在对端强制，harness 不做客户端二次切片（单一过滤点，
   * 防口径漂移）。
   */
  public async execute(
    toolName: string,
    params: unknown,
    approval?: ApprovalGate,
    options?: { operationId?: string },
  ): Promise<ToolCallOutcome> {
    const definition = this.registry.get(toolName);
    if (!definition.ok) return { kind: "failed", error: definition.error };

    const paramCheck = checkSchema(params ?? {}, definition.value.parameters, toolName);
    if (paramCheck !== null) {
      // D-a E2：入参违规（入参校验点位，未触桥接）——独立 outcome 类别，供 runner 回流模型
      // （R-1：与 E3 canonical 输出校验失败的 failed/schema_violation 结构性区分，不按错误码匹配）
      return {
        kind: "input_violation",
        tool: toolName,
        reason: "schema_violation",
        detail: { tool: toolName, params, message: paramCheck },
      };
    }

    if (requiresUserConfirmationOf(definition.value, params ?? {})) {
      const approvalOutcome = await this.approve(definition.value, params ?? {}, approval);
      if (!approvalOutcome.ok) return approvalOutcome.outcome;
    }

    // 批 3：本地工具分派（工作区工具面）——审批闸之后、桥接之前；canonical 校验同桥接径。
    // 本地 handler 只产 executed/rejected（环境缺口结构化回填，模型可转述；见 workspaceTools 头注）。
    const localHandler = this.local?.handlers[toolName];
    if (localHandler !== undefined && this.local !== undefined) {
      const outcome = await localHandler(params ?? {}, this.local.host);
      if (outcome.kind === "executed") {
        const canonicalCheck = validateCanonicalOutput(toolName, definition.value.canonical_output, outcome.result);
        if (!canonicalCheck.ok) return { kind: "failed", error: canonicalCheck.error };
        return { kind: "executed", tool: toolName, result: outcome.result };
      }
      return { kind: "rejected", tool: toolName, reason: outcome.reason, detail: outcome.detail };
    }

    const invoked = await this.request(rpcMethodFor(toolName), toolName, params ?? {}, definition.value.canonical_output);
    if (invoked.ok) return { kind: "executed", tool: toolName, result: invoked.result };
    if (invoked.rejected !== undefined) return invoked.rejected;
    return { kind: "failed", error: invoked.error ?? toolError("bridge_failure", "工具调用失败（原因未归类）") };
  }

  /**
   * 确认卡检查点（ADR-0022 后）：审批授权轨（账本 query/consume、scope_ref fail-closed、
   * approval_missing 78 终局）已退役——requiresUserConfirmationOf true 的工具经 handler
   * 出业务确认卡等待真人应答；无 handler（headless 无人值守）＝直通留痕（stderr 通报，
   * D284 fail-closed 语义退役），不再拦截。
   */
  private async approve(definition: ToolDefinition, params: unknown, approval?: ApprovalGate): Promise<ApprovalOutcome> {
    if (approval === undefined) {
      process.stderr.write(`[approval] ${definition.name} 确认卡无人可出——直通留痕（ADR-0022）\n`);
      return { ok: true };
    }
    let verdict: ApprovalTrackVerdict;
    try {
      verdict = await approval.handler({ tool: definition.name, params });
    } catch (cause) {
      // 禁止异常穿越边界:编排层故障折算结构化 block(fail-closed,不放行)
      return {
        ok: false,
        outcome: {
          kind: "blocked",
          block: approvalTrackBlock(definition.name, "approval_track_failed", `确认卡编排故障: ${String(cause)}`),
        },
      };
    }
    switch (verdict.kind) {
      case "granted":
        return { ok: true };
      case "suspended":
        return { ok: false, outcome: { kind: "suspended", tool: definition.name, block: verdict.block } };
      case "aborted":
        return { ok: false, outcome: { kind: "aborted", tool: definition.name, block: verdict.block } };
      default:
        // denied / reproposal / blocked:结构化回填(非终局类由 runner 按 block.reason 分流换路径)
        return { ok: false, outcome: { kind: "blocked", block: verdict.block } };
    }
  }

  /** 桥接请求 + canonical 校验（对端 ok=false → rejected 结构化回填；其余折算 failed）。
   *  toolName 与 rpcMethod 分离（R1 D-1）：回填 payload 的 tool 字段恒为模型面工具名。 */
  private async request(
    rpcMethod: string,
    toolName: string,
    params: unknown,
    canonical: SchemaNode,
  ): Promise<
    | { ok: true; result: unknown }
    | { ok: false; rejected?: { kind: "rejected"; tool: string; reason: string; detail?: unknown }; error?: ToolError }
  > {
    const response = await this.connection.request(rpcMethod, params);
    if (!response.ok) {
      const { code } = (response.error.detail ?? {}) as { code?: string };
      if (response.error.code === "request_rejected") {
        // 对端业务拒绝：结构化回填（任务书 S3-4），不折算为 harness 故障
        return { ok: false, rejected: { kind: "rejected", tool: toolName, reason: code ?? "rejected", detail: response.error.detail } };
      }
      return { ok: false, error: toolErrorFromBridge(response.error) };
    }
    const canonicalCheck = validateCanonicalOutput(rpcMethod, canonical, response.value);
    if (!canonicalCheck.ok) return { ok: false, error: canonicalCheck.error };
    return { ok: true, result: response.value };
  }
}

type ApprovalOutcome = { ok: true } | { ok: false; outcome: ToolCallOutcome };

// ledger 双 canonical 已随账本闸骨架迁 core/tools/ledgerGate.ts（批㊶-H 共享内核收口）；
// 此处 re-export 维持既有 import 面（index.ts / approvalHook / MCP 外壳）零变化。
export { LEDGER_CONSUME_CANONICAL, LEDGER_QUERY_CANONICAL } from "./ledgerGate.js";
