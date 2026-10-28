/**
 * 批⑱M2.75——训练执行段三工具投影（atf_run_training / atf_evaluate / atf_analyze_badcases）。
 *
 * 对齐审计缺口：12 skill 中三段无工具投影——训练执行→评估→可视化无法从 WebUI 对话驱动。
 * 实现要点：
 *  - atf_run_training：train.sh DRY_RUN 校验 → **danger_confirm（GPU/时长显性化）** → tmux 常驻
 *    （会话名经 tmuxLiveness 命名域单源）＋stdout tail 进料（HF dict 行→loss-series.json 追加——批⑯协议）→
 *    status 查询完成/ckpt。非阻塞两段式（start/status）——工具不阻塞 agent turn。
 *  - atf_evaluate：llamafactory api（8200，bnb 同训练形态）＋run_formal_eval.py 四件套——start/status 同款。
 *  - atf_analyze_badcases：两步链（批㉕B 段1 正道化）——build_raw_badcase_input.py 冻结账本 →
 *    run_analysis_chain.py --raw-mainline 一键链；脚本一律取 <kernelDir>/skills/（pin 单源）。
 * 审批：run_training= danger 必确认（GPU/时长）；evaluate= 确认（资源占用）；analyze= 轻量。
 * 环境纪律沿 M0：GPU/端口/venv 走 env-profile；异常即停即报不静默重试。
 *
 * E5·H2（D142/D143）评估链实例根显式传递：atf_evaluate 的内核子步（generate_eval_
 * service／build_service_prelaunch_report／generate_checkpoint_plan／generate_eval_
 * orchestration／--record-eval-release）一律显式接收 env（HOME＝实例根单源
 * resolveEvalInstanceRoot——ATF_HOME ＞ HOME ＞ 系统家〔getpwuid 锚，env -i 下仍稳〕；
 * 其余 env 原样继承），编排 tmux 会话命令同注入 env 前缀——内核子步与编排脚本内的
 * Path.home()/${HOME} 解析不再依赖子进程隐式继承（HOME 漂移/tmux 旧服务端分轴下
 * 账本与状态根稳定）；status 返回体带 instance_root（实际解析根＋来源）供对账。
 */
import { spawn, execFile, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { homedir, userInfo } from "node:os";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, statSync, copyFileSync as copyFileSyncBuiltin } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildMonitorSnapshot, formatTaskCard } from "../../atf-ui/src/snapshot.js";
import { scanRunDir } from "../../atf-ui/src/server.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { isTrainingAutopilot, ATF_TRAINING_PRESET } from "./trainingPreset.js";
import { asToolValue } from "./schemaTranslate.js";
import { decorateOutcome, projectUserNotice, receiptIsFailure, type UserSummary } from "./receiptSummary.js";
import { startLossIngest } from "../../../../src/core/workspace/lossIngest.js";
import { probeSession, resolveLaunchSessionName, tmuxCommand, tmuxTrainingEvidenceFor, evalOrchSessionBase, trainingSessionBase, type SessionProbe } from "../../../../src/core/workspace/tmuxLiveness.js";
import { awaitGpuWindow, formatCardTable, gpuQueuePollMsFromEnv, TRAINING_RESIDUE_PATTERN } from "./gpuQueueFace.js";
import { reconcileConfirmedWithTrainSh, formatReconcileDiff } from "./trainShReconcile.js";
import { editsFromFormAnswers, formAskQuestion, type FormAskService } from "./confirmFace.js";
import { appendAskFailureDiagnostic } from "./askDiagnostics.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import {
  latestCheckpointOf, readTrainingExitCode, readTrainingStartedAt, writeTrainingCompletion, writeTrainingStartedAt,
} from "../../../../src/core/workspace/trainingCompletion.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { appendBinding, readNumTrainEpochs, writeProgress } from "../../../../src/core/workspace/runFacts.js";
import { canonicalRunDirOf, resolveRunDir, resolveRunFile, runFileCandidates, workspaceOfRunDir } from "../../../../src/core/workspace/runLayout.js";
import { listRegistryRecords, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import { bindSessionRun, readSessionBinding, resolveActiveRun, resolveBindingsHome } from "../../../../src/core/workspace/sessionBindings.js";
import { buildRunCandidates } from "../../../../src/core/workspace/runDisplay.js";
import { appendLedgerAuditComment, ledgerEnvPrefixForShell, shellSingleQuoted } from "../../../../src/core/workspace/approvalLedger.js";
import { dualStageNote } from "./confirmFace.js";
import { deriveAtfRoot } from "../../../../src/webui/storageSettings.js";

/** 发布库位缺省派生（统一根 models 子目录——env-only 零字面量；未派生＝null）。 */
export const derivePublishRoot = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const root = deriveAtfRoot(env);
  return root === null ? null : join(root, "models");
};
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { humanizeKernelError, scanKernelErrorFace } from "../../../../src/core/workspace/kernelErrorFace.js";
// E9a·H2-H5：评估面走 docSlots 唯一路径表（ADR-0017 决定 10/12——禁再自拼槽位路径）
import { listDocSlots } from "../../atf-ui/src/docSlots.js";
import { queryNvidiaSmiAll } from "../../../../src/webui/readOnlyTools.js";
import { buildEvalOrchArgs } from "./evalOrchArgs.js";

// ── 批㊶Q增补三 段2：start 探活（终结 started:true 假成功）──

/** 探活窗口缺省（毫秒）——env `ATF_TRAIN_STARTUP_PROBE_MS` 可配（非法/≤0 回落缺省）。 */
export const STARTUP_PROBE_MS_DEFAULT = 10_000;
export const STARTUP_PROBE_MS_ENV = "ATF_TRAIN_STARTUP_PROBE_MS";

export const resolveStartupProbeMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env[STARTUP_PROBE_MS_ENV];
  if (raw === undefined || raw.trim() === "") return STARTUP_PROBE_MS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return STARTUP_PROBE_MS_DEFAULT;
  return parsed;
};

/** 进料确认特征（train.sh 数据准入自检产出：SHA=pass＋ADMISSION=pass）。 */
export const STARTUP_FEED_RE = /SHA=pass[\s\S]*ADMISSION=pass|ADMISSION=pass[\s\S]*SHA=pass/i;

/** 终止特征（闸门失败／脚本崩溃——命中即 started:false）。exit 78＝train.sh 放行记录闸专用码。
 *  真实闸门文案＝「真实训练缺少用户放行记录(subject=…)」（train.sh 生成面实锚——「用户」可省略形态并容）。 */
export const STARTUP_TERMINAL_RE = /缺少.{0,4}放行记录|Traceback|ADMISSION[ =:]*(fail|error)/i;

export interface StartupProbeResult {
  /** feed_ok＝进料确认且进程存活；alive_no_feed＝窗口内无进料但进程存活（llamafactory 启动中）；dead＝终止特征/进程退出。 */
  outcome: "feed_ok" | "alive_no_feed" | "dead";
  feedSeen: boolean;
  /** 日志尾摘要（dead 时含终止特征上下文——用户可见可指导）。 */
  tail: string;
  /** 终止原因（dead 时；缺少放行记录→闸门 78 语义）。 */
  reason?: string;
  /** exit code（仅缺少放行记录→78 可知；其余如实 null）。 */
  exitCode?: number | null;
}

const readLogTail = (logPath: string, bytes: number): string => {
  try {
    if (!existsSync(logPath)) return "";
    const text = readFileSync(logPath, "utf8");
    return text.length > bytes ? text.slice(-bytes) : text;
  } catch {
    return "";
  }
};

/**
 * 启动探活（段2——start 拉起 tmux 后不立即返回）：窗口内轮询 train-stdout，
 * 终止特征/进程退出 → dead；进料确认（SHA/ADMISSION pass）后再稳定 2s 且进程存活 → feed_ok；
 * 窗口耗尽进程仍存活 → alive_no_feed（如实标注，不假报进料）。注入面（读日志/tmux 存活/等待）可测。
 */
export async function probeTrainingStartup(input: {
  logPath: string;
  windowMs?: number;
  pollMs?: number;
  settleMs?: number;
  readTail?: (logPath: string, bytes: number) => string;
  sessionAlive?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<StartupProbeResult> {
  const windowMs = input.windowMs ?? resolveStartupProbeMs(process.env);
  const pollMs = input.pollMs ?? 500;
  const settleMs = input.settleMs ?? 2_000;
  const readTail = input.readTail ?? readLogTail;
  const sessionAlive = input.sessionAlive ?? (() => true);
  const now = input.now ?? Date.now;
  const step = async (ms: number): Promise<void> => {
    await (input.sleep ?? ((delay: number) => new Promise<void>((r) => setTimeout(r, delay))))(ms);
  };
  const startedAt = now();
  let feedSeenAt: number | null = null;
  let tail = "";
  for (;;) {
    tail = readTail(input.logPath, 4000);
    if (STARTUP_FEED_RE.test(tail)) feedSeenAt = feedSeenAt ?? now();
    const terminal = STARTUP_TERMINAL_RE.exec(tail);
    if (terminal !== null) {
      return {
        outcome: "dead",
        feedSeen: feedSeenAt !== null,
        tail,
        reason: `终止特征「${terminal[0].slice(0, 80)}」`,
        exitCode: /缺少.{0,4}放行记录/.test(tail) ? 78 : null,
      };
    }
    if (!sessionAlive()) {
      return { outcome: "dead", feedSeen: feedSeenAt !== null, tail, reason: "训练进程已退出（tmux 会话消失）", exitCode: null };
    }
    // 进料确认后稳定 settleMs 且进程存活 → feed_ok（settle 不受窗口截断——确认态优先）
    if (feedSeenAt !== null && now() - feedSeenAt >= settleMs) {
      return { outcome: "feed_ok", feedSeen: true, tail };
    }
    // 窗口只约束进料等待期（进料未现）：耗尽即出——进程存活与否在出口处终判
    if (feedSeenAt === null && now() - startedAt >= windowMs) break;
    const remaining = feedSeenAt !== null ? Math.max(50, settleMs - (now() - feedSeenAt)) : Math.max(50, Math.min(pollMs, windowMs - (now() - startedAt)));
    await step(remaining);
  }
  return sessionAlive()
    ? { outcome: "alive_no_feed", feedSeen: false, tail }
    : { outcome: "dead", feedSeen: false, tail, reason: "训练进程已退出（tmux 会话消失）", exitCode: null };
}

/** 批㊶-N N-5：会话身份提取（exec.agent.session.id——vendor ToolExecutionInput 链路；
 *  取不到＝undefined，调用方如实跳过绑定量不造挂点）。 */
const sessionIdOf = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

// ── 批B1：会话绑定账本接入（run_id 缺省解析＋成功后绑定）──
// 红线（指令 B1 §十）：run_id 省略时必须能解析绑定；无绑定必须报 run_binding_required＋候选，
// 绝不回退「列表第一个」；绑定写失败 fail-open（账本函数内 stderr 一条），不阻塞工具主流程。

/** run_binding_required 业务话术（用户可见面用「实验」——指令 §十）。 */
export const RUN_BINDING_REQUIRED_MESSAGE = "本会话还没有选择实验";

/** 业务候选面（≤5，本工作区优先）：{run_id, workspace, title}——run_binding_required 随附。 */
export const bindingCandidatesForTool = (runsRoot: string, preferWorkspace: string | null | undefined): Array<{ run_id: string; workspace: string | null; title: string }> =>
  buildRunCandidates(runsRoot, preferWorkspace, 5).map((candidate) => ({ run_id: candidate.run_id, workspace: candidate.workspace, title: candidate.title }));

export type ToolRunResolution =
  | { ok: true; runId: string; runDir: string; workspace: string | null }
  | { ok: false; payload: Record<string, unknown> };

/** D49：注册工作区根清单（canonical 解析种子——listRegistryRecords 派生，exists 记录）。
 *  cfg.canonicalRoots 测试注入优先（jointTrainFace registryWorkspaces 同款纪律）。 */
export const canonicalRunRootsOf = (cfg?: { canonicalRoots?: readonly string[] }, env: NodeJS.ProcessEnv = process.env): readonly string[] =>
  cfg?.canonicalRoots ??
  listRegistryRecords(resolveDshHome(env))
    .filter((record) => record.exists)
    .map((record) => record.path);

/** 工具 run_id 解析单源（atf_evaluate／atf_analyze_badcases／atf_publish_model 共用）：
 *  显式传入（须存在——不存在 run_not_found，不猜）＞ 会话绑定 resolveActiveRun（stale＝不改账本）；
 *  无绑定/会话身份不可得＝run_binding_required＋候选。
 *  D49：显式 run_id 的目录解析 canonical 优先（注册工作区 run.json 合法即 canonical）——
 *  training/evaluate 写面全经 runDir 拼接，解析档 canonical＝写面 canonical 落点
 *  （legacy 树零新增）。 */
export const resolveToolRun = (runsRoot: string, exec: unknown, explicitRunId?: string, canonicalRoots: readonly string[] = canonicalRunRootsOf()): ToolRunResolution => {
  const sessionId = sessionIdOf(exec);
  if (explicitRunId !== undefined && explicitRunId.trim() !== "") {
    const runId = explicitRunId.trim();
    // 会话工作区约束（UAT：同 run_id 多工作区候选时落点不受会话约束，评估/训练写面落进旧工作区）：
    // 绑定 workspace 非空 → **只在该工作区解析**（桶内 runs/<桶>/<runId>，或该工作区的实验树
    // canonical——桶名＝该工作区目录名），找不到即显式失败并列该工作区下的候选 run id；
    // 绑定 workspace 为空（平铺/未标注）→ 保持既有全量扫描行为，成功后由 bindToolRunSuccess
    // 按 runDir 反填 workspace（workspaceOfRunDir 推回，见下方 ok 分支）。
    const boundWorkspace = sessionId === undefined ? null : (readSessionBinding(resolveBindingsHome(process.env), sessionId)?.workspace ?? null);
    if (boundWorkspace !== null && boundWorkspace !== "") {
      const inWorkspaceCanonical = canonicalRunDirOf(
        canonicalRoots.filter((root) => typeof root === "string" && basename(root) === boundWorkspace), runId);
      const bucketed = join(runsRoot, boundWorkspace, runId);
      const scopedDir = inWorkspaceCanonical ?? (existsSync(bucketed) ? bucketed : null);
      if (scopedDir === null) {
        const candidates = (() => {
          try {
            return readdirSync(join(runsRoot, boundWorkspace), { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
              .map((entry) => entry.name).sort();
          } catch { return [] as string[]; }
        })();
        return {
          ok: false,
          payload: {
            error: "run_not_found_in_session_workspace", run_id: runId, workspace: boundWorkspace,
            candidates,
            message: `实验不存在：${runId}——本会话绑定工作区（${boundWorkspace}）内没有这个实验${candidates.length > 0 ? `；该工作区现有实验：${candidates.slice(0, 10).join("、")}` : "（该工作区下暂无实验）"}。核对 run_id 后重推（跨工作区取用不在工具面——请先切到该工作区）`,
          },
        };
      }
      return { ok: true, runId, runDir: scopedDir, workspace: boundWorkspace };
    }
    const runDir = resolveRunDir(runsRoot, runId, { canonicalRoots });
    if (!existsSync(runDir)) {
      return { ok: false, payload: { error: "run_not_found", run_id: runId, message: `实验不存在：${runId}——核对后重推，或省略 run_id 使用本会话绑定的实验` } };
    }
    return { ok: true, runId, runDir, workspace: workspaceOfRunDir(runsRoot, runDir) };
  }
  const resolution = sessionId === undefined
    ? { run: null, runId: null, workspace: null, reason: "new" as const }
    : resolveActiveRun(resolveBindingsHome(process.env), runsRoot, sessionId);
  if (resolution.run === null || resolution.runId === null) {
    return {
      ok: false,
      payload: {
        error: "run_binding_required",
        message: RUN_BINDING_REQUIRED_MESSAGE,
        candidates: bindingCandidatesForTool(runsRoot, resolution.workspace),
        ...(sessionId === undefined ? {} : { unbound_reason: resolution.reason === "bound" ? null : resolution.reason }),
      },
    };
  }
  return { ok: true, runId: resolution.runId, runDir: resolution.run, workspace: resolution.workspace };
};

/** 工具成功后的账本绑定（auto_tool＝对既有 run；created＝新建实验）。显式 run_id 与当前绑定
 *  不同 → 返回体带 rebound_from（旧绑定值；无旧绑定＝null——如实覆盖事实）。写失败 fail-open。
 *  缺省解析自绑定的成功（run_id 省略且账本已指向该 run）＝零写——保 source 溯源（user_pick 不被 auto_tool 冲掉）。 */
export const bindToolRunSuccess = (exec: unknown, runId: string, workspace: string | null, source: "auto_tool" | "created", explicitRunId?: string): { rebound_from?: string | null } => {
  const sessionId = sessionIdOf(exec);
  if (sessionId === undefined) return {};
  if (source === "auto_tool" && (explicitRunId === undefined || explicitRunId.trim() === "")) return {};
  const home = resolveBindingsHome(process.env);
  let rebound: string | null | undefined;
  if (source === "auto_tool" && explicitRunId !== undefined && explicitRunId.trim() !== "") {
    const prior = readSessionBinding(home, sessionId);
    if (prior === null || prior.active_run_id !== runId) rebound = prior?.active_run_id ?? null;
  }
  bindSessionRun(home, sessionId, { runId, workspace, source });
  return rebound !== undefined ? { rebound_from: rebound } : {};
};

/** 批㊶-P1 S3：同 run_id 双启请示闸（防御纵深）——作用域会话在场＝同 run 已有训练会话，
 *  经请示卡（DSH user-questions——ask_user_for_input 通道）问用户是否清旧重启；确认词
 *  恰为 `yes` 才放行，取消（ASK_CANCELLED）/其他应答/服务缺失一律拒绝（fail-closed——
 *  不静默双启不静默清场）。审批≠请示：danger 卡已过≠同意丢旧现场，重启须显式二次确认。 */
export const confirmDoubleLaunch = async (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; callId?: string; signal?: unknown },
  runId: string,
  sessionName: string,
  runDir?: string,
): Promise<{ ok: true } | { ok: false; outcome: string; note: string }> => {
  const userQuestions = ctx.get("userQuestions") as FormAskService | undefined;
  if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
    return { ok: false, outcome: "user_questions_unavailable", note: "同 run_id 训练会话已在场且请示通道（user-questions）未挂载——fail-closed 不启动：不静默双启，也不静默清理在跑会话；请先人工核会话现场（tmux 侧）再重推" };
  }
  try {
    const answers = await userQuestions.ask({
      questions: [formAskQuestion({
        id: `double-launch-${runId}`,
        question: `训练会话已存在（run ${runId}）——是否清理旧会话并重启？`,
        header: "双启确认",
        detail: `同 run_id 的训练会话 ${sessionName} 已在场（重复触发场景）。清理重启＝终止旧会话内进程（现场日志已落盘可追溯）；取消＝本次启动不动旧会话。proceed 填 yes 才重启；留空/no/其他＝取消。`,
        fields: [{ key: "proceed", label: "proceed（是否清理重启）", value: "no", hint: "仅接受 yes；no/留空＝取消本次启动" }],
        submitLabel: "提交",
      })],
      agent: exec.agent,
      signal: exec.signal,
    });
    const proceed = editsFromFormAnswers(answers)["proceed"]?.trim().toLowerCase() === "yes";
    return proceed
      ? { ok: true }
      : { ok: false, outcome: "declined", note: `双启请示未确认（proceed≠yes）——本次不启动，旧会话原样保留（run ${runId}）` };
  } catch (cause) {
    // A1 伴生缺陷收口：卡通道失败落 run 目录诊断（runDir 可得时——路径随 note 可定位）
    const diagRel = runDir !== undefined
      ? appendAskFailureDiagnostic(runDir, "atf_run_training", `double-launch-${runId}`, cause)
      : undefined;
    if ((cause as { code?: string }).code === "ASK_CANCELLED") {
      return { ok: false, outcome: "cancelled", note: `双启请示卡被关闭（取消）——本次不启动，旧会话原样保留（run ${runId}）` };
    }
    return { ok: false, outcome: "ask_failed", note: `双启请示卡应答失败：${String(cause).slice(0, 200)}${diagRel !== undefined ? `（通道诊断已落 run 目录 ${diagRel}）` : ""}——fail-closed 不启动` };
  }
};

// 批㊶-K 项 4：进料面提取共享（src/core/workspace/lossIngest.ts）——atf_launch_execute
// 登记放行后同挂（harness-launch-*.log 此前无人监控＝曲线进料断根因面）；本文件 re-export 兼容面。
export { parseTrainerLine, startLossIngest } from "../../../../src/core/workspace/lossIngest.js";

/** 训练 master 端口占用者（批⑳dot3 修复 3）。 */
export interface PortOccupant {
  pid: number;
  name: string;
  cmdline: string;
  /** 疑似上轮训练残留（torchrun/launcher/llamafactory/deepspeed 特征）——唯此类允许自动清理。 */
  residueLike: boolean;
}

/** 残留特征（cmdline/进程名任一命中即疑似上轮训练残留）。单源迁移 gpuQueueFace（批㊶-W F6 ④归属分类共用）——re-export 兼容面。 */
export { TRAINING_RESIDUE_PATTERN };

/** train.sh 文本 → master_port（`MASTER_PORT=${MASTER_PORT:-N}` 与 `MASTER_PORT=N` 两形态；缺省 29517）。 */
export function extractMasterPort(trainShText: string, fallback = 29_517): number {
  const m = /MASTER_PORT=(?:\$\{MASTER_PORT:-)?(\d{4,5})/.exec(trainShText);
  return m ? Number(m[1]) : fallback;
}

/** bind 探测：true＝端口空闲（探测套接字即关）；false＝已被占。 */
const bindProbe = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });

/** ss -tlnp → 占用者身份（ss 不可用/无 pid 时信息尽力而为，pid=0 表示未能识别）。 */
const portOccupantFromSs = (port: number): PortOccupant | null => {
  try {
    const out = execSync("ss -tlnp 2>/dev/null", { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }).toString();
    const line = out.split("\n").find((l) => l.includes(`:${port} `));
    if (line === undefined) return { pid: 0, name: "", cmdline: "", residueLike: false };
    const pidMatch = /pid=(\d+)/.exec(line);
    const nameMatch = /\("([^"]+)"/.exec(line);
    const pid = pidMatch !== null ? Number(pidMatch[1]) : 0;
    let cmdline = "";
    if (pid > 0) {
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 160);
      } catch { /* 权限或已消失 */ }
    }
    const residueLike = TRAINING_RESIDUE_PATTERN.test(`${nameMatch?.[1] ?? ""} ${cmdline}`);
    return { pid, name: nameMatch?.[1] ?? "", cmdline, residueLike };
  } catch {
    return { pid: 0, name: "", cmdline: "", residueLike: false };
  }
};

