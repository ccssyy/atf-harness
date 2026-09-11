/**
 * 铁律一（ADR-08：T0 不可引用为证据）的 domain_refs 校验扩展
 * （任务书 §4.4 / owner 口径 #4：扩展方式接入，不修改 src/session/ 既有语义）。
 *
 * 接线形态 = GuardedSessionLog 包装 SessionLog（S2 会话校验入口）：
 * - append：写入前先对本事件 domain_refs 逐条做 scratch/ 前缀判定，命中 → 返回首类结构化
 *   block（reason = t0_ref_forbidden，cause 登记于 workspace.contract.yaml）且**事件不落盘**
 *   （直接拒绝）；未命中 → 原样委托内层 SessionLog（digest 校验等 S2 既有语义零改动）；
 * - replay：先委托内层重建，再对重建事件逐条扫描——流内出现 scratch 引用 = 流不可信
 *   （fail-closed → blocked），文件本身只读不改写（与会话流事实留痕纪律一致）。
 *
 * 设计说明（为何不经 DigestResolver 通道注入）：S2 checkRefs 会把 resolver 的 err 统一
 * 包装为 resolver_failure（基础设施故障语义）——策略拒绝经该通道将被错误标注且归因深埋；
 * S2 的 ref_invalid cause 枚举（digest_mismatch | fact_not_found）固定，无法承载
 * t0_ref_forbidden。包装 SessionLog 入口是唯一不修改 src/session/、又不复用/污染既有
 * 语义的扩展点（owner 口径 #4"新增规则注入或包装校验器"之包装形态）。
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { type Result } from "../bridge/index.js";
import {
  SessionLog,
  type AppendOutcome,
  type DigestResolver,
  type SessionBlock,
  type SessionError,
  type SessionEventInput,
  type SessionLogOptions,
  type ReplayOutcome,
  type TruncatedTail,
} from "../session/index.js";

/** 铁律一拒绝归因（workspace.contract.yaml t0_ref_forbidden 节登记）。 */
export const T0_REF_FORBIDDEN = "t0_ref_forbidden";

/**
 * scratch/ 前缀判定（workspace.contract.yaml t0_ref_forbidden.path_semantics）：
 * ① 词法前缀：引用为 "scratch" 或 "scratch/..."（run 相对形态）；
 * ② 包含判定：绝对引用 resolve 后落于 scratchRoot 内；相对引用以 run 根（scratchRoot 父目录）为基解析后判定。
 * 不限 journal_type——fail-closed：任何携带 scratch 路径形态的引用一律命中。
 */
