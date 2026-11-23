/**
 * 批㊶-S5——存储与运行环境设置面（B1 数据层校验/派生/生效值 ＋ B3 fail-fast 语义）。
 *
 * 单源纪律（§三.1）：设置面保存写 webui settings store（storage 块）＋env-profile 档案；
 * 运行时读取保持 instance env > env-profile 现行优先级——漂移经 effectiveStorageValues
 * 投影在设置页显性呈现（设置值 vs 实际生效值），不静默双轨。
 * per-instance 派生（§三.2）：store 路径与根目录缺省均从实例自身 HOME/env 推导，零跨实例共享默认。
 * 约定子目录（§三.3，仅新建生效）：<root>/datasets｜runs｜logs 固定命名；根保存时不存在则创建；
 * 存量位置一律不动。
 */
import { existsSync, mkdirSync, accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StorageSettings } from "./settings.js";

/** 实例设置 store 路径（env ATF_DSH_SETTINGS 覆写；缺省＝<HOME>/.atf/webui-settings.json——实例 home 隔离）。 */
export const instanceSettingsPath = (env: Readonly<Record<string, string | undefined>>): string => {
  const override = env["ATF_DSH_SETTINGS"];
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return join(env["HOME"] ?? ".", ".atf", "webui-settings.json");
};

/** 根目录缺省派生（§三.2）：env ATF_ATF_ROOT ＞ runsRoot 父目录（runsRoot 以 runs 结尾时）＞未派生 null。 */
export const deriveAtfRoot = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const explicit = env["ATF_ATF_ROOT"];
  if (typeof explicit === "string" && explicit.trim() !== "") return explicit.trim();
  const runsRoot = env["ATF_DSH_RUNS_ROOT"];
  if (typeof runsRoot === "string" && runsRoot.trim() !== "") {
    const trimmed = runsRoot.replace(/\/+$/, "");
    if (trimmed.endsWith("/runs")) return dirname(trimmed);
  }
  return null;
};

export type Validation = { ok: true } | { ok: false; reason: string };

/** 目录存在＋可写（B3 fail-fast——根目录/模型库位置共用）。 */
export const validateDirWritable = (path: string): Validation => {
  if (path.trim() === "") return { ok: false, reason: "路径为空" };
  if (!existsSync(path)) return { ok: false, reason: `目录不存在：${path}` };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, reason: `不是目录：${path}` };
    accessSync(path, constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, reason: `目录不可写：${path}` };
  }
};

/** venv 特征（B3）：路径存在＋（bin/python|python3 在位 或 pyvenv.cfg 在位）。 */
export const validateVenvPath = (path: string): Validation => {
  if (path.trim() === "") return { ok: true }; // 未配置＝合法（任务发起时停下问——现行行为）
  if (!existsSync(path)) return { ok: false, reason: `路径不存在：${path}` };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, reason: `不是目录：${path}` };
    const hasPython = existsSync(join(path, "bin", "python")) || existsSync(join(path, "bin", "python3"));
    const hasCfg = existsSync(join(path, "pyvenv.cfg"));
    if (!hasPython && !hasCfg) return { ok: false, reason: `不是 venv 环境（缺 bin/python 与 pyvenv.cfg）：${path}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: `路径不可探测：${path}` };
  }
};

/** 训练卡数基线校验（B3）：正整数且 ≤ 可用卡数（拉满偏置的上界＝机器事实）。gpuCount null＝只查正整数。 */
export const validateGpuBaseline = (raw: string, gpuCount: number | null): Validation => {
  if (raw.trim() === "") return { ok: true }; // 空＝跟随探测拉满
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) return { ok: false, reason: `训练卡数基线须为正整数（得 ${raw}）` };
  if (gpuCount !== null && n > gpuCount) return { ok: false, reason: `超过本机可用卡数 ${gpuCount}（机器事实）` };
  return { ok: true };
};

/** 约定子目录（§三.3 固定命名——仅新建生效；存量位置一律不动）。 */
export const CONVENTION_SUBDIRS: readonly string[] = ["datasets", "runs", "logs"];

export const conventionSubdirsOf = (root: string): string[] => CONVENTION_SUBDIRS.map((sub) => join(root, sub));

/** 根保存时确保约定子目录在位（不存在则创建；已存在不动）。返回创建的子目录清单。 */
export const ensureConventionSubdirs = (root: string): string[] => {
  const created: string[] = [];
  for (const sub of CONVENTION_SUBDIRS) {
    const dir = join(root, sub);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        created.push(dir);
      } catch {
        // 创建失败不阻塞保存（写入时再报）
      }
    }
  }
  return created;
};

/** 生效值投影（§三.1 读取优先级：instance env ＞ 设置面值；漂移由调用方在 UI 显性呈现）。 */
export interface EffectiveStorageValues extends StorageSettings {
  /** 各字段实际生效来源：instance-env／settings／unset */
  sources: Record<keyof StorageSettings, "instance-env" | "settings" | "unset">;
}

export const effectiveStorageValues = (
  env: Readonly<Record<string, string | undefined>>,
  stored: StorageSettings,
): EffectiveStorageValues => {
  const pick = (envValue: string | undefined, setValue: string): { value: string; source: "instance-env" | "settings" | "unset" } => {
    const e = typeof envValue === "string" && envValue.trim() !== "" ? envValue.trim() : "";
    if (e !== "") return { value: e, source: "instance-env" };
    if (setValue.trim() !== "") return { value: setValue, source: "settings" };
    return { value: "", source: "unset" };
  };
  const root = pick(deriveAtfRoot(env) ?? undefined, stored.atf_root);
  const modelRoot = pick(env["ATF_MODEL_ROOT"], stored.model_root);
  const trainEnv = pick(env["ATF_TRAIN_ENV"], stored.train_env);
  const evalEnv = pick(env["ATF_EVAL_ENV"], stored.eval_env);
  return {
    atf_root: root.value,
    model_root: modelRoot.value,
    train_env: trainEnv.value,
    eval_env: evalEnv.value,
    train_gpu_baseline: stored.train_gpu_baseline,
    sources: {
      atf_root: root.source,
      model_root: modelRoot.source,
      train_env: trainEnv.source,
      eval_env: evalEnv.source,
      train_gpu_baseline: stored.train_gpu_baseline.trim() !== "" ? "settings" : "unset",
    },
  };
};
