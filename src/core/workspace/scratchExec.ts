/**
 * scratch 受控执行引擎（批 3「创作执行面」§一/§三，DDL 关键路径）。
 *
 * 职责（设计要点《ATF-Harness_批3创作执行面_设计要点_DDL合并门_20260922.md》§一）：
 * - env 白名单：PATH（解析出的 python3 目录 + 固定最小集）＋ HOME（对端隔离 home 同源）＋
 *   ATF_WORKSPACE_ROOT／ATF_SKILLS_AUTO_INSTALL（对端同源）＋ PYTHONPATH=<内核>/src（pin 唯一
 *   真相源；skills scripts 自注入 parents[3]/src 与此同值，双保险）＋ PYTHONUTF8/LANG ＋
 *   TMPDIR=<scratch>/.tmp ＋ 宿主 ATF_* 透传——排除 ATF_LLM_*（凭据不进子进程，脱敏红线）
 *   与键名含 KEY/TOKEN/SECRET/PASSWORD/PASSWD 的变量；其余宿主 env 一律不继承；
 * - argv[0] 白名单：python3/python 解释器，或 .py 脚本（<内核>/skills/** 或 scratch 内）——
 *   一切放行执行统一经解析出的 python3 解释器 spawn（无 shell、无第二二进制入口）；
 *   launch.sh/train.sh 不是合法 argv[0]（harness 专执行点，见 atf_launch_execute）；
 * - 上限：stdout 16 KiB（超限截断＋知情尾标，管道继续排空防背压死锁）、stderr tail 8 KiB、
 *   超时 SIGTERM（5s 宽限后 SIGKILL）；cwd 恒为 scratch；
 * - G5 检测（确定性，harness 侧）：扫 scratch（深度≤5、跳点目录）找 launch.sh，从脚本文本
 *   解析 TRAIN_DIR → 读 launch_manifest.json → 按 iteration_config_sha256 与 scratch 内
 *   IterationConfig/v1 字节级 sha256 对拍（对不上不给 config，fail-honest）。
 *
 * 边界声明：OS 级硬隔离不可得（零 npm 运行时依赖），本引擎提供的是「argv 白名单＋env 定向＋
 * cwd/TMPDIR 归 scratch＋上限」的实用 containment；子进程内部再 spawn 不在本引擎可控面。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";
import { safeScratchPath } from "./runWorkspace.js";

/** stdout 字节上限（超出截断；管道继续排空）。 */
export const SCRATCH_EXEC_STDOUT_CAP_BYTES = 16 * 1024;
/** stderr 保留尾部字节上限。 */
export const SCRATCH_EXEC_STDERR_TAIL_BYTES = 8 * 1024;
/** 执行超时缺省值（模型可用 timeout_seconds 覆盖，1..3600s）。 */
export const SCRATCH_EXEC_TIMEOUT_MS_DEFAULT = 120_000;
/** atf_scratch_write 内容字节上限（T0 写入体量守卫）。 */
export const SCRATCH_WRITE_MAX_BYTES = 1024 * 1024;
/** scratch 扫描深度上限（launch 检测）。 */
const SCRATCH_SCAN_DEPTH_MAX = 5;
/** 检测扫描中参与 IterationConfig 对拍的文件大小上限。 */
const SCAN_JSON_MAX_BYTES = 256 * 1024;
/** launch.sh 执行等待上限（未退出不杀，转后台跟踪）。 */
export const LAUNCH_WAIT_MS_DEFAULT = 120_000;

