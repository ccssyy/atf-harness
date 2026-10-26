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
 * confirmFace 前置预检在脚本缺席时跳过（训练方案链现状零回归）。
 *
 * E2（微批·预检双缺陷 20261024）：
 * - 缺陷 A（run 解析双源）：旧解析只查实例 runsRoot＋会话桶，而段工具
 *   atf_pipeline_stage 落点＝<workspace_path>/runs/<run_id>——用户工作区树里的
 *   run 永远找不到，产品内 agent 被迫自建软链自救（红线形态）。本批改三级单源
 *   解析（workspace_path 显式 > 会话工作区事实 > 实例 runsRoot 兜底）＋最终落点
 *   symlink 拒绝（lstat 不跟随链接——断掉软链自救的根，不可绕过）。
 * - 缺陷 B（退出码语义误判）：内核脚本对「有缺项」的 run 报 exit 1、stderr 空、
 *   stdout 仍为完整合法报告（UAT 实测）——exit≠0 不再等价「执行失败」：先解析
 *   stdout，报告可用即 degraded 返回（清单不丢、退出码如实透传）；解析失败才是
 *   真 preflight_failed（note 必含 stdout/stderr 摘要——禁空 note）。
 */
import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { isValidRunId, resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";

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
  /** E2 缺陷 A：workspace 根（与 atf_pipeline_stage 的 workspace_path 同值）——
   *  显式给定则落点单源 <workspacePath>/runs/<runId>（须绝对路径）。 */
  workspacePath?: string;
}

/** E2：run 目录解析来源三值闭集（返回体 run_dir_source 原样透出）。 */
export type PreflightRunDirSource = "workspace_path" | "session_fact" | "instance_runs_root";

/** E2：run 落点解析结果——成功＝实际目录＋来源；失败＝结构化错误（不猜不造路径）。 */
export type ResolvedPreflightRunDir =
  | { ok: true; runDir: string; source: PreflightRunDirSource }
  | { ok: false; error: string; note: string };

