/**
 * G1 拆解单元②（批㉞H-H3，沿门 1 设计稿「控制面三级处置」组件边界）：turn 级失败收口面。
 * 收口类型（TurnFailureSummary 族）/一句话文案表/阻塞说明素材提取/摘要构造器全部收口本单元——
 * 三级处置（nudge→cut→run_close）与 reject 环、budget、provider、length 五类收口共享同一构造，
 * 防 D-1 双份字面量漂移（原 runner 内共享构造器的单元化承接）。自 runner.ts 逐字迁出（零行为变化）。
 */
import { gapCardFor } from "./blockGuidance.js";
import { GATE_LEGAL_IDS } from "../tools/index.js";
import type { CrossTurnEscalation } from "./noProgressCrossTurn.js";
import type { SessionEvent } from "../session/index.js";

export type TurnFailureReason =
  | "reject_loop_exhausted"
  | "same_call_repeat"
  | "no_progress"
  | "budget_exhausted"
  | "provider_failure"
  | "length_truncated";

export interface TurnBlockingDescription {
  /** 卡在哪（一句话，具体到环节/对象） */
  stuck_at: string;
  /** 本 run 已用 turn 数（用户可见维度=轮次，非步数） */
  turns_used: number;
  /** 本 turn 已用步数（仅 payload 机查，不上屏） */
  steps_used: number;
  /** 微补丁（2026-09-23）：provider HTTP 错误可诊断性——status＋body_excerpt（≤500；错误体
   *  经 httpProvider redact 漏斗前置脱敏，通常不含凭据）＋dump 模式结构性 request_summary
   *  （仅 max_tokens/消息条数/总字符数/工具数，禁全量 body）。完整体不落盘。 */
  provider_error?: {
    status?: number;
    body_excerpt?: string;
    request_summary?: Record<string, unknown>;
  };
}

export interface TurnGapCardOption {
  text: string;
  recommended?: boolean;
}

/** 缺口卡四段（D-f-6 轻形态甲＋：卡在哪·缺什么·为什么需要·可选项≤3 标推荐）。 */
export interface TurnGapCard {
  stuck: string;
  missing: string;
  why: string;
  options: TurnGapCardOption[];
}

export interface TurnFailureSummary {
  reason: TurnFailureReason;
  /** reject_loop_exhausted：REJECT_LOOP_LIMIT；budget_exhausted：LOOP_MAX_STEPS_PER_TURN */
  limit?: number;
  /** reject_loop_exhausted 径携带（≤LIMIT 条连续被拒调用留痕） */
  rejected?: Array<{ tool: string; reason: string; params_digest: string }>;
  /** D-f-2 阻塞说明（卡在哪/已用轮次） */
  blocked_description?: TurnBlockingDescription;
  /** D-f-6 缺口卡（收口时按最后 material-gap 回流自动组装） */
  gap_card?: TurnGapCard;
  /** no_progress 族收口时本 turn 已切断的工具 */
  cut_tools?: string[];
  /** F2（2026-09-26）：跨 turn 无进展收口时携带（机查档位与窗口诊断面；turn 内收口不带）。
   *  escalation：nudge=档1（不收口，仅回流文案）／cut=档2（终止当前 turn 链）／
   *  run_close=档3（run 级收口报告）。 */
  cross_turn?: {
    window_turns: number;
    overlap_permille: number;
    escalation: CrossTurnEscalation;
  };
  hint: {
    /** 仅被拒工具含 atf_gate 时携带：合法 GateId 清单（GATE_LEGAL_IDS 单源） */
    gate_ids?: string[];
    note: string;
  };
}

/** 微补丁（2026-09-23）：provider 错误 detail 白名单提取——只取 status/body_excerpt（≤500
 *  再截断）/request_summary；request_body 永不进摘要/审计（大对象不落盘）。 */
export const providerErrorDetailOf = (error: { detail?: unknown }): NonNullable<TurnBlockingDescription["provider_error"]> => {
  if (typeof error.detail !== "object" || error.detail === null) return {};
  const detail = error.detail as Record<string, unknown>;
  const out: NonNullable<TurnBlockingDescription["provider_error"]> = {};
  if (typeof detail["status"] === "number") out["status"] = detail["status"];
  if (typeof detail["body_excerpt"] === "string" && detail["body_excerpt"] !== "") {
    out["body_excerpt"] = detail["body_excerpt"].length > 500 ? `${detail["body_excerpt"].slice(0, 500)}…` : detail["body_excerpt"];
  }
  if (typeof detail["request_summary"] === "object" && detail["request_summary"] !== null && !Array.isArray(detail["request_summary"])) {
    out["request_summary"] = detail["request_summary"] as Record<string, unknown>;
  }
  return out;
};