/** 端口占用探针：null＝空闲；其余为占用（占用者身份尽力识别）。 */
export async function probePortOccupant(port: number): Promise<PortOccupant | null> {
  const free = await bindProbe(port);
  if (free) return null;
  return portOccupantFromSs(port);
}

/** 清理疑似残留占用进程：SIGTERM→3s 宽限→SIGKILL；返回是否已退出。 */
export async function terminateOccupant(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true; // 已不存在
  }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** 批㊶-S1 段 1/2：闭环推荐层事实核对（确定性事实＝实锚目录/产物核对；推荐语由 agent 指引面
 *  承载——❌禁 if-else 业务规则，本块只列事实与可直用参数）。 */
export interface EvalReadiness {
  training_done: boolean;
  checkpoint_candidates: string[];
  latest_checkpoint: string | null;
  /** 以下三键单值形态＝N=1 该类在场值；N>1 为 null（逐类明细看 doc_slots）——E9a·H2。 */
  eval_assets_dir: string | null;
  field_config: string | null;
  split_manifest: string | null;
  four_set_ready: boolean;
  badcases_ready: boolean;
  /** E9a·H2：逐类评估三件明细（走 docSlots 表；缺项类带 missing 清单——miss 不静默）。 */
  doc_slots: Array<{
    doc_type: string;
    eval_assets_dir: string | null;
    field_config: string | null;
    split_manifest: string | null;
    missing?: string[];
  }>;
  /** E9a·H2：缺项人话清单（哪类缺什么；无槽位＝legacy 说明行）。 */
  missing: string[];
}

export const collectEvalReadiness = (runDir: string): EvalReadiness => {
  const trainingDir = join(runDir, "training");
  let ckpts: string[] = [];
  try {
    ckpts = existsSync(trainingDir)
      ? readdirSync(trainingDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^checkpoint-\d+$/.test(d.name) && existsSync(join(trainingDir, d.name, "adapter_model.safetensors"))).map((d) => d.name).sort()
      : [];
  } catch { /* 缺目录＝空候选 */ }
  // E9a·H2：评估三件一律走 docSlots 唯一路径表（publish/<doc>/<attempt>/eval、
  // experiment-setup/<doc>/field-config.json、publish/<doc>/<attempt>/split-manifest.json
  // ——ADR-0017 决定 10 评估输入逐类）；旧平铺探测（l1/eval、l1/field_config.json、
  // prep/field_config.json、l1/split-manifest.json、split/…）整链退役。miss 不静默：
  // 逐类给缺项清单（哪类缺什么），单值三键仅 N=1 填该类在场值。
  const slots = listDocSlots(runDir);
  const evalAssetsReady = (dir: string | null): boolean =>
    dir !== null && existsSync(join(dir, "test_images.json")) && existsSync(join(dir, "eval_labels.jsonl"));
  const docDetails = slots.map((slot) => {
    const missing: string[] = [];
    if (!evalAssetsReady(slot.eval_assets_dir)) missing.push("评估资产（test_images.json＋eval_labels.jsonl）");
    if (slot.eval_assets_dir === null) missing.push("评估资产目录（该类尚未发布——无 attempt 工作区）");
    if (!existsSync(slot.field_config)) missing.push("字段配置（field-config.json）");
    if (slot.split_manifest === null || !existsSync(slot.split_manifest)) missing.push("分区清单（split-manifest.json）");
    return {
      doc_type: slot.doc_type,
      eval_assets_dir: evalAssetsReady(slot.eval_assets_dir) ? slot.eval_assets_dir : null,
      field_config: existsSync(slot.field_config) ? slot.field_config : null,
      split_manifest: slot.split_manifest !== null && existsSync(slot.split_manifest) ? slot.split_manifest : null,
      ...(missing.length > 0 ? { missing } : {}),
    };
  });
  const sole = slots.length === 1 ? docDetails[0]! : null;
  const evalAssets = sole !== null ? sole.eval_assets_dir : null;
  const fieldConfig = sole !== null ? sole.field_config : null;
  const splitManifest = sole !== null ? sole.split_manifest : null;
  const missing = slots.length === 0
    ? ["无单据槽位（data/variants/ 下无含 train.jsonl 的单据子目录；v2 存量 prep/variants/ 只读兼容）——legacy 平铺 run 的评估三件不再自动探测，槽位化后重推"]
    : docDetails.flatMap((detail) =>
        ((detail as { missing?: string[] }).missing ?? []).map((item) => `${detail.doc_type} 类缺${item}`));
  const evalRoot = join(runDir, "eval");
  let fourSetReady = false;
  try {
    const rounds = readdirSync(evalRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d+-\d{8}$/.test(e.name)).map((e) => e.name).sort();
    for (const round of rounds) {
      const orchEval = join(evalRoot, round, "orch", "eval");
      if (["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"].every((f) => existsSync(join(orchEval, f)))) { fourSetReady = true; break; }
    }
  } catch { /* eval 根缺失 */ }
  const badcasesReady = (() => {
    try {
      const rounds = readdirSync(evalRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d+-\d{8}$/.test(e.name)).map((e) => e.name).sort();
      for (const round of rounds) {
        if (existsSync(join(evalRoot, round, "orch", "eval", "badcases.jsonl"))) return true;
      }
    } catch { /* 同上 */ }
    return false;
  })();
  return {
    training_done: ckpts.length > 0,
    checkpoint_candidates: ckpts,
    latest_checkpoint: ckpts.length > 0 ? join(trainingDir, ckpts[ckpts.length - 1] as string) : null,
    eval_assets_dir: evalAssets,
    field_config: fieldConfig,
    split_manifest: splitManifest,
    four_set_ready: fourSetReady,
    badcases_ready: badcasesReady,
    // E9a·H2：逐类明细＋缺项清单（走表单源——miss 不静默）
    doc_slots: docDetails,
    missing,
  };
};

/** 批㊶-S1 段 3：模型发布（语义 C——归档＋登记＋并入模型清单；§三.2 四件套齐即可，门槛不硬编码）。 */
export interface ModelPublishCheck {
  ok: boolean;
  reason?: string;
  four_set_ready?: boolean;
}

export const checkModelPublishPrereq = (runDir: string): ModelPublishCheck => {
  const readiness = collectEvalReadiness(runDir);
  if (!readiness.four_set_ready) return { ok: false, reason: "four_set_missing", four_set_ready: false };
  return { ok: true, four_set_ready: true };
};

/** danger 卡端口冲突文案（根因上卡面——撞前知道）。 */
export function formatPortConflictNote(port: number, occupant: PortOccupant): string {
  const who = occupant.pid > 0
    ? `进程 ${occupant.pid}(${(occupant.cmdline || occupant.name || "未知").slice(0, 120)})`
    : "未知进程（占用者身份识别不可用）";
  return occupant.residueLike
    ? `端口 ${port} 已被${who}占用——疑似上轮残留，建议清理后重试 [确认清理并重试] [手动处理]`
    : `端口 ${port} 已被${who}占用——非训练进程，不自动清理，请手动处理后重试 [手动处理]`;
}

/** 评估服务声明名：basename(model_name_or_path)＋adapter 后缀（批⑳dot3 修复 2——禁 OpenAI 缺省名）。 */
export function deriveDeclaredModelName(modelNameOrPath: string, hasAdapter: boolean): string {
  const base = modelNameOrPath.split("/").filter(Boolean).pop() ?? modelNameOrPath;
  return hasAdapter ? `${base}-lora` : base;
}

/** metrics_summary 落盘标签的前缀复核（gpt- 或 claude- 前缀即缺省泄漏）。 */
export function modelLabelLooksDefault(model: unknown): boolean {
  return typeof model === "string" && /^(gpt-|claude-)/i.test(model.trim());
}

/** tmux 面查询统一走 src/core/workspace/tmuxLiveness.ts probeSession（批㊶-ISO E1 单源——
 *  命名域前缀拼装与 fail-closed 拒绝同源，本文件不再自建包装）。 */

/** E5·H2（D142/D143）评估链实例根单源：内核子步显式接收的 home 根（禁依赖子进程
 *  Path.home() 隐式继承——env -i／HOME 漂移／tmux 旧服务端分轴下解析仍稳定）。
 *  解析序＝ATF_HOME（实例显式键）＞ HOME（实例 env 轴）＞ 系统家（getpwuid 锚——
 *  userInfo().homedir 不读 env，env -i 下仍是真家；异常回落 homedir()）。
 *  DSH_HOME 是 <home>/.dsh 派生位非家本身，不入序（当根传会把账本写进 .dsh 子树）。
 */
export type EvalInstanceRootSource = "atf_home_env" | "home_env" | "system_home";

export const resolveEvalInstanceRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  systemHome: () => string = () => {
    try { return userInfo().homedir; } catch { return homedir(); }
  },
): { root: string; source: EvalInstanceRootSource } => {
  const atfHome = env["ATF_HOME"]?.trim();
  if (atfHome !== undefined && atfHome !== "") return { root: atfHome, source: "atf_home_env" };
  const homeEnv = env["HOME"]?.trim();
  if (homeEnv !== undefined && homeEnv !== "") return { root: homeEnv, source: "home_env" };
  return { root: systemHome(), source: "system_home" };
};

/** 评估子步 env 构造（E5·H2）：实例 env 原样继承＋HOME 显式钉到实例根（子步内
 *  Path.home() 与 shell ${HOME} 解析单源；ATF_HOME 等实例键随继承面在场）。 */
const evalChildEnvOf = (env: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv =>
  ({ ...env, HOME: resolveEvalInstanceRoot(env).root } as NodeJS.ProcessEnv);

/** 内核模块入口（`python3 -m agentic_training_flow ...`）env：实例 env 轴＋PYTHONPATH 指向
 *  **pin 内核**（<kernelDir>/src 在场优先——包直挂 kernelDir 兜底，与 bridgeCommand 派生同序）。
 *  显式前置内核根：调用方进程 PYTHONPATH 若指别的检出，不抢占 pin 单源。 */
const kernelPythonEnvOf = (kernelDir: string, env: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv => {
  const base = evalChildEnvOf(env);
  const kernelSrc = existsSync(join(kernelDir, "src", "agentic_training_flow")) ? join(kernelDir, "src") : kernelDir;
  const inherited = base["PYTHONPATH"]?.trim();
  return { ...base, PYTHONPATH: inherited !== undefined && inherited !== "" ? `${kernelSrc}:${inherited}` : kernelSrc };
};

/** 评估实例 env-profiles 目录（atf_evaluate 的 env_profile 派生面）。
 *  根解析＝ATF_INSTANCE_ROOT ＞ ATF_HOME，**不读 HOME**——HOME 在 env -i／tmux 旧服务端
 *  分轴下会漂到别的家，把档案目录指到不存在的位置；目录布局 <root>/.atf/env-profiles
 *  （内核 env_profile.py 同布局）。根不可得＝null（调用方如实报缺，不自拟路径）。 */
export const evalEnvProfilesDirOf = (env: Readonly<Record<string, string | undefined>> = process.env): string | null => {
  const root = env["ATF_INSTANCE_ROOT"]?.trim() || env["ATF_HOME"]?.trim();
  return root !== undefined && root !== "" ? join(root, ".atf", "env-profiles") : null;
};

/** 档案摘要（用户面候选行：文件名＋其 eval_env＋绑卡摘要——不读库、不猜值）。 */
export interface EnvProfileSummary {
  name: string;
  file: string;
  eval_env: string | null;
  cuda_visible_devices: string | null;
}

const envProfileTextOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const envProfileSummaryOf = (file: string, path: string): EnvProfileSummary => {
  const base = { name: file.replace(/\.json$/i, ""), file };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const trainRaw = record["train"];
    const train = trainRaw !== null && typeof trainRaw === "object" ? (trainRaw as Record<string, unknown>) : {};
    return {
      ...base,
      eval_env: envProfileTextOf(train["eval_env"]) ?? envProfileTextOf(record["eval_env"]),
      cuda_visible_devices: envProfileTextOf(train["visible_devices"])
        ?? envProfileTextOf(train["cuda_visible_devices"])
        ?? envProfileTextOf(record["cuda_visible_devices"]),
    };
  } catch {
    return { ...base, eval_env: null, cuda_visible_devices: null };
  }
};

/** 档案目录内 .json 文件名（升序；目录不可读＝空——如实报缺不造候选）。 */
const envProfileFilesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => /\.json$/i.test(name) && !name.startsWith(".")).sort();
  } catch {
    return [];
  }
};

/** F11-2——实例档案清单（工具描述注入面）：启动时读一次实例 env-profiles 目录，列
 *  实际档案名＋各自 eval_env 摘要（形如 `实例档案：<档案名>(eval_env=<venv 路径>)`）。
 *  目录不可得／目录内无 .json ＝ null（调用方保留原文案并标「目录不可得」）；**不写死
 *  任何实例的档案名**——名字只来自运行时磁盘。 */
export const envProfileCatalogLineOf = (env: Readonly<Record<string, string | undefined>> = process.env): string | null => {
  const dir = evalEnvProfilesDirOf(env);
  if (dir === null) return null;
  const files = envProfileFilesOf(dir);
  if (files.length === 0) return null;
  const entries = files.map((file) => {
    const summary = envProfileSummaryOf(file, join(dir, file));
    return `${summary.name}(eval_env=${summary.eval_env ?? "缺"})`;
  });
  return `实例档案：${entries.join("、")}`;
};

export type EnvProfileResolution =
  | { ok: true; name: string; source: string }
  | { ok: false; payload: Record<string, unknown> };

/** env_profile 解析（atf_evaluate action=start）：显式值＞实例目录派生。
 *  派生只在**目录内恰一份**含 eval_env 的档案时成立（回执带 instance_default(<名>)）；
 *  多份＝env_profile_ambiguous（列候选：文件名＋eval_env＋绑卡摘要，交上层出选项卡）；
 *  零份／无目录＝env_profile_not_found（列目录内**全部**档案名及各自 eval_env——
 *  让调用方从实存档案里挑，禁编名字）。 */
export const resolveEvalEnvProfile = (
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvProfileResolution => {
  const given = explicit?.trim();
  if (given !== undefined && given !== "") return { ok: true, name: given, source: "explicit" };
  const dir = evalEnvProfilesDirOf(env);
  const files = dir === null ? [] : envProfileFilesOf(dir);
  const profiles = files.map((file) => envProfileSummaryOf(file, join(dir as string, file)));
  const usable = profiles.filter((profile) => profile.eval_env !== null);
  if (dir !== null && usable.length === 1) {
    const only = usable[0] as EnvProfileSummary;
    return { ok: true, name: only.name, source: `instance_default(${only.name})` };
  }
  if (dir !== null && usable.length > 1) {
    return {
      ok: false,
      payload: {
        started: false, error: "env_profile_ambiguous", dir,
        candidates: usable.map((profile) => ({
          name: profile.name, file: profile.file,
          eval_env: profile.eval_env, cuda_visible_devices: profile.cuda_visible_devices,
        })),
        note: `实例环境档案目录里有多份可用档案（${usable.map((profile) => profile.name).join("、")}）——不自动挑一份：让用户从中选一个，再把档案名作为 env_profile 重推`,
      },
    };
  }
  const listed = profiles.map((profile) => `${profile.name}（eval_env=${profile.eval_env ?? "缺"}）`);
  return {
    ok: false,
    payload: {
      started: false, error: "env_profile_not_found", ...(dir !== null ? { dir } : {}),
      profiles: profiles.map((profile) => ({
        name: profile.name, file: profile.file,
        eval_env: profile.eval_env, cuda_visible_devices: profile.cuda_visible_devices,
      })),
      note: dir === null
        ? "未给 env_profile，且实例根不可得（ATF_INSTANCE_ROOT／ATF_HOME 均未设）——无法派生档案目录；请显式给出 env_profile（档案名，见实例目录 .atf/env-profiles/*.json 文件名）"
        : `未给 env_profile，且 ${dir} 内没有唯一的可用档案（可用＝train.eval_env 在场）——目录内现有档案：${listed.length > 0 ? listed.join("、") : "无 .json 文件"}；让用户指定其中之一，不要自拟档案名`,
    },
  };
};

/** 评估编排 tmux 命令 env 前缀（E5·H2——训练链 ledgerEnvPrefixForShell 同构扩展）：
 *  HOME 钉实例根＋ATF_APPROVAL_LEDGER 显式前缀（编排脚本内 ${ATF_APPROVAL_LEDGER:-${HOME}/...}
 *  运行时解析不随 tmux 旧服务端 env 分轴漂移；未设则只注 HOME）。 */
const evalTmuxEnvPrefixOf = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const parts = [`HOME=${shellSingleQuoted(resolveEvalInstanceRoot(env).root)}`];
  const ledger = env["ATF_APPROVAL_LEDGER"]?.trim();
  if (ledger !== undefined && ledger !== "") parts.push(`ATF_APPROVAL_LEDGER=${shellSingleQuoted(ledger)}`);
  return `env ${parts.join(" ")} `;
};

/** 子步捕获封装（E5·H2：env 可选显式传——评估链五子步一律传 evalChildEnvOf()；
 *  未传＝继承（既有训练链行为不动）。非零退出/超时如实回传，不抛。 */
