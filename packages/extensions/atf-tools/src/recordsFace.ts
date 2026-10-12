/**
 * 批㊶-S1 §6.2 D2——atf_records.query 一等只读工具（跨域读取语义化）。
 * 参数＝任务标识（workspace/run 名）；路径翻译 harness 完成（卡面无路径裸串）。
 * 需用户点头时走 U 形式双段问题卡（人话卡面）；登记不 bump。豁免登记（用户点名）会话内留痕可回看。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { asToolValue, looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";
import { dualStageNote } from "./confirmFace.js";

/** 豁免登记落点（run 工作区 webui/records-exemptions.json——append 留痕可回看）。 */
export const exemptionsPathOf = (runWorkspace: string): string => join(runWorkspace, "webui", "records-exemptions.json");

export const readExemptions = (runWorkspace: string): Array<{ task_id: string; granted_at: string; via: string }> => {
  const path = exemptionsPathOf(runWorkspace);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is { task_id: string; granted_at: string; via: string } =>
      e !== null && typeof e === "object" && typeof (e as { task_id?: unknown }).task_id === "string") : [];
  } catch {
    return [];
  }
};

/** 点名豁免登记（append 留痕；幂等去重）。 */
export const grantExemption = (runWorkspace: string, taskId: string, via: string): void => {
  const entries = readExemptions(runWorkspace);
  if (entries.some((e) => e.task_id === taskId)) return;
  entries.push({ task_id: taskId, granted_at: new Date().toISOString(), via });
  mkdirSync(dirname(exemptionsPathOf(runWorkspace)), { recursive: true });
  writeFileSync(exemptionsPathOf(runWorkspace), `${JSON.stringify(entries, null, 1)}\n`, "utf8");
};

/** 任务标识 → 目录翻译（harness 完成路径解析；卡面不出现路径裸串）。 */
export const resolveTaskDir = (runsRoot: string, workspace: string | undefined, runName: string): string | null => {
  const flat = join(runsRoot, runName);
  if (existsSync(flat)) return flat;
  if (workspace !== undefined) {
    const bucketed = join(runsRoot, workspace, runName);
    if (existsSync(bucketed)) return bucketed;
  }
  try {
    for (const bucket of readdirSync(runsRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      const cand = join(runsRoot, bucket.name, runName);
      if (existsSync(cand)) return cand;
    }
  } catch { /* runsRoot 不可读＝null */ }
  return null;
};

/** 读取目标 run 的记录摘要（human_summary notes／report 首段——只读面）。 */
const readRecordDigest = (taskDir: string): { report_head: string | null; notes: string | null } => {
  let reportHead: string | null = null;
  const reportPath = join(taskDir, "report", "report.md");
  if (existsSync(reportPath)) {
    try { reportHead = readFileSync(reportPath, "utf8").slice(0, 600); } catch { /* 读失败如实 null */ }
  }
  let notes: string | null = null;
  const summaryPath = join(taskDir, "human_summary.json");
  if (existsSync(summaryPath)) {
    try { notes = readFileSync(summaryPath, "utf8").slice(0, 600); } catch { /* 同上 */ }
  }
  return { report_head: reportHead, notes };
};

/** atf_records.query 工具（U 双段式问题卡确认——跨域读取需用户点头；点名豁免后免打扰）。 */
export function buildRecordsQueryTool(ctx: { get(service: string): unknown }, cfg: { runsRoot: string; currentRunWorkspace?: () => string | null }): unknown {
  return defineTool({
    name: "atf_records_query",
    description:
      "跨任务记录语义化读取（只读一等工具，批㊶-S1 §6.2 D2）：参数＝任务标识（workspace 可选＋run 名），路径翻译由 harness 完成（对话与卡面不出现路径裸串）。跨出当前工作区的读取需用户点头（U 形式双段问题卡人话确认：「要参考训练任务 X 的记录吗」）；用户在消息中明确点名的任务标识自动登记豁免（同会话后续读取免打扰，登记留痕可回看）。登记不 bump。",
    parameters: {
      task_run: { type: "string", required: true, description: "任务 run 名（如 run-regress-formal-01）" },
      task_workspace: { type: "string", description: "任务工作区桶名（可选——缺省自动全桶扫描）" },
      note: { type: "string", description: "读取目的（入确认卡与豁免留痕）" },
    },
    output: { schema: looseObjectOutput, render: renderAsJsonText },
    presentCall: function(args: { task_run: string }) {
      return { card: "generic" as const, title: `跨任务记录读取 — ${args.task_run}`, kind: "other" as const };
    },
    async execute(args: { task_run: string; task_workspace?: string; note?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      const taskDir = resolveTaskDir(cfg.runsRoot, args.task_workspace, args.task_run);
      if (taskDir === null) {
        return asToolValue({ ok: false, error: "task_not_found", task_run: args.task_run, note: "任务标识未命中任何 run（平铺或桶内）——请用户确认任务名" });
      }
      const currentWs = cfg.currentRunWorkspace?.() ?? null;
      const crossWorkspace = currentWs !== null && !taskDir.startsWith(currentWs);
      const exemptions = currentWs !== null ? readExemptions(currentWs) : [];
      const exempt = exemptions.some((e) => e.task_id === args.task_run);
      if (crossWorkspace && !exempt) {
        // U 双段式问题卡：人话确认（卡面无路径裸串——只有任务标识与目的）
        const verdict = await requestApproval(ctx, exec, "atf_records_query",
          dualStageNote("跨任务记录读取确认", { extra: `要参考训练任务「${args.task_run}」的记录吗？${args.note !== undefined ? `（目的：${args.note}）` : ""}允许＝本次读取并登记豁免（同会话后续免打扰）；拒绝＝不读取。` }));
        if (!verdict.ok) return approvalDeniedResult("atf_records_query", verdict.outcome);
        if (currentWs !== null) grantExemption(currentWs, args.task_run, `atf_records_query${args.note !== undefined ? `（${args.note}）` : ""}`);
      }
      const digest = readRecordDigest(taskDir);
      return asToolValue({
        ok: true,
        task_run: args.task_run,
        ...(args.task_workspace !== undefined ? { task_workspace: args.task_workspace } : {}),
        exempt,
        ...digest,
        note: "路径翻译由 harness 完成（本结果不含绝对路径）；豁免登记留痕 webui/records-exemptions.json",
      });
    },
  });
}
