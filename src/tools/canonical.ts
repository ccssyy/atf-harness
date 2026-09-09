/**
 * canonical output 校验器（任务书 S3-2：每个成功返回值过 JSON Schema 校验，失败 = err）。
 * 零依赖方言（R2a：不引入 ajv），能力面恰为契约登记所需：
 * type（object/string/number/integer/boolean/array）+ const + enum +
 * required + properties + items + pattern。schema 与 bridge.contract.yaml methods 段
 * 对等维护（契约文件为真相源，本模块为实现载体，双侧同步修改）。
 */
import { toolError, type ToolError } from "./errors.js";

/** 极简 schema 节点（递归）。与 bridge.contract.yaml 登记的 result/params 结构对等。 */
export interface SchemaNode {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Readonly<Record<string, SchemaNode>>;
  items?: SchemaNode;
  pattern?: string;
  /** optional 声明仅作文档语义；校验以 properties 是否声明为准（声明即校验，未声明字段不校验） */
  optional?: boolean;
}

/** 供校验器抛错文案使用：把值缩略为可读摘要。 */
const brief = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value; // string | boolean | object | undefined
};

/** 校验 value 是否匹配 schema 节点。返回 null = 通过；返回人读错误消息 = 违规。 */
export const checkSchema = (value: unknown, schema: SchemaNode, path: string): string | null => {
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      return `${path} 违反 const 约束（期望 ${brief(schema.const)}，实得 ${brief(value)}）`;
    }
  }
  if (schema.enum !== undefined) {
    const hit = schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value));
    if (!hit) return `${path} 不在枚举 ${brief(schema.enum)} 内（实得 ${brief(value)}）`;
  }
  if (schema.type !== undefined && typeOf(value) !== schema.type) {
    return `${path} 类型非法（期望 ${schema.type}，实得 ${typeOf(value)}: ${brief(value)}）`;
  }
  if (schema.pattern !== undefined) {
    if (typeof value !== "string" || !new RegExp(schema.pattern).test(value)) {
      return `${path} 不匹配 pattern ${schema.pattern}（实得 ${brief(value)}）`;
    }
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) return `${path} 缺少 required 字段 "${key}"`;
    }
    const declared = schema.properties ?? {};
    for (const key of Object.keys(record)) {
      if (!(key in declared)) return `${path} 含未声明字段 "${key}"（properties 即白名单，额外字段拒绝）`;
    }
    for (const [key, child] of Object.entries(declared)) {
      if (!(key in record)) continue;
      const violation = checkSchema(record[key], child, `${path}.${key}`);
      if (violation !== null) return violation;
    }
  }
  if (schema.type === "array" && schema.items !== undefined && Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const violation = checkSchema(value[i], schema.items, `${path}[${String(i)}]`);
      if (violation !== null) return violation;
    }
  }
  return null;
};

/** canonical output 校验入口：违规折算 err(schema_violation)（owner 口径 #4，不猜测成功）。 */
export const validateCanonicalOutput = (
  toolName: string,
  schema: SchemaNode,
  value: unknown,
): { ok: true } | { ok: false; error: ToolError } => {
  const violation = checkSchema(value, schema, toolName);
  if (violation === null) return { ok: true };
  return {
    ok: false,
    error: toolError("schema_violation", `canonical output 校验失败: ${violation}`, { tool: toolName, got: value }),
  };
};
