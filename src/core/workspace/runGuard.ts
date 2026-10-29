/**
 * RunGuard——训练与推理共用的守卫（判定／定时汇报／恢复策略）。
 *
 * 设计口径（owner）：
 *   1. 同一套判定同时服务训练与推理（phase 只是标签，判据同一份）；
 *   2. 定时汇报进度：每个 phase 至少每隔 reportEveryMs 产一条人读进度；
 *   3. 健康度检测：进程存活＋进度新鲜度＋退出码＋OOM 四维；
 *   4. 启动失败/异常中止：先汇报，再按退避与上限决定是否恢复；恢复动作由调用方注入
 *      （训练＝重发 train.sh／OOM 降档，推理＝重启评估服务），本模块不直接起进程。
 *
 * 与既有组件的关系（复用，不另起一套）：
 *   - 判定输入来自既有事实源：trainer_log mtime（步进）、orch/progress.jsonl（推理阶段）、
 *     进程取证（probeTrainingEvidence）、退出码尾声件、日志 OOM 特征；
 *   - 汇报出口复用 alerts.json（appendNotification，同级同因 10 分钟幂等、上限 50）；
 *   - 状态落 webui/guard.json（每 run 一份，跨同步器重启可续）；进度流水落
 *     webui/guard-reports.json（近 20 条，供卡面直读，不污染告警面）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendNotification } from "./trainProbe.js";
import { resolveRunSubdir } from "./runSubdirs.js";

export type GuardPhase = "train" | "eval";

/** 守卫判定五态。unknown＝证据不足（不判、不报，避免误报）。 */
export type GuardVerdict = "running" | "stalled" | "failed" | "finished" | "unknown";

/** 判定输入（全部为事实，不含推测；null＝该项证据缺失）。 */
export interface GuardFacts {
  phase: GuardPhase;
  /** 本阶段是否应处于运行态（训练＝training.active；推理＝评估已启动且未完成）。 */
  active: boolean;
  /** 阶段完成标记（训练＝segments.training；推理＝评估轮 done）。 */
  done: boolean;
  /** 进程存活取证：true=命中；false=探针可用且未命中；null=探针不可用（不据此判死）。 */
  processEvidence: boolean | null;
  /** 最近一次进度证据的时间戳（trainer_log mtime／orch progress 末行 ts）。 */
  lastProgressAtMs: number | null;
  /** 进度百分比（0-100，未知 null）。 */
  percent: number | null;
  /** 进度标签（人读，如「3/12 步」「generate 2/5」）。 */
  progressLabel: string | null;
  /** 进程退出码（未退出/未知＝null）。 */
  exitCode: number | null;
  /** 日志是否命中 OOM 特征。 */
  oom: boolean;
  nowMs: number;
}

/** 阈值（全部可注入；缺省为产品基线：10 分钟软停滞、30 分钟硬停滞、10 分钟一报）。 */
export interface GuardThresholds {
  /** 软停滞：进度证据停更超过它 → stalled（只报不杀）。 */
  stallMs: number;
  /** 硬停滞：超过它 → 允许恢复动作（重启）。 */
  hardStallMs: number;
  /** 定时汇报间隔。 */
  reportEveryMs: number;
  /** 同一 run 同一阶段的最大恢复次数。 */
  maxRecoveries: number;
  /** 恢复退避（第 n 次恢复前的等待，毫秒；超出数组长度取末值）。 */
  backoffMs: readonly number[];
}

export const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  stallMs: 600_000,
  hardStallMs: 1_800_000,
  reportEveryMs: 600_000,
  maxRecoveries: 2,
  backoffMs: [60_000, 300_000],
};

/** run 级守卫状态（webui/guard.json）。 */
export interface GuardState {
  attempts: number;
  lastActionAtMs: number | null;
  lastReportAtMs: number | null;
  lastVerdict: GuardVerdict | null;
  lastReason: string | null;
}

export const EMPTY_GUARD_STATE: GuardState = {
  attempts: 0,
  lastActionAtMs: null,
  lastReportAtMs: null,
  lastVerdict: null,
  lastReason: null,
};

/** 判定结果。recover=true 表示调用方应执行恢复动作（是否真做还受 attempts/backoff 约束）。 */
export interface GuardDecision {
  verdict: GuardVerdict;
  reason: string;
  /** 是否应产出一条汇报（进度或告警）。 */
  report: boolean;
  /** 是否应执行恢复动作。 */
  recover: boolean;
  /** 人读汇报文本（report=false 时 null）。 */
  text: string | null;
  /** 汇报级别：info=进度通报，warn=停滞，error=失败。 */
  level: "info" | "warn" | "error" | null;
}

const PHASE_LABEL: Record<GuardPhase, string> = { train: "训练", eval: "评估" };