export const isScratchReference = (ref: string, scratchRoot: string): boolean => {
  if (typeof ref !== "string" || ref === "") return false;
  if (ref === "scratch" || ref.startsWith("scratch/")) return true;
  const scratchAbs = resolve(scratchRoot);
  const refAbs = isAbsolute(ref) ? resolve(ref) : resolve(dirname(scratchAbs), ref);
  const rel = relative(scratchAbs, refAbs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** 铁律一结构化 block（cause = t0_ref_forbidden；与 S2 SessionBlock 同构不同型——不混用既有枚举）。 */
export interface T0RefBlock {
  reason: "t0_ref_forbidden";
  message: string;
  /** 命中拒绝的引用明细（index = 在事件 domain_refs 数组中的下标） */
  invalid_refs: Array<{ index: number; journal_type: string; fact_id: string }>;
}

/** GuardedSessionLog.append 结果：rejected = 铁律一拒绝（事件不落盘）；其余为 S2 既有两态原样透传。 */
export type GuardedAppendOutcome =
  | { status: "rejected"; block: T0RefBlock }
  | AppendOutcome;

/** GuardedSessionLog.replay 结果：blocked = 流内含 T0 引用（fail-closed，文件只读不改写）。 */
export type GuardedReplayOutcome =
  | { kind: "blocked"; block: T0RefBlock }
  | ({ kind: "replayed" } & ReplayOutcome);

export class GuardedSessionLog {
  private constructor(
    private readonly inner: SessionLog,
    private readonly scratchRoot: string,
  ) {}

  /** S1b（L-2）：透传内层的尾部修复事实——run 层经包装实例亦可读，不再静默丢失。 */
  public get truncatedTail(): TruncatedTail | null {
    return this.inner.truncatedTail;
  }

  /**
   * S2a（决议 §3.3，C-2）：透传内层句柄显式关闭（批量档冲刷 + close；关闭后 append 一律
   * err，fail-closed）——消除 FileHandle 依赖 GC 回收的 DeprecationWarning。纯新增透传，
   * 不触及 append/replay 任何既有语义。
   */
  public async close(): Promise<Result<void, SessionError>> {
    return this.inner.close();
  }

  /** 打开（或创建）挂载铁律一规则的会话日志。resolver 为 S2 既有注入口（digest 校验），原样透传。 */
  public static async create(
    filePath: string,
    resolver: DigestResolver,
    scratchRoot: string,
    options: SessionLogOptions = {},
  ): Promise<Result<GuardedSessionLog, SessionError>> {
    const inner = await SessionLog.create(filePath, resolver, options);
    if (!inner.ok) return inner;
    return { ok: true, value: new GuardedSessionLog(inner.value, scratchRoot) };
  }

  /**
   * 追加事件：先做铁律一前置校验（scratch 引用 → rejected + 事件不落盘），
   * 未命中再委托 S2（结构校验 / digest 校验 / 落盘）。
   */
  public async append(input: SessionEventInput): Promise<Result<GuardedAppendOutcome, SessionError>> {
    const t0 = scanDomainRefs(input.domain_refs, this.scratchRoot);
    if (t0 !== null) {
      return {
        ok: true,
        value: {
          status: "rejected",
          block: {
            reason: "t0_ref_forbidden",
            message: `T0 不可引用为证据（铁律一）：引用 ${t0.invalid_refs.map((ref) => ref.fact_id).join(", ")} 落于 scratch/ 前缀，事件不落盘`,
            invalid_refs: t0.invalid_refs,
          },
        },
      };
    }
    const delegated = await this.inner.append(input);
    if (!delegated.ok) return delegated;
    return { ok: true, value: delegated.value };
  }

  /**
   * 从磁盘全量重建：先委托 S2 replay（结构校验 + digest 校验），再对重建出的事件逐条
   * 扫描铁律一——流内出现 scratch 引用 = 流不可信 → blocked（文件只读不改写）。
   * S1b（L-2）：透传 truncated_tail（尾部修复事实），拦截语义逐位不变。
   */
  public static async replay(
    filePath: string,
    resolver: DigestResolver,
    scratchRoot: string,
  ): Promise<Result<GuardedReplayOutcome, SessionError>> {
    const delegated = await SessionLog.replay(filePath, resolver);
    if (!delegated.ok) return delegated;
    const allRefs = delegated.value.events.flatMap((event) => event.domain_refs ?? []);
    const t0 = scanDomainRefs(allRefs, scratchRoot);
    if (t0 !== null) {
      return {
        ok: true,
        value: {
          kind: "blocked",
          block: {
            reason: "t0_ref_forbidden",
            message: "T0 不可引用为证据（铁律一）：流内出现落于 scratch/ 前缀的引用，流不可信（fail-closed）",
            invalid_refs: t0.invalid_refs,
          },
        },
      };
    }
    return {
      ok: true,
      value: {
        kind: "replayed",
        events: delegated.value.events,
        blocks: delegated.value.blocks,
        truncated_tail: delegated.value.truncated_tail,
      },
    };
  }
}

/** 逐条判定 domain_refs：命中 scratch 前缀 → 结构化明细（null = 无命中）。 */
const scanDomainRefs = (
  domainRefs: readonly { journal_type: string; fact_id: string }[] | undefined,
  scratchRoot: string,
): { invalid_refs: T0RefBlock["invalid_refs"] } | null => {
  if (domainRefs === undefined || domainRefs.length === 0) return null;
  const invalidRefs: T0RefBlock["invalid_refs"] = [];
  for (let index = 0; index < domainRefs.length; index += 1) {
    const ref = domainRefs[index];
    if (ref === undefined) continue;
    if (isScratchReference(ref.fact_id, scratchRoot)) {
      invalidRefs.push({ index, journal_type: ref.journal_type, fact_id: ref.fact_id });
    }
  }
  return invalidRefs.length > 0 ? { invalid_refs: invalidRefs } : null;
};

/** 便利判断（供 S5 runner 归约结构化 block 用）。 */
export const isT0RefBlock = (block: T0RefBlock | SessionBlock): block is T0RefBlock =>
  block.reason === "t0_ref_forbidden";
