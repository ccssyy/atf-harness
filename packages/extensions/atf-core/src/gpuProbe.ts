/**
 * D88-A——GPU 探针三态化（探针归一面）：nvidia-smi 探活结果不再折成 boolean。
 *
 * 动机（A800-5005 实测）：本机 `nvidia-smi -L` min 3.23s／med 3.26s／max 3.47s，
 * `--query-gpu=index` min 0.31s／med 3.26s／max 6.25s（正常机器 <0.5s——这台机本身就要
 * 3.3s）。旧实现把「非零退出／ENOENT／execFileSync timeout」一律折成 false，再统一报
 * 「nvidia-smi 不可达（GPU 不可见或驱动异常）」：探针超时被误报成机器故障（实际 rc=0、
 * 8 卡可见），操作者去查驱动/挂载，白查一轮。
 *
 * 归一纪律：**归一在探针层，致命性判定在消费层**。本模块只回答「这次探活是什么状态」，
 * 不回答「该不该拒绝启动」——bootPreflight（启动闸）与 webui/readOnlyTools（展示面）
 * 各自按自己的缺省预算与豁免规则判。timeout 是独立态，任何消费层都不得把它折成
 * failed／unavailable（本批判据级红线）。
 *
 * 预算：同一 env 变量 ATF_GPU_PROBE_TIMEOUT_MS、两个消费方各自缺省
 * （启动闸 30s／展示面 10s）——结构性排除「卡面说离线但机器好」：两边永远读同一变量、
 * 两边都不折叠超时，只是各自缺省不同。
 * **不重试**：抖动源是负载，重试只推迟失败且给负载再加压（10s 预算 ≈ 3x 中位数／1.6x
 * 实测峰值，load 25~29 时必然越界——该调预算就调预算，不靠重试撞运气）。
 */
import { spawn, spawnSync } from "node:child_process";

/**
 * 探针归一结果（探针层唯一输出形状）。
 *  - ok：rc=0（只说明命令回得来）
 *  - failed：命令跑起来了但非零退出（带 code＋stderr——证据不丢）
 *  - timeout：预算内没回（带 elapsed_ms／budget_ms——操作者据此判「负载还是真故障」）
 *  - unavailable：命令起不来（ENOENT 等，机器上根本没这个东西）
 */
export type ProbeResult =
  | { status: "ok"; elapsedMs: number }
  | { status: "failed"; code: string; stderr: string; elapsedMs: number }
  | { status: "timeout"; elapsedMs: number; budgetMs: number }
  | { status: "unavailable"; code: string; stderr: string };

/** 预算 env（同一变量，两个消费方各自缺省。禁整包 process.env 透传进缓存键）。 */
export const GPU_PROBE_TIMEOUT_ENV = "ATF_GPU_PROBE_TIMEOUT_MS";
/** 启动闸缺省预算：本机实测峰值 6.25s，30s ≈ 5x 峰值（load 25~29 亦在界内）。 */
export const GPU_PROBE_BOOT_DEFAULT_BUDGET_MS = 30_000;
/** 展示面缺省预算：卡面刷新容忍度——10s 仍是本机中位数的 3x。 */
export const GPU_PROBE_DISPLAY_DEFAULT_BUDGET_MS = 10_000;
export const GPU_PROBE_COMMAND = "nvidia-smi";
/** 启动闸探活参数（-L 只列卡，最轻的一条）。 */
export const GPU_PROBE_LIST_ARGS: readonly string[] = ["-L"];

/** 展示面两态文案（timeout 与不可达必须可区分——一字之差决定「查负载」还是「查驱动」）。 */
export const GPU_OFFLINE_TIMEOUT_LABEL = "离线（探测超时）";
export const GPU_OFFLINE_UNREACHABLE_LABEL = "离线（不可达）";

/** 非 ok 态的展示面文案（ok 不调用本函数——调用点只在已知离线时取文案）。 */
export const gpuOfflineLabel = (probe: ProbeResult): string =>
  probe.status === "timeout" ? GPU_OFFLINE_TIMEOUT_LABEL : GPU_OFFLINE_UNREACHABLE_LABEL;

/**
 * 预算解析：env 显式合法值 ＞ 消费方缺省。
 * 非数值／非正数／空白一律回落缺省（不猜，也不把 NaN 传进 spawnSync 变成 0ms 立即超时）。
 */
export const resolveGpuProbeBudgetMs = (
  env: Record<string, string | undefined>,
  fallbackMs: number,
): number => {
  const raw = env[GPU_PROBE_TIMEOUT_ENV];
  if (raw === undefined) return fallbackMs;
  const token = raw.trim();
  if (token === "") return fallbackMs;
  const parsed = Number(token);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed);
};

