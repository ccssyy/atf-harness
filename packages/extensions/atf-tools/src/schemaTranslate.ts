/**
 * 协议适配层：手搓版契约 schema（core/tools 的 JSON Schema 方言）→ DSH defineTool
 * 参数/输出形态。适配是本包存在的意义——桥接执行与校验逻辑零重写（复用
 * src/agent/atfAgentTools.ts 执行径与 src/webui/readOnlyTools.ts 纯函数），这里只做
 * 翻译与结果序列化。
 */
import type { SchemaNode } from "../../../../src/core/tools/canonical.js";

/** DSH 属性 spec 的直译子集（对齐 @deepseek-ai/dsh-tools 0.2.0-rc.2 的 ValueSchemaSpec）。 */
export type DshPropertySpec =
  | { type: "string"; description?: string; enum?: readonly string[]; required?: true }
  | { type: "json"; description?: string; required?: true }
  | { type: "number"; description?: string; required?: true }
  | { type: "integer"; description?: string; required?: true }
  | { type: "boolean"; description?: string; required?: true }
  | { type: "array"; description?: string; required?: true }
  | { type: "object"; additionalProperties: true; description?: string; required?: true };

export type DshParamsSpec = Record<string, DshPropertySpec>;

/** 手搓契约属性 → DSH 属性（直译；未知类型如实抛错不猜——契约方言漂移宁可加载失败）。 */
const translateProperty = (node: Record<string, unknown>, key: string, required: boolean): DshPropertySpec => {
  const description = typeof node["description"] === "string" ? node["description"] : undefined;
  const base = { ...(description !== undefined ? { description } : {}), ...(required ? { required: true as const } : {}) };
  if (node["type"] === undefined && Array.isArray(node["enum"])) {
    // 契约方言的 enum-only 属性（如 atf_gate.action）＝字符串枚举
    return { type: "string", enum: (node["enum"] as readonly string[]), ...base };
  }
  if (node["type"] === undefined) {
    // 无形态声明（如 guidance 类自由字段）→ DSH json＝任意无损 JSON 宽收，描述保留
    return { type: "json", ...base };
  }
  switch (node["type"]) {
    case "string":
      return { type: "string", ...base };
    case "number":
      return { type: "number", ...base };
    case "integer":
      return { type: "integer", ...base };
    case "boolean":
      return { type: "boolean", ...base };
    case "array":
      // items 省略＝接受任意 JSON item（DSH ArrayValueSchemaSpec 语义）；元素约束随 description 走
      return { type: "array", ...base };
    case "object":
      return { type: "object", additionalProperties: true, ...base };
    default:
      throw new Error(`atf-tools: 契约参数 ${key} 的类型 "${String(node["type"])}" 无法映射到 DSH 协议`);
  }
};

/** 契约 ToolDefinition.parameters → DSH defineTool 的 parameters（required 数组 → 属性级 required）。 */
export const translateParameters = (parameters: SchemaNode): DshParamsSpec => {
  const node = parameters as unknown as Record<string, unknown>;
  const properties = (node["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(node["required"]) ? (node["required"] as unknown[]) : [];
  const spec: DshParamsSpec = {};
  for (const [key, prop] of Object.entries(properties)) {
    spec[key] = translateProperty(prop, key, required.includes(key));
  }
  return spec;
};

/** DSH 宽根 output schema（canonical 校验已在手搓执行径做掉——这里只约束对象根，避免第二权威漂移）。 */
export const looseObjectOutput = { type: "object", additionalProperties: true } as const;

/** 结果序列化（与手搓 textResult 同口径：canonical 值 JSON 文本化给模型）。 */
export const renderAsJsonText = (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
  { type: "text", text: JSON.stringify(value, null, 1) },
];

/** execute 返回收口：递归清洗为无损 JSON（DSH output 校验拒收 undefined 等非 lossless 值——
 *  实测桥错误回填路径会夹带 detail: undefined；此处统一剔除 undefined 字段，双向安全）。 */
export const asToolValue = <T>(value: T): Record<string, never> => {
  const clean = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (item !== undefined) out[k] = clean(item);
      }
      return out;
    }
    return v;
  };
  return clean(value) as unknown as Record<string, never>;
};
