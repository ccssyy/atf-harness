/**
 * 前端三（MCP server 外壳）——7 细粒度工具面（L1 门 2 T05，D11）。
 *
 * 工具名与 canonical output 沿用桥接契约，不另造一套：4 个模型面工具直接取
 * ToolRegistry 的 ToolDefinition（canonical 校验在 ToolExecutor 内）；atf_bind_run 与
 * 2 个账本方法的 schema 按 bridge.contract.yaml 转写；ledger 的 canonical output 复用
 * executor 导出常量（LEDGER_*_CANONICAL）。
 *
 * inputSchema 转换：本仓 SchemaNode 方言的 `optional` 旁标记不是标准 JSON Schema——
 * MCP inputSchema 剥除 optional、收严 additionalProperties:false。
 */
import { TOOL_DEFINITIONS, type SchemaNode, type ToolDefinition } from "../core/tools/index.js";
import { type McpToolDescriptor } from "./protocol.js";

/** D11：恰 7 个细粒度工具（顺序即 tools/list 顺序；禁止增补）。 */
export const MCP_TOOL_NAMES = [
  "atf_bind_run",
  "atf_workspace_status",
  "atf_fact_scan",
  "atf_gate",
  "atf_admit_data",
  "ledger_query",
  "ledger_consume",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** SchemaNode → 标准 JSON Schema（剥 optional 旁标记；object 收严 additionalProperties）。 */
export const toMcpJsonSchema = (node: SchemaNode): Record<string, unknown> => {
  const base: Record<string, unknown> = { type: node.type };
  if (node.enum !== undefined) base["enum"] = node.enum;
  if (node.const !== undefined) base["const"] = node.const;
  if (node.pattern !== undefined) base["pattern"] = node.pattern;
  if (node.type === "array" && node.items !== undefined) base["items"] = toMcpJsonSchema(node.items);
  if (node.type === "object") {
    base["additionalProperties"] = false;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      properties[key] = toMcpJsonSchema(child);
      if (child.optional !== true) required.push(key);
    }
    base["properties"] = properties;
    base["required"] = required;
  }
  return base;
};

const descriptionOf = (name: McpToolName, fallback: ToolDefinition | undefined): string => {
  if (fallback !== undefined) return fallback.description;
  switch (name) {
    case "atf_bind_run":
      return "会话绑定：将本 MCP server 进程绑定到指定 ATF run（我方会话以 atf_bind_run 为界、进程内维持；后续工具调用写入同一 run 的 append-only 会话日志）。v1 一进程一绑定。";
    case "ledger_query":
      return "审批账本查询：按 scope_ref(+operation_id) 定位审批链，缺省只返回可消费记录（state=approved 且未 consumed）。";
    case "ledger_consume":
      return "审批账本消费：以 {approval_ref, record_id} 逐值一致消费（内核 CAS 一次性语义；对端强制）。";
    default:
      return name;
  }
};

const paramsOf = (name: McpToolName, fallback: ToolDefinition | undefined): SchemaNode => {
  if (fallback !== undefined) return fallback.parameters;
  switch (name) {
    case "atf_bind_run":
      return {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
      };
    case "ledger_query":
      return {
        type: "object",
        required: ["scope_ref"],
        properties: {
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
          operation_id: { type: "string", optional: true },
          state: { type: "string", optional: true },
          include_consumed: { type: "boolean", optional: true },
        },
      };
    case "ledger_consume":
      return {
        type: "object",
        required: ["approval_ref", "record_id"],
        properties: {
          approval_ref: { type: "string" },
          record_id: { type: "string" },
        },
      };
    default:
      return { type: "object", required: [], properties: {} };
  }
};

/** tools/list 全集（恰 7 项；每次调用重算，无共享可变态）。 */
export const mcpToolDescriptors = (): McpToolDescriptor[] =>
  MCP_TOOL_NAMES.map((name) => {
    const fallback = TOOL_DEFINITIONS.find((definition) => definition.name === name);
    return {
      name,
      description: descriptionOf(name, fallback),
      inputSchema: toMcpJsonSchema(paramsOf(name, fallback)),
    };
  });
