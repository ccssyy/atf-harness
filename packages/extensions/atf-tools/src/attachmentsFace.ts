/**
 * atf_attachments_assembly——T2 附件装配的 harness 呈现与修订入口。
 *
 * 内核装配器（skill atf-ingest-attachments）只产确定性产物：`assembly-report.json` 与六节
 * 方案稿，**不弹卡、不做业务决策**（SKILL「三层分工」）。呈现与修订转达由本工具承担：
 * - `action=review`：读装配结果 → 按档位二分呈现（两档结果一致，只改呈现）：
 *   · 非完全授权档 → 原生 options＋multiSelect 确认卡（可勾掉判错的项，勾掉后由 agent
 *     追问「那它到底是什么」，再经 `action=revise` 转成内核修订调用）；
 *   · 完全授权档（预设 atf-training ＋权限档 danger-full-access）→ 不弹卡，一行汇报 +
 *     落 `<ws>/analysis/attachments-report.md`（业务话 markdown，不是 JSON 转贴）。
 * - `action=revise`：把「d3 不是抽取说明，是输出模板」转成内核
 *   `run_assembly.py revise --id d3 --to template --reason …`，并把返回的修订条目在对话里
 *   回报一句话（**不自作判断、不重放**：判断权在内核，冲突由内核 fail-closed 裁决）。
 *
 * 失败面：报告不存在＝「装配结果未找到」；字段缺＝「装配结果不完整，缺 X」；`degraded[]`
 * 非空＝逐条列出哪几项没验成与原因。三条都如实回传，不静默成功、不自行解包或猜。
 *
 * 免审批：本工具只读报告 + 触发内核装配/修订（数据整理面，不占 GPU、不发布、不改训练参数），
 * 用户意愿由卡面/对话表达，落盘范围限 `<ws>/analysis` 与 `<ws>/datasets`（内核脚本自身边界）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { type ChoiceAskQuestion, type FormAskService } from "./confirmFace.js";
import { runPipeline } from "./pipelineFace.js";
import { isTrainingAutopilot } from "./trainingPreset.js";
import {
  ASSEMBLY_ROLES,
  MISSING_IMPACT,
  ROLE_BUSINESS,
  confidenceBandOf,
  CONFIDENCE_WORD,
  readAssemblyReport,
  renderAssemblyCardDetail,
  renderAssemblySummaryLine,
  renderAttachmentsMarkdown,
  needsUserConfirmation,
  type AssemblyReport,
  type AssemblyRole,
} from "../../../../src/core/workspace/attachmentsReport.js";

/** 装配结果落点（内核 `_analysis_dir` 同构：`<ws>/analysis/<name>/`）。 */
export const assemblyReportPathOf = (workspacePath: string, name: string): string =>
  join(workspacePath, "analysis", name, "assembly-report.json");

/** 完全授权档的汇报文件落点。 */
export const attachmentsReportPathOf = (workspacePath: string): string =>
  join(workspacePath, "analysis", "attachments-report.md");

/** 内核整理脚本（pin 内技能包；缺席即 fail-closed，不 mock）。 */
const ingestScriptOf = (kernelDir: string): string =>
  join(kernelDir, "skills", "atf-ingest-attachments", "scripts", "run_assembly.py");

/** 判断编号 → 「第 N 项」（用户面说法；d3 → 3）。 */
const ordinalOf = (id: string): string => {
  const match = /^d(\d+)$/.exec(id.trim());
  return match === null ? id : `第 ${match[1]} 项`;
};

/** 角色中文名（未知角色回退原值，不造词）。 */
const roleBusinessOf = (role: string): string => ROLE_BUSINESS[role as AssemblyRole] ?? role;

