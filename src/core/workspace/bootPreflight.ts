/**
 * 批㊶-W——boot 环境预检分级自愈（设计要点件 §五/§6.3；判据单一：
 * 补齐动作落在产品自身写权限内（env 注入/清单派生）→ L1 自动＋留痕；
 * 涉及系统状态/包管理/不可逆变更 → L2 fail-fast 给可复制命令，不静默降级）。
 *
 * 预检清单（随仓版本化——环境要求变更＝改清单＋改模板）：
 *   ① ATF_DSH_PIPELINE_COMMAND 缺失 → L1 派生注入 `python3 <kernelDir>/tools/walkthrough_pipeline.py`
 *     （kernelDir＝ATF_DSH_KERNEL_DIR＞ATF_CLI_PATH；同事 10-12 实遇的 pipeline env 缺失属此类）；
 *     派生源脚本不存在 → L2 fatal（附核查命令）。
 *   ② ATF_DSH_BRIDGE_COMMAND 缺失 → L1 派生注入 `python3 -m agentic_training_flow serve`
 *     （kernelDir 在场即派生；kernelDir 缺失 → L2 fatal）。
 *   ③ LD_LIBRARY_PATH：env-profiles（$HOME/.atf/env-profiles/*.json）train.env 显式声明而
 *     进程 env 未含 → L1 注入（有清单值才注入——无声明不猜）；目录不存在 → L2 fatal。
 *   ④ python3 可用（`python3 -c "import sys"` 级探活）→ 失败 L2 fatal（附安装命令）。
 *   ⑤ nvidia-smi 可达 → 三态判定（D88-A；GPU 机器必备）：ok 放行；failed／unavailable
 *     → L2 fatal `nvidia_smi_unreachable`（确定态：命令回了非零，或根本起不来）；
 *     **timeout → L2 fatal `env_probe_timeout` ＋ notes 留痕 `env_unverified`**
 *     （探针没回＝GPU 可见性未证实，**永不折成 unreachable**——超时被报成「驱动异常」
 *     会让操作者去查机器/驱动/挂载，白查一轮；放行面＝ATF_ALLOW_PROBE_TIMEOUT=1）。
 *     ATF_GPU_REQUIRED=0 只豁免**确定态**（failed／unavailable），**不兜 timeout**
 *     （纯 CPU 部署不必关心 GPU；但探针超时是「没证实」，不是「不需要」，不得静默吞）。
 *   ⑥ 对端命令文件存在性：env 已配置形态下指向的脚本缺席 → L2 fatal。
 *   ⑦ pin 树 worktree 实锚（批㊶-ISO-2 S1）：实例 pin 根在场即校验——`git describe --tags`
 *     可解析（worktree 形态实锚）且 describe tag 与 pin 树版本串（__init__.py __version__）
 *     一致（沿 test_release_version_consistency 语义）；不可解析/不一致 → L2 fatal（附核查
 *     命令）。实例 pin 未配置（回退共享态）→ notes 留痕「pin 路径：回退共享态」。
 * L1 补齐＝返回值 autoFixed（调用方写回 process.env）＋boot 日志留痕「已自动补齐 X」；
 * L2 fatal 非空 → 调用方抛错拒绝 boot（fail-closed 纪律不变）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  GPU_PROBE_BOOT_DEFAULT_BUDGET_MS,
  GPU_PROBE_LIST_ARGS,
  GPU_PROBE_TIMEOUT_ENV,
  captureGpuProbeSync,
  formatProbeEvidence,
  resolveGpuProbeBudgetMs,
  type ProbeResult,
} from "./gpuProbe.js";

export interface PreflightAutoFix {
  level: "L1";
  /** 补齐的 env 键。 */
  key: string;
  value: string;
  /** boot 留痕文案（「已自动补齐 X」）。 */
  note: string;
}

export interface PreflightFatal {
  level: "L2";
  /** 预检项名。 */
  check: string;
  /** 机器可判的错误码（D88-A：`nvidia_smi_unreachable` 与 `env_probe_timeout` 必须可 grep 区分）。 */
  code?: string;
  /** 缺什么（指名）。 */
  missing: string;
  /** 可复制命令／补法指引（ops 一条命令补完）。 */
  fix: string;
}

export interface PreflightReport {
  autoFixed: PreflightAutoFix[];
  fatal: PreflightFatal[];
  /** 非致命观察（如 ATF_MODEL_ROOT 未配置——不阻塞 boot）。 */
  notes: string[];
}

