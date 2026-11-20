/**
 * 批C1-1 D5——训练终态跃迁通知轨（并入既有通知面，零新通道）。
 *
 * 单一职责：由同步器每周期观测的 run 训练态（pending/active/done/failed——与
 * snapshot.segmentStatus 训练段同优先级：活跃＞完成锚＞failed＞pending）驱动一台
 * 纯跃迁状态机：仅「活跃/未启动 → 终态（done/failed）」一跳产 notice（终态间互跳、
 * 首见即终态不产——禁每轮全亮）；per-run last-state 持久化（runsRoot/atf-ui/
 * train-notice-state.json，与 monitor.json 同写盘位同单写者），重启不重报、重训后
 * 新跃迁新 id 再报。notice 形与 eval_notices 同族（additive train_notices），文案只
 * 说事实（零工具名/批次号/内部代号）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** 观测态闭集（与 snapshot.segmentStatus 训练段显示态同优先级镜像）。 */
export type TrainObservedState = "pending" | "active" | "done" | "failed";

/** 终态闭集（跃迁目标）。 */
export type TrainTerminalKind = "training_done" | "training_failed";

/** 通知面（monitor.json runs[].train_notices 元素——与 eval_notices 同族 additive；
 *  id 供 client 已读集去重，text 为用户可见文案单源）。 */
export interface TrainTerminalNoticeFace {
  id: string;
  kind: TrainTerminalKind;
  run_id: string;
  at: string;
  text: string;
}

/** 用户可见文案（owner 审措辞面——只说事实；失败态附只读指路，不点具体路径）。 */
export const TRAIN_NOTICE_TEXT: Readonly<Record<TrainTerminalKind, string>> = {
  training_done: "训练已结束",
  training_failed: "训练未完成退出，可查看训练日志或报告",
};

/** 每 run 通知账保留上限（与 eval_notices slice(-8) 同量级；超出滚出最旧）。 */
export const TRAIN_NOTICE_LOG_CAP = 8;

/** 持久化文件名（落在 runsRoot/atf-ui/——与 monitor.json 同目录，同步器单写者）。 */
export const TRAIN_NOTICE_STATE_FILENAME = "train-notice-state.json";

/** 持久化形态：per-run last-state ＋ per-run 通知账（append 有界）。 */
export interface TrainNoticeStateFile {
  states: Record<string, TrainObservedState>;
  notices: Record<string, TrainTerminalNoticeFace[]>;
}

/**
 * 观测态推导（纯函数）：活跃（training.active）＞完成锚（segments.training===true）
 * ＞ failed（segments.training==="failed"）＞ pending。与用户在浮卡看到的训练段态一致，
 * 跃迁通知的「起跳」与「落点」都对齐显示语义（重训期间回 active 不产终态通知）。
 */
export const trainObservedStateOf = (run: {
  segments?: { training?: boolean | string };
  training?: { active?: boolean };
}): TrainObservedState => {
  if (run.training?.active === true) return "active";
  const seg = run.segments?.training;
  if (seg === true) return "done";
  if (seg === "failed") return "failed";
  return "pending";
};

/** 跃迁判定（纯函数）：起跳闭集＝活跃/未启动，落点闭集＝终态；其余（首见/终态间互跳）不产。 */
export const isEmittingTransition = (prev: TrainObservedState | undefined, next: TrainObservedState): boolean =>
  (prev === "active" || prev === "pending") && (next === "done" || next === "failed");

/**
 * 状态机推进（纯函数）：逐 run 推进 last-state，命中跃迁产出 additive 通知
 * （id＝kind:run_id:观测时刻——同一跃迁只产一次；重训后经 active 再落终态＝新时刻新 id）。
 * @param states - 持久化的 per-run last-state（缺省空——首见语义见 isEmittingTransition）。
 * @param observations - 本周期观测（run_id＋观测态）。
 * @param atIso - 本周期观测时刻（ISO——id 与 at 同源，刷新/重启同 id）。
 */
export const applyTrainNoticeTransitions = (
  states: Readonly<Record<string, TrainObservedState>>,
  observations: ReadonlyArray<{ run_id: string; state: TrainObservedState }>,
  atIso: string,
): { notices: TrainTerminalNoticeFace[]; next: Record<string, TrainObservedState> } => {
  const next: Record<string, TrainObservedState> = { ...states };
  const notices: TrainTerminalNoticeFace[] = [];
  for (const obs of observations) {
    const prev = states[obs.run_id];
    next[obs.run_id] = obs.state;
    if (!isEmittingTransition(prev, obs.state)) continue;
    const kind: TrainTerminalKind = obs.state === "done" ? "training_done" : "training_failed";
    notices.push({ id: `train:${kind}:${obs.run_id}:${atIso}`, kind, run_id: obs.run_id, at: atIso, text: TRAIN_NOTICE_TEXT[kind] });
  }
  return { notices, next };
};

/** 状态文件读取（坏文件/缺席＝空态重来——fail-closed：首见即终态不产通知，不重报不刷屏）。 */
export const readTrainNoticeState = (path: string): TrainNoticeStateFile => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const states: Record<string, TrainObservedState> = {};
    if (raw !== null && typeof raw === "object" && raw["states"] !== null && typeof raw["states"] === "object") {
      for (const [runId, value] of Object.entries(raw["states"] as Record<string, unknown>)) {
        if (value === "pending" || value === "active" || value === "done" || value === "failed") states[runId] = value;
      }
    }
    const notices: Record<string, TrainTerminalNoticeFace[]> = {};
    if (raw !== null && typeof raw === "object" && raw["notices"] !== null && typeof raw["notices"] === "object") {
      for (const [runId, value] of Object.entries(raw["notices"] as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const faces = value.filter(
            (n): n is TrainTerminalNoticeFace =>
              n !== null && typeof n === "object" && typeof (n as Record<string, unknown>)["id"] === "string",
          );
          if (faces.length > 0) notices[runId] = faces.slice(-TRAIN_NOTICE_LOG_CAP);
        }
      }
    }
    return { states, notices };
  } catch {
    return { states: {}, notices: {} };
  }
};

/** 状态文件写入（与 monitor.json 同步器单写者；JSON 落盘即可——同 tickOnce 串行面）。 */
export const writeTrainNoticeState = (path: string, state: TrainNoticeStateFile): void => {
  const pruned: Record<string, TrainTerminalNoticeFace[]> = {};
  for (const [runId, list] of Object.entries(state.notices)) {
    const capped = list.slice(-TRAIN_NOTICE_LOG_CAP);
    if (capped.length > 0) pruned[runId] = capped;
  }
  writeFileSync(path, `${JSON.stringify({ states: state.states, notices: pruned }, null, 1)}\n`, "utf8");
};

/** 状态文件在位探测（测试/诊断面）。 */
export const trainNoticeStateExists = (path: string): boolean => existsSync(path);
