/**
 * atf-ui 快照构造纯函数（本仓 vitest 直测；服务端同步器与 client 渲染共享口径）。
 * 单源纪律：段语义沿批⑮定稿；空态文案单源导出（client 直引）。
 */

/** 管线前五段（批⑮ 定稿口径；training 段由 loss-series 激活，不入此列）。 */
export const SEGMENTS = [
  { key: "register", label: "登记卡" },
  { key: "split", label: "切分卡" },
  { key: "label_qc", label: "体检卡" },
  { key: "candidate", label: "候选" },
  { key: "publish", label: "发布" },
];

/** 空态文案（GPU 排队语义——文案单源，client 直引不另写）。 */
export const QUEUE_IDLE_TEXT = "等待训练启动 · DRY_RUN 已过 · 排队中";

/** KPI 2×2 的键（指令组件 2）。 */
export const KPI_KEYS = ["train_loss", "eval_loss", "learning_rate", "gpu_mem"];

/**
 * @param runs - 同步器 scanRuns 的 run 形态（run_id/state/segments/training/report）。
 * @returns monitor.json 快照：每 run 段状态＋训练视图数据。
 */
export function buildMonitorSnapshot(runs) {
  return {
    schema: "AtfMonitor/v1",
    generated_at: new Date().toISOString(),
    runs: runs.map((run) => ({
      run_id: run.run_id,
      state: run.state ?? "unknown",
      segments: SEGMENTS.map(({ key, label }) => ({ key, label, lit: run.segments?.[key] === true })),
      training: {
        active: run.training?.active === true,
        points: Array.isArray(run.training?.loss) ? run.training.loss : [],
        pending_confirm: run.training?.pending_confirm ?? null,
      },
    })),
  };
}

/**
 * 产物抽屉快照：逐段入列（登记件/契约件 digest/切分清单/train.sh/评估四件套/badcase viewer/report.md）。
 * 每行 {name, path, kind}——path 为 runsRoot 相对路径；[预览] 由 client read 直开（批⑰直开语义）。
 */
export function buildArtifactsSnapshot(runs) {
  return {
    schema: "AtfArtifacts/v1",
    generated_at: new Date().toISOString(),
    runs: runs.map((run) => ({
      run_id: run.run_id,
      artifacts: deriveArtifacts(run),
    })),
  };
}

function deriveArtifacts(run) {
  const rows = [];
  const has = (rel) => (run.artifacts ?? []).includes(rel) || run.report?.files?.some((f) => rel.includes(f));
  if (has("session.jsonl")) rows.push({ name: "登记件 session.jsonl", path: `${run.run_id}/session.jsonl`, kind: "jsonl" });
  if (has("contract-candidate.json")) rows.push({ name: "契约件（含 digest）", path: `${run.run_id}/contract-candidate.json`, kind: "json" });
  if (run.segments?.split === true) rows.push({ name: "切分清单", path: `${run.run_id}/dataset`, kind: "dir" });
  if (has("launch/train.sh")) rows.push({ name: "train.sh", path: `${run.run_id}/launch/train.sh`, kind: "sh" });
  for (const file of run.report?.files ?? []) {
    const kind = file.endsWith(".md") ? "md" : "json";
    const label = file === "report.md" ? "report.md（界面同源声明）" : file.startsWith("segment-") ? `分段报告 ${file}` : file;
    rows.push({ name: label, path: `${run.run_id}/report/${file}`, kind });
  }
  return rows;
}

/** loss-series 点列解析（坏行如实跳过；空/坏文件 → []）。 */
export function parseLossSeries(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((point) => point !== null && typeof point === "object") : [];
  } catch {
    return [];
  }
}

/** SVG polyline points 串（0..w 归一；points 不足 2 → null 不画）。 */
export function lossSvgPath(points, key, w = 300, h = 80) {
  const values = points.map((point) => point[key]).filter((v) => typeof v === "number");
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / range) * (h - 8)).toFixed(1)}`)
    .join(" ");
}

/** KPI 2×2（最新点优先；缺失显示 —）。gpu_mem 现阶段来自 GPU 卡实测面（M3 接线），缺省 —。 */
export function deriveKpis(points) {
  const last = points[points.length - 1] ?? {};
  return {
    train_loss: typeof last.train_loss === "number" ? String(last.train_loss) : "—",
    eval_loss: typeof last.eval_loss === "number" ? String(last.eval_loss) : "—",
    learning_rate: typeof last.learning_rate === "number" ? String(last.learning_rate) : "—",
    gpu_mem: "—",
  };
}

/** 训练视图状态机：loss 有点 → training；否则 idle（空态文案单源）。 */
export function deriveTrainingState(points) {
  return points.length > 0 ? "training" : "idle";
}