const runCapture = (cmd: string, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, ...(env !== undefined ? { env } : {}) }, (error, stdout, stderr) => {
      const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({ code: typeof rawCode === "number" ? rawCode : null, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** 批次 R H1-3：每卡 free 行（nvidia-smi 机器事实——gpu_capacity_insufficient 人话回流附表；
 *  不可用＝undefined（如实缺表不猜）；free＝total−used 派生，非 nvidia-smi 直报。 */
const gpuFreeRowsForErrorFace = async (): Promise<string[] | undefined> => {
  const cards = await queryNvidiaSmiAll();
  if (cards === null) return undefined;
  return cards.map((card) => {
    const used = Number(String(card.memoryUsed).replace(/[^0-9]/g, ""));
    const total = Number(String(card.memoryTotal).replace(/[^0-9]/g, ""));
    const free = Number.isFinite(used) && Number.isFinite(total) ? total - used : null;
    return `GPU ${card.index}: util ${card.utilization}, mem ${card.memoryUsed}/${card.memoryTotal}, free ${free !== null ? `${free} MiB` : "（不可得）"}`;
  });
};

export interface TrainingToolsConfig {
  runsRoot: string;
  /** 训练日志落点目录（tail 进料源与 tee 目标同路径）。 */
  logDir: string;
  ctx: { get(service: string): unknown };
  /** 批㊶R前置 状态面：本机模型清单（apply 启动扫描注入——入工具描述供 agent 会话内可见）。 */
  models?: { root: string; names: string[] };
  /** 批㊶-TRAIN-OBS-FIX2 T1：内核侧会话绑定闭包（BridgeManager.bindRun——装配点注入；
   *  缺省＝不绑（测试/无桥装配形态）。fail-open 语义在闭包内，工具主流程不感知）。 */
  bindRun?: (runId: string) => Promise<void>;
  /** D49：canonical 解析种子（注册工作区根清单——测试注入面；缺省 listRegistryRecords 实例态）。 */
  canonicalRoots?: readonly string[];
}

/** status 结果形状（任务卡卡面输入）。 */
export interface TrainingStatusValue {
  action?: string;
  run_id?: string;
  segments?: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
  running?: boolean;
  /** 批㊶-ISO E1：运行态 tmux 会话名（命名域解析值——随环境前缀自然变化，零开发叙事）。 */
  tmux?: string;
  /** 批㊶-ISO E1：tmux 探测被命名域拒绝时的回流（fail-closed——guidance 随卡面可见）。 */
  tmux_probe?: { ok: false; reason: string; guidance: string } | null;
  loss_points?: number;
  ckpts?: string[];
  latest_ckpt?: string;
}

/** 任务卡卡面文本（chat 卡单点——批㉑三段任务卡入口）：status 结果渲染八段 checklist。
 *  liveness 权威面＝tmux 探测：running=true 时训练段展示提升 active（段标记的
 *  loss-series 在场=done 是面板段语义，进程态由本覆盖呈现，两者不混）。 */
export function renderTaskCardText(value: TrainingStatusValue): string | null {
  if (value?.action !== "status" || !Array.isArray(value.segments)) return null;
  const segs = value.running === true
    ? value.segments.map((s) => (s.key === "training" && s.status === "done" ? { ...s, status: "active" as const } : s))
    : value.segments;
  // 批㊶-ISO E1：进程行随解析会话名自然变化；探测被命名域拒绝时如实呈现拒绝语义（guidance 可见）
  const processLine = value.running === true
    ? `运行中（tmux ${value.tmux ?? ""}）`
    : value.tmux_probe
      ? `未运行（tmux 探测拒绝：${value.tmux_probe.guidance}）`
      : "未运行";
  return [
    `训练任务卡 — run ${value.run_id ?? "?"}`,
    formatTaskCard({ segments: segs }),
    `训练进程：${processLine}`,
    `loss 点数：${String(value.loss_points ?? 0)}`,
    ...(Array.isArray(value.ckpts) && value.ckpts.length > 0 ? [`checkpoint：${value.ckpts.join("、")}`, `latest：${value.latest_ckpt ?? ""}`] : []),
  ].join("\n");
}

/** atf_run_training（action: start/status）——danger 必确认。 */
export const buildRunTrainingTool = (ctx: { get(service: string): unknown }, cfg: TrainingToolsConfig) =>
  defineTool({
    name: "atf_run_training",
    description:
      "训练本机重跑（降格定界——atf_launch_execute 为唯一编排执行点，本工具仅限「账本已放行 config 的本机重跑」）：action=start 校验 train.sh（DRY_RUN 过）→prelaunch 报告在场检查（prepare SKILL.md:84 确认制——缺失拒绝）→base_model.path 本地复核（防线③——家族名/HF id 一律拒）→端口预检→danger 卡放行→tmux 会话常驻执行＋stdout tail 进料监控（loss-series）；action=status 查询运行状态并返回八段任务卡（chat 流可见的 checklist——训练推进期请周期调用 status，把最新任务卡呈现给用户）。异常即停即报，不静默重试。" +
      (cfg.models !== undefined
        ? `本机可用模型清单（ATF_MODEL_ROOT=${cfg.models.root}）：${cfg.models.names.length > 0 ? cfg.models.names.join("、") : "（空）"}——iteration-config 的 base_model.path 必须是这些本地目录的绝对路径，禁止填 HF 家族名/仓库 id（如 qwen3_vl）。`
        : ""),
    parameters: {
      action: { type: "string", required: true, enum: ["start", "status"], description: "start=放行后启动训练；status=查询状态与 ckpt" },
      train_sh: { type: "string", required: true, description: "train.sh 绝对路径（须已通过 DRY_RUN 校验）" },
      run_id: { type: "string", required: true, description: "新实验标识；创建成功后自动绑定本会话（监控数据/ckpt 归属）" },
      prelaunch_report: { type: "string", description: "build_prelaunch_report.py 产物路径（缺省自动扫 train.sh 同目录 prelaunch*——两处皆无即拒绝启动）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        // 任务卡 chat 卡面：status 结果带段状态时渲染八段 checklist——run 推进期 agent
        // 每次 status 轮询即把最新任务卡贴进对话流；其余形态保持 JSON 卡面。
        const card = renderTaskCardText(value as TrainingStatusValue);
        return [{ type: "text" as const, text: card ?? JSON.stringify(value, null, 1) }];
      },
    },
    presentCall: function(args: { action: string; run_id: string }) {
      return {
        card: "generic" as const,
        title: args.action === "status" ? `训练状态查询 — ${args.run_id}` : `训练执行 — ${args.run_id}`,
        kind: "other" as const,
      }
    },
    async execute(args: { action: string; train_sh: string; run_id: string; prelaunch_report?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批㊶Q增补三 段3：run 目录双形态解析（存量平铺＋新桶 runs/<工作区>/<run_id>——单源 resolveRunDir）
      const runDir = resolveRunDir(cfg.runsRoot, args.run_id, { canonicalRoots: canonicalRunRootsOf(cfg) });
      if (args.action === "status") {
        // 批㊶-ISO E1：探测走命名域单源（前缀未设＝refused fail-closed——guidance 随 payload 回流）
        // 批㊶-P1 S1：基名作用域化——按 run_id 取名，同实例并发 run 各探各的会话
        const sessionBase = trainingSessionBase(args.run_id);
        const probe: SessionProbe = probeSession(sessionBase);
        const running = probe.present;
        const sessionName = resolveLaunchSessionName(sessionBase);
        const ckptDir = join(runDir, "training");
        const ckpts = existsSync(ckptDir)
          ? (await import("node:fs")).readdirSync(ckptDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("checkpoint-")).map((d) => d.name)
          : [];
        const lossPath = join(ckptDir, "loss-series.json");
        const points = existsSync(lossPath) ? (JSON.parse(readFileSync(lossPath, "utf8")) as unknown[]).length : 0;
        // 八段任务卡段状态（与监控同步器同源推导——scanRunDir 单源；双形态根＝dirname(runDir)）
        const segments = buildMonitorSnapshot([scanRunDir(dirname(runDir), basename(runDir), {
          trainingTmuxPresent: probe.present,
          trainingEvidence: { [args.run_id]: tmuxTrainingEvidenceFor(args.run_id) },
        })]).runs[0]?.segments ?? [];
        // 批㊶-N N-3：段内进度持久化（loss-series 末点→round/total_rounds/loss 推导；写失败静默）
        let lastLoss: number | null = null;
        try {
          if (existsSync(lossPath)) {
            const series = JSON.parse(readFileSync(lossPath, "utf8")) as Array<{ train_loss?: number }>;
            for (let i = series.length - 1; i >= 0; i -= 1) {
              if (typeof series[i]?.train_loss === "number") { lastLoss = series[i]!.train_loss!; break; }
            }
          }
        } catch { /* 进度推导失败＝无进度 */ }
        if (lastLoss !== null) {
          writeProgress(runDir, {
            round: points,
            loss: lastLoss,
            updated_at: new Date().toISOString(),
          });
        }
        // 批㊶-N N-5：会话绑定（exec.agent.session.id——vendor 链路实锚）
        const sessionId = sessionIdOf(exec);
        if (sessionId !== undefined) appendBinding(runDir, sessionId);
        // 批㊶-S1 段 1/2：闭环推荐层事实核对块（确定性事实；推荐语 agent 指引面承载）
        const readiness = collectEvalReadiness(resolveRunDir(cfg.runsRoot, args.run_id, { canonicalRoots: canonicalRunRootsOf(cfg) }));
        return asToolValue({
          action: "status", running, run_id: args.run_id, segments, ckpts, loss_points: points,
          tmux: sessionName,
          ...(probe.refused !== null ? { tmux_probe: probe.refused } : {}),
          ...(ckpts.length > 0 ? { latest_ckpt: `runs/${args.run_id}/training/${ckpts[ckpts.length - 1]}` } : {}),
          next_steps: {
            eval_ready: readiness.training_done,
            checkpoint_candidates: readiness.checkpoint_candidates,
            latest_checkpoint_path: readiness.latest_checkpoint,
            eval_assets_dir: readiness.eval_assets_dir,
            field_config: readiness.field_config,
            split_manifest: readiness.split_manifest,
            note: readiness.training_done
              ? "训练段产物在位——评估衔接参数（run_id/adapter_path 取上方实锚候选）已可直接用于 atf_evaluate start"
              : "训练段产物未齐（无含 adapter 的 checkpoint）——无评估衔接事实",
          },
        });
      }
      // —— start：DRY_RUN 校验 → 端口预检（批⑳dot3 修复 3）→ danger 必确认 → 启动 ——
      // DRY_RUN 前置校验（打印型零副作用，先于审批——坏脚本不进卡面）
      const dry = await runCapture("bash", [args.train_sh], 60_000).then(async (r) => {
        void r;
        const env = { ...process.env, DRY_RUN: "1" } as Record<string, string>;
        const { execFile: ef } = await import("node:child_process");
        return await new Promise<{ code: number | null; stdout: string }>((resolve) => {
          ef("bash", [args.train_sh], { timeout: 60_000, env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            const raw = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
            resolve({ code: typeof raw === "number" ? raw : null, stdout: String(stdout) });
          });
        });
      });
      if (dry.code !== 0 || !dry.stdout.includes("ADMISSION=pass")) {
        return asToolValue({ started: false, error: "DRY_RUN 未通过（数据准入/命令面校验失败）——不启动训练", dry_stdout_head: dry.stdout.slice(0, 500) });
      }
      // prelaunch 报告在场检查（批㉕B 段4——prepare SKILL.md:84「报告未生成视为训练放行准入未闭合」）
      const prelaunch = args.prelaunch_report ?? findPrelaunchReport(dirname(args.train_sh));
      if (prelaunch === null) {
        return asToolValue({ started: false, error: "prelaunch_report_missing", train_sh: args.train_sh, note: "授权启动前必须产出 build_prelaunch_report.py 报告（prepare SKILL.md:84——报告未生成视为训练放行准入未闭合）；编排启动走 atf_launch_execute（唯一编排执行点）" });
      }
      // 批㊶R前置 防线③（start 面复核——纵深防御：内核旧版 skills 残留于某实例时仍拦截）：
      // 读 iteration-config 的 base_model.path 本地复核；失败秒拒＋本机可用模型清单回流
      // （payload 纯增量＝补登不 bump；不进审批、不进 tmux、不产任何训练进程）
      const startRunDir = resolveRunDir(cfg.runsRoot, args.run_id, { canonicalRoots: canonicalRunRootsOf(cfg) });
      const modelCheck = checkStartModelPath(startRunDir, process.env);
      if (!modelCheck.ok) {
        return asToolValue({
          started: false,
          error: "model_path_missing",
          reason: modelCheck.reason,
          model_path: modelCheck.path ?? null,
          models: modelCheck.models,
          models_root: modelCheck.root,
          train_sh: args.train_sh,
          run_id: args.run_id,
          note: `start 面复核拒绝：iteration-config 的 base_model.path（${modelCheck.path ?? "缺席"}）${modelCheck.reasonText}——不进训练进程。本机可用模型（${modelCheck.root}）：${modelCheck.models.length > 0 ? modelCheck.models.join("、") : "（清单为空）"}；请改用本地绝对路径后重推`,
        });
      }
      // 端口预检：占用即根因上卡面；非训练进程占用 fail-closed 不自动清理
      const port = extractMasterPort(readFileSync(args.train_sh, "utf8"));
      const occupant = await probePortOccupant(port);
      if (occupant !== null && !occupant.residueLike) {
        return asToolValue({ started: false, error: "port_occupied_non_residue", port, occupant, note: formatPortConflictNote(port, occupant) });
      }
      const conflictNote = occupant !== null ? `\n${formatPortConflictNote(port, occupant)}` : "";
      // 训练自动驾驶（Agent 预设 = atf-training **且** 权限档 = danger-full-access）下，
      // 方案确认与段卡免逐段确认；但本 danger 卡永远保留人工审批（真实 GPU 代价操作一次
      // 人工确认，产品纪律；atf_run_training 不进 chainTools）。ADR-07 内核侧账本闸门不变
      // （train.sh 内放行记录校验原样保留，无记录 exit 78）。非自动驾驶审批链零变化。
      const autoTierStart = isTrainingAutopilot(ctx, exec);
      const verdict = await requestApproval(ctx, exec, "atf_run_training",
        buildApprovalReason({
          action: "启动真实 GPU 训练",
          target: `（train.sh=${args.train_sh}）`,
          effect: "占用 GPU 与写训练产物（卡数/时长以本次训练方案卡与 train.sh 为准）",
          reversible: "不可自动回滚（产物可人工清理）",
        }) + conflictNote);
      if (!verdict.ok) return approvalDeniedResult("atf_run_training", verdict.outcome);
      // 批㊶-W F7：方案确认值 → train.sh 生成面逐键透传对账（start 面即拒——awb_r1
      // 首跑 nproc 确认 8 生成 1 被静默丢弃的回归锚）。对账基线＝config-snapshot.confirmed
      // ＞iteration-config training 段；两处皆缺＝无对账对象（存量 run 重跑兼容——账本
      // 闸门仍在 train.sh 内），跳过对账并在结果如实标注 reconcile: "skipped_no_baseline"。
      const confirmedBaseline: Record<string, string> | null = (() => {
        const snapDir = resolveRunDir(cfg.runsRoot, args.run_id, { canonicalRoots: canonicalRunRootsOf(cfg) });
        const snapPath = resolveRunFile(snapDir, "webui/config-snapshot.json");
        try {
          if (existsSync(snapPath)) {
            const parsed = JSON.parse(readFileSync(snapPath, "utf8")) as { confirmed?: Record<string, string> };
            if (parsed.confirmed !== undefined && parsed.confirmed !== null) return parsed.confirmed;
          }
        } catch { /* 降级 iteration-config */ }
        for (const candidate of iterationConfigCandidates(snapDir)) {
          try {
            if (!existsSync(candidate)) continue;
            const iter = JSON.parse(readFileSync(candidate, "utf8")) as { training?: Record<string, unknown> };
            if (iter.training === undefined || iter.training === null) continue;
            const flat: Record<string, string> = {};
            for (const [key, value] of Object.entries(iter.training)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") flat[key] = String(value);
            }
            return Object.keys(flat).length > 0 ? flat : null;
          } catch { /* 下一候选 */ }
        }
        return null;
      })();
      let reconcileSkipped = false;
      let requiredCards = 1;
      let reconcile: ReturnType<typeof reconcileConfirmedWithTrainSh> | null = null;
      if (confirmedBaseline === null) {
        reconcileSkipped = true;
      } else {
        reconcile = reconcileConfirmedWithTrainSh(confirmedBaseline, readFileSync(args.train_sh, "utf8"));
        if (!reconcile.ok) {
          return asToolValue({
            started: false,
            error: "train_sh_reconcile_failed",
            train_sh: args.train_sh,
            mismatches: reconcile.mismatches,
            extracted: reconcile.extracted,
            note: `透传对账失败（确认值与 train.sh 生成面不符——F7 拒绝，不静默换算）：${formatReconcileDiff(reconcile.mismatches)}——重新走 training_prep 生成 train.sh（或修正确认卡）后重推`,
          });
        }
        // 批㊶-W F6 ③：整组判定所需卡数＝train.sh NPROC_PER_NODE ＞ 确认快照 nproc ＞ 1（保守）
        requiredCards = Math.max(1, Number.parseInt(reconcile.extracted["nproc_per_node"] ?? confirmedBaseline["nproc_per_node"] ?? "1", 10) || 1);
      }
      // 批㊶-K 项 1：GPU 排队编排（真跑 danger 放行后入队——批㊶-W F6 四合一：整组 nproc 卡
      // 空闲判定＋compute-apps 归属＋快速二次确认；命中→琥珀再确认卡人工放行（真跑守门不变）；
      // 无超时；编排器零启动调用。env ATF_GPU_POLL_MS 可配，缺省 30s）
      const gpuPollMs = gpuQueuePollMsFromEnv(process.env);
      if (gpuPollMs !== null) {
        // 批㊶-W owner 反馈增补：排队即时反馈——首探即报「需 N 卡、空闲 M」，空闲数变化
        // 再报（挂 alerts 通报面，聊天可见可决策：等或显式降档），不默默轮询。
        let lastNotifiedIdle = -1;
        const windowState = await awaitGpuWindow({
          pollMs: gpuPollMs,
          requiredCards,
          signal: exec.signal as { aborted: boolean } | undefined,
          onQueueStatus: (status) => {
            if (status.idle === lastNotifiedIdle) return;
            lastNotifiedIdle = status.idle;
            const short = status.idle < status.required
              ? `空闲不足（${status.required} 卡才能开跑）——等待释放，或在聊天显式降档 nproc 后重走确认卡`
              : "整组空闲数已满足——复探后开跑";
            appendNotification(runDir, {
              level: status.idle < status.required ? "warn" : "info",
              kind: "gpu_queue",
              reason: `GPU 排队：需 ${status.required} 卡、现空闲 ${status.idle}（已等待 ${status.waitedText}）——${short}`,
              since: new Date().toISOString(),
            });
          },
        });
        if (windowState.kind === "aborted") return approvalDeniedResult("atf_run_training", "cancelled");
        // 批㊶-Q：全自动档免琥珀再确认（通报已覆盖放行事实；窗口命中即启动）
        if (!autoTierStart) {
          const amber = await requestApproval(ctx, exec, "atf_run_training",
            buildApprovalReason({
              action: "GPU 窗口命中，启动训练",
              target: `（GPU ${windowState.snapshot.gpuIndexes.join("、")}，已等待 ${windowState.snapshot.waitedText}；train.sh=${args.train_sh}）`,
              effect: "占用 GPU 与写训练产物",
              reversible: "不可自动回滚（产物可人工清理）",
            }) + `\n${formatCardTable(windowState.snapshot.table)}`);
          if (!amber.ok) return approvalDeniedResult("atf_run_training", amber.outcome);
        }
      }
      if (occupant !== null) {
        // 卡面 [确认清理并重试] 语义：SIGTERM→宽限→SIGKILL，复探仍占用即保留现场停手
        const killed = occupant.pid > 0 ? await terminateOccupant(occupant.pid) : false;
        const still = killed ? await probePortOccupant(port) : occupant;
        if (!killed || still !== null) {
          return asToolValue({ started: false, error: "port_occupied_cleanup_failed", port, note: "清理后端口仍被占用——保留现场停手，请手动处理" });
        }
      }
      // tmux 常驻＋tee 日志＋tail 进料
      const logPath = join(cfg.logDir, "train-stdout.log");
      mkdirForce(cfg.logDir);
      // 批㊶-E-H 项 7a（P28）：启动轮转——旧 train-stdout.log 归档为带启动时间戳副本，
      // 当前日志只含本次尝试（tee -a 在新文件上追加；历史保留可追溯）
      const rotated = rotateTrainLog(logPath);
      // 批㊶Q增补三 段1③：生成面审计注释（幂等——生效账本路径写入脚本尾注释，便于事后审计）
      // 批甲-BUILD T3（D4=A）：写失败 fail-open 语义保留，但出启动日志告警（含账本路径与失败原因）
      const ledgerAudit = appendLedgerAuditComment(args.train_sh, process.env);
      if (ledgerAudit.warning !== null) console.error(`[atf-ledger] ${ledgerAudit.warning}`);
      // 段1① 检查器侧同源：旧 tmux 服务端不传播新 env 变量——账本路径显式前缀注入
      // （未设 ATF_APPROVAL_LEDGER 时为空串＝沿 train.sh 内 ${...:-$HOME/...} 缺省式）
      const ledgerPrefix = ledgerEnvPrefixForShell(process.env);
      const { execSync } = await import("node:child_process");
      // 批㊶-P1 S1：会话名走作用域基名＋命名域单源（launch 域不受 fail-closed 限制——pre-kill
      // 与 new-session 同目标名，天然不跨域）；命令构造走 tmuxCommand（D2① 测试 socket 注入点同源）。
      // 批㊶-P1 S3：同 run_id 双启串行闸（防御纵深）——作用域会话在场＝同 run 已有训练，
      // 经请示卡问用户（确认词 yes 才清旧重启）；拒绝/取消/服务缺失一律不启动（不静默双启）。
      // 探测被命名域拒绝（前缀未设）＝存在性不可判——launch 域存量语义不变（闸不误伤）。
      const sessionBase = trainingSessionBase(args.run_id);
      const sessionName = resolveLaunchSessionName(sessionBase);
      if (probeSession(sessionBase).present) {
        const gate = await confirmDoubleLaunch(ctx, exec, args.run_id, sessionName, runDir);
        if (!gate.ok) {
          return asToolValue({
            started: false,
            error: "double_launch_not_confirmed",
            outcome: gate.outcome,
            run_id: args.run_id,
            tmux: sessionName,
            note: gate.note,
          });
        }
      }
      try { execSync(tmuxCommand(`kill-session -t ${sessionName} 2>/dev/null`)); } catch { /* 无旧会话 */ }
      // D50：spawn 面两件——started.at（completion.started 数据源）＋tmux 尾声真退出码捕获
      // （tee 管道下 $?＝tee 的；PIPESTATUS[0] 才是 train.sh 的）→ training/exit.code
      // （同步环 completion.json 的权威 exit_code 源；`\$` 经外层 sh 转义直达 tmux 内层 bash）。
      writeTrainingStartedAt(runDir);
      const exitCodeFile = join(runDir, "training", "exit.code").replaceAll("'", "'\\''");
      execSync(tmuxCommand(`new-session -d -s ${sessionName} "${ledgerPrefix}bash ${args.train_sh} 2>&1 | tee -a ${logPath}; ec=\\\$\\\{PIPESTATUS[0]\\\}; printf %s \\\$ec > '${exitCodeFile}'"`));
      // 批㊶Q增补三 段2：启动探活（窗口内 tail train-stdout——终止特征/进程退出 → started:false
      // ＋exit＋stderr 摘要；SHA/ADMISSION 进料确认＋进程存活 → started:true；窗口耗尽仍存活
      // → started:true 但 note 如实标注未见进料。终结 started:true 假成功——cr_r2 三连败实锚）。
      const probe = await probeTrainingStartup({
        logPath,
        // 批㊶-ISO E1：探测被命名域拒绝（前缀未设）＝tmux 判据不可用——不以 tmux 判死
        // （交由终止特征与窗口判；避免对自启会话误报「会话消失」），在场/缺席仍如实二态
        sessionAlive: () => {
          const p = probeSession(sessionBase);
          return p.present || p.refused !== null;
        },
      });
      if (probe.outcome === "dead") {
        // D50：启动失败也落训练完成事实（status=failed——不伪装完成；exit.code 尾声件
        // 优先（放行闸 78 等真实退出码），缺席回落探活面推断值；首写者胜/重训覆写同语义）
        writeTrainingCompletion(runDir, {
          status: "failed",
          exit_code: readTrainingExitCode(runDir) ?? probe.exitCode ?? null,
          checkpoint: latestCheckpointOf(runDir),
          started: readTrainingStartedAt(runDir),
          finished: new Date().toISOString(),
        });
        // 批次 R H1-3：内核错误码人话回流（提前接线——内核 v0.7.24b0 未发版，当前无真实
        // 来源；发版后日志尾命中即转人话）。gpu_capacity_insufficient 附每卡 free 表
        //（nvidia-smi 机器事实）；建议但不自动降档（降档是用户决策）。未命中＝既有 note。
        let startupNote = probe.exitCode === 78
          ? "启动探活：放行记录闸失败（exit 78——账本无本 config 的放行记录）——先经 --record-training-release 登记（或核 ATF_APPROVAL_LEDGER 双轴）后重推"
          : "启动探活发现终止特征——训练未启动成功；按 log_tail 摘要处理后重推";
        // D77：内核四码命中只转人话 note——完整码不进模型可见返回体（对账面＝观测账）。
        const kernelFaceHit = scanKernelErrorFace([probe.tail]);
        if (kernelFaceHit !== null) {
          const gpuRows = kernelFaceHit.code.startsWith("gpu_capacity_insufficient") ? await gpuFreeRowsForErrorFace() : undefined;
          startupNote = humanizeKernelError(kernelFaceHit.code, { gpuFreeRows: gpuRows }) ?? startupNote;
        }
        return asToolValue({
          started: false,
          error: "startup_failed",
          reason: probe.reason ?? "终止特征",
          exit_code: probe.exitCode ?? null,
          run_id: args.run_id,
          train_sh: args.train_sh,
          log_tail: probe.tail.slice(-800),
          note: startupNote,
        });
      }
      startLossIngest(logPath, join(runDir, "training", "loss-series.json"));
      // A3：启动放行后 progress 初帧（round=0）——无 loss-series 的启动早期，训练活跃
      // 判定（trainingActiveLive）有确定性信号源（progress fresh 窗口）；total_rounds 仅在
      // num_train_epochs 确定性可得时写（iteration-config 单源——缺源不造数）。既有的
      // status 写方仍是唯一进度推进源，初帧只占启动态（不引入第二状态源）。
      const startEpochs = readNumTrainEpochs(runDir);
      writeProgress(runDir, { round: 0, ...(startEpochs !== null ? { total_rounds: startEpochs } : {}), updated_at: new Date().toISOString() });
      // 批㊶-M M-3 段事实轨：训练启动确认后登记（training 段——探活 dead 不登记）
      appendSegmentFact(runDir, "training", "atf_run_training");
      // 批㊶-N N-5：会话绑定
      const sessionIdStart = sessionIdOf(exec);
      if (sessionIdStart !== undefined) appendBinding(runDir, sessionIdStart);
      // 批B1：会话账本绑定（source=created——新建实验即绑定，无需二次选择；fail-open）
      if (sessionIdStart !== undefined) {
        bindSessionRun(resolveBindingsHome(process.env), sessionIdStart, {
          runId: args.run_id,
          workspace: workspaceOfRunDir(cfg.runsRoot, runDir),
          source: "created",
        });
      }
      // 批㊶-TRAIN-OBS-FIX2 T1：内核侧会话绑定（run 产生成功路径——宿主链对齐
      // runner.ts:391-395 形态；fail-open 沿 appendBinding 语义——闭包内已兜底，
      // 消费点再兜一道，任何注入形态都不阻塞启动主流程）
      try { if (cfg.bindRun !== undefined) await cfg.bindRun(args.run_id); } catch { /* fail-open */ }
      // 批㊶-S1 门2修复：围栏可写根随 run 切换更新（与 confirmFace 同 helper 语义）
      process.env["ATF_BASH_RUN_WORKSPACE"] = runDir;
      const feedNote = probe.outcome === "feed_ok"
        ? "探活已确认进料（SHA=pass/ADMISSION=pass 且进程存活）"
        : `探活窗口（${String(resolveStartupProbeMs(process.env))}ms）内未见进料行但进程存活（llamafactory 启动中）——status 跟进确认`;
      return asToolValue({
        started: true,
        tmux: sessionName,
        run_id: args.run_id,
        log: logPath,
        reconcile: reconcileSkipped ? "skipped_no_baseline" : "ok",
        probe: { outcome: probe.outcome, feed_seen: probe.feedSeen },
        ...(autoTierStart ? { auto: true, tier: ATF_TRAINING_PRESET } : {}),
        ...(rotated !== null ? { previous_log: rotated } : {}),
        note: autoTierStart
          ? `训练已启动（全自动档·免审批放行已通报；${feedNote}）——status 查询进度与 ckpt；完成回报 ckpt 路径`
          : `训练已启动（${feedNote}）——status 查询进度与 ckpt；完成回报 ckpt 路径`,
      });
    },
  });

/** 批㊶R前置 防线③：start 面 iteration-config base_model.path 本地复核（确定性三态）。
 *  合法＝本地目录在位（config.json 缺席如实降级为 config_json_missing 拒绝——HF 本地模型
 *  目录必有 config.json，缺失即不可训）；失败附本机可用模型清单（扫描 ATF_MODEL_ROOT）。 */
export function checkStartModelPath(
  runDir: string,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; path: string } | { ok: false; path: string | null; reason: string; reasonText: string; models: string[]; root: string } {
  const candidates = iterationConfigCandidates(runDir);
  let configPath: string | null = null;
  let iter: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      iter = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      configPath = candidate;
      break;
    } catch {
      continue;
    }
  }
  const inventory = scanLocalModels(env);
  const fail = (path: string | null, reason: string, reasonText: string): { ok: false; path: string | null; reason: string; reasonText: string; models: string[]; root: string } =>
    ({ ok: false, path, reason, reasonText, models: inventory.models, root: inventory.root });
  if (iter === null || configPath === null) return fail(null, "iteration_config_missing", "缺席（config/iteration-config 与存量 prep/iteration-config 两候选路径均无）——先走确认卡落快照回写链");
  const baseModel = iter["base_model"];
  const path = baseModel !== null && typeof baseModel === "object" ? (baseModel as Record<string, unknown>)["path"] : undefined;
  if (typeof path !== "string" || path.trim() === "") return fail(null, "base_model_path_absent", "缺席（base_model.path 未声明）——不猜测缺省模型");
  if (!existsSync(path)) return fail(path, "not_local_dir", "不是本地存在的目录（疑似 HF 家族名/仓库 id 误填）");
  try {
    if (!lstatSync(path).isDirectory()) return fail(path, "not_local_dir", "不是本地目录（是文件）");
  } catch {
    return fail(path, "not_local_dir", "本地探测失败（权限/挂载）");
  }
  if (!existsSync(join(path, "config.json"))) return fail(path, "config_json_missing", "本地目录在位但缺 config.json——不可训（不静默放行）");
  return { ok: true, path };
}

function mkdirForce(dir: string): void {
  import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
}

/** 批㊶-E-H 项 7a（P28）训练日志启动轮转：train-stdout.log 已存在 → 原地更名为
 *  train-stdout.<启动时间戳>.log（历史保留可追溯，当前日志只含本次尝试）；
 *  不存在即 no-op。返回归档路径（null＝无可轮转）。同名归档已存在（同秒两次启动）
 *  追加毫秒序避免覆盖。 */
export function rotateTrainLog(logPath: string, now: Date = new Date()): string | null {
  if (!existsSync(logPath)) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let rotated = join(dirname(logPath), `train-stdout.${stamp}.log`);
  if (existsSync(rotated)) rotated = join(dirname(logPath), `train-stdout.${stamp}.${String(now.getMilliseconds()).padStart(3, "0")}.log`);
  renameSync(logPath, rotated);
  return rotated;
}

/** prelaunch 报告在场探测：目录内 prelaunch*（md/json）任一即返回路径；无则 null。 */
export function findPrelaunchReport(dir: string): string | null {
  try {
    const hits = readdirSync(dir).filter((f) => /^prelaunch.*\.(md|json)$/i.test(f)).sort();
    return hits.length > 0 ? join(dir, hits[0] as string) : null;
  } catch {
    return null;
  }
}

/** 固定编号 checkpoint 校验（SKILL.md 环节④：显式路径声明，拒 latest/符号链接/无编号目录）。 */
export function validateFixedCheckpoint(path: string): { ok: true } | { ok: false; reason: string } {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  if (base === "latest") return { ok: false, reason: "checkpoint_latest_forbidden" };
  if (!/^checkpoint-\d+$/.test(base)) return { ok: false, reason: "checkpoint_explicit_number_required" };
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: "checkpoint_symlink_forbidden" };
  } catch {
    return { ok: false, reason: "checkpoint_dir_missing" };
  }
  if (!existsSync(join(path, "adapter_model.safetensors"))) return { ok: false, reason: "checkpoint_adapter_missing" };
  return { ok: true };
}