/** 预检输入 env（测试注入面）；probes 可注入（vitest 假件——生产缺省真探测）。 */
export interface PreflightProbes {
  /** 探活命令（缺省 execFileSync `python3 -c "import sys"` 级）。返回非零/抛错＝不可用。 */
  commandWorks?: (command: string, args: readonly string[]) => boolean;
  /** 文件在场探测（缺省 existsSync）。 */
  fileExists?: (path: string) => boolean;
  /** 目录在场探测（缺省 existsSync）。 */
  dirExists?: (path: string) => boolean;
  /** 目录 JSON 清单读取（缺省 readdirSync .json 文件名列表）。 */
  listJsonFiles?: (dir: string) => string[];
  /** JSON 文本读取（缺省 readFileSync）。 */
  readText?: (path: string) => string | null;
  /** 批㊶-ISO-2 S1：pin 树 tag 探测（缺省 execFileSync `git describe --tags`；null＝不可解析）。 */
  gitDescribe?: (root: string) => string | null;
  /** D88-A：GPU 探针注入面（vitest 假件）——返回归一 ProbeResult，参数为本消费方预算
   *  （缺省 30s／ATF_GPU_PROBE_TIMEOUT_MS）。注入即**不读写缓存**（缓存只服务
   *  defaultCommandWorks 真探路径）。 */
  gpuProbe?: (budgetMs: number) => ProbeResult;
}

export const BOOT_PREFLIGHT_PIPELINE_ENV = "ATF_DSH_PIPELINE_COMMAND";
export const BOOT_PREFLIGHT_BRIDGE_ENV = "ATF_DSH_BRIDGE_COMMAND";
/** D88-A：探针超时显式放行（等价 `--allow-probe-timeout`）——放行后仍留 `env_unverified` 痕。 */
export const BOOT_PREFLIGHT_ALLOW_PROBE_TIMEOUT_ENV = "ATF_ALLOW_PROBE_TIMEOUT";
/** 内核 walkthrough_pipeline 相对 kernelDir 的仓内位（F4：路径以仓内实际为准）。 */
export const PIPELINE_SCRIPT_RELPATH = join("tools", "walkthrough_pipeline.py");

/** 通用命令探活（缺省 execFileSync；非零／抛错＝false）。
 *  D88-A 后只剩 python3 用例——GPU 走 gpuProbe（三态，不折 boolean）。 */
