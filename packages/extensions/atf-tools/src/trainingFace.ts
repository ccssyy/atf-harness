/**
 * 批⑱M2.75——训练执行段三工具投影（atf_run_training / atf_evaluate / atf_analyze_badcases）。
 *
 * 对齐审计缺口：12 skill 中三段无工具投影——训练执行→评估→可视化无法从 WebUI 对话驱动。
 * 实现要点：
 *  - atf_run_training：train.sh DRY_RUN 校验 → **danger_confirm（GPU/时长显性化）** → tmux 常驻
 *    （atf-training-run）＋stdout tail 进料（HF dict 行→loss-series.json 追加——批⑯协议）→
 *    status 查询完成/ckpt。非阻塞两段式（start/status）——工具不阻塞 agent turn。
 *  - atf_evaluate：llamafactory api（8200，bnb 同训练形态）＋run_formal_eval.py 四件套——start/status 同款。
 *  - atf_analyze_badcases：run_analysis_chain.py 一键链（--style-cluster-manifest 透传——M2.5 聚类产物喂链）。
 * 审批：run_training= danger 必确认（GPU/时长）；evaluate= 确认（资源占用）；analyze= 轻量。
 * 环境纪律沿 M0：GPU/端口/venv 走 env-profile；异常即停即报不静默重试。
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { asToolValue } from "./schemaTranslate.js";

/** HF Trainer dict 行解析（批⑯ logParser 协议口径）→ loss-series 点。 */
export function parseTrainerLine(line: string): { train_loss: number; grad_norm: number | null; learning_rate: number | null; epoch: number } | null {
  const m = /\{'loss':[^}]+\}/.exec(line);
  if (!m) return null;
  try {
    const d = astEval(m[0]);
    if (typeof d.loss !== "number") return null;
    return {
      train_loss: d.loss,
      grad_norm: typeof d.grad_norm === "number" ? d.grad_norm : null,
      learning_rate: typeof d.learning_rate === "number" ? d.learning_rate : null,
      epoch: typeof d.epoch === "number" ? d.epoch : 0,
    };
  } catch {
    return null;
  }
}

/** 受控字面量求值（HF 日志 dict——单引号 Python 形态；仅本格式，其他内容抛错走 null 路径）。 */
function astEval(text: string): Record<string, number | string> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 输入限定为训练日志的 dict 行
  const fn = new Function(`return (${text.replace(/'/g, '"')})`) as () => Record<string, number | string>;
  return fn();
}

/** tail 进料循环：解析新日志行→追加 loss-series.json（批⑯协议）。返回停止函数。 */
export function startLossIngest(logPath: string, seriesPath: string, intervalMs = 3000): () => void {
  const read = (): Array<Record<string, unknown>> => {
    try {
      return JSON.parse(readFileSync(seriesPath, "utf8")) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  };
  const timer = setInterval(() => {
    try {
      if (!existsSync(logPath)) return;
      const series = read();
      let pos = series.length === 0 ? 0 : -1;
      const text = readFileSync(logPath, "utf8");
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      const points: Array<Record<string, unknown>> = [];
      for (const line of lines) {
        const p = parseTrainerLine(line);
        if (p !== null) {
          points.push({ step: points.length + 1, ...p, at: new Date().toISOString() });
        }
      }
      if (points.length > series.length) {
        const merged = [...series, ...points.slice(series.length)];
        mkdirSync(join(seriesPath, ".."), { recursive: true });
        writeFileSync(seriesPath, `${JSON.stringify(merged, null, 1)}\n`, "utf8");
        void pos;
      }
    } catch { /* 下周期重试 */ }
  }, intervalMs);
  return () => clearInterval(timer);
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

/** atf_run_training（action: start/status）——danger 必确认。 */
export const buildRunTrainingTool = (ctx: { get(service: string): unknown }, cfg: TrainingToolsConfig) =>
  defineTool({
    name: "atf_run_training",
    description:
      "训练执行（danger 必确认——GPU 时长代价显性化）：action=start 校验 train.sh（DRY_RUN 过）→审批卡放行→tmux atf-training-run 常驻执行＋stdout tail 进料监控（loss-series）→返回启动凭据；action=status 查询运行状态/checkpoint 落盘/loss 进度。异常即停即报，不静默重试。",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "status"], description: "start=放行后启动训练；status=查询状态与 ckpt" },
      train_sh: { type: "string", required: true, description: "train.sh 绝对路径（须已通过 DRY_RUN 校验）" },
      run_id: { type: "string", required: true, description: "run 标识（监控数据/ckpt 归属）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { action: string; train_sh: string; run_id: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      if (args.action === "status") {
        const running = tmuxHas("atf-training-run");
        const ckptDir = join(cfg.runsRoot, args.run_id, "training");
        const ckpts = existsSync(ckptDir)
          ? (await import("node:fs")).readdirSync(ckptDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith("checkpoint-")).map((d) => d.name)
          : [];
        const lossPath = join(ckptDir, "loss-series.json");
        const points = existsSync(lossPath) ? (JSON.parse(readFileSync(lossPath, "utf8")) as unknown[]).length : 0;
        return asToolValue({ action: "status", running, run_id: args.run_id, ckpts, loss_points: points, ...(ckpts.length > 0 ? { latest_ckpt: `runs/${args.run_id}/training/${ckpts[ckpts.length - 1]}` } : {}) });
      }
      // —— start：danger 必确认 ——
      const verdict = await requestApproval(ctx, exec, "atf_run_training", `真实 GPU 训练启动确认：GPU 2 单卡 · max_steps 30（短跑锁死）· 预计 20 分钟 · train.sh=${args.train_sh}`);
      if (!verdict.ok) return approvalDeniedResult("atf_run_training", verdict.outcome);
      // DRY_RUN 前置校验
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
      // tmux 常驻＋tee 日志＋tail 进料
      const logPath = join(cfg.logDir, "train-stdout.log");
      mkdirForce(cfg.logDir);
      const { execSync } = await import("node:child_process");
      try { execSync(`tmux kill-session -t atf-training-run 2>/dev/null`); } catch { /* 无旧会话 */ }
      execSync(`tmux new-session -d -s atf-training-run "bash ${args.train_sh} 2>&1 | tee -a ${logPath}"`);
      startLossIngest(logPath, join(cfg.runsRoot, args.run_id, "training", "loss-series.json"));
      return asToolValue({ started: true, tmux: "atf-training-run", run_id: args.run_id, log: logPath, note: "训练已启动（tail 进料监控中）——status 查询进度与 ckpt；完成回报 ckpt 路径" });
    },
  });

