/**
 * 铁律一（ADR-08：T0 不可引用为证据）的 domain_refs 校验扩展。
 *
 * ── G2 迁移改造（施工卡交付物 3）：t0Guard 重判 ────────────────────────────────
 *
 * **为什么必须重判**：原实现（`GuardedSessionLog`）包装 `src/core/session/SessionLog`，
 * 靠「在 append 委托前先判定」实现**写前拒绝**（命中＝事件不落盘）。方案 §3.3 判
 * `src/core/session` 整模块删除、由 vendor session 族承接。实测 vendor 的会话写入面：
 *
 * | vendor 面 | 模式 | 能否否决写入 |
 * |---|---|---|
 * | `session/event` | emit（post-commit，明示「fire-and-forget」） | ❌ 事件已进 log |
 * | `session/flush` | parallel（durable checkpoint） | ❌ 无 veto |
 * | `session/created` / `session/disposed` | emit | ❌ 非写入点 |
 *
 * 结论：**vendor 没有 pre-append waterfall 否决点**。「命中即不落盘」这条语义在
 * vendor 事件模型下不可复现——把它硬做成 post-commit 监听器再声称「已拦截」就是自欺。
 *
 * **重判方案（两层，语义诚实分层）**：
 *
 * 1. **写前闸（能力保留，位置前移）**：`guardT0Append(port, scratchRoot)` 包一个最小的
 *    `T0AppendPort`（`append(input)` 单方法）——任何会话写入实现都能适配。判定逻辑
 *    `scanT0Refs` 逐字沿用原实现（命中 → 结构化 block 并**不调用** inner.append）。
 *    接线方式：生产路径的写入调用点先过闸，再 append。这是唯一能保住「事件不落盘」的位置。
 *
 * 2. **写后审计（新增，fail-loud 而非 fail-closed）**：`t0AuditSink(scratchRoot)` 产出一个
 *    纯函数 sink，供 `ctx.on('session/event', ...)` 观察者调用——对**已提交**事件做同样的
 *    `scanDomainRefs` 判定，命中即回一条 `T0Violation`。它**不能撤销写入**，语义是
 *    「违规留痕 + 可被告警/停止后续动作」，与写前闸不同类，故类型上分开（`T0Violation`
 *    vs `T0RefBlock`），不混用一个枚举。
 *
 * **不可迁移的关键能力（如实登记）**：原 `GuardedSessionLog.replay` 在**重建流**上做
 * fail-closed（流内出现 scratch 引用 → 整个流 blocked，文件只读不改写）。vendor 的重建
 * 读取面是 `Session.snapshotEvents()`（明示 deprecated，禁止新调用）。故 replay 判定退化为
 * 上层可选审计，本包不再提供 `replay`——见交付报告「候裁/风险」段：若 owner 要求保留
 * fail-closed 重建，需 G5 时在 vendor 侧找替代读取面，属跨组决策。
 *
 * **依赖改造**：原实现 import `src/bridge` 的 `Result` 与 `src/core/session` 的类型。
 * 现在两者都不再依赖——本文件零包外 import（纯 node:path），返回 `T0RefBlock | null`
 * 而不是 Result，避免把「Result 形状」这一 bridge 细节带进迁移后的包。
 */
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

/** 铁律一结构化 block（写前闸的拒绝载荷；cause = t0_ref_forbidden）。 */
export interface T0RefBlock {
  reason: "t0_ref_forbidden";
  message: string;
  /** 命中拒绝的引用明细（index = 在事件 domain_refs 数组中的下标） */
  invalid_refs: Array<{ index: number; journal_type: string; fact_id: string }>;
}

/** domain_refs 条目（本模块用到的最小子集——不依赖 src/core/session 的 DomainRef）。 */
export interface T0DomainRef {
  readonly journal_type: string;
  readonly fact_id: string;
}

/** 待校验事件的形状（本模块用到的最小子集——不依赖 src/core/session 的 SessionEventInput）。 */
export interface T0EventShape {
  readonly domain_refs?: readonly T0DomainRef[] | undefined;
}

