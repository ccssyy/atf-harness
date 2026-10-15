/**
 * 批⑱-M2——atf-ui：三定制组件的**服务端半**（数据同步器）。
 *
 * 分工：把 runsRoot 快照（段状态/产物清单/loss-series）周期写入
 * `<runsRoot>/atf-ui/monitor.json` 与 `artifacts.json`——client 半（浏览器）经 DSH 原生
 * workspaceFiles.read（外路径读为其文档明示能力）轮询这两个文件渲染。
 * 落盘即重建源（刷新不依赖浏览器会话——指令通用要求）。
 * 目录枚举是 workspace-scoped（DSH 文档口径），故枚举在服务端做、client 只读成品文件。
 * 纯函数（buildMonitorSnapshot/buildArtifactsSnapshot）在 ./snapshot.js，本仓 vitest 直测。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import * as net from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildArtifactsSnapshot, buildMonitorSnapshot } from "./snapshot.js";
import { PANEL_HTML } from "./panel.js";
import { queryNvidiaSmi, queryNvidiaSmiAll } from "../../../../src/webui/readOnlyTools.js";
import { buildConfigConfirmFields, CONFIG_CONFIRM_KEYS } from "../../../../src/webui/configConfirm.js";
import { resolveBridgeDeployment, kernelVersionSync, type BridgeDeployment } from "../../../../src/bridge/bridgeCommand.js";
import { resolveInstanceKernelDir } from "../../../../src/core/workspace/instancePin.js";
import { sessionDomainRefusal, sessionIsScopedFor, listTrainingSessionCmdlines, resolveSessionName, trainingSessionBase } from "../../../../src/core/workspace/tmuxLiveness.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { probeAndRecord } from "../../../../src/core/workspace/trainProbe.js";
import { maybeAutoOomFallback, nodeOomFallbackIo } from "../../../../src/core/workspace/oomFallback.js";
import { startLossIngest } from "../../../../src/core/workspace/lossIngest.js";
import { hasSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { buildEvalNoticeFaces, type EvalNoticeFace, type EvalProgressFace } from "../../../../src/core/workspace/evalProgressTrack.js";
import { orderGuarded, readProgress, progressFresh, readBindings, writeProgress, readNumTrainEpochs, type RunProgress } from "../../../../src/core/workspace/runFacts.js";
import { trainObsTick, readTrainlogTail, resetTrainObsForTest, type TrainlogTailFace } from "../../../../src/core/workspace/trainObsSync.js";
import { bucketedRunEntries, flatRunDirNames, resolveRunDir, RUN_MARKER_RELS, sweepAnsweredPendings } from "../../../../src/core/workspace/runLayout.js";
import { checkApprovalLedgerStartup, ledgerEnvPrefixForShell, homeLedgerPathOf } from "../../../../src/core/workspace/approvalLedger.js";
import { EFFORT_CLOSED_IDS, openSettingsStore, type SettingsDoc, type SettingsStore } from "../../../../src/webui/settings.js";
import {
  instanceSettingsPath,
  effectiveStorageValues,
  validateDirWritable,
  validateVenvPath,
  validateGpuBaseline,
  ensureConventionSubdirs,
} from "../../../../src/webui/storageSettings.js";
import { detectAvailableGpuCount } from "../../../../src/core/workspace/smartDefaults.js";
import { readAlerts } from "../../../../src/core/workspace/trainProbe.js";

/** Cordis 插件名。 */
export const name = "atf-ui";

/** 仓根（packages/extensions/atf-ui/src → 上四级）——缺省落点以本文件位置锚定，
 *  不随 DSH 进程 cwd 漂移（cwd 默认在 vendor 树内，相对缺省即成 vendor 写入面）。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface AtfUiConfig {
  runsRoot: string;
  intervalMs: number;
}

/** 缺省解析（runsRoot 缺省 env 或仓根 tmp/webui-runs——批㉑三段起不再用 cwd 相对值；
 *  批㉘ 补 ATF_WEBUI_RUNS_ROOT 兜底位（指令覆盖轴，排在 ATF_DSH_RUNS_ROOT 之后——dsh 原生轴优先；
 *  两实例现役均只设 ATF_DSH_RUNS_ROOT，缺省行为零变化）。 */
const resolveConfig = (raw: unknown): AtfUiConfig => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    runsRoot:
      typeof value["runsRoot"] === "string"
        ? (value["runsRoot"] as string)
        : (process.env["ATF_DSH_RUNS_ROOT"] ?? process.env["ATF_WEBUI_RUNS_ROOT"] ?? join(repoRoot, "tmp", "webui-runs")),
    intervalMs: typeof value["intervalMs"] === "number" ? (value["intervalMs"] as number) : 5_000,
  };
};

const OUT_DIR = "atf-ui";

/** monitor 快照路径单源（同步器写盘位＝client 半轮询位——批㉘注入面共用了同一推导）。 */
export const monitorPathOf = (runsRoot: string): string => join(runsRoot, OUT_DIR, "monitor.json");

/** index HTML 注入（纯函数）：`</head>` 前插 per-instance monitor 路径全局；
 *  无 head 锚则整体前置。值经 JSON.stringify 转义，路径含特殊字符也安全。
 *  批㊶-E-H 项 2.3：扩键 bridge——桥类型徽标数据源（白名单两键 mode/version，
 *  摘要化不含路径命令面；缺席键＝旧装配面，client 回退不渲染徽标）。 */
export interface BridgeBadgeSurface {
  mode: "mock" | "real";
  /** 内核 git describe tag（real 且可探测时有值；null＝如实无版本）。 */
  version: string | null;
}

export const injectMonitorGlobal = (html: string, monitorPath: string, bridge?: BridgeBadgeSurface, permissionPreset?: { key: string; label: string }, permissionPresets?: Array<{ key: string; label: string }>): string => {
  const config: Record<string, unknown> = { monitorPath };
  if (bridge !== undefined) config["bridge"] = bridge;
  if (permissionPreset !== undefined) config["permissionPreset"] = permissionPreset;
  // 批㊶-Q 段1 additive：档位目录投影（key+label 两键白名单同形态——auto_training 等新档随
  // catalog 自然流入；徽章/切换 UI 由原生选择器承载，本面为目录数据源）
  if (permissionPresets !== undefined) config["permissionPresets"] = permissionPresets;
  const snippet = `<script>window.__ATF_UI_CONFIG__=Object.assign({},window.__ATF_UI_CONFIG__,${JSON.stringify(config)});</script>`;
  const at = html.toLowerCase().indexOf("</head>");
  return at === -1 ? snippet + html : html.slice(0, at) + snippet + html.slice(at);
};

/**
 * 桥徽标面推导（批㊶-E-H 项 2.3）：与 atf-tools 装配同源（src/bridge/bridgeCommand.ts
 * 单源＋同进程同 env——本插件不持 Config，env 缺省值与 atf-tools Config 缺省一致）。
 * real 时探测内核版本（git describe，fail-soft null）。
 */
export const bridgeBadgeSurface = (env: Readonly<Record<string, string | undefined>>, repoRootValue: string, probe?: (path: string) => boolean): BridgeBadgeSurface => {
  // 批㊶-ISO-2 S1：内核目录消费链单源（resolveInstanceKernelDir——ATF_DSH_KERNEL_DIR＞
  // ATF_CLI_PATH＞实例 pin 根）；徽标版本沿 describe（boot 行实载化为 S2——徽标不 spawn 探针）
  const kernelDir = resolveInstanceKernelDir(env, repoRootValue);
  const commandValue = env["ATF_DSH_BRIDGE_COMMAND"] ?? `node ${join(repoRootValue, "tests", "fixtures", "mock_atf.mjs")}`;
  const deployment: BridgeDeployment = resolveBridgeDeployment({ commandValue, kernelDir, env, ...(probe !== undefined ? { probe } : {}) });
  return { mode: deployment.mode, version: deployment.mode === "real" ? kernelVersionSync(deployment.kernelRoot) : null };
};

export interface RunScan {
  run_id: string;
  /** 批㊶Q增补三 段3：工作区桶名（分桶形态＝桶名；平铺存量/系统级＝null——additive）。 */
  workspace: string | null;
  state: string;
  artifacts: string[];
  segments: Record<string, boolean | string>;
  training: { active: boolean; loss: unknown; pending_confirm: unknown; progress?: RunProgress | null };
  /** 批㊶-N N-5：会话绑定集（additive——可空数组）。 */
  bound_sessions?: string[];
  /** 批㊶-P P-2：训练探针告警（additive——{level,reason,since,kind?}，无告警 null；批㊶-Q level 并入 info＋kind 通报面）。 */
  probe?: { level: "error" | "warn" | "info"; reason: string; since: string; kind?: string } | null;
  report: { files: string[] };
  viewers: string[];
  launch: LaunchSurface;
  metrics: EvalMetricsSurface | null;
  env: EnvSurface;
  /** 批㊶-S3 S-B1：评估就绪进度投影面（orch/progress.jsonl 读账——additive，键面白名单）。 */
  eval_progress: EvalProgressFace | null;
  /** 批㊶-S3 S-B1：阶段流转＋训练完成可评估通知（读账播报零造值——additive，上限 8 条）。 */
  eval_notices: EvalNoticeFace[];
  /** 批㊶-TRAIN-OBS T3：训练日志尾部投影（capture-pane→trainlog.tail.json 读盘；null＝缺席）。 */
  trainlog_tail: TrainlogTailFace | null;
  /** 批㉝H：绑卡声明（train.sh/manifest——null＝读不到，client 仅显示全卡聚合）。 */
  gpu_binding: GpuBinding | null;
  /** 批㉞H：逐 eval 轮对比面（两轮对比视图数据源——空数组＝无轮产物）。 */
  eval_rounds: EvalRoundFace[];
}

/** 批㉛段2：Web 发起训练面（monitor.json 下发——client 摘要对话框与发起消息模板的数据源）。 */
export interface LaunchSurface {
  train_sh: boolean;
  config_snapshot: boolean;
  iteration_config: string | null;
  prelaunch_report: string | null;
  summary: IterationSummaryRow[];
}

export interface IterationSummaryRow {
  key: string;
  label: string;
  value: string;
  source: "iteration_config" | "config_snapshot" | "default";
  meaning: string;
}

/** 批㉛段3.1：评估轮指标面（KPI 2×2 数据源——eval 四件套同源 metrics_summary.json）。 */
export interface EvalMetricsSurface {
  round: string;
  model: string;
  pages: number | null;
  f1: number | null;
  precision: number | null;
  recall: number | null;
  exact: number | null;
  /** 批㉞H：推理长度口径（request_max_completion_tokens——轮产物缺该键如实 null，不猜测）。 */
  max_completion_tokens: number | null;
}