export const buildAttachmentsTool = (
  ctx: { get(service: string): unknown },
  deps: { kernelDir: string; timeoutMs?: number },
): unknown => {
  const script = ingestScriptOf(deps.kernelDir);
  const timeoutMs = deps.timeoutMs ?? 120_000;

  /** 卡面选项：一项判断一条（label 供勾选，description 给把握度与并列候选）。 */
  const optionsOf = (report: AssemblyReport) =>
    report.identified.map((item) => {
      const band = confidenceBandOf(item.confidence);
      const uncertain = needsUserConfirmation(item.confidence) ? "这一项我不太确定，你确认一下" : undefined;
      const alt = item.alternatives.length > 0
        ? `也可能${item.alternatives.map((role) => roleBusinessOf(role)).join("／")}`
        : undefined;
      const note = [alt, uncertain].filter((text): text is string => text !== undefined).join("；");
      return {
        label: `${item.id}｜${item.roleLabel} ${String(item.pathCount)} 个（${CONFIDENCE_WORD[band]}）`,
        ...(note === "" ? {} : { description: note }),
      };
    });

  return defineTool({
    name: "atf_attachments_assembly",
    description:
      "素材装配结果的呈现与修订（数据整理面，免审批）：" +
      "action=review 读 `<workspace_path>/analysis/<name>/assembly-report.json`，按档位二分呈现——" +
      "非完全授权档弹一张选择卡（列出「单据图像 438 个」这类业务话，用户可勾掉判错的项；缺口与未读到项一并呈现），" +
      "完全授权档（预设 atf-training＋完全权限）不弹卡，直接一句话汇报并把业务话版本落到 " +
      "`<workspace_path>/analysis/attachments-report.md`；两档读同一份报告、结果一致，只改呈现。" +
      "action=revise 把用户的一句话（如「d3 不是抽取说明，是输出模板」）转成内核修订调用" +
      "（--id d3 --to template --reason …），只重放落地步骤，冲突由内核裁决并如实回传。" +
      "失败面：装配结果未找到／装配结果不完整（缺哪一项）／未读到的信息逐条列出——都不静默成功、不自行解包或猜。" +
      "注意：role（images/records/instructions/field_config/template/auxiliary）是内部口径，**不要原样念给用户**——" +
      "用户面说法见卡面或本工具返回的 role_label。",
    parameters: {
      workspace_path: { type: "string", required: true, description: "工作区根（绝对路径——装配器 --workspace 同值）" },
      name: { type: "string", required: true, description: "数据集名称（装配器 --name 同值；报告落 <ws>/analysis/<name>/）" },
      action: {
        type: "string",
        enum: ["review", "revise"],
        description: "review＝呈现装配结果（缺省）；revise＝按用户指认改一条判断并重放落地",
      },
      report_path: { type: "string", description: "装配结果路径（缺省按 <ws>/analysis/<name>/assembly-report.json 定位；给显式路径时以它为准）" },
      id: { type: "string", description: "revise 用：判断编号（如 d3；用户指着编号说话时的那个编号）" },
      to: { type: "string", enum: [...ASSEMBLY_ROLES], description: "revise 用：改成哪一类（内部口径，仅作参数；对用户说中文名）" },
      reason: { type: "string", description: "revise 用：用户给的原因原话（不改写、不概括掉关键信息）" },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: {
        workspace_path?: string;
        name?: string;
        action?: string;
        report_path?: string;
        id?: string;
        to?: string;
        reason?: string;
      },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      const workspacePath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (workspacePath === "" || name === "") {
        return asToolValue({ ok: false, error: "args_missing", note: "workspace_path 与 name 必填（与装配器 --workspace/--name 同值）" });
      }
      const action = args.action === "revise" ? "revise" : "review";

      // ---------------- revise：转成内核修订调用 ----------------
      if (action === "revise") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        if (id === "" || to === "" || reason === "") {
          return asToolValue({
            ok: false,
            error: "revise_args_missing",
            note: "revise 需要 id（哪一条判断）、to（改成哪一类）、reason（用户给的原因）三项——缺一项就会变成 harness 替用户做决定，故拒",
          });
        }
        if (!(ASSEMBLY_ROLES as readonly string[]).includes(to)) {
          return asToolValue({
            ok: false,
            error: "revise_target_unknown",
            note: `改成哪一类不认识（${to}）——可用：${ASSEMBLY_ROLES.map((role) => roleBusinessOf(role)).join("、")}`,
          });
        }
        const ran = await runPipeline(
          `python3 ${script}`,
          ["revise", "--workspace", workspacePath, "--name", name, "--id", id, "--to", to, "--reason", reason],
          timeoutMs,
        );
        let parsed: Record<string, unknown> | null = null;
        try {
          const parsedRaw = JSON.parse(ran.stdout) as unknown;
          parsed = parsedRaw !== null && typeof parsedRaw === "object" && !Array.isArray(parsedRaw) ? (parsedRaw as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        if (parsed === null) {
          return asToolValue({
            ok: false,
            error: ran.code === null ? "revise_timeout" : "revise_failed",
            exit_code: ran.code,
            stdout_head: ran.stdout.trim().slice(0, 300),
            stderr_tail: ran.stderr.trim().slice(-600),
            note: "内核修订没有返回可解析结果——方案未确认改动，请把 stderr 原文如实告知用户（不猜、不重放）",
          });
        }
        if (parsed["error"] === "revision_conflict") {
          const conflicts = Array.isArray(parsed["conflicts"]) ? (parsed["conflicts"] as unknown[]) : [];
          const lines = conflicts.map((entry) => {
            const row = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
            const check = typeof row["check"] === "string" ? row["check"] : "";
            const detail = typeof row["detail"] === "string" ? row["detail"] : "";
            return [check, detail].filter((text) => text !== "").join("：");
          });
          return asToolValue({
            ok: false,
            error: "revision_conflict",
            conflicts,
            note: `这次改不了，因为和已有事实矛盾：${lines.length === 0 ? "（内核未给出细项）" : lines.join("；")}——方案一个字都没改，请先确认指认或补齐缺口`,
          });
        }
        const revision = (parsed["revision"] ?? null) as Record<string, unknown> | null;
        const from = revision === null ? "" : String(revision["from"] ?? "");
        const toRole = revision === null ? to : String(revision["to"] ?? to);
        const version = typeof parsed["version"] === "string" ? parsed["version"] : "";
        const landing = typeof parsed["landing"] === "string" ? parsed["landing"] : "";
        const line = `已按你说的把${ordinalOf(id)}改成「${roleBusinessOf(toRole)}」${version === "" ? "" : `，重新落地了，新版本 ${version}`}${landing === "" ? "" : `（${landing}）`}`;
        return asToolValue({
          ok: true,
          action: "revise",
          summary_line: line,
          revision: { id, from: roleBusinessOf(from), to: roleBusinessOf(toRole), reason },
          version,
          landing,
          replayed: parsed["replayed"] === true,
          plan_path: typeof parsed["plan_path"] === "string" ? parsed["plan_path"] : "",
          note: "修订已由内核记录并只重放受影响的落地步骤；把这个结果用一句话告诉用户即可，不要自行改判或重放",
        });
      }

      // ---------------- review：读报告 → 按档位呈现 ----------------
      const reportPath = typeof args.report_path === "string" && args.report_path.trim() !== ""
        ? args.report_path.trim()
        : assemblyReportPathOf(workspacePath, name);
      const parsedReport = readAssemblyReport(reportPath);
      if (!parsedReport.ok) {
        return asToolValue({
          ok: false,
          error: parsedReport.error,
          report_path: reportPath,
          ...(parsedReport.error === "assembly_report_incomplete" ? { missing_field: parsedReport.missing } : {}),
          note: parsedReport.note,
        });
      }
      const report = parsedReport.report;
      const detail = renderAssemblyCardDetail(report);
      const summaryLine = renderAssemblySummaryLine(report);
      const degradedLines = report.degraded.length === 0 ? [] : report.degraded.map((entry) => `${entry.path === "" ? "（未具名文件）" : entry.path}：${entry.reason}`);

      // 完全授权档：不弹卡（两档结果一致——同一份报告、同一套业务话，只是不问）
      if (isTrainingAutopilot(ctx, exec)) {
        const filePath = attachmentsReportPathOf(workspacePath);
        let written: string | null = null;
        try {
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, renderAttachmentsMarkdown(report), "utf8");
          written = filePath;
        } catch (cause) {
          return asToolValue({
            ok: false,
            error: "attachments_report_unwritable",
            report_path: reportPath,
            detail,
            note: `一行汇报已可给用户，但业务话版本落盘失败（${filePath}）：${String(cause).slice(0, 160)}——请如实告知用户「报告没写成」`,
          });
        }
        return asToolValue({
          ok: true,
          mode: "report_only",
          summary_line: summaryLine,
          report_path: reportPath,
          report_file: written,
          identified: report.identified.map((item) => ({ id: item.id, role_label: item.roleLabel, path_count: item.pathCount })),
          missing: report.missing.map((entry) => ({ role_label: roleBusinessOf(entry.role), detail: entry.detail })),
          degraded_lines: degradedLines,
          note: "完全授权档不弹卡：把 summary_line 原样告诉用户即可（一行汇报），细节在 report_file",
        });
      }

      // 非完全授权档：弹确认卡（原生 options + multiSelect）
      const svc = ctx.get("userQuestions") as FormAskService | undefined;
      if (svc === undefined || typeof svc.ask !== "function") {
        return asToolValue({
          ok: false,
          error: "user_questions_unavailable",
          report_path: reportPath,
          detail,
          summary_line: summaryLine,
          note: "确认卡通道不可用（user-questions 服务未挂载）——不静默按「全部正确」继续：请把上面的识别结果与缺口如实告知用户，让用户口头确认或指认",
        });
      }
      const options = optionsOf(report);
      // 选项卡：原生 options + multiSelect（不设 intent——intent 只用于 form/plan-review）
      const question: ChoiceAskQuestion = {
        id: `attachments-${name}`,
        question: `素材整理结果确认 — ${name}`,
        header: "素材整理",
        detail,
        options,
        multiSelect: true,
      };
      let answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> };
      try {
        answers = await svc.ask({
          questions: [question],
          agent: exec.agent,
          signal: exec.signal,
        });
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        if (code === "ASK_CANCELLED") {
          return asToolValue({
            ok: true,
            mode: "card",
            cancelled: true,
            report_path: reportPath,
            detail,
            summary_line: summaryLine,
            note: "用户关掉了确认卡（未确认任何判断）——按「未确认」处理：不要据此继续落地，也不要替用户假定判断成立",
          });
        }
        return asToolValue({
          ok: false,
          error: "card_ask_failed",
          report_path: reportPath,
          detail,
          note: `确认卡应答失败：${String(cause).slice(0, 200)}——请把识别结果与缺口如实告知用户，让用户口头确认或指认`,
        });
      }
      const selected = answers.answers.flatMap((answer) => [...answer.selected]);
      const confirmed = report.identified.filter((item) => selected.some((label) => label.startsWith(`${item.id}｜`)));
      const disputed = report.identified.filter((item) => !confirmed.includes(item));
      return asToolValue({
        ok: true,
        mode: "card",
        report_path: reportPath,
        confirmed: confirmed.map((item) => ({ id: item.id, role_label: item.roleLabel, path_count: item.pathCount })),
        disputed: disputed.map((item) => ({ id: item.id, role_label: item.roleLabel, path_count: item.pathCount })),
        missing: report.missing.map((entry) => ({ role_label: roleBusinessOf(entry.role), detail: entry.detail, impact: MISSING_IMPACT[entry.role] })),
        degraded_lines: degradedLines,
        ...(disputed.length > 0
          ? {
              revise_choices: disputed.map((item) => ({ id: item.id, current_role_label: item.roleLabel })),
              revise_hint: "勾掉的项要问用户「那它到底是什么」，拿到答案后调 action=revise（id/to/reason 三项齐全），不要自己改判",
            }
          : {}),
        note: disputed.length === 0
          ? "用户确认全部判断成立——可以继续下一步（缺口按 missing 里的说明请用户补）"
          : "有判断被勾掉：逐项问清它实际是哪一类，再用 action=revise 转成内核修订（不要自行改判或重放）",
      });
    },
  });
};
