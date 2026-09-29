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

/** AgentTool 兼容形状（与 src/agent/atfAgentTools.ts 的 AgentTool 同构——避免循环 import 用结构类型）。 */
export interface ReadOnlyToolDeps {
  runsRoot: string;
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

/** runs 目录枚举（run_id/状态/最近产物——status 从 run 目录特征推导，不猜）。 */
export const listRuns = async (runsRoot: string): Promise<Array<Record<string, unknown>>> => {
  if (!existsSync(runsRoot)) return [];
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsRoot, entry.name);
    const has = (rel: string): boolean => existsSync(join(runDir, rel));
    const state = has("webui/config-snapshot.json")
      ? "config_confirmed"
      : has("launch/train.sh")
        ? "launch_ready"
        : has("contract-candidate.json")
          ? "candidate_built"
          : has("registration.json") || has("dataset")
            ? "registered"
            : "unknown";
    const artifacts = ["session.jsonl", "contract-candidate.json", "launch/train.sh", "webui/config-snapshot.json"].filter((rel) => has(rel));
    runs.push({ run_id: entry.name, state, artifacts });
  }
  return runs.sort((a, b) => String(a["run_id"]).localeCompare(String(b["run_id"])));
};

/** metrics_summary 读取（runs/<id>/report/metrics_summary.json；缺 → null）。 */
const readMetrics = async (runsRoot: string, runId: string): Promise<Record<string, unknown> | null> => {
  const path = join(runsRoot, runId, "report", "metrics_summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const makeReadOnlyTools = (deps: ReadOnlyToolDeps): ReadOnlyTool[] => [
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
      const path = join(deps.runsRoot, runId, rel);
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
      const a = await readMetrics(deps.runsRoot, String(params["run_a"] ?? ""));
      const b = await readMetrics(deps.runsRoot, String(params["run_b"] ?? ""));
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
      const queried = await queryNvidiaSmi();
      if (queried === null) return textResult({ gpu_offline: true, note: "nvidia-smi 不可用或无 GPU——状态如实上报为离线" });
      return textResult({ gpu_offline: false, ...queried });
    },
  },
];

export interface GpuStatus {
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
  topProcesses: string[];
}

/** nvidia-smi 查询（不可用/非零退出 → null，调用方如实报离线）。 */
export const queryNvidiaSmi = async (): Promise<GpuStatus | null> => {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "nvidia-smi",
        ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 5_000 },
        (error, stdoutText) => (error === null ? resolve(stdoutText) : reject(error)),
      );
    });
    const first = stdout.trim().split("\n")[0]?.split(",") ?? [];
    if (first.length < 3) return null;
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
      utilization: `${(first[0] ?? "").trim()}%`,
      memoryUsed: `${(first[1] ?? "").trim()} MiB`,
      memoryTotal: `${(first[2] ?? "").trim()} MiB`,
      topProcesses: processes,
    };
  } catch {
    return null;
  }
};

/** AgentTool 装配（结构对齐 src/agent 的 AgentTool：name/description/parameters/execute）。 */
export const buildReadOnlyAgentTools = (deps: ReadOnlyToolDeps): ReadOnlyTool[] => makeReadOnlyTools(deps);