/** python3 解释器解析：显式注入 > 常见绝对路径探测 > 交由 PATH 解析的 "python3"。 */
export const findPython3 = (override?: string): string => {
  if (override !== undefined && override !== "" && existsSync(override)) return override;
  for (const candidate of ["/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python3";
};

/** 脱敏透传拒绝键：ATF_LLM_*（凭据）与键名含敏感词的 ATF_* 一律不进子进程 env。 */
const ENV_DENY = /(ATF_LLM_|KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;

/**
 * 构造受控执行 env（白名单；禁继承宿主任意 env——设计要点 §一）。
 * baseEnv＝对端同源键（HOME/ATF_WORKSPACE_ROOT/ATF_SKILLS_AUTO_INSTALL 等，调用方装配），
 * 显式键优先于宿主 ATF_* 透传。具名例外：LD_LIBRARY_PATH（python3 解释器运行时依赖——
 * 本机解释器经它加载 libpython；属解释器注入面的一部分，随「python3 解释器路径」一同注入；
 * LD_PRELOAD 等其余注入向量一律不透传）。
 */
export const buildScratchExecEnv = (input: {
  scratchDir: string;
  kernelDir: string;
  baseEnv: Readonly<Record<string, string>>;
  pythonPath: string;
}): Record<string, string> => {
  const passthrough: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !key.startsWith("ATF_") || ENV_DENY.test(key)) continue;
    passthrough[key] = value;
  }
  if (typeof process.env["LD_LIBRARY_PATH"] === "string") {
    passthrough["LD_LIBRARY_PATH"] = process.env["LD_LIBRARY_PATH"];
  }
  const pythonDir = dirname(input.pythonPath);
  return {
    ...passthrough,
    ...input.baseEnv,
    PATH: `${pythonDir}:/usr/local/bin:/usr/bin:/bin`,
    PYTHONPATH: join(input.kernelDir, "src"),
    PYTHONUTF8: "1",
    LANG: "C.UTF-8",
    TMPDIR: join(input.scratchDir, ".tmp"),
  };
};

/** argv 白名单裁决结果：spawnArgv 恒以解析出的 python3 解释器开头（无第二二进制入口）。 */
export type ArgvGuardVerdict =
  | { ok: true; spawnArgv: string[] }
  | { ok: false; reason: string; message: string };

/**
 * argv[0] 白名单（设计要点 §一）：
 * - "python3"/"python"（或解析后同路径）→ [python, ...rest]
 * - .py 结尾且位于 <kernelDir>/skills/** 或 scratch 内 → [python, <abs>, ...rest]
 * - 其余（含 shell、launch.sh/train.sh、scratch 内 .sh）一律拒绝。
 * 长度 1..32（裸 python3/裸脚本合法——stdin 为 ignore 即即退，无危害）。
 */
export const guardScratchArgv = (input: {
  argv: readonly string[];
  scratchDir: string;
  kernelDir: string;
  pythonPath: string;
}): ArgvGuardVerdict => {
  const { argv, scratchDir, kernelDir, pythonPath } = input;
  if (argv.length < 1 || argv.length > 32) {
    return { ok: false, reason: "argv_invalid", message: `argv 长度非法（须为 1..32 个元素，实得 ${String(argv.length)}）` };
  }
  const a0 = argv[0] as string;
  const rest = argv.slice(1);
  const within = (root: string, target: string): boolean => {
    const rel = relative(root, target);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (a0 === "python3" || a0 === "python" || resolve(a0) === resolve(pythonPath)) {
    return { ok: true, spawnArgv: [pythonPath, ...rest] };
  }
  if (a0.endsWith(".py")) {
    const abs = resolve(scratchDir, a0);
    if (within(scratchDir, abs) || within(join(kernelDir, "skills"), abs) || within(kernelDir, abs)) {
      return { ok: true, spawnArgv: [pythonPath, abs, ...rest] };
    }
    return { ok: false, reason: "argv0_not_allowed", message: `argv[0] 须为 python3 或 .py 脚本（pin 内 skills scripts 或 scratch 内），拒绝: ${a0}` };
  }
  return { ok: false, reason: "argv0_not_allowed", message: `argv[0] 须为 python3 或 .py 脚本（pin 内 skills scripts 或 scratch 内），拒绝: ${a0}` };
};

export interface ScratchRunOutcome {
  exit_code: number | null;
  timed_out: boolean;
  stdout: string;
  stdout_truncated: boolean;
  stderr_tail: string;
  duration_ms: number;
}

/**
 * 受控执行一次命令（argv 直 spawn，无 shell；cwd/env 由调用方给定）。
 * - 正常退出/超时/非零退出都返回 ok（这是业务产出，由 canonical 载荷如实承载）；
 * - spawn 失败（解释器不存在等）→ err（rejected 载荷由调用方折算，不猜测成功）。
 */
export const runScratchCommand = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<Result<ScratchRunOutcome, { reason: string; message: string }>> =>
  new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let stdout = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrText = "";
    let settled = false;
    let child;
    try {
      child = spawn(input.argv[0] as string, input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      resolvePromise(err({ reason: "spawn_failure", message: `执行 spawn 失败: ${String(cause)}` }));
      return;
    }
    const finish = (outcome: { exit_code: number | null; timed_out: boolean }) => {
      const tail = stderrText.length > SCRATCH_EXEC_STDERR_TAIL_BYTES
        ? `…(截断)${stderrText.slice(-SCRATCH_EXEC_STDERR_TAIL_BYTES)}`
        : stderrText;
      resolvePromise(ok({
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
        stdout: stdout.toString("utf8"),
        stdout_truncated: stdoutTruncated,
        stderr_tail: tail,
        duration_ms: Date.now() - startedAt,
      }));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref?.();
      finish({ exit_code: null, timed_out: true });
    }, input.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < SCRATCH_EXEC_STDOUT_CAP_BYTES) {
        stdout = Buffer.concat([stdout, chunk]).subarray(0, SCRATCH_EXEC_STDOUT_CAP_BYTES);
        if (stdout.length >= SCRATCH_EXEC_STDOUT_CAP_BYTES) stdoutTruncated = true;
      } else {
        stdoutTruncated = true; // 超限后继续排空管道（防背压死锁），不再累积
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText = stderrText + chunk.toString("utf8");
      if (stderrText.length > SCRATCH_EXEC_STDERR_TAIL_BYTES * 4) {
        stderrText = stderrText.slice(-SCRATCH_EXEC_STDERR_TAIL_BYTES * 4);
      }
    });
    child.on("error", (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(err({ reason: "spawn_failure", message: `执行失败（解释器不可用？）: ${cause.message}` }));
    });
    child.on("close", (code) => {
      if (settled) return; // 超时已先行 settle（timed_out 形态不翻转）
      settled = true;
      clearTimeout(timer);
      finish({ exit_code: code, timed_out: false });
    });
  });

