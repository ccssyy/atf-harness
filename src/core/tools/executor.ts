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
import { approvalKeyFor, type LedgerRecord, type ScopeRef } from "./approvalKey.js";
import { approvalMissingBlock, approvalTrackBlock, toolError, toolErrorFromBridge, type ToolBlock, type ToolError } from "./errors.js";
import { type ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./toolDefinition.js";

/** 单次工具执行的结果(Phase 1 四态 + P2-S2 问答轨两终态):
 *  - executed/blocked/rejected/failed:Phase 1 既有语义零改动;
 *  - suspended:问答轨 timeout → run 挂起(exit 75,非终态可恢复,「超时非否决」);
 *  - aborted:应答 verdict=abort 或拒绝循环升级 → run 终态(exit 79)。
 *  blocked 的问答轨子类(denied / credential_consumed / credential_invalid)为结构化回填:
 *  模型可换路径继续,由 runner 按 block.reason 分流,不是 run 终局。 */
export type ToolCallOutcome =
  | { kind: "executed"; tool: string; result: unknown }
  | { kind: "blocked"; block: ToolBlock }
  | { kind: "rejected"; tool: string; reason: string; detail?: unknown }
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
  handler: (input: { tool: string; params: unknown; approval_key: string }) => Promise<ApprovalTrackVerdict>;
}

/** 工具执行所需的桥接最小面（AtfBridgeConnection 结构满足；测试可用桩注入）。 */
export interface BridgeTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

export class ToolExecutor {
  public constructor(
    private readonly connection: BridgeTransport,
    private readonly registry: ToolRegistry,
    /** 作用域引用（契约 v2）：须审批工具的账本查询定位键；缺省时须审批调用 fail-closed。 */
    private readonly scopeRef?: ScopeRef,
  ) {}

  public async execute(toolName: string, params: unknown, approval?: ApprovalGate): Promise<ToolCallOutcome> {
    const definition = this.registry.get(toolName);
    if (!definition.ok) return { kind: "failed", error: definition.error };

    const paramCheck = checkSchema(params ?? {}, definition.value.parameters, toolName);
    if (paramCheck !== null) {
      return {
        kind: "failed",
        error: toolError("schema_violation", `工具参数违反模型可见 schema: ${paramCheck}`, { tool: toolName, params }),
      };
    }

    if (definition.value.requires_approval) {
      const approvalOutcome = await this.approve(definition.value, params ?? {}, approval);
      if (!approvalOutcome.ok) return approvalOutcome.outcome;
    }

    const invoked = await this.request(toolName, params ?? {}, definition.value.canonical_output);
    if (invoked.ok) return { kind: "executed", tool: toolName, result: invoked.result };
    if (invoked.rejected !== undefined) return invoked.rejected;
    return { kind: "failed", error: invoked.error ?? toolError("bridge_failure", "工具调用失败（原因未归类）") };
  }