/** 轮号解析注入面（F2）：生产缺省走内核 CLI（单源）；测试注入 stub 以免依赖真实内核进程。
 *  注入**不是**第二套实现——语义仍是"由调用方给轮目录"，不在此处推导轮号。 */
export type EvalRoundResolver = (
  runDir: string,
  checkpoints: readonly string[],
) => Promise<{ ok: true; roundDir: string } | { ok: false; payload: Record<string, unknown> }>;

/** 评估轮目录解析（ADR-0007 决定 2）——**内核单源**：调
 *  `python3 -m agentic_training_flow resolve-eval-round --run <runDir> [--checkpoints id1,id2]`，
 *  stdout 最后一行＝轮目录绝对路径。
 *  历史实现是 TS 里另抄一份「纯 maxN+1」：每次评估 start 都派新轮号，绕过内核
 *  next_eval_round_dir 的 E5 复评复用判定，UAT 现场一个 run 因此长出 1-/2-/3-/4- 四个空轮。
 *  同一次评估动作（service／ckpt-plan／orch 三子步）必须共用一个轮号——轮号只由内核定，
 *  harness 不再自建第二套。
 *  失败即 fail-closed（resolve_eval_round_unavailable）——**不在 harness 侧推导轮号**：
 *  任何本地推导（maxN+1 或"复用最新轮"）都是第二套实现，正是 F2 要消灭的东西。 */
export const resolveEvalRoundDir = async (
  runDir: string,
  cfg: { kernelDir: string },
  checkpoints: readonly string[] = [],
): Promise<
  | { ok: true; roundDir: string }
  | { ok: false; payload: Record<string, unknown> }
> => {
  const ids = checkpoints.map((id) => id.trim()).filter((id) => id !== "");
  const resolved = await runCapture("python3", [
    "-m", "agentic_training_flow", "resolve-eval-round", "--run", runDir,
    ...(ids.length > 0 ? ["--checkpoints", ids.join(",")] : []),
  ], 60_000, kernelPythonEnvOf(cfg.kernelDir));
  const lines = resolved.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const roundDir = lines.length > 0 ? (lines[lines.length - 1] as string) : "";
  if (resolved.code !== 0 || roundDir === "") {
    // F2（ADR-0005 条款 5＋E5 复用）：轮号只由内核定。CLI 不可用＝配置错误，fail-closed
    // 显式失败——不退回任何 harness 侧实现（maxN+1 会每次评估堆一个空轮，正是 UAT
    // 四个空轮的根因；即便改成"复用最新轮"也是第二套实现，仍是 F2 要消灭的东西）。
    return {
      ok: false,
      payload: {
        started: false,
        error: "resolve_eval_round_unavailable",
        note:
          "内核 resolve-eval-round 不可用——轮号必须由内核单源解析（ADR-0005 条款 5／E5 复用判定），"
          + "harness 不再自建第二套。下一步：确认内核 pin 是否含该命令（python3 -m "
          + "agentic_training_flow resolve-eval-round --help）后重推。",
        stderr_tail: resolved.stderr.slice(-800),
      },
    };
  }
  return { ok: true, roundDir };
};

interface EvalStatusValue {
  action: string;
  run_id: string;
  /** D15：完成轮（orch/eval/metrics_summary.json 在场）；无完成轮＝null（note 指因）。 */
  eval_round?: string | null;
  /** D15：名称最新轮（含部分/进行中——照实展示）；与 eval_round 同值时也返回。 */
  latest_round?: string | null;
  /** D15：latest_round ≠ eval_round（最新轮未完成）→ true。 */
  latest_round_incomplete?: boolean;
  service?: Record<string, unknown>;
  orchestration?: Record<string, unknown>;
  files?: string[];
  metrics_summary?: unknown;
  model_label_warning?: string;
  model_matches_manifest?: boolean;
  running?: boolean;
  /** 批㊶-ISO E1：编排会话名（命名域解析值）与探测拒绝回流。 */
  tmux?: string;
  tmux_probe?: { ok: false; reason: string; guidance: string } | null;
}

/** atf_evaluate status：最新**完成**评估轮的服务 receipt/编排状态/四件套与 model 标签复核。
 *  D15 选轮双值：latest_round＝名称最新（含部分/进行中轮——照实展示「有一轮在走」）；
 *  eval_round＝最新一个 `orch/eval/metrics_summary.json` 在场的轮（service/orchestration/
 *  files/summary 全取完成轮——部分轮天然不算 completed，不做 dry-run 标记）。
 *  两值不同 → 返回体附 latest_round_incomplete:true。不删除任何轮目录。 */
export async function evalStatus(runId: string, cfg: { runsRoot: string; kernelDir: string; canonicalRoots?: readonly string[] }): Promise<ReturnType<typeof asToolValue>> {
  // E5·H2（D142/D143）：status 返回体带实际解析根（实例根单源——env -i/HOME 漂移下
  // 仍解析稳定；start 链子步 env 即按此根显式传递，此处同源对账）
  const instanceRoot = resolveEvalInstanceRoot();
  const instanceRootKeys = { instance_root: instanceRoot.root, instance_root_source: instanceRoot.source };
  const evalRoot = join(resolveRunDir(cfg.runsRoot, runId, { canonicalRoots: canonicalRunRootsOf(cfg) }), "eval");
  let roundNames: string[] = [];
  try {
    roundNames = readdirSync(evalRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-\d{8}$/.test(e.name)).map((e) => e.name).sort();
  } catch { /* 无评估轮 */ }
  const latestName = roundNames.length > 0 ? roundNames[roundNames.length - 1] ?? null : null;
  let completedName: string | null = null;
  for (let i = roundNames.length - 1; i >= 0; i -= 1) {
    if (existsSync(join(evalRoot, roundNames[i] as string, "orch", "eval", "metrics_summary.json"))) {
      completedName = roundNames[i] as string;
      break;
    }
  }
  const latest = completedName !== null ? join(evalRoot, completedName) : null;
  const { execSync } = await import("node:child_process");
  // 批㊶-ISO E1：探测走命名域单源（前缀未设＝false fail-closed；refused 随 payload 回流）
  // 批㊶-P1 S1：编排基名作用域化——按 run_id 取名（同实例并发 run 评估编排互不踩）
  const orchBase = evalOrchSessionBase(runId);
  const orchProbe = probeSession(orchBase);
  let running = orchProbe.present;
  if (latestName === null) {
    return asToolValue({
      action: "status", run_id: runId, running,
      tmux: resolveLaunchSessionName(orchBase),
      ...(orchProbe.refused !== null ? { tmux_probe: orchProbe.refused } : {}),
      ...instanceRootKeys,
      note: "无评估轮目录——先 start",
    });
  }
  if (latest === null) {
    // 有轮目录但无完成轮：eval_round=null＋note；latest_round 照实返回。
    // D15 补全：next_steps 事实面保留（readiness 扫全轮——四件套缺＝false、指引行不预告），
    // 旧消费面（E9 收口提示锚）零翻新。
    const runDirNone = resolveRunDir(cfg.runsRoot, runId, { canonicalRoots: canonicalRunRootsOf(cfg) });
    const readinessNone = collectEvalReadiness(runDirNone);
    return asToolValue({
      action: "status", run_id: runId, eval_round: null,
      latest_round: latestName, latest_round_incomplete: true, running,
      tmux: resolveLaunchSessionName(orchBase),
      ...(orchProbe.refused !== null ? { tmux_probe: orchProbe.refused } : {}),
      ...instanceRootKeys,
      note: "尚无完成的评估轮",
      next_steps: {
        four_set_ready: readinessNone.four_set_ready,
        badcases_ready: readinessNone.badcases_ready,
        latest_checkpoint: readinessNone.latest_checkpoint,
        publish_prereq_met: checkModelPublishPrereq(runDirNone).ok,
        note: readinessNone.four_set_ready
          ? "四件套齐——坏例分析（atf_analyze_badcases）与模型发布（atf_publish_model）前置事实在位"
          : "四件套未齐——分析/发布前置事实未满足",
      },
    });
  }
  const serviceReceiptPath = join(latest, "service", "service", "service_receipt.json");
  const service = existsSync(serviceReceiptPath) ? JSON.parse(readFileSync(serviceReceiptPath, "utf8")) as Record<string, unknown> : null;
  const orchEval = join(latest, "orch", "eval");
  const statePath = join(orchEval, "state.json");
  const blockPath = join(orchEval, "orch-block.json");
  const ingestPath = join(orchEval, "ingest.json");
  const orchestration: Record<string, unknown> = {
    ...(existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown> : {}),
    ...(existsSync(blockPath) ? { block: JSON.parse(readFileSync(blockPath, "utf8")) } : {}),
    ...(existsSync(ingestPath) ? { ingest: JSON.parse(readFileSync(ingestPath, "utf8")) } : {}),
  };
  const files = ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"].filter((f) => existsSync(join(orchEval, f)));
  const summaryPath = join(orchEval, "metrics_summary.json");
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
  const labelWarning = summary !== null && modelLabelLooksDefault((summary as Record<string, unknown>)["model"])
    ? "metrics_summary.model 为 OpenAI 风格缺省名（标签泄漏）——正道链 --model 取自 service manifest 期望名，不应出现该形态"
    : undefined;
  // model 与 manifest 对拍：serving 名域隔离（<run_id>_<逻辑名>）
  const manifestPath = join(latest, "service", "service_manifest.json");
  let modelMatchesManifest: boolean | undefined;
  if (summary !== null && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const expected = (manifest["expected_model_names"] as string[] | undefined) ?? [];
    modelMatchesManifest = expected.includes(String((summary as Record<string, unknown>)["model"]));
  }
  // 批㊶-S1 段 1：四件套齐→可分析/可发布信号（确定性事实核对）
  const runDirEval = resolveRunDir(cfg.runsRoot, runId, { canonicalRoots: canonicalRunRootsOf(cfg) });
  const readiness = collectEvalReadiness(runDirEval);
  const value: EvalStatusValue = {
    action: "status", run_id: runId, eval_round: latest, running,
    ...(completedName !== latestName ? { latest_round: latestName, latest_round_incomplete: true } : { latest_round: completedName }),
    tmux: resolveLaunchSessionName(orchBase),
    ...(orchProbe.refused !== null ? { tmux_probe: orchProbe.refused } : {}),
    ...instanceRootKeys,
    ...(service !== null ? { service } : {}),
    orchestration,
    files,
    ...(summary !== null ? { metrics_summary: summary } : {}),
    ...(labelWarning !== undefined ? { model_label_warning: labelWarning } : {}),
    ...(modelMatchesManifest !== undefined ? { model_matches_manifest: modelMatchesManifest } : {}),
  };
  return asToolValue({
    ...value,
    next_steps: {
      four_set_ready: readiness.four_set_ready,
      badcases_ready: readiness.badcases_ready,
      latest_checkpoint: readiness.latest_checkpoint,
      publish_prereq_met: checkModelPublishPrereq(runDirEval).ok,
      note: readiness.four_set_ready
        ? "四件套齐——坏例分析（atf_analyze_badcases）与模型发布（atf_publish_model）前置事实在位"
        : "四件套未齐——分析/发布前置事实未满足",
      // A-C3b E9 收口提示：仅四件套在位时出现（不预告未发生的事）——会话 agent 下一步可跑
      // badcase 分析（工具返回面指引，非用户可见卡片文案）
      ...(readiness.four_set_ready
        ? { analyze_guidance: "评估已完成——可调 atf_analyze_badcases 生成 badcase viewer（产物可经任务卡 viewer 面板打开）" }
        : {}),
    },
  });
}


/** 批㊶-S1 段 3：模型产物发布（语义 C＝归档＋登记＋并入模型清单；U 双段式确认卡）。 */

/** E4——发布拷贝逐文件结果（manifest 与返回面共形）。 */
export interface PublishCopyFile {
  file: string;
  sha256: string;
  bytes: number;
  status: "copied" | "reused";
}

/** E4——发布拷贝断点续传结果（成功＝文件集＋计数；失败＝中断/校验码＋已拷进度）。 */
export type PublishCopyOutcome =
  | {
      ok: true;
      files: PublishCopyFile[];
      total: number;
      copied: number;
      reused: number;
      bytes_copied: number;
      bytes_total: number;
      /** 目标在场但 sha 不等（源变更/目标损坏）而重拷的计数——如实通报不静默。 */
      changed_re_copied: number;
    }
  | {
      ok: false;
      error: "publish_copy_interrupted" | "publish_copy_verify_failed";
      file?: string;
      copied: number;
      reused: number;
      total: number;
      reason?: string;
    };

/** E4——发布拷贝断点续传（纯函数可注入）：先全量枚举源文件，再逐文件
 *  sha256 比对——目标存在且 sha 相等→reused（跳过拷贝）；缺失/不等→copyFileSync
 *  ＋复算目标 sha 校验（不等＝publish_copy_verify_failed，半截清单不得为权威）。
 *  中断（IO 异常）＝publish_copy_interrupted：已拷文件保留（下次续传按 sha 复用），
 *  manifest 由调用方在 ok 后才写。零外部依赖（无 rsync）。 */
