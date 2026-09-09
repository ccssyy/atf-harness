/**
 * SessionLog——append-only 会话事件流存储（Phase 1 任务书 S2，登记于 session.contract.yaml）。
 *
 * 纪律：
 * - 先落盘再继续：append 等待写入完成才返回（任务书硬约束）；
 * - append-only：只追加、不改写不删除，崩溃可由 replay 重建；
 * - fail-closed：schema 违规拒绝写入；digest 校验失败的事件带 ref_invalid 标记落盘（事实留痕）
 *   并返回结构化 block；resolver 查询自身失败不落盘、不猜测；
 * - 禁止异常穿越边界：一切可能失败的路径返回 Result。
 */
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { type InvalidRef, sessionError, type SessionBlock, type SessionError } from "./errors.js";
import {
  asSessionEvent,
  isSessionEventType,
  validateDomainRef,
  validateEventEnvelope,
  type DomainRef,
  type SessionEvent,
  type SessionEventInput,
} from "./schema.js";
import { type DigestResolver } from "./digestResolver.js";

/** 单行字节上限（与会话协议同量级的防御性常量；超限 = corrupt_stream，不猜测截断）。 */
export const MAX_SESSION_LINE_BYTES = 1_048_576;

/** append 结果：干净落盘，或落盘但触发 block（ref_invalid 留痕）。 */
export type AppendOutcome =
  | { status: "appended"; event: SessionEvent }
  | { status: "appended_blocked"; event: SessionEvent; block: SessionBlock };

/** replay 结果：完整事件序列 + 校验发现的全部 block（events 与磁盘逐条对应，文件只读不改写）。 */
export interface ReplayOutcome {
  events: SessionEvent[];
  blocks: SessionBlock[];
}

export interface SessionLogOptions {
  /** 时间源注入（默认 UTC ISO 8601）；测试可用固定时钟。 */
  now?: () => string;
}

interface ParsedLine {
  event: SessionEvent;
}

export class SessionLog {
  private nextId: number;
  private readonly now: () => string;

  private constructor(
    private readonly filePath: string,
    private readonly resolver: DigestResolver,
    nextId: number,
    options: SessionLogOptions,
  ) {
    this.nextId = nextId;
    this.now = options.now ?? ((): string => new Date().toISOString());
  }

  /**
   * 打开（或创建）一个会话日志。digest 校验对端（resolver）为必要依赖——
   * 会话层自创建起即具备 domain_refs 校验能力。
   * 若文件已存在，从既有行续接 id 序列（崩溃恢复语义）；
   * 既有行结构损坏 = err（fail-closed，不在损坏流上继续追加）。
   * 注意：打开阶段只校验结构，不做 digest 校验——那是 replay 的职责。
   */
  public static async create(
    filePath: string,
    resolver: DigestResolver,
    options: SessionLogOptions = {},
  ): Promise<Result<SessionLog, SessionError>> {
    const read = await readFile(filePath, "utf8").then(
      (text): Result<string | null, SessionError> => ok(text),
      (cause: NodeJS.ErrnoException): Result<string | null, SessionError> =>
        cause.code === "ENOENT" ? ok(null) : err(sessionError("io_error", `读取会话日志失败: ${String(cause.message)}`, { code: cause.code })),
    );
    if (!read.ok) return read;
    if (read.value === null) return ok(new SessionLog(filePath, resolver, 1, options));

    let maxId = 0;
    for (const line of splitLines(read.value)) {
      const parsed = SessionLog.parseLine(line);
      if (!parsed.ok) return parsed;
      if (parsed.value.event.id !== maxId + 1) {
        return err(sessionError("corrupt_stream", `既有会话流 id 不连续：期望 ${String(maxId + 1)}，实得 ${String(parsed.value.event.id)}`));
      }
      maxId = parsed.value.event.id;
    }
    return ok(new SessionLog(filePath, resolver, maxId + 1, options));
  }