/** 批㉛段3.1：环境卡面（IterationConfig 同源——基模型/数据集/deepspeed/lane）。 */
export interface EnvSurface {
  base_model: string;
  dataset_keys: string;
  deepspeed: string;
  lane: string;
}

/** 批㉝H：run 绑卡声明——train.sh 实际执行面（export CUDA_VISIBLE_DEVICES）优先，
 *  回退 launch_manifest.json deploy_effective.visible_devices（声明面）。 */
export interface GpuBinding {
  devices: string;
  source: "train_sh" | "deploy_effective";
}

/** 绑卡声明推导（纯函数）：train.sh 的 `export CUDA_VISIBLE_DEVICES=…` ＞ manifest
 *  deploy_effective.visible_devices；两处都缺席 → null（client 仅显示全卡聚合，不猜测）。 */
export const gpuBindingOf = (runDir: string): GpuBinding | null => {
  try {
    const trainSh = readFileSync(join(runDir, "launch", "train.sh"), "utf8");
    const m = /^\s*export\s+CUDA_VISIBLE_DEVICES=(.+)$/m.exec(trainSh);
    if (m !== null) {
      const devices = m[1]!.trim().replace(/^["']|["']$/g, "");
      if (devices !== "") return { devices, source: "train_sh" };
    }
  } catch {
    // train.sh 缺席 → manifest 声明面回退
  }
  const manifest = readJsonFile(join(runDir, "launch", "launch_manifest.json"));
  if (manifest !== null && typeof manifest === "object") {
    const deploy = (manifest as Record<string, unknown>)["deploy_effective"];
    if (deploy !== null && typeof deploy === "object") {
      const devices = (deploy as Record<string, unknown>)["visible_devices"];
      if (typeof devices === "string" && devices !== "") return { devices, source: "deploy_effective" };
    }
  }
  return null;
};

const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** metrics_summary.json（FormalEvalSummary/v1）→ KPI 2×2 面（纯函数，vitest 直测）。 */
export const parseEvalMetrics = (raw: unknown, round: string): EvalMetricsSurface | null => {
  if (raw === null || typeof raw !== "object") return null;
  const sum = raw as Record<string, unknown>;
  const micro = (sum["micro"] ?? {}) as Record<string, unknown>;
  const model = strOrNull(sum["model"]) ?? "—";
  return {
    round,
    model,
    pages: numOrNull(sum["pages"]),
    f1: numOrNull(micro["f1"]),
    precision: numOrNull(micro["precision"]),
    recall: numOrNull(micro["recall"]),
    exact: numOrNull(sum["page_exact_rate"]),
    max_completion_tokens: numOrNull(sum["request_max_completion_tokens"]),
  };
};

/** 最新评估轮发现：<run>/eval/<N-日期> 取 N 最大者；无轮目录回退 eval 根 metrics_summary.json。 */
export const latestEvalMetrics = (runDir: string): EvalMetricsSurface | null => {  const evalRoot = join(runDir, "eval");
  let best: { round: string; n: number } | null = null;
  try {
    for (const entry of readdirSync(evalRoot, { withFileTypes: true })) {
      const m = /^(\d+)-(\d{8})$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) {
        const n = Number(m[1]);
        if (best === null || n > best.n) best = { round: entry.name, n };
      }
    }
  } catch {
    return null;
  }
  if (best !== null) {
    const raw = readJsonFile(join(evalRoot, best.round, "orch", "eval", "metrics_summary.json"));
    const parsed = parseEvalMetrics(raw, best.round);
    if (parsed !== null) return parsed;
  }
  const rootRaw = readJsonFile(join(evalRoot, "metrics_summary.json"));
  return parseEvalMetrics(rootRaw, "latest");
};

/** 批㉞H：单轮 badcases.jsonl 计数面（纯函数，vitest 直测）——finish_reason 分布
 *  （finish=length 截断行计数）＋错误字段计数；坏行如实跳过，total＝有效行数。 */
export interface BadcaseCounts {
  total: number;
  finish_reason: Record<string, number>;
  by_field: Record<string, number>;
}

export const parseEvalBadcases = (text: string): BadcaseCounts => {
  const counts: BadcaseCounts = { total: 0, finish_reason: {}, by_field: {} };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row === null || typeof row !== "object") continue;
    counts.total += 1;
    const finish = typeof row["finish_reason"] === "string" ? row["finish_reason"] : "unknown";
    counts.finish_reason[finish] = (counts.finish_reason[finish] ?? 0) + 1;
    const field = typeof row["field"] === "string" ? row["field"] : "unknown";
    counts.by_field[field] = (counts.by_field[field] ?? 0) + 1;
  }
  return counts;
};

/** 批㉞H：单 eval 轮对比面（两轮并排对比视图数据源——只读现有产物，不造数据）。 */
export interface EvalRoundFace {
  round: string;
  metrics: EvalMetricsSurface | null;
  badcases: BadcaseCounts | null;
  /** 字段级 F1（metrics_summary fields.*.f1——现有产物已含则展示；缺席 null＝client 占位）。 */
  fields_f1: Record<string, number> | null;
}

/** 逐轮扫描 <run>/eval/<N-日期>/orch/eval/：metrics_summary 在场才入列（按 N 升序——
 *  对比选择器时间序）；badcases.jsonl 与 fields 缺席如实 null。 */
export const scanEvalRounds = (runDir: string): EvalRoundFace[] => {
  const evalRoot = join(runDir, "eval");
  const found: Array<{ name: string; n: number }> = [];
  try {
    for (const entry of readdirSync(evalRoot, { withFileTypes: true })) {
      const m = /^(\d+)-(\d{8})$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) found.push({ name: entry.name, n: Number(m[1]) });
    }
  } catch {
    return [];
  }
  found.sort((a, b) => a.n - b.n);
  const rounds: EvalRoundFace[] = [];
  for (const { name } of found) {
    const evalDir = join(evalRoot, name, "orch", "eval");
    const summary = readJsonFile(join(evalDir, "metrics_summary.json"));
    const metrics = parseEvalMetrics(summary, name);
    if (metrics === null) continue;
    let badcases: BadcaseCounts | null = null;
    try {
      badcases = parseEvalBadcases(readFileSync(join(evalDir, "badcases.jsonl"), "utf8"));
    } catch {
      badcases = null;
    }
    let fieldsF1: Record<string, number> | null = null;
    const fields = summary !== null && typeof summary === "object" ? (summary as Record<string, unknown>)["fields"] : null;
    if (fields !== null && typeof fields === "object") {
      const map: Record<string, number> = {};
      for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
        const f1 = value !== null && typeof value === "object" ? numOrNull((value as Record<string, unknown>)["f1"]) : null;
        if (f1 !== null) map[key] = f1;
      }
      fieldsF1 = Object.keys(map).length > 0 ? map : null;
    }
    rounds.push({ round: name, metrics, badcases, fields_f1: fieldsF1 });
  }
  return rounds;
};

/** 训练历史曲线（live loss-series.json 缺席时的回退源）：最新 checkpoint 的 trainer_state.json
 *  log_history → {step, train_loss, learning_rate, epoch} 点列（client Loss 曲线 train 线）。 */
export const trainerHistoryLoss = (runDir: string): Array<Record<string, number>> => {
  const trainingDir = join(runDir, "training");
  let ckpts: Array<{ name: string; n: number }> = [];
  try {
    for (const entry of readdirSync(trainingDir, { withFileTypes: true })) {
      const m = /^checkpoint-(\d+)$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) ckpts.push({ name: entry.name, n: Number(m[1]) });
    }
  } catch {
    return [];
  }
  ckpts.sort((a, b) => b.n - a.n);
  for (const ckpt of ckpts) {
    const raw = readJsonFile(join(trainingDir, ckpt.name, "trainer_state.json"));
    if (raw === null || typeof raw !== "object") continue;
    const history = (raw as Record<string, unknown>)["log_history"];
    if (!Array.isArray(history)) continue;
    const points: Array<Record<string, number>> = [];
    for (const p of history) {
      if (p === null || typeof p !== "object") continue;
      const row = p as Record<string, unknown>;
      const step = numOrNull(row["step"]);
      const loss = numOrNull(row["loss"]);
      if (step === null || loss === null) continue;
      const point: Record<string, number> = { step, train_loss: loss };
      const lr = numOrNull(row["learning_rate"]);
      const epoch = numOrNull(row["epoch"]);
      if (lr !== null) point["learning_rate"] = lr;
      if (epoch !== null) point["epoch"] = epoch;
      points.push(point);
    }
    if (points.length > 0) return points;
  }
  return [];
};

/** 环境卡面构造（IterationConfig 同源；缺席字段如实 —）。 */
export const buildEnvSurface = (iter: Record<string, unknown> | null, runId: string): EnvSurface => {
  const training = (iter?.["training"] ?? {}) as Record<string, unknown>;
  const dataset = (iter?.["dataset"] ?? {}) as Record<string, unknown>;
  const baseModel = (iter?.["base_model"] ?? {}) as Record<string, unknown>;
  const keys = dataset["dataset_keys"];
  return {
    base_model: strOrNull(baseModel["path"])?.split("/").filter(Boolean).pop() ?? "—",
    dataset_keys: Array.isArray(keys) && keys.every((k) => typeof k === "string") ? (keys as string[]).join(",") : "—",
    deepspeed: strOrNull(training["deepspeed"]) ?? "—",
    lane: strOrNull(iter?.["lane"]) ?? "—",
  };
};

/** 单 run 目录标记推导（任务卡 chat 卡面与同步器同源——trainingFace status 复用本出口）。 */
/** 批㊶-L L-1：训练活跃新鲜窗口缺省（毫秒）——env `ATF_TRAIN_ACTIVE_WINDOW_MS` 可配。 */
export const TRAIN_ACTIVE_WINDOW_MS_DEFAULT = 180_000;
export const TRAIN_ACTIVE_WINDOW_MS_ENV = "ATF_TRAIN_ACTIVE_WINDOW_MS";

/** 新鲜窗口解析（gpuQueuePollMsFromEnv 同风格）：非法/≤0 回落缺省。 */
export const resolveTrainActiveWindowMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env[TRAIN_ACTIVE_WINDOW_MS_ENV];
  if (raw === undefined || raw.trim() === "") return TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
  return parsed;
};

