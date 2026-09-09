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
  /** 审批轨要求：写动作/闸门推进 = true（调用前须账本预录且未消费）；只读 = false */
  requires_approval: boolean;
  /** canonical output schema（成功返回值逐次校验，失败 = err(schema_violation)） */
  canonical_output: SchemaNode;
}

/** 模型可见形态：仅 { name, description, parameters }——内部字段一律不发。 */
export interface ModelVisibleTool {
  name: string;
  description: string;
  parameters: SchemaNode;
}

export const toModelVisible = (definition: ToolDefinition): ModelVisibleTool => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
});

/** 无参工具的公共 parameters（只读查询面）。 */
const NO_PARAMS: SchemaNode = { type: "object", required: [], properties: {} };

const STRING_ARRAY: SchemaNode = { type: "array", items: { type: "string" } };

const HEX64 = "^[0-9a-f]{64}$";

/** 严格 4 个工具（任务书 S3-1 / owner 口径 #5），工具面收敛，禁止任何增补。 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "atf_admit_data",
    description: "数据准入：将指定数据集准入 ATF 训练流水（登记领域事实并产出 digest）。须账本审批预录。",
    parameters: {
      type: "object",
      required: ["dataset_id"],
      properties: {
        dataset_id: { type: "string" },
        source: { type: "string", optional: true },
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
    description: "查询或推进 G 闸门（如 G2 实验门）。blocked 为合法业务产出（含缺失证据说明）。须账本审批预录。",
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
    canonical_output: {
      type: "object",
      required: ["ok", "gate", "status"],
      properties: {
        ok: { const: true },
        gate: { type: "string" },
        status: { enum: ["pass", "blocked"] },
        reason: { type: "string", optional: true },
        missing: { ...STRING_ARRAY, optional: true },
      },
    },
  },
  {
    name: "atf_surface_scan",
    description: "证据面扫描：列出当前 run 已登记的领域事实（journal_type / fact_id / sha256_digest）。只读。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "surface", "count"],
      properties: {
        ok: { const: true },
        count: { type: "integer" },
        surface: {
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
    description: "工作区状态查询：返回当前 run 标识与已准入事实计数。只读。",
    parameters: NO_PARAMS,
    requires_approval: false,
    canonical_output: {
      type: "object",
      required: ["ok", "run_id", "admitted_count"],
      properties: {
        ok: { const: true },
        run_id: { type: "string" },
        admitted_count: { type: "integer" },
      },
    },
  },
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((definition) => definition.name);
