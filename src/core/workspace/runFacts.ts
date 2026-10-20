/**
 * 批㊶-N——会话↔run 绑定＋段内进度＋段序守卫共享面（run 目录本地文件，fail-open）。
 *
 * - binding.json：append 式 [{session_id, bound_at}]；写者＝run 域工具执行成功时
 *   （exec.agent.session.id——vendor ToolExecutionInput.agent.session.id 链路实锚）；
 *   同 run 多会话幂等去重；写失败静默降级（不阻塞工具主流程）。
 * - progress.json：{round, total_rounds, step_remaining?, eta_s?, loss?, updated_at}；
 *   写者＝atf_run_training status 每次成功取数后。
 * - 段序：八段有序管线，后段 done 前提＝前段 done 成立（推导层抑制，不报错）。
 * 均为 run 目录本地文件，不进 bridge 契约面。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// ── 绑定 ──

export interface SessionBinding {
  session_id: string;
  bound_at: string;
}

export const bindingPathOf = (runDir: string): string => join(runDir, "webui", "binding.json");

export const readBindings = (runDir: string): SessionBinding[] => {
  const path = bindingPathOf(runDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SessionBinding =>
        entry !== null && typeof entry === "object" && typeof (entry as SessionBinding).session_id === "string",
    );
  } catch {
    return [];
  }
};

/** 追加绑定（同 session 幂等去重；写失败静默——fail-open）。 */
export const appendBinding = (runDir: string, sessionId: string, boundAt: string = new Date().toISOString()): void => {
  if (sessionId === "") return;
  try {
    const bindings = readBindings(runDir);
    if (bindings.some((binding) => binding.session_id === sessionId)) return;
    bindings.push({ session_id: sessionId, bound_at: boundAt });
    const dir = join(runDir, "webui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(bindingPathOf(runDir), `${JSON.stringify(bindings, null, 1)}\n`, "utf8");
  } catch {
    // fail-open：绑定写失败不阻塞工具主流程
  }
};

// ── 批㊶-W W1：会话→runDir 直传解析（围栏并发会话隔离）──

/** 会话绑定反查：扫 runs 根（平铺＋工作区分桶双形态）逐 run 读 binding.json，
 *  返回含该 sessionId 且 bound_at 最新的 runDir；无命中＝null。
 *  调用链直传语义（W1 修法）：atf_bash 围栏可写根优先取本解析值（会话各回各 run），
 *  进程级 env ATF_BASH_RUN_WORKSPACE 降为过渡态回退（并发互踩消除）。
 *  runs 数量少（实例级几十）＋单层目录扫描——逐次调用可承受；异常静默 fail-open。 */
export const resolveSessionRunWorkspace = (runsRoot: string, sessionId: string): string | null => {
  if (sessionId === "") return null;
  const hits: Array<{ runDir: string; at: number }> = [];
  const visit = (runDir: string): void => {
    for (const binding of readBindings(runDir)) {
      if (binding.session_id !== sessionId) continue;
      const at = Date.parse(binding.bound_at);
      hits.push({ runDir, at: Number.isFinite(at) ? at : 0 });
    }
  };
  try {
    if (!existsSync(runsRoot)) return null;
    for (const level1 of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!level1.isDirectory()) continue;
      const level1Path = join(runsRoot, level1.name);
      if (existsSync(join(level1Path, "webui", "binding.json"))) {
        visit(level1Path);
        continue;
      }
      // 工作区分桶形态：runs/<workspace>/<run_id>/webui/binding.json
      try {
        for (const level2 of readdirSync(level1Path, { withFileTypes: true })) {
          if (!level2.isDirectory()) continue;
          if (!existsSync(join(level1Path, level2.name, "webui", "binding.json"))) continue;
          visit(join(level1Path, level2.name));
        }
      } catch { /* 桶层不可读——跳过 */ }
    }
  } catch {
    return null;
  }
  if (hits.length === 0) return null;
  // 多 run 绑定同会话：取 bound_at 最新（含非有限时间戳按 0 排序——如实最早）。
  let best = hits[0] as { runDir: string; at: number };
  for (const hit of hits) if (hit.at >= best.at) best = hit;
  return best.runDir;
};

// ── 段内进度 ──

export interface RunProgress {
  round?: number;
  total_rounds?: number;
  step_remaining?: number;
  /** 批㊶-TRAIN-OBS 注记：由 trainer_log remaining_time（"H:MM:SS"）换算的预计剩余秒数（源见 buildProgressFromTrainerLog）。 */
  eta_s?: number;
  loss?: number;
  /** 批㊶Q增补二1 additive：trainer_log percentage 直通（0-100）。 */
  percentage?: number;
  /** 批㊶-TRAIN-OBS additive：记账本连续 12 轮（≈1 分钟）停更标记（停环前末次写入——不猜原因）。 */
  stale?: boolean;
  updated_at: string;
  /** D16：源 trainer_log mtime ISO（源新鲜度门 stale 快照回写源时间——updated_at 不得 now）。 */
  source_updated_at?: string;
}