// ---------------------------------------------------------------- G5 检测

/** launch 就绪检测产物（deterministic；字段按可得性诚实缺省）。 */
export interface LaunchReady {
  /** launch.sh 的 scratch 相对路径 */
  launch_sh: string;
  run_id?: string;
  iteration_config_sha256?: string;
  global_batch?: number;
  nnodes?: number;
  /** 与 manifest 字节级 sha256 对拍命中的 IterationConfig（scratch 相对路径） */
  config?: string;
}

interface ScratchFileHit {
  abs: string;
  rel: string;
  bytes: number;
}

/** 有界扫描 scratch（深度≤5、跳点目录），返回文件清单（不含目录）。 */
const sweepScratch = async (scratchDir: string): Promise<Result<ScratchFileHit[], { reason: string; message: string }>> => {
  const hits: ScratchFileHit[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > SCRATCH_SCAN_DEPTH_MAX) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读（含尚未创建）＝无可检测物，非故障
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      hits.push({ abs, rel: relative(scratchDir, abs), bytes: size });
    }
  };
  try {
    await walk(scratchDir, 0);
  } catch (cause) {
    return err({ reason: "scan_failure", message: `scratch 扫描失败: ${String(cause)}` });
  }
  hits.sort((a, b) => (a.rel < b.rel ? -1 : 1)); // 确定性序
  return ok(hits);
};