  /**
   * 从磁盘全量重建会话（验收用例 1 的承载），并逐事件重新做 digest 校验（验收用例 2）。
   * 文件本身只读不改写；校验失败的事件在内存中带 ref_invalid 标记并出现在 blocks 中。
   * 结构损坏（坏行 / id 断裂 / schema 违规）= err——文件被篡改到不可信，fail-closed。
   */
  public static async replay(filePath: string, resolver: DigestResolver): Promise<Result<ReplayOutcome, SessionError>> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (cause) {
      const errno = (cause as NodeJS.ErrnoException).code;
      return err(sessionError("io_error", `读取会话日志失败: ${(cause as Error).message}`, { code: errno }));
    }

    const events: SessionEvent[] = [];
    const blocks: SessionBlock[] = [];
    let expectedId = 1;
    for (const line of splitLines(text)) {
      const parsed = SessionLog.parseLine(line);
      if (!parsed.ok) return parsed;
      const event = parsed.value.event;
      if (event.id !== expectedId) {
        return err(sessionError("corrupt_stream", `会话流 id 不连续：期望 ${String(expectedId)}，实得 ${String(event.id)}`));
      }
      expectedId += 1;

      const checked = await SessionLog.checkRefs(event, resolver);
      if (!checked.ok) return checked;
      if (checked.value !== null) {
        event.ref_invalid = checked.value.invalidRefs;
        blocks.push(checked.value.block);
      }
      events.push(event);
    }
    return ok({ events, blocks });
  }

  /**
   * 追加一条事件：schema 校验 → digest 校验 → 构造完整事件 → 落盘。
   * 白名单外 type / 结构违规 = err 且不落盘；digest 失效 = 带 ref_invalid 标记落盘 + 返回 block。
   */
  public async append(input: SessionEventInput): Promise<Result<AppendOutcome, SessionError>> {
    if (!isSessionEventType(input.type)) {
      return err(sessionError("schema_violation", `未知事件 type: ${String(input.type)}（schema v0 白名单外一律拒绝写入）`));
    }
    if (input.payload === undefined) {
      // undefined 不是 JSON 值：stringify 会静默省略该字段，落盘即坏行（replay 时 payload 缺失）
      return err(sessionError("schema_violation", "payload 必填（undefined 不是合法 JSON 值）"));
    }
    if (input.domain_refs !== undefined) {
      if (!Array.isArray(input.domain_refs)) {
        return err(sessionError("schema_violation", "domain_refs 非法（须为数组）"));
      }
      for (let i = 0; i < input.domain_refs.length; i += 1) {
        const violation = validateDomainRef(input.domain_refs[i]);
        if (violation !== null) {
          return err(sessionError("schema_violation", `domain_refs[${String(i)}] ${violation}`));
        }
      }
    }

    const event: SessionEvent = {
      id: this.nextId,
      ts: this.now(),
      type: input.type,
      payload: input.payload,
      projection: { evidence_event: null }, // ADR-06 细则 3：字段位必须存在，Phase 3 前恒 null
    };
    if (input.domain_refs !== undefined) event.domain_refs = input.domain_refs;
    if (input.ui !== undefined) event.ui = input.ui;

    // digest 校验（无引用则跳过）；resolver 查询自身失败 = 不落盘、不猜测
    let invalidRefs: InvalidRef[] | null = null;
    if (event.domain_refs !== undefined && event.domain_refs.length > 0) {
      const checked = await SessionLog.checkRefs(event, this.resolver);
      if (!checked.ok) return checked;
      if (checked.value !== null) {
        event.ref_invalid = checked.value.invalidRefs;
        invalidRefs = checked.value.invalidRefs;
      }
    }

    const write = await this.writeLine(event);
    if (!write.ok) return write;
    this.nextId += 1;

    if (invalidRefs === null) return ok({ status: "appended", event });
    return ok({
      status: "appended_blocked",
      event,
      block: {
        reason: "ref_invalid",
        message: `事件 ${String(event.id)} 的 domain_refs 未通过 digest 校验（fail-closed block）`,
        event_id: event.id,
        invalid_refs: invalidRefs,
      },
    });
  }

  // ------------------------------------------------------------------ 内部

  /** 对单条事件执行 digest 校验：通过返回 null；失效返回标记 + block；查询自身失败返回 err。 */
  private static async checkRefs(
    event: SessionEvent,
    resolver: DigestResolver,
  ): Promise<Result<{ invalidRefs: InvalidRef[]; block: SessionBlock } | null, SessionError>> {
    if (event.domain_refs === undefined || event.domain_refs.length === 0) return ok(null);
    const invalidRefs: InvalidRef[] = [];
    for (let index = 0; index < event.domain_refs.length; index += 1) {
      const ref = event.domain_refs[index];
      if (ref === undefined) continue;
      const lookup = await resolver.lookupDigest(ref.journal_type, ref.fact_id);
      if (!lookup.ok) {
        return err(
          sessionError("resolver_failure", `digest 查询失败（${ref.journal_type}/${ref.fact_id}）: ${lookup.error.message}`, {
            journal_type: ref.journal_type,
            fact_id: ref.fact_id,
            cause: lookup.error,
          }),
        );
      }
      if (lookup.value.status === "found" && lookup.value.sha256_digest === ref.sha256_digest) continue;
      invalidRefs.push({
        index,
        journal_type: ref.journal_type,
        fact_id: ref.fact_id,
        claimed_digest: ref.sha256_digest,
        cause: lookup.value.status === "found" ? "digest_mismatch" : "fact_not_found",
      });
    }
    if (invalidRefs.length === 0) return ok(null);
    return ok({
      invalidRefs,
      block: {
        reason: "ref_invalid",
        message: `事件 ${String(event.id)} 的 domain_refs 未通过 digest 校验（fail-closed block）`,
        event_id: event.id,
        invalid_refs: invalidRefs,
      },
    });
  }

  private async writeLine(event: SessionEvent): Promise<Result<void, SessionError>> {
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (cause) {
      return err(sessionError("schema_violation", `事件不可序列化（payload 可能含循环引用）: ${String(cause)}`));
    }
    if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
      return err(sessionError("schema_violation", `事件行超限（>${String(MAX_SESSION_LINE_BYTES)} 字节），拒绝写入`));
    }
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8"); // O_APPEND 语义：先落盘再继续
      return ok(undefined);
    } catch (cause) {
      return err(sessionError("io_error", `会话日志写入失败: ${(cause as Error).message}`, { code: (cause as NodeJS.ErrnoException).code }));
    }
  }

  private static parseLine(line: string): Result<ParsedLine, SessionError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const excerpt = line.length > 120 ? `${line.slice(0, 120)}…` : line;
      return err(sessionError("corrupt_stream", `非法 JSON 行: ${excerpt || "<空行>"}`));
    }
    if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
      return err(sessionError("corrupt_stream", `单行超限（>${String(MAX_SESSION_LINE_BYTES)} 字节）`));
    }
    const violation = validateEventEnvelope(parsed);
    if (violation !== null) return err(sessionError("schema_violation", violation));
    return ok({ event: asSessionEvent(parsed as Record<string, unknown>) });
  }
}

/** 按行切分落盘文本：容忍结尾 LF；中间空行视为损坏流（严格 LF 分帧，与会话协议同口径）。 */
function* splitLines(text: string): Generator<string> {
  if (text === "") return;
  const lines = text.split("\n");
  const last = lines.pop();
  for (const line of lines) yield line;
  if (last !== undefined && last !== "") yield last;
}

/** domain_refs 类型收窄的便利判断（空数组语义 = 无引用）。 */
export const hasDomainRefs = (event: SessionEvent): boolean =>
  event.domain_refs !== undefined && event.domain_refs.length > 0;
