/**
 * compaction（P2-S1，任务书 §2 设计要求 1–5 / D1 结论 C4/C5，登记于 session.contract.yaml compaction 节）。
 *
 * 三条设计红线：
 * - append-only 不变：压缩只影响投给模型的投影视图（projectContext），磁盘事件流不删不改；
 * - 计划是纯函数：live 与 replay 对同一事件序列的计算结果逐条一致（重建一致、可幂等重放）；
 * - 承证白名单：携带 domain_refs 的事件及其相邻因果链（tool/call ↔ 同名工具最近配对的
 *   tool/result）永不折叠，引用链必须留在模型上下文中（ADR-06 细则 2）。
 *
 * session/compaction 落盘事件是压缩动作的审计留痕（可回答「哪次压缩吃掉了哪些事件」），
 * 对计划算法透明：不计入事件数、不参与折叠、不直接进入投影（投影中的压缩摘要由算法
 * 确定性重建）——因此「含审计事件的 replay 序列」与「不含审计的内存序列」投影完全一致。
 */
import {
  COMPACTION_CHUNK,
  COMPACTION_KEEP_RECENT,
  COMPACTION_TRIGGER_TOKENS,
  TOKEN_ESTIMATE_DIVISOR,
} from "./constants.js";
import { compactionTriggerEvents } from "./constantsBudget.js";
import { hasDomainRefs, type SessionEvent } from "./schema.js";

/**
 * 模型上下文事件——convertToLlm 的白名单输出形态（session.contract.yaml pipeline 节）。
 * 仅 { id, ts, type, payload, domain_refs?, synthetic? }；ui / projection / ref_invalid 及
 * 任何其他内部字段一律不出现（内部字段不发模型，与 S3 工具 schema 同一收敛哲学）。
 * synthetic 仅出现在投影合成的压缩摘要条目上（P1-2 修复：与同 id 的白名单豁免原文区分，
 * 投影消费者按 (id, synthetic) 唯一识别条目——ADR-09 §1.2 投影形态纪律）。
 */
export interface LlmContextEvent {
  id: number;
  ts: string;
  type: SessionEvent["type"];
  payload: unknown;
  domain_refs?: SessionEvent["domain_refs"];
  synthetic?: boolean;
}

/** 单事件白名单投影：剔除 UI-only 与内部字段。 */
export const convertToLlm = (event: SessionEvent): LlmContextEvent => {
  const projected: LlmContextEvent = {
    id: event.id,
    ts: event.ts,
    type: event.type,
    payload: event.payload,
  };
  if (event.domain_refs !== undefined) projected.domain_refs = event.domain_refs;
  return projected;
};

/** 压缩触发归因。 */
export type CompactionTriggerReason = "event_count" | "token_budget" | "none";

/** 触发指标快照（写入 session/compaction 审计事件，可审计）。 */
export interface CompactionTriggerMetrics {
  events: number;
  estimated_tokens: number;
  reason: CompactionTriggerReason;
}

/**
 * 压缩计划（planCompaction 输出）。boundary 以「实质事件序列」的位置计
 * （见 materialOf：session/compaction 审计事件对算法透明），前 boundary 条中
 * 未命中白名单者被折叠为摘要。
 */
export interface CompactionPlan {
  triggered: boolean;
  /** 折叠边界（实质事件序列的位置数；0 = 未折叠任何前缀）。切点对齐后值。 */
  boundary: number;
  /** 修复批 3：切点对齐前的 CHUNK 粒度原始边界（≥ boundary；未触发 = 0）。 */
  boundary_before: number;
  /** 修复批 3：切点对齐是否实际前移了边界（配对切断 → 宁可少折叠）。 */
  aligned: boolean;
  /** 折叠区间内保留原文的白名单事件位置集合。 */
  keptPositions: Set<number>;
  /** 实际折叠的事件数（boundary - 区间内白名单命中数）。 */
  foldedCount: number;
  trigger: CompactionTriggerMetrics;
}