/** 从 launch.sh 文本解析 TRAIN_DIR（generate_launch_orchestration 以 repr 单引号渲染绝对路径）。 */
const parseTrainDir = (scriptText: string): string | null => {
  const match = /^TRAIN_DIR=['\"]?(.+?)['\"]?\s*$/m.exec(scriptText);
  if (match === null) return null;
  const value = (match[1] as string).trim().replace(/^['\"]|['\"]$/g, "");
  return value !== "" ? value : null;
};

interface LaunchManifestFacts {
  run_id?: string;
  iteration_config_sha256?: string;
  global_batch?: number;
  nnodes?: number;
}

const readManifestFacts = async (manifestAbs: string): Promise<LaunchManifestFacts | null> => {
  try {
    const text = await readFile(manifestAbs, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["run_id"] === "string" ? { run_id: record["run_id"] } : {}),
      ...(typeof record["iteration_config_sha256"] === "string" ? { iteration_config_sha256: record["iteration_config_sha256"] } : {}),
      ...(typeof record["global_batch"] === "number" ? { global_batch: record["global_batch"] } : {}),
      ...(typeof record["nnodes"] === "number" ? { nnodes: record["nnodes"] } : {}),
    };
  } catch {
    return null;
  }
};

const isIterationConfig = async (hit: ScratchFileHit): Promise<boolean> => {
  if (hit.bytes === 0 || hit.bytes > SCAN_JSON_MAX_BYTES || !hit.rel.endsWith(".json")) return false;
  try {
    const parsed: unknown = JSON.parse(await readFile(hit.abs, "utf8"));
    return typeof parsed === "object" && parsed !== null &&
      (parsed as Record<string, unknown>)["schema_version"] === "IterationConfig/v1";
  } catch {
    return false;
  }
};

/**
 * G5 就绪检测（确定性，harness 侧；scratch_exec 成功退出后调用）：
 * 找 launch.sh → 解析 TRAIN_DIR → 读 launch_manifest.json → 与 scratch 内
 * IterationConfig/v1 逐文件 sha256 对拍。找不到/读不到的字段诚实缺省（不猜测）。
 */
export const scanLaunchReady = async (scratchDir: string): Promise<LaunchReady | null> => {
  const swept = await sweepScratch(scratchDir);
  if (!swept.ok) return null;
  const hits = swept.value;
  const launchHit = hits.find((hit) => hit.rel === "launch.sh" || hit.rel.endsWith("/launch.sh"));
  if (launchHit === undefined) return null;
  let manifest: LaunchManifestFacts = {};
  try {
    const scriptText = await readFile(launchHit.abs, "utf8");
    const trainDir = parseTrainDir(scriptText);
    if (trainDir !== null) {
      const fromTrainDir = await readManifestFacts(join(trainDir, "launch_manifest.json"));
      if (fromTrainDir !== null) manifest = fromTrainDir;
    }
  } catch {
    // launch.sh 不可读＝形态异常，仅返回路径事实
  }
  let config: string | undefined;
  if (manifest.iteration_config_sha256 !== undefined) {
    for (const hit of hits) {
      if (!(await isIterationConfig(hit))) continue;
      try {
        const bytes = await readFile(hit.abs);
        if (createHash("sha256").update(bytes).digest("hex") === manifest.iteration_config_sha256) {
          config = hit.rel;
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return {
    launch_sh: launchHit.rel,
    ...manifest,
    ...(config !== undefined ? { config } : {}),
  };
};

// ------------------------------------------------------------ launch 执行件

/** 解析 bash（launch.sh shebang = #!/usr/bin/env bash；write_text 落盘无执行位，经 bash spawn）。 */
export const findBash = (): string => {
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "bash";
};

/** 读 launch 收据 state.json（<launch.sh 目录>/launch/state.json；缺失/非法 = null，不猜测）。 */
export const readLaunchState = async (launchShAbs: string): Promise<Record<string, unknown> | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dirname(launchShAbs), "launch", "state.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

/**
 * 执行 launch.sh（受控执行点）：stdout/stderr 直接落 harness 日志文件（文件 fd 交给子进程，
 * 零上限问题）；等待至 waitMs——未退出**不杀**（训练为长任务，setsid 语义归内核），转后台跟踪。
 */
export const runLaunchScript = (input: {
  launchShAbs: string;
  bashPath: string;
  cwd: string;
  env: Record<string, string>;
  logFileAbs: string;
  waitMs: number;
}): Promise<Result<{ timed_out: boolean; exit_code: number | null; pid: number | null; log_path: string }, { reason: string; message: string }>> =>
  new Promise((resolvePromise) => {
    let logFd: number;
    try {
      mkdirSync(dirname(input.logFileAbs), { recursive: true }); // 收据目录由内核 launch.sh 建；harness 日志先行自建
      logFd = openSync(input.logFileAbs, "a");
    } catch (cause) {
      resolvePromise(err({ reason: "scratch_io_error", message: `launch 日志文件创建失败: ${String(cause)}` }));
      return;
    }
    let child;
    try {
      child = spawn(input.bashPath, [input.launchShAbs], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (cause) {
      closeSync(logFd);
      resolvePromise(err({ reason: "spawn_failure", message: `launch.sh spawn 失败: ${String(cause)}` }));
      return;
    }
    const pid = child.pid ?? null;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolvePromise(ok({ timed_out: true, exit_code: null, pid, log_path: input.logFileAbs }));
    }, input.waitMs);
    timer.unref?.();
    child.on("error", (cause: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(logFd);
      resolvePromise(err({ reason: "spawn_failure", message: `launch.sh 执行失败: ${cause.message}` }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeSync(logFd);
      resolvePromise(ok({ timed_out: false, exit_code: code, pid, log_path: input.logFileAbs }));
    });
  });

/** scratch 相对路径写入（atf_scratch_write handler 共用；守卫复用晋升闸同款 safeScratchPath）。 */
export const guardedScratchWrite = async (input: {
  scratchDir: string;
  relPath: string;
  content: string;
  maxBytes: number;
}): Promise<Result<{ path: string; bytes: number; sha256: string }, { reason: string; message: string }>> => {
  const guard = safeScratchPath(input.scratchDir, input.relPath);
  if (!guard.ok) {
    return err({ reason: "path_escape", message: guard.error.message });
  }
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > input.maxBytes) {
    return err({ reason: "content_too_large", message: `内容超限（${String(bytes)} > ${String(input.maxBytes)} 字节）` });
  }
  try {
    await mkdir(dirname(guard.value.resolved), { recursive: true });
    await writeFile(guard.value.resolved, input.content, "utf8");
  } catch (cause) {
    return err({ reason: "scratch_io_error", message: `scratch 写入失败: ${String(cause)}` });
  }
  return ok({ path: input.relPath, bytes, sha256: createHash("sha256").update(input.content, "utf8").digest("hex") });
};

/** ensure scratch/.tmp 存在（exec 前置；TMPDIR 定向落 scratch）。 */
export const ensureExecDirs = async (scratchDir: string): Promise<Result<true, { reason: string; message: string }>> => {
  try {
    await mkdir(join(scratchDir, ".tmp"), { recursive: true });
    return ok(true);
  } catch (cause) {
    return err({ reason: "scratch_io_error", message: `scratch 目录准备失败: ${String(cause)}` });
  }
};
