/**
 * atf-ui 快照构造纯函数（本仓 vitest 直测；服务端同步器与 client 渲染共享口径）。
 * 单源纪律：段语义沿批⑮定稿；空态文案单源导出（client 直引）。
 */

/** 管线八段（批⑳ 打回修正：八段全渲染——登记/体检/实验配置/发布/切分/admission/训练/评估）。 */
export const SEGMENTS = [
  { key: "register", label: "数据登记" },
  { key: "label_qc", label: "标注体检" },
  { key: "experiment_config", label: "实验配置" },
  { key: "publish", label: "契约发布" },
  { key: "split", label: "数据切分" },
  { key: "admission", label: "准入检查" },
  { key: "training", label: "训练执行" },
  { key: "evaluate", label: "评估与可视化" },
];

/** 空态文案（GPU 排队语义——文案单源，client 直引不另写）。 */
export const QUEUE_IDLE_TEXT = "等待训练启动 · DRY_RUN 已过 · 排队中";

/** KPI 2×2 的键（指令组件 2）。 */
export const KPI_KEYS = ["train_loss", "eval_loss", "learning_rate", "gpu_mem"];

/** 段四态：done 完成 / active 进行中 / failed 失败 / pending 待办。 */
function segmentStatus(run, key) {
  const seg = run.segments?.[key];
  if (seg === "failed") return "failed";
  if (seg === "active") return "active";
  if (seg === true) return "done";
  // 进行中语义：训练段有 loss 流即 active；评估段有推理中标记（预留）；
  // 实验配置段有 pending 确认卡即 active（等待用户四卡应答）。
  if (key === "training" && run.training?.active === true) return "active";
  if (key === "experiment_config" && run.training?.pending_confirm) return "active";
  return "pending";
}

/**
 * @param runs - 同步器 scanRuns 的 run 形态（run_id/state/segments/training/report）。
 * @param gpu - GPU 首行单卡面（queryNvidiaSmi 结果；缺省 offline——不猜测）。
 * @param gpuAll - 批㉝H 全卡面（queryNvidiaSmiAll 逐卡列表；缺省/不可用 → 空数组，
 *   client 回退首行单卡面——旧快照与新 client 双向向后兼容）。
 * @returns monitor.json 快照：每 run 段状态＋训练视图数据＋GPU 状态行。
 */
export function buildMonitorSnapshot(runs, gpu, gpuAll) {
  return {
    // schema: v2 (additive, 2026-10-09, 批㊶-N)——只增不改（progress/bound_sessions 两键；禁改名/改值/删除）
    schema: "AtfMonitor/v1",
    generated_at: new Date().toISOString(),
    gpu: gpu ?? { offline: true },
    // 批㉝H：全卡聚合面（GPU0 0%/0MiB · GPU1 12%/8429MiB——逐卡 util/显存）
    gpu_all: Array.isArray(gpuAll) ? gpuAll : [],
    runs: runs.map((run) => ({
      run_id: run.run_id,
      state: run.state ?? "unknown",
      segments: SEGMENTS.map(({ key, label }) => ({ key, label, status: segmentStatus(run, key) })),
      // 批㉛段1：badcase viewer 产物发现（scanRunDir 两形态兼容推导，空数组＝无挂载面）
      viewers: Array.isArray(run.viewers) ? run.viewers : [],
      // 批㉛段2：Web 发起训练面（train.sh/快照/IterationConfig/prelaunch/摘要四件套）
      launch: run.launch ?? null,
      // 批㉛段3.1：右栏监控面（评估轮 KPI＋环境卡）
      metrics: run.metrics ?? null,
      env: run.env ?? null,
      // 批㉝H：绑卡声明（train.sh CUDA_VISIBLE_DEVICES＞deploy_effective.visible_devices；null＝读不到）
      gpu_binding: run.gpu_binding ?? null,
      // 批㉞H：逐 eval 轮对比面（两轮对比视图数据源；空数组＝无轮产物）
      eval_rounds: Array.isArray(run.eval_rounds) ? run.eval_rounds : [],
      // 批㊶-N N-3：段内进度（additive——过期/缺失 null）
      progress: run.progress ?? null,
      // 批㊶-N N-5：会话绑定集（additive——可空数组）
      bound_sessions: Array.isArray(run.bound_sessions) ? run.bound_sessions : [],
      // 批㊶-P P-2：训练探针（additive——{level,reason,since}，无告警 null；schema v2 续）
      probe: run.probe ?? null,
      training: {
        active: run.training?.active === true,
        points: Array.isArray(run.training?.loss) ? run.training.loss : [],
        pending_confirm: run.training?.pending_confirm ?? null,
      },
    })),
  };
}

/** 批㉝H：全卡聚合显示串——「GPU0 0%/0MiB · GPU1 12%/8429MiB」（空列表 → null，
 *  client 回退首行单卡面）。client.js 有同语义裸服务副本（双份钉子见 tests/dshUi）。 */
export function formatGpuAll(gpuAll) {
  if (!Array.isArray(gpuAll) || gpuAll.length === 0) return null;
  return gpuAll
    .map((c) => `GPU${String(c?.index ?? "?")} ${String(c?.utilization ?? "—")}/${String(c?.memoryUsed ?? "—")}`)
    .join(" · ");
}

/** 批㉝H：绑卡标注——「绑卡：0（train.sh CUDA_VISIBLE_DEVICES）」；缺席/空 → null
 *  （仅显示全卡聚合）。client.js 有同语义裸服务副本（双份钉子见 tests/dshUi）。 */
