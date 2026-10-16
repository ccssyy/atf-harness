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
 */
import { spawn, execFile, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as net from "node:net";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildMonitorSnapshot, formatTaskCard } from "../../atf-ui/src/snapshot.js";
import { scanRunDir } from "../../atf-ui/src/server.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { isAutoTrainingTier } from "./autoTrainingTier.js";
import { asToolValue } from "./schemaTranslate.js";
import { startLossIngest } from "../../../../src/core/workspace/lossIngest.js";
import { probeSession, resolveLaunchSessionName, tmuxCommand, tmuxTrainingEvidenceFor, evalOrchSessionBase, trainingSessionBase, type SessionProbe } from "../../../../src/core/workspace/tmuxLiveness.js";
import { awaitGpuWindow, gpuQueuePollMsFromEnv, queueHitText, TRAINING_RESIDUE_PATTERN } from "./gpuQueueFace.js";
import { reconcileConfirmedWithTrainSh, formatReconcileDiff } from "./trainShReconcile.js";
import { editsFromFormAnswers, type FormAskService } from "./confirmFace.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { appendBinding, writeProgress } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";
import { appendLedgerAuditComment, ledgerEnvPrefixForShell } from "../../../../src/core/workspace/approvalLedger.js";
import { dualStageNote } from "./confirmFace.js";
import { deriveAtfRoot } from "../../../../src/webui/storageSettings.js";

/** 发布库位缺省派生（统一根 models 子目录——env-only 零字面量；未派生＝null）。 */
export const derivePublishRoot = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const root = deriveAtfRoot(env);
  return root === null ? null : join(root, "models");
};
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";

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

/** 批㊶-P1 S3：同 run_id 双启请示闸（防御纵深）——作用域会话在场＝同 run 已有训练会话，
 *  经请示卡（DSH user-questions——ask_user_for_input 通道）问用户是否清旧重启；确认词
 *  恰为 `yes` 才放行，取消（ASK_CANCELLED）/其他应答/服务缺失一律拒绝（fail-closed——
 *  不静默双启不静默清场）。审批≠请示：danger 卡已过≠同意丢旧现场，重启须显式二次确认。 */
export const confirmDoubleLaunch = async (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; callId?: string; signal?: unknown },
  runId: string,
  sessionName: string,
): Promise<{ ok: true } | { ok: false; outcome: string; note: string }> => {
  const userQuestions = ctx.get("userQuestions") as FormAskService | undefined;
  if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
    return { ok: false, outcome: "user_questions_unavailable", note: "同 run_id 训练会话已在场且请示通道（user-questions）未挂载——fail-closed 不启动：不静默双启，也不静默清理在跑会话；请先人工核会话现场（tmux 侧）再重推" };
  }
  try {
    const answers = await userQuestions.ask({
      questions: [{
        id: `double-launch-${runId}`,
        question: `训练会话已存在（run ${runId}）——是否清理旧会话并重启？`,
        header: "双启确认",
        detail: `同 run_id 的训练会话 ${sessionName} 已在场（重复触发场景）。清理重启＝终止旧会话内进程（现场日志已落盘可追溯）；取消＝本次启动不动旧会话。proceed 填 yes 才重启；留空/no/其他＝取消。`,
        intent: {
          kind: "form",
          fields: [{ key: "proceed", label: "proceed（是否清理重启）", value: "no", hint: "仅接受 yes；no/留空＝取消本次启动" }],
          submitLabel: "提交",
        },
      }],
      agent: exec.agent,
      signal: exec.signal,
    });
    const proceed = editsFromFormAnswers(answers)["proceed"]?.trim().toLowerCase() === "yes";
    return proceed
      ? { ok: true }
      : { ok: false, outcome: "declined", note: `双启请示未确认（proceed≠yes）——本次不启动，旧会话原样保留（run ${runId}）` };
  } catch (cause) {
    if ((cause as { code?: string }).code === "ASK_CANCELLED") {
      return { ok: false, outcome: "cancelled", note: `双启请示卡被关闭（取消）——本次不启动，旧会话原样保留（run ${runId}）` };
    }
    return { ok: false, outcome: "ask_failed", note: `双启请示卡应答失败：${String(cause).slice(0, 200)}——fail-closed 不启动` };
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
  eval_assets_dir: string | null;
  field_config: string | null;
  split_manifest: string | null;
  four_set_ready: boolean;
  badcases_ready: boolean;
}

