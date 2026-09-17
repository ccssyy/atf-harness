/**
 * ToolDefinition（任务书 S3-2）：模型可见 schema（白名单）+ canonical output 声明 +
 * 桥接方法名 + 审批要求。内部字段（canonical_output / requires_approval / method /
 * execution 相关的一切）绝不进入模型可见形态——toModelVisible 白名单投影（owner 口径 #5）。
 */
import { type SchemaNode } from "./canonical.js";

export interface ToolDefinition {
  /** 工具名 = 桥接方法名（契约 methods 段登记） */
  name: string;
  /** 模型可见描述 */
  description: string;
  /** 模型可见参数白名单（JSON Schema 方言，见 canonical.ts） */
  parameters: SchemaNode;
  /** 审批轨要求：写动作/闸门推进 = true（调用前须账本预录且未消费）；只读 = false。
   *  基准旗标——当 requiresApproval 谓词存在时以其为准（见下）。 */
  requires_approval: boolean;
  /** L1b B7 N1（owner 裁定 2026-09-17）：按 params 分派的审批谓词（存在时优先于
   *  requires_approval）。atf_gate：action=="advance"（推进）须审批；action=="query"
   *  （只读）免审批、模型自主执行——对齐 L1 门 2 VERIFY 4「模型自主只读」与
   *  L1b-D1=A 写类界定。定性＝实现修正到已裁口径，非放宽「逐工具审批」红线
   *  （advance 仍走问答轨；账本轨优先/CAS/一次性消费零改动）。 */
  requiresApproval?: (params: unknown) => boolean;
  /** canonical output schema（成功返回值逐次校验，失败 = err(schema_violation)） */
  canonical_output: SchemaNode;
}

/** 模型可见形态：仅 { name, description, parameters }——内部字段一律不发。 */
export interface ModelVisibleTool {
  name: string;
  description: string;
  parameters: SchemaNode;
}

/** 审批判定单一出口：谓词存在以其为准，否则退回基准旗标（executor 消费点唯一）。 */
export const requiresApprovalFor = (definition: ToolDefinition, params: unknown): boolean =>
  definition.requiresApproval !== undefined ? definition.requiresApproval(params) : definition.requires_approval;

/** atf_gate 审批谓词：仅 action=="advance"（推进＝状态变更）须审批；query 只读免审批。
 *  action 缺失/非法 → 按须审批处置（fail-closed，不猜只读）。 */
const gateRequiresApproval = (params: unknown): boolean => {
  const action = typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as { action?: unknown }).action
    : undefined;
  return action !== "query";
};

export const toModelVisible = (definition: ToolDefinition): ModelVisibleTool => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
});

/** 无参工具的公共 parameters（只读查询面）。 */
const NO_PARAMS: SchemaNode = { type: "object", required: [], properties: {} };

const STRING_ARRAY: SchemaNode = { type: "array", items: { type: "string" } };

const HEX64 = "^[0-9a-f]{64}$";

/** 严格 4 个工具（任务书 S3-1 / owner 口径 #5），工具面收敛，禁止任何增补。
 *  契约 v2（2026-09-13 契约修订）：证据面扫描工具改名 atf_fact_scan（数组 facts）、
 *  atf_gate 增补 warn 与附加字段、atf_admit_data source → source_ref、
 *  atf_workspace_status 增补 scope_ref。 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "atf_admit_data",
    description: "数据准入：将指定数据集准入 ATF 训练流水（登记领域事实并产出 digest）。须账本审批预录。",
    parameters: {
      type: "object",
      required: ["dataset_id"],
      properties: {
        dataset_id: { type: "string" },
        source_ref: { type: "string", optional: true },
        // R2 补登（D3 决议 20260914）：与契约 atf_admit_data.params 对等——
        // 显式 pin 优先，缺省由内核按 canonical_digest({dataset_id, source_ref})[:12] 推导。
        pin: { type: "string", optional: true },
      },
    },
    requires_approval: true,
    canonical_output: {
      type: "object",
      required: ["ok", "journal_type", "fact_id", "sha256_digest"],
      properties: {
        ok: { const: true },
        journal_type: { type: "string" },
        fact_id: { type: "string" },
        sha256_digest: { type: "string", pattern: HEX64 },
        dataset_id: { type: "string", optional: true },
      },
    },
  },
  {
    name: "atf_gate",
    description:
      "查询或推进闸门：gate 取值按命名分流（G1–G4 大小写不敏感 → 数据准入闸；其余须命中七组完整性 GateId；都不命中 unknown_gate）。blocked/warn 为合法业务产出（含原因码与证据引用）。query 免审批自主执行；advance 须账本审批预录。",
    parameters: {
      type: "object",
      required: ["gate", "action"],
      properties: {
        gate: { type: "string" },
        action: { enum: ["query", "advance"] },
        evidence_refs: { ...STRING_ARRAY, optional: true },
      },
    },
    requires_approval: true,
    requiresApproval: gateRequiresApproval,
    canonical_output: {
      type: "object",
      required: ["ok", "gate", "status"],
      properties: {
        ok: { const: true },
        gate: { type: "string" },
        status: { enum: ["pass", "warn", "blocked"] },
        reason_codes: { ...STRING_ARRAY, optional: true },
        requires_human_review: { type: "boolean", optional: true },
        evidence: { ...STRING_ARRAY, optional: true },
        reason: { type: "string", optional: true },
        missing: { ...STRING_ARRAY, optional: true },
      },
    },
  },
  {
    name: "atf_fact_scan",
    description: "事实索引枚举：列出本 run 可被引用的事实索引（journal_type / fact_id / sha256_digest 三元组）。只读。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "facts", "count"],
      properties: {
        ok: { const: true },
        count: { type: "integer" },
        facts: {
          type: "array",
          items: {
            type: "object",
            required: ["journal_type", "fact_id", "sha256_digest"],
            properties: {
              journal_type: { type: "string" },
              fact_id: { type: "string" },
              sha256_digest: { type: "string", pattern: HEX64 },
            },
          },
        },
      },
    },
  },
  {
    name: "atf_workspace_status",
    description: "工作区状态查询：返回当前 run 标识、已准入事实计数与作用域引用 scope_ref（供账本定位）。只读。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "run_id", "admitted_count", "scope_ref"],
      properties: {
        ok: { const: true },
        run_id: { type: "string" },
        admitted_count: { type: "integer" },
        scope_ref: {
          type: "object",
          required: ["project_id", "scope_type", "scope_id", "scope_mode"],
          properties: {
            project_id: { type: "string" },
            scope_type: { type: "string" },
            scope_id: { type: "string" },
            scope_mode: { type: "string" },
          },
        },
      },
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((definition) => definition.name);
