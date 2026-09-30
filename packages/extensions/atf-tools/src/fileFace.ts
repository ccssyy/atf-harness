/**
 * 文件面工具（4 个只读：run_list / report_read / metrics_compare / gpu_status）——
 * 逻辑零重写：直接复用 src/webui/readOnlyTools.ts 的纯函数（listRuns/queryNvidiaSmi），
 * DSH defineTool 包装＋结果 JSON 文本化。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRuns, queryNvidiaSmi } from "../../../../src/webui/readOnlyTools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";

/** metrics_summary 读取（readOnlyTools 内部逻辑的同款复用——读文件 JSON，缺/坏 → null）。 */
const readMetrics = (runsRoot: string, runId: string): Record<string, unknown> | null => {
  const path = join(runsRoot, runId, "report", "metrics_summary.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const buildFileTools = (runsRoot: string): unknown[] => [
  defineTool({
    name: "atf_run_list",
    description: "枚举 runs 目录（只读）：返回各 run 的 run_id/状态/最近产物清单。用于『查看历史 run/总结训练/继续某个训练』等请求。",
    parameters: {},
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute() {
      const runs = await listRuns(runsRoot);
      return asToolValue({ runs, count: runs.length });
    },
  }),
  defineTool({
    name: "atf_report_read",
    description: "读 run 报告（只读）：runs/<run_id>/report/report.md 或指定段 segment-<n>.md。入参 run_id 必填、segment 可选（缺省读 report.md）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（runs 目录名）" },
      segment: { type: "number", description: "段号（缺省读 report.md 全文）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { run_id: string; segment?: number }) {
      const rel = args.segment === undefined ? "report/report.md" : `report/segment-${String(args.segment)}.md`;
      const path = join(runsRoot, args.run_id, rel);
      if (!existsSync(path)) return asToolValue({ run_id: args.run_id, path: rel, exists: false, note: "报告不存在（该 run 无此段记录）" });
      return asToolValue({ run_id: args.run_id, path: rel, exists: true, text: readFileSync(path, "utf8").slice(0, 8000) });
    },
  }),
  defineTool({
    name: "atf_metrics_compare",
    description: "两轮 metrics_summary 对比（只读）：run_a/run_b 必填。任一轮缺 metrics_summary.json 时如实报『无可比轮次』（不造数）。",
    parameters: {
      run_a: { type: "string", required: true, description: "对比左侧 run 标识" },
      run_b: { type: "string", required: true, description: "对比右侧 run 标识" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(args: { run_a: string; run_b: string }) {
      const a = readMetrics(runsRoot, args.run_a);
      const b = readMetrics(runsRoot, args.run_b);
      if (a === null || b === null) {
        return asToolValue({ comparable: false, note: "无可比轮次", missing: [a === null ? args.run_a : null, b === null ? args.run_b : null].filter(Boolean) });
      }
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const diff: Record<string, { a: unknown; b: unknown }> = {};
      for (const key of keys) diff[key] = { a: a[key], b: b[key] };
      return asToolValue({ comparable: true, diff });
    },
  }),
  defineTool({
    name: "atf_gpu_status",
    description: "GPU 状态（只读，nvidia-smi 包装）：利用率/显存/在跑进程 top3。nvidia-smi 不可用时报 gpu_offline（不猜测）。",
    parameters: {},
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute() {
      const queried = await queryNvidiaSmi();
      if (queried === null) return asToolValue({ gpu_offline: true, note: "nvidia-smi 不可用或无 GPU——状态如实上报为离线" });
      return asToolValue({ gpu_offline: false, ...queried });
    },
  }),
];