  /** 审批检查点(契约 v2 审批链键模型;双轨语义不变):账本轨先以 scope_ref 查询可消费
   *  记录(取链首 sequence 最小者),命中 → {approval_ref, record_id} 消费放行;
   *  无可消费记录 + 无 gate → blocked(approval_missing,Phase 1 逐位一致);
   *  未命中 + gate → 问答轨编排(handler 发起/延续审批会话,granted 附带持久化前置)。
   *  scope_ref 缺省 = harness 配置故障,无法核对授权状态 → failed(fail-closed,不猜测)。 */
  private async approve(definition: ToolDefinition, params: unknown, approval?: ApprovalGate): Promise<ApprovalOutcome> {
    if (this.scopeRef === undefined) {
      return {
        ok: false,
        outcome: {
          kind: "failed",
          error: toolError("scope_ref_missing", `审批账本查询缺少 scope_ref（契约 v2 定位键）: ${definition.name}`, { tool: definition.name }),
        },
      };
    }
    const auditKey = approvalKeyFor(definition.name, params);
    const queried = await this.request("ledger_query", { scope_ref: this.scopeRef }, LEDGER_QUERY_CANONICAL);
    if (!queried.ok) {
      // 账本面故障 = 无法确认授权状态 → fail-closed,不猜测审批通过
      return { ok: false, outcome: { kind: "failed", error: queried.error ?? toolError("bridge_failure", "账本查询失败") } };
    }
    const records = (queried.result as { records: LedgerRecord[] }).records;
    const live = records[0];
    if (live === undefined) {
      if (approval === undefined) {
        return {
          ok: false,
          outcome: {
            kind: "blocked",
            block: approvalMissingBlock(
              definition.name,
              `审批缺失：账本无可消费记录（tool=${definition.name}）——headless 下进程须以 exit 78 终止`,
              { scope_ref: this.scopeRef, audit_key: auditKey, ledger_records: records },
            ),
          },
        };
      }
      // 问答轨(账本未命中且已声明审批面):编排 handler 发起 request → 等待应答 → 分支处置
      let verdict: ApprovalTrackVerdict;
      try {
        verdict = await approval.handler({ tool: definition.name, params, approval_key: auditKey.params_digest });
      } catch (cause) {
        // 禁止异常穿越边界:编排层故障折算结构化 block(fail-closed,不放行)
        return {
          ok: false,
          outcome: {
            kind: "blocked",
            block: approvalTrackBlock(definition.name, "approval_track_failed", `问答轨编排故障: ${String(cause)}`),
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
    // 消费：{approval_ref, record_id} 逐值一致校验（契约 v2；对端强制一次性语义）
    const consumed = await this.request(
      "ledger_consume",
      { approval_ref: live.approval_id, record_id: live.record_id },
      LEDGER_CONSUME_CANONICAL,
    );
    if (consumed.ok) return { ok: true };
    if (consumed.rejected !== undefined) {
      // 预录存在但消费时已被吃掉/不匹配/不存在（一次性语义在对端强制）→ 授权不可用 → blocked
      return {
        ok: false,
        outcome: {
          kind: "blocked",
          block: approvalMissingBlock(definition.name, "审批消费失败（记录已消费、不匹配或不存在）——一次性语义 fail-closed", consumed.rejected),
        },
      };
    }
    return { ok: false, outcome: { kind: "failed", error: consumed.error ?? toolError("bridge_failure", "审批消费失败") } };
  }

  /** 桥接请求 + canonical 校验（对端 ok=false → rejected 结构化回填；其余折算 failed）。 */
  private async request(
    method: string,
    params: unknown,
    canonical: SchemaNode,
  ): Promise<
    | { ok: true; result: unknown }
    | { ok: false; rejected?: { kind: "rejected"; tool: string; reason: string; detail?: unknown }; error?: ToolError }
  > {
    const response = await this.connection.request(method, params);
    if (!response.ok) {
      const { code } = (response.error.detail ?? {}) as { code?: string };
      if (response.error.code === "request_rejected") {
        // 对端业务拒绝：结构化回填（任务书 S3-4），不折算为 harness 故障
        return { ok: false, rejected: { kind: "rejected", tool: method, reason: code ?? "rejected", detail: response.error.detail } };
      }
      return { ok: false, error: toolErrorFromBridge(response.error) };
    }
    const canonicalCheck = validateCanonicalOutput(method, canonical, response.value);
    if (!canonicalCheck.ok) return { ok: false, error: canonicalCheck.error };
    return { ok: true, result: response.value };
  }
}

type ApprovalOutcome = { ok: true } | { ok: false; outcome: ToolCallOutcome };

// ledger 方法自身的 canonical output（与 bridge.contract.yaml methods 段 v2 对等）
const LEDGER_QUERY_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "records"],
  properties: {
    ok: { const: true },
    records: {
      type: "array",
      items: {
        type: "object",
        required: ["record_id", "approval_id", "sequence", "state"],
        properties: {
          record_id: { type: "string" },
          approval_id: { type: "string" },
          sequence: { type: "integer" },
          state: { type: "string" },
          command_id: { type: "string", optional: true },
          actor: { type: "string", optional: true },
          operation_id: { type: "string", optional: true },
          attempt_id: { type: "string", optional: true },
          evidence_refs: { type: "array", optional: true, items: { type: "string" } },
        },
      },
    },
  },
};

const LEDGER_CONSUME_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "record_id", "state"],
  properties: {
    ok: { const: true },
    record_id: { type: "string" },
    state: { const: "consumed" },
  },
};
