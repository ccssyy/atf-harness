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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildArtifactsSnapshot, buildMonitorSnapshot } from "./snapshot.js";
import { PANEL_HTML } from "./panel.js";
import { queryNvidiaSmi, queryNvidiaSmiAll } from "../../../../src/webui/readOnlyTools.js";
import { buildConfigConfirmFields, CONFIG_CONFIRM_KEYS } from "../../../../src/webui/configConfirm.js";
import { resolveBridgeDeployment, kernelVersionSync, type BridgeDeployment } from "../../../../src/bridge/bridgeCommand.js";

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

export const injectMonitorGlobal = (html: string, monitorPath: string, bridge?: BridgeBadgeSurface): string => {
  const config: Record<string, unknown> = { monitorPath };
  if (bridge !== undefined) config["bridge"] = bridge;
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
  const kernelDir = env["ATF_DSH_KERNEL_DIR"] ?? env["ATF_CLI_PATH"] ?? join(repoRootValue, ".atf-pinned");
  const commandValue = env["ATF_DSH_BRIDGE_COMMAND"] ?? `node ${join(repoRootValue, "tests", "fixtures", "mock_atf.mjs")}`;
  const deployment: BridgeDeployment = resolveBridgeDeployment({ commandValue, kernelDir, env, ...(probe !== undefined ? { probe } : {}) });
  return { mode: deployment.mode, version: deployment.mode === "real" ? kernelVersionSync(deployment.kernelRoot) : null };
};