export const publishCopyWithResume = (
  ckptDir: string,
  destDir: string,
  deps: {
    shaOf?: (file: string) => string;
    copyFile?: (src: string, dest: string) => void;
  } = {},
): PublishCopyOutcome => {
  const shaOf = deps.shaOf ?? ((file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex"));
  const copyFile = deps.copyFile ?? ((src: string, dest: string): void => {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSyncBuiltin(src, dest);
  });
  const tryShaOf = (file: string): string | null => {
    try {
      return shaOf(file);
    } catch {
      return null;
    }
  };
  const sources: Array<{ file: string; src: string; bytes: number }> = [];
  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, entry.name);
      const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
      if (entry.isDirectory()) walk(src, rel);
      else sources.push({ file: rel, src, bytes: statSync(src).size });
    }
  };
  try {
    walk(ckptDir, "");
  } catch (cause) {
    return { ok: false, error: "publish_copy_interrupted", copied: 0, reused: 0, total: 0, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const files: PublishCopyFile[] = [];
  let copied = 0;
  let reused = 0;
  let bytesCopied = 0;
  let bytesTotal = 0;
  let changedReCopied = 0;
  for (const item of sources) {
    const dest = join(destDir, item.file);
    bytesTotal += item.bytes;
    let srcSha: string;
    try {
      srcSha = shaOf(item.src);
    } catch (cause) {
      return { ok: false, error: "publish_copy_interrupted", file: item.file, copied, reused, total: sources.length, reason: cause instanceof Error ? cause.message : String(cause) };
    }
    const destSha = tryShaOf(dest);
    if (destSha === srcSha) {
      reused += 1;
      files.push({ file: item.file, sha256: srcSha, bytes: item.bytes, status: "reused" });
      continue;
    }
    if (destSha !== null) changedReCopied += 1;
    try {
      copyFile(item.src, dest);
    } catch (cause) {
      return { ok: false, error: "publish_copy_interrupted", file: item.file, copied, reused, total: sources.length, reason: cause instanceof Error ? cause.message : String(cause) };
    }
    if (tryShaOf(dest) !== srcSha) {
      return { ok: false, error: "publish_copy_verify_failed", file: item.file, copied, reused, total: sources.length, reason: "拷贝后校验失败（目标 sha 与源不符）" };
    }
    copied += 1;
    bytesCopied += item.bytes;
    files.push({ file: item.file, sha256: srcSha, bytes: item.bytes, status: "copied" });
  }
  return { ok: true, files, total: sources.length, copied, reused, bytes_copied: bytesCopied, bytes_total: bytesTotal, changed_re_copied: changedReCopied };
};

/** copyFileSync 内置实现（publishCopyWithResume 缺省注入面单源——顶部 fs import 别名）。 */

export function buildPublishModelTool(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; modelRoot?: string; /** D49：canonical 解析种子（与 TrainingToolsConfig 同键——canonicalRunRootsOf(cfg) 注入面；缺省注册表实例态）。 */ canonicalRoots?: readonly string[] }): unknown {
  return defineTool({
    name: "atf_publish_model",
    description:
      "模型产物发布（语义 C：归档＋登记＋并入模型清单）：对评估完成的 checkpoint 收口——四件套齐即可发布（指标门槛不硬编码，发布与否由用户在确认卡定）；发布动作＝确定性归档复制（SHA256 清单）到 <发布库位>/<run_id>/<ckpt>/＋manifest＋发布报告。确认卡＝U 双段式（dualStageNote），danger 级 Allow once 落审批账本。已发布模型并入模型清单状态面（训练确认卡基模型可选历史发布作 base——迁移学习；ATF_MODEL_ROOT＋发布库位两源合并、来源标注区分）。发布前置缺四件套即拒（不猜测）。",
    parameters: {
      run_id: { type: "string", description: "可选；省略时使用本会话当前绑定的实验。无绑定会返回 run_binding_required 与候选（含实验名与工作区），不要自行猜一个 id" },
      checkpoint: { type: "string", required: true, description: "checkpoint 目录名（checkpoint-<数字>；拒 latest/符号链接）" },
      publish_root: { type: "string", description: "发布库位根（缺省＝统一根 models 子目录——ATF_ATF_ROOT/ATF_DSH_RUNS_ROOT 父目录派生；实例分桶自动）" },
      note: { type: "string", description: "发布说明（入发布报告）" },
    },
    output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }] },
    presentCall: function(args: { run_id?: string; checkpoint?: string }) {
      return { card: "generic" as const, title: `模型发布 — ${args.run_id ?? "会话绑定实验"}${args.checkpoint !== undefined ? `/${args.checkpoint}` : ""}`, kind: "other" as const };
    },
    async execute(args: { run_id?: string; checkpoint: string; publish_root?: string; note?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批B1：run_id 缺省解析（显式＞会话绑定；无绑定＝run_binding_required＋候选）
      const runResolution = resolveToolRun(cfg.runsRoot, exec, args.run_id, canonicalRunRootsOf(cfg));
      if (!runResolution.ok) return asToolValue(runResolution.payload);
      const runId = runResolution.runId;
      const runDir = runResolution.runDir;
      if (!/^checkpoint-\d+$/.test(args.checkpoint)) {
        return asToolValue({ ok: false, error: "checkpoint_name_invalid", note: "checkpoint 须为 checkpoint-<数字> 形态（拒 latest/符号链接/缺省猜测）" });
      }
      const ckptDir = join(runDir, "training", args.checkpoint);
      try {
        if (lstatSync(ckptDir).isSymbolicLink()) return asToolValue({ ok: false, error: "checkpoint_symlink_forbidden", note: "符号链接 checkpoint 拒绝（SKILL.md 环节④沿用）" });
      } catch {
        return asToolValue({ ok: false, error: "checkpoint_missing", note: `checkpoint 目录不存在：${ckptDir}` });
      }
      const prereq = checkModelPublishPrereq(runDir);
      if (!prereq.ok) {
        return asToolValue({ ok: false, error: prereq.reason, note: "发布前置＝四件套齐即可（当前缺四件套——不猜测不放宽）" });
      }
      // 发布库位缺省派生（零绝对路径字面量——统一根 models 子目录；§三.1 语义 C）
      const publishRoot = args.publish_root?.trim() || derivePublishRoot(process.env);
      if (publishRoot === null) {
        return asToolValue({ ok: false, error: "publish_root_unset", note: "发布库位未派生：ATF_ATF_ROOT/ATF_DSH_RUNS_ROOT 皆未提供统一根——publish_root 显式传入或配置后重试" });
      }
      const destDir = join(publishRoot, runId, args.checkpoint);
      // U 双段式确认卡（danger 级 Allow once 落审批账本）；E5 模板四行＋发布明细续行
      const verdict = await requestApproval(ctx, exec, "atf_publish_model",
        buildApprovalReason({
          action: "归档复制发布模型",
          target: `（run ${runId}／checkpoint ${args.checkpoint}）`,
          effect: "写发布库（归档复制＋SHA256 清单＋manifest＋发布报告）",
          reversible: "可逆（发布库条目可人工删除）",
        }) + `\n发布明细：归档复制 ${ckptDir} → ${destDir}（SHA256 清单）＋manifest＋发布报告${args.note !== undefined ? `｜说明：${args.note}` : ""}\n如需改参（publish_root/checkpoint），直接回复。`);
      if (!verdict.ok) return approvalDeniedResult("atf_publish_model", verdict.outcome);
      // 确定性归档复制（SHA256 清单）——零内核触碰（node fs 实现）；E4 断点续传：
      // 逐文件 sha 比对（等→reused；缺/变→copied＋复算校验）；中断/校验失败保留已拷
      // 且 manifest 不写（半截清单不得被当权威）——重跑按 sha 自动续传。
      mkdirSync(destDir, { recursive: true });
      const copyOutcome = publishCopyWithResume(ckptDir, destDir);
      if (!copyOutcome.ok) {
        return asToolValue({
          ok: false,
          error: copyOutcome.error,
          ...(copyOutcome.file !== undefined ? { file: copyOutcome.file } : {}),
          copied: copyOutcome.copied,
          reused: copyOutcome.reused,
          total: copyOutcome.total,
          ...(copyOutcome.reason !== undefined ? { reason: copyOutcome.reason } : {}),
          dest_dir: destDir,
          note:
            copyOutcome.error === "publish_copy_verify_failed"
              ? "发布拷贝后校验失败——已拷文件保留，修复后重跑续传（sha 相等文件自动复用）"
              : "发布拷贝中断——已拷文件保留，重跑按 sha 比对续传（相等即复用，无需全量重拷）",
        });
      }
      const files = copyOutcome.files;
      const manifest = {
        schema_version: "ModelPublish/v1",
        run_id: runId,
        checkpoint: args.checkpoint,
        published_at: new Date().toISOString(),
        source_dir: ckptDir,
        dest_dir: destDir,
        // E4：续传标记（reused>0＝本次有文件按 sha 复用未重拷）；每文件 status 如实分流
        resumed: copyOutcome.reused > 0,
        files: files.sort((a, b) => a.file.localeCompare(b.file)),
        ...(args.note !== undefined ? { note: args.note } : {}),
      };
      writeFileSync(join(destDir, "publish-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
      const report = [
        `# 模型发布报告 — ${runId}/${args.checkpoint}`,
        "",
        `- 发布时间：${manifest.published_at}`,
        `- 源：${ckptDir}`,
        `- 归档：${destDir}`,
        `- 文件数：${files.length}（新拷 ${copyOutcome.copied} · 复用 ${copyOutcome.reused}——SHA256 清单见 publish-manifest.json）`,
        ...(args.note !== undefined ? [`- 说明：${args.note}`] : []),
      ].join("\n");
      mkdirSync(join(runDir, "publish"), { recursive: true });
      writeFileSync(join(runDir, "publish", `${args.checkpoint}.md`), `${report}\n`, "utf8");
      // 批B1：会话账本绑定（auto_tool——成功动作才绑定，显式传入与绑定不同带 rebound_from）
      const rebound = bindToolRunSuccess(exec, runId, runResolution.workspace, "auto_tool", args.run_id);
      return asToolValue({
        ok: true,
        run_id: runId,
        checkpoint: args.checkpoint,
        dest_dir: destDir,
        file_count: files.length,
        // E4：续传计数（卡片明细可读——total/copy/reused/字节双轴）
        copy_stats: {
          total: copyOutcome.total,
          copied: copyOutcome.copied,
          reused: copyOutcome.reused,
          bytes_copied: copyOutcome.bytes_copied,
          bytes_total: copyOutcome.bytes_total,
        },
        ...(copyOutcome.changed_re_copied > 0 ? { changed_re_copied: copyOutcome.changed_re_copied } : {}),
        manifest: "publish-manifest.json",
        report: `publish/${args.checkpoint}.md`,
        ...rebound,
        note: "已发布——并入模型清单状态面（发布库位源；ATF_MODEL_ROOT＋发布库位两源合并、来源标注区分）",
      });
    },
  });
}
/** 批㊶-EVALCARD（2026-10-16，微批 31cf79ff）：评估授权卡摘要化——human_summary 六字段
 *  冻结结构（内核 session/tools.py _human_summary 会签表）的 harness 侧确定性投影：
 *  headline（H1＋接入形态/环境行）＋metrics（生效服务参数表关键行，不二次截断拼串）；
 *  全文不上卡→「完整报告：<路径>」行（无新落盘动作）。纯函数，单测直测。 */
export interface EvalReportSummary {
  headline: string;
  metrics: string[];
}

export const summarizeEvalPrelaunchReport = (reportText: string, runId?: string): EvalReportSummary => {
  const lines = reportText.split("\n");
  // D14：卡面 headline 固定「评估放行 — <run_id>」（报告自身 H1 不再上卡）；runId 缺席＝纯函数旧形态
  const headline = runId !== undefined
    ? `评估放行 — ${runId}`
    : (lines.find((l) => l.startsWith("# ")) ?? "推理服务接入确认报告").replace(/^#\s+/, "");
  // metrics：生效服务参数表的键值行（| 参数 | 值 | 来源 | 表——取关键键，值原样不截断）。
  // D14 修复：精确键匹配（键前缀匹配曾把「绑卡差异」一并算成「绑卡」→卡面两行重复）；
  // 键闭集＝pin 生成面 build_service_prelaunch_report 实际产出的整键（端口/TP/gpu_mem_util 等含全段）
  const metricKeys = ["环境来源", "eval_env", "绑卡", "端口/TP/gpu_mem_util", "max_model_len/max_num_seqs/batched_tokens", "adapters", "request_defaults", "并发"];
  const metrics: string[] = [];
  let inParams = false;
  let inRecon = false;
  for (const line of lines) {
    if (line.startsWith("## ")) { inParams = line.includes("生效服务参数"); inRecon = line.includes("参数对账"); continue; }
    if ((!inParams && !inRecon) || !line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2) continue;
    const key = cells[0] ?? "";
    if (key === "") continue;
    const hit = metricKeys.find((k) => key === k);
    if (hit === undefined) continue;
    // 批D17：并发行卡面紧凑投影（行在「参数对账」节——实锚 1-20261019 报告 :32；值列/容量列
    // 分属两格，kernel 全文落盘可达，卡面只上数字面）。对账节其余行维持不上卡（键闭集同源）。
    if (hit === "并发") { metrics.push(projectConcurrencyMetricLine(cells[1] ?? "", cells[2] ?? "")); continue; }
    if (inRecon) continue;
    metrics.push(`${key}＝${cells[1] ?? ""}`);
  }
  return { headline, metrics };
};

// ── 批D17：评估并发参数（参数门＋卡面并发行投影）──

/** D17——并发参数门解析结果（成功＝生效并发值；失败＝容量门快败面）。 */
export type EvalConcurrencyResolution =
  | { ok: true; concurrency: number }
  | {
      ok: false;
      error: "concurrency_invalid" | "concurrency_exceeds_capacity";
      concurrency: number;
      max_num_seqs?: number;
      suggested_concurrency?: number;
      note: string;
    };

/** D17——并发参数门（纯函数）：缺省 1 恒过；显式值须 ≥1 整数；容量单源＝service_config
 *  的 max_num_seqs（可读且为正整数时核对，超容量 fail-closed 附容量与建议值）。容量不可读
 *  不猜——交 prelaunch 既有机械核对（harness 只做参数门，不设第二套校验）。 */
export const resolveEvalConcurrency = (serviceConfigText: string, explicit?: number): EvalConcurrencyResolution => {
  const requested = explicit ?? 1;
  if (!Number.isInteger(requested) || requested < 1) {
    return { ok: false, error: "concurrency_invalid", concurrency: requested, note: "并发须为 ≥1 的整数（缺省 1＝串行；上限＝服务 max_num_seqs）" };
  }
  let maxNumSeqs: number | null = null;
  try {
    const raw = (JSON.parse(serviceConfigText) as Record<string, unknown>)["max_num_seqs"];
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) maxNumSeqs = raw;
  } catch { /* 配置不可读＝容量未知——存在性已前置校验，容量核对交 prelaunch，此处不猜 */ }
  if (maxNumSeqs !== null && requested > maxNumSeqs) {
    return {
      ok: false, error: "concurrency_exceeds_capacity", concurrency: requested, max_num_seqs: maxNumSeqs, suggested_concurrency: maxNumSeqs,
      note: `并发 ${requested} 超服务容量 max_num_seqs=${maxNumSeqs}——按容量收紧后重推（图像类任务建议从中等并发起步，不要默认拉满）`,
    };
  }
  return { ok: true, concurrency: requested };
};

/** D17——卡面「并发」行紧凑投影：值列（kernel 形态「runner 实际=N(缺省 1 保守底);agent 推荐
 *  =M(…);推荐理由:…」）＋来源列（「服务 max_num_seqs=C」）→「并发＝N/M（容量 C）」；
 *  缺推荐（串行缺省）降「N（容量 C）」、缺容量降「N/M」；实际值不可解析＝值原样上卡
 *  （kernel 文案变动时兜底，不丢事实）。纯函数，单测直测。 */
export const projectConcurrencyMetricLine = (value: string, source: string): string => {
  const actual = /runner 实际=(\d+)/.exec(value)?.[1] ?? null;
  if (actual === null) return `并发＝${value}`;
  const recommended = /agent 推荐=(\d+)/.exec(value)?.[1] ?? null;
  const capacity = /max_num_seqs=(\d+)/.exec(source)?.[1] ?? null;
  const head = recommended === null ? actual : `${actual}/${recommended}`;
  return capacity === null ? `并发＝${head}` : `并发＝${head}（容量 ${capacity}）`;
};

// ── 批D14：评测参数继承（field_config 缺省自动继承训练＋prompt_mode 继承＋评测口径投影）──

/** iteration-config 双形态候选（与 checkStartModelPath 同面——目录与平铺两形态；
 *  RunLayout/v3：每形态各自 config/iteration-config 优先、v2 prep/iteration-config 只读兜底）。 */
export const iterationConfigCandidates = (runDir: string): string[] => [
  ...runFileCandidates(runDir, "prep/iteration-config/iteration-config.json"),
  ...runFileCandidates(runDir, "prep/iteration-config.json"),
];

/** run 记录的字段配置指纹（dataset.digest_provenance.field_config_sha256；可读候选首个权威；
 *  无声明/损坏/缺席一律 null——不可核对即 unverified 语义，不猜）。 */
export const recordedFieldConfigSha = (runDir: string): string | null => {
  for (const candidate of iterationConfigCandidates(runDir)) {
    try {
      if (!existsSync(candidate)) continue;
      const iter = JSON.parse(readFileSync(candidate, "utf8")) as { dataset?: { digest_provenance?: { field_config_sha256?: unknown } } };
      const sha = iter.dataset?.digest_provenance?.field_config_sha256;
      return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
    } catch {
      return null; // 损坏＝无指纹（fail-closed：不可核对）
    }
  }
  return null;
};

/** F1.1——run 记录的模板骨架指纹（dataset.digest_provenance.template_sha256＝内核写的
 *  sha256(field_config["template"])；候选链与 field_config_sha256 同源）。缺席/损坏＝null
 *  （老 run 零回归：不比对、不报错、回执标 absent）。 */
export const recordedTemplateSha = (runDir: string): string | null => {
  for (const candidate of iterationConfigCandidates(runDir)) {
    try {
      if (!existsSync(candidate)) continue;
      const iter = JSON.parse(readFileSync(candidate, "utf8")) as { dataset?: { digest_provenance?: { template_sha256?: unknown } } };
      const sha = iter.dataset?.digest_provenance?.template_sha256;
      return typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null;
    } catch {
      return null; // 损坏＝无记录（不可核对即不比对，不造假指纹）
    }
  }
  return null;
};

/** F1.1——内核口径的稳定 JSON 文本（json.dumps(ensure_ascii=False, sort_keys=True,
 *  separators=(",", ":")) ＋尾部换行）。template_sha256 只能按这个口径实算才对得上记录值。 */
export const canonicalJsonTextOf = (value: unknown, trailingNewline = true): string => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = sort(record[key]);
      return out;
    }
    return input;
  };
  const text = JSON.stringify(sort(value));
  return trailingNewline ? `${text}\n` : text;
};

/** F1.1——field_config 里 template 的实测指纹（两种序列化尾差口径都算：带/不带尾部换行——
 *  尾差不算模板漂移）。文件不可读或无 template 键＝null（无法实算＝按漂移 fail-closed）。 */
const fieldConfigTemplateDigestsOf = (path: string): { primary: string; variant: string } | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(parsed, "template")) return null;
    const template = parsed["template"];
    return {
      primary: createHash("sha256").update(Buffer.from(canonicalJsonTextOf(template, true), "utf8")).digest("hex"),
      variant: createHash("sha256").update(Buffer.from(canonicalJsonTextOf(template, false), "utf8")).digest("hex"),
    };
  } catch {
    return null;
  }
};

/** D14——field_config 解析结果（成功＝路径＋来源＋指纹；失败＝码＋下一步指引）。 */
export type EvalFieldConfigResolution =
  | {
      ok: true;
      path: string;
      source: "explicit" | "run_recorded";
      sha256: string;
      /** 显式传入且与训练指纹不一致——只告警不阻断（用户显式覆盖，产品裁定）。 */
      warning?: "field_config_explicit_drift";
      recorded_sha256?: string;
      /** F1.1：模板骨架核对结果——verified＝与记录一致；absent＝老 run 无记录键（不比对）；
       *  drift_accepted＝显式放行模板差异（回执带 template_drift_accepted:true）。 */
      template_sha256_source: "verified" | "absent" | "drift_accepted";
      template_drift_accepted?: true;
    }
  | {
      ok: false;
      error: "eval_field_config_unresolved" | "eval_field_config_drift" | "eval_field_config_unverified" | "eval_field_config_multi_doc" | "eval_template_drift";
      path: string;
      note: string;
    };

/** D14/E9a·H4——field_config 解析（纯函数）：显式传入→直接用（漂移仅告警）；缺省→
 *  槽位 run（docSlots 表非空）取该类 experiment-setup/<doc>/field-config.json（指定
 *  docType 判该类；N=1 判唯一类＝恒等路径换槽位；N>1 未指定→multi_doc 结构化拒——
 *  一次评多类 E9b 前不支持）；legacy run（表空）保持平铺 experiment-setup/
 *  field-config.json 恒等。一律与 iteration-config 的训练指纹比对。失败 fail-closed：
 *  文件缺失→unresolved；指纹不一致→drift；run 无指纹→unverified（缺省路径时）。 */
export const resolveEvalFieldConfig = (runDir: string, explicit?: string, docType?: string, opts?: { /** F1.1：显式接受模板骨架漂移（仅显式 field_config 时生效）。 */ acceptTemplateDrift?: boolean }): EvalFieldConfigResolution => {
  const isExplicit = explicit !== undefined && explicit.trim() !== "";
  const acceptTemplateDrift = opts?.acceptTemplateDrift === true;
  let path: string;
  if (isExplicit) {
    path = explicit as string;
  } else {
    const slots = listDocSlots(runDir);
    if (slots.length > 0) {
      const wanted = docType !== undefined && docType.trim() !== "" ? docType.trim() : null;
      const slot = wanted !== null
        ? slots.find((entry) => entry.doc_type === wanted) ?? null
        : slots.length === 1 ? slots[0]! : null;
      if (slot === null) {
        return {
          ok: false, error: "eval_field_config_multi_doc", path: resolveRunFile(runDir, "experiment-setup"),
          note: slots.find((entry) => entry.doc_type === wanted) === undefined && wanted !== null
            ? `本 run 无「${wanted}」类的单据槽位——核对单据类型后重推`
            : `本 run 有 ${String(slots.length)} 类单据（${slots.map((entry) => entry.doc_type).join("、")}）——一次评多类尚不支持，评估请面向单类 run 或等下一批`,
        };
      }
      path = slot.field_config;
    } else {
      path = resolveRunFile(runDir, "experiment-setup/field-config.json"); // 单单据 run：v3 config/experiment-setup ＞ v2 存量只读
    }
  }
  if (!existsSync(path)) {
    return {
      ok: false, error: "eval_field_config_unresolved", path,
      note: isExplicit
        ? "显式传入的 field_config 路径不存在——核对路径后重推"
        : "缺省解析失败：run 目录无 config/experiment-setup/field-config.json（v2 存量 experiment-setup/ 已按映射探测）——显式传 field_config（PromptFieldConfig/v1 路径）后重推",
    };
  }
  let sha256: string;
  try {
    sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return { ok: false, error: "eval_field_config_unresolved", path, note: "field_config 文件不可读——核对权限/完整性后重推（或显式传入有效路径）" };
  }
  // F1.1：模板骨架漂移核对（有记录值就必须对得上——模板换了＝提示渲染面不同源，
  // 评估指标与训练口径不可比；老 run 无该键＝不比对，回执标 absent，零回归）。
  const templateFields = ((): { template_sha256_source: "verified" | "absent" | "drift_accepted"; template_drift_accepted?: true } | null => {
    const recordedTemplate = recordedTemplateSha(runDir);
    if (recordedTemplate === null) return { template_sha256_source: "absent" };
    const actual = fieldConfigTemplateDigestsOf(path);
    if (actual !== null && (actual.primary === recordedTemplate || actual.variant === recordedTemplate)) {
      return { template_sha256_source: "verified" };
    }
    if (isExplicit && acceptTemplateDrift) return { template_sha256_source: "drift_accepted", template_drift_accepted: true };
    return null;
  })();
  if (templateFields === null) {
    return {
      ok: false, error: "eval_template_drift", path,
      note: isExplicit
        ? "字段配置的模板骨架与训练记录不同源（记录里的模板指纹对不上当前文件的 template）——先确认两批数据用的是同一套模板骨架；确认这份就是要用的，带模板差异放行开关（accept_template_drift）后重推"
        : "字段配置的模板骨架与训练记录不同源（run 记录的模板指纹对不上当前继承的 field_config）——先确认训练时是否换过模板；确认要用当前文件，显式传 field_config 并带模板差异放行开关后重推",
    };
  }

  const recorded = recordedFieldConfigSha(runDir);
  if (recorded === null) {
    if (isExplicit) return { ok: true, path, source: "explicit", sha256, ...templateFields }; // 无指纹可核对——显式即权威
    return {
      ok: false, error: "eval_field_config_unverified", path,
      note: "run 未记录字段配置指纹（iteration-config 无 dataset.digest_provenance.field_config_sha256）——显式传 field_config 后重推",
    };
  }
  if (recorded !== sha256) {
    if (isExplicit) return { ok: true, path, source: "explicit", sha256, warning: "field_config_explicit_drift", recorded_sha256: recorded, ...templateFields };
    return {
      ok: false, error: "eval_field_config_drift", path,
      note: "字段配置指纹与训练记录不一致（experiment-setup/field-config.json 可能被改动）——先确认训练配置是否被改过；确认要用当前文件则显式传入 field_config 覆盖后重推",
    };
  }
  return { ok: true, path, source: isExplicit ? "explicit" : "run_recorded", sha256, ...templateFields };
};

/** D14——prompt_mode 解析结果（mode＋来源：显式/训练声明/训练缺省兜底）。 */
export interface EvalPromptModeResolution {
  mode: "mode0" | "mode1";
  source: "explicit" | "training_declared" | "training_default";
}

/** D14——prompt_mode 解析（纯函数）：显式传入→explicit；缺省继承训练声明
 *  （iteration-config 的 dataset.prompt_mode＞顶层 prompt_mode；非 mode0/mode1 值视同无声明）；
 *  无声明→mode0（training_default）。 */
export const resolveEvalPromptMode = (runDir: string, explicit?: string): EvalPromptModeResolution => {
  if (explicit === "mode0" || explicit === "mode1") return { mode: explicit, source: "explicit" };
  for (const candidate of iterationConfigCandidates(runDir)) {
    try {
      if (!existsSync(candidate)) continue;
      const iter = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      const dataset = iter["dataset"] as Record<string, unknown> | undefined;
      for (const declared of [dataset?.["prompt_mode"], iter["prompt_mode"]]) {
        if (declared === "mode0" || declared === "mode1") return { mode: declared, source: "training_declared" };
      }
      return { mode: "mode0", source: "training_default" }; // 可读配置无声明——兜底 mode0（该 run 配置即权威）
    } catch {
      continue; // 损坏——试第二候选；皆不可读＝无声明兜底
    }
  }
  return { mode: "mode0", source: "training_default" };
};

/** D14——评测口径（卡面信息行＋返回体报告面共形）。null＝该面不可得（显示行不阻断，不造数）。 */
export interface EvalCaliber {
  prompt_mode: "mode0" | "mode1";
  prompt_mode_source: EvalPromptModeResolution["source"];
  /** 参与评分的训练字段数（field_config.fields − training_excluded_fields——与内核 E16 计分口径同源）。 */
  training_fields: number | null;
  /** GT 覆盖：评估标注中出现且属训练字段集的字段数。 */
  gt_covered_fields: number | null;
  /** GT 外字段（评估标注有、训练没要——只进返回体报告面，不上卡）。 */
  gt_fields_out_of_scope: string[];
}

