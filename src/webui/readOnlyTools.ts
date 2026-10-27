/**
 * 批⑬ v2（2026-09-29）——只读工具组（通用任务面）：atf_run_list / atf_report_read /
 * atf_metrics_compare / atf_gpu_status。全部只读、落审计账（经 AgentTool 面的审批 hook
 * 审计流——requires_approval=false 只读直通亦入事件流）；metrics_compare 超出目录读取
 * 范围时如实报"无可比轮次"（不造数）。
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bucketedRunEntries, flatRunDirNames, hasRunMarkers, resolveRunDir, runFileCandidates, RUN_MARKER_RELS } from "../core/workspace/runLayout.js";
import { captureGpuProbeAsync, formatProbeEvidence, gpuOfflineLabel, type ProbeResult } from "../core/workspace/gpuProbe.js";
import { registeredWorkspaceRoots } from "../core/workspace/workspaceRegistry.js";

/** AgentTool 兼容形状（与 src/agent/atfAgentTools.ts 的 AgentTool 同构——避免循环 import 用结构类型）。 */
export interface ReadOnlyToolDeps {
  runsRoot: string;
  /** RunLayout/v3 canonical 档根清单（缺省＝注册工作区根：v3 canonical run 住
   *  `<ws>/experiments/<exp>/<run_id>`，不带只能查平铺/桶）。 */
  canonicalRoots?: readonly string[];
}

export interface ReadOnlyTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

const textResult = (details: Record<string, unknown>): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => ({
  content: [{ type: "text", text: JSON.stringify(details, ensure_plain_replacer, 1) }],
  details,
});
const ensure_plain_replacer = (_key: string, value: unknown): unknown => value;

/** run 条目状态/产物推导（run 目录特征，不猜——平铺/桶内同码）。
 *  D81-B：导出为 run 面读具状态推导单源（scopeFace 会话作用域枚举同码复用，防双份漂移）。 */
export const deriveRunEntry = (runDir: string, runId: string, workspace: string | null): Record<string, unknown> => {
  // 产物判定按 V2_TO_V3 映射双向探测（v3 形态在前、v2 存量在后——存量 run 继续可读）
  const has = (rel: string): boolean => runFileCandidates(runDir, rel).some((path) => existsSync(path));
  const state = has("webui/config-snapshot.json")
    ? "config_confirmed"
    : has("launch/train.sh")
      ? "launch_ready"
      : has("contract-candidate.json")
        ? "candidate_built"
        : has("registration.json") || has("dataset")
          ? "registered"
          : "pending";
  const artifacts = ["session.jsonl", "contract-candidate.json", "launch/train.sh", "webui/config-snapshot.json"].filter((rel) => has(rel));
  return { run_id: runId, workspace, state, artifacts };
};

export { RUN_MARKER_RELS };

/** 工作区过滤（纯函数——B3；语义：桶名精确匹配；null workspace 仅在不过滤视图出现）。 */
export const filterRunsByWorkspace = (runs: Array<Record<string, unknown>>, workspace: string | null): Array<Record<string, unknown>> =>
  workspace === null ? runs : runs.filter((run) => run["workspace"] === workspace);

/** runs 目录枚举（批㊶-S2 B1 多桶适配——runLayout 单源）：平铺存量＋桶内 run 并集，
 *  条目增 workspace 字段（桶 slug／平铺 null）；桶名目录本身不入列（幻影防护——
 *  有桶内条目的目录即桶，平铺层跳过）。状态推导平铺/桶内同码。 */
export const listRuns = async (runsRoot: string): Promise<Array<Record<string, unknown>>> => {
  if (!existsSync(runsRoot)) return [];
  const root = runsRoot; // 平铺枚举基准（runId 级解析一律走 resolveRunDir——grep join(runsRoot 清零）
  const runs: Array<Record<string, unknown>> = [];
  const buckets = new Set<string>();
  for (const entry of bucketedRunEntries(runsRoot, { skipRunMarkerDirs: true })) {
    if (!hasRunMarkers(entry.dir)) continue; // 桶内无特征目录不入列（幻影防护——桶内即 run 域）
    buckets.add(entry.workspace);
    runs.push(deriveRunEntry(entry.dir, entry.runId, entry.workspace));
  }
  for (const name of flatRunDirNames(runsRoot)) {
    if (buckets.has(name)) continue; // 桶名目录不现（幻影防护）
    runs.push(deriveRunEntry(join(root, name), name, null));
  }
  return runs.sort((a, b) => String(a["run_id"]).localeCompare(String(b["run_id"])));
};

