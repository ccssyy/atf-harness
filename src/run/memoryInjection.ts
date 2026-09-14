/**
 * TEM 读闸注入点（切片 2——《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》§1.3；
 * 依据《ATF-TEM_接入设计_双消费者_20260914.md》§3）。
 *
 * 位置纪律：注入发生在 **transformContext 投影之后、provider.decide() 之前**（runner 决策循环内），
 * **不另起注入通道**；v1 注入源为**可注入桩**（缺省无注入 = 无记忆运行），真实 TEM 调用在
 * TEM 提供接口后另批。
 *
 * 条目形态：带**来源引用**（source_ref，可追溯 Case/Claim id）；条目可被（将来真实 TEM 批的）
 * 折叠语义折叠，但引用链必须保留——`structural_preconditions` 类携带 `pinned` 标记（不折叠）。
 *
 * 失败语义：注入源不可用 → **无记忆运行**（记忆是增强而非依赖）＋ 记事件留痕
 * （assistant/attempt——落盘但不进模型历史，与"无记忆运行"语义一致）。
 */
import { type LlmContextEvent } from "../session/index.js";

/** TEM 读闸条目（v1 桩形态；真实 TEM 接入时由接口层归一化到本形态）。 */
export interface MemoryReadEntry {
  /** 来源引用（可追溯 Case/Claim id；引用链不随折叠丢失） */
  source_ref: string;
  /** 条目类别：structural_preconditions = 结构前提（不折叠）；context_note = 上下文补充（可折叠） */
  kind: "structural_preconditions" | "context_note";
  content: string;
}

/** 注入源接口（v1 可注入桩；runner 缺省不注入 = 无记忆运行）。 */
export interface MemoryReadInjector {
  read(): Promise<{ ok: true; entries: readonly MemoryReadEntry[] } | { ok: false; code: string; message: string }>;
}

export interface MemoryInjectionOutcome {
  /** 注入后的上下文（失败/无注入时 = 原上下文原样） */
  context: LlmContextEvent[];
  /** 成功注入的条目数 */
  injected: number;
  /** 注入源不可用时的失败信息（runner 据此记事件；无记忆运行） */
  failure?: { code: string; message: string };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 条目校验（fail-closed：缺 source_ref/kind/content 或 kind 闭集外 → 整批拒绝，无记忆运行）。 */
const validateEntries = (entries: readonly unknown[]): MemoryReadEntry[] | null => {
  const validated: MemoryReadEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isPlainObject(entry)) return null;
    const { source_ref: sourceRef, kind, content } = entry;
    if (typeof sourceRef !== "string" || sourceRef === "") return null;
    if (kind !== "structural_preconditions" && kind !== "context_note") return null;
    if (typeof content !== "string" || content === "") return null;
    validated.push({ source_ref: sourceRef, kind, content });
  }
  return validated;
};

/**
 * 注入（transformContext 之后、decide 之前调用）：
 * - injector 未提供 → 原上下文原样（无记忆运行，零开销路径）；
 * - read 失败或条目非法 → 原上下文原样 ＋ failure（runner 记事件；无记忆运行）；
 * - 成功 → 条目以合成上下文事件形态**追加**（synthetic: true；顺序稳定：原上下文序 → 条目声明序），
 *   id 取上下文现有最大 id 的后续（确定性派生，不与事件流冲突）；
 *   `structural_preconditions` 条目携带 `pinned: true`（折叠语义必须尊重——引用链不随折叠丢失）。
 */
export const injectMemoryEntries = async (
  context: readonly LlmContextEvent[],
  injector?: MemoryReadInjector,
): Promise<MemoryInjectionOutcome> => {
  if (injector === undefined) return { context: [...context], injected: 0 };
  let read: { ok: true; entries: readonly MemoryReadEntry[] } | { ok: false; code: string; message: string };
  try {
    read = await injector.read();
  } catch (cause) {
    read = { ok: false, code: "memory_read_threw", message: String(cause) };
  }
  if (!read.ok) return { context: [...context], injected: 0, failure: { code: read.code, message: read.message } };
  if (!Array.isArray(read.entries)) {
    return { context: [...context], injected: 0, failure: { code: "memory_entry_invalid", message: "TEM 读闸返回形态非法（entries 须为数组）" } };
  }
  const entries = validateEntries(read.entries);
  if (entries === null) {
    return { context: [...context], injected: 0, failure: { code: "memory_entry_invalid", message: "TEM 读闸条目形态非法（fail-closed，整批拒绝）" } };
  }
  if (entries.length === 0) return { context: [...context], injected: 0 };
  const maxId = context.reduce((max, event) => Math.max(max, event.id), 0);
  const injectedContext: LlmContextEvent[] = [...context];
  entries.forEach((entry, index) => {
    injectedContext.push({
      id: maxId + 1 + index, // 确定性派生：同输入同 id（durability 公理——不依赖注入时的墙钟或随机量）
      ts: "1970-01-01T00:00:00Z", // 派生时间占位：注入条目非事件流事实（真实 ts 属 TEM 源，另行批接入）
      type: "user/message",
      payload: {
        memory: true,
        source_ref: entry.source_ref,
        kind: entry.kind,
        content: entry.content,
        ...(entry.kind === "structural_preconditions" ? { pinned: true } : {}),
      },
      synthetic: true,
    });
  });
  return { context: injectedContext, injected: entries.length };
};