export interface PreflightOutcome {
  ok: boolean;
  error?: string;
  note?: string;
  /** E2：实际解析出的 run 目录（三级单源——KPI 落点与返回体 run_dir 同值）。 */
  runDir?: string;
  /** E2：run 目录解析来源（workspace_path／session_fact／instance_runs_root）。 */
  runDirSource?: PreflightRunDirSource;
  /** E2 缺陷 B：true＝脚本退出码非零但报告可用（清单完整，退出码如实透传不丢）。 */
  degraded?: true;
  /** E2 缺陷 B：degraded 时的脚本退出码（null＝超时/信号形态）。 */
  exitCode?: number | null;
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

/** E2：run 目录不存在统一指路文案（探测落点如实呈现；内部码不进文案——红线）。 */
const runDirNotFoundNote = (probed: readonly string[]): string =>
  `run 目录不存在（已探测：${probed.join("、")}）——请传 workspace_path（与 atf_pipeline_stage 同值）`;

/**
 * E2 缺陷 A 修复——run 落点解析单源（三级优先序，与段工具 atf_pipeline_stage 的
 * 落点 <workspace_path>/runs/<run_id> 对齐；旧「实例 runsRoot＋会话桶」形态降为
 * 第三级兜底，存量平铺/桶内 run 零破坏）：
 *   a. workspace_path 显式给定 → <workspace_path>/runs/<run_id>（须绝对路径——
 *      非绝对 fail-closed，文案对齐 pipelineFace 同名错误形态；给定但目录不存在
 *      即拒，不回落 b/c——显式优先不容静默改道）；
 *   b. 会话工作区事实（exec.agent.session.header.cwd——与 sessionWorkspaceSlug
 *      同源取法）→ <cwd>/runs/<run_id> 与 <cwd>/workspace/runs/<run_id> 两候选
 *      首中（前者＝段工具落点形态，后者＝canonical 工作区形态）；
 *   c. 兜底现行 resolveRunDir（实例 runsRoot 平铺/桶——存量形态）。
 * 三级全不中 → run_dir_not_found fail-closed 并指路 workspace_path；最终落点为
 * 软链 → run_dir_symlink_rejected（lstat 而非 stat——stat 跟随链接失去判据；
 * 不接受镜像/软链自救形态，无开关可绕过）。a/b 候选仅对合法 runId 探测
 * （RUN_NAME_RE 同源——路径穿越不进候选面；非法 runId 走 c 的既有兼容口径）。
 */
export const resolvePreflightRunDir = (deps: PreflightDeps, args: PreflightFlowArgs, exec: unknown): ResolvedPreflightRunDir => {
  // 收口门：对三级来源统一做 symlink 终判（探测路径已在 probed 里，lstat 竞态
  // 失败按不存在处理——fail-closed）。
  const settle = (dir: string, source: PreflightRunDirSource, probed: readonly string[]): ResolvedPreflightRunDir => {
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        return { ok: false, error: "run_dir_symlink_rejected", note: "run 目录落点是软链——请使用真实工作区路径（不接受镜像/软链）" };
      }
    } catch {
      return { ok: false, error: "run_dir_not_found", note: runDirNotFoundNote([...probed, dir]) };
    }
    return { ok: true, runDir: dir, source };
  };

  const runId = args.runId;
  const workspacePath = typeof args.workspacePath === "string" ? args.workspacePath.trim() : "";
  if (workspacePath !== "") {
    if (!isAbsolute(workspacePath)) {
      return { ok: false, error: "workspace_path_not_absolute", note: `workspace_path 须为绝对路径（得 ${workspacePath}）` };
    }
    // E3 补（与 pipelineFace canonical 修复同族）：显式 wp 下 canonical 布局
    // <wp>/workspace/runs/<id>（内核 RunLayout v1）在场优先——否则本次训练方案卡的
    // 快照/iteration-config 回写会落到 legacy 假树，与 training_prep 的 canonical
    // 真树不同树（F7 train_sh 对账必拦）；canonical 缺席回落 legacy 公式
    // <wp>/runs/<id>（存量/新建形态），两形态都不在场才拒（显式优先不静默改道）。
    const canonical = join(workspacePath, "workspace", "runs", runId);
    if (isValidRunId(runId) && existsSync(canonical)) return settle(canonical, "workspace_path", [canonical]);
    const legacy = join(workspacePath, "runs", runId);
    if (!isValidRunId(runId) || !existsSync(legacy)) {
      return { ok: false, error: "run_dir_not_found", note: runDirNotFoundNote([canonical, legacy]) };
    }
    return settle(legacy, "workspace_path", [canonical, legacy]);
  }

  const probed: string[] = [];
  // b. 会话工作区事实：cwd 取法与 sessionWorkspaceSlug 同源（runLayout vendor 锚）
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } })?.agent?.session?.header?.cwd;
  if (isValidRunId(runId) && typeof cwd === "string" && cwd.trim() !== "") {
    for (const candidate of [join(cwd, "runs", runId), join(cwd, "workspace", "runs", runId)]) {
      if (existsSync(candidate)) return settle(candidate, "session_fact", probed);
      probed.push(candidate);
    }
  }
  // c. 兜底：实例 runsRoot 平铺/桶（存量形态；canonicalRoots 缺省不查＝既有行为）
  const fallback = resolveRunDir(deps.runsRoot, runId, { workspace: sessionWorkspaceSlug(exec) });
  if (!existsSync(fallback)) {
    return { ok: false, error: "run_dir_not_found", note: runDirNotFoundNote([...probed, fallback]) };
  }
  return settle(fallback, "instance_runs_root", [...probed, fallback]);
};

/** 只读预检执行（spawn＋schema 校验）。
 *  E2 缺陷 B 修复——退出码语义修正：内核脚本对「有缺项」的 run 报 exit 1、stderr
 *  空、stdout 仍为完整合法报告（UAT 实测形态），exit≠0 不再等价「执行失败」：
 *  先尝试解析 stdout，解析成功＝报告可用（ok:true＋degraded＋exitCode 如实透传
 *  ——三态清单不丢）；解析失败才是真 preflight_failed——note 必含 stdout 前 300
 *  字与 stderr 前 300 字摘要（禁空 note；code===null 超时/信号形态保留超时说明）。 */