/** 审计事件 payload 形态（session/compaction 落盘与投影摘要共用，确定性可重建）。 */
export interface CompactionRecordPayload {
  kind: "compaction_summary";
  /** 被折叠的实质事件 id 区间（按事件 id，含端点） */
  covers: { from_id: number; to_id: number };
  folded_count: number;
  /** 折叠区间内保留原文的承证事件 id（白名单豁免） */
  kept_ids: number[];
  type_counts: Record<string, number>;
  trigger: CompactionTriggerMetrics;
  /** 修复批 3：切点对齐审计——CHUNK 粒度原始边界与对齐后边界（前者 ≥ 后者）。 */
  boundary_before: number;
  boundary_after: number;
  /** 对齐原因：none = 未前移；pair_alignment = 配对切断前移（宁可少折叠，不可切配对）。 */
  reason_aligned: "none" | "pair_alignment";
  /** 人读摘要文本（确定性生成，投给模型） */
  text: string;
}

/**
 * 实质事件序列：session/compaction（压缩审计）与 session/repair（S1a 尾部修复留痕）
 * 均为运维留痕而非对话内容——对压缩算法透明（不计数、不折叠、不投影）。
 */
export const materialOf = (events: readonly SessionEvent[]): SessionEvent[] =>
  events.filter((event) => event.type !== "session/compaction" && event.type !== "session/repair");

/** payload 估算 token（启发式，常量层理由见 TOKEN_ESTIMATE_DIVISOR）。 */
const estimateEventTokens = (event: SessionEvent): number =>
  Math.ceil(JSON.stringify(event.payload).length / TOKEN_ESTIMATE_DIVISOR);

/** 估算 token 总量（对实质事件序列求和）。 */
export const estimateTokens = (material: readonly SessionEvent[]): number =>
  material.reduce((sum, event) => sum + estimateEventTokens(event), 0);

/**
 * 白名单判定（纯函数，owner 口径 #3）：domain_refs 命中事件永不折叠；
 * 相邻因果链 = tool/result 与其「往前最近的同名工具 tool/call」、tool/call 与其
 * 「往后最近的同名工具 tool/result」互为配对，命中方的配对方随之豁免。
 * 返回值以实质事件序列的位置为键。
 */
export const computeCompactionWhitelist = (events: readonly SessionEvent[]): Set<number> => {
  const material = materialOf(events);
  const keep = new Set<number>();
  const toolOf = (event: SessionEvent): unknown =>
    (event.payload as { tool?: unknown } | null | undefined)?.tool;
  for (let pos = 0; pos < material.length; pos += 1) {
    const event = material[pos] as SessionEvent;
    if (!hasDomainRefs(event)) continue;
    keep.add(pos);
    if (event.type === "tool/result" && typeof toolOf(event) === "string") {
      for (let i = pos - 1; i >= 0; i -= 1) {
        const prior = material[i] as SessionEvent;
        if (prior.type === "tool/call" && toolOf(prior) === toolOf(event)) {
          keep.add(i);
          break;
        }
      }
    }
    if (event.type === "tool/call" && typeof toolOf(event) === "string") {
      for (let i = pos + 1; i < material.length; i += 1) {
        const next = material[i] as SessionEvent;
        if (next.type === "tool/result" && toolOf(next) === toolOf(event)) {
          keep.add(i);
          break;
        }
      }
    }
  }
  return keep;
};

/**
 * 切点对齐（修复批 3，2026-09-23；重跑① A 类缺陷根因修复）。
 *
 * 不变量（写入测试）：投影消息序中 tool/call 必先于其配对 tool/result、approval/request
 * 必先于其 approval/response——孤儿闭合半边使消息序非法，provider 两协议同拒（重跑①
 * 持续 422 实证）。CHUNK 粒度边界只看数量不看配对，边界落在配对中间时前半边被折叠、
 * 后半边留在投影 → 孤儿。
 *
 * 对齐算法：FIFO 模拟线缆配对（与 codecWire 同序——call/request 入队、result/response
 * 出队），在「投影序」（折叠区间内白名单原文 + 保留侧原文）上找孤儿闭合半边；命中则把
 * boundary 前移到其开启半边（折叠区内最近同族同工具者）的位置——该半边改归保留侧
 * （宁可少折叠，不可切配对），迭代至无孤儿。防御：找不到开启半边 → boundary=0（不折叠，
 * v0 语义保证合法）。纯函数：live 与 replay 逐条一致。
 */
