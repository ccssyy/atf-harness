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
 *   ⑦ 注册工作区（A4——D2 收口）：注册表 records[].path（exists===true 记录；缺失/
 *      不可解析/读失败一律空集 fail-open 不猜不回退）——UI 建工作区免重启即可读写。
 *   ⑧ DSH 家附件目录（E8b·H4 D151）：<DSH_HOME>/attachments——用户上传附件落点
 *      （vendor 上传面契约），**只读证据面**：读通道（atf_read 与 glob/grep/read_image
 *      守卫）经本面放行；写拒在 fileTools 写闸（attachment_write_denied，atf_edit/
 *      atf_write 均拒；atf_bash 围栏可写仅 run 工作区天然不含）。仅认显式 DSH_HOME
 *      （vendor 家解析链的 homedir 兜底不是实例声明——缺省形态不派生）。
 *
 * 本文件（及一切产品资产）不得出现具体绝对路径（守护测试 staticNoHardcodedPaths 钉死）；
 * 换环境/换机器＝改实例配置，白名单随声明面自动重建。
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { listRegistryRecords, resolveDshHome } from "../core/workspace/workspaceRegistry.js";

/** 白名单根派生输入（env 必传——纯函数可注入 fs 读取做守卫测试）。 */
export interface DeriveFileRootsInput {
  env: NodeJS.ProcessEnv;
  /** 声明文件读取（缺省 node:fs 同步读；守卫测试注入内存桩）。 */
  readFile?: (path: string) => string | null;
  /** 目录枚举（缺省 node:fs；守卫测试注入桩）。 */
  readDir?: (path: string) => string[];
  /** 注册工作区清单（缺省＝注册表实读——registry:workspace 派生面；守卫测试注入桩）。 */
  listRegistryWorkspaces?: () => ReadonlyArray<{ path: string }>;
  /** realpath 归一（缺省 node:fs；解析失败＝null 按字面去重——D2 realpath 去重测试桩面）。 */
  realpath?: (path: string) => string | null;
}

export interface DerivedFileRoots {
  /** 有序去重根（派生集在前、env 附加集在后——附加集不得收窄派生集）。 */
  roots: string[];
  /** 逐根来源标注（与 roots 等长——守护测试②"派生集＝声明面"的断言面）。 */
  sources: string[];
  /** 被实例定域闸排除的注册工作区（空数组＝无排除；调用方须如实投影，禁止静默）。
   *  reason 闭集见 {@link WORKSPACE_OUT_OF_INSTANCE}。 */
  excluded: Array<{ path: string; reason: string }>;
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

/** ⑦ 注册工作区实读（缺省实现）：exists===true 记录的 path；注册表缺席/不可解析/读失败
 *  一律空集（fail-open——不猜不回退，沿 listRegistryRecords 既有语义外再兜一层）。
 *  D2 收口：跳过时留一条可诊断日志（坏 JSON/形态非法可从 boot 日志定位——不阻断启动）。 */
const defaultRegistryWorkspaces = (env: NodeJS.ProcessEnv): (() => ReadonlyArray<{ path: string }>) => () => {
  try {
    return listRegistryRecords(resolveDshHome(env))
      .filter((record) => record.exists)
      .map((record) => ({ path: record.path }));
  } catch (cause) {
    console.warn(
      `[file-roots] 注册表读取失败，⑦注册工作区派生面跳过（其余派生面不受累）: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return [];
  }
};

/** 注册工作区落在实例根外的拒绝码（定域纪律 F16 在文件围栏层的机器锚）。 */
export const WORKSPACE_OUT_OF_INSTANCE = "workspace_out_of_instance";

/** 路径是否落在根内（含根本身）。
 *
 *  逐段比较而非字符串前缀——`<根>/x` 不得匹配 `<根>/x2`（既有 workspace_init 同类教训）。
 *  两侧都先 realpath 归一（软链同一性）；归一失败按字面比较，不猜。
 *
 *  @param path - 待判路径。
 *  @param root - 根路径。
 *  @param realpath - realpath 归一函数（注入桩供守卫测试）。
 *  @returns 在根内为 true。
 */
export const withinRootOf = (
  path: string,
  root: string,
  realpath: (value: string) => string | null,
): boolean => {
  const normalize = (value: string): string => {
    const resolved = (realpath(value) ?? value).replace(/\/+$/, "");
    return resolved === "" ? "/" : resolved;
  };
  const target = normalize(path);
  const base = normalize(root);
  if (base === "/") return target.startsWith("/");
  return target === base || target.startsWith(base + "/");
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
  const realpath = input.realpath ?? ((path: string): string | null => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  });
  const env = input.env;
  const roots: string[] = [];
  const sources: string[] = [];
  // D2：去重按 realpath 归一（与既有各项归一后比对——⑥env 附加集与⑦注册表同树异写法
  // 只留首见字面；realpath 不可解析＝按字面自等去重，不猜）。存储面仍为首见字面（声明序）。
  const seenReal = new Map<string, true>();
  const push = (raw: string | undefined, source: string): void => {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") return;
    const identity = realpath(value) ?? value;
    if (seenReal.has(identity)) return;
    seenReal.set(identity, true);
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
  // ⑧ DSH 家附件目录（E8b·H4 D151——用户上传附件只读面；目录尚未创建也入集：
  // 声明面镜像语义，首次上传前 atf_read 即可定向，读到与否由文件存在性如实回答。
  // 只认显式 DSH_HOME——vendor 家解析链的 homedir 兜底不是实例声明，缺省形态不派生）。
  const dshHomeEnv = env["DSH_HOME"]?.trim() ?? "";
  if (dshHomeEnv !== "") push(join(dshHomeEnv, "attachments"), "dsh-home:attachments");
  // ⑦ 注册工作区（A4——UI 建工作区免重启可读写；热加载见 fileGuardFace.startFileRootsHotReload）。
  // 清单获取失败（注入桩抛错/实读异常）＝空集 fail-open——派生面永不因注册表不可读而失败。
  //
  // 定域闸（F16 纪律在围栏层的落点）：注册表是无条件接受外部写入的面——UI picker 缺省根是
  // 宿主家目录（vendor 行为），随手建一个工作区就会把实例根外目录（家目录、他人项目、/tmp）
  // 变成白名单根。故此处按"实例根内 / 已被其它派生面覆盖"两条纳入，其余排除并如实记账。
  // 实例根未声明（非实例形态）＝闸不启用（fail-open，旧行为不变）。
  const excluded: Array<{ path: string; reason: string }> = [];
  const instanceRoot = env["ATF_INSTANCE_ROOT"]?.trim() ?? "";
  const coveredByDeclared = (path: string): boolean =>
    roots.some((declared) => withinRootOf(path, declared, realpath));
  try {
    for (const entry of (input.listRegistryWorkspaces ?? defaultRegistryWorkspaces(env))()) {
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      if (path === "") continue;
      if (instanceRoot === "" || withinRootOf(path, instanceRoot, realpath) || coveredByDeclared(path)) {
        push(path, "registry:workspace");
        continue;
      }
      if (!excluded.some((item) => item.path === path)) {
        excluded.push({ path, reason: WORKSPACE_OUT_OF_INSTANCE });
      }
    }
  } catch {
    // fail-open：该声明面缺席（不猜不回退——其余派生面不受累）
  }
  return { roots, sources, excluded };
};
