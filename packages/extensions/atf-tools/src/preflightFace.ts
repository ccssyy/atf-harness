/**
 * F1（首跑体验批）——atf_training_preflight 工具面（训练链入口预检单卡）。
 *
 * 指令《ATF_指令_首跑体验F1_预检单卡_20261024》§二 harness 1/2：
 * - 读内核 tools/training_preflight.py 输出（固定 schema——校验/渲染单源
 *   src/core/workspace/trainingPreflight.ts），渲染三态清单（missing/derivable/
 *   needs_confirm，按依赖链 order 序）。
 * - apply=true 或预检卡上勾选执行 → 经 DSH 审批卡放行后触发内核 --apply
 *   （对 derivable 项一键执行：坐标批处理整批重试／内置 provider 计量生成预算）。
 *   授权恒在审批卡（表单卡只收决策不承载授权——confirmFace F5 同纪律）。
 * - needs_confirm 项合并一张 form 卡收集（不逐项弹）；decisions 结构化回传，
 *   由 agent 转后续段参数（自由文本永不直达生成面）。
 * - KPI：预检成功即记首次 preflight 时间戳（launch-kpi.json——首写固定）。
 * - 预检只是把「缺什么」提前聚合：不替代各段既有校验（防御纵深不变），
 *   不是段、不进 STAGE_ORDER、不进 bridge 契约面。
 *
 * 脚本参数面假设（内核脚本落地前按此开发，re-pin 集成时对账）：
 * `training_preflight.py --run-dir <abs> [--apply]`（stdout＝固定 schema JSON）。
 * pin 未含脚本时工具如实报 preflight_script_missing（fail-closed，不 mock 不猜）；
 * confirmFace 前置预检在脚本缺席时跳过（九要素链现状零回归）。
 */
import { existsSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { runPipeline } from "./pipelineFace.js";
import { buildApprovalReason, requestApproval } from "./approvalFace.js";
import { formAskQuestion, editsFromFormAnswers, type FormAskService } from "./confirmFace.js";
import { appendAskFailureDiagnostic } from "./askDiagnostics.js";
import { asToolValue } from "./schemaTranslate.js";
import {
  parsePreflightReport,
  renderPreflightChecklist,
  recordPreflightAt,
  type PreflightReport,
} from "../../../../src/core/workspace/trainingPreflight.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";

/** 预检命令形态："python3 /abs/tools/training_preflight.py"（或 mock "node /abs/mock.mjs"）。
 *  在场判定＝脚本路径存在（首 token 为解释器，其余为脚本路径——缺空格＝命令本身）。 */
export const preflightScriptPathOf = (command: string): string => {
  const at = command.indexOf(" ");
  return at < 0 ? command : command.slice(at + 1).trim();
};

export const preflightScriptAvailable = (command: string): boolean => existsSync(preflightScriptPathOf(command));

export interface PreflightDeps {
  /** 预检命令（解释器＋脚本绝对路径；env ATF_DSH_PREFLIGHT_COMMAND 注入面）。 */
  command: string;
  timeoutMs: number;
  runsRoot: string;
  ctx: { get(service: string): unknown };
}

export interface PreflightFlowArgs {
  runId: string;
  apply: boolean;
}

export interface PreflightOutcome {
  ok: boolean;
  error?: string;
  note?: string;
  /** 最新一份报告（apply 重跑后为执行后报告）。 */
  report?: PreflightReport;
  checklist?: string;
  /** needs_confirm 项决策（form 卡 selected 解析——agent 转后续段参数）。 */
  decisions?: Record<string, string>;
  /** true＝--apply 已实际执行（审批卡放行后）。 */
  applied?: boolean;
  /** true＝预检卡被用户取消（清单仍如实返回，不阻塞后续）。 */
  cancelled?: boolean;
}

/** 只读预检执行（spawn＋schema 校验＋KPI 首记）。 */
const runPreflightOnce = async (
  deps: PreflightDeps,
  runDir: string,
  extraArgs: readonly string[] = [],
): Promise<{ ok: true; report: PreflightReport } | { ok: false; error: string; note: string }> => {
  const ran = await runPipeline(deps.command, ["--run-dir", runDir, ...extraArgs], deps.timeoutMs);
  if (ran.code !== 0) {
    return {
      ok: false,
      error: "preflight_failed",
      note: `内核预检脚本退出码 ${String(ran.code)}（${ran.code === null ? "超时或被信号终止" : "详见 stderr 尾"}）：${ran.stderr.trim().slice(0, 200)}`,
    };
  }
  const parsed = parsePreflightReport(ran.stdout);
  if (!parsed.ok) return { ok: false, error: "preflight_schema_invalid", note: `预检输出与固定 schema 不符：${parsed.error}` };
  return { ok: true, report: parsed.report };
};

/** 预检交互主流程（本工具直调与 confirmFace 前置预检共用单源）：
 *  只读预检 → KPI 首记 → needs_confirm 合并 form 卡（presentCard=false 时跳过，
 *  如全自动训练档免阻塞）→ apply 意愿（参数直给或卡上勾选）→ 审批卡放行 →
 *  --apply 重跑 → 执行后清单。任一环节失败/取消都如实返回已得清单，不抛。 */
export const runPreflightFlow = async (
  deps: PreflightDeps,
  args: PreflightFlowArgs,
  exec: { agent?: unknown; callId?: string; signal?: unknown },
  opts?: { presentCard?: boolean },
): Promise<PreflightOutcome> => {
  const runDir = resolveRunDir(deps.runsRoot, args.runId, { workspace: sessionWorkspaceSlug(exec) });
  const first = await runPreflightOnce(deps, runDir);
  if (!first.ok) return { ok: false, error: first.error, note: first.note };
  recordPreflightAt(runDir, new Date().toISOString());
  const report = first.report;
  const checklist = renderPreflightChecklist(report);
  const needsConfirm = report.items.filter((item) => item.state === "needs_confirm");
  const derivable = report.items.filter((item) => item.state === "derivable");

  // needs_confirm 合并一屏（§二.2——不逐项弹）：form 卡 detail＝三态清单；
  // fields＝逐项决策行＋（有可派生项时）apply 行——apply 只收意愿，授权在审批卡。
  let decisions: Record<string, string> | undefined;
  if (needsConfirm.length > 0 && opts?.presentCard !== false) {
    const svc = deps.ctx.get("userQuestions") as FormAskService | undefined;
    if (svc === undefined || typeof svc.ask !== "function") {
      return { ok: true, report, checklist, note: "user_questions_unavailable——needs_confirm 项以清单呈现，决策值请由 agent 结构化转达后续段参数" };
    }
    const fields = needsConfirm.map((item) => ({
      key: item.id,
      label: item.id,
      value: "",
      placeholder: item.action !== "" ? item.action.slice(0, 200) : item.detail.slice(0, 200),
      hint: item.detail.slice(0, 200),
    }));
    if (derivable.length > 0) {
      fields.push({
        key: "apply_derivables",
        label: "apply_derivables（是否执行全部可派生项）",
        value: "no",
        placeholder: `共 ${String(derivable.length)} 项可自动执行（${derivable.map((item) => item.id).join("、")}）——填 yes 后仍需审批卡放行才执行`,
        hint: "填 yes＝执行全部可派生项（授权在后续审批卡）；no/留空＝本轮不执行",
      });
    }
    let answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> };
    try {
      answers = await svc.ask({
        questions: [formAskQuestion({
          id: `preflight-${args.runId}`,
          question: `首跑预检 — ${args.runId}`,
          header: "训练链入口预检",
          detail: `${checklist}\n确认项请逐项填写决策值后提交（一屏合并收集，不逐项弹）。`,
          fields,
          submitLabel: "提交预检决策",
        })],
        agent: exec.agent,
        signal: exec.signal,
      });
    } catch (cause) {
      const diagRel = appendAskFailureDiagnostic(runDir, "atf_training_preflight", `preflight-${args.runId}`, cause);
      if ((cause as { code?: string }).code === "ASK_CANCELLED") {
        return { ok: true, report, checklist, cancelled: true, note: "预检卡被取消——清单如实返回（预检不阻塞后续链）" };
      }
      return { ok: true, report, checklist, note: `预检卡应答失败：${String(cause).slice(0, 200)}（通道诊断已落 run 目录 ${diagRel}）——清单如实返回` };
    }
    const submitted = editsFromFormAnswers(answers);
    const collected: Record<string, string> = {};
    for (const [key, value] of Object.entries(submitted)) {
      if (value === "") continue;
      collected[key] = value;
    }
    decisions = Object.keys(collected).length > 0 ? collected : undefined;
  }

  // apply 路径：意愿＝工具参数直给 ｜ 卡上 apply_derivables=yes；授权恒走审批卡。
  const wantApply = args.apply || decisions?.["apply_derivables"] === "yes";
  if (wantApply && derivable.length > 0) {
    const verdict = await requestApproval(deps.ctx, exec, "atf_training_preflight",
      buildApprovalReason({
        action: "执行预检可派生项（一键）",
        target: `（${String(derivable.length)} 项：${derivable.map((item) => item.id).join("、")}；run ${args.runId}）`,
        effect: "对 derivable 项自动执行（坐标换算整批重试／内置 CPU provider 计量生成 token 预算）",
        reversible: "不可自动回滚（run 目录产物可人工清理）",
        cost: "按任务卡",
      }) + `\n${checklist}`);
    if (!verdict.ok) {
      return { ok: true, report, checklist, ...(decisions !== undefined ? { decisions } : {}), note: `apply 未获放行（${verdict.outcome}）——清单如实返回` };
    }
    const second = await runPreflightOnce(deps, runDir, ["--apply"]);
    if (!second.ok) {
      return { ok: true, report, checklist, ...(decisions !== undefined ? { decisions } : {}), applied: false, note: `apply 执行失败：${second.note}` };
    }
    return {
      ok: true,
      report: second.report,
      checklist: renderPreflightChecklist(second.report),
      ...(decisions !== undefined ? { decisions } : {}),
      applied: true,
    };
  }
  if (derivable.length > 0 && !wantApply) {
    return { ok: true, report, checklist, ...(decisions !== undefined ? { decisions } : {}), note: `有 ${String(derivable.length)} 项可派生未执行——apply=true（或在预检卡 apply_derivables 填 yes）经审批卡放行后一键执行` };
  }
  return { ok: true, report, checklist, ...(decisions !== undefined ? { decisions } : {}) };
};

