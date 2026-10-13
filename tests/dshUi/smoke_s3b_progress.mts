/** 批㊶-S3 窗口B 真机冒烟（非注入路径——生产 TS 源直跑同步器投影链）：
 *  /tmp 假 runsRoot 造 run（progress.jsonl 四态账＋段事实轨＋完成锚）→ tickOnce 生产码 →
 *  monitor.json 断言：eval_progress 读账投影／eval_notices 三跳＋trainable／守卫豁免后段状态／
 *  panel.html 四态渲染＋评估进度行。运行：vendor tsx tests/dshUi/smoke_s3b_progress.mts */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tickOnce } from "/data/sam/ATF-Harness/packages/extensions/atf-ui/src/server.js";

const runsRoot = "/tmp/s3b-smoke/runs";
await tickOnce({ runsRoot, intervalMs: 60_000 });

const monitorPath = join(runsRoot, "atf-ui", "monitor.json");
if (!existsSync(monitorPath)) throw new Error("monitor.json 未落盘");
const monitor = JSON.parse(readFileSync(monitorPath, "utf8"));
const run = monitor.runs.find((r: { run_id: string }) => r.run_id === "eval-r1");
if (run === undefined) throw new Error("run 未收录");

const assert = (cond: boolean, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// 1) 读账投影：eval_progress 五键白名单（ready 跳末行如实搬运）
assert(run.eval_progress !== null && typeof run.eval_progress === "object", "eval_progress 投影在场");
assert(run.eval_progress?.round === "1-20261013", "eval_progress.round=最新轮");
assert(run.eval_progress?.phase === "ready", "eval_progress.phase=ready（读账末行）");
assert(run.eval_progress?.elapsed_s === 30 && run.eval_progress?.detail === "health 探测通过", "eval_progress 末行 detail/elapsed 如实");
assert(Object.keys(run.eval_progress).every((k: string) => ["round", "phase", "detail", "elapsed_s", "updated_at"].includes(k)), "eval_progress 键面白名单五键");

// 2) 通知面：三跳＋trainable（training 事实＋完成锚＋evaluate 未发起）
const notices = run.eval_notices ?? [];
const phases = notices.filter((n: { kind?: string }) => n.kind !== "trainable").map((n: { phase?: string }) => n.phase);
assert(JSON.stringify(phases) === JSON.stringify(["launching", "initializing", "ready"]), `流转三跳=launching/initializing/ready（实得 ${JSON.stringify(phases)}）`);
assert(notices.some((n: { kind?: string }) => n.kind === "trainable"), "trainable 可评估一跳在场");

// 3) 前缀闭包（owner 裁定：段显示态保序）：收尾段证据反蕴含前段——done 恒为前缀无间隔态
const seg = (key: string): string | boolean => run.segments.find((s: { key: string }) => s.key === key)?.status;
assert(seg("experiment_config") === "done", "experiment_config 事实轨 done");
assert(seg("training") === "done", "training 完成锚 done");
assert(seg("register") === "done", "register 随前缀点亮（后段完成反蕴含，间隔态消除）");
assert(seg("evaluate") === "pending", "evaluate 无产物如实 pending（frontier）");
// 机械序守恒：done 恒为前缀（任何后段 done 而前段非 done 即不合逻辑态）
let seenPending = false;
let ordered = true;
for (const s of run.segments) {
  if (s.status !== "done") seenPending = true;
  else if (seenPending) ordered = false;
}
assert(ordered, "八段 done 恒为前缀（保序不变量）");

// 4) panel.html：四态渲染标记＋评估进度行（读账文案）在模板产物
const panelHtml = readFileSync(join(runsRoot, "atf-ui", "panel.html"), "utf8");
assert(panelHtml.includes("STATE_MARK"), "panel 八段卡四态渲染（lit 硬伤退役）");
assert(!panelHtml.includes("getElementById('updated')"), "panel updated 空引用已删");
assert(panelHtml.includes("eval_progress"), "panel 评估进度行读 eval_progress 面");

console.log(`[smoke] monitor generated_at=${monitor.generated_at}`);