const runPreflightOnce = async (
  deps: PreflightDeps,
  runDir: string,
  extraArgs: readonly string[] = [],
): Promise<
  | { ok: true; report: PreflightReport; degraded?: true; exitCode?: number | null }
  | { ok: false; error: string; note: string }
> => {
  const ran = await runPipeline(deps.command, ["--run-dir", runDir, ...extraArgs], deps.timeoutMs);
  const parsed = parsePreflightReport(ran.stdout);
  if (ran.code !== 0) {
    if (parsed.ok) {
      // 报告可用：退出码非零但清单完整——degraded 透传，不丢清单
      return { ok: true, report: parsed.report, degraded: true, exitCode: ran.code };
    }
    const stdoutHead = `stdout 摘要：${ran.stdout.trim().slice(0, 300)}`;
    const stderrHead = `stderr 摘要：${ran.stderr.trim().slice(0, 300)}`;
    return {
      ok: false,
      error: "preflight_failed",
      note: ran.code === null
        ? `内核预检脚本超时或被信号终止（无退出码）——${stdoutHead}；${stderrHead}`
        : `内核预检脚本退出码 ${String(ran.code)} 且 stdout 不可解析为合法报告——${stdoutHead}；${stderrHead}`,
    };
  }
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
  // E2 缺陷 A：run 落点三级单源解析（resolvePreflightRunDir——workspace_path 显式 >
  // 会话工作区事实 > 实例 runsRoot 兜底）；解析失败 fail-closed 直接返回，不进
  // 脚本调用（找不到 run 的预检只会产出假失败＋软链自救诱因）。
  const resolved = resolvePreflightRunDir(deps, args, exec);
  if (!resolved.ok) return { ok: false, error: resolved.error, note: resolved.note };
  const runDir = resolved.runDir;
  // 返回体锚：run_dir/run_dir_source 随全部成功路径透出（实际解析值——KPI 同值）
  const meta = { runDir, runDirSource: resolved.source };
  const first = await runPreflightOnce(deps, runDir);
  if (!first.ok) return { ok: false, error: first.error, note: first.note };
  // 报告可用即记 KPI 首次预检（degraded 同记——清单拿到＝预检成功；落点随单源修正）
  recordPreflightAt(runDir, new Date().toISOString());
  // E2 缺陷 B：degraded/exitCode 随「报告来自 first」的全部返回点透传
  const firstDegraded = first.degraded === true ? { degraded: true as const, exitCode: first.exitCode ?? null } : {};
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
      return { ok: true, ...meta, ...firstDegraded, report, checklist, note: "user_questions_unavailable——needs_confirm 项以清单呈现，决策值请由 agent 结构化转达后续段参数" };
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
        return { ok: true, ...meta, ...firstDegraded, report, checklist, cancelled: true, note: "预检卡被取消——清单如实返回（预检不阻塞后续链）" };
      }
      return { ok: true, ...meta, ...firstDegraded, report, checklist, note: `预检卡应答失败：${String(cause).slice(0, 200)}（通道诊断已落 run 目录 ${diagRel}）——清单如实返回` };
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
      }) + `\n${checklist}`);
    if (!verdict.ok) {
      return { ok: true, ...meta, ...firstDegraded, report, checklist, ...(decisions !== undefined ? { decisions } : {}), note: `apply 未获放行（${verdict.outcome}）——清单如实返回` };
    }
    const second = await runPreflightOnce(deps, runDir, ["--apply"]);
    if (!second.ok) {
      return { ok: true, ...meta, ...firstDegraded, report, checklist, ...(decisions !== undefined ? { decisions } : {}), applied: false, note: `apply 执行失败：${second.note}` };
    }
    // 执行后报告来自 second——degraded/exitCode 随之取 second 的（如实反映最终态）
    const secondDegraded = second.degraded === true ? { degraded: true as const, exitCode: second.exitCode ?? null } : {};
    return {
      ok: true,
      ...meta,
      ...secondDegraded,
      report: second.report,
      checklist: renderPreflightChecklist(second.report),
      ...(decisions !== undefined ? { decisions } : {}),
      applied: true,
    };
  }
  if (derivable.length > 0 && !wantApply) {
    return { ok: true, ...meta, ...firstDegraded, report, checklist, ...(decisions !== undefined ? { decisions } : {}), note: `有 ${String(derivable.length)} 项可派生未执行——apply=true（或在预检卡 apply_derivables 填 yes）经审批卡放行后一键执行` };
  }
  return { ok: true, ...meta, ...firstDegraded, report, checklist, ...(decisions !== undefined ? { decisions } : {}) };
};