const defaultCommandWorks = (command: string, args: readonly string[]): boolean => {
  try {
    execFileSync(command, args, { timeout: 10_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** 批㊶-ISO-2 S1：pin 树 tag 探测缺省实现（`git describe --tags`；非 worktree/无 tag/超时＝null）。 */
const defaultGitDescribe = (root: string): string | null => {
  try {
    const out = execFileSync("git", ["-C", root, "describe", "--tags"], { timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const tag = out.toString("utf8").trim();
    return tag !== "" ? tag : null;
  } catch {
    return null;
  }
};

/** 批㊶-ISO-2 S1：pin 树版本串读取（src/agentic_training_flow/__init__.py `__version__`；缺读＝null）。 */
export const pinVersionFromTree = (root: string, readText: (path: string) => string | null): string | null => {
  const text = readText(join(root, "src", "agentic_training_flow", "__init__.py"));
  if (text === null) return null;
  const m = /__version__\s*=\s*"([^"]+)"/.exec(text);
  return m?.[1] ?? null;
};

/** env-profiles train.env 声明值提取（LD_LIBRARY_PATH 等 env 键——有显式声明才构成自愈源）。 */
export const declaredLdLibraryPathFromProfiles = (home: string, probes: PreflightProbes): string | null => {
  const listJsonFiles = probes.listJsonFiles ?? ((dir: string): string[] => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  });
  const readText = probes.readText ?? ((path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  });
  const profilesDir = join(home, ".atf", "env-profiles");
  for (const entry of listJsonFiles(profilesDir)) {
    const text = readText(join(profilesDir, entry));
    if (text === null) continue;
    try {
      const profile = JSON.parse(text) as { train?: { env?: Record<string, unknown> } };
      const value = profile.train?.env?.["LD_LIBRARY_PATH"];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    } catch {
      continue;
    }
  }
  return null;
};

/** boot 预检主入口（纯逻辑＋可注入探测；调用方＝atf-tools apply）。
 *  kernelDirOverride＝Config 解析后的内核目录（env 缺席时 Config 有实例 pin 根缺省——
 *  预检与装配取同一值，避免「env 面」与「装配面」错位误报）。
 *  pin（批㊶-ISO-2 S1）＝实例 pin 根解析值（resolveInstancePinRoot）——在场即做 worktree
 *  实锚校验＋回退共享态留痕；缺席（旧调用方）＝本项跳过。 */
export const runBootPreflight = (
  env: Record<string, string | undefined>,
  probes: PreflightProbes = {},
  kernelDirOverride?: string,
  pin?: { root: string; explicit: boolean },
): PreflightReport => {
  const fileExists = probes.fileExists ?? ((p: string) => existsSync(p));
  const dirExists = probes.dirExists ?? ((p: string) => existsSync(p));
  const commandWorks = probes.commandWorks ?? defaultCommandWorks;
  const autoFixed: PreflightAutoFix[] = [];
  const fatal: PreflightFatal[] = [];
  const notes: string[] = [];

  const kernelDir = kernelDirOverride ?? env["ATF_DSH_KERNEL_DIR"] ?? env["ATF_CLI_PATH"] ?? "";
  const hasKernelDir = kernelDir !== "" && dirExists(kernelDir);

  // ① ATF_DSH_PIPELINE_COMMAND：缺 → L1 派生注入；派生源缺失 → L2
  if (env[BOOT_PREFLIGHT_PIPELINE_ENV] === undefined || env[BOOT_PREFLIGHT_PIPELINE_ENV]?.trim() === "") {
    if (!hasKernelDir) {
      fatal.push({
        level: "L2",
        check: "pipeline_command",
        missing: `${BOOT_PREFLIGHT_PIPELINE_ENV} 未配置且内核目录不可得（ATF_DSH_KERNEL_DIR/ATF_CLI_PATH 均缺席）`,
        fix: "在实例 env 声明：export ATF_DSH_KERNEL_DIR=<内核 pin 副本目录>",
      });
    } else {
      const pipelineScript = join(kernelDir, PIPELINE_SCRIPT_RELPATH);
      if (!fileExists(pipelineScript)) {
        fatal.push({
          level: "L2",
          check: "pipeline_command",
          missing: `管线对端脚本不存在：${pipelineScript}`,
          fix: `ls ${pipelineScript}  # 核对内核 pin 副本完整性；或 export ${BOOT_PREFLIGHT_PIPELINE_ENV}=<真管线命令>`,
        });
      } else {
        autoFixed.push({
          level: "L1",
          key: BOOT_PREFLIGHT_PIPELINE_ENV,
          value: `python3 ${pipelineScript}`,
          note: `已自动补齐 ${BOOT_PREFLIGHT_PIPELINE_ENV}＝python3 ${pipelineScript}（L1 自愈——由 kernelDir 派生）`,
        });
      }
    }
  }
  // ② ATF_DSH_BRIDGE_COMMAND：缺 → L1 派生注入（kernelDir 在场）；缺 kernelDir → L2
  if (env[BOOT_PREFLIGHT_BRIDGE_ENV] === undefined || env[BOOT_PREFLIGHT_BRIDGE_ENV]?.trim() === "") {
    if (!hasKernelDir) {
      fatal.push({
        level: "L2",
        check: "bridge_command",
        missing: `${BOOT_PREFLIGHT_BRIDGE_ENV} 未配置且内核目录不可得（ATF_DSH_KERNEL_DIR/ATF_CLI_PATH 均缺席）`,
        fix: "在实例 env 声明：export ATF_DSH_KERNEL_DIR=<内核 pin 副本目录>",
      });
    } else {
      autoFixed.push({
        level: "L1",
        key: BOOT_PREFLIGHT_BRIDGE_ENV,
        value: "python3 -m agentic_training_flow serve",
        note: `已自动补齐 ${BOOT_PREFLIGHT_BRIDGE_ENV}＝python3 -m agentic_training_flow serve（L1 自愈——由 kernelDir 派生；PYTHONPATH 由桥装配链自内核目录派生）`,
      });
    }
  }
  // ③ LD_LIBRARY_PATH：env-profiles 显式声明而进程 env 未含 → L1 注入；声明目录不存在 → L2
  const home = env["HOME"] ?? "";
  if (home !== "") {
    const declared = declaredLdLibraryPathFromProfiles(home, probes);
    if (declared !== null) {
      const current = env["LD_LIBRARY_PATH"] ?? "";
      const declaredDirs = declared.split(":").map((d) => d.trim()).filter((d) => d !== "");
      const missingDirs = declaredDirs.filter((d) => !current.split(":").includes(d));
      if (missingDirs.length > 0) {
        const absent = missingDirs.filter((d) => !dirExists(d));
        if (absent.length > 0) {
          fatal.push({
            level: "L2",
            check: "ld_library_path",
            missing: `env-profiles 声明的 lib 目录不存在：${absent.join("、")}`,
            fix: `ls ${absent[0]}  # 核对声明或安装对应库后重试`,
          });
        } else {
          const merged = current === "" ? missingDirs.join(":") : `${current}:${missingDirs.join(":")}`;
          autoFixed.push({
            level: "L1",
            key: "LD_LIBRARY_PATH",
            value: merged,
            note: `已自动补齐 LD_LIBRARY_PATH（L1 自愈——追加 env-profiles 声明目录：${missingDirs.join(":")}）`,
          });
        }
      }
    }
  }
  // ④ python3 可用（L2）
  if (!commandWorks("python3", ["-c", "import sys"])) {
    fatal.push({
      level: "L2",
      check: "python3",
      missing: "python3 不可用（探活 python3 -c \"import sys\" 失败）",
      fix: "which python3 || apt-get install -y python3  # 确认解释器在位后重试",
    });
  }
  // ⑤ nvidia-smi 可达（L2——GPU 机器必备；纯 CPU 部署须显式 ATF_GPU_REQUIRED=0 豁免）
  // D88-A：三态判定。归一见 gpuProbe.ts（探针层只报状态），致命性判据在此消费层：
  //   ok → 放行；
  //   failed／unavailable（确定态）→ nvidia_smi_unreachable，ATF_GPU_REQUIRED=0 可豁免；
  //   timeout（未证实态）→ env_probe_timeout，**永不折成 unreachable**，豁免不覆盖。
  const gpuRequired = env["ATF_GPU_REQUIRED"] !== "0";
  // 豁免也照跑探针：**「不探」等于「兜 timeout」**——豁免面只作用于确定态，不许把未证实态
  // 静默变成通过。纯 CPU 机上 nvidia-smi 不存在＝ENOENT 即回（不额外耗时）；GPU 机上多花
  // 一次探活（≤预算）换「豁免不掩盖超时」这条结构保证，值。
  // 块作用域：probe／budgetMs 不外泄到 ⑥⑦ 段。
  {
    const budgetMs = resolveGpuProbeBudgetMs(env, GPU_PROBE_BOOT_DEFAULT_BUDGET_MS);
    const probe: ProbeResult =
      probes.gpuProbe !== undefined
        ? probes.gpuProbe(budgetMs)
        : probes.commandWorks !== undefined
          ? // 兼容注入面（旧 vitest 假件）：注入态一律**不写缓存不读缓存**。
            probes.commandWorks("nvidia-smi", GPU_PROBE_LIST_ARGS)
            ? { status: "ok", elapsedMs: 0 }
            : { status: "failed", code: "injected_command_works_false", stderr: "", elapsedMs: 0 }
          : // 真探路径＝唯一缓存读写点（正负缓存同寿命＝进程；见 gpuProbe.ts）。
            captureGpuProbeSync({ budgetMs, env, useCache: true }).result;
    if (probe.status === "timeout") {
      // 本分支**不读** gpuRequired——ATF_GPU_REQUIRED=0 不得兜 timeout（豁免只在下面那条分支）。
      const evidence = formatProbeEvidence(probe);
      notes.push(
        `env_unverified：nvidia-smi 探针超时（${evidence}）——GPU 可见性未证实，不是「不可达」（${GPU_PROBE_TIMEOUT_ENV}=${probe.budgetMs} 可调大）`,
      );
      if (env[BOOT_PREFLIGHT_ALLOW_PROBE_TIMEOUT_ENV] !== "1") {
        fatal.push({
          level: "L2",
          check: "gpu_probe",
          code: "env_probe_timeout",
          missing: `nvidia-smi 探针超时（${evidence}）——命令未回，不是不可达：本轮 GPU 可见性未证实（预算 ${probe.budgetMs}ms，经 ${GPU_PROBE_TIMEOUT_ENV} 调整；本机实测中位 3.3s、峰值 6.25s，高负载可超 10s）`,
          fix: `nvidia-smi -L  # 手工确认真实耗时（是不是负载一眼可判）；确认负载抖动后 export ${GPU_PROBE_TIMEOUT_ENV}=60000 提高预算，或 export ${BOOT_PREFLIGHT_ALLOW_PROBE_TIMEOUT_ENV}=1 显式放行本次启动（留 env_unverified 痕，不静默）`,
        });
      }
    } else if (probe.status !== "ok" && gpuRequired) {
      fatal.push({
        level: "L2",
        check: "nvidia_smi",
        code: "nvidia_smi_unreachable",
        missing: `nvidia-smi 不可达（GPU 不可见或驱动异常）：${formatProbeEvidence(probe)}——ATF_GPU_REQUIRED=0 可显式豁免 GPU 机器要求`,
        fix: "nvidia-smi 2>&1 | head -3; nvidia-smi -L  # 诊断驱动；必要时联系 ops 重载驱动",
      });
    }
  }
  // ⑥ 对端命令文件存在性（env 已配置形态：首词 python3 ＋ 脚本路径 → 脚本在场核查）
  for (const [check, envKey] of [["pipeline_command_file", BOOT_PREFLIGHT_PIPELINE_ENV], ["bridge_command_file", BOOT_PREFLIGHT_BRIDGE_ENV]] as const) {
    const raw = env[envKey];
    if (raw === undefined || raw.trim() === "") continue;
    const parts = raw.trim().split(/\s+/);
    const scriptArg = parts.find((p) => p.endsWith(".py") || p.endsWith(".mjs") || p.endsWith(".js"));
    if (scriptArg !== undefined && isAbsolute(scriptArg) && !fileExists(scriptArg)) {
      fatal.push({
        level: "L2",
        check,
        missing: `${envKey} 指向的脚本不存在：${scriptArg}`,
        fix: `ls ${scriptArg}  # 核对路径；真内核 pin 副本经 git worktree 检出`,
      });
    }
  }
  // ⑦ pin 树 worktree 实锚（批㊶-ISO-2 S1——回退共享态留痕＋tag↔版本串一致性）
  if (pin !== undefined) {
    if (!pin.explicit) {
      notes.push("pin 路径：回退共享态——实例 pin 未配置（ATF_INSTANCE_PIN_ROOT；ISO-2 生效段切实例 pin 后此留痕消失）");
    }
    if (dirExists(pin.root)) {
      const described = (probes.gitDescribe ?? defaultGitDescribe)(pin.root);
      const version = pinVersionFromTree(pin.root, probes.readText ?? ((p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } }));
      if (described === null) {
        fatal.push({
          level: "L2",
          check: "pin_worktree",
          missing: `pin 树非 worktree 形态或 tag 不可解析：${pin.root}`,
          fix: `git -C ${pin.root} describe --tags 2>&1; git -C ${pin.root} worktree list  # 核对 pin 树须为内核仓 worktree 检出在发版 tag`,
        });
      } else if (version === null) {
        fatal.push({
          level: "L2",
          check: "pin_version",
          missing: `pin 树版本串不可读（src/agentic_training_flow/__init__.py __version__ 缺失）：${pin.root}`,
          fix: `ls ${join(pin.root, "src", "agentic_training_flow", "__init__.py")}  # 核对 pin 树完整性（re-pin 残留）`,
        });
      } else if (described.replace(/^v/, "") !== version) {
        fatal.push({
          level: "L2",
          check: "pin_version_consistency",
          missing: `pin 树 tag 与版本串不一致：describe=${described} vs __version__=${version}（${pin.root}）`,
          fix: `git -C ${pin.root} log --oneline -1  # tag 与版本串须同指（沿 test_release_version_consistency 语义）——re-pin 残留请重做检出`,
        });
      } else {
        notes.push(`pin 树实锚：${described}（worktree describe＝版本串一致）`);
      }
    }
    // pin.root 不存在 → 不在此处 fatal（①②kernelDir 派生检查已覆盖该面，避免双报）
  }
  // 观察面（不阻塞）
  if (env["ATF_MODEL_ROOT"] === undefined || env["ATF_MODEL_ROOT"]?.trim() === "") {
    notes.push("ATF_MODEL_ROOT 未配置——本机模型清单为空（训练 base_model 选型面受限；不阻塞 boot）");
  }
  return { autoFixed, fatal, notes };
};

/** L2 fatal 汇总人读文案（boot 拒绝启动时抛错体——指名缺什么＋补法；code 一并打印便于 grep）。 */
export const formatPreflightFatal = (fatal: readonly PreflightFatal[]): string =>
  fatal.map((f) => `[${f.check}${f.code !== undefined ? ` ${f.code}` : ""}] 缺：${f.missing}\n  补法：${f.fix}`).join("\n");