const alignBoundaryToPairs = (
  material: readonly SessionEvent[],
  rawBoundary: number,
  keptPositions: Set<number>,
): { boundary: number; aligned: boolean } => {
  let boundary = rawBoundary;
  let aligned = false;
  for (;;) {
    if (boundary <= 0) return { boundary: 0, aligned };
    const callQueue: number[] = [];
    const approvalQueue: number[] = [];
    let orphanAt = -1;
    for (let pos = 0; pos < material.length; pos += 1) {
      if (pos < boundary && !keptPositions.has(pos)) continue; // 折叠区非白名单 = 不投影
      const type = (material[pos] as SessionEvent).type;
      if (type === "tool/call") callQueue.push(pos);
      else if (type === "tool/result") {
        if (callQueue.length === 0) {
          orphanAt = pos;
          break;
        }
        callQueue.shift();
      } else if (type === "approval/request") approvalQueue.push(pos);
      else if (type === "approval/response") {
        if (approvalQueue.length === 0) {
          orphanAt = pos;
          break;
        }
        approvalQueue.shift();
      }
    }
    if (orphanAt < 0) return { boundary, aligned };
    const closer = material[orphanAt] as SessionEvent;
    const openerType = closer.type === "tool/result" ? "tool/call" : "approval/request";
    const closerTool = (closer.payload as { tool?: unknown } | null | undefined)?.tool;
    let target = -1;
    for (let pos = Math.min(orphanAt, boundary) - 1; pos >= 0; pos -= 1) {
      if (keptPositions.has(pos)) continue; // 只找被折叠的开启半边（白名单原文本就投影）
      const event = material[pos] as SessionEvent;
      if (event.type !== openerType) continue;
      if (openerType === "tool/call") {
        const tool = (event.payload as { tool?: unknown } | null | undefined)?.tool;
        if (tool !== closerTool) continue;
      }
      target = pos;
      break;
    }
    if (target < 0) return { boundary: 0, aligned: true };
    boundary = target;
    aligned = true;
  }
};

/**
 * 压缩计划（纯函数）：双指标触发（事件数 || 估算 token，先到者生效）；
 * 折叠边界按 CHUNK 粒度整数倍推进（滞后防逐条重折叠），保留窗内（最近 KEEP_RECENT 条）
 * 一律不动。未触发时 boundary 恒为 0（投影 = v0 语义原样）。
 * L1c 提前批 A1.5.2（放行件 v7 ★段解冻：预算参数化）：triggerTokens 由调用方注入——
 * 缺省 = 既有常量 COMPACTION_TRIGGER_TOKENS（未配置 context_window 时逐字节回退）；
 * 数据驱动值经 constantsBudget.compactionTriggerTokens() 解析，投影径与审计径
 * （sessionLog.ts:463）必须同源传值（同源铁律，禁只改一处）。
 * 修复批 3（2026-09-23）：① 事件数门经 constantsBudget.compactionTriggerEvents() 同源可配
 * （缺省回退常量 512——128 过早折叠）；② 切点对齐（alignBoundaryToPairs）——折叠边界
 * 永不切断配对，审计 payload 携带 boundary_before/after 与 reason_aligned。
 */