/**
 * 缓存键：command + args + ATF_GPU_REQUIRED + PATH（**显式枚举**）。
 * 禁把整包 process.env 进键——ATF_APPROVAL_LEDGER 之类与本探活无关的噪音字段一变，
 * 缓存就白失效，等于没缓存。
 */
export const gpuProbeCacheKey = (
  command: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): string => JSON.stringify([command, args, env["ATF_GPU_REQUIRED"] ?? "", env["PATH"] ?? ""]);

/**
 * 进程级探针缓存（正负同寿命）。
 * 生命周期＝进程：**apply() 重建不重建本表**（模块级单例），**热重载不会重探**——探针结果
 * 一经落表即钉到进程退出。恢复需重启进程（或显式 resetProbeCache()，仅测试用）。
 * 只在启动闸 defaultCommandWorks 路径读写（probeGpuSync 的 useCache）；展示面每次真探，
 * 免得一次超时被缓存永久钉在卡面上。
 */
const probeCache = new Map<string, ProbeResult>();

/**
 * 清空探针缓存。**仅测试用**——不得作为生产运维入口（运维手段是重启实例，不是清缓存；
 * 清完下一次调用又会落一条新的负缓存，等于把「一次超时」换成「一次重探」再钉住）。
 */
export const resetProbeCache = (): void => {
  probeCache.clear();
};

/** 缓存条数（测试与运维观测用；不含内容）。 */
export const probeCacheSize = (): number => probeCache.size;

/** 原始执行结果（分类前的证据面：保留 stderr／退出码／超时标志）。 */
export interface RawProbeOutcome {
  timedOut: boolean;
  /** 退出码（被信号杀死＝null）。 */
  code: number | null;
  signal: string | null;
  /** 起不来（ENOENT 等）＝'ENOENT'；跑起来了＝null。 */
  spawnError: string | null;
  stderr: string;
  stdout: string;
}

export type RawProbeRunner = (
  command: string,
  args: readonly string[],
  budgetMs: number,
) => RawProbeOutcome;

