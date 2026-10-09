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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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

// ── 段内进度 ──

export interface RunProgress {
  round?: number;
  total_rounds?: number;
  step_remaining?: number;
  eta_s?: number;
  loss?: number;
  updated_at: string;
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

/** 写进度（写失败静默；字段缺省可空由调用方组装）。 */
export const writeProgress = (runDir: string, progress: RunProgress): void => {
  try {
    const dir = join(runDir, "webui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(progressPathOf(runDir), `${JSON.stringify(progress, null, 1)}\n`, "utf8");
  } catch {
    // fail-open
  }
};

/** fresh 判定：updated_at 在新鲜窗口内（解析失败/过期＝false）。 */
export const progressFresh = (progress: RunProgress | null, nowMs: number, windowMs: number): boolean => {
  if (progress === null) return false;
  const at = Date.parse(progress.updated_at);
  if (!Number.isFinite(at)) return false;
  return nowMs - at <= windowMs;
};

/** 段内进度人读文案（浮卡段明细行）："第 6/8 轮 · 剩余 17 步 · loss 0.0589"。 */
export const formatProgressDetail = (progress: RunProgress): string | null => {
  const parts: string[] = [];
  if (typeof progress.round === "number" && Number.isFinite(progress.round)) {
    parts.push(typeof progress.total_rounds === "number" && Number.isFinite(progress.total_rounds)
      ? `第 ${progress.round}/${progress.total_rounds} 轮`
      : `第 ${progress.round} 轮`);
  }
  if (typeof progress.step_remaining === "number" && Number.isFinite(progress.step_remaining)) {
    parts.push(`剩余 ${progress.step_remaining} 步`);
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
