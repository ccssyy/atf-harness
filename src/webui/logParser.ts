/**
 * 批⑯ 增量 B（2026-09-30，指令 f4ef32e2）——训练监控数据面管道。
 *
 * 职责链：HF Trainer 日志行（`{'loss': 0.32,'grad_norm': 1.02,'learning_rate': 1e-4,'epoch': 0.02}`
 * 单引号 Python dict 形态）→ parseTrainerLogLine 结构化 → appendLossSeries 落盘
 * `runs/<id>/training/loss-series.json`（append-only：`[{step, train_loss?, eval_loss?,
 * grad_norm?, at}]`）→ SSE `metrics_delta` 增量推送 → 右栏三线曲线（页面刷新从文件重建，
 * SSE 只推增量——§B 落盘契约）。
 *
 * eval_loss 来自 HF Trainer 的 `{'eval_loss': ...}` 行（独立行）；v1 边界：逐层梯度可视化
 * 不做（界面外链占位）；SwanLab/tensorboard 事件文件接入留 M2。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

/** 结构化日志点（loss-series.json 单元素形态）。 */
export interface LossPoint {
  step: number;
  train_loss?: number;
  eval_loss?: number;
  grad_norm?: number;
  at: string;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Python dict 单引号 → JSON 双引号（键与字符串值；数值/布尔/None 原样）。 */
const pyDictToJson = (line: string): string =>
  line
    .replace(/'/g, '"')
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false");

/**
 * 解析一行 HF Trainer 日志（train/eval 两形态；非日志行 → null 不猜测）。
 * - train：`{'loss': 0.32, 'grad_norm': 1.02, 'learning_rate': 1e-04, 'epoch': 0.02}`
 * - eval： `{'eval_loss': 0.51, 'eval_runtime': 12.3, 'epoch': 1.0}`
 */
export const parseTrainerLogLine = (line: string): Omit<LossPoint, "at"> | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(pyDictToJson(trimmed)) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    const trainLoss = num(parsed["loss"]);
    const evalLoss = num(parsed["eval_loss"]);
    const gradNorm = num(parsed["grad_norm"]);
    const step = num(parsed["step"]) ?? num(parsed["global_step"]);
    const epoch = num(parsed["epoch"]);
    if (trainLoss === undefined && evalLoss === undefined && gradNorm === undefined) return null;
    return {
      step: step ?? (epoch !== undefined ? Math.round(epoch * 100) : 0),
      ...(trainLoss !== undefined ? { train_loss: trainLoss } : {}),
      ...(evalLoss !== undefined ? { eval_loss: evalLoss } : {}),
      ...(gradNorm !== undefined ? { grad_norm: gradNorm } : {}),
    };
  } catch {
    return null;
  }
};

/** loss-series 路径约定（runs/<id>/training/loss-series.json）。 */
export const lossSeriesPath = (runDir: string): string => `${runDir}/training/loss-series.json`;

/** 读全量序列（页面刷新重建曲线——§B「刷新从文件重建」）。文件缺失/损坏 → 空数组。 */
export const readLossSeries = (runDir: string): LossPoint[] => {
  const path = lossSeriesPath(runDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LossPoint[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * 追加一个点（append-only：JSON 数组尾部追加并整写——点数训练期量级 ~1e3-1e4，整写可接受；
 * 行级 append 的 NDJSON 形态留 M1 数据量实证后切换）。返回写后全量（调用方取尾点推 SSE）。
 */
export const appendLossPoint = (runDir: string, point: Omit<LossPoint, "at">, now: string): LossPoint[] => {
  const path = lossSeriesPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  const series = readLossSeries(runDir);
  const full: LossPoint = { ...point, at: now };
  series.push(full);
  writeFileSync(path, `${JSON.stringify(series, null, 1)}\n`, "utf8");
  return series;
};

/** 多行批量解析追加（合成日志流测试与真实 tail 管道共用）。返回新增点（SSE metrics_delta 载荷）。 */
export const ingestTrainerLogLines = (runDir: string, lines: readonly string[], now: string): LossPoint[] => {
  const added: LossPoint[] = [];
  for (const line of lines) {
    const point = parseTrainerLogLine(line);
    if (point !== null) {
      const series = appendLossPoint(runDir, point, now);
      added.push(series[series.length - 1] as LossPoint);
    }
  }
  return added;
};

/** NDJSON 逐行追加形态（M1 数据量实证后切换的预留面——本批实现不接）。 */
export const appendLossPointNdjson = (runDir: string, point: Omit<LossPoint, "at">, now: string): void => {
  const path = lossSeriesPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "", "utf8");
  appendFileSync(path, `${JSON.stringify({ ...point, at: now })}\n`, "utf8");
};
