/**
 * 批㊶-H/I 白名单根派生（产品层零具体目录——owner 增补裁定：产品/实例分层）。
 *
 * 派生规则＝配置声明面逐项镜像（env 名与声明文件，值全部运行期解析）：
 *   ① ATF_DSH_RUNS_ROOT           → 桥 runs 根（W-runs；scratch 约定 `<runs>/<run_id>/scratch` 在其内）
 *   ② $HOME/.atf/config.json      → workspace_root（内核配置根声明）
 *   ③ $HOME/.atf/env-profiles/*.json → train_env/eval_env 非 "system" 值（venv 声明根）
 *   ④ ATF_DSH_KERNEL_DIR ?? ATF_CLI_PATH → 内核源侧根
 *   ⑤ ATF_DSH_EXEC_HOME / ATF_DSH_LOG_DIR → exec 家目录／日志写入位
 *   ⑥ ATF_V1_FILE_TOOL_ROOTS      → 实例附加集（追加语义——非派生覆盖的目录全部走这里，
 *      由 per-instance overlay 登记声明；产品资产零具体路径）
 *
 * 本文件（及一切产品资产）不得出现具体绝对路径（守护测试 staticNoHardcodedPaths 钉死）；
 * 换环境/换机器＝改实例配置，白名单随声明面自动重建。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 白名单根派生输入（env 必传——纯函数可注入 fs 读取做守卫测试）。 */
export interface DeriveFileRootsInput {
  env: NodeJS.ProcessEnv;
  /** 声明文件读取（缺省 node:fs 同步读；守卫测试注入内存桩）。 */
  readFile?: (path: string) => string | null;
  /** 目录枚举（缺省 node:fs；守卫测试注入桩）。 */
  readDir?: (path: string) => string[];
}

export interface DerivedFileRoots {
  /** 有序去重根（派生集在前、env 附加集在后——附加集不得收窄派生集）。 */
  roots: string[];
  /** 逐根来源标注（与 roots 等长——守护测试②"派生集＝声明面"的断言面）。 */
  sources: string[];
}

const KERNEL_CONFIG_RELPATH = join(".atf", "config.json");
const ENV_PROFILES_RELPATH = join(".atf", "env-profiles");

const defaultReadFile = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const defaultReadDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/** 从一份 env-profile JSON 文本提取声明根：train_env/eval_env 非 "system"/空值。 */
export const rootsFromEnvProfileText = (text: string): string[] => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const values: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && value !== "system") values.push(value);
  };
  if (doc !== null && typeof doc === "object") {
    const train = (doc as Record<string, unknown>)["train"];
    push((doc as Record<string, unknown>)["eval_env"]);
    if (train !== null && typeof train === "object") {
      push((train as Record<string, unknown>)["train_env"]);
      push((train as Record<string, unknown>)["eval_env"]);
    }
  }
  return values;
};

/** 白名单根派生（配置声明面逐项镜像；单一实现——守卫测试②钉死派生集＝声明面）。 */
export const deriveFileToolRoots = (input: DeriveFileRootsInput): DerivedFileRoots => {
  const readFile = input.readFile ?? defaultReadFile;
  const readDir = input.readDir ?? defaultReadDir;
  const env = input.env;
  const roots: string[] = [];
  const sources: string[] = [];
  const push = (raw: string | undefined, source: string): void => {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") return;
    if (roots.includes(value)) return;
    roots.push(value);
    sources.push(source);
  };
  // ① 桥 runs 根（scratch 约定在其内）
  push(env["ATF_DSH_RUNS_ROOT"], "env:ATF_DSH_RUNS_ROOT");
  // ② 内核配置根声明（workspace_root）
  const home = env["HOME"] ?? "";
  if (home !== "") {
    const configText = readFile(join(home, KERNEL_CONFIG_RELPATH));
    if (configText !== null) {
      try {
        const workspaceRoot = (JSON.parse(configText) as Record<string, unknown>)["workspace_root"];
        push(typeof workspaceRoot === "string" ? workspaceRoot : undefined, "config:workspace_root");
      } catch {
        // 配置根不可解析 → 该声明面缺席（不猜不回退）
      }
    }
    // ③ env-profiles 声明根（venv 等）
    for (const entry of readDir(join(home, ENV_PROFILES_RELPATH))) {
      if (!entry.endsWith(".json")) continue;
      const text = readFile(join(home, ENV_PROFILES_RELPATH, entry));
      if (text === null) continue;
      for (const root of rootsFromEnvProfileText(text)) push(root, `env-profile:${entry}`);
    }
  }
  // ④ 内核源侧
  push(env["ATF_DSH_KERNEL_DIR"] ?? env["ATF_CLI_PATH"], "env:ATF_DSH_KERNEL_DIR");
  // ⑤ exec 家目录／日志位
  push(env["ATF_DSH_EXEC_HOME"], "env:ATF_DSH_EXEC_HOME");
  push(env["ATF_DSH_LOG_DIR"], "env:ATF_DSH_LOG_DIR");
  // ⑥ 实例附加集（追加在尾——overlay 声明面）
  for (const part of (env["ATF_V1_FILE_TOOL_ROOTS"] ?? "").split(":")) {
    push(part, "env:ATF_V1_FILE_TOOL_ROOTS");
  }
  return { roots, sources };
};
