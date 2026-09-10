/**
 * 会话事件 schema v1（ADR-06 + Phase 2 任务书 §2 / owner 决议口径 #1，登记于 session.contract.yaml）。
 * v1 = v0 七类 + session/compaction + session/repair（P2-S1/S1a 启用）+ approval/request、
 * approval/response、provider/switch（P2-S2/S3 启用，本阶段为保留位——不得写入、落盘流
 * 出现即拒，白名单纪律沿用 v0）。
 * v1 定义修正（S1a，决议 §2.1.6）：P2-S1 未闭合前 v1 仍在修正窗口内，集合 11 → 12 类属
 * v1 定义修正，不构成 v1 → v2。
 * 事件类型严格白名单；未知或未启用 type 拒绝写入。
 * 本模块只做结构与语法的运行时校验；digest 与领域事实的一致性校验在 sessionLog.ts。
 */

/** 事件 schema 版本（v1；S1a 定义修正 11 → 12 类，不 bump 版本号）。 */
export const SESSION_SCHEMA_VERSION = 1;

/** schema v1 事件类型白名单——12 类（S1a 定义修正后定死）。 */
export const SESSION_EVENT_TYPES = [
  "user/message",
  "assistant/message",
  "assistant/attempt", // 失败尝试：落盘但不进模型历史（transformContext 过滤）
  "tool/call",
  "tool/result",
  "turn/start",
  "turn/end",
  "session/compaction", // P2-S1：压缩动作审计留痕（哪次压缩吃掉了哪些事件）
  "session/repair", // S1a：尾部残段截断修复留痕（与截断成对写入）
  "approval/request", // 保留位：P2-S2 启用
  "approval/response", // 保留位：P2-S2 启用
  "provider/switch", // 保留位：P2-S3 启用
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/** 本阶段可写入（启用）类型：v0 七类 + session/compaction + session/repair（owner 口径 #1：未实现类型不得被写入）。 */
export const SESSION_ENABLED_EVENT_TYPES = [
  "user/message",
  "assistant/message",
  "assistant/attempt",
  "tool/call",
  "tool/result",
  "turn/start",
  "turn/end",
  "session/compaction",
  "session/repair",
] as const;

/** schema v1 保留位类型：已登记未启用——写入与落盘流中出现一律拒绝（fail-closed）。 */
export const SESSION_RESERVED_EVENT_TYPES = ["approval/request", "approval/response", "provider/switch"] as const;

export const isSessionEventType = (value: unknown): value is SessionEventType =>
  typeof value === "string" && (SESSION_EVENT_TYPES as readonly string[]).includes(value);

/** 是否为当前可写入（已启用）的事件类型。 */
export const isEnabledEventType = (value: unknown): value is SessionEventType =>
  isSessionEventType(value) && !(SESSION_RESERVED_EVENT_TYPES as readonly string[]).includes(value);

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
    return `未知事件 type: ${String(value["type"])}（schema v1 白名单外一律拒绝）`;
  }
  if (!isEnabledEventType(value["type"])) {
    // 保留位类型（approval/*、provider/switch）在启用 slice（P2-S2/S3）前不得写入或出现于落盘流
    return `事件 type 未启用（schema v1 保留位）: ${String(value["type"])}`;
  }
  if (!("payload" in value)) return "事件缺少 payload 字段";
  if (!isPlainObject(value["projection"]) || !("evidence_event" in value["projection"])) {
    return "事件缺少 projection 字段位（schema v1 要求必须存在）";
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

/** domain_refs 类型收窄的便利判断（空数组语义 = 无引用）。 */
export const hasDomainRefs = (event: SessionEvent): boolean =>
  event.domain_refs !== undefined && event.domain_refs.length > 0;
