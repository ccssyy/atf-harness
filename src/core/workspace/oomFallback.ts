/**
 * 批㊶-Q 段3——OOM 自动降档重发（探针识别 → 通报前置 → 同 run 重发；两档统一生效）。
 *
 * 链路（同步器 tickOnce 探针循环内驱动）：probeRun 判出 OOM（训练日志 CUDA out of memory 特征）
 * → 护栏核验 → **先写重发通报**（alerts.json kind=oom_fallback，告警行同源呈现）→ train.sh 确定性
 * 降档补丁（bs→1、accum=256/(1×nproc)、gb 256 不变；原 train.sh 不动，产 train-oom-fallback.sh）
 * → DRY_RUN 校验 → tmux 重发（kill 旧会话→新会话）→ loss 进料重启 → 状态落盘（每 run 一次）。
 *
 * 护栏（fail-closed，全部不走重发只通报）：
 *   状态文件 webui/oom-fallback.json 在场（本 run 已降档过）｜现 train.sh bs 已=1（降档无可再降，
 *   再发无意义）｜train.sh 缺特征行（补丁定位失败不盲改）｜端口被非预期占用（不同步器侧自动清理）
 *   ｜DRY_RUN 校验不过。副作用全部可注入（vitest 假件直测）；宿主接线见 atf-ui server.ts。
 * 真实放行账本闸门不变：重发沿用同 run 的 config（train.sh 内 subject sha256 校验原样）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { deriveGradAccum } from "./smartDefaults.js";
import { appendNotification, OOM_PATTERN } from "./trainProbe.js";

/** OOM 降档状态文件（webui/oom-fallback.json——每 run 一次护栏）。 */
export const oomFallbackStatePath = (runDir: string): string => join(runDir, "webui", "oom-fallback.json");

export interface TrainShBatchParams {
  bs: number;
  accum: number;
  nproc: number;
}

/** train.sh 文本 → 批参（TRAIN_CMD 数组形态：'--flag' \ 换行 'value'；NPROC_PER_NODE=export 形态）。
 *  特征行缺失返回 error（fail-closed——补丁定位失败不盲改）。 */