/** metrics_summary 读取（runs/<id>/report/metrics_summary.json；缺 → null）。 */
const readMetrics = async (runsRoot: string, runId: string, canonicalRoots: readonly string[]): Promise<Record<string, unknown> | null> => {
  const path = join(resolveRunDir(runsRoot, runId, { canonicalRoots }), "report", "metrics_summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const makeReadOnlyTools = (deps: ReadOnlyToolDeps): ReadOnlyTool[] => {
  const canonicalRoots = deps.canonicalRoots ?? registeredWorkspaceRoots();
  return [
  {
    name: "atf_run_list",
    label: "atf_run_list",
    description: "枚举 runs 目录（只读）：返回各 run 的 run_id/状态/最近产物清单。用于『查看历史 run/总结训练/继续某个训练』等请求。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_toolCallId: string) => {
      const runs = await listRuns(deps.runsRoot);
      return textResult({ runs, count: runs.length });
    },
  },
  {
    name: "atf_report_read",
    label: "atf_report_read",
    description: "读 run 报告（只读）：runs/<run_id>/report/report.md 或指定段 segment-<n>.md。入参 run_id 必填、segment 可选（缺省读 report.md）。",
    parameters: {
      type: "object",
      properties: { run_id: { type: "string" }, segment: { type: "number" } },
      required: ["run_id"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const runId = String(params["run_id"] ?? "");
      const segment = typeof params["segment"] === "number" ? params["segment"] : undefined;
      const rel = segment === undefined ? "report/report.md" : `report/segment-${String(segment)}.md`;
      const path = join(resolveRunDir(deps.runsRoot, runId, { canonicalRoots }), rel);
      if (!existsSync(path)) return textResult({ run_id: runId, path: rel, exists: false, note: "报告不存在（该 run 无此段记录）" });
      const text = await readFile(path, "utf8");
      return textResult({ run_id: runId, path: rel, exists: true, text: text.slice(0, 8000) });
    },
  },
  {
    name: "atf_metrics_compare",
    label: "atf_metrics_compare",
    description: "两轮 metrics_summary 对比（只读）：run_a/run_b 必填。任一轮缺 metrics_summary.json 时如实报『无可比轮次』（不造数）。",
    parameters: {
      type: "object",
      properties: { run_a: { type: "string" }, run_b: { type: "string" } },
      required: ["run_a", "run_b"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const a = await readMetrics(deps.runsRoot, String(params["run_a"] ?? ""), canonicalRoots);
      const b = await readMetrics(deps.runsRoot, String(params["run_b"] ?? ""), canonicalRoots);
      if (a === null || b === null) {
        return textResult({ comparable: false, note: "无可比轮次", missing: [a === null ? params["run_a"] : null, b === null ? params["run_b"] : null].filter(Boolean) });
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const diff: Record<string, { a: unknown; b: unknown }> = {};
      for (const key of keys) diff[key] = { a: a[key], b: b[key] };
      return textResult({ comparable: true, diff });
    },
  },
  {
    name: "atf_gpu_status",
    label: "atf_gpu_status",
    description: "GPU 状态（只读，nvidia-smi 包装）：利用率/显存/在跑进程 top3。nvidia-smi 不可用时报 gpu_offline（不猜测）。",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_toolCallId: string) => {
      const view = await queryNvidiaSmiProbed();
      if (view.gpu === null) return textResult(gpuOfflinePayload(view.probe));
      return textResult({ gpu_offline: false, ...view.gpu });
    },
  },
  ];
};

export interface GpuStatus {
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
  topProcesses: string[];
}

/** 单卡状态（批㉝H 多卡聚合面——monitor.json gpu_all 逐卡条目）。
 *  D11-2：纯增可选温度/功耗（[N/A]/空/非数值 → null，不填 0 不猜——旧四字段零改）。 */
export interface GpuCardStatus {
  index: string;
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
  temperature?: number | null;
  powerDraw?: number | null;
}

/** 数值化单元格（D11-2）：[N/A]/空/非有限数值 → null（不猜）；「42.」类尾点由 Number 判定。 */
const numericCell = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const token = raw.trim();
  if (token === "" || token.toUpperCase() === "[N/A]" || token === "N/A") return null;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
};

/** nvidia-smi 全卡输出解析（纯函数，vitest 直测）：`index,util,used,total[,temp[,power]]` 逐行
 *  → 逐卡列表；无有效行 → null（调用方如实报离线不猜测）。温度/功耗列缺席（旧输出）＝
 *  undefined → null，向后兼容。 */
export const parseNvidiaSmiAll = (stdout: string): GpuCardStatus[] | null => {
  const cards: GpuCardStatus[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (line === "") continue;
    const cell = line.split(",").map((c) => c.trim());
    if (cell.length < 4) continue;
    cards.push({
      index: cell[0]!,
      utilization: `${cell[1]!}%`,
      memoryUsed: `${cell[2]!}MiB`,
      memoryTotal: `${cell[3]!}MiB`,
      temperature: numericCell(cell[4]),
      powerDraw: numericCell(cell[5]),
    });
  }
  return cards.length > 0 ? cards : null;
};

/** nvidia-smi 全卡查询（逐卡列表；不可用/非零退出 → null，调用方如实报离线不猜测）。
 *  与 queryNvidiaSmi（首行单卡面，atf_gpu_status 工具面保持零变化）分立采集。
 *  D11-2：查询串纯增 temperature.gpu,power.draw（[N/A] 原样回 → 解析层 null 化）。 */
export const queryNvidiaSmiAll = async (): Promise<GpuCardStatus[] | null> => {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "nvidia-smi",
        ["--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
        { timeout: 5_000 },
        (error, stdoutText) => (error === null ? resolve(stdoutText) : reject(error)),
      );
    });
    return parseNvidiaSmiAll(stdout);
  } catch {
    return null;
  }
};

