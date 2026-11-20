/**
 * 受控执行 env 的键归属**单源**（`atf_bash` 与 `atf_scratch_exec` 两条通道共用一份判定）。
 *
 * ## 为什么要有这个文件
 *
 * 两条受控执行通道各自维护过一份 env 白名单，`LD_LIBRARY_PATH` 就是这样漏掉的：
 * scratch 侧显式带、bash 侧没有 → 同一个容器里「python3 在 scratch 里能跑、在 bash 里
 * 连解释器自身都起不来」（`error while loading shared libraries: libpython3.10.so.1.0`）。
 * 键的**归属**（哪些是解释器运行时必需、哪些是会话键、哪些 ATF 面可透传、哪些永不透传）
 * 从此只在这里判定；任何一条通道要加键，改这里一处，不再各写一份。
 *
 * ## 为什么只合并「键清单」不合并「装配函数」
 *
 * 两条通道语义不同，硬合成一个函数会串味：
 * - `atf_bash` 是通用 shell——**不给** `PYTHONPATH`／`PYTHONUTF8`，否则用户跑自己的
 *   python 项目会被内核源码路径污染；
 * - `atf_scratch_exec` 是内核 python 执行器——**必须** `PYTHONPATH=<内核>/src` 与
 *   `PYTHONUTF8=1`。
 *
 * 所以：键清单与凭据禁区单源在此，各自的装配值（PATH 组成、PYTHONPATH 落点等）仍归各自通道。
 */

/**
 * 解释器运行时依赖键：缺了连 `python3` 自身都起不来（容器内是本地编译版，需它加载
 * `libpython3.10.so.1.0`），扩展模块更不用说。纯路径列表、无凭据语义——两条通道一致放行，
 * 且**不得**因「白名单只放业务键」的理由被移除（移除即现场表现为「python3 坏了」）。
 */
export const RUNTIME_ENV_KEYS: readonly string[] = ["LD_LIBRARY_PATH"];

/** 会话基础键（可执行搜索路径／对端隔离 home／locale／临时目录／终端类型）。两通道一致。 */
export const SESSION_ENV_KEYS: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];

/**
 * ATF 面具名键（bash 只放行这两个具名项；scratch 另有 `ATF_*` 前缀通配＋凭据禁区过滤）。
 * 具名而非前缀通配，是为了让 bash 通道的放行面可穷举、可审计。
 */
export const ATF_NAMED_ENV_KEYS: readonly string[] = ["ATF_CLI_PATH", "ATF_WORKSPACE_ROOT"];

/**
 * 凭据禁区：键名命中即**永不**透传（脱敏红线，两通道一致）。
 * 覆盖 `ATF_LLM_*`（模型密钥）与任意含 KEY/TOKEN/SECRET/PASSWORD/PASSWD 的键。
 */
export const ENV_DENY_PATTERN = /(ATF_LLM_|KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

/**
 * `atf_bash` 白名单＝三类键的有序并集。
 *
 * 顺序即 env 覆盖先后（后者不做覆盖，只按序取值），**保持既有顺序不变**——
 * 加键只能追加，重排会改变行为面。
 */
export const CONTROLLED_BASH_ENV_KEYS: readonly string[] = [
  ...SESSION_ENV_KEYS,
  ...ATF_NAMED_ENV_KEYS,
  ...RUNTIME_ENV_KEYS,
];

/**
 * 从宿主 env 取「运行时必需」键（交给 scratch 通道合并进 env）。
 *
 * 命中凭据禁区者跳过——`LD_LIBRARY_PATH` 这类纯路径键不会命中，但若将来往
 * `RUNTIME_ENV_KEYS` 里加键，这条过滤保证凭据仍进不了子进程。
 *
 * @param hostEnv - 宿主 env（通常 `process.env`）。
 * @returns 键值对（空值跳过，与 bash 通道同口径）。
 */
export const runtimeEnvOf = (hostEnv: NodeJS.ProcessEnv): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    if (ENV_DENY_PATTERN.test(key)) continue;
    const value = hostEnv[key];
    if (typeof value === "string" && value !== "") picked[key] = value;
  }
  return picked;
};

/**
 * 按白名单从宿主 env 取值（bash 通道用）。
 *
 * @param hostEnv - 宿主 env。
 * @returns 白名单内的键值对（空值跳过）。
 */
export const bashEnvOf = (hostEnv: NodeJS.ProcessEnv): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const key of CONTROLLED_BASH_ENV_KEYS) {
    const value = hostEnv[key];
    if (value !== undefined && value !== "") picked[key] = value;
  }
  return picked;
};
