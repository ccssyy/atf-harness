/**
 * 批㊶-TRAIN-OBS T1/T3——训练观测环（同步器 5s 环内 per-run 驱动）。
 *
 * T1 进度写方状态机：idle→active→stopped——每轮读 `training/trainer_log.jsonl` 末行→
 * 组装 RunProgress（percentage/eta_s/step_remaining）→writeProgress（原子写）。fail-closed：
 * 文件缺/空/末行坏/必填缺 → 本轮跳过不写不抛；连续 12 轮（≈1 分钟）读不到有效行 → 写一次
 * 带 `stale: true` 的快照后停环（不猜原因不伪造进度）；percentage ≥100 终态 → 写一次后停环；
 * 同一 run 防双开（状态表在案即不重起）。
 *
 * T3 日志尾部流：同环经 tmuxLiveness tmuxCommand 单源发起 capture-pane（-S -40）→ ≤40 行（每行 ≤200 字符）
 * → 原子写 `webui/trainlog.tail.json`（含采集时间戳）。会话缺席/命名域拒绝/捕获失败 → 该面
 * 缺席，不伪造不刷屏。
 *
 * 数据面纪律：会话名与 trainProbe 同源（tmuxLiveness 命名域单源，不新发明来源）；
 * 原子写＝tmp＋rename（读侧永不见半截文件）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmuxCommand } from "./tmuxLiveness.js";
import {
  buildProgressFromTrainerLog,
  readProgress,
  readTrainerLogTail,
  trainerLogPathOf,
  writeProgress,
  type RunProgress,
} from "./runFacts.js";
import {
  latestCheckpointOf, readTrainingExitCode, readTrainingStartedAt, writeTrainingCompletion,
} from "./trainingCompletion.js";

/** 记账本停更阈值：连续 12 轮读不到有效行（同步器 5s 环 ≈1 分钟）。 */
export const TRAIN_OBS_STALE_ROUNDS = 12;
/** capture-pane 行数封顶。 */
export const TRAINLOG_TAIL_MAX_LINES = 40;
/** 单行字符截断。 */
export const TRAINLOG_TAIL_MAX_LINE_CHARS = 200;

/** 批㊶-L L-1／D16 单源迁移：训练活跃新鲜窗口缺省（毫秒）——env `ATF_TRAIN_ACTIVE_WINDOW_MS`
 *  可配（非法/≤0 回落缺省 180s）。常量自 atf-ui server.ts 迁入 core（trainObsSync 源新鲜度门
 *  同源消费——core 不得反向依赖 extensions；server.ts re-export 兼容既有引用面）。 */
export const TRAIN_ACTIVE_WINDOW_MS_DEFAULT = 180_000;
export const TRAIN_ACTIVE_WINDOW_MS_ENV = "ATF_TRAIN_ACTIVE_WINDOW_MS";
export const resolveTrainActiveWindowMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env[TRAIN_ACTIVE_WINDOW_MS_ENV];
  if (raw === undefined || raw.trim() === "") return TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return TRAIN_ACTIVE_WINDOW_MS_DEFAULT;
  return parsed;
};

/** 源 trainer_log mtime（D27 双拓扑：trainerLogPathOf 单源发现——stat 失败/两路俱缺席
 *  ＝null，走 stale 分支）。 */
const sourceLogMtimeMs = (runDir: string): number | null => {
  try {
    const path = trainerLogPathOf(runDir);
    return path !== null ? statSync(path).mtimeMs : null;
  } catch {
    return null;
  }
};

/** per-run 观测态（进程内——syncer 重启即复位，progress.json 落盘态不受影响）。
 *  批㊶-TRAIN-OBS-FIX R1-b 语义修正：
 *  - seenValid：曾读到过首条有效行——前首行（模型加载窗）不计 miss 不判 stale；
 *  - stale 不设 stopped（允许 trainer_log 新行复活重置——清 staleWritten/misses 即恢复写）；
 *  - stopped 仅由 finished-stopped（percentage ≥100）设置——终态防复活。 */
interface TrainObsState {
  misses: number;
  stopped: boolean;
  staleWritten: boolean;
  seenValid: boolean;
}

const obsStates = new Map<string, TrainObsState>();

/** 测试钩子：清空观测态。 */
export const resetTrainObsForTest = (): void => {
  obsStates.clear();
};

/** 防双开：该 run 是否已有观测环（未停）。 */
export const trainObsRunning = (runId: string): boolean => {
  const s = obsStates.get(runId);
  return s !== undefined && !s.stopped;
};

