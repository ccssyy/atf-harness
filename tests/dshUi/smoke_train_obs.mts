/** 批㊶-TRAIN-OBS 真实环境冒烟（铁律·非注入路径）：dev 实例起一次真实短训练
 *  （Qwen2.5-VL-3B·LoRA·identity 数据集·4 步），验证四点：
 *  ① progress.json 按 5s 颗粒更新（eta_s/percentage 在盘）②卡面进度行＋ETA（payload 断言）
 *  ③ trainlog.tail.json 刷新（capture-pane）④训练结束后环停止（终态后零写）。
 *  前置：dev 实例（3080）已重启载本批代码。运行：vendor tsx tests/dshUi/smoke_train_obs.mts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLossIngest } from "/data/sam/ATF-Harness/src/core/workspace/lossIngest.js";

const RUN_ID = "train-obs-smoke-r1";
const RUN_DIR = `/data/atf/dev/runs/${RUN_ID}`;
const SESSION = `dev-atf-training-run-${RUN_ID}`;
const LOG = join(RUN_DIR, "training", "train-stdout.log");
let failures = 0;
const assert = (cond: boolean, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 0) 现场：清残留→建 runDir→写真实训练命令→tmux 起→loss 进料（真实产品组件）
rmSync(RUN_DIR, { recursive: true, force: true });
mkdirSync(join(RUN_DIR, "training"), { recursive: true });
mkdirSync(join(RUN_DIR, "webui"), { recursive: true });
spawnSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });

const TRAIN_CMD = [
  "CUDA_VISIBLE_DEVICES=0 llamafactory-cli train",
  "--stage sft --do_train --finetuning_type lora",
  "--model_name_or_path /data/LLM_model/Qwen2.5-VL-3B-Instruct",
  "--dataset identity --dataset_dir /data/sam/LLaMA-Factory_094dev/data",
  "--template qwen2_vl --cutoff_len 1024 --max_samples 8",
  "--output_dir " + JSON.stringify(join(RUN_DIR, "training")),
  "--max_steps 4 --logging_steps 1 --save_strategy no --plot_loss no --report_to none",
  "--per_device_train_batch_size 2 --gradient_accumulation_steps 1 --learning_rate 5e-5",
  "--lora_rank 8 --lora_alpha 16",
].join(" ");
const TMUX_CMD = `${TRAIN_CMD} 2>&1 | tee ${JSON.stringify(LOG)}`;
const tm = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, TMUX_CMD], { encoding: "utf8" });
assert(tm.status === 0, "tmux 会话启动（dev-atf-training-run-<run_id> 产品形态）: " + tm.stderr.slice(0, 80));

// loss 进料（真实产品组件 startLossIngest——loss-series.json→training.active 判据供给）
const stopIngest = startLossIngest(LOG, join(RUN_DIR, "training", "loss-series.json"), 2000);

// ── ① progress.json 按 5s 颗粒更新＋eta_s（等待训练步进，至多 6 分钟）
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let sawProgress = false;
let sawEta = false;
let sawPercentageAdvance = false;
let lastPct = -1;
const deadline = Date.now() + 6 * 60 * 1000;
while (Date.now() < deadline) {
  await sleepMs(3000);
  const ppath = join(RUN_DIR, "webui", "progress.json");
  if (!existsSync(ppath)) continue;
  const p = JSON.parse(readFileSync(ppath, "utf8")) as { percentage?: number; eta_s?: number; updated_at?: string };
  sawProgress = true;
  if (typeof p.eta_s === "number" && p.eta_s > 0) sawEta = true;
  if (typeof p.percentage === "number" && p.percentage !== lastPct) {
    if (lastPct >= 0 && p.percentage > lastPct) sawPercentageAdvance = true;
    lastPct = p.percentage;
  }
  console.log(`[obs] percentage=${p.percentage} eta_s=${p.eta_s} updated_at=${p.updated_at}`);
  if (sawEta && sawPercentageAdvance) break;
}
assert(sawProgress, "① progress.json 在盘（同步器写方）");
assert(sawEta, "① eta_s 在盘（remaining_time 换算）");
assert(sawPercentageAdvance, "① percentage 随步进推进（5s 环多次写）");

// 5s 颗粒实证：相邻两次 updated_at 间隔取样（10s 窗口内 mtime 至少两变＝非 30s 节流）
const mt1 = statSync(join(RUN_DIR, "webui", "progress.json")).mtimeMs;
await sleepMs(7000);
const mt2 = existsSync(join(RUN_DIR, "webui", "progress.json")) ? statSync(join(RUN_DIR, "webui", "progress.json")).mtimeMs : 0;
assert(mt2 > mt1, `① 5s 颗粒：7s 窗口内 progress.json 再写（mtime ${mt1}→${mt2}）`);

// ── ③ trainlog.tail.json（capture-pane 采集刷新）
let tailOk = false;
let tailLines = 0;
const tailDeadline = Date.now() + 30_000;
while (Date.now() < tailDeadline) {
  await sleepMs(3000);
  const tpath = join(RUN_DIR, "webui", "trainlog.tail.json");
  if (!existsSync(tpath)) continue;
  const t = JSON.parse(readFileSync(tpath, "utf8")) as { captured_at?: string; lines?: string[] };
  tailLines = t.lines?.length ?? 0;
  if (tailLines > 0) { tailOk = true; break; }
}
assert(tailOk, `③ trainlog.tail.json 刷新（capture-pane ${tailLines} 行）`);

// ── ② 卡面进度行＋ETA（monitor.json 投影面断言——卡面 payload 源）
await sleepMs(6000);
const monitorPath = "/data/atf/dev/runs/atf-ui/monitor.json";
let cardEta = false;
let cardPct = false;
if (existsSync(monitorPath)) {
  const monitor = JSON.parse(readFileSync(monitorPath, "utf8")) as { runs: Array<{ run_id: string; training: { progress?: { percentage?: number; eta_s?: number } | null } }> };
  const run = monitor.runs.find((r) => r.run_id === RUN_ID);
  const prog = run?.training?.progress;
  cardPct = typeof prog?.percentage === "number";
  cardEta = typeof prog?.eta_s === "number";
}
assert(cardPct, "② monitor 投影 progress.percentage（卡面数据源）");
assert(cardEta, "② monitor 投影 progress.eta_s（ETA 到卡面）");

// ── ④ 停环：等训练结束（percentage 100 后 progress 冻结且无 stale——终态停环路径）
console.log("[obs] 等待训练结束…");
const endDeadline = Date.now() + 8 * 60 * 1000;
let finished = false;
let frozenAt = "";
while (Date.now() < endDeadline) {
  await sleepMs(5000);
  const ppath = join(RUN_DIR, "webui", "progress.json");
  if (!existsSync(ppath)) continue;
  const p = JSON.parse(readFileSync(ppath, "utf8")) as { percentage?: number; updated_at?: string; stale?: boolean };
  if (p.percentage === 100) {
    if (frozenAt === "") frozenAt = p.updated_at ?? "";
    else if (p.updated_at === frozenAt) { finished = true; break; } // 终态后冻结（零写）
  }
}
assert(finished, "④ 终态停环：percentage 100 后 progress 冻结（终态写一次后零写）");
const finalP = JSON.parse(readFileSync(join(RUN_DIR, "webui", "progress.json"), "utf8")) as { stale?: boolean; percentage?: number };
assert(finalP.stale !== true, "④ 走终态路径非 stale 路径（正常完成）");
assert(finalP.percentage === 100, "④ 终态 percentage=100");

// 会话自然退场
const sessGone = spawnSync("tmux", ["has-session", "-t", SESSION], { stdio: "ignore" }).status !== 0;
assert(sessGone, "④ 训练会话自然退场");

stopIngest();
console.log(`[smoke] runDir 留证：${RUN_DIR}（真实短训产物——trainer_log/progress/trainlog.tail/loss-series）`);
console.log(failures === 0 ? "[smoke] ALL PASS" : `[smoke] FAILURES: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