const humanMs = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分钟`;
};

const progressPart = (facts: GuardFacts): string => {
  const label = facts.progressLabel ?? (facts.percent === null ? "" : `${Math.round(facts.percent)}%`);
  return label === "" ? "进度未知" : label;
};

/**
 * 判定一个 run 当前的健康态，并给出是否汇报／是否恢复。
 *
 * 规则顺序（先终态、后异常、再停滞、最后运行）：
 *   1. done → finished（只在状态跃迁时报一次）
 *   2. OOM → failed（恢复交给 OOM 降档链，本模块不重复动作）
 *   3. 退出码非 0 → failed（可恢复）
 *   4. 进程取证明确为不存在 → failed（可恢复）
 *   5. 进度停更 > stallMs → stalled（软停滞只报；> hardStallMs 才允许恢复）
 *   6. 其余 → running（按 reportEveryMs 定时汇报）
 *
 * @param facts 事实输入。
 * @param thresholds 阈值。
 * @param state 既有状态（跨 tick 持久）。
 * @return 判定与动作建议。
 */
export const decideGuard = (
  facts: GuardFacts,
  thresholds: GuardThresholds,
  state: GuardState,
): GuardDecision => {
  const phase = PHASE_LABEL[facts.phase];
  const canRecover = state.attempts < thresholds.maxRecoveries;
  const backoff = thresholds.backoffMs[Math.min(state.attempts, thresholds.backoffMs.length - 1)] ?? 0;
  const backoffReady = state.lastActionAtMs === null || facts.nowMs - state.lastActionAtMs >= backoff;
  const recover = canRecover && backoffReady;
  const stalledFor = facts.lastProgressAtMs === null ? null : facts.nowMs - facts.lastProgressAtMs;

  if (facts.done) {
    const report = state.lastVerdict !== "finished";
    return {
      verdict: "finished",
      reason: "phase_done",
      report,
      recover: false,
      level: report ? "info" : null,
      text: report ? `${phase}已结束。` : null,
    };
  }

  if (facts.oom) {
    return {
      verdict: "failed",
      reason: "oom",
      report: state.lastReason !== "oom",
      recover: false,
      level: state.lastReason !== "oom" ? "error" : null,
      text:
        state.lastReason !== "oom"
          ? `${phase}因显存不足中止（CUDA out of memory）；降档重发由既有 OOM 链路处理，守卫不重复动作。`
          : null,
    };
  }

  if (facts.exitCode !== null && facts.exitCode !== 0) {
    const reason = `exit_${facts.exitCode}`;
    const report = state.lastReason !== reason;
    return {
      verdict: "failed",
      reason,
      report,
      recover,
      level: report ? "error" : null,
      text: report
        ? `${phase}进程已退出（退出码 ${facts.exitCode}，${progressPart(facts)}）。` +
          (canRecover ? (backoffReady ? "守卫将重新拉起。" : "守卫在退避等待后重新拉起。") : "已达恢复上限，等人工处理。")
        : null,
    };
  }

  if (facts.processEvidence === false) {
    const report = state.lastReason !== "process_gone";
    return {
      verdict: "failed",
      reason: "process_gone",
      report,
      recover,
      level: report ? "error" : null,
      text: report
        ? `${phase}进程已不在（取证未见运行实例，${progressPart(facts)}）。` +
          (canRecover ? "守卫将重新拉起。" : "已达恢复上限，等人工处理。")
        : null,
    };
  }

  if (stalledFor !== null && stalledFor > thresholds.stallMs) {
    const severe = stalledFor > thresholds.hardStallMs;
    const reason = severe ? "hard_stalled" : "stalled";
    const report = state.lastReason !== reason || state.lastReportAtMs === null ||
      facts.nowMs - state.lastReportAtMs >= thresholds.reportEveryMs;
    return {
      verdict: "stalled",
      reason,
      report,
      recover: severe && recover,
      level: report ? "warn" : null,
      text: report
        ? severe
          ? `${phase}停滞 ${humanMs(stalledFor)}（${progressPart(facts)}，超过硬阈值）。` +
            (canRecover ? "守卫将重启进程。" : "已达恢复上限，等人工处理。")
          : `${phase}已 ${humanMs(stalledFor)}没有新的进度写入（${progressPart(facts)}），进程仍在；守卫继续观察。`
        : null,
    };
  }

  const dueReport = state.lastReportAtMs === null || facts.nowMs - state.lastReportAtMs >= thresholds.reportEveryMs;
  return {
    verdict: "running",
    reason: "running",
    report: dueReport,
    recover: false,
    level: dueReport ? "info" : null,
    text: dueReport
      ? `${phase}进行中：${progressPart(facts)}` +
        (facts.lastProgressAtMs === null ? "。" : `，最近一次进度 ${humanMs(facts.nowMs - facts.lastProgressAtMs)}前。`)
      : null,
  };
};

export const guardStatePathOf = (runDir: string): string =>
  join(resolveRunSubdir(runDir, "webui"), "guard.json");

export const guardReportsPathOf = (runDir: string): string =>
  join(resolveRunSubdir(runDir, "webui"), "guard-reports.json");

/** 读守卫状态（缺失/坏件＝空态，不改写盘面）。 */
export const readGuardState = (runDir: string): GuardState => {
  const path = guardStatePathOf(runDir);
  if (!existsSync(path)) return { ...EMPTY_GUARD_STATE };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<GuardState>;
    return {
      attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
      lastActionAtMs: typeof raw.lastActionAtMs === "number" ? raw.lastActionAtMs : null,
      lastReportAtMs: typeof raw.lastReportAtMs === "number" ? raw.lastReportAtMs : null,
      lastVerdict: (raw.lastVerdict ?? null) as GuardVerdict | null,
      lastReason: typeof raw.lastReason === "string" ? raw.lastReason : null,
    };
  } catch {
    return { ...EMPTY_GUARD_STATE };
  }
};

const writeJson = (runDir: string, path: string, payload: unknown): void => {
  try {
    mkdirSync(resolveRunSubdir(runDir, "webui"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
  } catch {
    // fail-open：守卫自身写盘失败不打断同步器
  }
};

export const writeGuardState = (runDir: string, state: GuardState): void => {
  writeJson(runDir, guardStatePathOf(runDir), state);
};

/** 进度流水（近 20 条，供卡面直读；不进告警面，避免 50 条上限被打满）。 */
export const appendGuardReport = (runDir: string, line: { at: string; phase: GuardPhase; verdict: GuardVerdict; text: string }): void => {
  const path = guardReportsPathOf(runDir);
  let rows: unknown[] = [];
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (Array.isArray(parsed)) rows = parsed;
    }
  } catch {
    rows = [];
  }
  rows.push(line);
  writeJson(runDir, path, rows.slice(-20));
};

/** 守卫一跳的依赖（副作用全注入——vitest 用假件直测；宿主接真件）。 */
export interface GuardTickDeps {
  runDir: string;
  facts: GuardFacts;
  thresholds?: GuardThresholds;
  /** 恢复动作（训练＝重发 train.sh；推理＝重启评估服务）。缺省＝只报不恢复。 */
  relaunch?: () => Promise<{ ok: boolean; detail?: string }>;
  now?: () => Date;
}

export interface GuardTickResult {
  decision: GuardDecision;
  recovered: boolean;
  recoveryDetail: string | null;
}

/**
 * 守卫一跳：判定 → 汇报 → （必要时）恢复 → 落状态。
 *
 * 恢复动作失败不重试（下一 tick 由 attempts/backoff 决定），失败也如实汇报——
 * 绝不把"没能恢复"写成"已恢复"。
 *
 * @param deps 依赖与事实。
 * @return 本跳结果（判定、是否真的恢复、恢复明细）。
 */
export const guardTick = async (deps: GuardTickDeps): Promise<GuardTickResult> => {
  const thresholds = deps.thresholds ?? DEFAULT_GUARD_THRESHOLDS;
  const now = deps.now ?? (() => new Date());
  const state = readGuardState(deps.runDir);
  const decision = decideGuard(deps.facts, thresholds, state);
  const nowMs = deps.facts.nowMs;
  let recovered = false;
  let recoveryDetail: string | null = null;

  if (decision.report && decision.text !== null && decision.level !== null) {
    appendNotification(deps.runDir, {
      level: decision.level,
      kind: "guard",
      reason: `guard:${deps.facts.phase}:${decision.reason}`,
      since: now().toISOString(),
    });
    appendGuardReport(deps.runDir, {
      at: now().toISOString(),
      phase: deps.facts.phase,
      verdict: decision.verdict,
      text: decision.text,
    });
  }

  if (decision.recover && deps.relaunch !== undefined) {
    try {
      const outcome = await deps.relaunch();
      recovered = outcome.ok;
      recoveryDetail = outcome.detail ?? null;
      appendNotification(deps.runDir, {
        level: outcome.ok ? "info" : "error",
        kind: "guard",
        reason: `guard:${deps.facts.phase}:${outcome.ok ? "recovered" : "recover_failed"}`,
        since: now().toISOString(),
      });
    } catch (cause) {
      recovered = false;
      recoveryDetail = cause instanceof Error ? cause.message : String(cause);
      appendNotification(deps.runDir, {
        level: "error",
        kind: "guard",
        reason: `guard:${deps.facts.phase}:recover_failed`,
        since: now().toISOString(),
      });
    }
  }

  writeGuardState(deps.runDir, {
    attempts: state.attempts + (recovered ? 1 : 0),
    lastActionAtMs: recovered ? nowMs : state.lastActionAtMs,
    lastReportAtMs: decision.report ? nowMs : state.lastReportAtMs,
    lastVerdict: decision.verdict,
    lastReason: decision.reason,
  });

  return { decision, recovered, recoveryDetail };
};
