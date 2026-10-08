/**
 * 批⑱M2.75——训练执行段三工具投影（atf_run_training / atf_evaluate / atf_analyze_badcases）。
 *
 * 对齐审计缺口：12 skill 中三段无工具投影——训练执行→评估→可视化无法从 WebUI 对话驱动。
 * 实现要点：
 *  - atf_run_training：train.sh DRY_RUN 校验 → **danger_confirm（GPU/时长显性化）** → tmux 常驻
 *    （atf-training-run）＋stdout tail 进料（HF dict 行→loss-series.json 追加——批⑯协议）→
 *    status 查询完成/ckpt。非阻塞两段式（start/status）——工具不阻塞 agent turn。
 *  - atf_evaluate：llamafactory api（8200，bnb 同训练形态）＋run_formal_eval.py 四件套——start/status 同款。
 *  - atf_analyze_badcases：两步链（批㉕B 段1 正道化）——build_raw_badcase_input.py 冻结账本 →
 *    run_analysis_chain.py --raw-mainline 一键链；脚本一律取 <kernelDir>/skills/（pin 单源）。
 * 审批：run_training= danger 必确认（GPU/时长）；evaluate= 确认（资源占用）；analyze= 轻量。
 * 环境纪律沿 M0：GPU/端口/venv 走 env-profile；异常即停即报不静默重试。
 */
import { spawn, execFile, execSync } from "node:child_process";
import * as net from "node:net";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildMonitorSnapshot, formatTaskCard } from "../../atf-ui/src/snapshot.js";
import { scanRunDir } from "../../atf-ui/src/server.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { asToolValue } from "./schemaTranslate.js";
import { startLossIngest } from "../../../../src/core/workspace/lossIngest.js";
import { awaitGpuWindow, gpuQueuePollMsFromEnv, queueHitText } from "./gpuQueueFace.js";

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

/** 残留特征（cmdline/进程名任一命中即疑似上轮训练残留）。 */
export const TRAINING_RESIDUE_PATTERN = /torchrun|launcher\.py|llamafactory|deepspeed|pt_elastic/i;

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