/** 训练活跃注入面（调用方——同步器循环每周期探测一次 tmux，不逐 run）。 */
export interface ScanLiveness {
  /** tmux 训练会话在场（探测异常按 false——fail-closed 回落 mtime 窗口判据）。 */
  trainingTmuxPresent?: boolean;
  /** 批㊶-O O-1：绑 run 取证映射（run_id → 该 run 训练会话进程链含 run_id 的布尔）。
   *  在场时 training.active＝本 run 映射值；未命中回落 mtime 新鲜窗口单判据。
   *  （批㊶-N N-2 会族泛匹配 trainingTmuxFamilyPresent 自本批起不再参与 active 判定。） */
  trainingEvidence?: Record<string, boolean>;
  /** 批㊶-N N-2：training-logs 目录 mtime 新鲜（编排日志写入活性）。 */
  trainingLogsFresh?: boolean;
  freshWindowMs?: number;
  nowMs?: number;
}

/** 批㊶-N N-1：八段有序键（snapshot SEGMENTS 同源序）。 */
const SEGMENT_ORDER_KEYS: readonly string[] = [
  "register", "label_qc", "experiment_config", "publish", "split", "admission", "training", "evaluate",
];

/** 批㊶-N N-2：training-logs 目录活性（目录树内任一文件 mtime 在窗口内即 fresh；
 *  目录缺失/异常＝false）。 */
export const trainingLogsFreshAt = (root: string, windowMs: number, nowMs: number = Date.now()): boolean => {
  // ATF_DSH_LOG_DIR 轴优先（绝对路径独立轴——编排/训练日志写入位）；回落 runsRoot/training-logs
  const candidates = [process.env["ATF_DSH_LOG_DIR"], join(root, "training-logs")].filter((p): p is string => typeof p === "string" && p !== "");
  for (const logsDir of candidates) {
    try {
      if (!existsSync(logsDir)) continue;
      for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
        if (entry.isFile()) {
          const at = statSync(join(logsDir, entry.name)).mtimeMs;
          if (nowMs - at <= windowMs) return true;
        }
      }
    } catch {
      // 目录不可读＝查下一个候选
    }
  }
  return false;
};

/** 批㊶-N N-2：训练完成产物锚三选一（loss-series＝atf-ui 进料路径副产品；
 *  adapter_model.safetensors／all_results.json＝LlamaFactory 真实完成产物）。 */
const trainingAnchorPresent = (runDir: string): boolean =>
  hasAny(runDir, [
    join("training", "loss-series.json"),
    join("training", "adapter_model.safetensors"),
    join("training", "all_results.json"),
  ]);

const hasAny = (runDir: string, rels: readonly string[]): boolean => rels.some((rel) => existsSync(join(runDir, rel)));

/** loss-series mtime 新鲜判定（now/window 注入可测；stat 失败按不新鲜）。 */
const lossSeriesFresh = (dir: string, liveness: ScanLiveness | undefined): boolean => {
  try {
    const windowMs = liveness?.freshWindowMs ?? TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
    const now = liveness?.nowMs ?? Date.now();
    return now - statSync(join(dir, "training", "loss-series.json")).mtimeMs <= windowMs;
  } catch {
    return false;
  }
};

/** 批㊶-M 锚兼容：逐轮目录 eval/<round>/metrics_summary.json 扫描（任一轮在场即 true）。
 *  批㊶-S3 S-B2 锚布局补全：产品现役轮产物在 eval/<round>/orch/eval/metrics_summary.json
 *  （scanEvalRounds/evalStatus 同位）——旧锚只认轮根位，真实布局轮的评估段被误判 pending。 */
const evalRoundAnchored = (runDir: string): boolean => {
  const evalRoot = join(runDir, "eval");
  try {
    for (const entry of readdirSync(evalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(evalRoot, entry.name, "metrics_summary.json"))) return true;
      if (existsSync(join(evalRoot, entry.name, "orch", "eval", "metrics_summary.json"))) return true;
    }
  } catch {
    // eval 根缺失＝无轮产物
  }
  return false;
};

/** 训练活跃终判（批㊶-O O-1 修正）：绑 run tmux 取证优先；无匹配回落 mtime 新鲜窗口
 *  （N-2 既有窗口判据）；泛匹配会族布尔不再参与（假阳性根除）。run_dir 保留签名兼容。 */
const trainingActiveLive = (dir: string, runId: string, liveness: ScanLiveness | undefined): boolean => {
  if (liveness?.trainingEvidence !== undefined) {
    if (liveness.trainingEvidence[runId] === true) return true;
    return lossSeriesFresh(dir, liveness);
  }
  return lossSeriesFresh(dir, liveness);
};

/** 单 run 目录扫描（root＋runId 双形态兼容：分桶调用方传 dirname(runDir) 作 root 或以
 *  workspace 段拼接——dir 单点推导于此）。workspace 为投影标注（批㊶Q增补三 段3 additive）。 */
export function scanRunDir(root: string, runId: string, liveness?: ScanLiveness, workspace: string | null = null): RunScan {
  const dir = workspace !== null ? join(root, workspace, runId) : join(root, runId);
  const has = (rel: string): boolean => existsSync(join(dir, rel));
  // 批㊶-M M-3：段事实轨优先（webui/segments.json 有记录的段直接 done），启发式锚降级兜底
  const segmentDone = (segment: string, heuristicFallback: boolean): boolean =>
    hasSegmentFact(dir, segment) || heuristicFallback;
  const readJson = (rel: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, rel), "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const reportDir = join(dir, "report");
  const reportFiles = existsSync(reportDir) ? readdirSync(reportDir).filter((f) => f.endsWith(".md") || f.endsWith(".json")) : [];

  // 批㊶-N N-1：段序守卫两段装配——先按锚/事实轨算全段原始 done 图，再逐段经 orderGuarded
  // 抑制（后段 done 前提＝前段 done 成立；评估先于训练的陈旧倒挂场景在此天然覆盖）。
  const rawDone: Record<string, boolean> = {
    register: segmentDone("register", has("registration.json") || has("dataset")),
    label_qc: segmentDone("label_qc", has("label_qc") || has("qc")),
    experiment_config: has("webui/config-snapshot.json"),
    publish: (has("report") && reportFiles.some((f) => f.startsWith("segment-"))) || has("contract-candidate.json"),
    split: has("split") || has("dataset/split"),
    admission: has("launch/train.sh") || has("admission.json") || has("training/train.sh"),
    training: trainingAnchorPresent(dir),
    evaluate: has("eval/metrics_summary.json") || evalRoundAnchored(dir),
  };
  // 事实轨并入证据图（M-3 契约「有记录的段直接 done」——experiment_config/publish 等段
  // 的 rawDone 表达式原本只读锚，事实在位而锚布局不符的历史 run 会丢证据）；training 段
  // 事实语义＝start 放行（非完成）、evaluate 段事实＝编排启动（非完成），两段不入事实。
  for (const key of SEGMENT_ORDER_KEYS) {
    if (key === "training" || key === "evaluate") continue;
    if (hasSegmentFact(dir, key)) rawDone[key] = true;
  }
  // 批㊶-S3 S-B2 根因修复②（owner 裁定：段显示态必须保序——done 恒为前缀，后段完成蕴含
  // 前段发生；间隔完成/后成前未成是不合逻辑状态，不得显示）。证据图＝事实轨（segments.json
  // 工具执行成功记录）∥ 在盘锚；training/evaluate 收尾段完成锚（adapter/all_results/metrics
  // 轮产物——出现即事实，历史 run 重评形态由此不再冻结 0/8）。训练活跃期（本轮重跑）证据
  // 不入前缀——训练段回落边界显示 ●，evaluate 回落 pending。显示 done＝前缀闭包（末位证据
  // 截断）：历史 run 前段锚缺口由后段证据反蕴含补齐（登记→体检→…必然已发生），不再出现
  // ✓○✓○ 间隔态；「评估✓训练○」倒挂形态同时被前缀语义自然排除。
  const trainingActiveNow = rawDone.training === true && trainingActiveLive(dir, runId, liveness);
  const evidence: Record<string, boolean> = { ...rawDone };
  evidence["training"] = rawDone.training === true && !trainingActiveNow;
  evidence["evaluate"] = rawDone.evaluate === true && !trainingActiveNow;
  let maxEvidenceIdx = -1;
  SEGMENT_ORDER_KEYS.forEach((key, idx) => {
    if (evidence[key] === true) maxEvidenceIdx = idx;
  });
  const doneMap: Record<string, boolean> = {};
  SEGMENT_ORDER_KEYS.forEach((key, idx) => {
    doneMap[key] = maxEvidenceIdx >= idx;
  });
  // 批㊶-N N-3：段内进度（progress.json 镜像＋fresh 布尔；过期/缺失置 null——additive）
  const progressRaw = readProgress(dir);
  const nowMs = liveness?.nowMs ?? Date.now();
  const progress: RunProgress | null = progressRaw !== null && progressFresh(progressRaw, nowMs, liveness?.freshWindowMs ?? resolveTrainActiveWindowMs(process.env))
    ? progressRaw
    : null;
  // 批㊶-N N-5：会话绑定集（binding.json append 轨镜像；可空）
  const boundSessions = readBindings(dir).map((binding) => binding.session_id);
  // 批㊶-P P-2：探针告警面（alerts.json 末条；同步器另行驱动判定与落盘）
  const probeAlerts = readAlerts(dir);
  const probe = probeAlerts.length > 0 ? probeAlerts[probeAlerts.length - 1]! : null;
  return {
    run_id: runId,
    // 批㊶Q增补三 段3：工作区归属标注（additive——分桶＝桶名，平铺/系统级＝null）
    workspace,
    state: has("webui/config-snapshot.json")
      ? "config_confirmed"
      : has("launch/train.sh")
        ? "launch_ready"
        : has("contract-candidate.json")
          ? "candidate_built"
          : has("registration.json") || has("dataset")
            ? "registered"
            : "unknown",
    artifacts: [
      "session.jsonl",
      "contract-candidate.json",
      "launch/train.sh",
      "launch/launch_manifest.json",
      "webui/config-snapshot.json",
      "eval/metrics_summary.json",
      "eval/badcases.jsonl",
      "eval/raw_predictions.jsonl",
      "eval/indexes.csv",
    ].filter(has),
    segments: {
      register: doneMap["register"] === true,
      split: doneMap["split"] === true,
      label_qc: doneMap["label_qc"] === true,
      // 实验配置段：done（守卫后）＝config-snapshot 已确认；pending-confirm 在场=active（等待四卡应答）
      experiment_config: doneMap["experiment_config"] === true
        ? true
        : has("webui/pending-confirm.json")
          ? "active"
          : false,
      candidate: has("contract-candidate.json"),
      publish: doneMap["publish"] === true,
      admission: doneMap["admission"] === true,
      training: doneMap["training"] === true,
      evaluate: doneMap["evaluate"] === true,
    },
    training: {
      // 批㊶-L L-1＋批㊶-N N-2：终结判定——active＝训练产物锚在场（loss-series／
      // adapter_model.safetensors／all_results.json 三选一）&&（tmux 在场 || 会族前缀
      // atf-* 任一会话 || training-logs mtime 新鲜 || loss-series mtime 新鲜；窗口 env 可配）。
      active: trainingAnchorPresent(dir) && trainingActiveLive(dir, runId, liveness),
      // 批㉛段3.1：live loss-series 缺席 → 最新 checkpoint trainer_state.json 历史回退
      loss: has("training/loss-series.json") ? readJson(join("training", "loss-series.json")) : trainerHistoryLoss(dir),
      pending_confirm: readJson(join("webui", "pending-confirm.json")),
      // 批㊶-N N-3：段内进度（additive——fresh 过期/缺失置 null）
      progress,
    },
    // 批㊶-N N-5：会话绑定集（additive——可空数组）
    bound_sessions: boundSessions,
    // 批㊶-P P-2：训练探针（additive）
    probe,
    report: { files: reportFiles },
    viewers: discoverViewerDirs(dir),
    launch: buildLaunchSurface(dir),
    metrics: latestEvalMetrics(dir),
    env: buildEnvSurface(readJsonFile(iterationConfigPathOf(dir)) as Record<string, unknown> | null, runId),
    gpu_binding: gpuBindingOf(dir),
    eval_rounds: scanEvalRounds(dir),
    // 批㊶-S3 S-B1：通知面（读账播报——键面白名单构造于 evalProgressTrack，不透传未知字段）
    ...(() => {
      const faces = buildEvalNoticeFaces(dir);
      return { eval_progress: faces.progress, eval_notices: faces.notices.slice(-8) };
    })(),
    // 批㊶-TRAIN-OBS T3：日志尾部投影（两键闭集 captured_at/lines——摘要化：行已 200 字符截断）
    trainlog_tail: readTrainlogTail(dir),
  };
}

