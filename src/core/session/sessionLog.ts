/**
 * SessionLog——append-only 会话事件流存储（Phase 1 任务书 S2 / P2-S1 升级，登记于 session.contract.yaml）。
 *
 * 纪律：
 * - 先落盘再继续：durability 契约按档位（P2-S1，owner 决议四，常量见 constants.ts）：
 *   · 逐条档 per-append（默认）：write + fsync 后 ack——ack ⇒ 已持久化，已确认事件永不丢；
 *   · 批量档 batch：write 完成（数据交 OS，顺序保留）即 ack，fsync 攒批在 N 条 / T 毫秒
 *     边界异步补做——持久化确认点 = 刷盘水位线（unsyncedEvents 归零）；进程崩溃不丢已写入
 *     事件，断电级持久性以水位线为准（性能档位，适用于可容忍丢尾部的场景）。
 *   档位收在常量/选项层，模型不可见。
 * - append-only：只追加、不改写不删除，崩溃可由 replay 重建；
 * - fail-closed：schema 违规（未知 type / 保留位未启用 type）拒绝写入；digest 校验失败的
 *   事件带 ref_invalid 标记落盘（事实留痕）并返回结构化 block；resolver 查询自身失败
 *   不落盘、不猜测；
 * - 压缩审计：实质事件数达到压缩阈值时，压缩动作自动落盘为 session/compaction 审计事件
 *   （可回答「哪次压缩吃掉了哪些事件」）；同一折叠边界只记一次（按 covers.to_id 判重），
 *   审计写入失败按写路径失败上报（fail-closed）。
 * - 禁止异常穿越边界：一切可能失败的路径返回 Result。
 */
