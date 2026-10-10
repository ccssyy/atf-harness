/**
 * 批㊶-P P-2——训练探针（自适应步长基线）＋告警面（run 目录本地 alerts.json，fail-open）。
 *
 * 判定四态（同步器 5s 扫描内 per-run）：
 *   error·假死    —— training.active=true 且 progress.updated_at 停更超阈值；
 *                    阈值＝max(progress 历史步间隔中位数×3, 10 分钟)；无历史基线＝30 分钟保守缺省
 *                    （owner 修订：单步可能数分钟，替代一刀切 3 分钟）。
 *   error·进程消失 —— tmux 绑 run 取证消失＋loss-series mtime 过窗＋training 段未 done（沿 O-1）。
 *   error·OOM     —— 训练日志匹配 CUDA out of memory 特征 → 触发 P-1 OOM 降档建议（bs1/accum×2/gb256 预填）。
 *   warn·loss 停滞 —— loss 连续 N 个判定周期无变化（N 自适应沿基线机制）；仅提示不打断。
 *
 * 通知出口两路：monitor additive per-run probe 字段（{level, reason, since}，无告警 null）＋
 * alerts.json append（上限截断）——模型调 status 随状态返回。全自动代发不在本批（归批㊶-Q）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readProgress, progressFresh, type RunProgress } from "./runFacts.js";

export interface ProbeAlert {
  level: "error" | "warn";
  reason: string;
  since: string;
}

/** 训练日志 OOM 特征（大小写不敏感子串）。 */
export const OOM_PATTERN = /cuda out of memory/i;

/** alerts.json 路径与上限（append＋截断）。 */
export const alertsPathOf = (runDir: string): string => join(runDir, "webui", "alerts.json");
const ALERTS_MAX = 50;

export const readAlerts = (runDir: string): ProbeAlert[] => {
  const path = alertsPathOf(runDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ProbeAlert[]) : [];
  } catch {
    return [];
  }
};

const appendAlert = (runDir: string, alert: ProbeAlert): void => {
  try {
    const alerts = readAlerts(runDir);
    // 幂等：同级同因且 since 在 10 分钟内不重复追加
    const recent = alerts.find(
      (a) => a.level === alert.level && a.reason === alert.reason &&
        Date.parse(a.since) > Date.now() - 600_000,
    );
    if (recent !== undefined) return;
    alerts.push(alert);
    const trimmed = alerts.slice(-ALERTS_MAX);
    const dir = join(runDir, "webui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(alertsPathOf(runDir), `${JSON.stringify(trimmed, null, 1)}\n`, "utf8");
  } catch {
    // fail-open
  }
};

/** 进度历史步间隔中位数（从 progress.json 历史不可得时——由 loss 点间距近似；无基线返回 null）。
 *  progress.json 本身只存末点；步间隔基线取 loss-series 相邻点时间差的中位数（秒）。 */
export const medianStepIntervalSec = (lossPoints: Array<Record<string, unknown>>): number | null => {
  const times: number[] = [];
  for (const point of lossPoints) {
    const at = typeof point["at"] === "string" ? Date.parse(point["at"] as string) : NaN;
    if (Number.isFinite(at)) times.push(at);
  }
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i]! - times[i - 1]!) / 1000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid! - 1]! + gaps[mid]!) / 2;
};

/** 停更阈值（秒）：max(步间隔中位数×3, 600)；无基线保守 1800（30 分钟）。 */
export const staleThresholdSec = (medianIntervalSec: number | null): number => {
  if (medianIntervalSec === null || !Number.isFinite(medianIntervalSec) || medianIntervalSec <= 0) return 1800;
  return Math.max(medianIntervalSec * 3, 600);
};

export interface ProbeInput {
  trainingActive: boolean;
  tmuxEvidence: boolean;
  lossSeriesFresh: boolean;
  trainingDone: boolean;
  lossPoints: Array<Record<string, unknown>>;
  progress: RunProgress | null;
  logTailText: string;
  nowMs: number;
}

/** 探针判定（纯函数——vitest 直测）。返回最高优先级告警（error > warn），无告警 null。 */
export const probeRun = (input: ProbeInput): ProbeAlert | null => {
  const since = new Date(input.nowMs).toISOString();
  // error·OOM（日志特征）
  if (OOM_PATTERN.test(input.logTailText)) {
    return { level: "error", reason: "CUDA out of memory（训练日志 OOM 特征）——建议重发：bs 1、梯度累积翻倍、全局批量 256 不变", since };
  }
  // error·进程消失（沿 O-1 取证链）
  if (input.trainingActive && !input.tmuxEvidence && !input.lossSeriesFresh && !input.trainingDone) {
    return { level: "error", reason: "训练进程消失（tmux 取证无本 run 会话且产物停止更新）", since };
  }
  // error·假死（自适应停更阈值）
  if (input.trainingActive && input.progress !== null) {
    const median = medianStepIntervalSec(input.lossPoints);
    const thresholdSec = staleThresholdSec(median);
    const updatedAt = Date.parse(input.progress.updated_at);
    if (Number.isFinite(updatedAt) && input.nowMs - updatedAt > thresholdSec * 1000) {
      return {
        level: "error",
        reason: `训练疑似停滞 · 进度已停更 ${Math.round((input.nowMs - updatedAt) / 60000)} 分钟（阈值 ${Math.round(thresholdSec / 60)} 分钟，自适应步长基线）`,
        since,
      };
    }
  }
  // warn·loss 停滞（连续 N 个判定周期无变化；N 自适应＝基线周期数，缺省 3）
  if (input.trainingActive) {
    const times: number[] = [];
    const losses: number[] = [];
    for (const point of input.lossPoints) {
      const at = typeof point["at"] === "string" ? Date.parse(point["at"] as string) : NaN;
      const loss = typeof point["train_loss"] === "number" ? (point["train_loss"] as number) : NaN;
      if (Number.isFinite(at) && Number.isFinite(loss)) { times.push(at); losses.push(loss); }
    }
    if (times.length >= 3) {
      const median = medianStepIntervalSec(input.lossPoints) ?? 60;
      const n = Math.max(3, Math.min(10, Math.round(staleThresholdSec(median) / Math.max(median, 1))));
      const tail = losses.slice(-n);
      const allSame = tail.every((v) => v === tail[0]);
      if (allSame && tail.length >= 3) {
        return { level: "warn", reason: `loss 连续 ${tail.length} 个周期无变化（值 ${tail[0]}）`, since };
      }
    }
  }
  return null;
};

/** 同步器入口：判定＋告警落盘＋返回 probe 面（无告警 null）。 */
export const probeAndRecord = (runDir: string, input: ProbeInput): ProbeAlert | null => {
  const alert = probeRun(input);
  if (alert !== null) appendAlert(runDir, alert);
  return alert;
};

export { readProgress, progressFresh };