/**
 * 批㉛段2：IterationConfig 摘要（四件套标准：含义＋值＋来源标注＋可改）——纯函数 vitest 直测。
 *
 * 值源优先级：run 的 IterationConfig 实值（source=iteration_config，标注「来自 IterationConfig」）
 * ＞ webui/config-snapshot.json（source=config_snapshot）＞ 批㉚ 段1 缺省表（source=default，
 * KB 四项如实标注「KB 建议·未校准」）。可改轴＝meaning 尾注（KB 项沿批㉚ label 的改法；核心项
 * 走 chat 纯文字应答「lr 改 2e-4」通道，client 对话框统一提示）。
 *
 * token_gate 语义（批㉛段2 修正，A 重评实证）：max_total_tokens 是**数据构造期准入闸门**——
 * 超限样本在构造期截断/拒绝，不作用于评估推理长度（推理截断根因是服务端 completion 缺省，
 * 批㉙ A 重评已证伪「token_gate 4096＝截断根因」的段1 提案归因）；摘要面不得引用错误归因。
 */
export const ITERATION_MEANINGS: Record<string, string> = {
  learning_rate: "学习率（LoRA 微调优化步长）",
  nproc_per_node: "训练卡数（单机并行进程数＝GPU 数——默认拉满可用卡，训练时长优先；降档仅用户明确要求）",
  base_model_path: "基模型路径（本地绝对路径——默认＝模型库位置下 Qwen3-VL-32B-Instruct，owner 偏置锚点；家族名/HF id 无效）",
  num_train_epochs: "训练轮数（全量数据过几遍）",
  per_device_train_batch_size: "单卡 batch（每次前向的样本数）",
  gradient_accumulation_steps: "梯度累积（累积几步做一次更新；等效 batch＝单卡 batch×累积）",
  cutoff_len: "样本截断长度（训练序列最大 token 数）",
  deepspeed: "DeepSpeed 分布式配置（显存/卸载策略）",
  lora_rank: "LoRA 秩（容量/参数量）",
  lora_alpha: "LoRA alpha（缩放系数，与 rank 成对）",
  dataset_keys: "数据集键（登记面推导的 variants 条目）",
  max_total_tokens: "构造准入闸门：单样本超限在数据构造期截断/拒绝——不作用于评估推理长度（推理截断由服务端 completion 参数决定）",
  image_min_pixels: "像素下限（训练/评估必须同一对值，评估服务只引用训练确认值）",
  image_max_pixels: "像素上限（与像素下限成对确认）",
  negative_ratio_target: "负样本目标带（构造期配比目标）",
};

/** KB 四项（批㉚ 段1 入卡来源——未经确认不进生效配置，卡面/摘要均如实标注未校准）。 */
const KB_KEYS = new Set(["max_total_tokens", "image_min_pixels", "image_max_pixels", "negative_ratio_target"]);