import { open, mkdir, readFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";
import {
  FSYNC_BATCH_MAX_EVENTS,
  FSYNC_BATCH_WINDOW_MS,
  FSYNC_DEFAULT_MODE,
} from "./constants.js";
import { buildCompactionRecord, materialOf, planCompaction } from "./compaction.js";
import { compactionTriggerTokens } from "./constantsBudget.js";
import { type InvalidRef, sessionError, type SessionBlock, type SessionError } from "./errors.js";
import {
  asSessionEvent,
  isEnabledEventType,
  SESSION_RESERVED_EVENT_TYPES,
  validateDomainRef,
  validateEventEnvelope,
  type SessionEvent,
  type SessionEventInput,
} from "./schema.js";
import { type DigestResolver } from "./digestResolver.js";

/** 单行字节上限（与会话协议同量级的防御性常量；超限 = corrupt_stream，不猜测截断）。 */
export const MAX_SESSION_LINE_BYTES = 1_048_576;

/** fsync 档位（owner 决议四：默认逐条；批量窗口为可配置性能档）。 */
export type FsyncMode = "per-append" | "batch";

/** fsync 配置（默认值收在 constants.ts 常量层；选项仅供测试/嵌入方注入，模型不可见）。 */
export interface FsyncOptions {
  mode?: FsyncMode;
  batchMaxEvents?: number;
  batchWindowMs?: number;
}

export interface SessionLogOptions {
  /** 时间源注入（默认 UTC ISO 8601）；测试可用固定时钟。 */
  now?: () => string;
  /** durability 档位（缺省 = 常量层默认：逐条 fsync）。 */
  fsync?: FsyncOptions;
}

/** append 结果：干净落盘，或落盘但触发 block（ref_invalid 留痕）。 */
export type AppendOutcome =
  | { status: "appended"; event: SessionEvent }
  | { status: "appended_blocked"; event: SessionEvent; block: SessionBlock };

/** replay 结果：完整事件序列 + 校验发现的全部 block + 尾部修复事实（events 与磁盘逐条对应，文件只读不改写）。 */
export interface ReplayOutcome {
  events: SessionEvent[];
  blocks: SessionBlock[];
  /** S1a：末尾未确认残段被丢弃的事实（replay 只读不改写，null = 无残段）；S1b 收紧为必填。 */
  truncated_tail: TruncatedTail | null;
}

/** 尾部未确认残段的丢弃事实（S1a，决议 §2.1.5）。 */
export interface TruncatedTail {
  dropped_bytes: number;
  dropped_from_offset: number;
}

interface ResolvedFsync {
  mode: FsyncMode;
  batchMaxEvents: number;
  batchWindowMs: number;
}

export class SessionLog {
  private nextId: number;
  private readonly now: () => string;
  private readonly fsync: ResolvedFsync;
  /** 内存事件序列（含审计事件）：压缩计划的输入；create 时从既有流装载。 */
  private readonly history: SessionEvent[] = [];
  private handle: FileHandle | null = null;
  /** 批量档：已 write 未 fsync 的事件数（持久化水位线的逆向指标）。 */
  private unsyncedCount = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** S1a：create 时对尾部未确认残段执行截断修复的事实（null = 无残段）。 */
  public readonly truncatedTail: TruncatedTail | null;

  private constructor(
    private readonly filePath: string,
    private readonly resolver: DigestResolver,
    nextId: number,
    options: SessionLogOptions,
    history: SessionEvent[],
    truncatedTail: TruncatedTail | null,
  ) {
    this.nextId = nextId;
    this.history.push(...history);
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.fsync = {
      mode: options.fsync?.mode ?? FSYNC_DEFAULT_MODE,
      batchMaxEvents: options.fsync?.batchMaxEvents ?? FSYNC_BATCH_MAX_EVENTS,
      batchWindowMs: options.fsync?.batchWindowMs ?? FSYNC_BATCH_WINDOW_MS,
    };
    this.truncatedTail = truncatedTail;
  }

  /**
   * 打开（或创建）一个会话日志。digest 校验对端（resolver）为必要依赖——
   * 会话层自创建起即具备 domain_refs 校验能力。
   * 若文件已存在，从既有行续接 id 序列并装载内存历史（崩溃恢复语义；
   * 压缩审计判重依赖历史，重开后不会对同一折叠边界重复记审计）。
   * S1a 尾部策略：末尾未确认残段（无结尾 LF）按 §2.1 判定为从未 ack 的不完整写入——
   * 先物理截断该残段，再成对写入 session/repair 审计留痕（留痕写失败 = 修复失败上报，
   * fail-closed），修复事实经实例 truncatedTail 携带；中间行损坏仍 fail-closed。
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
    if (read.value === null) return ok(new SessionLog(filePath, resolver, 1, options, [], null));

    const scan = scanTailFragment(read.value);
    const history: SessionEvent[] = [];
    let maxId = 0;
    for (const line of splitLines(scan.bodyText)) {
      const parsed = SessionLog.parseLine(line);
      if (!parsed.ok) return parsed;
      if (parsed.value.event.id !== maxId + 1) {
        return err(sessionError("corrupt_stream", `既有会话流 id 不连续：期望 ${String(maxId + 1)}，实得 ${String(parsed.value.event.id)}`));
      }
      maxId = parsed.value.event.id;
      history.push(parsed.value.event);
    }

    let truncatedTail: TruncatedTail | null = null;
    if (scan.tail !== null) {
      // 物理截断：丢弃从未 ack 过的残段（不触及任何已确认事件）
      const truncated = await truncateTail(filePath, scan.tail);
      if (!truncated.ok) return truncated;
      truncatedTail = { dropped_bytes: scan.tail.droppedBytes, dropped_from_offset: scan.tail.droppedFromOffset };
    }
    const log = new SessionLog(filePath, resolver, maxId + 1, options, history, truncatedTail);

    if (scan.tail !== null) {
      // 成对留痕：截断与 session/repair 事件必须成对；留痕写失败 = 修复失败上报（fail-closed）
      const recorded = await log.append({
        type: "session/repair",
        payload: {
          dropped_bytes: scan.tail.droppedBytes,
          dropped_from_offset: scan.tail.droppedFromOffset,
          tail_excerpt: scan.tail.excerpt,
          tail_sha256: scan.tail.sha256,
        },
      });
      if (!recorded.ok) {
        return err(sessionError("io_error", "尾部截断修复的留痕写入失败（fail-closed，修复未完成上报）", {
          stage: "tail_repair_audit",
          truncated_tail: truncatedTail,
          cause: recorded.error,
        }));
      }
    }
    return ok(log);
  }

  /**
   * 从磁盘全量重建会话（验收用例 1 的承载），并逐事件重新做 digest 校验（验收用例 2）。
   * 文件本身只读不改写；校验失败的事件在内存中带 ref_invalid 标记并出现在 blocks 中。
   * S1a 尾部策略：末尾未确认残段在内存中丢弃并以 truncated_tail 报告（文件不动）；
   * 中间行损坏（坏行 / id 断裂 / schema 违规，含保留位类型出现于流内）= err——文件被篡改到
   * 不可信，fail-closed。
   */
  public static async replay(filePath: string, resolver: DigestResolver): Promise<Result<ReplayOutcome, SessionError>> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (cause) {
      const errno = (cause as NodeJS.ErrnoException).code;
      return err(sessionError("io_error", `读取会话日志失败: ${(cause as Error).message}`, { code: errno }));
    }

    const scan = scanTailFragment(text);
    const events: SessionEvent[] = [];
    const blocks: SessionBlock[] = [];
    let expectedId = 1;
    for (const line of splitLines(scan.bodyText)) {
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
    return ok({
      events,
      blocks,
      truncated_tail: scan.tail === null ? null : { dropped_bytes: scan.tail.droppedBytes, dropped_from_offset: scan.tail.droppedFromOffset },
    });
  }

  /**
   * 追加一条事件：schema 校验（白名单 + 保留位未启用拒写）→ digest 校验 → 构造完整事件 →
   * durability 落盘 → 压缩审计（按需）。白名单外 / 未启用 type / 结构违规 = err 且不落盘；
   * digest 失效 = 带 ref_invalid 标记落盘 + 返回 block。
   */
  public async append(input: SessionEventInput): Promise<Result<AppendOutcome, SessionError>> {
    if (!isEnabledEventType(input.type)) {
      if ((SESSION_RESERVED_EVENT_TYPES as readonly string[]).includes(input.type)) {
        return err(sessionError("schema_violation", `事件 type 未启用（schema v1 保留位）: ${String(input.type)}`));
      }
      return err(sessionError("schema_violation", `未知事件 type: ${String(input.type)}（schema v1 白名单外一律拒绝写入）`));
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

    const written = await this.appendEvent(event);
    if (!written.ok) return written;

    // 压缩审计（按需、同一折叠边界只记一次）；留痕写入失败按写路径失败上报（fail-closed）
    const audited = await this.recordCompactionAuditIfNeeded();
    if (!audited.ok) return audited;

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

  /**
   * 立即 fsync：把批量档尚未刷盘的事件刷入磁盘（持久化水位线推进到最新已写入事件；
   * 逐条档为空操作——事件本就在 ack 前 fsync）。返回 = 全部已写入事件已持久化。
   */
  public async flush(): Promise<Result<void, SessionError>> {
    return this.syncNow();
  }

  /** 刷盘并关闭句柄；关闭后 append 一律 err（fail-closed，不猜测写入成功）。 */
  public async close(): Promise<Result<void, SessionError>> {
    const synced = await this.syncNow();
    this.closed = true;
    if (this.handle !== null) {
      try {
        await this.handle.close();
      } catch (cause) {
        return err(sessionError("io_error", `会话日志句柄关闭失败: ${(cause as Error).message}`));
      } finally {
        this.handle = null;
      }
    }
    return synced;
  }

  /** 批量档持久化水位线（诊断/测试用）：已 write 未 fsync 的事件数；逐条档恒 0。 */
  public get unsyncedEvents(): number {
    return this.fsync.mode === "batch" ? this.unsyncedCount : 0;
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

  /** 序列化 → durability 落盘 → 成功后登记内存历史与 id 推进（主事件与审计事件共用）。 */
  private async appendEvent(event: SessionEvent): Promise<Result<void, SessionError>> {
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (cause) {
      return err(sessionError("schema_violation", `事件不可序列化（payload 可能含循环引用）: ${String(cause)}`));
    }
    if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
      return err(sessionError("schema_violation", `事件行超限（>${String(MAX_SESSION_LINE_BYTES)} 字节），拒绝写入`));
    }
    const written = await this.writeDurably(line);
    if (!written.ok) return written;
    this.nextId = event.id + 1;
    this.history.push(event);
    return ok(undefined);
  }

  /**
   * durability 写入：
   * - per-append（默认）：write + fsync 后返回——ack ⇒ 已持久化；
   * - batch：write 完成即返回（ack ⇒ 已写入 OS，顺序保留）；fsync 攒批补做：
   *   攒满 N 条立即 sync，否则自首条未刷事件起 T 毫秒窗口到期 sync（时钟 unref 不驻留进程）。
   */
  private async writeDurably(line: string): Promise<Result<void, SessionError>> {
    const handle = await this.ensureHandle();
    if (!handle.ok) return err(handle.error);
    try {
      await handle.value.write(line);
    } catch (cause) {
      return ioFailure("会话日志写入失败", cause);
    }
    if (this.fsync.mode === "per-append") {
      return this.syncNow();
    }
    this.unsyncedCount += 1;
    if (this.unsyncedCount >= this.fsync.batchMaxEvents) {
      return this.syncNow();
    }
    this.armFlushTimer();
    return ok(undefined);
  }

  /** fsync 当前全部已写入事件（两档通用；推进持久化水位线）。 */
  private async syncNow(): Promise<Result<void, SessionError>> {
    this.disarmFlushTimer();
    if (this.handle === null || this.unsyncedCount === 0) return ok(undefined);
    try {
      await this.handle.sync();
    } catch (cause) {
      return ioFailure("会话日志 fsync 失败", cause);
    }
    this.unsyncedCount = 0;
    return ok(undefined);
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null) return; // 窗口自首条未刷事件起算，不重置
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.syncNow();
    }, this.fsync.batchWindowMs);
    this.flushTimer.unref(); // 空转时钟不驻留进程
  }

  private disarmFlushTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async ensureHandle(): Promise<Result<FileHandle, SessionError>> {
    if (this.closed) {
      return err(sessionError("io_error", "会话日志已关闭（fail-closed，不猜测写入成功）"));
    }
    if (this.handle !== null) return ok(this.handle);
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      this.handle = await open(this.filePath, "a"); // O_APPEND 语义：只追加
      return ok(this.handle);
    } catch (cause) {
      return ioFailure("会话日志打开失败", cause);
    }
  }

  /**
   * 压缩审计（按需）：实质事件序列达到折叠边界且该边界尚未记录时，落盘一条
   * session/compaction 审计事件（payload = 确定性压缩记录，covers.to_id 判重）。
   * 审计事件对计划透明（materialOf），不会引发递归审计。
   * L1c 提前批 A1.5.2（放行件 v7 ★段解冻消费点：审计语义零改，仅触发水位与投影径
   * 同源——compactionTriggerTokens() 与 runner seam 读同一进程级注入值，同源铁律）。
   */
  private async recordCompactionAuditIfNeeded(): Promise<Result<void, SessionError>> {
    const plan = planCompaction(this.history, compactionTriggerTokens());
    if (plan.boundary === 0) return ok(undefined);
    const material = materialOf(this.history);
    const anchor = material[plan.boundary - 1];
    if (anchor === undefined) return ok(undefined); // 防御：边界与序列不一致时宁缺审计，不猜测
    if (this.lastRecordedCompactionBoundary() >= anchor.id) return ok(undefined);
    const payload = buildCompactionRecord(material, plan);
    const auditEvent: SessionEvent = {
      id: this.nextId,
      ts: this.now(),
      type: "session/compaction",
      payload,
      projection: { evidence_event: null },
    };
    return this.appendEvent(auditEvent);
  }

  /** 最近一条审计事件记录的折叠边界（covers.to_id）；无审计 = 0。 */
  private lastRecordedCompactionBoundary(): number {
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const event = this.history[i] as SessionEvent;
      if (event.type !== "session/compaction") continue;
      const covers = (event.payload as { covers?: { to_id?: unknown } } | null | undefined)?.covers;
      return typeof covers?.to_id === "number" ? covers.to_id : 0;
    }
    return 0;
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

