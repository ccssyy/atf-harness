/**
 * 批B1——run 显示名（RunDisplay/v1）：不编造、缺数据按降级规则、用户名优先（指令 B1 §二）。
 *
 * - autoTitle：<单据名> · <模型短名> · <MM-DD HH:mm>；
 *   单据名＝experiment-setup/field-config.json 的 document_zh（缺则 document_type）；
 *   模型短名＝iteration-config base_model.path 的 basename 去 -Instruct/-AWQ 后缀；
 *   时间＝iteration-config.json mtime（缺则 runDir mtime）。
 * - 降级：缺两项以上 → <workspace> · <MM-DD>；仍缺 → 实验 <run_id 末6位>（不拼随机串）。
 * - 用户改名写 <run>/webui/display.json（source=user，仅在用户改名时存在），优先于 auto。
 * - title 不含 workspace（B2 用次行/前缀处理同名——设计要点 §三.2 owner 批准）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { enumerateBindingCandidates, type BindingCandidateEntry } from "./sessionBindings.js";
import { hasRunMarkers } from "./runLayout.js";

export const DISPLAY_SCHEMA_VERSION = "RunDisplay/v1";

export interface RunDisplayDoc {
  schema_version: string;
  title: string;
  source: "user";
  updated_at: string;
}

/** iteration-config 双形态候选（与 checkStartModelPath/runFacts 同面——prep/ 平铺与目录两形态）。 */
const iterationConfigPaths = (runDir: string): string[] => [
  join(runDir, "prep", "iteration-config.json"),
  join(runDir, "prep", "iteration-config", "iteration-config.json"),
];

