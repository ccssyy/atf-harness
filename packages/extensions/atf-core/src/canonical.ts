/**
 * canonical output 校验器（任务书 S3-2：每个成功返回值过 JSON Schema 校验，失败 = err）。
 * 零依赖方言（R2a：不引入 ajv），能力面恰为契约登记所需：
 * type（object/string/number/integer/boolean/array）+ const + enum +
 * required + properties + items + pattern。schema 与 bridge.contract.yaml methods 段
 * 对等维护（契约文件为真相源，本模块为实现载体，双侧同步修改）。
 */
import { toolError, type ToolError } from "./toolErrors.js";

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
  /** 对象白名单的选择性退出（K-Gap-2 接线批与 F6 harness 侧小批同名扩展，2026-09-21）：
   *  缺省 true（properties 即白名单，未声明键拒绝）；显式 strict:false 放开未声明键——
   *  用于自由形态 payload 透传（split_policy 确认态／状态面数据集概览／human_summary 双层），
   *  深形态校验归内核，harness 不做第二权威。已声明属性仍逐键校验。 */
  strict?: boolean;
  /** 快修批 D-b（2026-09-20）：纯文档元数据——经两 codec 原样透传给模型（提示词面），
   *  不参与 checkSchema/validateCanonicalOutput 校验，不属于契约对等面（bridge.contract.yaml 零 diff）。 */
  description?: string;
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
// B11/发现 5（1116):schema_violation 防御径消息=定位+两条改法（A4 批覆盖率口径升级——
// 纯定位无改法=agent 翻源码自救的根因面；报错即修复指令纪律的桥侧新发射点）。
const withHowToFix = (violation: string, kind: "const" | "enum" | "type" | "pattern" | "required" | "undeclared" | "child"): string => {
  const fixes: Record<typeof kind, string> = {
    const: "两条改法:①按期望固定值修正该参数后重试;②对照工具 schema 描述确认合法取值形态",
    enum: "两条改法:①改取枚举闭集内的合法值(见括号清单)后重试;②读工具 description 的取值说明确认语义再传",
    type: "两条改法:①按期望类型修正该参数(JSON 形态)后重试;②对照工具 schema 的 type 声明确认字段形态",
    pattern: "两条改法:①按 pattern 形态修正该参数后重试;②对照工具 description 的格式说明确认写法",
    required: "两条改法:①补齐该必填字段后重试;②对照工具 description 的参数说明确认来源(如回执字段/上游产物)",
    undeclared: "两条改法:①删去该未声明字段后重试(properties 即白名单);②确认是否传错工具——对照 description 的参数清单",
    child: "两条改法:①按报错路径修正该子字段后重试;②对照工具 schema 的嵌套声明确认形态",
  };
  return `${violation}；${fixes[kind]}`;
};

export const checkSchema = (value: unknown, schema: SchemaNode, path: string): string | null => {
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      return withHowToFix(`${path} 违反 const 约束（期望 ${brief(schema.const)}，实得 ${brief(value)}）`, "const");
    }
  }
  if (schema.enum !== undefined) {
    const hit = schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value));
    if (!hit) return withHowToFix(`${path} 不在枚举 ${brief(schema.enum)} 内（实得 ${brief(value)}）`, "enum");
  }
  if (schema.type !== undefined && typeOf(value) !== schema.type) {
    return withHowToFix(`${path} 类型非法（期望 ${schema.type}，实得 ${typeOf(value)}: ${brief(value)}）`, "type");
  }
  if (schema.pattern !== undefined) {
    if (typeof value !== "string" || !new RegExp(schema.pattern).test(value)) {
      return withHowToFix(`${path} 不匹配 pattern ${schema.pattern}（实得 ${brief(value)}）`, "pattern");
    }
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) return withHowToFix(`${path} 缺少 required 字段 "${key}"`, "required");
    }
    const declared = schema.properties ?? {};
    if (schema.strict !== false) {
      for (const key of Object.keys(record)) {
        if (!(key in declared)) return withHowToFix(`${path} 含未声明字段 "${key}"（properties 即白名单，额外字段拒绝）`, "undeclared");
      }
    }
    for (const [key, child] of Object.entries(declared)) {
      if (!(key in record)) continue;
      const violation = checkSchema(record[key], child, `${path}.${key}`);
      if (violation !== null) return violation; // 子字段违例已自带改法（递归同口径）
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
