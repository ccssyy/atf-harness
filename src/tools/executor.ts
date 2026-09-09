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
 */
import { type BridgeError } from "../bridge/index.js";
import { checkSchema, validateCanonicalOutput, type SchemaNode } from "./canonical.js";
import { approvalKeyFor, type LedgerEntry } from "./approvalKey.js";
import { approvalMissingBlock, toolError, toolErrorFromBridge, type ToolBlock, type ToolError } from "./errors.js";
import { type ToolRegistry } from "./registry.js";
import type { ToolDefinition } from "./toolDefinition.js";

/** 单次工具执行的四终态。 */
export type ToolCallOutcome =
  | { kind: "executed"; tool: string; result: unknown }
  | { kind: "blocked"; block: ToolBlock }
  | { kind: "rejected"; tool: string; reason: string; detail?: unknown }
  | { kind: "failed"; error: ToolError };

/** headless 退出码锚点（owner 口径 #3；ADR-07：78 = 无审批，0 = 成功，其他非零 = 各类 block/故障）。
 *  S5 冒烟 runner 的进程退出码必须经由本函数决出——单一出口，防语义漂移。 */
export const resolveHeadlessExitCode = (outcome: ToolCallOutcome): 0 | 78 | 1 => {
  switch (outcome.kind) {
    case "executed":
      return 0;
    case "blocked":
      return outcome.block.exit_code; // approval_missing 恒 78
    case "rejected":
    case "failed":
      return 1;
  }
};

/** 工具执行所需的桥接最小面（AtfBridgeConnection 结构满足；测试可用桩注入）。 */
export interface BridgeTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

export class ToolExecutor {
  public constructor(
    private readonly connection: BridgeTransport,
    private readonly registry: ToolRegistry,
  ) {}

  public async execute(toolName: string, params: unknown): Promise<ToolCallOutcome> {
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
      const approval = await this.approve(definition.value, params ?? {});
      if (!approval.ok) return approval.outcome;
    }

    const invoked = await this.request(toolName, params ?? {}, definition.value.canonical_output);
    if (invoked.ok) return { kind: "executed", tool: toolName, result: invoked.result };
    if (invoked.rejected !== undefined) return invoked.rejected;
    return { kind: "failed", error: invoked.error ?? toolError("bridge_failure", "工具调用失败（原因未归类）") };
  }

  /** 账本轨审批：命中未消费 → 消费；否则 blocked(approval_missing)。无自动应答路径。 */
  private async approve(definition: ToolDefinition, params: unknown): Promise<ApprovalOutcome> {
    const key = approvalKeyFor(definition.name, params);
    const queried = await this.request("ledger_query", key, LEDGER_QUERY_CANONICAL);
    if (!queried.ok) {
      // 账本面故障 = 无法确认授权状态 → fail-closed，不猜测审批通过
      return { ok: false, outcome: { kind: "failed", error: queried.error ?? toolError("bridge_failure", "账本查询失败") } };
    }
    const entries = (queried.result as { entries: LedgerEntry[] }).entries;
    const live = entries.find((entry) => entry.consumed === false);
    if (live === undefined) {
      return {
        ok: false,
        outcome: {
          kind: "blocked",
          block: approvalMissingBlock(
            definition.name,
            `审批缺失：账本无未消费记录（tool=${definition.name}）——headless 下进程须以 exit 78 终止`,
            { approval_key: key, ledger_entries: entries },
          ),
        },
      };
    }
    const consumed = await this.request("ledger_consume", { record_id: live.record_id }, LEDGER_CONSUME_CANONICAL);
    if (consumed.ok) return { ok: true };
    if (consumed.rejected !== undefined) {
      // 预录存在但消费时已被吃掉（一次性语义在对端强制）→ 授权不可用 → blocked
      return {
        ok: false,
        outcome: {
          kind: "blocked",
          block: approvalMissingBlock(definition.name, "审批消费失败（记录已消费或不存在）——一次性语义 fail-closed", consumed.rejected),
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

// ledger 方法自身的 canonical output（与 bridge.contract.yaml methods 段对等）
const LEDGER_QUERY_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "entries"],
  properties: {
    ok: { const: true },
    entries: {
      type: "array",
      items: {
        type: "object",
        required: ["record_id", "tool", "params_digest", "consumed"],
        properties: {
          record_id: { type: "string" },
          tool: { type: "string" },
          params_digest: { type: "string" },
          consumed: { type: "boolean" },
        },
      },
    },
  },
};

const LEDGER_CONSUME_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "record_id", "consumed"],
  properties: {
    ok: { const: true },
    record_id: { type: "string" },
    consumed: { const: true },
  },
};