interface ParsedLine {
  event: SessionEvent;
}

const ioFailure = (summary: string, cause: unknown): Result<never, SessionError> =>
  err(sessionError("io_error", `${summary}: ${(cause as Error).message}`, { code: (cause as NodeJS.ErrnoException).code }));

/** 尾部残段（S1a）：从未被 ack 的不完整写入的度量与取证信息。 */
interface TailFragment {
  droppedBytes: number;
  droppedFromOffset: number;
  excerpt: string;
  sha256: string;
}

interface StreamScan {
  bodyText: string;
  tail: TailFragment | null;
}

/**
 * S1a 尾部策略：文件非空且不以 LF 结尾 → 末段为「未确认尾部」（write 未完成的残段，
 * 从未被 ack），无论其内容是否可解析一律判为残段；紧邻残段的空行（\n\n）同属未确认
 * 尾部一并丢弃（否则该形态会落入中间空行损坏规则）；容忍仅限文件末尾——中间行不可
 * 解析 / id 断裂不在此列（仍 fail-closed corrupt_stream）。
 */
const scanTailFragment = (text: string): StreamScan => {
  if (text === "" || text.endsWith("\n")) return { bodyText: text, tail: null };
  let cut = text.lastIndexOf("\n");
  while (cut > 0 && text[cut - 1] === "\n") cut -= 1;
  if (cut <= 0) {
    // 整个文件不含任何完整行：全部判为未确认残段
    return { bodyText: "", tail: makeFragment(text, 0) };
  }
  const bodyText = text.slice(0, cut + 1);
  return { bodyText, tail: makeFragment(text.slice(cut + 1), Buffer.byteLength(bodyText, "utf8")) };
};

const makeFragment = (fragment: string, droppedFromOffset: number): TailFragment => ({
  droppedBytes: Buffer.byteLength(fragment, "utf8"),
  droppedFromOffset,
  excerpt: fragment.slice(0, 64),
  sha256: createHash("sha256").update(fragment, "utf8").digest("hex"),
});

/** 物理截断尾部残段（UTF-8 字节精确；只作用于从未 ack 的残段，不触及任何已确认事件）。 */
const truncateTail = async (filePath: string, tail: TailFragment): Promise<Result<void, SessionError>> => {
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, "r+");
    await handle.truncate(tail.droppedFromOffset);
    await handle.close();
    return ok(undefined);
  } catch (cause) {
    if (handle !== null) await handle.close().catch(() => undefined);
    return ioFailure("尾部残段截断失败", cause);
  }
};

/** 按行切分落盘文本：容忍结尾 LF；中间空行视为损坏流（严格 LF 分帧，与会话协议同口径）。 */
function* splitLines(text: string): Generator<string> {
  if (text === "") return;
  const lines = text.split("\n");
  const last = lines.pop();
  for (const line of lines) yield line;
  if (last !== undefined && last !== "") yield last;
}