export const buildPreflightTool = (deps: PreflightDeps): unknown =>
  defineTool({
    name: "atf_training_preflight",
    description:
      "训练链入口预检（首跑前先跑这个——跑完八段才不会被拦）：读内核预检脚本输出，渲染三态清单——missing（环境/用户必须提供）／derivable（可自动执行，给动作与数量）／needs_confirm（业务确认，合并一屏收集不逐项弹），按依赖链顺序呈现（provider→预算→坐标→variants→iteration，derivable 项依赖未清会如实标待依赖）。apply=true 时经审批卡放行后触发内核 --apply 对可派生项一键执行（坐标换算整批重试／内置 CPU provider 计量生成 token 预算）。预检不替代各段既有校验（防御纵深不变），只是把「缺什么」提前聚合；预检结果与首次预检/首次放行时间戳（time-to-launch 统计）落 run 事实。本次训练方案卡前会自动先出本预检（顺序机制保证）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识（run 目录＝<workspace_path>/runs/<run_id>；未传 workspace_path 时按会话工作区事实与实例 runs 根顺次探测）" },
      apply: { type: "boolean", description: "true＝对 derivable 项执行内核 --apply（经审批卡放行后执行）；缺省 false 只读预检" },
      workspace_path: { type: "string", description: "workspace 根（绝对路径——与 atf_pipeline_stage 的 workspace_path 同值；落点 <workspace_path>/runs/<run_id>）" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { run_id: string; apply?: boolean; workspace_path?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      if (!preflightScriptAvailable(deps.command)) {
        return asToolValue({
          ok: false,
          run_id: args.run_id,
          error: "preflight_script_missing",
          note: `内核预检脚本不在场（${preflightScriptPathOf(deps.command)}）——当前 pin 未含 tools/training_preflight.py，待内核发版 re-pin 后生效；可经 ATF_DSH_PREFLIGHT_COMMAND 注入替代命令`,
        });
      }
      const outcome = await runPreflightFlow(deps, { runId: args.run_id, apply: args.apply === true, workspacePath: args.workspace_path }, exec);
      if (!outcome.ok) {
        return asToolValue({ ok: false, run_id: args.run_id, error: outcome.error, ...(outcome.note !== undefined ? { note: outcome.note } : {}) });
      }
      return asToolValue({
        ok: true,
        run_id: args.run_id,
        // E2：实际解析落点与来源三值透出（用户/agent 可核对预检到底查的哪棵树）
        run_dir: outcome.runDir,
        run_dir_source: outcome.runDirSource,
        generated_at: outcome.report?.generated_at,
        summary: outcome.report?.summary,
        order: outcome.report?.order,
        checklist: outcome.checklist,
        ...(outcome.decisions !== undefined ? { decisions: outcome.decisions } : {}),
        ...(outcome.applied !== undefined ? { applied: outcome.applied } : {}),
        ...(outcome.cancelled === true ? { cancelled: true } : {}),
        // E2 缺陷 B：报告可用但退出码非零——degraded＋exit_code 如实透传
        ...(outcome.degraded === true ? { degraded: true, exit_code: outcome.exitCode ?? null } : {}),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
    },
  });