/** D14——评测口径计算（纯函数）：field_config（训练字段集）＋eval_labels.jsonl（GT 字段面）。 */
export const computeEvalCaliber = (fieldConfigPath: string, evalAssetsDir: string, promptMode: EvalPromptModeResolution): EvalCaliber => {
  let score: Set<string> | null = null;
  try {
    const fc = JSON.parse(readFileSync(fieldConfigPath, "utf8")) as { fields?: unknown; training_excluded_fields?: unknown };
    const fieldIds = Array.isArray(fc.fields)
      ? fc.fields.map((f) => (f !== null && typeof f === "object" && typeof (f as Record<string, unknown>)["field_id"] === "string" ? (f as Record<string, string>)["field_id"] : null)).filter((v): v is string => v !== null)
      : [];
    const excluded = Array.isArray(fc.training_excluded_fields) ? fc.training_excluded_fields.filter((v): v is string => typeof v === "string") : [];
    score = new Set(fieldIds.filter((f) => !excluded.includes(f)));
  } catch { /* field_config 不可解析＝无口径数字（显示行不阻断——runner 侧自有 fail-closed） */ }
  let gt: Set<string> | null = null;
  try {
    gt = new Set<string>();
    for (const line of readFileSync(join(evalAssetsDir, "eval_labels.jsonl"), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const labels = (JSON.parse(line) as { labels?: unknown }).labels;
        if (labels !== null && typeof labels === "object") for (const key of Object.keys(labels as Record<string, unknown>)) gt.add(key);
      } catch { /* 坏行跳过（显示行不阻断——runner 对行完整性自有 fail-closed） */ }
    }
  } catch { /* 缺/不可读＝无 GT 面（在场性已由前置检查保证，此处为显示行的容错面） */ }
  return {
    prompt_mode: promptMode.mode,
    prompt_mode_source: promptMode.source,
    training_fields: score === null ? null : score.size,
    gt_covered_fields: score !== null && gt !== null ? [...gt].filter((f) => score.has(f)).length : null,
    gt_fields_out_of_scope: score !== null && gt !== null ? [...gt].filter((f) => !score.has(f)).sort() : [],
  };
};

/** D14——口径行文案（卡面信息行，非确认项）：「评测口径：抽取 mode0（继承训练）· 训练字段 25 · GT 覆盖 8」。
 *  training_fields 不可得＝null（整行不上卡，不造数）。 */
export const formatEvalCaliberLine = (caliber: EvalCaliber): string | null => {
  if (caliber.training_fields === null) return null;
  const head = `抽取 ${caliber.prompt_mode}（${caliber.prompt_mode_source === "explicit" ? "显式指定" : "继承训练"}）· 训练字段 ${String(caliber.training_fields)}`;
  return caliber.gt_covered_fields === null
    ? `评测口径：${head}`
    : `评测口径：${head} · GT 覆盖 ${String(caliber.gt_covered_fields)}`;
};

/** D14——cost 行占卡文案（TP 单源：service_config.tensor_parallel_size＞manifest argv
 *  --tensor-parallel-size；两处皆不可得＝不带卡数，不猜）。 */
export const evalGpuCostText = (serviceConfigPath: string, manifest: Record<string, unknown>): string => {
  let tp: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(serviceConfigPath, "utf8")) as Record<string, unknown>;
    const value = parsed["tensor_parallel_size"] ?? parsed["tensor-parallel-size"];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) tp = value;
  } catch { /* service_config 已过在场检查——不可读时走 argv 面 */ }
  if (tp === null && Array.isArray(manifest["argv"])) {
    const argv = manifest["argv"] as unknown[];
    const idx = argv.indexOf("--tensor-parallel-size");
    const raw = idx >= 0 ? argv[idx + 1] : undefined;
    const n = typeof raw === "string" ? Number(raw) : Number.NaN;
    if (Number.isInteger(n) && n > 0) tp = n;
  }
  return tp === null ? "占用 GPU，直到服务停止" : `占用 ${String(tp)} 张 GPU，直到服务停止`;
};

// ── D91：评估 lane 从任务事实取值（指令《ATF_指令_参数面增补_harness_20261023》）──
// 内核事实：评估 lane 闭集＝goods/non_goods（verify-history.py choices）；任务事实权威源＝
// run 内 <runDir>/l1/training-data-manifest.json（TrainingDataArtifact/v1），顶层 lanes 是
// 对象且键即训练 lane 原文名，恰一个键＝唯一 lane。iteration-config 的 lane 字段不可靠
//（walkthrough 链恒写内核缺省 pl_goods，不能区分任务）——selections/冻结账本两处硬编码
// goods 全部退役，判定不了 fail-closed 停下问（禁缺省 goods）。

/** 判定失败业务文案单源（evaluate/analyze 两链共用——零内部码；多 lane 场景列出键名供确认）。 */
export const EVAL_LANE_UNRESOLVED_NOTE_OF = (lanesSeen?: string[]): string =>
  lanesSeen !== undefined && lanesSeen.length > 0
    ? `无法从任务事实判定这批数据的评估 lane（任务事实记录到多个训练数据 lane：${lanesSeen.join("、")}）——请确认后显式指定 lane 再试`
    : `无法从任务事实判定这批数据的评估 lane（训练数据 lane 记录缺席）——请确认后显式指定 lane 再试`;

/** D113：任务事实多源清单——① <runDir>/l1/training-data-manifest.json（既有单源）＋
 *  ② <runDir>/publish-* 目录下的 training-data-manifest.json（walkthrough 发布区实锚
 *  形态 publish-ws-<slug>——B7 缺陷⑫：walkthrough run 的 manifest 落发布区，只认 l1/ 即
 *  eval_lane_unresolved。目录序确定性（按名排序），源不敏感场景取值一致）。 */
const listLaneManifestSources = (runDir: string): string[] => {
  const sources: string[] = [];
  const l1 = join(runDir, "l1", "training-data-manifest.json");
  if (existsSync(l1)) sources.push(l1);
  try {
    const publishDirs = readdirSync(runDir)
      .filter((name) => name.startsWith("publish-"))
      .sort()
      .map((name) => join(runDir, name, "training-data-manifest.json"))
      .filter((path) => existsSync(path));
    sources.push(...publishDirs);
  } catch {
    // run 目录不可读＝仅 l1 源（下方解析按缺席处理）
  }
  return sources;
};

/** 评估 lane 判定（evaluate/analyze 共用单源；E9a·H3 槽位表逐类化）：① 显式 lane
 *  trim 非空即采纳（用户指路语义）；② 槽位 run（docSlots 表非空）按类判定——lane 键
 *  形 `<doc>_<lane>` 归位该类（取自该类 training-data-manifest 的 lanes 键）：指定
 *  docType 判该类；未指定且 N=1 判唯一类（恒等旧语义——恰一键＝唯一 lane）；N>1 未
 *  指定＝lanes_multi_doc（逐类键清单随行——一次评多类在 E9b 前不支持，入口另有快败）；
 *  ③ legacy run（表空）保持 D113 双源逻辑恒等（l1/ 与 publish-* 平铺）。
 *  显式空串＝explicit_empty；全源缺失＝task_fact_missing；lanes 键缺失/非对象＝
 *  lanes_field_invalid；零键＝lanes_empty；单类多键＝lanes_ambiguous（带 lanesSeen）；
 *  多源键集不一致＝lanes_conflict_across_sources（legacy 双源 fail-closed 报两值）。 */
export const resolveEvalLaneFrom = (
  runDir: string,
  explicitLane: string | undefined,
  docType?: string,
): { ok: true; lane: string; source: "explicit" | "task_fact" } | { ok: false; reason: "explicit_empty" | "task_fact_missing" | "lanes_field_invalid" | "lanes_empty" | "lanes_ambiguous" | "lanes_multi_doc" | "lanes_conflict_across_sources"; lanesSeen?: string[]; lanesByDoc?: Array<{ doc_type: string; lanes: string[] }>; conflict?: Array<{ source: string; lanes: string[] }> } => {
  if (explicitLane !== undefined) {
    const trimmed = explicitLane.trim();
    if (trimmed === "") return { ok: false, reason: "explicit_empty" };
    return { ok: true, lane: trimmed, source: "explicit" };
  }
  // E9a·H3：槽位 run 按类判定（lane 键归位——类内恰一键才成立，取消全局「恰一 lane」判）
  const slots = listDocSlots(runDir);
  if (slots.length > 0) {
    const lanesByDoc = slots.map((slot) => ({ doc_type: slot.doc_type, lanes: slot.lanes }));
    const target = docType !== undefined && docType.trim() !== ""
      ? lanesByDoc.find((entry) => entry.doc_type === docType.trim())
      : undefined;
    if (docType !== undefined && docType.trim() !== "" && target === undefined) {
      return { ok: false, reason: "task_fact_missing", lanesByDoc };
    }
    const pick = target ?? (slots.length === 1 ? lanesByDoc[0]! : null);
    if (pick === null) {
      return { ok: false, reason: "lanes_multi_doc", lanesSeen: lanesByDoc.flatMap((entry) => entry.lanes), lanesByDoc };
    }
    const manifestPath = slots.find((slot) => slot.doc_type === pick.doc_type)!.training_data_manifest;
    if (manifestPath === null) return { ok: false, reason: "task_fact_missing", lanesByDoc }; // 该类未发布——manifest 缺席
    if (pick.lanes.length === 0) return { ok: false, reason: "lanes_empty", lanesSeen: pick.lanes, lanesByDoc };
    if (pick.lanes.length > 1) return { ok: false, reason: "lanes_ambiguous", lanesSeen: pick.lanes, lanesByDoc };
    return { ok: true, lane: pick.lanes[0] as string, source: "task_fact" };
  }
  // legacy run（表空）——D113 双源逻辑恒等
  const sources = listLaneManifestSources(runDir);
  if (sources.length === 0) return { ok: false, reason: "task_fact_missing" };
  const lanesBySource: Array<{ source: string; lanes: string[] }> = [];
  for (const source of sources) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(source, "utf8"));
    } catch {
      return { ok: false, reason: "task_fact_missing" };
    }
    const lanes = manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>)["lanes"]
      : undefined;
    if (lanes === null || typeof lanes !== "object" || Array.isArray(lanes)) {
      return { ok: false, reason: "lanes_field_invalid" };
    }
    lanesBySource.push({ source, lanes: Object.keys(lanes as Record<string, unknown>).filter((key) => key.trim() !== "") });
  }
  const first = lanesBySource[0]?.lanes ?? [];
  if (first.length === 0) return { ok: false, reason: "lanes_empty", lanesSeen: first };
  if (first.length > 1) return { ok: false, reason: "lanes_ambiguous", lanesSeen: first };
  // 多源一致性（D113 fail-closed：任一源键集与首个不同即冲突，报两值）
  for (const entry of lanesBySource.slice(1)) {
    if (entry.lanes.length !== 1 || entry.lanes[0] !== first[0]) {
      return { ok: false, reason: "lanes_conflict_across_sources", conflict: lanesBySource };
    }
  }
  return { ok: true, lane: first[0] as string, source: "task_fact" };
};

/** D114：评估分区清单解析结果。 */
export interface SplitManifestResolution {
  path: string;
  source: "explicit" | "discovered_l1" | "discovered_publish";
}

/** D114：split-manifest 解析（编排绑定兼容 walkthrough 布局）：显式 assets_split_manifest ＞
 *  run 树自动发现（l1/split-manifest.json → publish-* 目录下 split-manifest.json——walkthrough
 *  发布区实锚，确定性按名排序取首）。发现域仅限本 run 树内（本次训练 run 自己的留出分区
 *  ——内核逐页校验 ⊆ test 分区不因发现而放宽；外部资产仍须显式绑定或 owner 级确认）。
 *  未发现＝null（调用方按既有绑定三态裁决）。 */
export const resolveEvalSplitManifest = (runDir: string, explicit?: string): SplitManifestResolution | null => {
  if (explicit !== undefined && explicit.trim() !== "") return { path: explicit.trim(), source: "explicit" };
  const l1 = join(runDir, "l1", "split-manifest.json");
  if (existsSync(l1)) return { path: l1, source: "discovered_l1" };
  try {
    const hit = readdirSync(runDir)
      .filter((name) => name.startsWith("publish-"))
      .sort()
      .map((name) => join(runDir, name, "split-manifest.json"))
      .find((path) => existsSync(path));
    if (hit !== undefined) return { path: hit, source: "discovered_publish" };
  } catch {
    // run 目录不可读＝无发现（调用方按缺席处理）
  }
  return null;
};

// ── F6-a/F6-b：atf_evaluate 的用户面摘要（user_summary）与连续失败升级（escalate_to_user）──
// 方案 §3-1 修正：三句话结论文本**不进提示词**，由回执结构携带（T 面），并在工具执行侧
// 直接投影进会话流（L 面——exec.deferContext，用户直接看到，不靠 agent 转述）。

/** 评估工具名（失败计数键与通知来源标签同源）。 */
const EVAL_TOOL_NAME = "atf_evaluate";

/** 评估回执 → 用户面三句话（业务语言、零内部码；码本身仍留在回执机器面）。 */
export const evalUserSummaryOf = (receipt: Record<string, unknown>, ok: boolean, action?: string): UserSummary => {
  if (ok) {
    if (action === "status") {
      return {
        conclusion: "评估进度已查到",
        stage: "评估在跑或已出结果",
        next: "按回执里的四件套与指标继续；要改参数就直接说要改哪一项",
      };
    }
    return {
      conclusion: "评估已启动",
      stage: "评估服务与编排在后台跑（起服务→对齐检查点→正式评测→回灌结果）",
      next: "用 atf_evaluate status 查进度；出结果后看四件套与指标",
    };
  }
  const code = typeof receipt["error"] === "string" ? receipt["error"] : "";
  const gate = "还没开始跑（未消耗审批与显卡）";
  switch (code) {
    case "adapter_path_missing":
    case "eval_assets_dir_missing":
    case "service_config_missing":
    case "eval_assets_missing":
      return { conclusion: "评估还缺必要的输入件", stage: gate, next: "按回执点名的那一项补齐后重推 start" };
    case "env_profile_not_found":
    case "env_profile_ambiguous":
      return { conclusion: "评估环境档案需要你指定一份", stage: gate, next: "从回执列出的档案里挑一个，再说一次要用的档案名" };
    case "machine_facts_missing":
      return { conclusion: "评估要用的机器事实不全", stage: gate, next: "补服务配置或环境档案里的端口/显存/绑卡信息后重推" };
    case "eval_assets_binding_missing":
    case "assets_split_manifest_missing":
      return { conclusion: "评估数据还没绑定来源分区", stage: gate, next: "给出分区清单，或明确确认这批数据就是外部来源" };
    case "eval_field_config_unresolved":
    case "eval_field_config_drift":
    case "eval_field_config_unverified":
    case "eval_field_config_multi_doc":
      return { conclusion: "字段配置对不上，评估没有启动", stage: gate, next: "核对训练用的字段配置；确认要用现在这份就显式指定字段配置路径" };
    case "eval_template_drift":
      return { conclusion: "字段配置的模板骨架与训练时不同", stage: gate, next: "确认两批数据用的是同一套模板骨架；确认要用现在这份就带模板差异放行开关重推" };
    case "eval_lane_unresolved":
      return { conclusion: "评估批次（lane）定不下来", stage: gate, next: "说清这批数据属于哪一类，或核对训练数据里的批次记录" };
    case "run_binding_required":
      return { conclusion: "本会话还没有选择实验", stage: gate, next: "先从回执列出的候选里选一个实验，再说要评估什么" };
    case "concurrency_invalid":
    case "concurrency_exceeds_capacity":
      return { conclusion: "评估并发值不合要求", stage: gate, next: "按回执给的容量值收紧并发后重推" };
    case "approval_denied":
      return { conclusion: "评估放行未获批准", stage: "停在确认卡（服务未启动）", next: "说明要调整的项后重推；审批只能由有权限的人点" };
    default:
      return { conclusion: "评估没有启动成功", stage: "停在准备阶段", next: "按回执里的提示补齐后重试；连着两次不成功会升级给你" };
  }
};

/** atf_evaluate 外层包装：所有返回出口统一记成败＋挂 user_summary；升级时直投会话通知。 */
const instrumentEvalOutcome = <T extends { execute: (args: unknown, exec: unknown) => Promise<unknown> }>(tool: T): T => {
  const inner = tool.execute.bind(tool);
  (tool as { execute: (args: unknown, exec: unknown) => Promise<unknown> }).execute = async (args: unknown, exec: unknown) => {
    const receipt = await inner(args, exec);
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return receipt;
    const payload = receipt as Record<string, unknown>;
    const rawAction = (args as { action?: unknown } | null | undefined)?.action;
    const action = typeof rawAction === "string" ? rawAction : undefined;
    const ok = !receiptIsFailure(payload);
    const decorated = decorateOutcome(
      payload, sessionIdOf(exec) ?? null, EVAL_TOOL_NAME, ok, evalUserSummaryOf(payload, ok, action),
    );
    const escalated = decorated.escalate_to_user === true;
    const summary: UserSummary = escalated
      ? { ...decorated.user_summary, next: "连续两次没成功——需要你介入：失败原因已写在回执里（可直接查看），看一眼就知道是缺条件还是环境问题；也可以直接说要改哪一项" }
      : decorated.user_summary;
    if (escalated) decorated.user_summary = summary;
    // L 层投影：通知进会话流（status 查询且未升级时不投——免噪声）
    if (!ok ? escalated : action !== "status") {
      projectUserNotice(exec as { deferContext?: (context: unknown) => void } | undefined, summary);
    }
    return decorated;
  };
  return tool;
};

// ── F8：badcase 分析链的审阅覆盖透传（内核 run_analysis_chain.py 的 stdout 顶层）──

/** 审阅覆盖（内核口径）。 */
export interface ReviewCoverage {
  pages_total: number;
  pages_reviewed: number;
  status: string;
}

/** 取 stdout 末段 JSON 对象（整串 → 逐行自尾向上 → 最后一个 `{` 起到串尾）；解析不到＝null。 */
const trailingJsonObjectOf = (stdout: string): Record<string, unknown> | null => {
  const text = stdout.trim();
  if (text === "") return null;
  const asObject = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const whole = asObject(text);
  if (whole !== null) return whole;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("{")) continue;
    const hit = asObject(line);
    if (hit !== null) return hit;
  }
  const brace = text.lastIndexOf("{");
  return brace >= 0 ? asObject(text.slice(brace)) : null;
};

/** F8——一键链 stdout → 回执透传面：`review_coverage{pages_total,pages_reviewed,status}` 原值
 *  透传＋`incomplete`（内核给了布尔就照抄，否则 pages_reviewed===0）；解析不到＝
 *  `review_coverage:null` ＋ `incomplete_reason:"chain_output_missing"`（不静默编造覆盖度）。 */
export const reviewCoverageOf = (stdout: string): {
  review_coverage: ReviewCoverage | null;
  incomplete: boolean;
  incomplete_reason?: "chain_output_missing";
} => {
  const parsed = trailingJsonObjectOf(stdout);
  const raw = parsed?.["review_coverage"];
  const coverage = ((): ReviewCoverage | null => {
    if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const pagesTotal = record["pages_total"];
    const pagesReviewed = record["pages_reviewed"];
    const status = record["status"];
    if (typeof pagesTotal !== "number" || typeof pagesReviewed !== "number" || typeof status !== "string") return null;
    return { pages_total: pagesTotal, pages_reviewed: pagesReviewed, status };
  })();
  if (coverage === null) {
    return { review_coverage: null, incomplete: true, incomplete_reason: "chain_output_missing" };
  }
  const kernelFlag = parsed?.["incomplete"];
  return {
    review_coverage: coverage,
    incomplete: typeof kernelFlag === "boolean" ? kernelFlag : coverage.pages_reviewed === 0,
  };
};

