/**
 * D50（门 2 收口）——训练段事实＋完成锚（training/completion.json）。
 *
 * 要修的真问题：训练真实完成（trainer_log 100%／进程干净退出）后，完成信号只存在于
 * 临时启发（tmux 缺席＋无锚 → 判 failed「失败/中断」）——run 树没有确定性的完成事实，
 * UI 段链不收口、通知轨误报 training_failed（门 2 b3 走查实锚：6/6 步干净完成后阶段
 * pill 仍「失败/中断」）。
 *
 * 形态（training/completion.json——原子写）：
 *   { status: "ok" | "failed", exit_code: number | null, checkpoint: string | null,
 *     started: string | null, finished: string | null }
 * 写者三面（首写者胜——已在场即跳过，不覆盖不改判）：
 *   ① 工具启动失败面（atf_run_training startup_failed——含放行闸 exit 78）；
 *   ② 同步环（exit.code 尾声件在场且 completion 缺席——真退出码权威）；
 *   ③ 训练观测环 finished-stopped（percentage ≥100 终态）。
 * 消费（atf-ui scanRunDir）：status ok → training 段完成锚（UI 链收口）；status failed
 * → 训练段确定性 failed（不再依赖 tmux 缺席启发）。status ok 同时登记段事实
 * appendSegmentFact(runDir, "training", "atf_run_training")（M-3 事实轨——段键与工具
 * 名沿既有约定）；status failed 不登记段事实（不伪装完成）。
 *
 * 配套落点（工具 spawn 面）：
 *   - training/started.at：new-session 成功即写（ISO——completion.started 数据源）；
 *   - training/exit.code：tmux 尾声 `ec=${PIPESTATUS[0]}; printf …` 落盘（真退出码——
 *     tee 管道下 $? 是 tee 的，PIPESTATUS[0] 才是 train.sh 的）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendSegmentFact } from "./segmentFacts.js";
import { resolveRunSubdir } from "./runSubdirs.js";

/** completion.json 相对落点。 */
export const TRAINING_COMPLETION_REL = join("training", "completion.json");
/** started.at 相对落点（spawn 面写）。 */
export const TRAINING_STARTED_REL = join("training", "started.at");
/** exit.code 相对落点（tmux 尾声写——真退出码）。 */
export const TRAINING_EXIT_CODE_REL = join("training", "exit.code");

/** 完成事实形态（键集闭集——D50 指令键名：exit_code/checkpoint/started/finished＋status）。 */
export interface TrainingCompletion {
  status: "ok" | "failed";
  exit_code: number | null;
  checkpoint: string | null;
  started: string | null;
  finished: string | null;
}

/** 读 completion.json（缺/坏/键形不符＝null 不猜）。 */
export const readTrainingCompletion = (runDir: string): TrainingCompletion | null => {
  const path = join(runDir, TRAINING_COMPLETION_REL);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrainingCompletion>;
    if (parsed === null || typeof parsed !== "object") return null;
    if (parsed.status !== "ok" && parsed.status !== "failed") return null;
    return {
      status: parsed.status,
      exit_code: typeof parsed.exit_code === "number" ? parsed.exit_code : null,
      checkpoint: typeof parsed.checkpoint === "string" ? parsed.checkpoint : null,
      started: typeof parsed.started === "string" ? parsed.started : null,
      finished: typeof parsed.finished === "string" ? parsed.finished : null,
    };
  } catch {
    return null;
  }
};

/** 写 completion.json（首写者胜：已在场即跳过——除非新尝试收尾（本次 started 晚于既有
 *  finished＝同 run 重训的新一轮收尾，覆写是如实语义）。status ok ＝同时登记 training
 *  段事实（atf_run_training——启动面已登记则幂等去重）；status failed 不登记（不伪装
 *  完成——failed 呈现由 scanRunDir 读 completion.status 驱动，与段事实轨无关）。 */
export const writeTrainingCompletion = (runDir: string, completion: TrainingCompletion): boolean => {
  const existing = readTrainingCompletion(runDir);
  if (existing !== null) {
    const supersede = existing.finished !== null && completion.started !== null && completion.started > existing.finished;
    if (!supersede) return false;
  }
  try {
    mkdirSync(join(runDir, "training"), { recursive: true });
    const tmp = join(runDir, TRAINING_COMPLETION_REL) + ".tmp";
    writeFileSync(tmp, `${JSON.stringify(completion, null, 1)}\n`, "utf8");
    renameSync(tmp, join(runDir, TRAINING_COMPLETION_REL));
  } catch {
    return false; // fail-open：完成锚缺席不阻塞主流程（UI 回落既有启发）
  }
  if (completion.status === "ok") appendSegmentFact(runDir, "training", "atf_run_training");
  return true;
};

/** 最新 checkpoint 目录名（training/ 与 prep/iteration-config/ 双拓扑——walkthrough 布局
 *  落 prep 侧；checkpoint-<数字> 取最大编号；无＝null）。 */
export const latestCheckpointOf = (runDir: string): string | null => {
  let best: { name: string; n: number } | null = null;
  for (const parent of [join(runDir, "training"), resolveRunSubdir(runDir, "prep/iteration-config")]) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of entries) {
      const m = /^checkpoint-(\d+)$/.exec(name);
      if (m === null) continue;
      const n = Number.parseInt(m[1] as string, 10);
      if (best === null || n > best.n) best = { name, n };
    }
  }
  return best === null ? null : best.name;
};

/** exit.code 尾声件 → 退出码（缺/非整数＝null 如实）。 */
export const readTrainingExitCode = (runDir: string): number | null => {
  const path = join(runDir, TRAINING_EXIT_CODE_REL);
  if (!existsSync(path)) return null;
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};

/** started.at → ISO 串（缺＝null）。 */
export const readTrainingStartedAt = (runDir: string): string | null => {
  const path = join(runDir, TRAINING_STARTED_REL);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
};

/** spawn 面写 started.at（ISO；幂等——训练重跑时重写为最新启动时刻是如实语义）。 */
export const writeTrainingStartedAt = (runDir: string, iso: string = new Date().toISOString()): void => {
  try {
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, TRAINING_STARTED_REL), `${iso}\n`, "utf8");
  } catch {
    // fail-open：started 缺席 → completion.started=null 如实
  }
};

/** exit.code 尾声件 mtime → 完成时刻 ISO（尾声落盘时刻≈进程退出时刻；缺＝null）。 */
export const trainingFinishedAtOf = (runDir: string): string | null => {
  const path = join(runDir, TRAINING_EXIT_CODE_REL);
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
};

/** 同步环完成判定与组装（exit.code 在场＝train.sh 已退出——权威信号）：exit 0 → ok，
 *  非 0 → failed；checkpoint/started/finished 自配套件组装（缺席＝null 如实）。 */
export const completionFromExitCodeFile = (runDir: string): TrainingCompletion | null => {
  if (!existsSync(join(runDir, TRAINING_EXIT_CODE_REL))) return null;
  const exitCode = readTrainingExitCode(runDir);
  return {
    status: exitCode === 0 ? "ok" : "failed",
    exit_code: exitCode,
    checkpoint: latestCheckpointOf(runDir),
    started: readTrainingStartedAt(runDir),
    finished: trainingFinishedAtOf(runDir),
  };
};