/** 逐条判定 domain_refs：命中 scratch 前缀 → 结构化明细（null = 无命中）。 */
export const scanT0Refs = (
  domainRefs: readonly T0DomainRef[] | undefined,
  scratchRoot: string,
): T0RefBlock["invalid_refs"] | null => {
  if (domainRefs === undefined || domainRefs.length === 0) return null;
  const invalidRefs: T0RefBlock["invalid_refs"] = [];
  for (let index = 0; index < domainRefs.length; index += 1) {
    const ref = domainRefs[index];
    if (ref === undefined) continue;
    if (isScratchReference(ref.fact_id, scratchRoot)) {
      invalidRefs.push({ index, journal_type: ref.journal_type, fact_id: ref.fact_id });
    }
  }
  return invalidRefs.length > 0 ? invalidRefs : null;
};

/** 判定并组装完整 block（null = 放行）。写前闸与写后审计共用同一判定。 */
export const t0BlockOf = (input: T0EventShape, scratchRoot: string): T0RefBlock | null => {
  const invalidRefs = scanT0Refs(input.domain_refs, scratchRoot);
  if (invalidRefs === null) return null;
  return {
    reason: T0_REF_FORBIDDEN,
    message: `T0 不可引用为证据（铁律一）：引用 ${invalidRefs.map((ref) => ref.fact_id).join(", ")} 落于 scratch/ 前缀`,
    invalid_refs: invalidRefs,
  };
};

// ── 写前闸 ────────────────────────────────────────────────────────────────

/**
 * 会话写入端口（vendor `Session.append` 或其他实现的适配点）。
 * 只要求单方法——闸门不关心底层是 append-only log、内存队列还是远端会话。
 */
export interface T0AppendPort<Input extends T0EventShape, Outcome> {
  append(input: Input): Promise<Outcome>;
}

/** 闸门结果：rejected ＝ 铁律一拒绝（**inner.append 未被调用，事件未落盘**）；passed ＝ 内层原样结果。 */
export type GuardedAppendOutcome<Outcome> =
  | { status: "rejected"; block: T0RefBlock }
  | { status: "passed"; outcome: Outcome };

/**
 * 写前闸工厂：对每个事件先判铁律一，命中即拒绝且**不委托内层**——这是原
 * `GuardedSessionLog.append` 的唯一核心语义，逐位保留。
 *
 * 用法（接线点）：`const guarded = guardT0Append(sessionAdapter, run.scratchDir)`，
 * 生产写入走 `guarded.append(input)`；未命中时行为与直连内层完全一致。
 */
export const guardT0Append = <Input extends T0EventShape, Outcome>(
  inner: T0AppendPort<Input, Outcome>,
  scratchRoot: string,
): T0AppendPort<Input, GuardedAppendOutcome<Outcome>> => ({
  append: async (input: Input) => {
    const block = t0BlockOf(input, scratchRoot);
    if (block !== null) return { status: "rejected", block };
    return { status: "passed", outcome: await inner.append(input) };
  },
});

/** 便利判断（供 runner 归约结构化 block 用）。 */
export const isT0RefBlock = (block: T0RefBlock | { reason: string }): block is T0RefBlock =>
  block.reason === T0_REF_FORBIDDEN;

// ── 写后审计（新增能力：观察已提交事件）────────────────────────────────────

/** 已提交事件上的违规留痕（**不可撤销写入**——与写前闸的 T0RefBlock 严格区分）。 */
export interface T0Violation {
  kind: "t0_ref_violation";
  message: string;
  invalid_refs: T0RefBlock["invalid_refs"];
}

/**
 * 写后审计 sink 工厂：给 `ctx.on('session/event', (session, event) => sink(event))` 用。
 * 返回 `T0Violation | null`——命中即违规留痕，调用方可据此告警/停后续动作。
 *
 * 明确与写前闸的差别：事件**已经提交**（vendor `session/event` 是 post-commit emit），
 * 本 sink 不能回收它。要真正「不落盘」必须走 {@link guardT0Append}。
 */
export const t0AuditSink = (scratchRoot: string): ((input: T0EventShape) => T0Violation | null) => {
  return (input: T0EventShape): T0Violation | null => {
    const block = t0BlockOf(input, scratchRoot);
    if (block === null) return null;
    return {
      kind: "t0_ref_violation",
      message: `T0 不可引用为证据（铁律一）：已提交事件中出现落于 scratch/ 前缀的引用（违规已留痕，写入不可撤销）：${block.invalid_refs.map((ref) => ref.fact_id).join(", ")}`,
      invalid_refs: block.invalid_refs,
    };
  };
};
