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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import * as net from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildArtifactsSnapshot, buildMonitorSnapshot } from "./snapshot.js";
import { PANEL_HTML } from "./panel.js";
import { queryNvidiaSmi, queryNvidiaSmiAll, queryGpuComputeApps, gpuProcTopByIndex } from "../../../../src/webui/readOnlyTools.js";
import { buildConfigConfirmFields, CONFIG_CONFIRM_KEYS } from "../../../../src/webui/configConfirm.js";
import { resolveBridgeDeployment, kernelVersionSync, type BridgeDeployment } from "../../../../src/bridge/bridgeCommand.js";
import { resolveInstanceKernelDir } from "../../../../src/core/workspace/instancePin.js";
import { sessionDomainRefusal, listTrainingSessionCmdlines, probeTrainingEvidence, resolveSessionName, trainingSessionBase } from "../../../../src/core/workspace/tmuxLiveness.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { probeAndRecord } from "../../../../src/core/workspace/trainProbe.js";
import { maybeAutoOomFallback, nodeOomFallbackIo } from "../../../../src/core/workspace/oomFallback.js";
import { startLossIngest } from "../../../../src/core/workspace/lossIngest.js";
import { hasSegmentFact, stageSummarySegmentFacts } from "../../../../src/core/workspace/segmentFacts.js";
import { completionFromExitCodeFile, readTrainingCompletion, writeTrainingCompletion } from "../../../../src/core/workspace/trainingCompletion.js";
import { buildEvalNoticeFaces, type EvalNoticeFace, type EvalProgressFace } from "../../../../src/core/workspace/evalProgressTrack.js";
import {
  applyTrainNoticeTransitions, readTrainNoticeState, trainObservedStateOf,
  TRAIN_NOTICE_STATE_FILENAME, writeTrainNoticeState, type TrainTerminalNoticeFace,
} from "../../../../src/core/workspace/trainNoticeTrack.js";
import { probeEvalServiceHealth, type EvalServiceHealthFace } from "../../../../src/core/workspace/evalServiceHealth.js";
import { orderGuarded, readProgress, progressFresh, readBindings, writeProgress, readNumTrainEpochs, trainerLogPathOf, type RunProgress } from "../../../../src/core/workspace/runFacts.js";
import { trainObsTick, readTrainlogTail, resetTrainObsForTest, type TrainlogTailFace } from "../../../../src/core/workspace/trainObsSync.js";
import { bucketedRunEntries, flatRunDirNames, resolveRunDir, RUN_MARKER_RELS, sweepAnsweredPendings, workspaceOfRunDir } from "../../../../src/core/workspace/runLayout.js";
import { displayOf, buildRunCandidates, writeDisplay } from "../../../../src/core/workspace/runDisplay.js";
import {
  bindSessionRun, migrateFromRunBindings, readSessionBinding, resolveActiveRun, resolveBindingsHome, unbindSession,
  type SessionRunBindingRecord, type UnboundReason,
} from "../../../../src/core/workspace/sessionBindings.js";
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
import { listRegistryRecords, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
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
  /** 批㊶Q增补三 段3：工作区桶名（分桶形态＝桶名；平铺存量/系统级＝null——additive）。
   *  A2 案 a：注册实验树 run＝注册记录 title；平铺 run 命中注册表前缀＝记录 title。 */
  workspace: string | null;
  /** A2 案 a：工作区标注来源（bucket＝runsRoot 分桶（现形态缺省）；registry＝注册表
   *  前缀/实验树枚举）。additive 投影键（adapter 白名单同批）。 */
  workspace_source: "bucket" | "registry";
  state: string;
  /** D3/D4：pending 态指因（additive——单码白名单 no_on_disk_evidence；级联命中＝null）。 */
  state_reason: string | null;
  artifacts: string[];
  segments: Record<string, boolean | string>;
  training: { active: boolean; loss: unknown; pending_confirm: unknown; progress?: RunProgress | null };
  /** 批㊶-N N-5：会话绑定集（additive——可空数组）。 */
  bound_sessions?: string[];
  /** 批㊶-P P-2：训练探针告警（additive——{level,reason,since,kind?}，无告警 null；批㊶-Q level 并入 info＋kind 通报面）。 */
  probe?: { level: "error" | "warn" | "info"; reason: string; since: string; kind?: string } | null;
  report: { files: string[] };
  viewers: string[];
  /** D11-2：产物区 checkpoint 名单（additive——新→旧最多 5 条）。 */
  ckpts: string[];
  launch: LaunchSurface;
  metrics: EvalMetricsSurface | null;
  env: EnvSurface;
  /** 批㊶-S3 S-B1：评估就绪进度投影面（orch/progress.jsonl 读账——additive，键面白名单）。 */
  eval_progress: EvalProgressFace | null;
  /** 批㊶-S3 S-B1：阶段流转＋训练完成可评估通知（读账播报零造值——additive，上限 8 条）。 */
  eval_notices: EvalNoticeFace[];
  /** 批C1-1 D5：训练终态跃迁通知（活跃/未启动→done/failed 一跳——持久 last-state 判跃迁，
   *  additive，上限 8 条；client 复用同一通知卡与已读集）。 */
  train_notices: TrainTerminalNoticeFace[];
  /** 批㊶-TRAIN-OBS T3：训练日志尾部投影（capture-pane→trainlog.tail.json 读盘；null＝缺席）。 */
  trainlog_tail: TrainlogTailFace | null;
  /** 批B1：run 显示名（用户改名优先，否则自动名；title 不含 workspace——additive 单键）。 */
  display: { title: string } | null;
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

/** 最新 checkpoint 名单（D11-2 产物区数据源；training/ 下 checkpoint-N 目录按 N 降序取前 max 条。
 *  命名发现与 trainerHistoryLoss 同域单源（同一 readdir 形态），非第二套扫描器。 */
export const latestCheckpoints = (runDir: string, max = 5): string[] => {
  const ckpts: Array<{ name: string; n: number }> = [];
  try {
    for (const entry of readdirSync(join(runDir, "training"), { withFileTypes: true })) {
      const m = /^checkpoint-(\d+)$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) ckpts.push({ name: entry.name, n: Number(m[1]) });
    }
  } catch {
    return [];
  }
  ckpts.sort((a, b) => b.n - a.n);
  return ckpts.slice(0, max).map((c) => c.name);
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
/** 单 run 目录标记推导（任务卡 chat 卡面与同步器同源——trainingFace status 复用本出口）。 */
/** 批㊶-L L-1／D16 单源迁移：训练活跃新鲜窗口常量/解析迁 core trainObsSync.ts
 *  （源新鲜度门同源消费——core 不得反向依赖 extensions）；此处 re-export 兼容既有引用面。 */
export { TRAIN_ACTIVE_WINDOW_MS_DEFAULT, TRAIN_ACTIVE_WINDOW_MS_ENV, resolveTrainActiveWindowMs } from "../../../../src/core/workspace/trainObsSync.js";
import { resolveTrainActiveWindowMs, TRAIN_ACTIVE_WINDOW_MS_DEFAULT } from "../../../../src/core/workspace/trainObsSync.js";

/** 训练活跃注入面（调用方——同步器循环每周期探测一次 tmux，不逐 run）。 */
export interface ScanLiveness {
  /** tmux 训练会话在场（探测异常按 false——fail-closed 回落 mtime 窗口判据）。 */
  trainingTmuxPresent?: boolean;
  /** 批㊶-O O-1：绑 run 取证映射（run_id → 该 run 训练会话进程链含 run_id 的布尔）。
   *  在场时 training.active＝本 run 映射值；未命中回落 mtime 新鲜窗口单判据。
   *  （批㊶-N N-2 会族泛匹配 trainingTmuxFamilyPresent 自本批起不再参与 active 判定。） */
  trainingEvidence?: Record<string, boolean>;
  /** D28：tmux 取证探测可用性（命名域已设且枚举命令成功执行——probeTrainingEvidence）。
   *  true 且 trainingEvidence 本 run 无命中＝训练 tmux 退出 definitive 负证据——
   *  trainingActiveLive 立即翻 false（mtime/progress 过期缓存不再兜底）；false/缺席＝
   *  面缺席（探测异常/命名域未设），回落 mtime 窗口判据（既有 fail-closed 语义不动）。 */
  tmuxProbeUsable?: boolean;
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

/** D3/D4：trainer_log mtime 新鲜（步进写入活性——trainProbe 假死判据同源证据；
 *  stat 失败按不新鲜。内核直跑训练无 loss-series/progress（atf-ui 工具面产物），
 *  trainer_log 是其唯一在盘活性面）。D27：双拓扑经 trainerLogPathOf 单源发现。 */
const trainerLogFresh = (dir: string, liveness: ScanLiveness | undefined): boolean => {
  try {
    const windowMs = liveness?.freshWindowMs ?? TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
    const now = liveness?.nowMs ?? Date.now();
    const path = trainerLogPathOf(dir);
    if (path === null) return false;
    return now - statSync(path).mtimeMs <= windowMs;
  } catch {
    return false;
  }
};

/** D28：trainer_log 在场且 mtime 超窗（源停更 definitive 负证据——文件缺席/不可读＝false
 *  不猜，启动加载窗无此文件不触发）。活跃训练步进写入恒在窗内——「不误杀」由同门保证。
 *  D27：双拓扑经 trainerLogPathOf 单源发现。 */
const trainerLogOverWindow = (dir: string, liveness: ScanLiveness | undefined): boolean => {
  try {
    const windowMs = liveness?.freshWindowMs ?? TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
    const now = liveness?.nowMs ?? Date.now();
    const path = trainerLogPathOf(dir);
    if (path === null) return false;
    return now - statSync(path).mtimeMs > windowMs;
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

/** 训练活跃终判（批㊶-O O-1 修正；D28 判定序重排——definitive 证据优先，过期缓存不再兜底）：
 *  ① tmux 正证据（绑 run 会话进程链在场）＝活跃终判——checkpoint 长停顿/重启加载窗不误杀
 *  （进程活着即活跃；停更面由 D16 progress stale 表达，不在此翻面）；
 *  ② 探测可用（tmuxProbeUsable）且取证面明确无本 run 会话＝训练 tmux 退出 → 立即 false——
 *  loss-series/progress/trainer_log 的 mtime 新鲜是已过去的写历史（过期 liveness 缓存），
 *  不得再兜底出「结束 10 分钟内训练中」；
 *  ③ trainer_log 在场且 mtime 超窗 → 立即 false（源停更 definitive 负证据——活跃训练步进
 *  写入恒窗内；内核直跑无 tmux 面者靠同款窗口活判，超窗即翻面）；
 *  ④ 面缺席（探测异常/命名域未设/vitest 直扫）回落窗口判据——既有 fail-closed 语义不动。
 *  run_dir 保留签名兼容。A3：progress fresh 同为活跃信号（仅 ④ 路径参与）。 */
const trainingActiveLive = (dir: string, runId: string, liveness: ScanLiveness | undefined): boolean => {
  if (liveness?.trainingEvidence?.[runId] === true) return true;
  if (liveness?.tmuxProbeUsable === true && liveness.trainingEvidence !== undefined) return false;
  if (trainerLogOverWindow(dir, liveness)) return false;
  const progressActive = progressFresh(
    readProgress(dir),
    liveness?.nowMs ?? Date.now(),
    liveness?.freshWindowMs ?? resolveTrainActiveWindowMs(process.env),
  );
  return lossSeriesFresh(dir, liveness) || progressActive || trainerLogFresh(dir, liveness);
};

/** 单 run 目录扫描（root＋runId 双形态兼容：分桶调用方传 dirname(runDir) 作 root 或以
 *  workspace 段拼接——dir 单点推导于此）。workspace 为投影标注（批㊶Q增补三 段3 additive）。
 *  A2 案 a：workspaceSource 标注来源（bucket 缺省/registry 枚举），additive 返回。 */
export function scanRunDir(root: string, runId: string, liveness?: ScanLiveness, workspace: string | null = null, workspaceSource: "bucket" | "registry" = "bucket"): RunScan {
  const dir = workspace !== null ? join(root, workspace, runId) : join(root, runId);
  return scanRunDirAt(dir, runId, liveness, workspace, workspaceSource);
}

/** A2 案 a：绝对目录扫描变体（注册工作区实验树 run——runsRoot 之外，dir 由枚举面给定）。 */
export function scanRunDirAt(dir: string, runId: string, liveness?: ScanLiveness, workspace: string | null = null, workspaceSource: "bucket" | "registry" = "bucket"): RunScan {
  const has = (rel: string): boolean => existsSync(join(dir, rel));
  // 批㊶-M M-3＋D3/D4：段完成事实三源——①webui/segments.json（工具路径写）→
  // ②stage-<内核段>.summary.json exit 0（内核直跑落盘——run_id/stage 双对账，E10b 同款）
  // → ③启发式文件锚（降级兜底）。三源 OR；映射 SEGMENT_FACT_BY_KERNEL_STAGE 单源。
  const summaryFacts = stageSummarySegmentFacts(dir, runId);
  const segmentDone = (segment: string, heuristicFallback: boolean): boolean =>
    hasSegmentFact(dir, segment) || summaryFacts.has(segment) || heuristicFallback;
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
    // D50：completion.json（status ok）＝训练段确定性完成锚（与既有锚 OR——真完成事实
    // 落盘后段链即收口，不再依赖 tmux 缺席启发判 failed）
    training: trainingAnchorPresent(dir) || readTrainingCompletion(dir)?.status === "ok",
    evaluate: has("eval/metrics_summary.json") || evalRoundAnchored(dir),
  };
  // 事实轨并入证据图（M-3 契约「有记录的段直接 done」——experiment_config/publish 等段
  // 的 rawDone 表达式原本只读锚，事实在位而锚布局不符的历史 run 会丢证据）；D3/D4：段
  // 摘要兜底源同门并入（三源 OR）。training 段事实语义＝start 放行（非完成）、evaluate
  // 段事实＝编排启动（非完成），两段不入事实（摘要面同守——无内核段映射至两键）。
  for (const key of SEGMENT_ORDER_KEYS) {
    if (key === "training" || key === "evaluate") continue;
    if (hasSegmentFact(dir, key) || summaryFacts.has(key)) rawDone[key] = true;
  }
  // 批㊶-S3 S-B2 根因修复②（owner 裁定：段显示态必须保序——done 恒为前缀，后段完成蕴含
  // 前段发生；间隔完成/后成前未成是不合逻辑状态，不得显示）。证据图＝事实轨（segments.json
  // 工具执行成功记录）∥ 在盘锚；training/evaluate 收尾段完成锚（adapter/all_results/metrics
  // 轮产物——出现即事实，历史 run 重评形态由此不再冻结 0/8）。训练活跃期（本轮重跑）证据
  // 不入前缀——训练段回落边界显示 ●，evaluate 回落 pending。显示 done＝前缀闭包（末位证据
  // 截断）：历史 run 前段锚缺口由后段证据反蕴含补齐（登记→体检→…必然已发生），不再出现
  // ✓○✓○ 间隔态；「评估✓训练○」倒挂形态同时被前缀语义自然排除。
  // A3：progress 活跃信号（启动初帧 round=0 即 fresh——训练段 active/failed 判定共用）。
  // 读序提前（原 N-3 位读 progressRaw——现 hoist 至训练活跃判定前，单次读取双用）。
  const progressRaw = readProgress(dir);
  const nowMs = liveness?.nowMs ?? Date.now();
  const progressActiveNow = progressFresh(progressRaw, nowMs, liveness?.freshWindowMs ?? resolveTrainActiveWindowMs(process.env));
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
  // A3 训练段不悬空判定（A3.1 收紧）：「曾启动」证据闭集（三支 OR——train.sh 文件在场只
  // 证明已备料不证明曾启动，waiting_for_start/launch_ready 形态不得假 failed）：
  //   ① progressRaw !== null（曾写即曾启动，不受 fresh 限制）；② hasSegmentFact("training")
  //   （atf_run_training 启动放行写入——最硬）；③ training/trainer_state.json（真实训练副产物）。
  // 其余判据逐字不动：完成锚缺席 ∧ tmux 取证面已定义且本 run 无命中 ∧ 无活跃信号 → failed；
  // 取证面缺席（liveness 无 trainingEvidence——vitest 直扫等）＝信号源不在场，不猜（pending）。
  const trainingLaunchedEvidence =
    progressRaw !== null || hasSegmentFact(dir, "training") || has("training/trainer_state.json");
  const trainingFailedNow =
    // D50：completion status failed＝确定性失败（真退出码非 0／启动失败面落盘——先于
    // 一切启发）；completion ok＝确定性完成（不走 failed 启发）
    readTrainingCompletion(dir)?.status === "failed"
    || (readTrainingCompletion(dir) === null
      && trainingLaunchedEvidence && rawDone.training !== true &&
      liveness?.trainingEvidence !== undefined && liveness.trainingEvidence[runId] !== true &&
      !trainingActiveLive(dir, runId, liveness));  // 批㊶-N N-3：段内进度（progress.json 镜像＋fresh 布尔；过期/缺失置 null——additive）
  const progress: RunProgress | null = progressRaw !== null && progressFresh(progressRaw, nowMs, liveness?.freshWindowMs ?? resolveTrainActiveWindowMs(process.env))
    ? progressRaw
    : null;
  // 批㊶-N N-5：会话绑定集（binding.json append 轨镜像；可空）
  const boundSessions = readBindings(dir).map((binding) => binding.session_id);
  // 批㊶-P P-2：探针告警面（alerts.json 末条；同步器另行驱动判定与落盘）。
  // D33 排队横幅生命周期清零：gpu_queue 是过程性通知（排队等待计时），训练一旦有启动
  // 证据（progress 曾写/启动放行事实/trainer_state——A3 闭集），排队事实即被取代——呈现
  // 清零，不残留旧计时（alerts.json 落盘零动，历史账保留；排队进行中＝训练未启动，正常显示）。
  const probeAlerts = readAlerts(dir);
  const probeLast = probeAlerts.length > 0 ? probeAlerts[probeAlerts.length - 1]! : null;
  const probe = probeLast !== null && probeLast.kind === "gpu_queue" && trainingLaunchedEvidence ? null : probeLast;
  return {
    run_id: runId,
    // 批㊶Q增补三 段3：工作区归属标注（additive——分桶＝桶名，平铺/系统级＝null）
    workspace,
    // A2 案 a：标注来源（additive——bucket＝现形态缺省；registry＝注册表前缀/实验树枚举）
    workspace_source: workspaceSource,
    // D3/D4：状态面禁 unknown 静默——生命周期级联命中＝既有语义（config_confirmed/
    // launch_ready/candidate_built/registered）；全不中＝pending＋state_reason 单码
    // 白名单（no_on_disk_evidence——盘上无任何可识别生命周期证据，如实指因不猜）。
    state: has("webui/config-snapshot.json")
      ? "config_confirmed"
      : has("launch/train.sh")
        ? "launch_ready"
        : has("contract-candidate.json")
          ? "candidate_built"
          : has("registration.json") || has("dataset")
            ? "registered"
            : "pending",
    state_reason:
      has("webui/config-snapshot.json") || has("launch/train.sh") || has("contract-candidate.json") || has("registration.json") || has("dataset")
        ? null
        : "no_on_disk_evidence",
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
      candidate: has("contract-candidate.json") || summaryFacts.has("candidate"),
      publish: doneMap["publish"] === true,
      admission: doneMap["admission"] === true,
      // A3 训练段三态：done＝前缀闭包（S3 语义不动）；failed＝启动证据在场 ∧ 无完成锚 ∧
      // tmux 取证面在且本 run 无命中 ∧ 无活跃信号（progress 初帧 stale/loss-series stale——
      // 进程消失判据是确定性取证面，缺席不猜，显 pending）。active 态由 adapter 以
      // training.active 呈现（segmentStatus 训练段活跃优先——scanRunDir 不重复表达）。
      training: doneMap["training"] === true
        ? true
        : trainingFailedNow
          ? "failed"
          : false,
      evaluate: doneMap["evaluate"] === true,
    },
    training: {
      // 批㊶-L L-1＋批㊶-N N-2：终结判定——active＝训练产物锚在场（loss-series／
      // adapter_model.safetensors／all_results.json 三选一）&&（tmux 在场 || 会族前缀
      // atf-* 任一会话 || training-logs mtime 新鲜 || loss-series mtime 新鲜；窗口 env 可配）。
      // A3：启动初帧（progress fresh）同为锚等价——启动早期无 loss-series 也有确定性活跃。
      // D3/D4：trainer_log 在场且新鲜＝锚等价＋活跃证据（内核直跑训练的唯一在盘活性面）。
      active: (trainingAnchorPresent(dir) || progressActiveNow || trainerLogFresh(dir, liveness)) && trainingActiveLive(dir, runId, liveness),
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
    // D11-2：产物区 checkpoint 名单（additive——新→旧最多 5 条；缺席＝空数组）
    ckpts: latestCheckpoints(dir),
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
    // 批C1-1 D5：训练终态通知缺省空（跃迁状态机在 tickOnce——纯读面无上下文；同步器回填）
    train_notices: [],
    // 批B1：run 显示名（读盘面——用户改名 webui/display.json 优先，否则按产物自动名；
    // 读失败＝null 不造名，client 回退 run_id）
    display: (() => {
      try {
        return { title: displayOf(dir, runId, workspace) };
      } catch {
        return null;
      }
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
 * badcase viewer 产物发现（批㉛段1；批C2 E9 多形态）：analysis 目录三形态——
 * ①run 一级 analysis 前缀目录（批㉕B 两步链 analysis＋批㉙ 命名变体 analysis-b29）；
 * ②eval 前缀域直挂 analysis（uat awb_r1 实形）；③eval 前缀域内轮目录（N-日期）深挂
 * analysis（内核链产物真实形态；E9 台账更正：写者在深、读者在浅的四跳断链修复）。
 * `.bak` 备份目录不入列（历史备份不是现役产物，也不得经 URL 服务）；无 viewer 子目录
 * （含 viewer.html）的 analysis 自然落选。
 * 排序＝viewer.html mtime 新者在前（A 重评后重建的 viewer 即首选），mtime 同值按路径升序。
 */
export function discoverViewerDirs(runDir: string): string[] {
  const candidates: string[] = [];
  // ①一级 analysis*
  try {
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("analysis") && !entry.name.includes(".bak")) candidates.push(entry.name);
    }
  } catch {
    // runDir 缺席＝无浅层候选
  }
  // ②③eval* 域：直挂 analysis*＋轮目录 <N>-<日期>/analysis* 深挂
  try {
    for (const evalDir of readdirSync(runDir, { withFileTypes: true })) {
      if (!evalDir.isDirectory() || !evalDir.name.startsWith("eval") || evalDir.name.includes(".bak")) continue;
      const evalRel = evalDir.name;
      const evalAbs = join(runDir, evalRel);
      for (const entry of readdirSync(evalAbs, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("analysis") && !entry.name.includes(".bak")) candidates.push(`${evalRel}/${entry.name}`);
        if (entry.isDirectory() && /^\d+-\d{8}/.test(entry.name) && !entry.name.includes(".bak")) {
          const roundRel = `${evalRel}/${entry.name}`;
          try {
            for (const deep of readdirSync(join(runDir, roundRel), { withFileTypes: true })) {
              if (deep.isDirectory() && deep.name.startsWith("analysis") && !deep.name.includes(".bak")) candidates.push(`${roundRel}/${deep.name}`);
            }
          } catch {
            // 轮目录不可读＝该轮零候选
          }
        }
      }
    }
  } catch {
    // 无 eval* 域＝零深挂候选
  }
  const stamp = (rel: string): number => {
    try {
      return statSync(join(runDir, rel, "viewer", "viewer.html")).mtimeMs;
    } catch {
      return -1;
    }
  };
  return candidates
    .filter((rel) => stamp(rel) >= 0)
    .sort((a, b) => (stamp(b) - stamp(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

/** 批㊶-M2 段 2：run 特征判定（防御性——目录含特征之一才收录为 run）。
 *  特征集＝launch_manifest.json／prep/／training/／webui/／eval/（防 atf-ui/default 等混入）。 */
// 批㊶-S2：RUN_MARKER_RELS 单源迁至 runLayout（readOnlyTools 共用）——此处 re-export 保持锚路径
export { RUN_MARKER_RELS };

export const looksLikeRun = (dir: string): boolean =>
  RUN_MARKER_RELS.some((rel) => existsSync(join(dir, rel)));

/** 合格 run 子目录判据（H2.1 rev2 owner 裁决收紧——桶判定**单源**谓词）。
 *  子目录满足任一即合格：
 *  ①含 run.json（有效 run 身份）；②含 webui/segments.json（段事实身份锚）；
 *  ③含 stage-register.summary.json（段模式身份锚）；④命中 ≥2 个不同的 RUN_MARKER_RELS 条目。
 *  显式排除：子目录顶层**孤立的 launch_manifest.json 单命中不合格**——该文件正是父 run
 *  标记 launch/launch_manifest.json 落在子目录内的形态（cr_r2/launch 假阳性根源；真机
 *  run-regress-formal-01/launch 同形态），单命中过不了 ≥2 门。
 *  按标记结构收紧，非目录名特判（无任何 if name===...）；对 H21 指令「含有效/legacy
 *  run 子目录」的结构化解释——真 run 子目录恒有身份锚或 run.json，多标记形态由 ≥2 门兜住
 *  （atf-prodtest-20261021 子 run prep+training+webui+eval ≥4 命中；H21 夹具 run-x 走锚 ②）。 */
export const isQualifyingRunChild = (child: string): boolean => {
  if (existsSync(join(child, "run.json"))) return true;
  if (existsSync(join(child, "webui", "segments.json"))) return true;
  if (existsSync(join(child, "stage-register.summary.json"))) return true;
  return RUN_MARKER_RELS.filter((rel) => existsSync(join(child, rel))).length >= 2;
};

/** H2.1 rev2（D37）——桶容器判定：目录含任一**合格 run 子目录**＝桶
 *  （owner 裁决：本函数与四向分类规则 2 必须共用 isQualifyingRunChild 单源——禁两套）。
 *  桶优先：runs/<工作区桶>/prep 污染形态（容器根被测试侧 prep/variants 命中标记，其下
 *  是真 run 子目录）不得当平铺 run 收录。异常 fail-closed 返回 false（不可读＝不判桶，
 *  调用方既有 looksLikeRun 通道自决）。 */
export const hasRunChildDirs = (dir: string): boolean => {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (e) => e.isDirectory() && !e.name.startsWith(".") && isQualifyingRunChild(join(dir, e.name)),
    );
  } catch {
    return false;
  }
};

// ── H2.1 rev2 预检——runs 根一级条目四类身份分类（RunLayout/v1 枚举规则 2.3）────
// 判定序（不按目录名特判——prep 只是 RUN_MARKER_RELS 的一个实例，禁 `if name==="prep"`）：
//   ①有 run.json 且校验通过 → valid_run；②无（有效）run.json 但含**合格 run 子目录**
//   （isQualifyingRunChild——身份锚或 ≥2 标记，孤立 launch_manifest.json 不合格）→ bucket；
//   ③无 run.json、无合格 run 子目录、有 legacy 标记（RUN_MARKER_RELS）→ legacy_run
//   （只读兼容）；④其余 → unregistered_entry（告警并隔离，不进 run 列表）。
// 校验＝最小实现：run.json 可解析为对象即过（workspace_id/run_id 等身份字段缺席不拒——
// 内核 RunLayout/v1 尚未发版，本面为休眠面，不发明第二套 schema）。

/** runs 根一级条目四类身份。 */
export type RunRootEntryKind = "valid_run" | "bucket" | "legacy_run" | "unregistered_entry";

export interface RunRootEntryClassification {
  name: string;
  dir: string;
  kind: RunRootEntryKind;
  /** valid run 且存在 run.json.dirs 清单外顶层目录 → true（隔离，不进列表）。 */
  artifactOutsideLayout: boolean;
  /** 隔离/异常原因（隔离条目非空——随告警行携出；正常条目 null）。 */
  reason: string | null;
}

/** run.json 最小校验：可解析为普通对象即返回之；缺席/损坏/非对象 → null（不抛）。 */
const readRunManifestObject = (dir: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** run.json.dirs 清单违规（顶层**目录**不在声明集——顶层文件不查：stage 摘要/契约候选等
 *  顶层文件是现役合法形态且 dirs schema 未发版，字面全查会误隔离现役 run）。 */
const layoutViolationsOf = (dir: string, manifest: Record<string, unknown>): string[] => {
  const dirs = manifest["dirs"];
  if (!Array.isArray(dirs)) return [];
  const declared = new Set(dirs.filter((d): d is string => typeof d === "string"));
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !declared.has(e.name))
      .map((e) => e.name);
  } catch {
    return []; // 不可读＝无法证明违规，不猜
  }
};

/** 单条目四类分类（纯函数零副作用——告警由枚举接线面输出）。 */
export const classifyRunRootEntry = (dir: string, name: string): RunRootEntryClassification => {
  const manifest = readRunManifestObject(dir);
  if (manifest !== null) {
    const violations = layoutViolationsOf(dir, manifest);
    return {
      name,
      dir,
      kind: "valid_run",
      artifactOutsideLayout: violations.length > 0,
      reason: violations.length > 0 ? `artifact_outside_layout: ${violations.join(",")}` : null,
    };
  }
  if (hasRunChildDirs(dir)) {
    return { name, dir, kind: "bucket", artifactOutsideLayout: false, reason: null };
  }
  if (looksLikeRun(dir)) {
    return { name, dir, kind: "legacy_run", artifactOutsideLayout: false, reason: null };
  }
  return {
    name,
    dir,
    kind: "unregistered_entry",
    artifactOutsideLayout: false,
    reason: "no run.json / no run-shaped child dir / no legacy marker",
  };
};

/** runs 根一级条目全量分类（OUT_DIR＝harness 自有输出面豁免——非 run 身份判据）。
 *  异常 fail-open：根不可读＝空清单（枚举面既有语义不变）。 */
export const classifyRunRootEntries = (runsRoot: string): RunRootEntryClassification[] =>
  flatRunDirNames(runsRoot)
    .filter((name) => name !== OUT_DIR)
    .map((name) => classifyRunRootEntry(join(runsRoot, name), name));

/** A2 案 a：注册工作区枚举输入（registry records 的只读投影——path/title 两键；
 *  调用方自 listRegistryRecords(resolveDshHome()) 过滤 exists===true 后映射）。
 *  D3/D4：sessionIds 可选键——平铺 run 的 binding.json 反查归属输入。 */
export interface RegistryWorkspaceSeed {
  path: string;
  title: string;
  /** 该工作区会话集（records[].sessionIds 直通；缺席＝调用方不供反查面）。 */
  sessionIds?: readonly string[];
}

/** 注册工作区根的 realpath（目录缺失/权限失败/非目录＝null——fail-open 静默跳过，不报错弹条）。 */
const registryWorkspaceRealRoot = (ws: RegistryWorkspaceSeed): string | null => {
  try {
    if (!statSync(ws.path).isDirectory()) return null;
    return realpathSync(ws.path);
  } catch {
    return null;
  }
};

/** 注册工作区 run 目录清单（H2.1 rev2 D38——三档候选根、按优先级）：
 *  ①<root>/workspace/runs（当前内核布局＝canonical）②<root>/runs（旧布局，只读兼容）
 *  ③<root>/experiments/<x>/runs（历史实验树）。各根直接子目录收录候选（looksLikeRun
 *  过滤归枚举调用方）；同一目录不跨档重复收录（path 去重——symlink 别名形态由下游
 *  claim 的 realpath 键兜底）；一级缺席/异常＝该档空，不阻断后续档。 */
const registryExperimentRunDirs = (wsReal: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushRoot = (root: string): void => {
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(root, name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  };
  pushRoot(join(wsReal, "workspace", "runs")); // ①canonical
  pushRoot(join(wsReal, "runs")); // ②旧布局
  let experiments: string[];
  try {
    experiments = readdirSync(join(wsReal, "experiments"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const experiment of experiments) pushRoot(join(wsReal, "experiments", experiment, "runs")); // ③历史实验树
  return out;
};

/** A2 案 a：run 条目枚举单源（runsRoot 平铺＋分桶 ∪ 注册工作区 run 根）。
 *  H2.1 rev2（D38）枚举序翻转——registry 三档候选根（<ws>/workspace/runs canonical ＞
 *  <ws>/runs 旧布局 ＞ <ws>/experiments/<x>/runs 历史实验树）**先登记**，flat/bucket 后到。
 *  去重双键：realpath（同 inode 只出一次）＋claimKey `${workspace}\u0000${runId}`
 *  （(workspace,runId) 身份去重——registry/canonical 先 claim，flat/bucket 同键后到跳过；
 *  两棵树同 runId 只留 canonical，不合并不复制）。runs 根一级条目先过四类预检分类
 *  （classifyRunRootEntries——valid/legacy 照常进枚举面；bucket 只作容器不进 flat，
 *  其子 run 由分桶通道收录＝D37 桶优先；unregistered_entry 与 artifact_outside_layout
 *  隔离不进列表，结构化告警一行）。只读：零写入零建目录；目录缺失/权限失败静默跳过
 *  （fail-open）。平铺 run 的注册表前缀归属沿用：registry 记录 path 为 run 目录祖先
 *  即标该记录 title（workspace_source=registry）；分桶条目标签＝桶目录名，不受前缀改写。 */
export interface RunDirEntry {
  runId: string;
  dir: string;
  workspace: string | null;
  workspaceSource: "bucket" | "registry";
}

export const enumerateRunEntries = (runsRoot: string, registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>): RunDirEntry[] => {
  const entries: RunDirEntry[] = [];
  const seenReal = new Set<string>();
  const claimedKeys = new Set<string>();
  // 双键占位（rev2）：realpath（同 inode）与 claimKey（(workspace,runId) 身份）任一已占＝跳过；
  // 两键同过才占位（部分占位不落——避免 symlink 镜像与同名 run 交错时半占死锁）。
  const claim = (dir: string, key: string): boolean => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return false;
    }
    if (seenReal.has(real) || claimedKeys.has(key)) return false;
    seenReal.add(real);
    claimedKeys.add(key);
    return true;
  };
  // ①registry 三档候选根（canonical 优先——先登记先占键）
  for (const ws of registryWorkspaces ?? []) {
    const wsReal = registryWorkspaceRealRoot(ws);
    if (wsReal === null) continue;
    for (const dir of registryExperimentRunDirs(wsReal)) {
      if (!looksLikeRun(dir)) continue;
      const runId = basename(dir);
      if (!claim(dir, `${ws.title}\u0000${runId}`)) continue;
      entries.push({ runId, dir, workspace: ws.title, workspaceSource: "registry" });
    }
  }
  // ②runs 根平铺层——四类预检分类接线
  const classifications = classifyRunRootEntries(runsRoot);
  for (const c of classifications) {
    if (c.kind === "unregistered_entry" || c.artifactOutsideLayout) {
      console.warn(`[atf-ui] runs-root entry quarantined ${JSON.stringify({ path: c.dir, kind: c.kind, reason: c.reason })}`);
    }
  }
  const flatRuns = new Set(
    classifications
      .filter((c) => (c.kind === "valid_run" || c.kind === "legacy_run") && !c.artifactOutsideLayout)
      .map((c) => c.name),
  );
  for (const name of flatRuns) {
    const dir = join(runsRoot, name);
    // 注册表前缀归属（平铺存量——records[].path 为 run 目录祖先即归属，标注＝记录 title）
    const wsHit = (registryWorkspaces ?? []).find((ws) => {
      const wsReal = registryWorkspaceRealRoot(ws);
      if (wsReal === null) return false;
      try {
        const real = realpathSync(dir);
        return real === wsReal || real.startsWith(wsReal + sep);
      } catch {
        return false;
      }
    });
    // D3/D4：前缀未命中 → binding.json 反查（注册表工作区 sessionIds ∩ run 绑定会话——
    //  会话是工作区成员，run 由该会话操作即归属该工作区；都无 → null（渲染侧同树可见，
    //  不依赖 bound_sessions）。首个命中记录定归属（注册表序确定——不猜多数派）。
    let workspace: string | null = wsHit?.title ?? null;
    let workspaceSource: "bucket" | "registry" = wsHit !== undefined ? "registry" : "bucket";
    if (workspace === null) {
      const boundSessions = readBindings(dir).map((binding) => binding.session_id);
      if (boundSessions.length > 0) {
        const bySession = (registryWorkspaces ?? []).find((ws) =>
          (ws.sessionIds ?? []).some((id) => boundSessions.includes(id)),
        );
        if (bySession !== undefined) {
          workspace = bySession.title;
          workspaceSource = "registry";
        }
      }
    }
    if (!claim(dir, `${workspace ?? ""}\u0000${name}`)) continue;
    entries.push({ runId: name, dir, workspace, workspaceSource });
  }
  // ③分桶层（D37 桶优先：容器含 run 子目录不再进 flatRuns——其子 run 由本通道正常收录）
  for (const entry of bucketedRunEntries(runsRoot)) {
    if (flatRuns.has(entry.workspace) || entry.workspace === OUT_DIR || entry.runId === OUT_DIR) continue;
    if (!looksLikeRun(entry.dir)) continue;
    if (!claim(entry.dir, `${entry.workspace}\u0000${entry.runId}`)) continue;
    entries.push({ runId: entry.runId, dir: entry.dir, workspace: entry.workspace, workspaceSource: "bucket" });
  }
  return entries;
};

/** H5（atf_joint_train）：run_id → 枚举条目单源解析——enumerateRunEntries 同源消费
 *  （registry/canonical 先占、flat/bucket 后到的全部语义零复制；工具面禁自建第二套
 *  路径表）。找不到＝null（调用方结构化报缺，不猜不平铺拼接）。 */
export const resolveRunEntry = (runsRoot: string, runId: string, registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>): RunDirEntry | null =>
  enumerateRunEntries(runsRoot, registryWorkspaces).find((entry) => entry.runId === runId) ?? null;

/** 同步器周期内 run_id 清单（目录枚举一次——取证映射的目标集；特征过滤后。
 *  批㊶Q增补三 段3：平铺＋分桶双形态并集，run_id 恒为裸名；平铺 run 自身子目录
 *  不作桶降层（launch/eval 等内部结构不产幻影 run——真机 24 条污染实证后修正）。
 *  A2 案 a：注册工作区 run 根（rev2 三档候选根）run id 一并进取证映射键集（tmux cmdline 取证按 runId 命中）。 */
const resolvedRunIds = (runsRoot: string, registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>): string[] =>
  enumerateRunEntries(runsRoot, registryWorkspaces).map((entry) => entry.runId);

/** 批㊶Q增补三 段3：runsRoot 双层扫描（平铺存量原地保留＋分桶新形态并存——向后兼容）。
 *  桶降层只对非 run 的一级目录进行（平铺 run 的 launch/eval/l1 等子目录是 run 内部
 *  结构不是工作区桶——否则幻影 run 污染全量视图）。
 *  A2 案 a：扫描面＝runsRoot（现形态不变）∪ 注册工作区 run 根（records[].path＋
 *  三档候选根——exists===true 记录、只读、realpath＋claimKey 双键去重 canonical 优先、标注＝title）。
 *  H2.1 rev2 裁决落地：桶判定收紧为「含合格 run 子目录」（isQualifyingRunChild——身份锚
 *  或 ≥2 标记，孤立 launch_manifest.json 不合格）——平铺 run 的 launch/publish-ws-xxx
 *  与 l1 等内部子目录不再使宿主被桶化（真机 24 条幻影污染防回潮锚保持；dev 存量
 *  run-regress-formal 系等 10 run 保持 legacy 可见），atf-prodtest-20261021 污染容器
 *  仍按桶优先出子 run。
 *  @param entries - 预算好的枚举（同步器单次枚举复用——runs[i] 与 entries[i] 一一对应，
 *  供调用方按序取 run 真实目录；缺省自行枚举）。 */
/** 导出供 vitest 直测（真机 24 条幻影污染实证后的防回潮锚）。 */
export function scanRuns(runsRoot: string, liveness?: ScanLiveness, registryWorkspaces?: ReadonlyArray<RegistryWorkspaceSeed>, entries?: ReadonlyArray<RunDirEntry>): RunScan[] {
  const root = join(runsRoot);
  if (!existsSync(root)) return [];
  const list = entries ?? enumerateRunEntries(runsRoot, registryWorkspaces);
  // 全部走绝对目录变体（entry.dir 与 scanRunDir 的 root 拼接逐字同源——runsRoot 内外同路）
  return list.map((entry) => scanRunDirAt(entry.dir, entry.runId, liveness, entry.workspace, entry.workspaceSource));
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
    // D28：取证改走 probeTrainingEvidence 批量单源（判据同源）并取探测可用性——
    // usable=true 且本 run 无命中＝训练 tmux 退出 definitive 负证据（trainingActiveLive
    // 立即翻面）；usable=false（命名域未设/枚举异常）＝面缺席，回落 mtime 窗口判据。
    // A2 案 a：注册工作区清单（每周期一次——exists===true 记录；实验树枚举＋run 真实
    // 目录取用的单源；目录缺失/权限失败由枚举面静默跳过）。注册表是内存权威（写侧实例
    // 重启进视野）——本处只读消费，零写入。
    const registryWorkspaces = listRegistryRecords(resolveDshHome())
      .filter((record) => record.exists)
      .map((record) => ({ path: record.path, title: record.title, sessionIds: record.sessionIds }));
    const runEntries = enumerateRunEntries(resolved.runsRoot, registryWorkspaces);
    const evidenceProbe = probeTrainingEvidence(runEntries.map((entry) => entry.runId));
    const runs = scanRuns(resolved.runsRoot, {
      trainingTmuxPresent,
      trainingEvidence: evidenceProbe.evidence,
      tmuxProbeUsable: evidenceProbe.usable,
      trainingLogsFresh: trainingLogsFreshAt(resolved.runsRoot, resolveTrainActiveWindowMs(process.env)),
      freshWindowMs: resolveTrainActiveWindowMs(process.env),
    }, registryWorkspaces, runEntries);
    // D50：完成锚同步写者（exit.code 尾声件在场＝train.sh 已退出——真退出码权威）：
    // completion.json 缺席（或重训新尝试收尾）即组装落盘（首写者胜/重训覆写在写方单源）。
    // 先于通知轨/段链观测执行——同周期内完成锚即可见（training done → training_done 通知
    // 与 UI 段链绿同拍落地）。fail-open：写失败下一周期重试。
    for (const entry of runEntries) {
      const completion = completionFromExitCodeFile(entry.dir);
      if (completion !== null) writeTrainingCompletion(entry.dir, completion);
    }
    // 批C1-1 D5：训练终态跃迁通知（持久 last-state 状态机——活跃/未启动→done/failed 一跳产
    // additive train_notices；首见即终态/终态间互跳不产，重启不重报）。状态文件与 monitor.json
    // 同目录同单写者；monitor 携带 per-run 近期通知账（client 已读集＋24h 窗去重渲染）。
    try {
      const statePath = join(outDir, TRAIN_NOTICE_STATE_FILENAME);
      const prior = readTrainNoticeState(statePath);
      const tickAt = new Date().toISOString();
      const applied = applyTrainNoticeTransitions(
        prior.states,
        runs.map((run) => ({ run_id: run.run_id, state: trainObservedStateOf(run) })),
        tickAt,
      );
      const nextNotices: Record<string, TrainTerminalNoticeFace[]> = { ...prior.notices };
      for (const notice of applied.notices) {
        const list = [...(nextNotices[notice.run_id] ?? []), notice];
        nextNotices[notice.run_id] = list.slice(-8);
      }
      for (const run of runs) {
        run.train_notices = nextNotices[run.run_id] ?? [];
      }
      writeTrainNoticeState(statePath, { states: applied.next, notices: nextNotices });
    } catch (cause) {
      console.error("[atf-ui] 训练终态通知轨异常（下周期重试）:", cause instanceof Error ? cause.message : String(cause));
    }
    // 批C1-1 D6：评估服务健康（复用内核 eval_service_probe 只读探测——端口取 run 的
    // eval/services.jsonl 末行；缺账/无内核目录/探测失败＝null 不造假）。仅 eval_progress
    // 在场的 run 探测（有评估账才有健康面）；停服务后下一周期即 false（interval 5s ≪ 一轮）。
    const kernelDirForHealth = resolveInstanceKernelDir(process.env, repoRoot);
    for (let runIdx = 0; runIdx < runs.length; runIdx += 1) {
      const run = runs[runIdx]!;
      if (run.eval_progress === null) continue;
      const runDir = runEntries[runIdx]?.dir
        ?? (run.workspace !== null ? join(resolved.runsRoot, run.workspace, run.run_id) : join(resolved.runsRoot, run.run_id));
      const health: EvalServiceHealthFace | null = await probeEvalServiceHealth({ runDir, kernelDir: kernelDirForHealth });
      run.eval_progress = { ...run.eval_progress, health };
    }
    // 批㊶Q增补三 段4.2：pending-confirm 存量清理扫描（确认/放行完成即删，含存量——
    // 完成证据判据 fail-open；等待中的卡不动。cr_r2 09:36 确认后残留 8h＋实证）
    try {
      sweepAnsweredPendings(resolved.runsRoot);
    } catch { /* 清理扫描异常不阻断同步器 */ }
    // 批㊶-P P-2：训练探针（per-run——active run 才判定；告警落 alerts.json＋monitor probe 面见 snapshot 组装）
    try {
      for (let runIdx = 0; runIdx < runs.length; runIdx += 1) {
        const run = runs[runIdx]!;
        if (!run.training.active) continue;
        // 批㊶Q增补三 段3：run 实际目录（runs[i]↔entries[i] 一一对应——注册实验树 run
        // 取枚举面真实目录，禁从 runsRoot 拼接第二套路径）
        const runDir = runEntries[runIdx]?.dir
          ?? (run.workspace !== null ? join(resolved.runsRoot, run.workspace, run.run_id) : join(resolved.runsRoot, run.run_id));
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
        // D27：双拓扑经 trainerLogPathOf 单源发现
        let trainerLogMtimeMs: number | null = null;
        try {
          const trainerLogPath = trainerLogPathOf(runDir);
          if (trainerLogPath !== null) trainerLogMtimeMs = statSync(trainerLogPath).mtimeMs;
        } catch { /* 不可读＝null（判据按无此证据处理） */ }
        const alert = probeAndRecord(runDir, {
          trainingActive: true,
          tmuxEvidence: evidenceProbe.evidence[run.run_id] === true,
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
    // D11-2：进程归属一次采集全卡共用（复用钉——readOnlyTools.parseComputeAppsWithIndex
    // 唯一解析面，本调用方只做归约 gpuProcTopByIndex；禁止每卡一次 shell）。
    const computeApps = await queryGpuComputeApps();
    const procTopMap = gpuProcTopByIndex(Array.isArray(computeApps) ? computeApps : []);
    // D11-2：GPU 历史随同一同步拍追加（写失败不阻断——appendGpuHistory 自吞错节流 stderr）
    const historyRow = buildGpuHistoryRow(new Date(), gpuAll ?? [], procTopMap);
    if (historyRow !== null) appendGpuHistory(resolved.runsRoot, historyRow);
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

// ── D11-2：GPU 历史面（每同步拍追加一行 jsonl；按天文件即轮转；每天首写清理 7 天前）─────

/** 历史行逐卡条目（键闭集——gpu-history jsonl 唯一形态；util 百分数、显存 MiB 数值，缺 → null）。 */
export interface GpuHistoryCard {
  index: number;
  util: number | null;
  memUsed: number | null;
  memTotal: number | null;
  temp: number | null;
  power: number | null;
  procTop: { pid: string; name: string; memMiB: number } | null;
}
export interface GpuHistoryRow {
  ts: string;
  gpus: GpuHistoryCard[];
}

/** 按天文件名（gpu-history-YYYYMMDD.jsonl——文件名即轮转）。 */
export const gpuHistoryFileName = (d: Date): string => {
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `gpu-history-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.jsonl`;
};

/** gpu_all 字符串字段数值化（"82%"/"48MiB" → 82/48；坏值 → null 不猜）。 */
const gpuNumericField = (raw: string): number | null => {
  const n = Number(raw.replace(/%\s*$|MiB\s*$/i, "").trim());
  return Number.isFinite(n) ? n : null;
};

/** 历史行构造（纯函数）：gpu_all（D11-2 扩展后含 temp/power）＋procTop 归约 → 一行。
 *  gpu_all 缺席/空（采集不可用）→ null——不写空拍（缺失时段如实断流，不造平线）。 */
export const buildGpuHistoryRow = (
  now: Date,
  gpuAll: ReadonlyArray<{ index: string; utilization: string; memoryUsed: string; memoryTotal: string; temperature?: number | null; powerDraw?: number | null }>,
  procTop: ReadonlyMap<string, { pid: string; name: string; memMiB: number }>,
): GpuHistoryRow | null => {
  if (!Array.isArray(gpuAll) || gpuAll.length === 0) return null;
  return {
    ts: now.toISOString(),
    gpus: gpuAll.map((c) => ({
      index: Number(c.index),
      util: gpuNumericField(c.utilization),
      memUsed: gpuNumericField(c.memoryUsed),
      memTotal: gpuNumericField(c.memoryTotal),
      temp: typeof c.temperature === "number" ? c.temperature : null,
      power: typeof c.powerDraw === "number" ? c.powerDraw : null,
      procTop: procTop.get(String(c.index)) ?? null,
    })),
  };
};

const GPU_HISTORY_KEEP_DAYS = 7;

/** 清理 7 天前的历史文件（每天首次写入时调用；unlink 失败逐个忽略）。返回删除数。 */
export const cleanupOldGpuHistory = (runsRoot: string, now = new Date(), keepDays = GPU_HISTORY_KEEP_DAYS): number => {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(runsRoot, "atf-ui")).filter((f) => /^gpu-history-\d{8}\.jsonl$/.test(f));
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - keepDays * 86_400_000;
  let removed = 0;
  for (const f of entries) {
    const m = /^gpu-history-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(f);
    if (m === null) continue;
    const dayTs = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (dayTs < cutoff) {
      try {
        unlinkSync(join(runsRoot, "atf-ui", f));
        removed += 1;
      } catch {
        /* 单文件删除失败忽略（下一天再试） */
      }
    }
  }
  return removed;
};

let gpuHistoryCleanupDay = "";
let gpuHistoryLastStderrAt = 0;

/** 追加一行（appendFileSync；任何失败不抛不阻断同步器——stderr 节流 60s）。 */
export const appendGpuHistory = (runsRoot: string, row: GpuHistoryRow): void => {
  try {
    const dir = join(runsRoot, "atf-ui");
    mkdirSync(dir, { recursive: true });
    const today = gpuHistoryFileName(new Date());
    if (gpuHistoryCleanupDay !== today) {
      gpuHistoryCleanupDay = today;
      cleanupOldGpuHistory(runsRoot);
    }
    appendFileSync(join(dir, today), `${JSON.stringify(row)}\n`, "utf8");
  } catch (cause) {
    const at = Date.now();
    if (at - gpuHistoryLastStderrAt > 60_000) {
      gpuHistoryLastStderrAt = at;
      console.error("[atf-ui] GPU 历史写入失败（不阻断同步器）:", cause instanceof Error ? cause.message : String(cause));
    }
  }
};

/** 读单天历史（尾部最多 2000 行；文件缺失/坏行跳过——不造点不抛）。 */
export const readGpuHistoryDay = (runsRoot: string, day: Date, tail = 2000): GpuHistoryRow[] => {
  let text = "";
  try {
    text = readFileSync(join(runsRoot, "atf-ui", gpuHistoryFileName(day)), "utf8");
  } catch {
    return [];
  }
  const rows: GpuHistoryRow[] = [];
  for (const line of text.split("\n").slice(-tail)) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (row !== null && typeof row === "object" && typeof (row as GpuHistoryRow).ts === "string" && Array.isArray((row as GpuHistoryRow).gpus)) {
        rows.push(row as GpuHistoryRow);
      }
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows;
};

/** 等间隔降采样（纯函数）：≤maxPoints 原样；超限抽 maxPoints 点、首末点恒在。 */
export const downsamplePoints = <T>(points: T[], maxPoints: number): T[] => {
  if (points.length <= maxPoints) return points;
  const last = points.length - 1;
  const out: T[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    out.push(points[Math.floor((i * last) / (maxPoints - 1))!]!);
  }
  out.push(points[last]!);
  return out;
};

/** 窗口过滤＋降采样（纯函数）：取 [now-minutes, now] 尾窗、按 ts 升序、降采样 ≤maxPoints。 */
export const windowDownsampleGpuHistory = (rows: GpuHistoryRow[], now: Date, minutes: number, maxPoints: number): GpuHistoryRow[] => {
  const cutoff = now.getTime() - minutes * 60_000;
  const inWindow = rows
    .filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoff && t <= now.getTime() + 60_000;
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return downsamplePoints(inWindow, maxPoints);
};

/** 读今天＋（跨零点）昨天的历史并取窗（路由数据面——文件缺失/全坏 → 空数组由调用方 200）。 */
export const readGpuHistoryWindow = (runsRoot: string, now: Date, minutes: number, maxPoints: number): GpuHistoryRow[] => {
  const yesterday = new Date(now.getTime() - 86_400_000);
  const rows = [...readGpuHistoryDay(runsRoot, yesterday), ...readGpuHistoryDay(runsRoot, now)];
  return windowDownsampleGpuHistory(rows, now, minutes, maxPoints);
};

/** gpu-history 查询串解析（纯函数）：minutes 必为 1–60 整数（缺省 5）；maxPoints 缺省 60（1–2000）。
 *  非法 → null（路由 400）。 */
export const parseGpuHistoryQuery = (url: string): { minutes: number; maxPoints: number } | null => {
  let q: URLSearchParams;
  try {
    q = new URL(url, "http://localhost").searchParams;
  } catch {
    return null;
  }
  const minutes = Number(q.get("minutes") ?? "5");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) return null;
  const rawMax = q.get("maxPoints");
  let maxPoints = 60;
  if (rawMax !== null && rawMax !== "") {
    maxPoints = Number(rawMax);
    if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 2000) return null;
  }
  return { minutes, maxPoints };
};

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

/** run-file 相对路径校验（D11-2 纯函数）：禁 `..`（任意位置）、禁绝对/反斜杠路径、逐段 SEG_RE、
 *  末段扩展名白名单（json/jsonl/md/txt/csv/log/yaml/yml/html；`.env` 类点开头文件＝无扩展名拒）。
 *  合法 → 归一化 rel（去空段）；非法 → null（路由一律 404，不回显绝对路径）。 */
export const RUN_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["json", "jsonl", "md", "txt", "csv", "log", "yaml", "yml", "html"]);
export const sanitizeRunFileRel = (rel: string): string | null => {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("..")) return null;
  const parts = rel.split("/").filter((p) => p !== "");
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (!SEG_RE.test(p)) return null;
  }
  const base = parts[parts.length - 1]!;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return RUN_FILE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) ? parts.join("/") : null;
};

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
  // 批C2 E9：viewers 条目＝analysis 目录相对路径（单段 `analysis*` 或多段
  // `eval*/[<N>-<日期>/]analysis*`）——按 parts 前缀最长匹配定位；未显式命中回落首条（缺省打开）
  let analysis: string | null = null;
  let sub: string[] = [];
  const maxTake = Math.min(parts.length - 1, 4);
  for (let take = maxTake; take >= 1; take -= 1) {
    const candidate = parts.slice(1, 1 + take).join("/");
    if (viewers.includes(candidate)) {
      analysis = candidate;
      sub = parts.slice(1 + take);
      break;
    }
  }
  if (analysis === null) {
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

// ===== 批B1：会话↔Run 绑定端点（GET/POST /atf-ui/session-binding——鉴权同 settings）=====

/** GET 响应体形态（binding/active/unbound_reason/recent/candidates——指令 B1 §三）。 */
export interface SessionBindingPayload {
  binding: SessionRunBindingRecord | null;
  active: { run_id: string; workspace: string | null; title: string } | null;
  unbound_reason: UnboundReason | "new" | null;
  /** runsRoot 按 mtime 倒序前 3（空白会话空态——不带工作区偏好）。 */
  recent: ReturnType<typeof buildRunCandidates>;
  /** 本工作区优先、mtime 倒序、≤5。 */
  candidates: ReturnType<typeof buildRunCandidates>;
}

/** GET 载荷组装（纯函数——vitest 直测；stale 不改账本：active:null＋reason:stale，持久化留给用户）。 */
export const sessionBindingPayloadOf = (home: string, runsRoot: string, sessionId: string): SessionBindingPayload => {
  const record = readSessionBinding(home, sessionId);
  const preferWorkspace = record?.workspace ?? null;
  let active: SessionBindingPayload["active"] = null;
  let unboundReason: SessionBindingPayload["unbound_reason"] = null;
  if (record === null) {
    unboundReason = "new";
  } else if (record.active_run_id === null || record.active_run_id === "") {
    unboundReason = record.unbound_reason;
  } else {
    const resolution = resolveActiveRun(home, runsRoot, sessionId);
    if (resolution.run !== null && resolution.runId !== null) {
      active = {
        run_id: resolution.runId,
        workspace: resolution.workspace,
        title: displayOf(resolution.run, resolution.runId, resolution.workspace),
      };
    } else {
      unboundReason = "stale";
    }
  }
  return {
    binding: record,
    active,
    unbound_reason: unboundReason,
    recent: buildRunCandidates(runsRoot, null, 3),
    candidates: buildRunCandidates(runsRoot, preferWorkspace, 5),
  };
};

/** 会话绑定端点 handler 工厂（viewerRouteHandler/eventsRouteHandler 同款形态——apply 注册，
 *  home/runsRoot 注入 vitest 直测）。GET ?sessionId=… 查询；GET 缺 sessionId＝草稿态载荷
 *  （B2c——机器级最近实验，只读）；POST {sessionId, runId|null, rename?}。
 *  错误码：run 不存在 404；title 非空且 ≤80 字否则 400。响应 JSON＋no-store。 */
export const sessionBindingRouteHandler = (deps: {
  home: string;
  runsRoot: string;
  reject?: (req: IncomingMessage) => 401 | 403 | undefined;
}) =>
(req: IncomingMessage, res: ServerResponse): void => {
  const respondJson = (status: number, payload: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
  };
  const rejection = deps.reject?.(req);
  if (rejection !== undefined) {
    res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required\n");
    return;
  }
  if (req.method === "GET") {
    const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId") ?? "";
    if (sessionId.trim() === "") {
      // B2c 草稿态（新会话未发首条消息、无 sessionId）：返回机器级最近实验（只读查询，
      // 「回到上次实验」卡数据源）。既有带 sessionId 查询/POST/账本语义零改。
      respondJson(200, {
        draft: true,
        active: null,
        unbound_reason: null,
        recent: buildRunCandidates(deps.runsRoot, null, 3),
        candidates: [],
      });
      return;
    }
    respondJson(200, { ...sessionBindingPayloadOf(deps.home, deps.runsRoot, sessionId.trim()) });
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return;
  }
  let body = "";
  req.on("data", (chunk: Buffer) => { body += String(chunk); });
  req.on("end", () => {
    let incoming: Record<string, unknown> = {};
    try {
      incoming = JSON.parse(body === "" ? "{}" : body) as Record<string, unknown>;
    } catch {
      respondJson(400, { error: "invalid_json", message: "请求体须为 JSON" });
      return;
    }
    const sessionId = typeof incoming["sessionId"] === "string" ? (incoming["sessionId"] as string).trim() : "";
    if (sessionId === "") {
      respondJson(400, { error: "sessionId_required", message: "缺 sessionId" });
      return;
    }
    const hasRunId = Object.prototype.hasOwnProperty.call(incoming, "runId");
    const rename = incoming["rename"];
    if (!hasRunId && rename === undefined) {
      respondJson(400, { error: "runId_or_rename_required", message: "缺 runId（string|null）与 rename" });
      return;
    }
    // 校验全集先行（fail-before-write：任一非法即整体拒绝，零落盘）
    const renameRaw = incoming["rename"];
    const renameParsed: { runId: string; title: string } | null = (() => {
      if (renameRaw === undefined) return null;
      if (renameRaw === null || typeof renameRaw !== "object") return null;
      const raw = renameRaw as Record<string, unknown>;
      return {
        runId: typeof raw["runId"] === "string" ? (raw["runId"] as string).trim() : "",
        title: typeof raw["title"] === "string" ? (raw["title"] as string).trim() : "",
      };
    })();
    const renameInvalid =
      (renameRaw !== undefined && (renameRaw === null || typeof renameRaw !== "object")) ||
      (renameParsed !== null && (renameParsed.runId === "" || renameParsed.title === "" || renameParsed.title.length > 80));
    if (renameInvalid) {
      respondJson(400, { error: "rename_invalid", message: "rename 须为 {runId, title}——title 非空且 ≤80 字" });
      return;
    }
    let bindDir: string | null = null;
    if (hasRunId) {
      const raw = incoming["runId"];
      if (raw !== null && (typeof raw !== "string" || raw.trim() === "")) {
        respondJson(400, { error: "runId_invalid", message: "runId 须为字符串或 null" });
        return;
      }
      if (raw !== null) {
        bindDir = resolveRunDir(deps.runsRoot, (raw as string).trim());
        if (!existsSync(bindDir)) {
          respondJson(404, { error: "run_not_found", message: `实验不存在：${(raw as string).trim()}` });
          return;
        }
      }
    }
    if (renameParsed !== null) {
      const renameDir = resolveRunDir(deps.runsRoot, renameParsed.runId);
      if (!existsSync(renameDir)) {
        respondJson(404, { error: "run_not_found", message: `实验不存在：${renameParsed.runId}` });
        return;
      }
      if (!writeDisplay(renameDir, renameParsed.title)) {
        respondJson(500, { error: "display_write_failed", message: "改名写入失败——run 目录不可写" });
        return;
      }
    }
    if (bindDir !== null) {
      bindSessionRun(deps.home, sessionId, {
        runId: (incoming["runId"] as string).trim(),
        workspace: workspaceOfRunDir(deps.runsRoot, bindDir),
        source: "user_pick",
      });
    } else if (hasRunId) {
      unbindSession(deps.home, sessionId, "cleared");
    }
    respondJson(200, { saved: true, ...sessionBindingPayloadOf(deps.home, deps.runsRoot, sessionId) });
  });
};

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
  // 批B1：会话绑定账本首次启动迁移（仅账本文件不存在时执行——run 侧 binding.json 聚合；
  // 幂等；迁移数入 boot 日志。失败 fail-open 不阻断同步器）。
  try {
    const migratedSessions = migrateFromRunBindings(resolveBindingsHome(process.env), resolved.runsRoot);
    if (migratedSessions > 0) {
      console.log(`[atf-ui] 会话绑定账本迁移：${String(migratedSessions)} 个会话自 run 侧 binding.json 聚合（source=migrated）`);
    }
  } catch (cause) {
    console.error(`[atf-ui] 会话绑定账本迁移失败（fail-open）: ${cause instanceof Error ? cause.message : String(cause)}`);
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
      // 目录结构 v1（设计基线 D5/D6）：工作区注册表清单端点（只读）——registry records
      // ＋path 目录在位状态（目录丢失呈现面数据源；鉴权沿壳 connection 信任面）。
      // 注册表本体是 DSH 运行时资产，本端点零写入零改动，只做 stat 级探测。
      const disposeWorkspaces = webServer.register({
        kind: "exact",
        path: "/atf-ui/workspaces",
        handler: (req, res) => {
          const rejection = connection.requestRejection(req);
          if (rejection !== undefined) {
            res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
            res.end("dsh web authentication required\n");
            return;
          }
          try {
            const records = listRegistryRecords(resolveDshHome()).map((record) => ({
              id: record.id,
              path: record.path,
              title: record.title,
              session_count: record.sessionIds.length,
              exists: record.exists,
            }));
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ records }));
          } catch (cause) {
            res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "registry_unavailable", message: String(cause) }));
          }
        },
      });
      ctx.effect(() => disposeWorkspaces, "atf-ui: 工作区注册表清单端点");
      console.log("[atf-ui] 工作区清单端点已注册（/atf-ui/workspaces——目录丢失呈现数据源·只读）");
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

    // ── D11-2：GPU 历史路由（鉴权同 settings；minutes 非法 400；文件缺失/全坏 → 200 空数组不 500）──
    const gpuHistoryHandler: (req: IncomingMessage, res: ServerResponse) => void = (req, res) => {
      const rejection = ctx.connection?.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end("dsh web authentication required\n");
        return;
      }
      const q = parseGpuHistoryQuery(req.url ?? "/");
      if (q === null) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "minutes 须为 1–60 整数；maxPoints 须为 1–2000 整数" }));
        return;
      }
      const points = readGpuHistoryWindow(resolved.runsRoot, new Date(), q.minutes, q.maxPoints);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ generated_at: new Date().toISOString(), window_minutes: q.minutes, points }));
    };
    const disposeGpuHistory = webServer.register({ kind: "exact", path: "/atf-ui/gpu-history", handler: gpuHistoryHandler });
    ctx.effect(() => disposeGpuHistory, "atf-ui: GPU 历史路由");
    console.log("[atf-ui] GPU 历史路由已注册（/atf-ui/gpu-history——按天 jsonl 尾窗读取）");

    // ── D11-2：run 产物只读路由（runId 段级白名单＋rel 校验＋realpath 越界拒；越界/非法一律
    // 404 且不回显绝对路径；鉴权同 settings）。checkpoint 目录不可服务——面板侧落 trainer_state.json。
    const notFound = (res: ServerResponse): void => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    };
    const RUN_FILE_MIME: Record<string, string> = {
      json: "application/json; charset=utf-8",
      jsonl: "application/json; charset=utf-8",
      md: "text/markdown; charset=utf-8",
      txt: "text/plain; charset=utf-8",
      csv: "text/csv; charset=utf-8",
      log: "text/plain; charset=utf-8",
      yaml: "text/yaml; charset=utf-8",
      yml: "text/yaml; charset=utf-8",
      html: "text/html; charset=utf-8",
    };
    const runFileHandler: (req: IncomingMessage, res: ServerResponse) => void = (req, res) => {
      const rejection = ctx.connection?.requestRejection(req);
      if (rejection !== undefined) {
        res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
        res.end("dsh web authentication required\n");
        return;
      }
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const runId = q.get("runId") ?? "";
      if (!SEG_RE.test(runId)) {
        notFound(res);
        return;
      }
      const rel = sanitizeRunFileRel(q.get("rel") ?? "");
      if (rel === null) {
        notFound(res);
        return;
      }
      // run 目录双形态解析（分桶/平铺——viewer 路由 runDirOf 同源 resolveRunDir，不直拼 runsRoot/runId）
      let baseDir = resolve(resolveRunDir(resolved.runsRoot, runId));
      // runsRoot 本身可能经符号链接落盘（dev 实锚：runs → datasets/.../runs）——containment
      // 基准必须取 realpath 归一后的 run 目录，否则合法文件恒被判越界。
      try {
        baseDir = realpathSync(baseDir);
      } catch {
        notFound(res);
        return;
      }
      let target = resolve(baseDir, rel);
      // 符号链接逃逸拒：realpath 归一后必须仍在该 run 目录内（不可解析＝404 不猜）。
      try {
        target = realpathSync(target);
      } catch {
        notFound(res);
        return;
      }
      if (!target.startsWith(baseDir + sep)) {
        notFound(res);
        return;
      }
      let data: Buffer;
      try {
        if (!statSync(target).isFile()) {
          notFound(res);
          return;
        }
        data = readFileSync(target);
      } catch {
        notFound(res);
        return;
      }
      const ext = (target.split(".").pop() ?? "").toLowerCase();
      res.writeHead(200, { "content-type": RUN_FILE_MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    };
    const disposeRunFile = webServer.register({ kind: "exact", path: "/atf-ui/run-file", handler: runFileHandler });
    ctx.effect(() => disposeRunFile, "atf-ui: run 产物只读路由");
    console.log("[atf-ui] run 产物只读路由已注册（/atf-ui/run-file——白名单扩展＋runsRoot 越界拒）");

    // ── 批B1：会话↔Run 绑定端点（GET 查询绑定＋候选；POST 绑定/解除/改名；鉴权同 settings）──
    const disposeSessionBinding = webServer.register({
      kind: "exact",
      path: "/atf-ui/session-binding",
      handler: sessionBindingRouteHandler({
        home: resolveBindingsHome(process.env),
        runsRoot: resolved.runsRoot,
        reject: (req) => ctx.connection?.requestRejection(req),
      }),
    });
    ctx.effect(() => disposeSessionBinding, "atf-ui: 会话绑定端点");
    console.log("[atf-ui] 会话绑定端点已注册（/atf-ui/session-binding——SessionRunBinding/v1 账本）");
  }
  void tickOnce(resolved);
  const timer: NodeJS.Timeout = setInterval(() => void tickOnce(resolved), resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