export const readTrainShBatchParams = (text: string): TrainShBatchParams | { error: string } => {
  const flagValue = (flag: string): number | null => {
    const m = new RegExp(`'--${flag}'\\s*\\\\\\n\\s*'([^'\\n]+)'`).exec(text);
    if (m === null) return null;
    const value = Number(m[1]);
    return Number.isFinite(value) ? value : null;
  };
  const bs = flagValue("per_device_train_batch_size");
  const accum = flagValue("gradient_accumulation_steps");
  const nprocM = /NPROC_PER_NODE=(?:\$\{NPROC_PER_NODE:-)?(\d+)/.exec(text);
  const nproc = nprocM !== null ? Number(nprocM[1]) : NaN;
  if (bs === null || accum === null || !Number.isFinite(nproc) || nproc <= 0) {
    return { error: `train_sh_batch_params_missing:bs=${String(bs)} accum=${String(accum)} nproc=${String(nproc)}——特征行缺失，不做降档补丁` };
  }
  return { bs, accum, nproc };
};

/** train.sh 降档补丁（纯函数）：bs→fallback.bs、accum→fallback.accum 两处值行替换＋头部来历注记；
 *  特征行缺失返回 null（调用方 fail-closed 停手）。原文本不被本函数修改（调用方写新文件）。 */
export const patchTrainShForOom = (text: string, fallback: { bs: number; accum: number }, note: string): string | null => {
  const replaceFlagValue = (source: string, flag: string, value: number): string | null => {
    const re = new RegExp(`('--${flag}'\\s*\\\\\\n\\s*)'[^'\\n]+'`);
    if (!re.test(source)) return null;
    return source.replace(re, `$1'${value}'`);
  };
  let out = replaceFlagValue(text, "per_device_train_batch_size", fallback.bs);
  if (out === null) return null;
  out = replaceFlagValue(out, "gradient_accumulation_steps", fallback.accum);
  if (out === null) return null;
  const stamp = `# OOM 自动降档重发（${note}）：bs=${fallback.bs} accum=${fallback.accum} 全局批量 256 不变；原件 launch/train.sh 未改动\n`;
  // 插在 shebang 之后（首行）
  const lines = out.split("\n");
  lines.splice(1, 0, stamp.trimEnd());
  return lines.join("\n");
};

/** 重发编排输入（副作用全注入——vitest 假件直测；宿主接线传真件）。 */
export interface OomFallbackDeps {
  runDir: string;
  runId: string;
  /** 训练日志目录（ATF_DSH_LOG_DIR 轴——与 atf_run_training tee 目标同源单轴）。 */
  logDir: string;
  /** 探针判定的 OOM 告警文案（kind=probe 且 reason 命中 OOM 特征才触发）。 */
  alert: { level: string; kind?: string; reason: string; since: string };
  now: () => Date;
  log: (line: string) => void;
  // —— 副作用注入面 ——
  readText: (abs: string) => string | null;
  writeText: (abs: string, text: string) => void;
  exists: (abs: string) => boolean;
  /** DRY_RUN 校验：exit 0 且 stdout 含 ADMISSION=pass 才算过。 */
  dryRun: (abs: string) => Promise<{ code: number; stdout: string }>;
  /** 端口占用探测（null=空闲）。 */
  probePort: (port: number) => Promise<unknown | null>;
  /** tmux 命令执行（kill-session / new-session）。 */
  tmux: (command: string) => void;
  /** 日志轮转（重发前把旧 train-stdout.log 归档——新日志只含本次尝试，旧 OOM 特征不再误判）。 */
  rotateLog: (logPath: string) => void;
  /** loss 进料重启（同步器进程内 tail 循环）。 */
  startIngest: (logPath: string, seriesPath: string) => void;
}

export interface OomFallbackOutcome {
  triggered: boolean;
  reason: string;
  fallbackScript?: string;
}

/** 同步器探针 OOM → 自动降档重发编排（护栏任一不过＝不重发只通报/记因；每 run 一次）。 */
export const maybeAutoOomFallback = async (deps: OomFallbackDeps): Promise<OomFallbackOutcome> => {
  const { runDir, runId, alert } = deps;
  const notTriggered = (reason: string): OomFallbackOutcome => ({ triggered: false, reason });
  // 护栏 0：本编排只吃探针 OOM 告警（kind=probe＋OOM 特征——通报类 info 条目不触发）
  if (alert.kind !== "probe" || alert.level !== "error" || !OOM_PATTERN.test(alert.reason)) {
    return notTriggered("非探针 OOM 告警——不触发");
  }
  // 护栏 1：每 run 一次（状态文件在场即不再发——含降档后再 OOM 的场景：bs 已 1 无可再降）
  if (deps.exists(oomFallbackStatePath(runDir))) {
    return notTriggered("oom_fallback_state_present——本 run 已降档过，不再重发");
  }
  const writeState = (payload: Record<string, unknown>): void => {
    try {
      mkdirSync(join(runDir, "webui"), { recursive: true });
      deps.writeText(oomFallbackStatePath(runDir), `${JSON.stringify({ run_id: runId, at: deps.now().toISOString(), ...payload }, null, 1)}\n`);
    } catch { /* fail-open——状态写失败仅影响幂等护栏 */ }
  };
  const trainShPath = join(runDir, "launch", "train.sh");
  const text = deps.readText(trainShPath);
  if (text === null) {
    return notTriggered("train_sh_missing——无重发原件");
  }
  const params = readTrainShBatchParams(text);
  if ("error" in params) {
    return notTriggered(params.error);
  }
  // 护栏 2：bs 已=1（已是降档形态——重发无意义；记状态防周期重复判定）
  if (params.bs <= 1) {
    writeState({ status: "skipped_already_bs1", bs: params.bs, accum: params.accum });
    return notTriggered(`bs 已为 ${params.bs}（降档形态）——不重发`);
  }
  // 降档目标（P-1 oomFallbackParams 同口径）：bs 2→1、accum=256/(1×nproc)、gb 256 不变
  const fallback = deriveGradAccum(1, params.nproc);
  if ("error" in fallback) {
    return notTriggered(`fallback_derive_failed:${fallback.error}`);
  }
  // in-flight 先占位（同步器 5s 周期短于 DRY_RUN/端口探测最坏耗时——防双触发重发）
  writeState({ status: "in_flight", bs: params.bs, accum: params.accum });
  const patched = patchTrainShForOom(text, { bs: 1, accum: fallback.accum }, deps.now().toISOString());
  if (patched === null) {
    return notTriggered("train_sh_patch_failed——特征行替换失败，不盲改");
  }
  const fallbackScript = join(runDir, "launch", "train-oom-fallback.sh");
  deps.writeText(fallbackScript, patched);
  // DRY_RUN 校验（坏脚本不进重发）
  const dry = await deps.dryRun(fallbackScript);
  if (dry.code !== 0 || !dry.stdout.includes("ADMISSION=pass")) {
    writeState({ status: "dryrun_failed", fallback_script: "launch/train-oom-fallback.sh", dry_stdout_head: dry.stdout.slice(0, 300) });
    appendNotification(runDir, {
      level: "warn", kind: "oom_fallback", since: deps.now().toISOString(),
      reason: `OOM 降档重发失败（DRY_RUN 未过）——已保留 launch/train-oom-fallback.sh 待人工核查；run ${runId}`,
    });
    return { triggered: false, reason: "dryrun_failed", fallbackScript };
  }
  // 端口预检：占用即停（同步器侧不自动清理进程——fail-closed，人工介入）
  const portM = /MASTER_PORT=(?:\$\{MASTER_PORT:-)?(\d{4,5})/.exec(patched);
  const port = portM !== null ? Number(portM[1]) : 29_517;
  const occupant = await deps.probePort(port);
  if (occupant !== null) {
    writeState({ status: "port_occupied", port });
    appendNotification(runDir, {
      level: "warn", kind: "oom_fallback", since: deps.now().toISOString(),
      reason: `OOM 降档重发停手：端口 ${port} 被占用——不自动清理，请人工处理后重发；run ${runId}`,
    });
    return { triggered: false, reason: "port_occupied", fallbackScript };
  }
  // —— 通报前置（红线：重发前告警行通报在场）——
  appendNotification(runDir, {
    level: "info", kind: "oom_fallback", since: deps.now().toISOString(),
    reason: `OOM 自动降档重发（run ${runId}）：bs ${params.bs}→1、梯度累积 ${params.accum}→${fallback.accum}、全局批量 256 不变——正在重发（launch/train-oom-fallback.sh，原件未动）`,
  });
  // tmux 重发：先轮转日志（新日志只含本次尝试——旧 OOM 特征不残留误判），kill 旧会话→新会话
  const logPath = join(deps.logDir, "train-stdout.log");
  try {
    deps.rotateLog(logPath);
  } catch { /* 轮转失败不阻断重发（tee -a 追加语义兜底） */ }
  deps.tmux(`tmux kill-session -t atf-training-run 2>/dev/null`);
  deps.tmux(`tmux new-session -d -s atf-training-run "bash ${fallbackScript} 2>&1 | tee -a ${logPath}"`);
  deps.startIngest(logPath, join(runDir, "training", "loss-series.json"));
  writeState({ status: "relaunched", bs: 1, accum: fallback.accum, global_batch: fallback.globalBatch, fallback_script: "launch/train-oom-fallback.sh", origin_alert_since: alert.since });
  deps.log(`[atf-ui] OOM 自动降档重发：run ${runId} bs ${params.bs}→1 accum ${params.accum}→${fallback.accum}（gb 256 不变）`);
  return { triggered: true, reason: "relaunched", fallbackScript };
};

/** existsSync/readFileSync/writeFileSync 薄包装（宿主接线用——保持 deps 注入面一致）。 */
export const nodeOomFallbackIo = {
  exists: (abs: string): boolean => existsSync(abs),
  readText: (abs: string): string | null => {
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  },
  writeText: (abs: string, text: string): void => {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf8");
  },
};