/** tmux capture-pane 原始输出 → 行数组（≤40 行，每行 ≤200 字符截断——纯函数）。 */
export const truncateCaptureLines = (raw: string): string[] =>
  raw
    .split("\n")
    .filter((line) => line.trim() !== "") // tmux pane 高度填充空行不入账（信息量为零）
    .slice(0, TRAINLOG_TAIL_MAX_LINES)
    .map((line) => (line.length > TRAINLOG_TAIL_MAX_LINE_CHARS ? `${line.slice(0, TRAINLOG_TAIL_MAX_LINE_CHARS)}…` : line));

/** trainlog.tail.json 落点。 */
export const trainlogTailPathOf = (runDir: string): string => join(runDir, "webui", "trainlog.tail.json");

/** 投影面形态（adapter 白名单两键闭集——摘要化：行已截断，无路径命令面）。 */
export interface TrainlogTailFace {
  captured_at: string;
  lines: string[];
}

/** 读 trainlog.tail.json（scanRunDir 投影消费；缺/坏＝null 不猜）。 */
export const readTrainlogTail = (runDir: string): TrainlogTailFace | null => {
  const path = trainlogTailPathOf(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrainlogTailFace>;
    if (typeof parsed.captured_at !== "string" || !Array.isArray(parsed.lines)) return null;
    if (!parsed.lines.every((l) => typeof l === "string")) return null;
    // 读侧摘要化钳制（投影面保证 ≤40 行/≤200 字符——即使写侧异常越界）
    return { captured_at: parsed.captured_at, lines: truncateCaptureLines(parsed.lines.join("\n")) };
  } catch {
    return null;
  }
};

const writeJsonAtomic = (target: string, payload: unknown): boolean => {
  try {
    mkdirSync(join(target, ".."), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
};

/** tmux capture-pane（会话缺席/捕获失败＝null——fail-closed 缺席，不伪造）。 */
export const captureTrainlogPane = (session: string): Promise<string[] | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    // 批㊶-ISO E2.2 单源纪律：tmux 命令经 tmuxLiveness tmuxCommand 构造（测试 socket 轴随源）；
    // 空socket旗标时命令串含双空格——trim+多空白分割（空串参数会令 tmux 报错）
    const parts = tmuxCommand(` capture-pane -t ${session} -p -S -40`).trim().split(/\s+/);
    const bin = parts[0] as string;
    const args = parts.slice(1) as string[];
    execFile(bin, args as readonly string[], { timeout: 3500, maxBuffer: 256 * 1024 }, (error: Error | null, stdout: string): void => {
      clearTimeout(timer);
      if (error !== null && error !== undefined) {
        resolve(null); // 会话不存在/已被杀＝预期内缺席
        return;
      }
      resolve(truncateCaptureLines(String(stdout)));
    });
  });

/** trainlog.tail.json 原子写。 */
const persistTrainlogTail = (runDir: string, lines: string[], nowIso: string): boolean =>
  writeJsonAtomic(trainlogTailPathOf(runDir), { captured_at: nowIso, lines } satisfies TrainlogTailFace);

/** 依赖注入形（tests 以临时目录/桩 capture 驱动；生产 tickOnce 接真实现）。 */
export interface TrainObsDeps {
  readTail?: (runDir: string) => ReturnType<typeof readTrainerLogTail>;
  numEpochs?: (runDir: string) => number | null;
  lastProgress?: (runDir: string) => RunProgress | null;
  writeProg?: (runDir: string, progress: RunProgress) => void;
  capture?: (session: string) => Promise<string[] | null>;
  sessionName?: (runId: string) => string | null;
  now?: () => Date;
  /** D16：源 trainer_log mtime（缺省真 statSync；stat 失败返回 null＝走 stale 分支）。 */
  sourceMtime?: (runDir: string) => number | null;
  /** D16：新鲜窗口 env（缺省 process.env——resolveTrainActiveWindowMs 单源）。 */
  env?: NodeJS.ProcessEnv;
}

/** 单轮观测（同步器每 5s 对活跃训练 run 调一次）。返回该轮处置（留证/测试断言用）。 */
export type TrainObsTickResult = "written" | "skipped" | "stale-stopped" | "finished-stopped" | "already-stopped";