// ── 批㊶-W F6 ④：compute-apps 进程归属（gpu_uuid → 卡 index 对表；10GB 固定阈值退役）──

/** 单条 compute-apps 进程（归属判定输入；gpuIndex 由 gpu_uuid 对表派生，对不上＝null）。 */
export interface GpuComputeApp {
  pid: string;
  processName: string;
  usedMemory: string;
  gpuIndex: string | null;
}

/** compute-apps 输出＋index/uuid 对表解析（纯函数）：pid,process_name,used_memory,gpu_uuid
 *  逐行 × index,gpu_uuid 对表 → 进程归属卡号。两输出任一无效 → null（不猜）。 */
export const parseComputeAppsWithIndex = (appsOut: string, indexOut: string): GpuComputeApp[] | null => {
  const uuidToIndex = new Map<string, string>();
  for (const line of indexOut.trim().split("\n")) {
    if (line === "") continue;
    const cell = line.split(",").map((c) => c.trim());
    if (cell.length < 2) continue;
    uuidToIndex.set(cell[1]!, cell[0]!);
  }
  if (uuidToIndex.size === 0) return null;
  const apps: GpuComputeApp[] = [];
  for (const line of appsOut.trim().split("\n")) {
    if (line === "") continue;
    const cell = line.split(",").map((c) => c.trim());
    if (cell.length < 4) continue;
    apps.push({ pid: cell[0]!, processName: cell[1]!, usedMemory: cell[2]!, gpuIndex: uuidToIndex.get(cell[3]!) ?? null });
  }
  return apps;
};

/** compute-apps 查询（进程归属真源；nvidia-smi 不可用 → null 不猜测）。 */
export const queryGpuComputeApps = async (): Promise<GpuComputeApp[] | null> => {
  try {
    const [appsOut, indexOut] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        execFile("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory,gpu_uuid", "--format=csv,noheader"], { timeout: 5_000 }, (error, text) =>
          error === null ? resolve(text) : reject(error),
        );
      }),
      new Promise<string>((resolve, reject) => {
        execFile("nvidia-smi", ["--query-gpu=index,gpu_uuid", "--format=csv,noheader"], { timeout: 5_000 }, (error, text) =>
          error === null ? resolve(text) : reject(error),
        );
      }),
    ]);
    return parseComputeAppsWithIndex(appsOut, indexOut);
  } catch {
    return null;
  }
};

/** 每卡进程 top1（D11-2 纯函数）：parseComputeAppsWithIndex 产物 → gpuIndex → 显存最大进程
 *  { pid, name, memMiB }（usedMemory MiB 数值化，非数值行不参与）；无归属/空列表 → 空 Map
 *  （调用方如实「—」不猜）。复用钉：进程解析只有 parseComputeAppsWithIndex 一处，本函数
 *  只做归约不碰 nvidia-smi 输出形态。 */