export const progressPathOf = (runDir: string): string => join(runDir, "webui", "progress.json");

export const readProgress = (runDir: string): RunProgress | null => {
  const path = progressPathOf(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RunProgress;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.updated_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
};

/** 写进度（原子写：tmp＋rename——批㊶-TRAIN-OBS 升级，读侧永不见半截文件；写失败静默）。 */
export const writeProgress = (runDir: string, progress: RunProgress): void => {
  try {
    const dir = join(runDir, "webui");
    mkdirSync(dir, { recursive: true });
    const target = progressPathOf(runDir);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(progress, null, 1)}\n`, "utf8");
    renameSync(tmp, target);
  } catch {
    // fail-open
  }
};

/** "H:MM:SS"｜"MM:SS" → 秒（非负整数秒；形态不符＝null 不猜）。 */
export const parseRemainingTimeSeconds = (raw: string): number | null => {
  const m = /^(\d{1,3}):(\d{1,2}):(\d{1,2})$/.exec(raw.trim());
  if (m !== null) {
    const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]);
    if (mi > 59 || s > 59) return null;
    return h * 3600 + mi * 60 + s;
  }
  const m2 = /^(\d{1,3}):(\d{1,2})$/.exec(raw.trim());
  if (m2 !== null) {
    const mi = Number(m2[1]), s = Number(m2[2]);
    if (s > 59) return null;
    return mi * 60 + s;
  }
  return null;
};

/** eta_s → 人读（>1h 显示 H:MM:SS，否则 MM:SS；非有限数＝null——缺数不占位）。 */
export const formatEta = (etaS: number | undefined): string | null => {
  if (typeof etaS !== "number" || !Number.isFinite(etaS) || etaS < 0) return null;
  const h = Math.floor(etaS / 3600);
  const mi = Math.floor((etaS % 3600) / 60);
  const s = Math.floor(etaS % 60);
  const mm = String(mi).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** fresh 判定：updated_at 在新鲜窗口内（解析失败/过期＝false）。
 *  D16：`stale === true` 恒 false（源停更快照——无论 updated_at 新旧，防假活续命）；
 *  旧文件无 stale 字段 → 行为不变（兼容）。 */
export const progressFresh = (progress: RunProgress | null, nowMs: number, windowMs: number): boolean => {
  if (progress === null) return false;
  if (progress.stale === true) return false;
  const at = Date.parse(progress.updated_at);
  if (Number.isFinite(at) === false) return false;
  return nowMs - at <= windowMs;
};

// ── 批㊶Q增补二1：progress 持续写链（trainer_log 步进单源）──

/** trainer_log.jsonl 末行形态（llamafactory 原生步进面——每 logging_steps 追加一行 JSON）。
 *  批㊶-TRAIN-OBS：+remaining_time（"H:MM:SS"｜"MM:SS"→eta_s 源）；loss/epoch 降可选——真实终态行
 *  （percentage 100）缺 loss/lr（A800 现网样本实锚），硬性必填将令终态永远解析失败、"终态写一次后停环"不可达。 */
export interface TrainerLogTail {
  current_steps: number;
  total_steps: number;
  loss: number | null;
  epoch: number | null;
  percentage: number;
  remaining_time: string | null;
}

/** trainer_log.jsonl 末行解析（纯函数——非 JSON/缺必填键＝null，不猜测；
 *  必填＝current_steps/total_steps/percentage；loss/epoch/remaining_time 可选缺省 null）。 */
export const parseTrainerLogLine = (line: string): TrainerLogTail | null => {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    const num = (key: string): number | null => {
      const v = raw[key];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const current = num("current_steps");
    const total = num("total_steps");
    const percentage = num("percentage");
    if (current === null || total === null || percentage === null) return null;
    const epoch = num("epoch");
    const remainingRaw = raw["remaining_time"];
    const remainingTime = typeof remainingRaw === "string" ? remainingRaw : null;
    return { current_steps: current, total_steps: total, loss: num("loss"), epoch, percentage, remaining_time: remainingTime };
  } catch {
    return null;
  }
};

/** trainer_log.jsonl 末行读取（文件缺席/空/末行损坏＝null；末行取最后一条非空行）。 */
export const readTrainerLogTail = (runDir: string): TrainerLogTail | null => {
  const path = join(runDir, "training", "trainer_log.jsonl");
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const parsed = parseTrainerLogLine(lines[i] as string);
      if (parsed !== null) return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

/** iteration-config num_train_epochs 读取（两候选路径沿 confirmFace 同款；缺/非法＝null）。 */
export const readNumTrainEpochs = (runDir: string): number | null => {
  for (const rel of ["prep/iteration-config.json", "prep/iteration-config/iteration-config.json"]) {
    const path = join(runDir, rel);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { training?: Record<string, unknown> };
      const v = raw.training?.["num_train_epochs"];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* 下一路候选 */ }
  }
  return null;
};

/** progress 组装（纯函数）：epoch 语义轮次（round＝当前轮 1-based＝floor(epoch)+1，
 *  numEpochs 可得时封顶），percentage additive 键；
 *  total_rounds 仅在 numEpochs 可得时写（缺源不造数）。 */
export const buildProgressFromTrainerLog = (tail: TrainerLogTail, numEpochs: number | null, nowIso: string): RunProgress => {
  // 批㊶-TRAIN-OBS：epoch 可选（真实终态行缺 epoch 形态兜底）；eta_s 由 remaining_time 换算
  // （缺失/形态不符＝不写字段——T2 缺数不占位）。
  const round = tail.epoch !== null ? Math.floor(tail.epoch) + 1 : 1;
  const eta = tail.remaining_time !== null ? parseRemainingTimeSeconds(tail.remaining_time) : null;
  return {
    round: numEpochs !== null ? Math.min(numEpochs, round) : round,
    ...(numEpochs !== null ? { total_rounds: numEpochs } : {}),
    step_remaining: Math.max(0, tail.total_steps - tail.current_steps),
    loss: tail.loss ?? undefined,
    percentage: tail.percentage,
    ...(eta !== null ? { eta_s: eta } : {}),
    updated_at: nowIso,
  };
};

/** 段内进度人读文案（浮卡段明细行）："第 6/8 轮 · 剩余 17 步 · loss 0.0589"。 */
export const formatProgressDetail = (progress: RunProgress): string | null => {
  // 批㊶-TRAIN-OBS T2：percentage/eta additive（缺数不占位——不显示 null/占位符）。
  const parts: string[] = [];
  if (typeof progress.percentage === "number" && Number.isFinite(progress.percentage)) {
    parts.push(`${progress.percentage}%`);
  }
  if (typeof progress.round === "number" && Number.isFinite(progress.round)) {
    parts.push(typeof progress.total_rounds === "number" && Number.isFinite(progress.total_rounds)
      ? `第 ${progress.round}/${progress.total_rounds} 轮`
      : `第 ${progress.round} 轮`);
  }
  if (typeof progress.step_remaining === "number" && Number.isFinite(progress.step_remaining)) {
    parts.push(`剩余 ${progress.step_remaining} 步`);
  }
  const eta = formatEta(progress.eta_s);
  if (eta !== null) {
    parts.push(`预计剩 ${eta}`);
  }
  if (typeof progress.loss === "number" && Number.isFinite(progress.loss)) {
    parts.push(`loss ${progress.loss}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
};

/** 收起徽标训练中态文案："第 6/8 轮"（无 round 回退 null——调用方回退"段 N/8"）。 */
export const formatProgressBadge = (progress: RunProgress | null): string | null => {
  if (progress === null || typeof progress.round !== "number" || !Number.isFinite(progress.round)) return null;
  return typeof progress.total_rounds === "number" && Number.isFinite(progress.total_rounds)
    ? `第 ${progress.round}/${progress.total_rounds} 轮`
    : `第 ${progress.round} 轮`;
};

// ── 段序守卫 ──

/** 八段管线顺序（与 snapshot SEGMENTS 键同源序）。 */
export const SEGMENT_ORDER: readonly string[] = [
  "register", "label_qc", "experiment_config", "publish", "split", "admission", "training", "evaluate",
];

/** 段序守卫：后段 done 的成立前提＝前段 done 已成立（逐前序段检查；任一未 done 即抑制）。
 *  @param segment 目标段键
 *  @param anchorDone 锚推导结果（在场即 true）
 *  @param doneMap 全段 done 布尔图（含事实轨与锚，先于本守卫装配）
 */
export const orderGuarded = (segment: string, anchorDone: boolean, doneMap: Readonly<Record<string, boolean>>): boolean => {
  if (!anchorDone) return false;
  const at = SEGMENT_ORDER.indexOf(segment);
  if (at <= 0) return anchorDone;
  for (let i = 0; i < at; i += 1) {
    if (doneMap[SEGMENT_ORDER[i] as string] !== true) return false;
  }
  return true;
};