function mkdirForce(dir: string): void {
  import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
}

/** atf_evaluate / atf_analyze_badcases 构造（评估与一键链——start/status 与轻量直跑）。 */
export function buildEvalTools(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; logDir: string }): unknown[] {
  const evaluate = defineTool({
    name: "atf_evaluate",
    description:
      "评估触发（确认——资源占用）：action=start 启动评估服务（llamafactory api，bnb 同训练形态加载 adapter）＋run_formal_eval 四件套推理（后台）；action=status 查询进度。四件套落 runs/<run_id>/eval/。",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "status"], description: "start=启动评估（后台）；status=查询四件套产出" },
      run_id: { type: "string", required: true, description: "run 标识" },
      adapter_path: { type: "string", description: "adapter checkpoint 绝对路径（如 runs/<id>/training/checkpoint-30）" },
      eval_assets_dir: { type: "string", required: true, description: "L1 EvaluationAssets/v1 目录（test_images.json+eval_labels.jsonl）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { action: string; run_id: string; adapter_path?: string; eval_assets_dir: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      if (args.action === "status") {
        const evalDir = join(cfg.runsRoot, args.run_id, "eval");
        const files = ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"].filter((f) => existsSync(join(evalDir, f)));
        const summary = files.includes("metrics_summary.json") ? JSON.parse(readFileSync(join(evalDir, "metrics_summary.json"), "utf8")) : null;
        return asToolValue({ action: "status", files, ...(summary !== null ? { metrics_summary: summary } : {}) });
      }
      const verdict = await requestApproval(ctx, exec, "atf_evaluate", `评估启动确认：评估服务（GPU 加载 base+adapter）＋holdout 推理——资源占用约 30GB/15 分钟`);
      if (!verdict.ok) return approvalDeniedResult("atf_evaluate", verdict.outcome);
      const adapter = args.adapter_path ?? join(cfg.runsRoot, args.run_id, "training", "checkpoint-30");
      if (!existsSync(adapter)) return asToolValue({ started: false, error: `adapter 不存在: ${adapter}` });
      const { execSync } = await import("node:child_process");
      try { execSync(`tmux kill-session -t atf-eval-service 2>/dev/null`); } catch { /* 无旧 */ }
      execSync(`tmux new-session -d -s atf-eval-service "CUDA_VISIBLE_DEVICES=2 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 API_PORT=8200 llamafactory-cli api --model_name_or_path /data/LLM_model/Qwen3-VL-32B-Instruct --adapter_name_or_path ${adapter} --template qwen3_vl --finetuning_type lora --quantization_bit 4 --quantization_method bnb 2>&1 | tee -a ${cfg.logDir}/eval-api.log"`);
      return asToolValue({ started: true, service: "llamafactory api @8200", adapter, eval_assets: args.eval_assets_dir, note: "服务启动中（加载约 2 分钟）——就绪后以 run_formal_eval.py 消费 /v1（四件套落 runs/<run_id>/eval/）" });
    },
  });

  const analyze = defineTool({
    name: "atf_analyze_badcases",
    description:
      "badcase 一键链（轻量）：run_analysis_chain.py --run <实验目录>（含 --style-cluster-manifest 透传——实验门②聚类产物喂分析链）→ viewer.html（GT/预测叠图）与 report.html 路径回报。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（实验目录＝runs/<run_id>）" },
      style_cluster_manifest: { type: "string", description: "StyleClusterManifest 路径（实验门②产出——缺省沿 L1 产物位）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { run_id: string; style_cluster_manifest?: string }) {
      const runDir = join(cfg.runsRoot, args.run_id);
      const script = "/data/sam/AgenticTrainingFlow/skills/atf-analyze-badcases/scripts/run_analysis_chain.py";
      const chainArgs = ["--run", runDir, "--eval-dir", join(runDir, "eval"), "--predictions", join(runDir, "eval", "raw_predictions.jsonl"), "--badcases", join(runDir, "eval", "badcases.jsonl"), "--output-dir", join(runDir, "analysis")];
      const manifest = args.style_cluster_manifest ?? join(runDir, "l1", "style-cluster-manifest.json");
      if (existsSync(manifest)) chainArgs.push("--style-cluster-manifest", manifest);
      const result = await runCapture("python3", [script, ...chainArgs], 300_000);
      const viewer = join(runDir, "analysis", "viewer.html");
      return asToolValue({
        ok: result.code === 0,
        exit_code: result.code,
        viewer_html: existsSync(viewer) ? viewer : join(runDir, "analysis", "viewer.html", "viewer.html"),
        report_html: join(runDir, "analysis", "report.html"),
        ...(result.code !== 0 ? { stderr_tail: result.stderr.slice(-800) } : {}),
      });
    },
  });

  return [evaluate, analyze];
}