export const gpuProcTopByIndex = (
  apps: GpuComputeApp[],
): Map<string, { pid: string; name: string; memMiB: number }> => {
  const top = new Map<string, { pid: string; name: string; memMiB: number }>();
  for (const app of apps) {
    if (app.gpuIndex === null) continue;
    const mem = Number(app.usedMemory.trim());
    if (!Number.isFinite(mem)) continue;
    const cur = top.get(app.gpuIndex);
    if (cur === undefined || mem > cur.memMiB) {
      top.set(app.gpuIndex, { pid: app.pid, name: app.processName, memMiB: mem });
    }
  }
  return top;
};

/** nvidia-smi 查询（不可用/非零退出 → null，调用方如实报离线）。
 *  D88-A：底层改走三态探针（gpuProbe.ts）——**展示面不判致命性**，只据探针状态选文案；
 *  需要区分「探测超时」与「不可达」的调用方用 queryNvidiaSmiProbed / gpuOfflinePayload。 */
export const queryNvidiaSmi = async (): Promise<GpuStatus | null> => (await queryNvidiaSmiProbed()).gpu;

/** 展示面探针参数（预算＝GPU_PROBE_DISPLAY_DEFAULT_BUDGET_MS 10s／ATF_GPU_PROBE_TIMEOUT_MS；
 *  与启动闸同一变量、各自缺省——结构上排除「卡面说离线但机器好」）。 */
const GPU_QUERY_ARGS: readonly string[] = [
  "--query-gpu=utilization.gpu,memory.used,memory.total",
  "--format=csv,noheader,nounits",
];

/** 探针＋首行单卡面（同一份探针数据；gpu=null 时 probe 说明为什么离线）。 */
export interface GpuStatusView {
  gpu: GpuStatus | null;
  probe: ProbeResult;
}

/** 探针驱动的单卡查询（展示面单源）：探针非 ok → 原样把 probe 状态交给调用方选文案，
 *  **不复用缓存**（一次超时不该被缓存永久钉在卡面上）。 */
export const queryNvidiaSmiProbed = async (): Promise<GpuStatusView> => {
  const { result: probe, stdout } = await captureGpuProbeAsync({ args: GPU_QUERY_ARGS, env: process.env });
  if (probe.status !== "ok") return { gpu: null, probe };
  const first = stdout.trim().split("\n")[0]?.split(",") ?? [];
  if (first.length < 3) {
    // 命令回了但输出不可解析＝确定态失败（不是 timeout，别混进超时文案）
    return {
      gpu: null,
      probe: { status: "failed", code: "unparsable_output", stderr: stdout.slice(0, 200), elapsedMs: probe.elapsedMs },
    };
  }
  let processes: string[] = [];
  try {
    const procOut = await new Promise<string>((resolve, reject) => {
      execFile("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"], { timeout: 5_000 }, (error, text) =>
        error === null ? resolve(text) : reject(error),
      );
    });
    processes = procOut.trim().split("\n").filter((line) => line !== "").slice(0, 3);
  } catch {
    processes = [];
  }
  return {
    gpu: {
      utilization: `${(first[0] ?? "").trim()}%`,
      memoryUsed: `${(first[1] ?? "").trim()} MiB`,
      memoryTotal: `${(first[2] ?? "").trim()} MiB`,
      topProcesses: processes,
    },
    probe,
  };
};

/** 离线载荷（两处 atf_gpu_status 展示面单源）：timeout 与不可达**必须可区分**——
 *  前者指向负载/预算（「探测超时」），后者指向驱动/可见性（「不可达」），并带探针证据。 */
export const gpuOfflinePayload = (probe: ProbeResult): Record<string, unknown> => {
  const timedOut = probe.status === "timeout";
  return {
    gpu_offline: true,
    offline_reason: timedOut ? "timeout" : "unreachable",
    offline_label: gpuOfflineLabel(probe),
    note: timedOut
      ? `nvidia-smi 探活超时（${formatProbeEvidence(probe)}）——是否可见未证实：按「${gpuOfflineLabel(probe)}」上报，先查负载/预算，不要按驱动故障排查`
      : `nvidia-smi 不可达或无 GPU（${formatProbeEvidence(probe)}）——按「${gpuOfflineLabel(probe)}」如实上报，不猜测`,
    probe_status: probe.status,
    probe_evidence: formatProbeEvidence(probe),
  };
};

/** AgentTool 装配（结构对齐 src/agent 的 AgentTool：name/description/parameters/execute）。 */
export const buildReadOnlyAgentTools = (deps: ReadOnlyToolDeps): ReadOnlyTool[] => makeReadOnlyTools(deps);