/** body_excerpt 首行（人读，≤limit；供收口行一眼判断）。 */
export const firstLineOf = (text: string, limit: number): string => {
  const line = (text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/** D-f 收口一句话提示（按 reason 取值；reject 径文案与 D-1 逐字一致，零回归）。 */
export const COLLAPSE_NOTES: Record<TurnFailureReason, string> = {
  reject_loop_exhausted: "修正参数后输入新指令即可继续本会话；被拒调用与错误码见上（模型下一 turn 同样可见）",
  same_call_repeat: "检测到同参数重复调用无进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
  no_progress: "检测到重复动作无新进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
  budget_exhausted: "本轮预算已用完（运行护栏，非进度指标）：控制权已交还——可直接输入新指令继续，或先收窄任务；输入新指令即可继续本会话",
  provider_failure: "provider 决策失败已按 turn 收口：核对 provider 配置/网络后输入新指令即可继续本会话",
  // pi-ai 换库批 R1：length 分型收口——截断响应不作完整决策执行；降档或续跑（缺口卡同源）
  length_truncated: "模型响应被输出上限截断（finish_reason=length）：截断响应未执行、未入历史；可降低思考等级后重试，或输入新指令以既有历史继续本会话",
};

/** 流尾连续 provider_failure 收口轮数（含本拍——调用方从 1 起算；任何非该类收口即截断）。
 *  批 2.5 层三熔断升级的判据源（事件流纯推导——「流尾连续」天然复位，无跨 turn 可变状态）。 */
export const consecutiveProviderFailuresOf = (events: readonly SessionEvent[]): number => {
  let consecutive = 1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as SessionEvent;
    if (event.type !== "turn/end") continue;
    const reason = (event.payload as { failure_summary?: { reason?: unknown } } | null | undefined)?.failure_summary?.reason;
    if (reason === "provider_failure") consecutive += 1;
    else break;
  }
  return consecutive;
};

/** 收口摘要构造的编排层状态快照（原 runner 闭包活变量的时点值——调用方收口时刻采集）。 */
export interface CollapseState {
  turnsOpened: number;
  turnStepCount: number;
  turnRejectCalls: ReadonlyArray<{ tool: string; reason: string; params_digest: string }>;
  turnLastMaterialGap?: { tool: string; reason: string };
}

/** D-f：turn 级收口摘要构造器（四类触发同源产出，防 D-1 双份字面量漂移）。
 *  reject 径输出与 D-1 逐字兼容（note 文案不变、gate_ids 逻辑不变、rejected/limit 恒填）。
 *  pi-ai 换库批：gapCardOverride 供 length 分型收口显式出卡（不经 material-gap 推导）。 */
export const buildCollapseSummaryOf = (
  state: CollapseState,
  input: {
    reason: TurnFailureReason;
    limit?: number;
    rejected?: TurnFailureSummary["rejected"];
    cutTools?: readonly string[];
    stuckAt: string;
    providerError?: TurnBlockingDescription["provider_error"];
    gapCardOverride?: TurnFailureSummary["gap_card"];
    /** F2：跨 turn 无进展收口的机查档位与窗口诊断面（档 2/档 3 收口径携带） */
    crossTurn?: NonNullable<TurnFailureSummary["cross_turn"]>;
  },
): TurnFailureSummary => {
  const gap = state.turnLastMaterialGap;
  const gapCard = input.gapCardOverride ?? (gap !== undefined ? gapCardFor(gap.tool, gap.reason) : undefined);
  return {
    reason: input.reason,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.rejected !== undefined ? { rejected: input.rejected } : {}),
    blocked_description: {
      stuck_at: input.stuckAt,
      turns_used: state.turnsOpened,
      steps_used: state.turnStepCount,
      ...(input.providerError !== undefined && Object.keys(input.providerError).length > 0 ? { provider_error: input.providerError } : {}),
    },
    ...(gapCard !== undefined ? { gap_card: gapCard } : {}),
    ...(input.cutTools !== undefined && input.cutTools.length > 0 ? { cut_tools: [...input.cutTools] } : {}),
    ...(input.crossTurn !== undefined ? { cross_turn: input.crossTurn } : {}),
    hint: {
      ...(state.turnRejectCalls.some((call) => call.tool === "atf_gate") ? { gate_ids: [...GATE_LEGAL_IDS] } : {}),
      note: COLLAPSE_NOTES[input.reason],
    },
  };
};