export const planCompaction = (events: readonly SessionEvent[], triggerTokens: number = COMPACTION_TRIGGER_TOKENS): CompactionPlan => {
  const material = materialOf(events);
  const tokens = estimateTokens(material);
  const byCount = material.length >= compactionTriggerEvents();
  const byTokens = tokens >= triggerTokens;
  const triggered = byCount || byTokens;
  const reason: CompactionTriggerReason = byCount ? "event_count" : byTokens ? "token_budget" : "none";

  const usable = material.length - COMPACTION_KEEP_RECENT;
  const boundary_before =
    triggered && usable >= COMPACTION_CHUNK ? Math.floor(usable / COMPACTION_CHUNK) * COMPACTION_CHUNK : 0;
  const keptPositions = boundary_before > 0 ? computeCompactionWhitelist(events) : new Set<number>();
  const { boundary, aligned } = alignBoundaryToPairs(material, boundary_before, keptPositions);
  let foldedCount = 0;
  for (let pos = 0; pos < boundary; pos += 1) {
    if (!keptPositions.has(pos)) foldedCount += 1;
  }
  return {
    triggered,
    boundary,
    boundary_before,
    aligned,
    keptPositions,
    foldedCount,
    trigger: { events: material.length, estimated_tokens: tokens, reason },
  };
};

/** 由计划确定性生成压缩记录（审计事件 payload 与投影摘要共用同一形态）。 */
export const buildCompactionRecord = (
  material: readonly SessionEvent[],
  plan: CompactionPlan,
): CompactionRecordPayload => {
  const folded: SessionEvent[] = [];
  const keptIds: number[] = [];
  const typeCounts: Record<string, number> = {};
  for (let pos = 0; pos < plan.boundary; pos += 1) {
    const event = material[pos] as SessionEvent;
    if (plan.keptPositions.has(pos)) {
      keptIds.push(event.id);
      continue;
    }
    folded.push(event);
    typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
  }
  const from = material[0];
  const to = material[plan.boundary - 1];
  const distribution = Object.entries(typeCounts)
    .map(([type, count]) => `${type}×${String(count)}`)
    .join("、");
  return {
    kind: "compaction_summary",
    covers: { from_id: (from as SessionEvent).id, to_id: (to as SessionEvent).id },
    folded_count: folded.length,
    kept_ids: keptIds,
    type_counts: typeCounts,
    trigger: plan.trigger,
    boundary_before: plan.boundary_before,
    boundary_after: plan.boundary,
    reason_aligned: plan.aligned ? "pair_alignment" : "none",
    text: `「上下文压缩摘要」此前 ${String(folded.length)} 条事件已折叠为摘要（${distribution || "无"}）；` +
      `${String(keptIds.length)} 条承证事件保留原文，领域事实引用链未压缩。`,
  };
};

/**
 * 模型上下文投影（transformContext 的实现）：未触发 = v0 语义原样（过滤 assistant/attempt）；
 * 触发 = [压缩摘要] + [折叠区间内白名单豁免原文] + [保留窗原文]，审计事件不进入投影。
 * 对同一输入逐条确定、可幂等重放（replay 重建一致性的根据）。
 * A1.5.2：triggerTokens 透传 planCompaction（缺省回退既有常量——行为中立）。
 */
export const projectContext = (events: readonly SessionEvent[], triggerTokens?: number): LlmContextEvent[] => {
  const plan = planCompaction(events, triggerTokens);
  const material = materialOf(events);
  if (plan.boundary === 0) {
    return material.filter((event) => event.type !== "assistant/attempt").map(convertToLlm);
  }

  const out: LlmContextEvent[] = [];
  const record = buildCompactionRecord(material, plan);
  const anchor = material[plan.boundary - 1] as SessionEvent;
  // synthetic 标记（P1-2 修复）：摘要条目是投影合成物，可能与同 id 的白名单豁免原文并存
  out.push({ id: anchor.id, ts: anchor.ts, type: "session/compaction", payload: record, synthetic: true });

  const pushOriginal = (event: SessionEvent): void => {
    if (event.type !== "assistant/attempt") out.push(convertToLlm(event));
  };
  for (let pos = 0; pos < plan.boundary; pos += 1) {
    if (plan.keptPositions.has(pos)) pushOriginal(material[pos] as SessionEvent);
  }
  for (let pos = plan.boundary; pos < material.length; pos += 1) {
    pushOriginal(material[pos] as SessionEvent);
  }
  return out;
};