export const buildIterationSummary = (
  iterValues: Record<string, unknown> | null,
  snapshot: Record<string, string> | null,
): IterationSummaryRow[] =>
  CONFIG_CONFIRM_KEYS.map((entry) => {
    const raw = iterValues?.[entry.key];
    const iterValue = raw !== undefined && (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") ? String(raw) : undefined;
    const snapValue = snapshot?.[entry.key];
    const [value, source] =
      iterValue !== undefined
        ? [iterValue, "iteration_config" as const]
        : snapValue !== undefined
          ? [snapValue, "config_snapshot" as const]
          : [entry.default, "default" as const];
    const sourceNote =
      source === "iteration_config"
        ? "来自 IterationConfig"
        : source === "config_snapshot"
          ? "来自登记快照"
          : KB_KEYS.has(entry.key)
            ? "KB 建议·未校准（未经确认不进生效配置）"
            : "已用缺省（未经确认）";
    const meaning = `${ITERATION_MEANINGS[entry.key] ?? entry.label}｜来源：${sourceNote}`;
    return { key: entry.key, label: entry.label, value, source, meaning };
  });

/** IterationConfig 落点（批㉙ 链产物形态：<run>/prep/iteration-config/iteration-config.json）。 */
export const iterationConfigPathOf = (runDir: string): string => join(runDir, "prep", "iteration-config", "iteration-config.json");

const readJsonFile = (abs: string): unknown => {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/** 批㉛段2：单 run 发起面扫描（train.sh/快照/IterationConfig/prelaunch 报告/摘要）。 */
export const buildLaunchSurface = (dir: string): LaunchSurface => {
  const trainSh = existsSync(join(dir, "launch", "train.sh"));
  const snapshotPath = join(dir, "webui", "config-snapshot.json");
  const snapshot = hasConfigSnapshotFile(snapshotPath) ? (readJsonFile(snapshotPath) as { confirmed?: Record<string, string> } | null) : null;
  const iterPath = iterationConfigPathOf(dir);
  const iter = existsSync(iterPath) ? (readJsonFile(iterPath) as Record<string, unknown> | null) : null;
  const reportDir = join(dir, "launch");
  let prelaunch: string | null = null;
  try {
    const hit = readdirSync(reportDir).filter((f) => /^prelaunch.*\.(md|json)$/i.test(f)).sort();
    prelaunch = hit.length > 0 ? join(reportDir, hit[0]!) : null;
  } catch {
    prelaunch = null;
  }
  return {
    train_sh: trainSh,
    config_snapshot: existsSync(snapshotPath),
    iteration_config: iter !== null ? "prep/iteration-config/iteration-config.json" : null,
    prelaunch_report: prelaunch,
    summary: buildIterationSummary(iter?.["training"] !== undefined && iter?.["training"] !== null && typeof iter["training"] === "object" ? (iter["training"] as Record<string, unknown>) : iter, snapshot?.confirmed ?? null),
  };
};

const hasConfigSnapshotFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * badcase viewer 产物发现（批㉛段1）：run 下以 `analysis` 开头的目录里的
 * `viewer/viewer.html`，两形态兼容（批㉕B 两步链 `analysis/` ＋ 批㉙ 命名变体
 * `analysis-b29/`）。`.bak` 备份目录不入列（历史备份不是现役产物，也不得经 URL
 * 服务）；`analysis-input` 无 viewer 子目录自然落选。
 * 排序＝viewer.html mtime 新者在前（A 重评后重建的 viewer 即首选），mtime 同值按名升序。
 */
export function discoverViewerDirs(runDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("analysis") && !e.name.includes(".bak"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const stamp = (name: string): number => {
    try {
      return statSync(join(runDir, name, "viewer", "viewer.html")).mtimeMs;
    } catch {
      return -1;
    }
  };
  return entries
    .filter((name) => stamp(name) >= 0)
    .sort((a, b) => (stamp(b) - stamp(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

/** 批㊶-M2 段 2：run 特征判定（防御性——目录含特征之一才收录为 run）。
 *  特征集＝launch_manifest.json／prep/／training/／webui/／eval/（防 atf-ui/default 等混入）。 */
// 批㊶-S2：RUN_MARKER_RELS 单源迁至 runLayout（readOnlyTools 共用）——此处 re-export 保持锚路径
export { RUN_MARKER_RELS };

export const looksLikeRun = (dir: string): boolean =>
  RUN_MARKER_RELS.some((rel) => existsSync(join(dir, rel)));

/** 同步器周期内 run_id 清单（目录枚举一次——取证映射的目标集；特征过滤后。
 *  批㊶Q增补三 段3：平铺＋分桶双形态并集，run_id 恒为裸名；平铺 run 自身子目录
 *  不作桶降层（launch/eval 等内部结构不产幻影 run——真机 24 条污染实证后修正）。 */
const resolvedRunIds = (runsRoot: string): string[] => {
  const ids: string[] = [];
  const flatRuns = new Set(flatRunDirNames(runsRoot).filter((name) => name !== OUT_DIR && looksLikeRun(join(runsRoot, name))));
  for (const name of flatRuns) ids.push(name);
  for (const entry of bucketedRunEntries(runsRoot)) {
    if (flatRuns.has(entry.workspace) || entry.workspace === OUT_DIR || entry.runId === OUT_DIR) continue;
    if (looksLikeRun(entry.dir)) ids.push(entry.runId);
  }
  return ids;
};

/** 批㊶Q增补三 段3：runsRoot 双层扫描（平铺存量原地保留＋分桶新形态并存——向后兼容）。
 *  桶降层只对非 run 的一级目录进行（平铺 run 的 launch/eval/l1 等子目录是 run 内部
 *  结构不是工作区桶——否则幻影 run 污染全量视图）。 */
/** 导出供 vitest 直测（真机 24 条幻影污染实证后的防回潮锚）。 */
export function scanRuns(runsRoot: string, liveness?: ScanLiveness): RunScan[] {
  const root = join(runsRoot);
  if (!existsSync(root)) return [];
  const runs: RunScan[] = [];
  const flatRuns = new Set(flatRunDirNames(root).filter((name) => name !== OUT_DIR && looksLikeRun(join(root, name))));
  for (const name of flatRuns) {
    runs.push(scanRunDir(root, name, liveness, null));
  }
  for (const entry of bucketedRunEntries(root)) {
    if (flatRuns.has(entry.workspace) || entry.workspace === OUT_DIR || entry.runId === OUT_DIR) continue;
    if (!looksLikeRun(entry.dir)) continue;
    runs.push(scanRunDir(root, entry.runId, liveness, entry.workspace));
  }
  return runs;
}

/**
 * viewer 静态路由 handler 工厂：壳鉴权（connection.requestRejection——401/403 沿壳语义）
 * → GET/HEAD 门 → 逐 run 现役 viewer 清单解析（resolveViewerRequest fail-closed）→ 读盘回包。
 * html/json no-store（刷新即新），图片类 max-age=3600（sha 文件名内容寻址）。
 * @param deps - runsRoot 与每 run viewer 清单的即时发现（每次请求现查，不缓存）。
 */
export const viewerRouteHandler = (deps: {
  runsRoot: string;
  viewersOf: (runId: string) => string[];
  /** 批㊶Q增补三 段3：run 目录双形态解析（缺省平铺拼接——分桶实例由宿主传 resolveRunDir）。 */
  runDirOf?: (runId: string) => string;
  reject?: (req: IncomingMessage) => 401 | 403 | undefined;
}) =>
(req: IncomingMessage, res: ServerResponse): void => {
  const rejection = deps.reject?.(req);
  if (rejection !== undefined) {
    res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  let pathname: string;
  try {
    const url = new URL(req.url ?? "/", "http://x");
    pathname = url.pathname
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // 目录式收尾：无尾斜杠的裸 runId 需 302 补斜杠，viewer 相对资源才能落在正确前缀下。
  const parts = pathname.slice(VIEWER_ROUTE_PREFIX.length).split("/").filter((p) => p !== "");
  if (parts.length === 1 && !req.url!.endsWith("/")) {
    res.writeHead(302, { location: pathname + "/" });
    res.end();
    return;
  }
  const resolved = resolveViewerRequest(deps.runsRoot, pathname, deps.viewersOf(parts[0]!), deps.runDirOf);
  if (resolved === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  const body = readFileSync(resolved.abs);
  res.writeHead(200, {
    "content-type": resolved.type,
    "cache-control": resolved.type.startsWith("image/") ? "public, max-age=3600" : "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : body);
};

export async function tickOnce(resolved: AtfUiConfig): Promise<void> {
  try {
    if (!existsSync(resolved.runsRoot)) return;
    const outDir = join(resolved.runsRoot, OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    // 批㊶-L L-1：tmux 面每周期一次（不逐 run）；异常按 false fail-closed 回落 mtime 窗口。
    // 批㊶-P1 S1：基名作用域化后无「无 run 单会话」可探——在场布尔＝本命名域作用域会话
    // 任一在场（枚举面）；命名域拒绝（前缀未设）经单源出口回流日志（fail-closed 留痕）。
    let trainingTmuxPresent = false;
    let tmuxSessionRefused = false;
    try {
      const refused = sessionDomainRefusal();
      if (refused !== null) {
        tmuxSessionRefused = true;
        console.warn(`[atf-ui] tmux 探测拒绝（${refused.reason}）：${refused.guidance}`);
      } else {
        trainingTmuxPresent = listTrainingSessionCmdlines().length > 0;
      }
    } catch {
      trainingTmuxPresent = false;
    }
    // 批㊶-O O-1：绑 run 取证（per-run 独立）。批㊶-P1 S1：两判据——作用域会话名尾段
    // 精确归属（sessionIsScopedFor，`r1` 不误命中 `cr_r1`）＋存量 cmdline 含 run_id。
    const trainingEvidence: Record<string, boolean> = {};
    try {
      const cmdlines = listTrainingSessionCmdlines();
      for (const entry of cmdlines) {
        for (const runId of resolvedRunIds(resolved.runsRoot)) {
          if (entry.cmdline.includes(runId) || sessionIsScopedFor(entry.session, runId)) trainingEvidence[runId] = true;
        }
      }
    } catch {
      // 取证异常＝空映射（回落 mtime 窗口）
    }
    const runs = scanRuns(resolved.runsRoot, {
      trainingTmuxPresent,
      trainingEvidence,
      trainingLogsFresh: trainingLogsFreshAt(resolved.runsRoot, resolveTrainActiveWindowMs(process.env)),
      freshWindowMs: resolveTrainActiveWindowMs(process.env),
    });
    // 批㊶Q增补三 段4.2：pending-confirm 存量清理扫描（确认/放行完成即删，含存量——
    // 完成证据判据 fail-open；等待中的卡不动。cr_r2 09:36 确认后残留 8h＋实证）
    try {
      sweepAnsweredPendings(resolved.runsRoot);
    } catch { /* 清理扫描异常不阻断同步器 */ }
    // 批㊶-P P-2：训练探针（per-run——active run 才判定；告警落 alerts.json＋monitor probe 面见 snapshot 组装）
    try {
      for (const run of runs) {
        if (!run.training.active) continue;
        // 批㊶Q增补三 段3：run 实际目录（分桶/平铺按 scan 标注推导）
        const runDir = run.workspace !== null ? join(resolved.runsRoot, run.workspace, run.run_id) : join(resolved.runsRoot, run.run_id);
        // 批㊶-TRAIN-OBS T1/T3：训练观测环（同步器 5s 环 per-run 驱动）——trainer_log 末行→
        // progress.json（5s 颗粒＋eta_s）＋tmux capture-pane→trainlog.tail.json；fail-closed：
        // 坏行跳过／12 轮停更转 stale 停环／percentage≥100 终态写一次停环／防双开（trainObsSync 内状态表）。
        // 取代批㊶Q增补二1 的 30s 节流块（5s 颗粒＋eta＋日志尾为本批 D1②/D3 裁定）。
        try {
          void trainObsTick(run.run_id, runDir, readNumTrainEpochs(runDir), {
            capture: sseCapturePane,
            sessionName: (rid) => {
              if (tmuxSessionRefused) return null; // 命名域拒绝＝缺席不伪造（fail-closed）
              const r = resolveSessionName(trainingSessionBase(rid));
              return r.ok ? r.session : null;
            },
          });
        } catch { /* 观测环 fail-open（下周期再试） */ }
        let logTail = "";
        const logsDir = process.env["ATF_DSH_LOG_DIR"];
        if (logsDir !== undefined && existsSync(logsDir)) {
          try {
            const trainLog = join(logsDir, "train-stdout.log");
            if (existsSync(trainLog)) logTail = readFileSync(trainLog, "utf8").slice(-8000);
          } catch { /* 日志不可读＝OOM 特征不可判 */ }
        }
        // 批㊶Q增补二2：trainer_log.jsonl mtime（步进写入活性——探针活跃证据源之一）
        let trainerLogMtimeMs: number | null = null;
        try {
          const trainerLogPath = join(runDir, "training", "trainer_log.jsonl");
          if (existsSync(trainerLogPath)) trainerLogMtimeMs = statSync(trainerLogPath).mtimeMs;
        } catch { /* 不可读＝null（判据按无此证据处理） */ }
        const alert = probeAndRecord(runDir, {
          trainingActive: true,
          tmuxEvidence: trainingEvidence[run.run_id] === true,
          lossSeriesFresh: existsSync(join(runDir, "training", "loss-series.json")),
          trainingDone: run.segments.training === true,
          lossPoints: Array.isArray(run.training.loss) ? (run.training.loss as Array<Record<string, unknown>>) : [],
          progress: readProgress(runDir),
          trainerLogMtimeMs,
          logTailText: logTail,
          nowMs: Date.now(),
        });
        // 批㊶-Q 段3：OOM 自动降档重发（两档统一生效）——护栏全 fail-closed（状态文件/bs 已 1/
        // 补丁失败/端口占用/DRY_RUN 不过均只通报不重发）；通报先于重发落 alerts.json。
        if (alert !== null) {
          try {
            await maybeAutoOomFallback({
              runDir,
              runId: run.run_id,
              logDir: process.env["ATF_DSH_LOG_DIR"] ?? join(runDir, "training-logs"),
              alert: { level: alert.level, kind: alert.kind, reason: alert.reason, since: alert.since },
              // 批㊶Q增补三 段1：重发命令账本 env 同款显式注入（与 atf_run_training start 同源）
              ledgerEnvPrefix: ledgerEnvPrefixForShell(process.env),
              now: () => new Date(),
              log: (line) => console.log(line),
              ...nodeOomFallbackIo,
              dryRun: (abs) => new Promise((resolve) => {
                execFile("bash", [abs], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DRY_RUN: "1" } }, (error, stdout) => {
                  const raw = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
                  resolve({ code: typeof raw === "number" ? raw : 1, stdout: String(stdout) });
                });
              }),
              probePort: (port) => new Promise((resolveProbe) => {
                // bind 探测（trainingFace probePortOccupant 的保守同语义：能绑定＝空闲 null；
                // 占用即非 null 对象——身份不识别，护栏 fail-closed 不清理）
                const srv = net.createServer();
                srv.once("error", () => resolveProbe({ occupied: true }));
                srv.once("listening", () => srv.close(() => resolveProbe(null)));
                srv.listen(port, "0.0.0.0");
              }),
              tmux: (command) => {
                try { execFileSync("/bin/sh", ["-c", command], { timeout: 10_000 }); } catch { /* 会话不存在/已退出＝预期内 */ }
              },
              rotateLog: (logPath) => {
                if (!existsSync(logPath)) return;
                const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
                try { renameSync(logPath, `${logPath}.${stamp}`); } catch { /* 同名冲突放弃轮转（tee -a 兜底） */ }
              },
              startIngest: (logPath, seriesPath) => {
                void startLossIngest(logPath, seriesPath);
              },
            });
          } catch { /* 重发编排异常不阻断同步器（下周期护栏/状态再判） */ }
        }
      }
    } catch {
      // 探针异常不阻断同步器
    }
    // GPU 状态（nvidia-smi 包装——不可用如实 offline，不猜测；快照单源随 monitor.json 下发）。
    // 批㉝H：gpu_all 全卡面并采（首行单卡面保留——atf_gpu_status 工具与旧 client 回退共用）。
    const gpu = await queryNvidiaSmi();
    const gpuAll = await queryNvidiaSmiAll();
    const monitor = buildMonitorSnapshot(runs, gpu === null ? { offline: true } : { offline: false, ...gpu }, gpuAll ?? undefined);
    const artifacts = buildArtifactsSnapshot(runs);
    writeFileSync(join(outDir, "monitor.json"), `${JSON.stringify(monitor, null, 1)}\n`, "utf8");
    // 批㊶-SSE S2：全 monitor 增量发布（与 snapshot 同一数据源——单源无二账；数据面零改动）
    publishMonitorEvents(resolved.runsRoot, monitor as unknown as Record<string, unknown>);
    writeFileSync(join(outDir, "artifacts.json"), `${JSON.stringify(artifacts, null, 1)}\n`, "utf8");
    // 自包含面板（数据内嵌——file:// 直开即用；owner 侧刷新页面即取最新快照）
    writeFileSync(join(outDir, "panel.html"), PANEL_HTML.replace("__ATF_DATA_JSON__", JSON.stringify({ monitor, artifacts }).replace(/</g, "\\u003c")), "utf8");
  } catch (cause) {
    console.error("[atf-ui] 同步失败（下周期重试）:", cause instanceof Error ? cause.message : String(cause));
  }
}

/** 批㊶-S5 B2：只读信息区块组装（灰底无编辑——§二.4；账本路径/凭据值/pin/桥命令锁死只读）。
 *  key_status 只显「已配置/未配置」，不回任何凭据值（env_key 纪律沿用）。 */
export interface SettingsReadonlyBlock {
  kernel_version: string;
  approval_ledger: string;
  key_status: string;
  instance_id: string;
}

export const buildSettingsReadonlyBlock = (
  env: Readonly<Record<string, string | undefined>>,
  bridge: BridgeBadgeSurface,
  repoRootValue: string,
): SettingsReadonlyBlock => {
  const dshHome = env["DSH_HOME"] ?? env["HOME"] ?? repoRootValue;
  const instanceId = dshHome.split("/").filter(Boolean).pop() ?? "unknown";
  const keyConfigured = ["ATF_LLM_KEY_GLM", "ZAI_CODING_CN_API_KEY", "ATF_LLM_CONFIG"].some((k) => {
    const v = env[k];
    return typeof v === "string" && v.trim() !== "";
  });
  return {
    kernel_version: bridge.mode === "real" ? (bridge.version ?? "real（版本未知）") : "mock",
    approval_ledger: homeLedgerPathOf(env["HOME"] ?? ""),
    key_status: keyConfigured ? "已配置" : "未配置",
    instance_id: instanceId,
  };
};

/** 前置服务（cordis 注入声明）：webServer 在场时经 tapIndex 把 monitor 路径注入 index——
 *  client 半据此轮询 per-instance 快照（批㉘；无 webServer 的裸挂载面——如 vitest 直调——跳过注入）。
 *  批㉛段1 增 connection：viewer 静态路由沿用壳既有信任面（requestRejection → 401/403），
 *  不在壳鉴权之外开裸口。 */
export const inject = ["webServer", "connection", "permissionPresets"];

/** viewer 静态服务路由前缀（prefix 注册：本前缀与其下任意子路径都进本 handler）。 */
export const VIEWER_ROUTE_PREFIX = "/atf-ui/viewer";

/** 路径段合法形态：字母数字开头，仅 字母数字._-；`..` 与分隔符天然被拒。 */
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VIEWER_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * viewer 路由请求解析（纯函数，vitest 直测——安全面单源）。
 *
 * URL 形态（pathname 均为 decodeURIComponent 后逐段校验）：
 *   `/atf-ui/viewer/<runId>`                    → 首选 viewer 的 viewer.html（调用方需先重定向补尾斜杠，
 *                                                 相对资源才能落在 runId 目录下）
 *   `/atf-ui/viewer/<runId>/`                   → 首选 viewer 的 viewer.html
 *   `/atf-ui/viewer/<runId>/<analysis>/…`       → 指定 analysis 变体（必须在已发现清单内）
 *   `/atf-ui/viewer/<runId>/images/<sha>.png`   → 首选 viewer 的相对资源
 *
 * fail-closed：runId 段不合法 / analysis 不在发现清单 / 子路径段非法或越出 viewer 根 /
 * 扩展名不在 MIME 表 → null（调用方回 404）。
 * @returns 绝对文件路径与 content-type；不可服务即 null。
 */
export const resolveViewerRequest = (
  runsRoot: string,
  pathname: string,
  viewers: string[],
  runDirOf: (runId: string) => string = (runId) => join(runsRoot, runId),
): { abs: string; type: string } | null => {
  const rest = pathname.slice(VIEWER_ROUTE_PREFIX.length);
  const parts = rest.split("/").filter((p) => p !== "");
  if (parts.length === 0 || !SEG_RE.test(parts[0]!)) return null;
  const runId = parts[0]!;
  if (viewers.length === 0) return null;
  let analysis: string;
  let sub: string[];
  if (parts.length >= 2 && viewers.includes(parts[1]!)) {
    analysis = parts[1]!;
    sub = parts.slice(2);
  } else {
    analysis = viewers[0]!;
    sub = parts.slice(1);
  }
  if (sub.length === 0) sub = ["viewer.html"];
  for (const seg of sub) {
    if (!SEG_RE.test(seg)) return null;
  }
  const viewerRoot = resolve(join(runDirOf(runId), analysis, "viewer"));
  const abs = resolve(join(viewerRoot, ...sub));
  if (abs !== viewerRoot && !abs.startsWith(viewerRoot + sep)) return null;
  const last = sub[sub.length - 1]!;
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return null;
  const mime = VIEWER_MIME[last.slice(dot).toLowerCase()];
  if (mime === undefined) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { abs, type: mime };
};

// ===== 批㊶-SSE：真 SSE 事件流（D1② 全 monitor 增量／D2② 事件日志与 Last-Event-ID 完整回放）=====
// 纯传输层：数据面零改动（progress.jsonl 读账/状态机/投影白名单不动）；事件 payload 与
// monitor.json 各键白名单同源（值直取 buildMonitorSnapshot 产物，不新增字段）。
// 参照 zai-org/ZCode SSE 工程面四要素：event: 命名／id: 续传序号／retry: 重连间隔／心跳注释帧。

/** D1②：事件键闭集＝monitor 顶层语义键（schema 为常量、generated_at 为 tick 水印非状态——
 *  两者不入 diff，否则每 tick 全键误报）。嵌套键（segments/progress/eval_progress/eval_notices
 *  等）变化经由 runs 键整体下发——payload 即 monitor.json runs 数组原形，白名单同源。 */
export const MONITOR_EVENT_KEYS: readonly string[] = ["gpu", "gpu_all", "runs"];

/** 顶层键 diff（JSON 串比较——值同源直取，浅键足矣）：返回发生变化的事件键序列。 */
export const diffMonitorKeys = (prev: Record<string, unknown> | null, next: Record<string, unknown>): string[] =>
  MONITOR_EVENT_KEYS.filter((key) => {
    if (prev === null || !(key in prev)) return true;
    return JSON.stringify(prev[key]) !== JSON.stringify(next[key]);
  });

/** 事件日志滚动阈值（实现侧定，硬约束防无限增长）：单文件 2000 行；滚动保留现役＋1 代归档
 *  （events.jsonl ↔ events.1.jsonl）——总量硬上限 ≈ 2×2000 行。 */
export const SSE_EVENTLOG_MAX_LINES = 2_000;
export const SSE_EVENTLOG_KEEP_ARCHIVES = 1;
export const SSE_EVENTLOG_DIR = "eventlog";

/** 连接治理阈值：每实例并发上限（env 可配）＋心跳间隔缺省 20s（15–30s 带内；env 供测试/调参）。 */
export const SSE_MAX_CONNECTIONS_DEFAULT = 8;
export const SSE_MAX_CONNECTIONS_ENV = "ATF_SSE_MAX_CONNECTIONS";
export const SSE_HEARTBEAT_MS_DEFAULT = 20_000;
export const SSE_HEARTBEAT_MS_ENV = "ATF_SSE_HEARTBEAT_MS";

const sseIntEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const sseMaxConnections = (env: NodeJS.ProcessEnv = process.env): number =>
  sseIntEnv(env[SSE_MAX_CONNECTIONS_ENV], SSE_MAX_CONNECTIONS_DEFAULT);
export const sseHeartbeatMs = (env: NodeJS.ProcessEnv = process.env): number =>
  sseIntEnv(env[SSE_HEARTBEAT_MS_ENV], SSE_HEARTBEAT_MS_DEFAULT);

/** SSE 事件（传输面形态）：id 单调递增（日志尾恢复——跨重启单调）；event＝monitor 键名或
 *  snapshot；data＝该键 monitor.json 值原形（白名单同源）。 */
export interface SseEvent {
  id: number;
  event: string;
  data: unknown;
}

export const sseEventlogDirOf = (runsRoot: string): string => join(runsRoot, OUT_DIR, SSE_EVENTLOG_DIR);

/** SSE 帧构造（四要素：id/event/data；retry 由握手首帧单独下发） */
export const sseFrame = (event: SseEvent): string =>
  `id: ${String(event.id)}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

interface SseConnection {
  res: ServerResponse;
  /** 上一次心跳写尚未被内核回执（flush 回调未触发）——半开连接判据。 */
  pending: boolean;
}

const sseConnections = new Set<SseConnection>();
let sseHeartbeatTimer: NodeJS.Timeout | null = null;
let sseLastMonitor: Record<string, unknown> | null = null;
let sseNextId: number | null = null;

/** 测试钩子：清空连接表/缓存/序号（连接本身由调用方 res 销毁）。 */
export const resetSseStreamStateForTest = (): void => {
  sseConnections.clear();
  if (sseHeartbeatTimer !== null) { clearInterval(sseHeartbeatTimer); sseHeartbeatTimer = null; }
  sseLastMonitor = null;
  sseNextId = null;
};

/** 日志尾恢复序号（跨重启单调）：读现役尾行 id，+1 起算；日志缺席＝1 起算。 */
const sseNextEventId = (runsRoot: string): number => {
  if (sseNextId !== null) return sseNextId;
  let last = 0;
  try {
    const current = join(sseEventlogDirOf(runsRoot), "events.jsonl");
    if (existsSync(current)) {
      const lines = readFileSync(current, "utf8").split("\n").filter((l) => l.trim() !== "");
      const tail = lines[lines.length - 1];
      if (tail !== undefined) {
        const parsed = JSON.parse(tail) as { id?: number };
        if (typeof parsed.id === "number") last = parsed.id;
      }
    }
  } catch { /* 日志不可读＝序号回退（越界回退快照路径兜底） */ }
  sseNextId = last + 1;
  return sseNextId;
};

/** 事件日志 append（滚动：现役超限→改档归档、归档超代→删除最旧）。写失败降级内存流：
 *  console.warn 如实留痕，不阻断推送（指令 S3）。返回是否落盘成功。 */
export const appendEventLog = (runsRoot: string, events: SseEvent[]): boolean => {
  if (events.length === 0) return true;
  const dir = sseEventlogDirOf(runsRoot);
  try {
    mkdirSync(dir, { recursive: true });
    const current = join(dir, "events.jsonl");
    let lines = 0;
    if (existsSync(current)) lines = readFileSync(current, "utf8").split("\n").filter((l) => l.trim() !== "").length;
    if (lines + events.length > SSE_EVENTLOG_MAX_LINES) {
      const archive = join(dir, "events.1.jsonl");
      if (existsSync(archive)) unlinkSync(archive); // 只保留 1 代归档（SSE_EVENTLOG_KEEP_ARCHIVES）
      renameSync(current, archive);
      lines = 0;
    }
    appendFileSync(current, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    return true;
  } catch (cause) {
    console.warn("[atf-ui] SSE 事件日志写失败，降级纯内存流:", cause instanceof Error ? cause.message : String(cause));
    return false;
  }
};

/** 回放读取：Last-Event-ID 定位——现役＋归档按代序拼接，返回 id > lastId 的有序事件；
 *  无缝回放不可保证（lastId 早于最旧保留行＝日志已滚动截断；lastId > 尾行＝客户端来自
 *  失踪日志/重置序号）→ null（调用方回退全量 snapshot，fail-closed 如实）。 */
export const readEventsAfter = (runsRoot: string, lastId: number): SseEvent[] | null => {
  try {
    const dir = sseEventlogDirOf(runsRoot);
    const files = [join(dir, "events.1.jsonl"), join(dir, "events.jsonl")].filter((f) => existsSync(f));
    if (files.length === 0) return null;
    const events: SseEvent[] = [];
    let minId = Number.MAX_SAFE_INTEGER;
    let maxId = 0;
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const parsed = JSON.parse(line) as Partial<SseEvent>;
        if (typeof parsed.id !== "number" || typeof parsed.event !== "string") continue;
        events.push({ id: parsed.id, event: parsed.event, data: parsed.data });
        if (parsed.id < minId) minId = parsed.id;
        if (parsed.id > maxId) maxId = parsed.id;
      }
    }
    if (lastId + 1 < minId || lastId > maxId) return null; // 越界（滚动截断/日志重置）＝无缝回放不可保证
    return events.filter((e) => e.id > lastId);
  } catch {
    return null; // 日志不可读＝fail-closed 回快照
  }
};

/** 增量发布（tickOnce 写盘后调用——与 snapshot 同一数据源，单源无二账）：diff→id 分配→
 *  日志 append（失败降级）→ 活连接 fan-out。首帧基线：prev 为 null 只入缓存不发光
 *  （初态由连接握手 snapshot 帧承载）。 */
export const publishMonitorEvents = (runsRoot: string, monitor: Record<string, unknown>): void => {
  const changed = diffMonitorKeys(sseLastMonitor, monitor);
  sseLastMonitor = monitor;
  if (changed.length === 0) return;
  const base = sseNextEventId(runsRoot);
  const events: SseEvent[] = changed.map((key, i) => ({ id: base + i, event: key, data: monitor[key] }));
  sseNextId = base + events.length;
  appendEventLog(runsRoot, events);
  for (const conn of sseConnections) {
    for (const event of events) {
      try { conn.res.write(sseFrame(event)); } catch { /* 写失败由 res error/close 路径清理 */ }
    }
  }
};

const sseWriteHead = (res: ServerResponse): void => {
  // 头三件套对齐 zai-org/ZCode（packages/debug/server/index.ts：no-cache, no-transform）
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  });
  res.write("retry: 5000\n"); // 首帧重连间隔（四要素之 retry）
};

const sseEnsureHeartbeat = (): void => {
  if (sseHeartbeatTimer !== null) return;
  sseHeartbeatTimer = setInterval(() => {
    for (const conn of [...sseConnections]) {
      // 批㊶-TRAIN-OBS-FIX 断点 B：半开回收——上拍 ping 的 flush 回调至今未触发
      // （对端消失且无 RST）→ 本拍踢除释放名额（每 2 拍内回收，上限 8 不再被占满）。
      if (conn.pending) {
        sseConnections.delete(conn);
        try { conn.res.destroy(); } catch { /* 已死连接 */ }
        continue;
      }
      conn.pending = true;
      try {
        conn.res.write(": ping\n\n", () => { conn.pending = false; });
      } catch {
        sseConnections.delete(conn);
        try { conn.res.destroy(); } catch { /* 已死连接 */ }
      }
    }
    if (sseConnections.size === 0 && sseHeartbeatTimer !== null) {
      clearInterval(sseHeartbeatTimer);
      sseHeartbeatTimer = null;
    }
  }, sseHeartbeatMs());
};

/** SSE 端点 handler 工厂（viewerRouteHandler 同款形态——apply 内以 webServer.register 挂载）。
 *  鉴权走 requestRejection（不自造）；Last-Event-ID 定位回放，越界回退全量 snapshot。 */
export const eventsRouteHandler = (deps: {
  runsRoot: string;
  reject?: (req: IncomingMessage) => 401 | 403 | undefined;
}) =>
(req: IncomingMessage, res: ServerResponse): void => {
  const rejection = deps.reject?.(req);
  if (rejection !== undefined) {
    res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required\n");
    return;
  }
  // 连接治理：并发上限 fail-closed（防连接堆积）
  if (sseConnections.size >= sseMaxConnections()) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("sse connection limit reached\n");
    return;
  }
  if (res.writableEnded || res.destroyed) return;
  sseWriteHead(res);
  const rawLastId = req.headers["last-event-id"];
  const lastId = typeof rawLastId === "string" ? Number(rawLastId) : NaN;
  const hasLastId = Number.isFinite(lastId) && lastId >= 0;
  const replay = hasLastId ? readEventsAfter(deps.runsRoot, lastId) : null;
  if (hasLastId && replay !== null) {
    // D2② 完整回放：定位后按序补发，其后增量由连接注册自然接上
    //（读日志→写帧→注册全同步段——node 单线程无交叠，零丢失窗口）
    for (const event of replay) res.write(sseFrame(event));
  } else {
    // 首连／越界回退：全量 snapshot（id＝当前日志尾——重连从其后增量续传）
    const snapshotId = hasLastId ? lastId : sseNextEventId(deps.runsRoot) - 1;
    res.write(sseFrame({ id: snapshotId, event: "snapshot", data: sseLastMonitor ?? {} }));
  }
  // 连接注册（此后增量直达）；心跳由全局单定时器迭代全部连接（末连接离开即停）
  const conn: SseConnection = { res, pending: false };
  sseConnections.add(conn);
  sseEnsureHeartbeat();
  res.on("close", () => {
    sseConnections.delete(conn);
    if (sseConnections.size === 0 && sseHeartbeatTimer !== null) {
      clearInterval(sseHeartbeatTimer);
      sseHeartbeatTimer = null;
    }
  });
  res.on("error", () => {
    sseConnections.delete(conn);
    res.destroy();
  });
};

/** 批㊶-TRAIN-OBS T3：capture-pane 适配器（eventsRouteHandler 依赖注入形——生产走真 tmux）。 */
const sseCapturePane = (session: string): Promise<string[] | null> =>
  import("../../../../src/core/workspace/trainObsSync.js").then((m) => m.captureTrainlogPane(session));

export function apply(
  ctx: {
    effect(run: () => () => void, label: string): void;
    webServer?: {
      tapIndex(transform: (html: string) => string): () => void;
      register?(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
    };
    connection?: { requestRejection(req: IncomingMessage): 401 | 403 | undefined };
  },
  config: unknown,
): void {
  const resolved = resolveConfig(config);
  console.log(`[atf-ui] 同步器启动（runsRoot=${resolved.runsRoot}，interval=${String(resolved.intervalMs)}ms）`);
  // 批㊶Q增补三 段1②：放行账本启动校验（WebUI 侧告警面——env×$HOME 双路径明示；
  // fail-fast 裁决在 atf-tools 写入侧，本面只告警不阻断监控同步器）
  const ledgerCheck = checkApprovalLedgerStartup(process.env);
  if (!ledgerCheck.dirWritable) {
    console.error(`[atf-ui] ⚠ 放行账本目录不可写（atf-tools 侧已 fail-fast）：${ledgerCheck.message}`);
  } else if (ledgerCheck.mismatch) {
    console.warn(`[atf-ui] ⚠ ${ledgerCheck.message}`);
  } else {
    console.log(`[atf-ui] ${ledgerCheck.message}`);
  }
  // 批㊶-E-H 项 2.3：桥徽标注入面（与 atf-tools 装配单源同 env 推导；boot 日志一行桥类型）
  const bridge = bridgeBadgeSurface(process.env, repoRoot);
  // 批㊶-K 项 3：部署默认权限档注入（GpuCard 徽标数据源——会话现值由宿主头部指示器与
  // atf_permission_status 承载，本键只表部署默认档）
  const permissionService = (ctx as { permissionPresets?: { defaultPreset?: string; catalog?: () => { options: Array<{ value: string; name: string }>; defaultPreset: string } } }).permissionPresets;
  let permissionPreset: { key: string; label: string } | undefined;
  // 批㊶-Q 段1：档位目录投影（additive——全部可选档 key+label；全自动训练档随 catalog 流入）
  let permissionPresetsCatalog: Array<{ key: string; label: string }> | undefined;
  if (permissionService !== undefined && typeof permissionService.catalog === "function") {
    try {
      const catalog = permissionService.catalog();
      const key = permissionService.defaultPreset ?? catalog.defaultPreset;
      const label = catalog.options.find((option) => option.value === key)?.name ?? key;
      permissionPreset = { key, label };
      permissionPresetsCatalog = catalog.options.map((option) => ({ key: option.value, label: option.name ?? option.value }));
    } catch {
      permissionPreset = undefined;
      permissionPresetsCatalog = undefined;
    }
  }
  console.log(`[atf-ui] 桥类型: ${bridge.mode === "real" ? `real${bridge.version !== null ? `·${bridge.version}` : ""}` : "mock（⚠ 缺省——设 ATF_DSH_BRIDGE_COMMAND 切真内核）"}`);
  const webServer = ctx.webServer;
  if (webServer !== undefined) {
    const monitorPath = monitorPathOf(resolved.runsRoot);
    const dispose = webServer.tapIndex((html) => injectMonitorGlobal(html, monitorPath, bridge, permissionPreset, permissionPresetsCatalog));
    ctx.effect(() => dispose, "atf-ui: monitor 路径＋桥徽标 index 注入");
    console.log(`[atf-ui] monitor 路径已注入 index（monitorPath=${monitorPath}）`);
    // 批㉛段1：badcase viewer 静态路由（鉴权沿壳 connection 信任面；connection/register 缺席的
    // 裸挂载面跳过不开口——tapIndex-only 消费方零变化）
    const connection = ctx.connection;
    if (connection !== undefined && webServer.register !== undefined) {
        const disposeRoute = webServer.register({
          kind: "prefix",
          path: VIEWER_ROUTE_PREFIX,
          handler: viewerRouteHandler({
            runsRoot: resolved.runsRoot,
            // 批㊶Q增补三 段3：viewer 目录发现走双形态解析（平铺存量＋分桶新形态）
            viewersOf: (runId) => discoverViewerDirs(resolveRunDir(resolved.runsRoot, runId)),
            runDirOf: (runId) => resolveRunDir(resolved.runsRoot, runId),
            reject: (req) => connection.requestRejection(req),
          }),
        });
      ctx.effect(() => disposeRoute, "atf-ui: viewer 静态路由");
      console.log(`[atf-ui] viewer 静态路由已注册（${VIEWER_ROUTE_PREFIX}/<runId>/）`);
      // 批㊶-SSE S1：真 SSE 事件流端点（D1② 全 monitor 增量／D2② Last-Event-ID 回放）——
      // 鉴权沿壳 connection 信任面（不自造）；连接上限/心跳/滚动日志阈值见常量段
      // 批㊶-TRAIN-OBS-FIX 断点 A：自有快照端点（GET）——monitor/artifacts 双 JSON 一下发；
      // 浏览器同源 fetch 随 shell cookie 过鉴权，不经 remote.mux workspaceFiles.read
      // （该通路真实浏览器恒败且静默——vendor 内部失败点以自有端点整体外绕，vendor 零触碰）。
      const disposeSnapshot = webServer.register({
        kind: "exact",
        path: "/atf-ui/snapshot",
        handler: (req, res) => {
          const rejection = connection.requestRejection(req);
          if (rejection !== undefined) {
            res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
            res.end("dsh web authentication required\n");
            return;
          }
          try {
            const monitorRaw = readFileSync(join(resolved.runsRoot, OUT_DIR, "monitor.json"));
            let artifactsRaw = Buffer.from("{}");
            try { artifactsRaw = readFileSync(join(resolved.runsRoot, OUT_DIR, "artifacts.json")); } catch { /* 未生成＝空形态 */ }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ monitor: JSON.parse(monitorRaw.toString("utf8")), artifacts: JSON.parse(artifactsRaw.toString("utf8")) }));
          } catch {
            res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
            res.end("snapshot not ready\n"); // boot 竞态（同步器首 tick 未落盘）——客户端下周期重取
          }
        },
      });
      ctx.effect(() => disposeSnapshot, "atf-ui: 快照端点");
      console.log("[atf-ui] 快照端点已注册（/atf-ui/snapshot）");
      const disposeEvents = webServer.register({
        kind: "prefix",
        path: "/atf-ui/events",
        handler: eventsRouteHandler({
          runsRoot: resolved.runsRoot,
          reject: (req) => connection.requestRejection(req),
        }),
      });
      ctx.effect(() => disposeEvents, "atf-ui: SSE 事件流路由");
      console.log("[atf-ui] SSE 事件流路由已注册（/atf-ui/events）");
    }
  }
  // 批㊶-S5 B1/B2：设置面数据层（实例隔离 store——<HOME>/.atf/webui-settings.json，env 可覆写）
  // ＋鉴权 GET/POST 路由（connection 信任面沿 viewer 路由先例）。webServer 缺席的裸挂载面跳过。
  const settingsStore: SettingsStore | null = webServer !== undefined
    ? openSettingsStore(instanceSettingsPath(process.env))
    : null;
  if (webServer !== undefined && webServer.register !== undefined) {
    const gpuCountNow = (): number | null => detectAvailableGpuCount(process.env);
    const settingsPayload = (): Record<string, unknown> => {
      const doc = (settingsStore as SettingsStore).get();
      const effective = effectiveStorageValues(process.env, doc.storage);
      return {
        storage: { set: doc.storage, effective },
        // 批甲-FIX T2.1：per-model 默认思考档（模型 id → 档位 id）——设置页 provider-card
        // 下拉与 composer 取值链中段共读此块；缺席＝未配置（取值链落到目录顺位最低档）。
        effort_defaults: doc.effort_defaults ?? {},
        gpu_detected: gpuCountNow(),
        gpu_baseline_effective: doc.storage.train_gpu_baseline.trim() !== "" ? doc.storage.train_gpu_baseline : String(gpuCountNow() ?? ""),
        readonly: buildSettingsReadonlyBlock(process.env, bridgeBadgeSurface(process.env, repoRoot), repoRoot),
        hints: {
          root_note: "根目录只影响新建任务的归属，现有数据位置不变",
          model_root_note: "模型库位置改动＝下次任务生效",
          env_priority: "实际生效值以实例 env 优先；设置值与生效值不一致时以生效值为准（重启/下次任务后对齐）",
        },
      };
    };
    const disposeSettings = webServer.register({
      kind: "exact",
      path: "/atf-ui/settings",
      handler: (req, res) => {
        const rejection = ctx.connection?.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
          res.end("dsh web authentication required\n");
          return;
        }
        void (async (): Promise<void> => {
          if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify(settingsPayload()));
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405, { allow: "GET, POST" });
            res.end();
            return;
          }
          // POST：fail-fast 校验全集（B3）→ 过则落 store＋约定子目录。
          // 批甲-FIX T2.1：body 键分区更新——storage 在场才动 storage（缺省不重写，
          // 防 effort_defaults 单写清空存储设置）；effort_defaults 在场走形态校验
          // （键＝模型 id 非空，值＝闭集四值——不造档位，非法键值 400 如实报）。
          let body = "";
          req.on("data", (chunk: Buffer) => { body += String(chunk); });
          req.on("end", () => {
            let incoming: Record<string, unknown> = {};
            try { incoming = JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>; } catch { /* 空体容忍 */ }
            const hasStorage = Object.prototype.hasOwnProperty.call(incoming, "storage");
            const hasEffortDefaults = Object.prototype.hasOwnProperty.call(incoming, "effort_defaults");
            if (!hasStorage && !hasEffortDefaults) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ saved: false, errors: { body: "无可识别的设置分区（storage / effort_defaults）" } }));
              return;
            }
            const errors: Record<string, string> = {};
            let next = { atf_root: "", model_root: "", train_env: "", eval_env: "", train_gpu_baseline: "" };
            let rootChanged = false;
            let created: string[] = [];
            if (hasStorage) {
              const raw = (incoming["storage"] ?? {}) as Record<string, unknown>;
              const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
              next = {
                atf_root: str("atf_root"),
                model_root: str("model_root"),
                train_env: str("train_env"),
                eval_env: str("eval_env"),
                train_gpu_baseline: str("train_gpu_baseline"),
              };
              if (next.atf_root !== "") { const v = validateDirWritable(next.atf_root); if (!v.ok) errors["atf_root"] = v.reason; }
              if (next.model_root !== "") { const v = validateDirWritable(next.model_root); if (!v.ok) errors["model_root"] = v.reason; }
              const vTrain = validateVenvPath(next.train_env); if (!vTrain.ok) errors["train_env"] = vTrain.reason;
              const vEval = validateVenvPath(next.eval_env); if (!vEval.ok) errors["eval_env"] = vEval.reason;
              const vGpu = validateGpuBaseline(next.train_gpu_baseline, gpuCountNow()); if (!vGpu.ok) errors["train_gpu_baseline"] = vGpu.reason;
            }
            let effortNext: Record<string, string> | null = null;
            if (hasEffortDefaults) {
              const rawEd = incoming["effort_defaults"];
              if (typeof rawEd !== "object" || rawEd === null || Array.isArray(rawEd)) {
                errors["effort_defaults"] = "须为对象（模型 id → 档位 id）";
              } else {
                const bad: string[] = [];
                const cleaned: Record<string, string> = {};
                for (const [modelId, effortId] of Object.entries(rawEd as Record<string, unknown>)) {
                  if (typeof modelId !== "string" || modelId.trim() === "" || typeof effortId !== "string"
                    || !(EFFORT_CLOSED_IDS as ReadonlyArray<string>).includes(effortId)) {
                    bad.push(String(modelId));
                    continue;
                  }
                  cleaned[modelId] = effortId;
                }
                if (bad.length > 0) errors["effort_defaults"] = "非法条目（模型 id 须非空、档位须属闭集 off/low/high/max）：" + bad.join("、");
                else effortNext = cleaned;
              }
            }
            if (Object.keys(errors).length > 0) {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ saved: false, errors }));
              return;
            }
            const patch: Record<string, unknown> = {};
            if (hasStorage) patch["storage"] = next;
            if (effortNext !== null) patch["effort_defaults"] = effortNext;
            const savedDoc = (settingsStore as SettingsStore).put(patch as Partial<SettingsDoc>);
            if (hasStorage) {
              created = next.atf_root !== "" ? ensureConventionSubdirs(next.atf_root) : [];
              rootChanged = next.atf_root !== "" && next.atf_root !== effectiveStorageValues(process.env, { atf_root: "", model_root: "", train_env: "", eval_env: "", train_gpu_baseline: "" }).atf_root;
            }
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({
              saved: true,
              ...(hasStorage ? { storage: next, created_subdirs: created, warning: rootChanged ? "根目录已变更：影响新建任务的目录归属，历史记录仍指向原位置" : "" } : {}),
              effort_defaults: savedDoc.effort_defaults ?? {},
            }));
          });
        })();
      },
    });
    ctx.effect(() => disposeSettings, "atf-ui: 设置面路由");
    console.log("[atf-ui] 设置面路由已注册（/atf-ui/settings——四区块，实例隔离 store）");
  }
  void tickOnce(resolved);
  const timer: NodeJS.Timeout = setInterval(() => void tickOnce(resolved), resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