export const collectEvalReadiness = (runDir: string): EvalReadiness => {
  const has = (rel: string): boolean => existsSync(join(runDir, rel));
  const trainingDir = join(runDir, "training");
  let ckpts: string[] = [];
  try {
    ckpts = existsSync(trainingDir)
      ? readdirSync(trainingDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^checkpoint-\d+$/.test(d.name) && existsSync(join(trainingDir, d.name, "adapter_model.safetensors"))).map((d) => d.name).sort()
      : [];
  } catch { /* 缺目录＝空候选 */ }
  let evalAssets: string | null = null;
  for (const cand of [join(runDir, "l1", "eval"), join(runDir, "eval_assets")]) {
    if (existsSync(join(cand, "test_images.json")) && existsSync(join(cand, "eval_labels.jsonl"))) { evalAssets = cand; break; }
  }
  let fieldConfig: string | null = null;
  for (const cand of [join(runDir, "l1", "field_config.json"), join(runDir, "prep", "field_config.json")]) {
    if (existsSync(cand)) { fieldConfig = cand; break; }
  }
  let splitManifest: string | null = null;
  for (const cand of [join(runDir, "l1", "split-manifest.json"), join(runDir, "split", "split-manifest.json")]) {
    if (existsSync(cand)) { splitManifest = cand; break; }
  }
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

const runCapture = (cmd: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const raw = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({ code: typeof raw === "number" ? raw : null, stdout: String(stdout), stderr: String(stderr) });
    });
  });

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
      run_id: { type: "string", required: true, description: "run 标识（监控数据/ckpt 归属）" },
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
      const runDir = resolveRunDir(cfg.runsRoot, args.run_id);
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
        const readiness = collectEvalReadiness(resolveRunDir(cfg.runsRoot, args.run_id));
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
      const startRunDir = resolveRunDir(cfg.runsRoot, args.run_id);
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
      // 批㊶-Q 段2：全自动训练档（会话档位=auto_training）——九要素确认卡与 GPU 琥珀卡
      // （下方 amber 段）维持通报化/免再确认。批㊶Q增补一（owner 裁定 1 乙）：danger 卡
      // 恢复任何档位阻塞——真实 GPU 训练启动确认永远保留人工审批（真实 GPU 代价操作一次
      // 人工确认，产品纪律）；ADR-07 内核侧账本闸门不变（train.sh 内放行记录校验原样保留，
      // 无记录 exit 78）。手动档审批链零变化。
      const autoTierStart = isAutoTrainingTier(ctx, exec);
      const verdict = await requestApproval(ctx, exec, "atf_run_training", `真实 GPU 训练启动确认（GPU/时长代价以九要素确认卡与 train.sh 为准）：train.sh=${args.train_sh}${conflictNote}`);
      if (!verdict.ok) return approvalDeniedResult("atf_run_training", verdict.outcome);
      // 批㊶-W F7：九要素确认值 → train.sh 生成面逐键透传对账（start 面即拒——awb_r1
      // 首跑 nproc 确认 8 生成 1 被静默丢弃的回归锚）。对账基线＝config-snapshot.confirmed
      // ＞iteration-config training 段；两处皆缺＝无对账对象（存量 run 重跑兼容——账本
      // 闸门仍在 train.sh 内），跳过对账并在结果如实标注 reconcile: "skipped_no_baseline"。
      const confirmedBaseline: Record<string, string> | null = (() => {
        const snapDir = resolveRunDir(cfg.runsRoot, args.run_id);
        const snapPath = join(snapDir, "webui", "config-snapshot.json");
        try {
          if (existsSync(snapPath)) {
            const parsed = JSON.parse(readFileSync(snapPath, "utf8")) as { confirmed?: Record<string, string> };
            if (parsed.confirmed !== undefined && parsed.confirmed !== null) return parsed.confirmed;
          }
        } catch { /* 降级 iteration-config */ }
        for (const candidate of [join(snapDir, "prep", "iteration-config.json"), join(snapDir, "prep", "iteration-config", "iteration-config.json")]) {
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
          const amber = await requestApproval(ctx, exec, "atf_run_training", `${queueHitText(windowState.snapshot.gpuIndexes, windowState.snapshot.table)}（已等待 ${windowState.snapshot.waitedText}）——GPU 窗口命中，确认启动训练（train.sh=${args.train_sh}）`);
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
        const gate = await confirmDoubleLaunch(ctx, exec, args.run_id, sessionName);
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
      execSync(tmuxCommand(`new-session -d -s ${sessionName} "${ledgerPrefix}bash ${args.train_sh} 2>&1 | tee -a ${logPath}"`));
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
        return asToolValue({
          started: false,
          error: "startup_failed",
          reason: probe.reason ?? "终止特征",
          exit_code: probe.exitCode ?? null,
          run_id: args.run_id,
          train_sh: args.train_sh,
          log_tail: probe.tail.slice(-800),
          note: probe.exitCode === 78
            ? "启动探活：放行记录闸失败（exit 78——账本无本 config 的放行记录）——先经 --record-training-release 登记（或核 ATF_APPROVAL_LEDGER 双轴）后重推"
            : "启动探活发现终止特征——训练未启动成功；按 log_tail 摘要处理后重推",
        });
      }
      startLossIngest(logPath, join(runDir, "training", "loss-series.json"));
      // 批㊶-M M-3 段事实轨：训练启动确认后登记（training 段——探活 dead 不登记）
      appendSegmentFact(runDir, "training", "atf_run_training");
      // 批㊶-N N-5：会话绑定
      const sessionIdStart = sessionIdOf(exec);
      if (sessionIdStart !== undefined) appendBinding(runDir, sessionIdStart);
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
        ...(autoTierStart ? { auto: true, tier: "auto_training" } : {}),
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
  const candidates = [join(runDir, "prep", "iteration-config.json"), join(runDir, "prep", "iteration-config", "iteration-config.json")];
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
  if (iter === null || configPath === null) return fail(null, "iteration_config_missing", "缺席（prep/iteration-config 两候选路径均无）——先走确认卡落快照回写链");
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

/** 评估编号轮目录（ADR-0007 决定 2：N＝轮内第几次评估动作，复评递增）。 */
export function deriveEvalRoundDir(runDir: string): string {
  const evalRoot = join(runDir, "eval");
  let maxN = 0;
  try {
    for (const entry of readdirSync(evalRoot, { withFileTypes: true })) {
      const m = /^(\d+)-\d{8}$/.exec(entry.name);
      if (entry.isDirectory() && m !== null) maxN = Math.max(maxN, Number(m[1]));
    }
  } catch { /* eval 根不存在＝首轮 */ }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(evalRoot, `${maxN + 1}-${date}`);
}

interface EvalStatusValue {
  action: string;
  run_id: string;
  eval_round?: string;
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

/** atf_evaluate status：最新评估轮的服务 receipt/编排状态/四件套与 model 标签复核。 */
export async function evalStatus(runId: string, cfg: { runsRoot: string; kernelDir: string }): Promise<ReturnType<typeof asToolValue>> {
  const evalRoot = join(resolveRunDir(cfg.runsRoot, runId), "eval");
  let latest: string | null = null;
  try {
    const rounds = readdirSync(evalRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-\d{8}$/.test(e.name)).map((e) => e.name).sort();
    latest = rounds.length > 0 ? join(evalRoot, rounds[rounds.length - 1] ?? "") : null;
  } catch { /* 无评估轮 */ }
  const { execSync } = await import("node:child_process");
  // 批㊶-ISO E1：探测走命名域单源（前缀未设＝false fail-closed；refused 随 payload 回流）
  // 批㊶-P1 S1：编排基名作用域化——按 run_id 取名（同实例并发 run 评估编排互不踩）
  const orchBase = evalOrchSessionBase(runId);
  const orchProbe = probeSession(orchBase);
  let running = orchProbe.present;
  if (latest === null) {
    return asToolValue({
      action: "status", run_id: runId, running,
      tmux: resolveLaunchSessionName(orchBase),
      ...(orchProbe.refused !== null ? { tmux_probe: orchProbe.refused } : {}),
      note: "无评估轮目录——先 start",
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
  const runDirEval = resolveRunDir(cfg.runsRoot, runId);
  const readiness = collectEvalReadiness(runDirEval);
  const value: EvalStatusValue = {
    action: "status", run_id: runId, eval_round: latest, running,
    tmux: resolveLaunchSessionName(orchBase),
    ...(orchProbe.refused !== null ? { tmux_probe: orchProbe.refused } : {}),
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
    },
  });
}


/** 批㊶-S1 段 3：模型产物发布（语义 C＝归档＋登记＋并入模型清单；U 双段式确认卡）。 */
export function buildPublishModelTool(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; modelRoot?: string }): unknown {
  return defineTool({
    name: "atf_publish_model",
    description:
      "模型产物发布（语义 C：归档＋登记＋并入模型清单）：对评估完成的 checkpoint 收口——四件套齐即可发布（指标门槛不硬编码，发布与否由用户在确认卡定）；发布动作＝确定性归档复制（SHA256 清单）到 <发布库位>/<run_id>/<ckpt>/＋manifest＋发布报告。确认卡＝U 双段式（dualStageNote），danger 级 Allow once 落审批账本。已发布模型并入模型清单状态面（训练确认卡基模型可选历史发布作 base——迁移学习；ATF_MODEL_ROOT＋发布库位两源合并、来源标注区分）。发布前置缺四件套即拒（不猜测）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识" },
      checkpoint: { type: "string", required: true, description: "checkpoint 目录名（checkpoint-<数字>；拒 latest/符号链接）" },
      publish_root: { type: "string", description: "发布库位根（缺省＝统一根 models 子目录——ATF_ATF_ROOT/ATF_DSH_RUNS_ROOT 父目录派生；实例分桶自动）" },
      note: { type: "string", description: "发布说明（入发布报告）" },
    },
    output: { schema: { type: "object", additionalProperties: true }, render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }] },
    presentCall: function(args: { run_id: string; checkpoint?: string }) {
      return { card: "generic" as const, title: `模型发布 — ${args.run_id}${args.checkpoint !== undefined ? `/${args.checkpoint}` : ""}`, kind: "other" as const };
    },
    async execute(args: { run_id: string; checkpoint: string; publish_root?: string; note?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const runDir = resolveRunDir(cfg.runsRoot, args.run_id);
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
      const destDir = join(publishRoot, args.run_id, args.checkpoint);
      // U 双段式确认卡（danger 级 Allow once 落审批账本）
      const verdict = await requestApproval(ctx, exec, "atf_publish_model",
        dualStageNote(`模型发布确认 — ${args.run_id}/${args.checkpoint}`, {
          extra: `发布动作：归档复制 ${ckptDir} → ${destDir}（SHA256 清单）＋manifest＋发布报告${args.note !== undefined ? `｜说明：${args.note}` : ""}。如需改参（publish_root/checkpoint），直接回复；确认请 Allow once（danger 级）。`,
        }));
      if (!verdict.ok) return approvalDeniedResult("atf_publish_model", verdict.outcome);
      // 确定性归档复制（SHA256 清单）——零内核触碰（node fs 实现）
      const { mkdirSync, readdirSync: rd, copyFileSync } = await import("node:fs");
      mkdirSync(destDir, { recursive: true });
      const shaOf = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
      const files: Array<{ file: string; sha256: string; bytes: number }> = [];
      const walk = (dir: string, relBase: string): void => {
        for (const entry of rd(dir, { withFileTypes: true })) {
          const src = join(dir, entry.name);
          const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
          if (entry.isDirectory()) walk(src, rel);
          else { copyFileSync(src, join(destDir, rel)); files.push({ file: rel, sha256: shaOf(src), bytes: statSync(src).size }); }
        }
      };
      walk(ckptDir, "");
      const manifest = {
        schema_version: "ModelPublish/v1",
        run_id: args.run_id,
        checkpoint: args.checkpoint,
        published_at: new Date().toISOString(),
        source_dir: ckptDir,
        dest_dir: destDir,
        files: files.sort((a, b) => a.file.localeCompare(b.file)),
        ...(args.note !== undefined ? { note: args.note } : {}),
      };
      writeFileSync(join(destDir, "publish-manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`, "utf8");
      const report = [
        `# 模型发布报告 — ${args.run_id}/${args.checkpoint}`,
        "",
        `- 发布时间：${manifest.published_at}`,
        `- 源：${ckptDir}`,
        `- 归档：${destDir}`,
        `- 文件数：${files.length}（SHA256 清单见 publish-manifest.json）`,
        ...(args.note !== undefined ? [`- 说明：${args.note}`] : []),
      ].join("\n");
      mkdirSync(join(runDir, "publish"), { recursive: true });
      writeFileSync(join(runDir, "publish", `${args.checkpoint}.md`), `${report}\n`, "utf8");
      return asToolValue({
        ok: true,
        run_id: args.run_id,
        checkpoint: args.checkpoint,
        dest_dir: destDir,
        file_count: files.length,
        manifest: "publish-manifest.json",
        report: `publish/${args.checkpoint}.md`,
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

export const summarizeEvalPrelaunchReport = (reportText: string): EvalReportSummary => {
  const lines = reportText.split("\n");
  const headline = (lines.find((l) => l.startsWith("# ")) ?? "推理服务接入确认报告").replace(/^#\s+/, "");
  // metrics：生效服务参数表的键值行（| 参数 | 值 | 来源 | 表——取关键键，值原样不截断）
  const metricKeys = ["eval_env", "绑卡", "端口/TP", "adapters", "max_model_len", "request_defaults", "环境来源"];
  const metrics: string[] = [];
  let inParams = false;
  for (const line of lines) {
    if (line.startsWith("## ")) { inParams = line.includes("生效服务参数"); continue; }
    if (!inParams || !line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2) continue;
    const key = cells[0] ?? "";
    if (key === "") continue;
    const hit = metricKeys.find((k) => key.startsWith(k));
    if (hit !== undefined) metrics.push(`${key}＝${cells[1] ?? ""}`);
  }
  return { headline, metrics };
};

/** atf_evaluate / atf_analyze_badcases 构造（评估与两步链——start/status 与轻量直跑）。 */
export function buildEvalTools(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; logDir: string; kernelDir: string; bindRun?: (runId: string) => Promise<void> }): unknown[] {
  const evaluate = defineTool({
    name: "atf_evaluate",
    description:
      "评估触发（正道链——确认制＋EVAL_RELEASE 审批账本，绕行 llamafactory api 形态已删除）：action=start 编排 pin 内正道链 generate_eval_service（vllm serve＋AWQ base）→build_service_prelaunch_report（九必报项确认报告）→用户确认（确认卡＝EVAL_RELEASE 放行，--record-eval-release 落账本）→generate_eval_orchestration（tmux 后台：服务自启→staging→run_formal_eval→回灌）；action=status 查询服务 receipt/编排状态/四件套与 model 标签。双段式：确认卡前先以问题卡呈九必报项值清单＋改参指引（可调＝adapter_path/eval_assets_dir/service_config 各项；改参回复聊天，重推 start 重走链）；机器事实三件（eval_env/awq_base/cuda_visible_devices）一律来自 deploy/env-profile，缺即 MissingFactsBlock 停下问用户。评估轮目录＝runs/<run_id>/eval/<N>-<日期>/{service,ckpt-plan,orch}（ADR-0007）。",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "status"], description: "start=确认并启动正道链（后台编排）；status=查询进度与四件套" },
      run_id: { type: "string", required: true, description: "run 标识" },
      adapter_path: { type: "string", required: true, description: "adapter checkpoint 目录绝对路径——固定编号（checkpoint-<数字>），拒 latest/符号链接/缺省猜测（SKILL.md 环节④条款）" },
      eval_assets_dir: { type: "string", required: true, description: "L1 EvaluationAssets/v1 目录（test_images.json+eval_labels.jsonl）" },
      field_config: { type: "string", required: true, description: "PromptFieldConfig/v1 JSON 路径（评估 prompt 与训练同渲染器）" },
      service_config: { type: "string", required: true, description: "EvalServiceConfig/v1 JSON 路径（按 SKILL.md 作者声明：port/TP/gpu_memory_utilization/max_model_len/mm 像素对/adapters 挂载表——adapters[].path 即本次 staging 的 adapter 源）" },
      env_profile: { type: "string", required: true, description: "环境档案名（评估环境配置层——确认报告九必报项⑤端口/连接的数据源）" },
      deploy: { type: "string", description: "可选 deploy.local.yaml 路径（显式机器事实，优先于环境档案）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    presentCall: function(args: { action: string; run_id: string }) {
      return { card: "generic" as const, title: `评估 — ${args.run_id}`, kind: "other" as const }
    },
    async execute(args: { action: string; run_id: string; adapter_path: string; eval_assets_dir: string; field_config: string; service_config: string; env_profile: string; deploy?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const skill = (name: string, script: string): string => join(cfg.kernelDir, "skills", name, "scripts", script);
      const genService = skill("atf-evaluate-checkpoints", "generate_eval_service.py");
      const prelaunch = skill("atf-evaluate-checkpoints", "build_service_prelaunch_report.py");
      const ckptPlanGen = skill("atf-evaluate-checkpoints", "generate_checkpoint_plan.py");
      const orchestration = skill("atf-evaluate-checkpoints", "generate_eval_orchestration.py");
      const runner = skill("atf-evaluate-checkpoints", "run_formal_eval.py");
      if (args.action === "status") return evalStatus(args.run_id, cfg);
      for (const script of [genService, prelaunch, ckptPlanGen, orchestration, runner]) {
        if (!existsSync(script)) return asToolValue({ started: false, error: "skill_script_missing", script, note: "pin 内技能脚本缺失——核 kernelDir 装配" });
      }
      // —— start：固定编号 adapter 校验 → 生成服务件 → 确认报告 → EVAL_RELEASE 确认卡 → 账本登记 → 编排（tmux 后台） ——
      const adapterCheck = validateFixedCheckpoint(args.adapter_path);
      if (!adapterCheck.ok) return asToolValue({ started: false, error: adapterCheck.reason, adapter_path: args.adapter_path, note: "SKILL.md 环节④：固定编号显式声明——latest/符号链接/最大编号推断一律拒绝" });
      // 批㊶Q增补三 段3：双形态解析（新 run 按发起会话工作区入桶——创建形态带归属）
      const runDir = resolveRunDir(cfg.runsRoot, args.run_id, { workspace: sessionWorkspaceSlug(exec) });
      if (!existsSync(args.service_config)) return asToolValue({ started: false, error: "service_config_missing", path: args.service_config });
      if (!existsSync(join(args.eval_assets_dir, "eval_labels.jsonl")) || !existsSync(join(args.eval_assets_dir, "test_images.json"))) {
        return asToolValue({ started: false, error: "eval_assets_missing", eval_assets_dir: args.eval_assets_dir, note: "test_images.json+eval_labels.jsonl 必备" });
      }
      const roundDir = deriveEvalRoundDir(runDir);
      const serviceDir = join(roundDir, "service");
      const deployArgs = args.deploy !== undefined ? ["--deploy", args.deploy] : [];
      // ① 生成服务件（机器事实 fail-closed 在脚本内：exit 2＝MissingFactsBlock——停下问用户，不进确认卡）
      const generated = await runCapture("python3", [genService, "--config", args.service_config, "--env-profile", args.env_profile, ...deployArgs, "--out", serviceDir], 120_000);
      const blockPath = join(serviceDir, "machine-facts-block.json");
      if (generated.code !== 0) {
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
      const reportPath = join(serviceDir, "service-prelaunch-report.md");
      const reported = await runCapture("python3", [prelaunch, "--service-dir", serviceDir, "--env-profile", args.env_profile, "--out", reportPath,
        "--field-config", args.field_config, "--prompt-renderer", skill("atf-admit-training-data", "render_prompt.py")], 120_000);
      if (reported.code !== 0 || !existsSync(reportPath)) {
        return asToolValue({ started: false, error: "prelaunch_report_failed", eval_round: roundDir, stderr_tail: reported.stderr.slice(-800), note: "确认报告未产出＝EVAL_RELEASE 准入未闭合（SKILL.md 确认制）" });
      }
      // ③ EVAL_RELEASE 确认卡：卡面摘要化（批㊶-EVALCARD，owner 裁 A 案——确认制语义
      // 不弱化：九必报项全文落盘可达（路径行），卡面只上 headline/metrics 摘要），
      // Allow once＝确认并落放行账本
      const reportText = readFileSync(reportPath, "utf8");
      const summary = summarizeEvalPrelaunchReport(reportText);
      // 批㊶-U §五：评估卡接双段式 helper（EVAL_RELEASE 账本语义不动——问题卡收改参，
      // 审批卡落账本；可调参数＝adapter 编号/评估集绑定/service_config 各项，改参经聊天回复）
      const verdict = await requestApproval(ctx, exec, "atf_evaluate",
        dualStageNote("评估服务 EVAL_RELEASE 确认（放行＝审批账本登记 config sha256，编排按其过闸）", {
          extra: [
            `确认摘要：${summary.headline}`,
            ...summary.metrics,
            `完整报告：${reportPath}`,
            "可调参数：adapter_path／eval_assets_dir／service_config 各项——如需改参，直接回复要改的项（如 adapter_path=<新路径>）；不改直接回复「按现值确认」",
          ].join("\n"),
        }));
      if (!verdict.ok) return approvalDeniedResult("atf_evaluate", verdict.outcome);
      const recorded = await runCapture("python3", [genService, "--record-eval-release", "--config", args.service_config, "--service-dir", serviceDir, "--note", "atf_evaluate 确认卡放行（九必报项报告已确认）"], 60_000);
      if (recorded.code !== 0) {
        return asToolValue({ started: false, error: "eval_release_record_failed", stderr_tail: recorded.stderr.slice(-800), note: "放行登记失败——不启动编排，账本唯一真相不造假" });
      }
      // ④ checkpoint staging 计划（selections 由已确认的 adapter_path 编译，非猜测）
      const ckptPlanDir = join(roundDir, "ckpt-plan");
      mkdirSync(ckptPlanDir, { recursive: true });
      const ckptPlanPath = join(ckptPlanDir, "CheckpointPlan.v1.json");
      writeFileSync(ckptPlanPath, JSON.stringify({
        schema_version: "CheckpointPlan/v1",
        run_id: args.run_id,
        staging_root: join(roundDir, "staging"),
        selections: [{ lane: "goods", checkpoint_dir: args.adapter_path, staged_name: `${args.run_id}_eval` }],
      }, null, 1) + "\n", "utf8");
      const planned = await runCapture("python3", [ckptPlanGen, "--config", ckptPlanPath, "--out", ckptPlanDir], 120_000);
      if (planned.code !== 0) {
        return asToolValue({ started: false, error: "checkpoint_plan_failed", eval_round: roundDir, stderr_tail: planned.stderr.slice(-800) });
      }
      // ⑤ 编排件（base_url 显式取自 service manifest 端口——G11 收口：编排/runner 端口缺省分歧在产品路径不生效）
      const port = Number((manifest["request_defaults"] as Record<string, unknown> | undefined)?.["port"] ?? (JSON.parse(readFileSync(args.service_config, "utf8")) as Record<string, unknown>)["port"]);
      const orchDir = join(roundDir, "orch");
      const orchArgs = [orchestration, "--service", serviceDir, "--ckpt", ckptPlanDir, "--out", orchDir,
        "--eval-runner", runner, "--assets", args.eval_assets_dir, "--field-config", args.field_config,
        "--base-url", `http://127.0.0.1:${port}/v1`, "--env-profile", args.env_profile];
      const orchPlanned = await runCapture("python3", orchArgs, 120_000);
      if (orchPlanned.code !== 0) {
        return asToolValue({ started: false, error: "orchestration_plan_failed", eval_round: roundDir, stderr_tail: orchPlanned.stderr.slice(-800) });
      }
      // ⑥ tmux 后台执行编排（服务自启→健康等待→staging→runner→回灌）；runner 附加参数经 $@ 透传
      mkdirForce(cfg.logDir);
      const { execSync } = await import("node:child_process");
      // 批㊶-ISO E1：编排会话同入命名域（launch 域——pre-kill/new-session 同目标名）；命令走 tmuxCommand
      // 批㊶-P1 S1：编排基名作用域化（run_id 入名——并发 run 各占各的编排会话）
      const orchSessionName = resolveLaunchSessionName(evalOrchSessionBase(args.run_id));
      try { execSync(tmuxCommand(`kill-session -t ${orchSessionName} 2>/dev/null`)); } catch { /* 无旧 */ }
      execSync(tmuxCommand(`new-session -d -s ${orchSessionName} "bash ${orchDir}/eval_orchestration.sh --prompt-renderer ${skill("atf-admit-training-data", "render_prompt.py")} --coordinate qwen3_vl --prompt-mode mode0 2>&1 | tee -a ${cfg.logDir}/eval-orchestration.log"`));
      // 批㊶-M M-3 段事实轨：评估编排启动成功即登记（evaluate 段）
      appendSegmentFact(runDir, "evaluate", "atf_evaluate");
      // 批㊶-N N-5：会话绑定
      const sessionIdEval = sessionIdOf(exec);
      if (sessionIdEval !== undefined) appendBinding(runDir, sessionIdEval);
      // 批㊶-TRAIN-OBS-FIX2 T1：内核侧会话绑定（评估接管成功路径——评估类一并覆盖；
      // fail-open 沿 appendBinding 语义——消费点兜底，不阻塞编排启动主流程）
      try { if (cfg.bindRun !== undefined) await cfg.bindRun(args.run_id); } catch { /* fail-open */ }
      return asToolValue({
        started: true, eval_round: roundDir, tmux: orchSessionName,
        serving_models: expectedModels, service_manifest: join(serviceDir, "service_manifest.json"),
        prelaunch_report: reportPath, release: "eval-release 账本已登记（config sha256）",
        note: "编排后台执行中（服务自启→staging→run_formal_eval→回灌，runner --model 取 manifest 期望名）——status 查询 receipt/四件套/model 标签",
      });
    },
  });

  const analyze = defineTool({
    name: "atf_analyze_badcases",
    description:
      "badcase 两步链（轻量，正道化）：①build_raw_badcase_input.py 冻结账本（评估四件套＋L1 eval 资产→RawBadcaseAnalysis/v1，落 analysis/ledger/）②run_analysis_chain.py --raw-mainline <冻结账本> 一键链→viewer.html（GT/预测叠图）与 report/。脚本一律取 <kernelDir>/skills/（pin 单源，禁源工作树绝对路径）。无训练数据/无审阅时链按合同显式声明跳过。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（实验目录＝runs/<run_id>）" },
      eval_assets_dir: { type: "string", description: "L1 EvaluationAssets/v1 目录（test_images.json+eval_labels.jsonl；缺省 runs/<run_id>/l1/eval）" },
      lane: { type: "string", description: "评估 lane（缺省 goods，与冻结账本/链一致）" },
      doc_type: { type: "string", description: "单据类型名（如 装箱单；缺省沿脚本中性缺省「单据」）" },
      style_cluster_manifest: { type: "string", description: "StyleClusterManifest 路径（实验门②产出——缺省沿 L1 产物位 runs/<run_id>/l1/style-cluster-manifest.json）" },
      coordinate_space: { type: "string", description: "预测坐标空间声明（qwen_axis_1000|original_pixel；SKILL.md 条款：无法从 ExperimentConfig 派生时必传，链侧 fail-closed 拒绝静默缺省）" },
      gt_coordinate_space: { type: "string", description: "GT 标签坐标空间声明（闭集同上；GT 与预测可分属不同空间）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    presentCall: function(args: { run_id: string }) {
      return { card: "generic" as const, title: `badcase 分析 — ${args.run_id}`, kind: "other" as const }
    },
    async execute(args: { run_id: string; eval_assets_dir?: string; lane?: string; doc_type?: string; style_cluster_manifest?: string; coordinate_space?: string; gt_coordinate_space?: string }) {
      const runDir = resolveRunDir(cfg.runsRoot, args.run_id);
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
      const lane = args.lane ?? "goods";
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
      const chained = await runCapture("python3", chainArgs, 300_000);
      const viewerPath = join(runDir, "analysis", "viewer", "viewer.html");
      const reportMd = join(runDir, "analysis", "report", "report.md");
      const reportHtml = join(runDir, "analysis", "report", "report.html");
      if (chained.code !== 0) {
        return asToolValue({ ok: false, step: "chain", exit_code: chained.code, ledger: ledgerPath, stderr_tail: chained.stderr.slice(-800), note: "一键链失败——冻结账本已落 ledger/ 可续查" });
      }
      return asToolValue({
        ok: true,
        ledger: ledgerPath,
        viewer_html: viewerPath,
        report_md: reportMd,
        report_html: reportHtml,
        viewer_ready: existsSync(viewerPath),
        report_ready: existsSync(reportMd),
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
