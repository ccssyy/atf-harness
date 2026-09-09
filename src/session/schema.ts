/**
 * 会话事件 schema v0（ADR-06 + Phase 1 任务书 S2-1，登记于 session.contract.yaml）。
 * 事件类型严格白名单；未知 type 拒绝写入（owner 口径 #3）。
 * 本模块只做结构与语法的运行时校验；digest 与领域事实的一致性校验在 sessionLog.ts。
 */

/** 事件 schema 版本（v0 起步，owner 口径 #3）。 */
export const SESSION_SCHEMA_VERSION = 0;

/** 事件类型白名单——任务书 S2-1 列出的 7 类，无第八类。 */
export const SESSION_EVENT_TYPES = [
  "user/message",
  "assistant/message",
  "assistant/attempt", // 失败尝试：落盘但不进模型历史（transformContext 过滤）
  "tool/call",
  "tool/result",
  "turn/start",
  "turn/end",
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value);

/** 双层引用三元组（ADR-06 细则 1）：digest 是唯一合法引用形态，不含事实内容副本。 */
export interface DomainRef {
  journal_type: string;
  fact_id: string;
  sha256_digest: string;
}

/** TEM 投影字段位（ADR-06 细则 3）：Phase 3 前恒为 { evidence_event: null }，但 schema 里必须有。 */
export interface Projection {
  evidence_event: string | null;
}

/** 落盘的完整会话事件（每条恰好一行 JSON）。 */
export interface SessionEvent {
  id: number;
  /** ISO 8601 UTC */
  ts: string;
  type: SessionEventType;
  /** 必填，任意 JSON 值（含 null） */
  payload: unknown;
  projection: Projection;
  domain_refs?: DomainRef[];
  /** UI-only 命名空间：仅供界面/诊断，convertToLlm 白名单投影时永不输出 */
  ui?: Record<string, unknown>;
  /** digest 校验失败标记：存在即表示该事件引用未通过校验（fail-closed 留痕） */
  ref_invalid?: InvalidRefEntry[];
}

/** ref_invalid 标记条目（归因枚举与载荷在 errors.ts 的 InvalidRef，此处为落盘同构形态）。 */
export interface InvalidRefEntry {
  index: number;
  journal_type: string;
  fact_id: string;
  claimed_digest: string;
  cause: "digest_mismatch" | "fact_not_found";
}

/** append 输入：id / ts / projection 由 SessionLog 生成，ref_invalid 由校验结果决定。 */
export interface SessionEventInput {
  type: SessionEventType;
  payload: unknown;
  domain_refs?: DomainRef[];
  ui?: Record<string, unknown>;
}

const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** domain_refs 三元组语法校验（journal_type / fact_id 非空串，digest 64 位小写 hex）。 */
export const validateDomainRef = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "domain_ref 不是 JSON 对象";
  if (typeof value["journal_type"] !== "string" || value["journal_type"] === "") {
    return "domain_ref.journal_type 非法（须为非空字符串）";
  }
  if (typeof value["fact_id"] !== "string" || value["fact_id"] === "") {
    return "domain_ref.fact_id 非法（须为非空字符串）";
  }
  if (typeof value["sha256_digest"] !== "string" || !SHA256_DIGEST_PATTERN.test(value["sha256_digest"])) {
    return "domain_ref.sha256_digest 非法（须为 64 位小写 hex）";
  }
  return null;
};

/**
 * 落盘事件信封校验（replay 用——文件内容是外部输入，逐字段严格白名单）。
 * 返回 null 表示合法。payload 允许任意 JSON 值（解析自 JSON.parse 的值必然合法）。
 */
export const validateEventEnvelope = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "事件不是 JSON 对象";
  if (typeof value["id"] !== "number" || !Number.isInteger(value["id"]) || (value["id"] as number) < 1) {
    return "事件 id 非法（须为正整数）";
  }
  const ts = value["ts"];
  if (typeof ts !== "string" || ts === "" || Number.isNaN(Date.parse(ts))) {
    return "事件 ts 非法（须为可解析的 ISO 8601 时间串）";
  }
  if (!isSessionEventType(value["type"])) {
    return `未知事件 type: ${String(value["type"])}（schema v0 白名单外一律拒绝）`;
  }
  if (!("payload" in value)) return "事件缺少 payload 字段";
  if (!isPlainObject(value["projection"]) || !("evidence_event" in value["projection"])) {
    return "事件缺少 projection 字段位（schema v0 要求必须存在）";
  }
  if ((value["projection"] as Record<string, unknown>)["evidence_event"] !== null) {
    return "projection.evidence_event 非 null（Phase 3 前恒为 null，非 null 视为 schema 提前激活）";
  }
  if ("domain_refs" in value) {
    const refs = value["domain_refs"];
    if (!Array.isArray(refs)) return "domain_refs 非法（须为数组）";
    for (let i = 0; i < refs.length; i += 1) {
      const violation = validateDomainRef(refs[i]);
      if (violation !== null) return `domain_refs[${String(i)}] ${violation}`;
    }
  }
  if ("ui" in value && !isPlainObject(value["ui"])) return "ui 非法（须为 JSON 对象）";
  if ("ref_invalid" in value) {
    const marks = value["ref_invalid"];
    if (!Array.isArray(marks)) return "ref_invalid 非法（须为数组）";
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i];
      if (!isPlainObject(mark)) return `ref_invalid[${String(i)}] 不是 JSON 对象`;
      const cause = mark["cause"];
      if (cause !== "digest_mismatch" && cause !== "fact_not_found") {
        return `ref_invalid[${String(i)}].cause 非法（须为 digest_mismatch | fact_not_found）`;
      }
    }
  }
  return null;
};

/** 从已通过 validateEventEnvelope 的对象收敛出 SessionEvent（未列出的杂散字段一律丢弃——严格 schema）。 */
export const asSessionEvent = (value: Record<string, unknown>): SessionEvent => {
  const event: SessionEvent = {
    id: value["id"] as number,
    ts: value["ts"] as string,
    type: value["type"] as SessionEventType,
    payload: value["payload"],
    projection: value["projection"] as Projection,
  };
  if ("domain_refs" in value) event.domain_refs = value["domain_refs"] as DomainRef[];
  if ("ui" in value) event.ui = value["ui"] as Record<string, unknown>;
  if ("ref_invalid" in value) event.ref_invalid = value["ref_invalid"] as InvalidRefEntry[];
  return event;
};