/** tmux 面查询（会话存在/进程退出判定——守卫 tmux 缺失环境）。 */
const tmuxHas = (session: string): boolean => {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(`tmux has-session -t ${session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
};

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
}

/** status 结果形状（任务卡卡面输入）。 */
export interface TrainingStatusValue {
  action?: string;
  run_id?: string;
  segments?: Array<{ key: string; label: string; status: "done" | "active" | "failed" | "pending" }>;
  running?: boolean;
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
  return [
    `训练任务卡 — run ${value.run_id ?? "?"}`,
    formatTaskCard({ segments: segs }),
    `训练进程：${value.running === true ? "运行中（tmux atf-training-run）" : "未运行"}`,
    `loss 点数：${String(value.loss_points ?? 0)}`,
    ...(Array.isArray(value.ckpts) && value.ckpts.length > 0 ? [`checkpoint：${value.ckpts.join("、")}`, `latest：${value.latest_ckpt ?? ""}`] : []),
  ].join("\n");
}

/** atf_run_training（action: start/status）——danger 必确认。 */
export const buildRunTrainingTool = (ctx: { get(service: string): unknown }, cfg: TrainingToolsConfig) =>
  defineTool({
    name: "atf_run_training",
    description:
      "训练本机重跑（批㉕B 段4 降格定界——atf_launch_execute 为唯一编排执行点，本工具仅限「账本已放行 config 的本机重跑」）：action=start 校验 train.sh（DRY_RUN 过）→prelaunch 报告在场检查（prepare SKILL.md:84 确认制——缺失拒绝）→端口预检→danger 卡放行→tmux atf-training-run 常驻执行＋stdout tail 进料监控（loss-series）；action=status 查询运行状态并返回八段任务卡（chat 流可见的 checklist——训练推进期请周期调用 status，把最新任务卡呈现给用户）。异常即停即报，不静默重试。",
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
      if (args.action === "status") {
        const running = tmuxHas("atf-training-run");
        const ckptDir = join(cfg.runsRoot, args.run_id, "training");
        const ckpts = existsSync(ckptDir)
          ? (await import("node:fs")).readdirSync(ckptDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("checkpoint-")).map((d) => d.name)
          : [];
        const lossPath = join(ckptDir, "loss-series.json");
        const points = existsSync(lossPath) ? (JSON.parse(readFileSync(lossPath, "utf8")) as unknown[]).length : 0;
        // 八段任务卡段状态（与监控同步器同源推导——scanRunDir 单源）
        const segments = buildMonitorSnapshot([scanRunDir(cfg.runsRoot, args.run_id)]).runs[0]?.segments ?? [];
        return asToolValue({ action: "status", running, run_id: args.run_id, segments, ckpts, loss_points: points, ...(ckpts.length > 0 ? { latest_ckpt: `runs/${args.run_id}/training/${ckpts[ckpts.length - 1]}` } : {}) });
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
      // 端口预检：占用即根因上卡面；非训练进程占用 fail-closed 不自动清理
      const port = extractMasterPort(readFileSync(args.train_sh, "utf8"));
      const occupant = await probePortOccupant(port);
      if (occupant !== null && !occupant.residueLike) {
        return asToolValue({ started: false, error: "port_occupied_non_residue", port, occupant, note: formatPortConflictNote(port, occupant) });
      }
      const conflictNote = occupant !== null ? `\n${formatPortConflictNote(port, occupant)}` : "";
      const verdict = await requestApproval(ctx, exec, "atf_run_training", `真实 GPU 训练启动确认（GPU/时长代价以九要素确认卡与 train.sh 为准）：train.sh=${args.train_sh}${conflictNote}`);
      if (!verdict.ok) return approvalDeniedResult("atf_run_training", verdict.outcome);
      // 批㊶-K 项 1：GPU 排队编排（真跑 danger 放行后入队——原 WebUI 语义迁移：周期探测
      // util<20%＋显存<10GB 连续 2 周期；命中→琥珀再确认卡人工放行（真跑守门不变）；
      // 无超时；编排器零启动调用。env ATF_GPU_POLL_MS 可配，缺省 300s）
      const gpuPollMs = gpuQueuePollMsFromEnv(process.env);
      if (gpuPollMs !== null) {
        const windowState = await awaitGpuWindow({ pollMs: gpuPollMs, signal: exec.signal as { aborted: boolean } | undefined });
        if (windowState.kind === "aborted") return approvalDeniedResult("atf_run_training", "cancelled");
        const amber = await requestApproval(ctx, exec, "atf_run_training", `${queueHitText(windowState.gpuIndex)}（已等待 ${windowState.waitedText}）——GPU 窗口命中，确认启动训练（train.sh=${args.train_sh}）`);
        if (!amber.ok) return approvalDeniedResult("atf_run_training", amber.outcome);
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
      const { execSync } = await import("node:child_process");
      try { execSync(`tmux kill-session -t atf-training-run 2>/dev/null`); } catch { /* 无旧会话 */ }
      execSync(`tmux new-session -d -s atf-training-run "bash ${args.train_sh} 2>&1 | tee -a ${logPath}"`);
      startLossIngest(logPath, join(cfg.runsRoot, args.run_id, "training", "loss-series.json"));
      return asToolValue({
        started: true,
        tmux: "atf-training-run",
        run_id: args.run_id,
        log: logPath,
        ...(rotated !== null ? { previous_log: rotated } : {}),
        note: "训练已启动（tail 进料监控中）——status 查询进度与 ckpt；完成回报 ckpt 路径",
      });
    },
  });

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
}

/** atf_evaluate status：最新评估轮的服务 receipt/编排状态/四件套与 model 标签复核。 */
export async function evalStatus(runId: string, cfg: { runsRoot: string; kernelDir: string }): Promise<ReturnType<typeof asToolValue>> {
  const evalRoot = join(cfg.runsRoot, runId, "eval");
  let latest: string | null = null;
  try {
    const rounds = readdirSync(evalRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-\d{8}$/.test(e.name)).map((e) => e.name).sort();
    latest = rounds.length > 0 ? join(evalRoot, rounds[rounds.length - 1] ?? "") : null;
  } catch { /* 无评估轮 */ }
  const { execSync } = await import("node:child_process");
  let running = false;
  try { execSync(`tmux has-session -t atf-eval-orch 2>/dev/null`); running = true; } catch { /* 未运行 */ }
  if (latest === null) return asToolValue({ action: "status", run_id: runId, running, note: "无评估轮目录——先 start" });
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
  const value: EvalStatusValue = {
    action: "status", run_id: runId, eval_round: latest, running,
    ...(service !== null ? { service } : {}),
    orchestration,
    files,
    ...(summary !== null ? { metrics_summary: summary } : {}),
    ...(labelWarning !== undefined ? { model_label_warning: labelWarning } : {}),
    ...(modelMatchesManifest !== undefined ? { model_matches_manifest: modelMatchesManifest } : {}),
  };
  return asToolValue(value);
}

/** atf_evaluate / atf_analyze_badcases 构造（评估与两步链——start/status 与轻量直跑）。 */
export function buildEvalTools(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; logDir: string; kernelDir: string }): unknown[] {
  const evaluate = defineTool({
    name: "atf_evaluate",
    description:
      "评估触发（批㉕B 段3 正道链——确认制＋EVAL_RELEASE 审批账本，绕行 llamafactory api 形态已删除）：action=start 编排 pin 内正道链 generate_eval_service（vllm serve＋AWQ base）→build_service_prelaunch_report（九必报项确认报告）→用户确认（确认卡＝EVAL_RELEASE 放行，--record-eval-release 落账本）→generate_eval_orchestration（tmux 后台：服务自启→staging→run_formal_eval→回灌）；action=status 查询服务 receipt/编排状态/四件套与 model 标签。机器事实三件（eval_env/awq_base/cuda_visible_devices）一律来自 deploy/env-profile，缺即 MissingFactsBlock 停下问用户。评估轮目录＝runs/<run_id>/eval/<N>-<日期>/{service,ckpt-plan,orch}（ADR-0007）。",
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
      const runDir = join(cfg.runsRoot, args.run_id);
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
      if (leaking.length > 0) return asToolValue({ started: false, error: "serving_model_label_default_leak", models: leaking, note: "service manifest 期望模型名含 OpenAI 风格缺省名——gpt-*/claude-* 前缀拒收（批⑳.3 防线）" });
      // ② 确认报告（九必报项，产物反生成自 service_manifest）
      const reportPath = join(serviceDir, "service-prelaunch-report.md");
      const reported = await runCapture("python3", [prelaunch, "--service-dir", serviceDir, "--env-profile", args.env_profile, "--out", reportPath,
        "--field-config", args.field_config, "--prompt-renderer", skill("atf-admit-training-data", "render_prompt.py")], 120_000);
      if (reported.code !== 0 || !existsSync(reportPath)) {
        return asToolValue({ started: false, error: "prelaunch_report_failed", eval_round: roundDir, stderr_tail: reported.stderr.slice(-800), note: "确认报告未产出＝EVAL_RELEASE 准入未闭合（SKILL.md 确认制）" });
      }
      // ③ EVAL_RELEASE 确认卡：九必报项报告全文上卡，Allow once＝确认并落放行账本
      const reportText = readFileSync(reportPath, "utf8");
      const verdict = await requestApproval(ctx, exec, "atf_evaluate",
        `评估服务 EVAL_RELEASE 确认（放行＝审批账本登记 config sha256，编排按其过闸）：\n${reportText.slice(0, 4000)}`);
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
      try { execSync(`tmux kill-session -t atf-eval-orch 2>/dev/null`); } catch { /* 无旧 */ }
      execSync(`tmux new-session -d -s atf-eval-orch "bash ${orchDir}/eval_orchestration.sh --prompt-renderer ${skill("atf-admit-training-data", "render_prompt.py")} --coordinate qwen3_vl --prompt-mode mode0 2>&1 | tee -a ${cfg.logDir}/eval-orchestration.log"`);
      return asToolValue({
        started: true, eval_round: roundDir, tmux: "atf-eval-orch",
        serving_models: expectedModels, service_manifest: join(serviceDir, "service_manifest.json"),
        prelaunch_report: reportPath, release: "eval-release 账本已登记（config sha256）",
        note: "编排后台执行中（服务自启→staging→run_formal_eval→回灌，runner --model 取 manifest 期望名）——status 查询 receipt/四件套/model 标签",
      });
    },
  });

  const analyze = defineTool({
    name: "atf_analyze_badcases",
    description:
      "badcase 两步链（轻量，批㉕B 段1 正道化）：①build_raw_badcase_input.py 冻结账本（评估四件套＋L1 eval 资产→RawBadcaseAnalysis/v1，落 analysis/ledger/）②run_analysis_chain.py --raw-mainline <冻结账本> 一键链→viewer.html（GT/预测叠图）与 report/。脚本一律取 <kernelDir>/skills/（pin 单源，禁源工作树绝对路径）。无训练数据/无审阅时链按合同显式声明跳过。",
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
      const runDir = join(cfg.runsRoot, args.run_id);
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
