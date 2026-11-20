/**
 * 批㊶R前置——本机模型清单状态面（防线③的清单回流源；§2.4 状态面）。
 *
 * 单源：扫描 `<ATF_MODEL_ROOT>/`（env 注入——实例层 deploy/instances/*.env 声明；
 * 产品资产零具体绝对路径）一级目录的
 * 子目录名＝本机可用模型（内核生成面/报告面防线的清单同源口径）。消费面：
 *   ① atf-tools apply 启动扫描→boot 日志（操作员状态投影）＋atf_run_training 工具描述（agent 可见）；
 *   ② trainingFace start 面复核失败时回流 `models` 清单（与探活回传同族形态）。
 * 目录缺席/不可读＝如实空清单＋error 标注（不猜测、不编造模型名）。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MODEL_ROOT_ENV = "ATF_MODEL_ROOT";

export interface LocalModelInventory {
  root: string;
  models: string[];
  /** root 缺席/未配置/不可读时的如实标注（models=空清单并存）。 */
  error?: "model_root_unset" | "model_root_missing" | "model_root_unreadable";
}

export interface SourcedModel {
  name: string;
  /** 来源标注（批㊶-S1 段 3：ATF_MODEL_ROOT＝model-root；发布库位＝publish-root） */
  source: "model-root" | "publish-root";
}

/** 批㊶-S1 段 3：两源合并（ATF_MODEL_ROOT＋发布库位〈统一根>/models——同名词取先、来源标注区分）。 */
export const mergePublishedModels = (primary: LocalModelInventory, published: string[]): LocalModelInventory => {
  const seen = new Set(primary.models);
  const merged = [...primary.models];
  const extra: SourcedModel[] = [];
  for (const name of published) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
    extra.push({ name, source: "publish-root" });
  }
  return { ...primary, models: merged };
};

/** 根解析（env-only——未配置＝null 如实，不设缺省绝对路径）。 */
export const modelRootOf = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const raw = env[MODEL_ROOT_ENV];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
};

/** 一级目录扫描（目录名升序；非目录/点前缀不入列；root 缺席＝空清单＋error 标注）。 */
export const scanLocalModels = (
  env: Readonly<Record<string, string | undefined>>,
  rootOverride?: string,
): LocalModelInventory => {
  const root = rootOverride ?? modelRootOf(env);
  if (root === null) return { root: "", models: [], error: "model_root_unset" };
  if (!existsSync(root)) return { root, models: [], error: "model_root_missing" };
  try {
    const models = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    return { root, models };
  } catch {
    return { root, models: [], error: "model_root_unreadable" };
  }
};
