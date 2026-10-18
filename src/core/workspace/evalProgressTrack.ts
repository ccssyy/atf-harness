/**
 * 批㊶-S3 窗口B S-B1——评估就绪进度账（内核编排 `orch/progress.jsonl`）读账面。
 *
 * 单一职责：读账（append-only JSONL，四态闭集 launching/initializing/ready/failed——
 * 契约见内核 skill 环节⑤补登）→ 阶段流转推导（相邻同相折叠）→ 通知投影面
 * （monitor.json additive 键，键面白名单构造、不透传未知字段）。**读账播报零造值**：
 * phase/detail/elapsed_s 逐字搬运账行，不推导不补齐；无账/坏行如实降级。
 * 另含训练完成"可评估"通知判据（D4①——复用段事实轨：training 段完成事实在位且
 * evaluate 段未 done 时一跳，id 含事实时间戳天然去重）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSegmentFacts, type SegmentFact } from "./segmentFacts.js";
import type { EvalServiceHealthFace } from "./evalServiceHealth.js";

/** 账行（progress.jsonl 一行一 JSON：ts/phase/detail/elapsed_s——键面闭集）。 */
export interface EvalProgressRow {
  ts: string;
  phase: string;
  detail: string;
  elapsed_s: number;
}

/** 四态闭集（内核 progress.jsonl 契约——消费面只认闭集，外值如实透传不解释）。 */
export const EVAL_PHASES: readonly string[] = ["launching", "initializing", "ready", "failed"];

/** 账行解析（单行）：键面白名单收窄，坏行 null 不猜。 */
export const parseEvalProgressLine = (line: string): EvalProgressRow | null => {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    if (raw === null || typeof raw !== "object") return null;
    const ts = raw["ts"];
    const phase = raw["phase"];
    const detail = raw["detail"];
    const elapsed = raw["elapsed_s"];
    if (typeof ts !== "string" || ts === "" || typeof phase !== "string" || phase === "") return null;
    return {
      ts,
      phase,
      detail: typeof detail === "string" ? detail : "",
      elapsed_s: typeof elapsed === "number" && Number.isFinite(elapsed) ? elapsed : 0,
    };
  } catch {
    return null;
  }
};

/** 最新评估轮目录（<run>/eval/<N-日期> 取 N 最大——与 scanEvalRounds 同轮序口径）。 */
export const latestEvalRoundDir = (runDir: string): string | null => {
  const evalRoot = join(runDir, "eval");
  let best: { name: string; n: number } | null = null;
  try {
    for (const entry of readdirSync(evalRoot, { withFileTypes: true })) {
      const m = /^(\d+)-(\d{8})$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) {
        const n = Number(m[1]);
        if (best === null || n > best.n) best = { name: entry.name, n };
      }
    }
  } catch {
    return null;
  }
  return best === null ? null : join(evalRoot, best.name);
};

/** 读账：最新评估轮 orch/progress.jsonl 全量行（缺账/不可读＝null；坏行如实跳过）。 */
export const readEvalProgressLedger = (runDir: string): { round: string; rows: EvalProgressRow[] } | null => {
  const roundDir = latestEvalRoundDir(runDir);
  if (roundDir === null) return null;
  const path = join(roundDir, "orch", "progress.jsonl");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const rows = text.split("\n").map(parseEvalProgressLine).filter((r): r is EvalProgressRow => r !== null);
  const roundDirName = roundDir.split(/[\\/]/).pop() ?? "";
  return { round: roundDirName, rows };
};

/** 阶段流转（纯函数）：相邻同相折叠为一跳；每跳携带 phase/首次出现时刻/该相末行 detail 与 elapsed_s。
 *  append-only 账重放稳定（同账同流转序列——id 用 phase+首时刻，天然幂等）。 */
export interface EvalPhaseTransition {
  id: string;
  round: string;
  phase: string;
  detail: string;
  elapsed_s: number;
  at: string;
}