const readJsonFile = (abs: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** 模型短名：basename 后循环去 -Instruct／-AWQ 后缀（Qwen3-VL-32B-Instruct-AWQ → Qwen3-VL-32B）。 */
export const shortModelName = (modelPath: string): string => {
  let name = modelPath.split("/").filter(Boolean).pop() ?? modelPath;
  for (;;) {
    if (name.endsWith("-Instruct")) name = name.slice(0, -"-Instruct".length);
    else if (name.endsWith("-AWQ")) name = name.slice(0, -"-AWQ".length);
    else break;
  }
  return name;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** mtime → 本地时区 MM-DD HH:mm（stat 失败＝null 不猜）。 */
export const formatMdHm = (mtimeMs: number): string | null => {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  const d = new Date(mtimeMs);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** mtime → 本地时区 MM-DD（同上降级面）。 */
const formatMd = (mtimeMs: number): string | null => {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  const d = new Date(mtimeMs);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const fileMtimeMs = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * 自动显示名（纯函数面——只读 run 目录产物，不编造）：
 * 三件齐/缺一件 → 逐件拼接（缺件跳过）；缺两项以上 → <workspace> · <MM-DD>；
 * 仍缺（无 workspace 或无时刻）→ 实验 <run_id 末6位>。runId 缺省取 basename(runDir)。
 */
export const autoTitle = (runDir: string, workspace?: string | null, runId?: string): string => {
  const id = runId !== undefined && runId !== "" ? runId : basename(runDir);
  // 单据名：field-config document_zh ＞ document_type；缺＝不算件（不落 "—" 占位）
  let doc: string | null = null;
  const fieldConfig = readJsonFile(join(runDir, "experiment-setup", "field-config.json"));
  if (fieldConfig !== null) {
    const zh = fieldConfig["document_zh"];
    const type = fieldConfig["document_type"];
    if (typeof zh === "string" && zh.trim() !== "") doc = zh.trim();
    else if (typeof type === "string" && type.trim() !== "") doc = type.trim();
  }
  // 模型短名：iteration-config base_model.path basename 去后缀
  let model: string | null = null;
  let configMtimeMs = 0;
  for (const path of iterationConfigPaths(runDir)) {
    if (!existsSync(path)) continue;
    const iter = readJsonFile(path);
    if (iter === null) continue;
    const baseModel = iter["base_model"];
    const modelPath = baseModel !== null && typeof baseModel === "object" ? (baseModel as Record<string, unknown>)["path"] : undefined;
    if (typeof modelPath === "string" && modelPath.trim() !== "") model = shortModelName(modelPath.trim());
    configMtimeMs = fileMtimeMs(path);
    break; // 首个可读候选即权威（与 recordedFieldConfigSha 同序）
  }
  const time = formatMdHm(configMtimeMs !== 0 ? configMtimeMs : fileMtimeMs(runDir));
  const parts = [doc, model, time].filter((p): p is string => p !== null);
  if (parts.length >= 2) return parts.join(" · ");
  // 缺两项以上降级：<workspace> · <MM-DD>
  const day = formatMd(configMtimeMs !== 0 ? configMtimeMs : fileMtimeMs(runDir));
  if (workspace !== null && workspace !== undefined && workspace !== "" && day !== null) return `${workspace} · ${day}`;
  // 仍缺：实验 <run_id 末6位>（不编造）
  return `实验 ${id.slice(-6)}`;
};

/** 读用户改名（<run>/webui/display.json——仅在用户改名时存在；缺/坏＝null）。 */
export const readDisplay = (runDir: string): RunDisplayDoc | null => {
  const parsed = readJsonFile(join(runDir, "webui", "display.json"));
  if (parsed === null) return null;
  if (typeof parsed["title"] !== "string" || (parsed["title"] as string).trim() === "") return null;
  if (parsed["source"] !== "user") return null; // 用户名才优先（auto 形态不入盘）
  return parsed as unknown as RunDisplayDoc;
};

/** 写用户改名（tmp＋rename 原子；失败返回 false 不抛——改名为锦上添花不阻塞主流程）。 */
export const writeDisplay = (runDir: string, title: string): boolean => {
  const doc: RunDisplayDoc = { schema_version: DISPLAY_SCHEMA_VERSION, title, source: "user", updated_at: new Date().toISOString() };
  try {
    mkdirSync(join(runDir, "webui"), { recursive: true });
    const target = join(runDir, "webui", "display.json");
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
};

/** 生效显示名：用户改名优先，否则 autoTitle（title 恒不含 workspace）。 */
export const displayOf = (runDir: string, runId: string, workspace?: string | null): string => {
  const user = readDisplay(runDir);
  return user !== null ? user.title : autoTitle(runDir, workspace, runId);
};

// ── 候选组装（端点 recent/candidates 与工具 run_binding_required 共用单源）──────────────

export interface RunCandidate {
  run_id: string;
  workspace: string | null;
  title: string;
  /** run 目录 mtime（ISO——recent 列表排序依据的透传面）。 */
  mtime?: string;
}

/**
 * 候选清单：本工作区（preferWorkspace）优先、各自 mtime 倒序、≤max。
 * 特征过滤＝runLayout hasRunMarkers（防 atf-ui 等非 run 目录混入）。
 */
export const buildRunCandidates = (runsRoot: string, preferWorkspace: string | null | undefined, max: number): RunCandidate[] => {
  const entries: BindingCandidateEntry[] = enumerateBindingCandidates(runsRoot).filter((entry) => {
    try {
      return statSync(entry.dir).isDirectory() && hasRunMarkers(entry.dir);
    } catch {
      return false;
    }
  });
  const prefer = (entry: BindingCandidateEntry): number =>
    preferWorkspace !== null && preferWorkspace !== undefined && preferWorkspace !== "" && entry.workspace === preferWorkspace ? 0 : 1;
  const sorted = [...entries].sort((a, b) => prefer(a) - prefer(b) || b.mtimeMs - a.mtimeMs);
  return sorted.slice(0, Math.max(0, max)).map((entry) => ({
    run_id: entry.runId,
    workspace: entry.workspace,
    title: displayOf(entry.dir, entry.runId, entry.workspace),
    ...(entry.mtimeMs > 0 ? { mtime: new Date(entry.mtimeMs).toISOString() } : {}),
  }));
};