const STDERR_LIMIT = 600;
const STDOUT_LIMIT = 4096;

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…（截断，原长 ${text.length} 字符）` : text;

/** 归一（唯一分类点）：原始证据 → ProbeResult。timeout 判定前置，绝不落入 failed。 */
export const normalizeProbeOutcome = (
  raw: RawProbeOutcome,
  elapsedMs: number,
  budgetMs: number,
): ProbeResult => {
  if (raw.timedOut) return { status: "timeout", elapsedMs, budgetMs };
  const stderr = truncate(raw.stderr, STDERR_LIMIT);
  if (raw.spawnError !== null) return { status: "unavailable", code: raw.spawnError, stderr };
  if (raw.code === 0) return { status: "ok", elapsedMs };
  const code = raw.code !== null ? `exit_${raw.code}` : `signal_${raw.signal ?? "unknown"}`;
  return { status: "failed", code, stderr, elapsedMs };
};

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";

/**
 * 同步执行器（启动闸用：runBootPreflight 是同步 API）。
 * 超时判据只用 spawnSync 的 code=ETIMEDOUT——**不靠** stderr 里有没有 timeout 字样猜。
 */
const runSyncDefault: RawProbeRunner = (command, args, budgetMs) => {
  const result = spawnSync(command, args, {
    timeout: budgetMs,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const error = result.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
  const timedOut = error?.code === "ETIMEDOUT";
  const spawnError = error !== undefined && !timedOut ? String(error.code ?? error.message) : null;
  return {
    timedOut,
    code: typeof result.status === "number" ? result.status : null,
    signal: result.signal ?? null,
    spawnError,
    stderr: textOf(result.stderr),
    stdout: textOf(result.stdout),
  };
};

/**
 * 异步执行器（展示面用：不能阻塞 webui 事件循环）。
 * 自带定时器而不是把 timeout 交给 spawn——超时判定用本进程的 flag，不猜信号来源
 * （外部 SIGTERM 与自家超时在 signal 上同形）。
 */
const runAsyncDefault = (
  command: string,
  args: readonly string[],
  budgetMs: number,
): Promise<RawProbeOutcome> =>
  new Promise<RawProbeOutcome>((resolve) => {
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      const code = cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? "EUNKNOWN") : "EUNKNOWN";
      resolve({ timedOut: false, code: null, signal: null, spawnError: String(code), stderr: "", stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      // 预算到＝立刻判超时并决断（**不等子进程 close**）：被 kill 的 nvidia-smi 若有孙进程
      // 占着 stdio 管道，close 会拖到孙进程结束——那等于把「预算」变成了「子进程树寿命」，
      // 超时上报又要晚 30s（实测 sleep 脚本形态）。kill 只是止损，判据是本进程的定时器。
      timedOut = true;
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve({ timedOut: true, code: null, signal: "SIGKILL", spawnError: null, stderr, stdout });
      }
    }, budgetMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDOUT_LIMIT) stderr += chunk;
    });
    child.on("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = (cause as NodeJS.ErrnoException).code ?? "EUNKNOWN";
      resolve({ timedOut: false, code: null, signal: null, spawnError: String(code), stderr, stdout });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal, spawnError: null, stderr, stdout });
    });
  });

export interface GpuProbeOptions {
  command?: string;
  args?: readonly string[];
  /** 本次消费方预算（启动闸 30s／展示面 10s）；缺省按消费方缺省值回落。 */
  budgetMs?: number;
  /** 预算 env 面（显式枚举进缓存键）。缺省空表——不隐式读 process.env（缓存键才可知）。 */
  env?: Record<string, string | undefined>;
  /** 缓存开关：仅启动闸 defaultCommandWorks 路径置 true（见 probeCache 注释）。 */
  useCache?: boolean;
  /** 测试注入：同步执行器（计数 spawn 次数／造超时，不真起进程）。 */
  runSync?: RawProbeRunner;
  /** 测试注入：异步执行器。 */
  runAsync?: (command: string, args: readonly string[], budgetMs: number) => Promise<RawProbeOutcome>;
}

/** 探针一次（同步·带 stdout 证据；启动闸只用 result 面）。 */
export const captureGpuProbeSync = (
  options: GpuProbeOptions = {},
): { result: ProbeResult; stdout: string } => {
  const command = options.command ?? GPU_PROBE_COMMAND;
  const args = options.args ?? GPU_PROBE_LIST_ARGS;
  const env = options.env ?? {};
  const budgetMs = options.budgetMs ?? resolveGpuProbeBudgetMs(env, GPU_PROBE_BOOT_DEFAULT_BUDGET_MS);
  const key = gpuProbeCacheKey(command, args, env);
  if (options.useCache === true) {
    const hit = probeCache.get(key);
    if (hit !== undefined) return { result: hit, stdout: "" };
  }
  const started = Date.now();
  const raw = (options.runSync ?? runSyncDefault)(command, args, budgetMs);
  const result = normalizeProbeOutcome(raw, Date.now() - started, budgetMs);
  if (options.useCache === true) probeCache.set(key, result);
  return { result, stdout: raw.stdout };
};

/** 探针一次（同步·只取归一结果）。 */
export const probeGpuSync = (options: GpuProbeOptions = {}): ProbeResult =>
  captureGpuProbeSync(options).result;

/** 探针一次（异步·带 stdout 证据；展示面解析用）。 */
export const captureGpuProbeAsync = async (
  options: GpuProbeOptions = {},
): Promise<{ result: ProbeResult; stdout: string }> => {
  const command = options.command ?? GPU_PROBE_COMMAND;
  const args = options.args ?? GPU_PROBE_LIST_ARGS;
  const env = options.env ?? {};
  const budgetMs = options.budgetMs ?? resolveGpuProbeBudgetMs(env, GPU_PROBE_DISPLAY_DEFAULT_BUDGET_MS);
  const key = gpuProbeCacheKey(command, args, env);
  if (options.useCache === true) {
    const hit = probeCache.get(key);
    if (hit !== undefined) return { result: hit, stdout: "" };
  }
  const started = Date.now();
  const raw = await (options.runAsync ?? runAsyncDefault)(command, args, budgetMs);
  const result = normalizeProbeOutcome(raw, Date.now() - started, budgetMs);
  if (options.useCache === true) probeCache.set(key, result);
  return { result, stdout: raw.stdout };
};

/** 探针一次（异步·只取归一结果）。 */
export const probeGpuAsync = async (options: GpuProbeOptions = {}): Promise<ProbeResult> =>
  (await captureGpuProbeAsync(options)).result;

/** 证据单行（fatal／卡面共用：timeout 必带 elapsed_ms／budget_ms）。 */
export const formatProbeEvidence = (probe: ProbeResult): string => {
  switch (probe.status) {
    case "ok":
      return `elapsed_ms=${probe.elapsedMs}`;
    case "timeout":
      return `elapsed_ms=${probe.elapsedMs} budget_ms=${probe.budgetMs}`;
    case "failed":
      return `code=${probe.code} elapsed_ms=${probe.elapsedMs}${probe.stderr.trim() !== "" ? ` stderr=${probe.stderr.trim()}` : ""}`;
    case "unavailable":
      return `code=${probe.code}${probe.stderr.trim() !== "" ? ` stderr=${probe.stderr.trim()}` : ""}`;
  }
};
