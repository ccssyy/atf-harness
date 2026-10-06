/**
 * 账本闸共享骨架（批㊶-H 丙线共享内核收口·镜像面②；owner 会话 10-06 19:46 定案，
 * 门 2 工单前置落地）：ledger_query →（链首比对）→ ledger_consume 的调用序单源——
 * 桥接方法名／参数形态／canonical 常量／链首取位在此单点维护，两线新增账本能力
 * 不改一漏一。
 *
 * 收口前形态（批㊲ 实锚）：查询/消费骨架在 agent/approvalHook.ts 内联（约 30 行），
 * 与 core/tools/executor.ts approve() 平行（复用 LEDGER 双 canonical 但各自折叠）。
 * 终态映射不在本层——甲线（executor.approve → ToolCallOutcome／ToolError）与丙线
 * （approvalHook → audit verdict／BeforeToolCallResult）各自保有：词汇面（事件流 vs
 * AgentEvent 的既知分叉）按批㊱A 结论维持两线并存。scope_ref 经 getter 逐次取值
 * （丙线 scopeRefBox 逐调用重读语义逐位保持；甲线 readonly 属性等价）。
 */
import { type BridgeError } from "../../bridge/index.js";
import { validateCanonicalOutput, type SchemaNode } from "./canonical.js";
import type { LedgerRecord, ScopeRef } from "./approvalKey.js";
import type { ToolError } from "./errors.js";

// ledger 方法自身的 canonical output（与 bridge.contract.yaml methods 段 v2 对等）
/** ledger_query canonical output（MCP 外壳同用，沿用桥接契约不另造）。 */
export const LEDGER_QUERY_CANONICAL: SchemaNode = {
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

/** ledger_consume canonical output（MCP 外壳同用，沿用桥接契约不另造）。 */
export const LEDGER_CONSUME_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "record_id", "state"],
  properties: {
    ok: { const: true },
    record_id: { type: "string" },
    state: { const: "consumed" },
  },
};

/** 账本闸桥接最小面（结构满足甲线 BridgeTransport 与丙线 SpikeBridgeTransport；测试可注桩）。 */
export interface LedgerGateTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

/** 骨架步失败载荷（原始未折叠——两线各自折叠为既有错误形态，零行为变化）：
 *  桥接层失败透传 bridgeError，canonical 校验失败透传 canonicalError，恰一者在位。 */
export interface LedgerGateFailure {
  readonly bridgeError?: BridgeError;
  readonly canonicalError?: ToolError;
}

/** 终态映射面（两线调用形态取交集）：四个决策点回调，T 为各线终态
 *  （甲线 ApprovalOutcome；丙线 BeforeToolCallResult | undefined）。 */
export interface LedgerGateMapping<T> {
  /** 查询步失败（账本面故障/canonical 违规——无法确认授权状态，fail-closed 输入）。 */
  onQueryFailure(failure: LedgerGateFailure): T | Promise<T>;
  /** 无可消费记录（records 全量透传——两线 detail.ledger_records 消费面）。 */
  onNoRecord(records: LedgerRecord[]): T | Promise<T>;
  /** 消费步失败（预录存在但一次性语义下授权不可用）。 */
  onConsumeFailure(failure: LedgerGateFailure): T | Promise<T>;
  /** 消费成功放行（record_id 透传——审计留痕消费面）。 */
  onGranted(recordId: string): T | Promise<T>;
}

/** 桥接请求 + canonical 校验（对端 ok=false／canonical 违规折叠为原始失败载荷）。 */
const ledgerRequest = async (
  bridge: LedgerGateTransport,
  method: string,
  params: unknown,
  canonical: SchemaNode,
): Promise<{ ok: true; value: unknown } | LedgerGateFailure> => {
  const response = await bridge.request(method, params);
  if (!response.ok) return { bridgeError: response.error };
  const canonicalCheck = validateCanonicalOutput(method, canonical, response.value);
  if (!canonicalCheck.ok) return { canonicalError: canonicalCheck.error };
  return { ok: true, value: response.value };
};

/** 账本闸骨架单源：ledger_query（scope_ref 定位；operation_id 可选过滤——L1b B5，
 *  过滤语义在对端强制）→ records[0]（链首 = 可消费记录）→ ledger_consume
 *  （{approval_ref, record_id} 逐值一致，契约 v2 审批链键模型）。 */
export const runLedgerGate = async <T>(
  bridge: LedgerGateTransport,
  scopeRef: () => ScopeRef | undefined,
  mapping: LedgerGateMapping<T>,
  options?: { operationId?: string },
): Promise<T> => {
  const queried = await ledgerRequest(
    bridge,
    "ledger_query",
    options?.operationId !== undefined
      ? { scope_ref: scopeRef(), operation_id: options.operationId }
      : { scope_ref: scopeRef() },
    LEDGER_QUERY_CANONICAL,
  );
  if (!("ok" in queried)) return mapping.onQueryFailure(queried);
  const records = (queried.value as { records: LedgerRecord[] }).records;
  const live = records[0];
  if (live === undefined) return mapping.onNoRecord(records);
  const consumed = await ledgerRequest(bridge, "ledger_consume", { approval_ref: live.approval_id, record_id: live.record_id }, LEDGER_CONSUME_CANONICAL);
  if (!("ok" in consumed)) return mapping.onConsumeFailure(consumed);
  return mapping.onGranted(live.record_id);
};