export function formatGpuBinding(binding) {
  if (binding === null || typeof binding !== "object") return null;
  if (typeof binding.devices !== "string" || binding.devices === "") return null;
  const source = binding.source === "deploy_effective" ? "deploy_effective.visible_devices" : "train.sh CUDA_VISIBLE_DEVICES";
  return `绑卡：${binding.devices}（${source}）`;
}

/**
 * 任务卡 checklist 文本（chat 卡面单源——atf_run_training status 的 output.render 与
 * panel 共用口径）：八段逐行，四态标记 ✓ done／● active／✗ failed／○ pending。
 * @param monitorRun - buildMonitorSnapshot 展开后的单 run 形态（segments 为四态数组）。
 * @returns 多行文本（无尾随换行）。
 */
export function formatTaskCard(monitorRun) {
  const MARKS = { done: "✓", active: "●", failed: "✗", pending: "○" };
  const lines = (monitorRun?.segments ?? []).map((seg) => `${MARKS[seg.status] ?? "○"} ${seg.label}`);
  const doneCount = (monitorRun?.segments ?? []).filter((seg) => seg.status === "done").length;
  const total = (monitorRun?.segments ?? []).length;
  lines.push(`进度 ${doneCount}/${total}`);
  return lines.join("\n");
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
  if (has("launch/launch_manifest.json")) rows.push({ name: "launch manifest（sha 索引）", path: `${run.run_id}/launch/launch_manifest.json`, kind: "json" });
  // 批㉛段3.3：评估产物面（最新轮四件套——按轮目录索引，不重复罗列历史轮）
  const round = run.metrics?.round;
  if (round !== undefined && round !== "latest") {
    rows.push({ name: `eval metrics_summary（${round}）`, path: `${run.run_id}/eval/${round}/orch/eval/metrics_summary.json`, kind: "json" });
  } else if (has("eval/metrics_summary.json")) {
    rows.push({ name: "eval metrics_summary", path: `${run.run_id}/eval/metrics_summary.json`, kind: "json" });
  }
  if (has("eval/badcases.jsonl")) rows.push({ name: "eval badcases.jsonl", path: `${run.run_id}/eval/badcases.jsonl`, kind: "jsonl" });
  if (has("eval/raw_predictions.jsonl")) rows.push({ name: "eval raw_predictions.jsonl", path: `${run.run_id}/eval/raw_predictions.jsonl`, kind: "jsonl" });
  if (has("eval/indexes.csv")) rows.push({ name: "eval indexes.csv", path: `${run.run_id}/eval/indexes.csv`, kind: "csv" });
  // 批㉛段1：viewer 产物行（按 manifest 式发现清单入列，不重复罗列——每变体一行指向 viewer.html）
  for (const dir of run.viewers ?? []) {
    rows.push({ name: `badcase viewer（${dir}）`, path: `${run.run_id}/${dir}/viewer/viewer.html`, kind: "html" });
  }
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

/**
 * 批㉛段2：训练发起消息模板（client『发起训练』对话框单源——chat 通道正道链指令）。
 * DRY_RUN 缺省：确认卡批准 → DRY_RUN 校验（ADMISSION=pass）→ prelaunch 在场检查 →
 * 账本登记核验 → 止步不开真训（真训须 owner 单独书面点头）。真训形态把第⑤条换为
 * 放行执行语义（仍须经 atf_launch_execute 唯一编排执行点）。
 * @param {{run_id: string, mode: "dry_run"|"real", summary?: Array<{key: string, value: string, source: string}>}} plan
 * @returns 多行消息文本。
 */
export function buildTrainLaunchMessage(plan) {
  const runId = plan?.run_id ?? "";
  const real = plan?.mode === "real";
  const lines = [
    `发起训练（${runId} · ${real ? "真实训练" : "DRY_RUN 验收"}）：`,
    "请按 prepare/run SKILL.md 正道链执行并逐步回报：",
    `① atf_config_confirm present（run_id=${runId}）——九要素卡呈我确认${plan?.summary && plan.summary.length > 0 ? `（Web 摘要已核：${plan.summary.filter((r) => r.source === "iteration_config").length} 项来自 IterationConfig，其余为缺省/KB 未校准值，卡面如实标注）` : ""}；`,
    "② 我 Allow once 后：DRY_RUN 校验——DRY_RUN=1 bash 该 run 的 train.sh，输出须含 ADMISSION=pass；",
    "③ prelaunch 报告在场检查（train.sh 同目录 prelaunch*.md|json）——缺失则按 prepare SKILL.md:84 以 build_prelaunch_report.py 生成到 scratch 并回报路径（不回写 run 目录）；",
    "④ 账本登记核验：generate_train_launch.py --record-training-release --config <该 IterationConfig>（已放行过则如实回报 already_recorded），贴 ledger 命中行作登记证据；",
  ];
  if (real) {
    lines.push(
      "⑤ 放行执行：atf_launch_execute（launch_sh=scratch 内 launch.sh，config=同一 IterationConfig，note 注明 owner 书面授权）——唯一编排执行点，manifest sha 对拍 fail-closed；",
    );
  } else {
    lines.push(
      "⑤ 到此止：不执行 atf_launch_execute、不启动 tmux、不占 GPU——本轮仅 DRY_RUN 验收，真实训练候我单独书面点头。",
    );
  }
  return lines.join("\n");
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