export const derivePhaseTransitions = (round: string, rows: EvalProgressRow[]): EvalPhaseTransition[] => {
  const hops: EvalPhaseTransition[] = [];
  for (const row of rows) {
    const last = hops[hops.length - 1];
    if (last !== undefined && last.phase === row.phase) {
      last.detail = row.detail;
      last.elapsed_s = row.elapsed_s;
      continue;
    }
    hops.push({ id: `${round}:${row.phase}:${row.ts}`, round, phase: row.phase, detail: row.detail, elapsed_s: row.elapsed_s, at: row.ts });
  }
  return hops;
};

/** 通知投影面（monitor.json runs[].eval_notices 元素——键面白名单闭集，构造即收窄）。 */
export type EvalNoticeFace = EvalPhaseTransition | TrainableNoticeFace;

/** 训练完成"可评估"一跳（D4①）：id 含训练完成事实时间戳（重训后事实追加→新 id→再通知）。 */
export interface TrainableNoticeFace {
  id: string;
  kind: "trainable";
  at: string;
}

/** 可评估判据（复用段事实轨）：training 段完成事实在位且 evaluate 段无完成事实。
 *  训练完成事实＝segments.json 中 source=atf_run_training 的 training 条目（start 放行
 *  即记——完成语义沿完成产物锚复核：adapter_model.safetensors/all_results.json 任一在位）；
 *  evaluate 段事实（atf_evaluate）在位＝已发起评估，不再通知。 */
export const deriveTrainableNotice = (
  runDir: string,
  facts: SegmentFact[],
  anchors: { trainingDone: boolean; evaluateDone: boolean },
): TrainableNoticeFace | null => {
  if (anchors.trainingDone !== true || anchors.evaluateDone === true) return null;
  const trainingFacts = facts.filter((f) => f.segment === "training");
  if (trainingFacts.length === 0) return null;
  const lastAt = trainingFacts.map((f) => f.at).sort().pop() ?? "";
  return { id: `trainable:${lastAt}`, kind: "trainable", at: lastAt };
};

/** 训练完成产物锚（LlamaFactory 真实完成产物——与 atf-ui trainingAnchorPresent 同源语义）。 */
export const trainingDoneAnchored = (runDir: string): boolean =>
  existsSync(join(runDir, "training", "adapter_model.safetensors")) || existsSync(join(runDir, "training", "all_results.json"));

/** 评估已发起判据（segments.json 中 evaluate 事实——atf_evaluate 编排启动即记）。 */
export const evaluateFactPresent = (facts: SegmentFact[]): boolean => facts.some((f) => f.segment === "evaluate");

/** 通知面组装（scanRunDir 消费入口）：账读不到且无可评估跳＝空数组（如实无通知）。 */
export const buildEvalNoticeFaces = (runDir: string): { progress: EvalProgressFace | null; notices: EvalNoticeFace[] } => {
  const ledger = readEvalProgressLedger(runDir);
  const transitions = ledger === null ? [] : derivePhaseTransitions(ledger.round, ledger.rows);
  const progress: EvalProgressFace | null =
    ledger !== null && ledger.rows.length > 0
      ? (() => {
          const lastRow = ledger.rows[ledger.rows.length - 1] as EvalProgressRow;
          return { round: ledger.round, phase: lastRow.phase, detail: lastRow.detail, elapsed_s: lastRow.elapsed_s, updated_at: lastRow.ts };
        })()
      : null;
  const facts = readSegmentFacts(runDir);
  const trainable = deriveTrainableNotice(runDir, facts, {
    trainingDone: trainingDoneAnchored(runDir),
    evaluateDone: evaluateFactPresent(facts),
  });
  const notices: EvalNoticeFace[] = [...transitions, ...(trainable !== null ? [trainable] : [])];
  return { progress, notices };
};

/** 进度投影面（monitor.json runs[].eval_progress——键面白名单闭集）。 */
export interface EvalProgressFace {
  round: string;
  phase: string;
  detail: string;
  elapsed_s: number;
  updated_at: string;
  /** 批C1-1 D6：服务健康（additive——同步器探测后回填；缺省/取不到＝null 无假健康）。 */
  health?: EvalServiceHealthFace | null;
}