export interface RunScan {
  run_id: string;
  state: string;
  artifacts: string[];
  segments: Record<string, boolean | string>;
  training: { active: boolean; loss: unknown; pending_confirm: unknown };
  report: { files: string[] };
  viewers: string[];
  launch: LaunchSurface;
  metrics: EvalMetricsSurface | null;
  env: EnvSurface;
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
export function scanRunDir(root: string, runId: string): RunScan {
  const dir = join(root, runId);
  const has = (rel: string): boolean => existsSync(join(dir, rel));
  const readJson = (rel: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, rel), "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const reportDir = join(dir, "report");
  const reportFiles = existsSync(reportDir) ? readdirSync(reportDir).filter((f) => f.endsWith(".md") || f.endsWith(".json")) : [];
  return {
    run_id: runId,
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
      register: has("registration.json") || has("dataset"),
      split: has("split") || has("dataset/split"),
      label_qc: has("label_qc") || has("qc"),
      // 实验配置段：config-snapshot 已确认=done；pending-confirm 在场=active（等待四卡应答）
      experiment_config: has("webui/config-snapshot.json") ? true : has("webui/pending-confirm.json") ? "active" : false,
      candidate: has("contract-candidate.json"),
      publish: has("report") && reportFiles.some((f) => f.startsWith("segment-")),
      // admission 沿 train.sh 存在（生成即过 DRY_RUN 准入自检面）
      admission: has("launch/train.sh") || has("admission.json"),
      training: has("training/loss-series.json"),
    },
    training: {
      active: has("training/loss-series.json"),
      // 批㉛段3.1：live loss-series 缺席 → 最新 checkpoint trainer_state.json 历史回退
      loss: has("training/loss-series.json") ? readJson(join("training", "loss-series.json")) : trainerHistoryLoss(dir),
      pending_confirm: readJson(join("webui", "pending-confirm.json")),
    },
    report: { files: reportFiles },
    viewers: discoverViewerDirs(dir),
    launch: buildLaunchSurface(dir),
    metrics: latestEvalMetrics(dir),
    env: buildEnvSurface(readJsonFile(iterationConfigPathOf(dir)) as Record<string, unknown> | null, runId),
    gpu_binding: gpuBindingOf(dir),
    eval_rounds: scanEvalRounds(dir),
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
  num_train_epochs: "训练轮数（全量数据过几遍）",
  per_device_train_batch_size: "单卡 batch（每次前向的样本数）",
  gradient_accumulation_steps: "梯度累积（累积几步做一次更新；等效 batch＝单卡 batch×累积）",
  cutoff_len: "样本截断长度（训练序列最大 token 数）",
  deepspeed: "DeepSpeed 分布式配置（显存/卸载策略）",
  lora_rank: "LoRA 秩（容量/参数量）",
  lora_alpha: "LoRA alpha（缩放系数，与 rank 成对）",
  dataset_keys: "数据集键（登记面推导的 variants 条目）",
  max_total_tokens: "构造准入闸门：单样本超限在数据构造期截断/拒绝——不作用于评估推理长度（推理截断由服务端 completion 参数决定，批㉙ A 重评实证）",
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

function scanRuns(runsRoot: string): RunScan[] {
  const root = join(runsRoot);
  if (!existsSync(root)) return [];
  const runs: RunScan[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === OUT_DIR) continue;
    runs.push(scanRunDir(root, entry.name));
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
  const resolved = resolveViewerRequest(deps.runsRoot, pathname, deps.viewersOf(parts[0]!));
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
    const runs = scanRuns(resolved.runsRoot);
    // GPU 状态（nvidia-smi 包装——不可用如实 offline，不猜测；快照单源随 monitor.json 下发）。
    // 批㉝H：gpu_all 全卡面并采（首行单卡面保留——atf_gpu_status 工具与旧 client 回退共用）。
    const gpu = await queryNvidiaSmi();
    const gpuAll = await queryNvidiaSmiAll();
    const monitor = buildMonitorSnapshot(runs, gpu === null ? { offline: true } : { offline: false, ...gpu }, gpuAll ?? undefined);
    const artifacts = buildArtifactsSnapshot(runs);
    writeFileSync(join(outDir, "monitor.json"), `${JSON.stringify(monitor, null, 1)}\n`, "utf8");
    writeFileSync(join(outDir, "artifacts.json"), `${JSON.stringify(artifacts, null, 1)}\n`, "utf8");
    // 自包含面板（数据内嵌——file:// 直开即用；owner 侧刷新页面即取最新快照）
    writeFileSync(join(outDir, "panel.html"), PANEL_HTML.replace("__ATF_DATA_JSON__", JSON.stringify({ monitor, artifacts }).replace(/</g, "\\u003c")), "utf8");
  } catch (cause) {
    console.error("[atf-ui] 同步失败（下周期重试）:", cause instanceof Error ? cause.message : String(cause));
  }
}

/** 前置服务（cordis 注入声明）：webServer 在场时经 tapIndex 把 monitor 路径注入 index——
 *  client 半据此轮询 per-instance 快照（批㉘；无 webServer 的裸挂载面——如 vitest 直调——跳过注入）。
 *  批㉛段1 增 connection：viewer 静态路由沿用壳既有信任面（requestRejection → 401/403），
 *  不在壳鉴权之外开裸口。 */
export const inject = ["webServer", "connection"];

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
  const viewerRoot = resolve(join(runsRoot, runId, analysis, "viewer"));
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
  // 批㊶-E-H 项 2.3：桥徽标注入面（与 atf-tools 装配单源同 env 推导；boot 日志一行桥类型）
  const bridge = bridgeBadgeSurface(process.env, repoRoot);
  console.log(`[atf-ui] 桥类型: ${bridge.mode === "real" ? `real${bridge.version !== null ? `·${bridge.version}` : ""}` : "mock（⚠ 缺省——设 ATF_DSH_BRIDGE_COMMAND 切真内核）"}`);
  const webServer = ctx.webServer;
  if (webServer !== undefined) {
    const monitorPath = monitorPathOf(resolved.runsRoot);
    const dispose = webServer.tapIndex((html) => injectMonitorGlobal(html, monitorPath, bridge));
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
          viewersOf: (runId) => discoverViewerDirs(join(resolved.runsRoot, runId)),
          reject: (req) => connection.requestRejection(req),
        }),
      });
      ctx.effect(() => disposeRoute, "atf-ui: viewer 静态路由");
      console.log(`[atf-ui] viewer 静态路由已注册（${VIEWER_ROUTE_PREFIX}/<runId>/）`);
    }
  }
  void tickOnce(resolved);
  const timer: NodeJS.Timeout = setInterval(() => void tickOnce(resolved), resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