export const trainObsTick = async (
  runId: string,
  runDir: string,
  numEpochs: number | null,
  deps: TrainObsDeps = {},
): Promise<TrainObsTickResult> => {
  const readTail = deps.readTail ?? readTrainerLogTail;
  const lastProgress = deps.lastProgress ?? readProgress;
  const writeProg = deps.writeProg ?? writeProgress;
  const sourceMtime = deps.sourceMtime ?? sourceLogMtimeMs;
  const now = deps.now ?? (() => new Date());
  let state = obsStates.get(runId);
  if (state === undefined) {
    state = { misses: 0, stopped: false, staleWritten: false, seenValid: false };
    obsStates.set(runId, state);
  }
  if (state.stopped) return "already-stopped"; // finished-stopped 终态——防复活

  const nowIso = now().toISOString();
  let result: TrainObsTickResult = "skipped";
  const tail = readTail(runDir);

  if (tail !== null) {
    // 有效行：复活（清 stale/misses）→源新鲜度门→写 progress→终态判定
    state.seenValid = true;
    state.misses = 0;
    // D16 源新鲜度门：trainer_log mtime 超窗（源停更）→ 写一次 stale 快照后停写。
    // updated_at/source_updated_at 回写源 mtime（不得 now——假活根因即 now 每 5s 续命）；
    // 复活须过本门：文件 mtime 变新（新行落盘）→ staleWritten 清零自然恢复写。
    // stat 失败（文件消失）同走 stale 分支（源时刻不可得＝沿用 last.updated_at，无则 now）。
    const windowMs = resolveTrainActiveWindowMs(deps.env ?? process.env);
    const srcMtimeMs = sourceMtime(runDir);
    const ageMs = srcMtimeMs !== null ? now().getTime() - srcMtimeMs : Number.POSITIVE_INFINITY;
    if (ageMs > windowMs) {
      if (!state.staleWritten) {
        const last = lastProgress(runDir);
        const srcIso = srcMtimeMs !== null
          ? new Date(srcMtimeMs).toISOString()
          : (last !== null && typeof last.updated_at === "string" ? last.updated_at : nowIso);
        writeProg(runDir, { ...(last ?? {}), stale: true, updated_at: srcIso, source_updated_at: srcIso });
        state.staleWritten = true;
        result = "stale-stopped"; // 停写——mtime 变新即复活（过本门）
      } else {
        result = "already-stopped"; // stale 快照已在盘——不再续写
      }
    } else {
      state.staleWritten = false;
      writeProg(runDir, buildProgressFromTrainerLog(tail, numEpochs, nowIso));
      if (tail.percentage >= 100) {
        state.stopped = true; // percentage ≥100＝终态——写一次后停环（防复活）
        // D50 补：观测环终态即写 completion.json（status ok）——launch 执行链
        // （atf_launch_execute——launch.sh 无 harness 尾声，training/exit.code 缺席）
        // 与 atf_run_training 双路径通吃的完成锚写者；exit.code 尾声件在场则回填真值，
        // 缺席＝null 如实（首写者胜/重训覆写在写方单源）。
        writeTrainingCompletion(runDir, {
          status: "ok",
          exit_code: readTrainingExitCode(runDir),
          checkpoint: latestCheckpointOf(runDir),
          started: readTrainingStartedAt(runDir),
          finished: nowIso,
        });
        result = "finished-stopped";
      } else {
        result = "written";
      }
    }
  } else if (!state.seenValid) {
    // R1-b：模型加载窗（首条有效行前）——不计 miss 不判 stale（加载可远超 60s）
    result = "skipped";
  } else {
    // 曾读到过有效行但当前读不到——trainer_log 停更/损坏
    state.misses += 1;
    if (state.misses >= TRAIN_OBS_STALE_ROUNDS && !state.staleWritten) {
      const last = lastProgress(runDir);
      const staleSnapshot: RunProgress = { ...(last ?? {}), stale: true, updated_at: nowIso };
      writeProg(runDir, staleSnapshot);
      state.staleWritten = true;
      result = "stale-stopped"; // 不设 stopped——新行出现即复活
    }
  }
  // T3 日志尾部流：与进度同环（会话名由调用方按命名域单源解析；拒绝/缺席＝null → 缺席不伪造）
  if (deps.capture !== undefined && deps.sessionName !== undefined) {
    const session = deps.sessionName(runId);
    if (session !== null) {
      const lines = await deps.capture(session);
      if (lines !== null) persistTrainlogTail(runDir, lines, nowIso);
    }
  }
  return result;
};

/** trainlog.tail.json 在盘判定（测试/留证用）。 */
export const trainlogTailPresent = (runDir: string): boolean => existsSync(trainlogTailPathOf(runDir));