export const buildPreflightTool = (deps: PreflightDeps): unknown =>
  defineTool({
    name: "atf_training_preflight",
    description:
      "训练链入口预检（首跑前先跑这个——跑完八段才不会被拦）：读内核预检脚本输出，渲染三态清单——missing（环境/用户必须提供）／derivable（可自动执行，给动作与数量）／needs_confirm（业务确认，合并一屏收集不逐项弹），按依赖链顺序呈现（provider→预算→坐标→variants→iteration，derivable 项依赖未清会如实标待依赖）。apply=true 时经审批卡放行后触发内核 --apply 对可派生项一键执行（坐标换算整批重试／内置 CPU provider 计量生成 token 预算）。预检不替代各段既有校验（防御纵深不变），只是把「缺什么」提前聚合；预检结果与首次预检/首次放行时间戳（time-to-launch 统计）落 run 事实。九要素确认卡前会自动先出本预检（顺序机制保证）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（预检落点 runs/<run_id>）" },
      apply: { type: "boolean", description: "true＝对 derivable 项执行内核 --apply（经审批卡放行后执行）；缺省 false 只读预检" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { run_id: string; apply?: boolean }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      if (!preflightScriptAvailable(deps.command)) {
        return asToolValue({
          ok: false,
          run_id: args.run_id,
          error: "preflight_script_missing",
          note: `内核预检脚本不在场（${preflightScriptPathOf(deps.command)}）——当前 pin 未含 tools/training_preflight.py，待内核发版 re-pin 后生效；可经 ATF_DSH_PREFLIGHT_COMMAND 注入替代命令`,
        });
      }
      const outcome = await runPreflightFlow(deps, { runId: args.run_id, apply: args.apply === true }, exec);
      if (!outcome.ok) {
        return asToolValue({ ok: false, run_id: args.run_id, error: outcome.error, ...(outcome.note !== undefined ? { note: outcome.note } : {}) });
      }
      return asToolValue({
        ok: true,
        run_id: args.run_id,
        generated_at: outcome.report?.generated_at,
        summary: outcome.report?.summary,
        order: outcome.report?.order,
        checklist: outcome.checklist,
        ...(outcome.decisions !== undefined ? { decisions: outcome.decisions } : {}),
        ...(outcome.applied !== undefined ? { applied: outcome.applied } : {}),
        ...(outcome.cancelled === true ? { cancelled: true } : {}),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
    },
  });