/** atf_evaluate / atf_analyze_badcases 构造（评估与两步链——start/status 与轻量直跑）。 */
export function buildEvalTools(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; logDir: string; kernelDir: string; resolveEvalRound?: EvalRoundResolver; bindRun?: (runId: string) => Promise<void>; /** D49：canonical 解析种子（与 TrainingToolsConfig 同键——canonicalRunRootsOf(cfg) 注入面；缺省注册表实例态）。 */ canonicalRoots?: readonly string[]; /** F11-2：档案清单读取面（缺省 process.env——测试注入用）。 */ env?: Readonly<Record<string, string | undefined>> }): unknown[] {
  // F11-2：env_profile 参数描述里的实例档案清单——**启动时**读一次实例 env-profiles 目录，
  // 把实际档案名与各自 eval_env 摘要写进工具描述（T 面可发现性）；目录不可得／无档案＝
  // 保留原文案并标「目录不可得」（运行时读，源码不写死任何实例的档案名）。
  const envProfileCatalog = envProfileCatalogLineOf(cfg.env ?? process.env) ?? "可选值见该目录内 .json 文件名（目录不可得）";
  const evaluate = defineTool({
    name: "atf_evaluate",
    description:
      "评估触发（正道链——确认制＋EVAL_RELEASE 审批账本，绕行 llamafactory api 形态已删除）：action=start 编排 pin 内正道链 generate_eval_service（vllm serve＋AWQ base）→build_service_prelaunch_report（九必报项确认报告）→用户确认（确认卡＝EVAL_RELEASE 放行，--record-eval-release 落账本）→generate_eval_orchestration（tmux 后台：服务自启→staging→run_formal_eval→回灌）；action=status 查询服务 receipt/编排状态/四件套与 model 标签。双段式：确认卡前先以问题卡呈九必报项值清单＋改参指引（可调＝adapter_path/eval_assets_dir/service_config 各项；改参回复聊天，重推 start 重走链）；机器事实三件（eval_env/awq_base/cuda_visible_devices）一律来自 deploy/env-profile，缺即 MissingFactsBlock 停下问用户。评估轮目录＝runs/<run_id>/eval/<N>-<日期>/{service,ckpt-plan,orch}（ADR-0007）。",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "status"], description: "start=确认并启动正道链（后台编排）；status=查询进度与四件套" },
      run_id: { type: "string", description: "可选；省略时使用本会话当前绑定的实验。无绑定会返回 run_binding_required 与候选（含实验名与工作区），不要自行猜一个 id" },
      // D32：start 四参降 optional——status 只按 run/轮次查询（不传 start 参数可查）；
      // start 路径 execute 内逐参验证（缺即结构化 *_missing，先于一切产物生成）
      adapter_path: { type: "string", description: "adapter checkpoint 目录绝对路径（仅 action=start 必填；status 省略）——固定编号（checkpoint-<数字>），拒 latest/符号链接/缺省猜测（SKILL.md 环节④条款）" },
      // D91：评估 lane 判定失败停下问时的显式覆盖通道（缺省从任务事实取——不设缺省 goods）
      lane: { type: "string", description: "评估 lane（可选——缺省从任务事实取 run 内训练数据 lane 记录；判定不了会停下来问；显式给值可覆盖）" },
      eval_assets_dir: { type: "string", description: "L1 EvaluationAssets/v1 目录（test_images.json+eval_labels.jsonl）（仅 action=start 必填；status 省略）" },
      field_config: { type: "string", description: "PromptFieldConfig/v1 JSON 路径（可选——缺省自动继承 <runDir>/experiment-setup/field-config.json 并与训练记录指纹核对；显式传入即覆盖，文件指纹漂移仅告警不阻断。注意模板骨架（template）漂移是硬拒：记录里的 template 指纹对不上当前文件即返回 eval_template_drift，需先确认，确要换骨架时带 accept_template_drift=true 重推）" },
      accept_template_drift: { type: "boolean", description: "显式接受字段配置的模板骨架差异（可选，缺省 false＝fail-closed）：仅在显式传 field_config 且确认要换模板骨架时给出；放行后回执标 template_drift_accepted=true" },
      prompt_mode: { type: "string", enum: ["mode0", "mode1"], description: "抽取方式（可选——缺省继承训练声明，无声明即 mode0）：mode0＝每页一次、全字段抽取；mode1＝按字段分组、每页×每组，适合字段多/相互干扰时。默认跟训练一致，不要自行切换" },
      service_config: { type: "string", description: "EvalServiceConfig/v1 JSON 路径（仅 action=start 必填；status 省略。按 SKILL.md 作者声明：port/TP/gpu_memory_utilization/max_model_len/mm 像素对/adapters 挂载表——adapters[].path 即本次 staging 的 adapter 源）" },
      env_profile: { type: "string", description: `环境档案名（仅 action=start 需要，可省略；status 省略）——评估环境配置层，确认报告九必报项⑤端口/连接的数据源。省略时按实例目录 <ATF_INSTANCE_ROOT|ATF_HOME>/.atf/env-profiles 自动派生：目录内恰一份含 eval_env 的档案即自动选用（回执带 env_profile_source=instance_default(<名>)）；多份＝返回 env_profile_ambiguous 列候选（让用户选），此时不要自拟档案名——${envProfileCatalog}` },
      deploy: { type: "string", description: "可选 deploy.local.yaml 路径（显式机器事实，优先于环境档案）" },
      // 批C2 E6 卡点修复：评估资产绑定通道（内核编排契约——外部资产须绑定分区清单或 owner 级显式确认）
      assets_split_manifest: { type: "string", description: "评估资产分区清单路径（split-manifest；跨 run/发布区资产须绑定——绑定后评估输入必须全部来自该 test 分区，内核逐页校验。缺省自动发现本 run 树内 l1/ 或 publish-* 下的 split-manifest.json——walkthrough 布局无需显式传）" },
      assets_external_confirm: { type: "boolean", description: "外部资产 owner 级确认（无分区清单时的显式通道——确认评估输入确属预期来源；显式给出时优先于 run 树自动发现）" },
      // 批D17：并发参数（透传 prelaunch --concurrency/--concurrency-recommended/--concurrency-reason
      // 与编排 --concurrency；容量门＝service_config.max_num_seqs，超容量零落盘零审批快败）
      concurrency: { type: "integer", description: "评估推理并发（可选，默认 1；省略＝串行。上限＝服务 max_num_seqs；图像类任务建议从中等并发起步，不要默认拉满）" },
      concurrency_reason: { type: "string", description: "并发取值理由（可选——传 concurrency 时一并给；随确认报告落盘，缺理由＝报告不完备）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => {
        // 批次R H1-3 补面（R-H）：内核四码命中时用户面只呈人话 note——kernel_error 属
        // 机器对账键，码原文/traceback 不进页面（产品语言纪律：错误回流全业务语）。
        const faced = value as Record<string, unknown>;
        if (faced["kernel_error"] !== undefined) return [{ type: "text", text: String(faced["note"] ?? "") }];
        return [{ type: "text", text: JSON.stringify(value, null, 1) }];
      },
    },
    presentCall: function(args: { action: string; run_id?: string }) {
      return { card: "generic" as const, title: `评估 — ${args.run_id ?? "会话绑定实验"}`, kind: "other" as const }
    },
    async execute(args: { action: string; run_id?: string; adapter_path?: string; eval_assets_dir?: string; lane?: string; field_config?: string; prompt_mode?: string; service_config?: string; env_profile?: string; deploy?: string; assets_split_manifest?: string; assets_external_confirm?: boolean; concurrency?: number; concurrency_reason?: string; accept_template_drift?: boolean }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批B1：run_id 缺省解析（显式＞会话绑定；无绑定＝run_binding_required＋候选——先于一切检查）
      const runResolution = resolveToolRun(cfg.runsRoot, exec, args.run_id, canonicalRunRootsOf(cfg));
      if (!runResolution.ok) return asToolValue(runResolution.payload);
      const runId = runResolution.runId;
      const runDir = runResolution.runDir;
      const skill = (name: string, script: string): string => join(cfg.kernelDir, "skills", name, "scripts", script);
      const genService = skill("atf-evaluate-checkpoints", "generate_eval_service.py");
      const prelaunch = skill("atf-evaluate-checkpoints", "build_service_prelaunch_report.py");
      const ckptPlanGen = skill("atf-evaluate-checkpoints", "generate_checkpoint_plan.py");
      const orchestration = skill("atf-evaluate-checkpoints", "generate_eval_orchestration.py");
      const runner = skill("atf-evaluate-checkpoints", "run_formal_eval.py");
      if (args.action === "status") return evalStatus(runId, cfg);
      // E9a·H5：多类先 fail-closed——一次评多类（逐类推理调度）在下一批落地，本批禁止
      // 静默只评一类（字段闭集串类＝指标无意义，ADR-0017 决定 10）。槽位表>1 即卡前快败
      //（零产物零审批零 spawn；legacy 平铺 run 表空不触发本闸）。
      // H-E9b：一条路（ADR-0017 决定 1）——N 个槽位同一条路径，N=1 就是 1 个槽位。
      // 逐类输入（资产/字段配置/分区清单/lane）由内核 --run 按权威槽位表派生；
      // 显式单值参数只在**单槽位**时可用（此时等同覆盖），多槽位下无法挑代表即快败。
      const evalSlots = listDocSlots(runDir);
      const evalDocTypes = evalSlots.map((slot) => slot.doc_type);
      const multiDoc = evalSlots.length > 1; // eval_doc_types_derived
      const explicitSingleInputs = [
        typeof args.eval_assets_dir === "string" && args.eval_assets_dir.trim() !== "" ? "eval_assets_dir" : null,
        typeof args.field_config === "string" && args.field_config.trim() !== "" ? "field_config" : null,
        typeof args.assets_split_manifest === "string" && args.assets_split_manifest.trim() !== "" ? "assets_split_manifest" : null,
      ].filter((v): v is string => v !== null);
      if (multiDoc && explicitSingleInputs.length > 0) {
        return asToolValue({
          started: false, error: "eval_inputs_ambiguous_in_multi_doc", run_id: runId, doc_types: evalDocTypes,
          explicit_inputs: explicitSingleInputs,
          note: `本 run 有 ${String(evalSlots.length)} 类单据（${evalDocTypes.join("、")}）——${explicitSingleInputs.join("／")} 是单类入参，无法代表多类；去掉这些参数后重试，逐类输入由内核按槽位表派生`,
        });
      }
      // D32：status 只按 run/轮次查询（start 四参降 optional）；start 路径逐参验证
      // （缺即结构化 *_missing——先于一切产物生成与审批，零消耗放行）
      if (typeof args.adapter_path !== "string" || args.adapter_path.trim() === "") {
        return asToolValue({ started: false, error: "adapter_path_missing", note: "action=start 必填 adapter_path（status 查询只按 run/轮次——无需 start 参数）" });
      }
      if (typeof args.eval_assets_dir !== "string" || args.eval_assets_dir.trim() === "") {
        return asToolValue({ started: false, error: "eval_assets_dir_missing", note: "action=start 必填 eval_assets_dir（status 查询只按 run/轮次——无需 start 参数）" });
      }
      if (typeof args.service_config !== "string" || args.service_config.trim() === "") {
        return asToolValue({ started: false, error: "service_config_missing", note: "action=start 必填 service_config（status 查询只按 run/轮次——无需 start 参数）" });
      }
      // env_profile 由必填降为可选：省略时按实例档案目录派生（ATF_INSTANCE_ROOT／ATF_HOME，
      // **不读 HOME**）——恰一份可用即自动选用并回报来源；多份＝env_profile_ambiguous（列候选
      // 交上层出选项卡）；零份＝env_profile_not_found（列全量档案名＋eval_env，禁编名字）。
      const envProfileResolved = resolveEvalEnvProfile(args.env_profile);
      if (!envProfileResolved.ok) return asToolValue(envProfileResolved.payload);
      const envProfile = envProfileResolved.name;
      const envProfileSource = envProfileResolved.source;
      for (const script of [genService, prelaunch, ckptPlanGen, orchestration, runner]) {
        if (!existsSync(script)) return asToolValue({ started: false, error: "skill_script_missing", script, note: "pin 内技能脚本缺失——核 kernelDir 装配" });
      }
      // —— start：固定编号 adapter 校验 → 生成服务件 → 确认报告 → EVAL_RELEASE 确认卡 → 账本登记 → 编排（tmux 后台） ——
      const adapterCheck = validateFixedCheckpoint(args.adapter_path);
      if (!adapterCheck.ok) return asToolValue({ started: false, error: adapterCheck.reason, adapter_path: args.adapter_path, note: "SKILL.md 环节④：固定编号显式声明——latest/符号链接/最大编号推断一律拒绝" });
      // 批C2 E6 卡点修复①＋D114：评估资产绑定卡前快败（内核编排契约——显式或 run 树
      // 自动发现的 split-manifest 均构成绑定；无绑定且无 owner 级确认即外部通道须拒绝。
      // 自动发现域仅限本 run 树——walkthrough 布局兼容〔split-manifest 落 publish-*/〕，
      // 内核逐页校验 ⊆ test 分区不因发现而放宽）
      const splitManifestResolved = args.assets_external_confirm === true
        ? (args.assets_split_manifest !== undefined && args.assets_split_manifest.trim() !== ""
          ? { path: args.assets_split_manifest.trim(), source: "explicit" as const }
          : null) // 显式 owner 外部确认优先于自动发现（发现仅补缺席——不覆盖显式选择的外部通道）
        : resolveEvalSplitManifest(runDir, args.assets_split_manifest);
      if (!multiDoc && splitManifestResolved === null && args.assets_external_confirm !== true) {
        return asToolValue({
          started: false, error: "eval_assets_binding_missing", eval_assets_dir: args.eval_assets_dir,
          note: "评估资产须显式绑定：跨 run/发布区资产传 assets_split_manifest（分区清单——内核逐页校验 ⊆ test 分区），或经 owner 级确认传 assets_external_confirm=true（外部显式通道）；本 run 树内 l1/ 或 publish-* 下的 split-manifest.json 可自动发现绑定，补参或落件后重试",
        });
      }
      if (splitManifestResolved !== null && !existsSync(splitManifestResolved.path)) {
        return asToolValue({ started: false, error: "assets_split_manifest_missing", path: splitManifestResolved.path, note: "分区清单路径不存在——核对后重试" });
      }
      // 批㊶Q增补三 段3：run 目录已由 resolveToolRun 双形态解析（显式/绑定 run 均须已存在）
      if (!existsSync(args.service_config)) return asToolValue({ started: false, error: "service_config_missing", path: args.service_config });
      if (!multiDoc && (!existsSync(join(String(args.eval_assets_dir), "eval_labels.jsonl")) || !existsSync(join(String(args.eval_assets_dir), "test_images.json")))) {
        return asToolValue({ started: false, error: "eval_assets_missing", eval_assets_dir: args.eval_assets_dir, note: "test_images.json+eval_labels.jsonl 必备" });
      }
      // —— 批D17：并发参数门（先于一切产物生成——超容量零落盘零审批；容量单源＝
      // service_config.max_num_seqs。prelaunch 既有推荐值≤容量校验不在此重复——本处只做
      // 参数门快败；容量不可读不猜，交 prelaunch 机械核对）——
      const concurrencyGate = resolveEvalConcurrency(readFileSync(args.service_config, "utf8"), args.concurrency);
      if (!concurrencyGate.ok) {
        return asToolValue({
          started: false, error: concurrencyGate.error, concurrency: concurrencyGate.concurrency,
          ...(concurrencyGate.max_num_seqs !== undefined ? { max_num_seqs: concurrencyGate.max_num_seqs, suggested_concurrency: concurrencyGate.suggested_concurrency } : {}),
          note: concurrencyGate.note,
        });
      }
      const concurrency = concurrencyGate.concurrency;
      // —— D14：评测参数继承（先于一切产物生成——解析失败零编排启动零落盘）——
      // field_config 缺省自动继承训练（显式传入→覆盖，漂移仅告警）；prompt_mode 缺省继承训练声明。
      // F1.1：模板骨架漂移开关（显式接受＝仅显式 field_config 时放行；缺省 fail-closed 报 eval_template_drift）
      const fieldConfigResolved = resolveEvalFieldConfig(runDir, args.field_config, undefined, { acceptTemplateDrift: args.accept_template_drift === true });
      if (!multiDoc && !fieldConfigResolved.ok) {
        return asToolValue({
          started: false, error: fieldConfigResolved.error, run_id: runId,
          ...(fieldConfigResolved.error === "eval_field_config_unresolved" ? { field_config_expected: fieldConfigResolved.path } : {}),
          note: fieldConfigResolved.note,
        });
      }
      const promptMode = resolveEvalPromptMode(runDir, args.prompt_mode);
      // D91：评估 lane 判定提前到审批卡之前（fail-closed——坏条件不消耗放行，卡前快败先例同
      // pipelineFace A-E14b）：显式 lane ＞ 任务事实（run 内 training-data-manifest lanes 键集
      // 恰一 lane）；判定不了即停——禁缺省 goods。checkpoint staging selections 用判定值。
      const evalLaneResolved = resolveEvalLaneFrom(runDir, args.lane);
      if (!multiDoc && !evalLaneResolved.ok) {
        return asToolValue({
          started: false, error: "eval_lane_unresolved", run_id: runId,
          ...(evalLaneResolved.lanesSeen !== undefined ? { lanes_seen: evalLaneResolved.lanesSeen } : {}),
          // D113：多源键集冲突 fail-closed 报两值（源路径形态相对 run 目录，供确认后显式指路）
          ...(evalLaneResolved.conflict !== undefined ? { lanes_conflict: evalLaneResolved.conflict } : {}),
          note: EVAL_LANE_UNRESOLVED_NOTE_OF(evalLaneResolved.lanesSeen),
        });
      }
      // 多槽位：staging 标签取 joint（同一 adapter 服务全体类；lane 本身逐类，见 doc_slots lanes）
      const evalLane = evalLaneResolved.ok ? evalLaneResolved.lane : "joint";
      // 多槽位：字段配置逐类由内核派生，harness 侧不再持有一份（禁挑一类当代表）
      const fieldConfigPath = fieldConfigResolved.ok ? fieldConfigResolved.path : undefined;
      const caliber = fieldConfigPath !== undefined ? computeEvalCaliber(fieldConfigPath, args.eval_assets_dir, promptMode) : null;
      const caliberLine = caliber !== null ? formatEvalCaliberLine(caliber) : null;
      // 评估轮号＝内核单源（resolve-eval-round：E5 复评复用判定在内核；harness 不再自建
      // maxN+1——那会每次评估新派一轮）。checkpoints 传入本次 adapter 的固定编号，
      // 供内核按「同一批判档」判定复用/递增；三子步 --out 全落在同一 roundDir 下。
      const checkpoints = [basename(args.adapter_path)];
      // F2：生产走内核 CLI（单源）；测试经 cfg.resolveEvalRound 注入 stub。
      const roundResolution = cfg.resolveEvalRound !== undefined
        ? await cfg.resolveEvalRound(runDir, checkpoints)
        : await resolveEvalRoundDir(runDir, cfg, checkpoints);
      if (!roundResolution.ok) return asToolValue(roundResolution.payload);
      const roundDir = roundResolution.roundDir;
      const serviceDir = join(roundDir, "service");
      const deployArgs = args.deploy !== undefined ? ["--deploy", args.deploy] : [];
      // ① 生成服务件（机器事实 fail-closed 在脚本内：exit 2＝MissingFactsBlock——停下问用户，不进确认卡）
      // E5·H2：env 显式传（HOME＝实例根单源——子步内 Path.home() 解析不随继承面漂移）
      const generated = await runCapture("python3", [genService, "--config", args.service_config, "--env-profile", envProfile, ...deployArgs, "--out", serviceDir], 120_000, evalChildEnvOf());
      const blockPath = join(serviceDir, "machine-facts-block.json");
      if (generated.code !== 0) {
        // 批次R H1-3 补面（R-H 实锚）：eval 服务件生成失败输出先扫内核四码
        // （token_budget_missing 等——预算缺失的 run 在服务件生成期即 fail，GPU 前零写入）。
        // 命中即 note 人话回流；未命中保持既有机器事实缺形态（machine_facts_missing）。
        // D77：完整码不进模型可见返回体——对账面＝scratch 观测账。
        const kernelFace = scanKernelErrorFace([generated.stderr, generated.stdout]);
        if (kernelFace !== null) {
          return asToolValue({
            started: false, error: kernelFace.code.split(":")[0], eval_round: roundDir,
            note: kernelFace.note,
          });
        }
        const block = existsSync(blockPath) ? JSON.parse(readFileSync(blockPath, "utf8")) as Record<string, unknown> : null;
        return asToolValue({
          started: false, error: "machine_facts_missing", eval_round: roundDir,
          ...(block !== null ? { missing_facts_block: block } : { stderr_tail: generated.stderr.slice(-800) }),
          note: "机器事实不设默认值：缺事实停下来问用户（ask_user_for_input），禁止猜测继续——补 deploy/env-profile 后重试",
        });
      }
      const manifest = JSON.parse(readFileSync(join(serviceDir, "service_manifest.json"), "utf8")) as Record<string, unknown>;
      const expectedModels = (manifest["expected_model_names"] as string[] | undefined) ?? [];
      const leaking = expectedModels.filter((m) => modelLabelLooksDefault(m));
      if (leaking.length > 0) return asToolValue({ started: false, error: "serving_model_label_default_leak", models: leaking, note: "service manifest 期望模型名含 OpenAI 风格缺省名——gpt-*/claude-* 前缀拒收（防线）" });
      // ② 确认报告（九必报项，产物反生成自 service_manifest）
      // 批D17：并发三参透传——实际值恒传（缺省 1）；推荐值/理由仅显式传参时给（推荐＝agent
      // 主动推理域，串行缺省无推荐；内核校验推荐值 ≤ max_num_seqs——harness 不设第二套）
      const reportPath = join(serviceDir, "service-prelaunch-report.md");
      const reported = await runCapture("python3", [prelaunch, "--service-dir", serviceDir, "--env-profile", envProfile, "--out", reportPath,
        "--field-config", fieldConfigPath ?? "", "--prompt-renderer", skill("atf-admit-training-data", "render_prompt.py"),
        "--concurrency", String(concurrency),
        ...(args.concurrency !== undefined ? ["--concurrency-recommended", String(concurrency)] : []),
        ...(args.concurrency_reason !== undefined && args.concurrency_reason.trim() !== "" ? ["--concurrency-reason", args.concurrency_reason.trim()] : [])], 120_000, evalChildEnvOf());
      if (reported.code !== 0 || !existsSync(reportPath)) {
        return asToolValue({ started: false, error: "prelaunch_report_failed", eval_round: roundDir, stderr_tail: reported.stderr.slice(-800), note: "确认报告未产出＝EVAL_RELEASE 准入未闭合（SKILL.md 确认制）" });
      }
      // ③ EVAL_RELEASE 确认卡：卡面摘要化（批㊶-EVALCARD，owner 裁 A 案——确认制语义
      // 不弱化：九必报项全文落盘可达（路径行），卡面只上 headline/metrics 摘要），
      // Allow once＝确认并落放行账本
      const reportText = readFileSync(reportPath, "utf8");
      const summary = summarizeEvalPrelaunchReport(reportText, runId);
      // 批㊶-U §五：评估卡改参收集走聊天回复、审批卡落账本（EVAL_RELEASE 账本语义不动）；
      // E5 模板四行＋确认摘要续行。D14 卡面修复：headline＝评估放行、无参数名/绝对路径、
      // cost＝占卡实况；新增口径行与字段配置来源行（信息行，不新增确认项）
      const verdict = await requestApproval(ctx, exec, "atf_evaluate",
        buildApprovalReason({
          action: "放行评估服务编排",
          target: `（run ${runId}）`,
          effect: `登记放行账本（config sha256）并启动评估编排——${evalGpuCostText(args.service_config, manifest)}`,
          reversible: "不可自动回滚（评估产物可人工清理）",
        }) + "\n" + [
          `确认摘要：${summary.headline}`,
          ...summary.metrics,
          ...(caliberLine !== null ? [caliberLine] : []),
          fieldConfigResolved.ok
            ? `字段配置：${fieldConfigResolved.source === "run_recorded" ? "继承训练记录（run_recorded）" : "显式传入（explicit）"}${fieldConfigResolved.warning !== undefined ? "——与训练记录指纹不一致，按显式覆盖执行" : ""}`
            : `字段配置：逐类派生（${String(evalDocTypes.length)} 类单据，由内核按槽位表各取各的配置）`,
          // D114：分区清单来源行（信息行，不新增确认项——自动发现不静默，run 树 l1/ 与
          // publish-* 布局如实标注；owner 外部确认通道明示）
          ...(splitManifestResolved !== null
            ? [`分区清单：${splitManifestResolved.source === "explicit" ? "显式传入" : "run 树自动发现"}（${splitManifestResolved.source}）`]
            : ["分区清单：无绑定——owner 级外部确认通道"]),
          "详细报告已生成（评估轮目录内）",
          "如需调整评估数据、adapter 或服务参数，直接回复要改的项；不改直接回复「按现值确认」",
          "仅 owner 可点；执行方不得代点",
        ].join("\n"));
      if (!verdict.ok) return approvalDeniedResult("atf_evaluate", verdict.outcome);
      // D20h：放行登记带会话身份与 ui 模式（actor＝会话 id，缺失＝unattributed——不伪造 owner）；
      // 账本 approval_id 回传返回体（解析失败省略键不阻断——stderr 记一条）
      // E5·H2：账本登记子步 env 显式传（HOME＝实例根——record 写 Path.home() 推导位
      // 的 eval-release.jsonl，落点不随继承面漂移）
      const recorded = await runCapture("python3", [genService, "--record-eval-release", "--config", args.service_config, "--service-dir", serviceDir, "--note", "atf_evaluate 确认卡放行（九必报项报告已确认）",
        "--actor", sessionIdOf(exec) ?? "unattributed", "--approval-mode", "ui", "--round-dir", roundDir], 60_000, evalChildEnvOf());
      if (recorded.code !== 0) {
        return asToolValue({ started: false, error: "eval_release_record_failed", stderr_tail: recorded.stderr.slice(-800), note: "放行登记失败——不启动编排，账本唯一真相不造假" });
      }
      let approvalEntryId: string | undefined;
      try { approvalEntryId = JSON.parse(recorded.stdout)["approval_id"]; } catch { console.error("[atf-evaluate] 放行账本 stdout 非 JSON——返回体省略 approval_entry_id（不阻断评估启动）"); }
      // ④ checkpoint staging 计划（selections 由已确认的 adapter_path 编译，非猜测）
      const ckptPlanDir = join(roundDir, "ckpt-plan");
      mkdirSync(ckptPlanDir, { recursive: true });
      const ckptPlanPath = join(ckptPlanDir, "CheckpointPlan.v1.json");
      writeFileSync(ckptPlanPath, JSON.stringify({
        schema_version: "CheckpointPlan/v1",
        run_id: runId,
        staging_root: join(roundDir, "staging"),
        selections: [{ lane: evalLane, checkpoint_dir: args.adapter_path, staged_name: `${runId}_eval` }],
      }, null, 1) + "\n", "utf8");
      const planned = await runCapture("python3", [ckptPlanGen, "--config", ckptPlanPath, "--out", ckptPlanDir], 120_000, evalChildEnvOf());
      if (planned.code !== 0) {
        return asToolValue({ started: false, error: "checkpoint_plan_failed", eval_round: roundDir, stderr_tail: planned.stderr.slice(-800) });
      }
      // ⑤ 编排件（base_url 显式取自 service manifest 端口——G11 收口：编排/runner 端口缺省分歧在产品路径不生效）
      // 批C2 E6 卡点修复②＋D114：资产绑定透传（split-manifest＝显式或 run 树发现值——walkthrough
      // 布局兼容）＋--prompt-renderer 生成期注入（内核 generate_eval_orchestration 在 --eval-runner
      // 在场时必填〔D58 生成期即拒〕——此前计划生成漏传、执行链 eval_orchestration.sh 才注入＝
      // B7 缺口⑬：编排计划生成直接失败。渲染器与执行链同值单源：pin 内 atf-admit-training-data）
      const port = Number((manifest["request_defaults"] as Record<string, unknown> | undefined)?.["port"] ?? (JSON.parse(readFileSync(args.service_config, "utf8")) as Record<string, unknown>)["port"]);
      const orchDir = join(roundDir, "orch");
      const promptRendererPath = skill("atf-admit-training-data", "render_prompt.py");
      // H-E9b：组装单点 buildEvalOrchArgs（N=1 与 N>1 同路径两形态；N=1 逐字恒等有黄金锚）
      const orchArgs = buildEvalOrchArgs({
        orchestration, serviceDir, ckptPlanDir, orchDir, runner, promptRenderer: promptRendererPath,
        port, envProfile,
        // 批D17：并发贯通编排（恒传，缺省 1——generator 内嵌进 runner 调用与 plan 口径披露；
        // 值来源＝prelaunch 确认值，容量校验由 prelaunch 承载，此处不设第二套）
        concurrency,
        // 单槽位：单值三参；多槽位：只给 --run（内核按槽位逐类派生，单值三参互斥）
        ...(multiDoc
          ? { runDir }
          : {
              assetsDir: args.eval_assets_dir,
              fieldConfig: fieldConfigPath ?? "",
              ...(splitManifestResolved !== null ? { splitManifest: splitManifestResolved.path } : {}),
              ...(args.assets_external_confirm === true ? { assetsExternalConfirm: true } : {}),
            }),
      });
      const orchPlanned = await runCapture("python3", orchArgs, 120_000, evalChildEnvOf());
      if (orchPlanned.code !== 0) {
        return asToolValue({
          started: false, error: "orchestration_plan_failed", eval_round: roundDir, stderr_tail: orchPlanned.stderr.slice(-800),
          ...(orchPlanned.stderr.includes("external_assets_confirmation_missing")
            ? { note: "评估资产绑定缺失（内核编排契约）：传 assets_split_manifest（分区清单）或 assets_external_confirm=true 后重试" }
            : {}),
        });
      }
      // ⑥ tmux 后台执行编排（服务自启→健康等待→staging→runner→回灌）；runner 附加参数经 $@ 透传
      mkdirForce(cfg.logDir);
      const { execSync } = await import("node:child_process");
      // 批㊶-ISO E1：编排会话同入命名域（launch 域——pre-kill/new-session 同目标名）；命令走 tmuxCommand
      // 批㊶-P1 S1：编排基名作用域化（run_id 入名——并发 run 各占各的编排会话）
      // D14：--prompt-mode 单源传解析值（继承训练/显式——不再硬编码 mode0；eval_orchestration.sh 经 "$@" 转发 runner）
      const orchSessionName = resolveLaunchSessionName(evalOrchSessionBase(runId));
      try { execSync(tmuxCommand(`kill-session -t ${orchSessionName} 2>/dev/null`)); } catch { /* 无旧 */ }
      // E5·H2：编排会话命令 env 前缀注入（HOME＝实例根＋ATF_APPROVAL_LEDGER 若设）——
      // 编排脚本内 ${ATF_APPROVAL_LEDGER:-${HOME}/...} 运行时解析不随 tmux 旧服务端
      // env 分轴漂移（训练链 ledgerEnvPrefixForShell 同构扩展）
      execSync(tmuxCommand(`new-session -d -s ${orchSessionName} "${evalTmuxEnvPrefixOf()}bash ${orchDir}/eval_orchestration.sh --prompt-renderer ${skill("atf-admit-training-data", "render_prompt.py")} --coordinate qwen3_vl --prompt-mode ${promptMode.mode} 2>&1 | tee -a ${cfg.logDir}/eval-orchestration.log"`));
      // 批㊶-M M-3 段事实轨：评估编排启动成功即登记（evaluate 段）
      appendSegmentFact(runDir, "evaluate", "atf_evaluate");
      // 批㊶-N N-5：会话绑定
      const sessionIdEval = sessionIdOf(exec);
      if (sessionIdEval !== undefined) appendBinding(runDir, sessionIdEval);
      // 批B1：会话账本绑定（auto_tool——显式传入与当前绑定不同时返回体带 rebound_from；fail-open）
      const rebound = bindToolRunSuccess(exec, runId, runResolution.workspace, "auto_tool", args.run_id);
      // 批㊶-TRAIN-OBS-FIX2 T1：内核侧会话绑定（评估接管成功路径——评估类一并覆盖；
      // fail-open 沿 appendBinding 语义——消费点兜底，不阻塞编排启动主流程）
      try { if (cfg.bindRun !== undefined) await cfg.bindRun(runId); } catch { /* fail-open */ }
      return asToolValue({
        started: true, eval_round: roundDir, tmux: orchSessionName,
        run_id: runId,
        serving_models: expectedModels, service_manifest: join(serviceDir, "service_manifest.json"),
        prelaunch_report: reportPath, release: "eval-release 账本已登记（config sha256）",
        // env_profile 派生来源（explicit＝显式传入；instance_default(<名>)＝实例目录唯一可用档案自动选用）
        env_profile: envProfile, env_profile_source: envProfileSource,
        ...(approvalEntryId !== undefined ? { approval_entry_id: approvalEntryId } : {}),
        // D14：评测参数继承落账（报告面——解析来源/指纹/口径；GT 外字段只在此报告面，不上卡）
        ...(fieldConfigResolved.ok ? {
          field_config: fieldConfigResolved.path,
          field_config_source: fieldConfigResolved.source,
          field_config_sha256: fieldConfigResolved.sha256,
          field_config_sha256_prefix12: fieldConfigResolved.sha256.slice(0, 12),
          ...(fieldConfigResolved.warning !== undefined ? { field_config_warning: fieldConfigResolved.warning } : {}),
          // F1.1：模板骨架核对结果（verified＝与记录一致；absent＝老 run 无记录键未比对；drift_accepted＝显式放行）
          template_sha256_source: fieldConfigResolved.template_sha256_source,
          ...(fieldConfigResolved.template_drift_accepted === true ? { template_drift_accepted: true } : {}),
        } : { field_config: null, field_config_source: "per_doc_derived" as const }),
        prompt_mode: promptMode.mode,
        prompt_mode_source: promptMode.source,
        eval_caliber: caliber,
        concurrency,
        ...(args.concurrency_reason !== undefined ? { concurrency_reason: args.concurrency_reason } : {}),
        ...rebound,
        note: "编排后台执行中（服务自启→staging→run_formal_eval→回灌，runner --model 取 manifest 期望名）——status 查询 receipt/四件套/model 标签",
      });
    },
  });

  // F6：成败记数＋用户面摘要＋会话通知投影（覆盖 execute 内全部返回出口——早退失败与成功终局同一口径）
  instrumentEvalOutcome(evaluate as unknown as { execute: (args: unknown, exec: unknown) => Promise<unknown> });

  const analyze = defineTool({
    name: "atf_analyze_badcases",
    description:
      "badcase 两步链（轻量，正道化）：①build_raw_badcase_input.py 冻结账本（评估四件套＋L1 eval 资产→RawBadcaseAnalysis/v1，落 analysis/ledger/）②run_analysis_chain.py --raw-mainline <冻结账本> 一键链→viewer.html（GT/预测叠图）与 report/。脚本一律取 <kernelDir>/skills/（pin 单源，禁源工作树绝对路径）。无训练数据/无审阅时链按合同显式声明跳过。" +
      "引用字段值（写分析、报告或向用户举例）必须与源记录逐字一致——从冻结账本/预测原文原样拷贝字符串，禁止重排版（千分位逗号、小数点、空格、全半角均不得改动）；拿不准就整段引用原文，不要凭记忆转写数值。",
    parameters: {
      run_id: { type: "string", description: "可选；省略时使用本会话当前绑定的实验。无绑定会返回 run_binding_required 与候选（含实验名与工作区），不要自行猜一个 id" },
      eval_assets_dir: { type: "string", description: "L1 EvaluationAssets/v1 目录（test_images.json+eval_labels.jsonl；缺省 runs/<run_id>/l1/eval）" },
      lane: { type: "string", description: "评估 lane（缺省从任务事实取——run 内训练数据 lane 记录；判定不了会停下来问你；显式给值可覆盖）" },
      doc_type: { type: "string", description: "单据类型名（缺省沿脚本中性缺省「单据」）" },
      style_cluster_manifest: { type: "string", description: "StyleClusterManifest 路径（实验门②产出——缺省沿 L1 产物位 runs/<run_id>/l1/style-cluster-manifest.json）" },
      coordinate_space: { type: "string", description: "预测坐标空间声明（qwen_axis_1000|original_pixel；SKILL.md 条款：无法从 ExperimentConfig 派生时必传，链侧 fail-closed 拒绝静默缺省）" },
      gt_coordinate_space: { type: "string", description: "GT 标签坐标空间声明（闭集同上；GT 与预测可分属不同空间）" },
      cluster_reviews: { type: "string", description: "图核审阅件路径（ClusterAgentReview/v1）：逐簇裁决按此件回注账本；账本同级已有审阅轮却不传，链会 fail-closed 拒绝（禁止把 coverage 标成完成）" },
      review_check: { type: "string", description: "审阅覆盖校验件路径（BadcaseReviewCheck/v1，可选；与审阅件同源）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    presentCall: function(args: { run_id?: string }) {
      return { card: "generic" as const, title: `badcase 分析 — ${args.run_id ?? "会话绑定实验"}`, kind: "other" as const }
    },
    async execute(args: { run_id?: string; eval_assets_dir?: string; lane?: string; doc_type?: string; style_cluster_manifest?: string; coordinate_space?: string; gt_coordinate_space?: string; cluster_reviews?: string; review_check?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // 批B1：run_id 缺省解析（显式＞会话绑定；无绑定＝run_binding_required＋候选）
      const runResolution = resolveToolRun(cfg.runsRoot, exec, args.run_id, canonicalRunRootsOf(cfg));
      if (!runResolution.ok) return asToolValue(runResolution.payload);
      const runId = runResolution.runId;
      const runDir = runResolution.runDir;
      // E9a·H5：多类先 fail-closed（与 atf_evaluate 同裁——一次评多类下一批落地，禁静默只评一类）
      const analyzeSlots = listDocSlots(runDir);
      const analyzeDocTypes = analyzeSlots.map((slot) => slot.doc_type);
      // H-E9b：多槽位走内核联合一键入口（run_joint_analysis.py --run）——它按槽位表枚举
      // 评估轮下全部 <单据>-<模式> 组，逐组解析输入，产出 run 级一份报告＋一个查看器
      //（单据/模式可筛选）。单槽位仍走既有两步链（freeze→chain），两者是内核的两个入口，
      // 不是 harness 侧的两套实现；选哪个人由槽位数决定（数据驱动，非路径复制）。
      if (analyzeSlots.length > 1) {
        const jointScript = join(cfg.kernelDir, "skills", "atf-analyze-badcases", "scripts", "run_joint_analysis.py");
        if (!existsSync(jointScript)) {
          return asToolValue({ ok: false, error: "skill_script_missing", script: jointScript, note: "pin 内技能脚本缺失——核 kernelDir 装配" });
        }
        const jointOut = join(runDir, "analysis");
        const jointArgs = [jointScript, "--run", runDir, "--output-dir", jointOut,
          ...(args.lane !== undefined && args.lane.trim() !== "" ? ["--lane", args.lane.trim()] : []),
          // 审阅件入口：联合链本身支持 --cluster-reviews/--review-check，此处只是把它接到工具面
          ...(args.cluster_reviews !== undefined && args.cluster_reviews.trim() !== ""
            ? ["--cluster-reviews", args.cluster_reviews.trim()] : []),
          ...(args.review_check !== undefined && args.review_check.trim() !== ""
            ? ["--review-check", args.review_check.trim()] : [])];
        const joint = await runCapture("python3", jointArgs, 600_000, evalChildEnvOf());
        if (joint.code !== 0) {
          return asToolValue({
            ok: false, step: "joint_analysis", exit_code: joint.code, analysis_dir: jointOut,
            stderr_tail: joint.stderr.slice(-800),
            doc_types: analyzeDocTypes,
            note: "逐类分析失败（run_joint_analysis 非零退出）——按 stderr 修正后重试；输入缺失时内核以 joint_slot_labels_missing 列出候选路径",
          });
        }
        return asToolValue({
          ok: true, mode: "multi_doc", doc_types: analyzeDocTypes,
          analysis_dir: jointOut, report: join(jointOut, "report.md"), viewer: join(jointOut, "viewer.html"),
          // 联合链内部委托单链，stdout 同样带 review_coverage/incomplete——多单据回执也须透传
          ...reviewCoverageOf(joint.stdout),
          note: `逐类分析完成（${analyzeDocTypes.join("、")}）：一份报告＋一个查看器，按单据/模式可筛选`,
        });
      }
      // pin 单源脚本面（批㉕B 段1：禁 ATF 源工作树绝对路径）
      const freezeScript = join(cfg.kernelDir, "skills", "atf-evaluate-checkpoints", "scripts", "build_raw_badcase_input.py");
      const chainScript = join(cfg.kernelDir, "skills", "atf-analyze-badcases", "scripts", "run_analysis_chain.py");
      for (const script of [freezeScript, chainScript]) {
        if (!existsSync(script)) {
          return asToolValue({ ok: false, error: "skill_script_missing", script, note: "pin 内技能脚本缺失——核 kernelDir 装配" });
        }
      }
      const evalDir = join(runDir, "eval");
      const assetsDir = args.eval_assets_dir ?? join(runDir, "l1", "eval");
      const labelsPath = join(assetsDir, "eval_labels.jsonl");
      if (!existsSync(join(evalDir, "badcases.jsonl")) || !existsSync(join(evalDir, "raw_predictions.jsonl"))) {
        return asToolValue({ ok: false, error: "eval_products_missing", eval_dir: evalDir, note: "评估四件套不齐（badcases+raw_predictions 必备）——先完成评估再分析" });
      }
      if (!existsSync(labelsPath)) {
        return asToolValue({ ok: false, error: "eval_assets_missing", eval_assets_dir: assetsDir, note: "eval_labels.jsonl 缺失——传 eval_assets_dir 指向 L1 EvaluationAssets/v1 目录" });
      }
      // D91：lane 判定 fail-closed（显式 ＞ 任务事实恰一 lane——禁缺省 goods；判定不了
      // 返回 eval_lane_unresolved＋业务文案，不猜 lane 进冻结账本）
      const laneResolved = resolveEvalLaneFrom(runDir, args.lane);
      if (!laneResolved.ok) {
        return asToolValue({
          ok: false, error: "eval_lane_unresolved",
          ...(laneResolved.lanesSeen !== undefined ? { lanes_seen: laneResolved.lanesSeen } : {}),
          ...(laneResolved.conflict !== undefined ? { lanes_conflict: laneResolved.conflict } : {}),
          note: EVAL_LANE_UNRESOLVED_NOTE_OF(laneResolved.lanesSeen),
        });
      }
      const lane = laneResolved.lane;
      // 图片根确定性解析（eval_labels 的 image 相对路径基准）：优先 assets 上级，退 assets 本身；都不中即结构化报缺
      const imagesDir = resolveImagesRoot(assetsDir);
      if (imagesDir === null) {
        return asToolValue({ ok: false, error: "images_root_unresolved", eval_assets_dir: assetsDir, note: "eval_labels 首行 image 路径在 assets 上级与本目录下都不存在——核资产布局" });
      }
      // ① 冻结账本（build_raw_badcase_input.py——SKILL.md 执行流程步 1）
      const ledgerDir = join(runDir, "analysis", "ledger");
      const freezeArgs = [freezeScript, "--eval-dir", evalDir, "--assets", assetsDir, "--lane", lane, "--out-dir", ledgerDir];
      if (args.doc_type !== undefined) freezeArgs.push("--doc-type", args.doc_type);
      const frozen = await runCapture("python3", freezeArgs, 120_000);
      const ledgerPath = join(ledgerDir, "raw-badcase-analysis.v1.json");
      if (frozen.code !== 0 || !existsSync(ledgerPath)) {
        return asToolValue({ ok: false, step: "freeze", exit_code: frozen.code, ledger: ledgerPath, stderr_tail: frozen.stderr.slice(-800), note: "冻结账本失败（build_raw_badcase_input 非零退出或未产出）——不进一键链" });
      }
      // ② 一键链（run_analysis_chain.py——--raw-mainline 必填补齐；产物布局 <out>/report＋<out>/viewer）
      const chainArgs = [
        chainScript, "--run", runDir, "--raw-mainline", ledgerPath,
        "--labels", labelsPath, "--images-dir", imagesDir,
        "--output-dir", join(runDir, "analysis"),
      ];
      const manifest = args.style_cluster_manifest ?? join(runDir, "l1", "style-cluster-manifest.json");
      if (existsSync(manifest)) chainArgs.push("--style-cluster-manifest", manifest);
      // 坐标声明透传（不设缺省——缺失时链侧按 SKILL.md fail-closed 拒绝静默取默认值）
      if (args.coordinate_space !== undefined) chainArgs.push("--coordinate-space", args.coordinate_space);
      if (args.gt_coordinate_space !== undefined) chainArgs.push("--gt-coordinate-space", args.gt_coordinate_space);
      // 审阅件透传（链内据此回注账本并更新覆盖账；缺它则回注/决策步显式跳过）
      if (args.cluster_reviews !== undefined && args.cluster_reviews.trim() !== "") {
        chainArgs.push("--cluster-reviews", args.cluster_reviews.trim());
      }
      if (args.review_check !== undefined && args.review_check.trim() !== "") {
        chainArgs.push("--review-check", args.review_check.trim());
      }
      const chained = await runCapture("python3", chainArgs, 300_000);
      const viewerPath = join(runDir, "analysis", "viewer", "viewer.html");
      const reportMd = join(runDir, "analysis", "report", "report.md");
      const reportHtml = join(runDir, "analysis", "report", "report.html");
      if (chained.code !== 0) {
        return asToolValue({ ok: false, step: "chain", exit_code: chained.code, ledger: ledgerPath, stderr_tail: chained.stderr.slice(-800), note: "一键链失败——冻结账本已落 ledger/ 可续查" });
      }
      // 批B1：会话账本绑定（auto_tool——成功动作才绑定，显式传入与绑定不同带 rebound_from）
      const rebound = bindToolRunSuccess(exec, runId, runResolution.workspace, "auto_tool", args.run_id);
      return asToolValue({
        ok: true,
        run_id: runId,
        ledger: ledgerPath,
        viewer_html: viewerPath,
        report_md: reportMd,
        report_html: reportHtml,
        viewer_ready: existsSync(viewerPath),
        report_ready: existsSync(reportMd),
        // F7(2026-10-28)：回执必须给**可点开的 URL**，不能只给磁盘路径。
        // 现场教训：产物路径给到用户后，用户拿去本地打开，html 与 images/ 不同层
        // 导致整页图裂——用户以为"viewer 坏了"，其实是打开方式不对。
        // 首选 viewer 走 /atf-ui/viewer/<runId>/（路由自己发现现役 viewer 清单）。
        // F8：审阅覆盖透传（内核 stdout 顶层 review_coverage/incomplete；解析不到＝null＋
        // incomplete_reason=chain_output_missing——覆盖度未知时不假装已审阅完整）
        ...reviewCoverageOf(chained.stdout),
        ...(existsSync(viewerPath)
          ? {
              viewer_url: `/atf-ui/viewer/${encodeURIComponent(runId)}/`,
              viewer_url_note: "在已登录的 dsh web 会话里直接打开（浏览器已登录即可）；不要取磁盘路径在本地打开，否则相对图片路径会裂",
            }
          : {}),
        ...rebound,
      });
    },
  });

  return [evaluate, analyze];
}

/** eval_labels 首行 image 相对路径的根目录确定性解析：assets 上级优先，assets 本身次之，未中返回 null。 */
export function resolveImagesRoot(assetsDir: string): string | null {
  try {
    const first = readFileSync(join(assetsDir, "eval_labels.jsonl"), "utf8").split("\n").find((l) => l.trim() !== "");
    if (first === undefined) return null;
    const image = (JSON.parse(first) as Record<string, unknown>)["image"];
    if (typeof image !== "string" || image === "") return null;
    for (const root of [join(assetsDir, ".."), assetsDir]) {
      if (existsSync(join(root, image))) return root;
    }
    return null;
  } catch {
    return null;
  }
}
