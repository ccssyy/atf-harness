#!/usr/bin/env node
/**
 * 前端一（自有 UI · TUI 主入口）——L1 门 2 T02（《ATF独立Harness_L1门2任务书_20260915.md》§2.2）。
 *
 * 形态：**同进程直连 core/**（不经 ACP、不受 ACP schema 约束）——本进程内以
 * ScenarioRunner（src/core/run/）驱动 run：atf.bind_run → 决策循环（模型面 provider
 * 沿用 L1a 配置，不改选型）→ 过程流经 core 投影面（onEvent）逐条渲染 → 高危动作触发
 * 问答轨审批，弹窗在同一界面等待人工应答（账本轨仍为唯一真相源）→ 终局与退出码可见。
 *
 * 运行：
 *   node dist/ui/tui.js [--runs-root <dir>] [--run-id <id>] [--instruction <text>]
 *        [--scenario-id <id>] [--scope-mode headless|canonical|simulation]
 *        [--mock <桥接 serve 脚本路径> | --peer real --ws-root <path>] [--help]
 *   缺省：runs-root=<repo>/tmp/ui-runs；mock=tests/fixtures/mock_atf.mjs；缺 run-id/
 *   instruction 时交互补问。
 *   W2 --peer real（门 1 裁定 D-1～D-5，2026-09-20）：内置真内核对端——内核副本取
 *   ATF_CLI_PATH 覆盖 > <repo>/.atf-pinned 缺省（HEAD sha 与契约 pin 校验，fail-closed）；
 *   隔离 HOME（<tmp>/atf-tui-home-*，零仓写入，退出即清）；启动预置一次幂等 `atf init
 *   --workspace-root <ws-root>`（失败不进会话）；scope-mode 强制 canonical；run 骨架不
 *   自动建（bind 失败按提示走走查 prep 脚本）。首屏对端核验行 peer=real(<pin tag>)。
 *
 * 红线：provider 配置经 ATF_LLM_CONFIG（0600）/ATF_LLM_* 注入（沿用 L1a，D2）；应答
 * 只能由人在本界面给出，无任何自动应答（ADR-07）；挂起 run 的续答应答 v1 仍走 CLI
 * resume 通道（登记 L1b 优化：TUI 内 resume）。
 * 退出码 = run 终局码（0/1/75/78/79，单一出口 resolveRunExitCode）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { ATF_UPSTREAM_COMMIT_SHA, ATF_UPSTREAM_TAG, readGitHeadSha } from "../bridge/atfCommand.js";
import { loadLlmProviderConfig, HttpLlmProvider, type ResolvedLlmProviderConfig } from "../llm/index.js";
import { formatThreePartLines, providerConfigThreePart } from "../core/index.js";
import { ToolRegistry, WORKSPACE_TOOL_HANDLERS, buildSkillsSystemSuffix, type LocalToolHost } from "../core/tools/index.js";
import {
  buildLabelQcResolveParams,
  labelQcCardKey,
  pendingItemsOf,
  readLabelQcReport,
  readResolvedItemIds,
  readSliceImageRef,
  type LabelQcDecisionDraft,
  type LabelQcItem,
  type LaunchReady,
} from "../core/workspace/index.js";
import { ScenarioRunner, resolveRunExitCode, sessionLogPathFor, listPendingApprovals, readSessionStream, type ApprovalStubResponse, type BranchRunReport, type RunBranchOptions } from "../core/run/index.js";
import { HistoryFolder } from "./historyFold.js";
import type { Scenario } from "../llm/index.js";
import { DiffRenderer } from "./renderer.js";
import { formatEventDetailLines, formatEventLine, statusLineFor } from "./eventView.js";
import { collapseLines } from "./collapseView.js";
import { askApproval, TUI_ACTOR } from "./approval.js";
import { buildInitInvocation, buildRealPeerDescriptor, effectiveScopeMode, parseArgs, repoRootDefault, resolveKernelDir, usage } from "./tuiArgs.js";
import { launchCardKey, launchCardLines, launchConfirmationText, synthesizeLaunchAction } from "./launchCard.js";
import {
  applyLabelQcField,
  labelQcCardLines,
  labelQcConfirmationText,
  labelQcFieldPrompt,
  labelQcItemLines,
  labelQcItemPrompt,
  parseLabelQcAnswer,
  requiredFieldsOf,
  synthesizeLabelQcResolveAction,
} from "./labelQcCard.js";
import { setCompactionContextWindow, setTurnTokenBudget } from "../core/session/constantsBudget.js";
import type { PendingConfirmAction } from "../core/run/runner.js";
import {
  applyFieldInput,
  canonicalConfirmationText,
  cardFields,
  confirmCardFromResult,
  confirmCardLines,
  confirmationEchoLine,
  synthesizeAction,
  type ConfirmCard,
  type SynthesizedAction,
} from "./confirmCard.js";
import { completedSummaryLines } from "./completedSummary.js";

const ask = (rl: readline.Interface, prompt: string, fallback?: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed !== "" ? trimmed : (fallback ?? ""));
    });
  });

const PLAIN_RESULT = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 子进程一次性调用（D-1 预置 init 用；非零退出 = 正常返回，由调用方断言）。 */
const execFileP = (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      const code = (error as { exitCode?: number | null }).exitCode;
      if (typeof code === "number") {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      reject(error);
    });
  });

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`参数非法: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  const args = parsed;
  if (args.help) {
    console.log(usage());
    return;
  }

  const renderer = new DiffRenderer({ out: process.stdout });
  // provider 配置 fail-closed 前置（沿用 L1a：ATF_LLM_CONFIG / ATF_LLM_*；批内不改选型）
  const configResult = await loadLlmProviderConfig(process.env);
  if (!configResult.ok) {
    renderer.appendLine(`✗ ${formatThreePartLines(providerConfigThreePart(configResult.error.message, "配置文件经 ATF_LLM_CONFIG 指定（两层清单，0600）"))}`);
    process.exitCode = 1;
    return;
  }
  const config: ResolvedLlmProviderConfig = configResult.value;
  // A1.5.2（L1c 提前批）：进程级 compaction 触发水位注入——context_window − reserve，
  // 未配置 null → 回退既有 24K（行为中立）；与 sessionLog 审计径同源（constantsBudget）。
  setCompactionContextWindow(config.context_window);
  // 批 2.5 §二：turn 级 token 预算注入（llm.json turn_token_budget 旋钮；null＝数据驱动 floor(水位/4)）。
  setTurnTokenBudget(config.turn_token_budget ?? null);

  // W2 --peer real 预置（门 1 裁定 D-1/D-2；全部 fail-closed，任一步不过即退出不进会话）。
  // 顺序：内核目录解析（D-2）→ pin sha 校验 → ws-root 校验 → 隔离 HOME → 幂等 atf init（D-1）。
  let peerReal: { kernelDir: string; wsRoot: string; home: string } | null = null;
  if (args.peer === "real") {
    const kernel = resolveKernelDir(process.env, repoRootDefault());
    if (!kernel.ok) {
      renderer.appendLine(`✗ ${kernel.error}`);
      process.exitCode = 1;
      return;
    }
    const sha = await readGitHeadSha(kernel.path);
    if (!sha.ok) {
      renderer.appendLine(`✗ 内核副本 pin 校验失败（读 HEAD 失败: ${sha.error.message}）——拒绝以非 pin 内核走查`);
      process.exitCode = 1;
      return;
    }
    if (sha.value !== ATF_UPSTREAM_COMMIT_SHA) {
      renderer.appendLine(`✗ 内核副本 HEAD ${sha.value.slice(0, 12)}… ≠ 契约 pin ${ATF_UPSTREAM_TAG}（${ATF_UPSTREAM_COMMIT_SHA.slice(0, 12)}…）——拒绝以非 pin 内核走查`);
      process.exitCode = 1;
      return;
    }
    const wsRoot = args.wsRoot;
    const wsStat = wsRoot === undefined ? undefined : statSync(wsRoot, { throwIfNoEntry: false });
    if (wsRoot === undefined || wsStat === undefined || !wsStat.isDirectory()) {
      renderer.appendLine(`✗ --ws-root 须为已存在目录: ${wsRoot ?? "(缺省)"}`);
      process.exitCode = 1;
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "atf-tui-home-"));
    const init = buildInitInvocation(kernel.path, wsRoot);
    const initRun = await execFileP(init.command, init.args, { cwd: init.cwd, env: { ...process.env, ...init.env, HOME: home } });
    if (initRun.exitCode !== 0) {
      rmSync(home, { recursive: true, force: true });
      renderer.appendLine(`✗ atf init 预置失败(exit=${String(initRun.exitCode)})——不进入会话（D-1 fail-closed）：${(initRun.stderr !== "" ? initRun.stderr : initRun.stdout).slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    peerReal = { kernelDir: kernel.path, wsRoot, home };
    renderer.appendLine(`真内核对端预置完成：内核=${kernel.path}（${kernel.source}，pin ${ATF_UPSTREAM_TAG}）· 隔离 HOME=${home}`);
  }

  // 批 3「创作执行面」：工作区工具面装配（§一/§二/§三）。内核目录可解析即启用——
  // 注册表扩至 11 工具（TUI/resume 专属；MCP/ACP 不变）＋技能清单常驻 systemSuffix＋
  // 本地工具宿主（scratch 内受控执行；HOME 与对端隔离 home 同源，内核配置根/放行账本一致）。
  // 内核目录不可解析＝不启用（7 工具既有行为；skills 装载降级——增强而非依赖）。
  const kernelDirResolved = peerReal !== null
    ? { ok: true as const, path: peerReal.kernelDir }
    : resolveKernelDir(process.env, repoRootDefault());
  let toolFace: RunBranchOptions["toolFace"] = undefined;
  let skillsSuffix: string | undefined;
  let execHome: string | null = null;
  const localHost: LocalToolHost | null = kernelDirResolved.ok
    ? (() => {
        execHome = peerReal !== null ? peerReal.home : mkdtempSync(join(tmpdir(), "atf-exec-home-"));
        const baseEnv: Record<string, string> = { ATF_SKILLS_AUTO_INSTALL: "0" };
        if (peerReal !== null) {
          baseEnv["HOME"] = peerReal.home;
          baseEnv["ATF_WORKSPACE_ROOT"] = peerReal.wsRoot;
        }
        return {
          scratchDir: "", // runId 就绪后回填（runs-root/run-id/scratch）
          kernelDir: kernelDirResolved.path,
          home: execHome,
          baseEnv,
        };
      })()
    : null;
  if (kernelDirResolved.ok) {
    skillsSuffix = await buildSkillsSystemSuffix(kernelDirResolved.path);
    toolFace = {
      registry: ToolRegistry.createWithWorkspaceTools(),
      local: { handlers: WORKSPACE_TOOL_HANDLERS, host: localHost as LocalToolHost },
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    renderer.appendLine("══ ATF Harness TUI（前端一 · 同进程直连 core）══");
    renderer.appendLine(`provider=${config.provider_id} model=${config.model}（沿用 L1a 选型）· 零 npm 依赖`);
    // W2 D-5：首屏对端核验行（仅 peer real；mock 模式首屏零扰动）
    if (peerReal !== null) {
      renderer.appendLine(`对端核验: peer=real(${ATF_UPSTREAM_TAG}) ws-root=${peerReal.wsRoot} home=${peerReal.home}`);
    }
    // 首屏四块指引（L1b B2）：绑定状态 / 可输入什么 / 常用指令示例 / 退出方式
    renderer.appendLine("── 使用指引 ──────────────────────────────");
    renderer.appendLine("① 当前状态：run 未绑定（下一步将提示输入 run-id 与触发指令，绑定后过程流逐条可见）");
    renderer.appendLine("② 你可以输入：run-id（如 run-20260916-1）与触发指令（自然语言描述本次任务）");
    renderer.appendLine("③ 常用指令示例：绑定 run → 查询工作区状态 → 事实扫描 → 闸门查询 → 数据准入 → 账本查询");
    renderer.appendLine("④ 退出方式：Ctrl+C 退出；运行中审批弹窗应答键 g=放行 a=给意见 d=拒绝 x=中止（可跟备注）");
    renderer.appendLine("──────────────────────────────────────────");
    const runId = args.runId ?? (await ask(rl, "run-id> "));
    const instruction = args.instruction ?? (await ask(rl, "触发指令> "));
    if (runId === "" || instruction === "") {
      renderer.appendLine("✗ run-id 与触发指令均必填（fail-closed）");
      process.exitCode = 1;
      return;
    }
    rl.pause(); // 运行期收摄输入（审批弹窗内由 askApproval resume）
    mkdirSync(args.runsRoot, { recursive: true });
    if (localHost !== null) localHost.scratchDir = join(args.runsRoot, runId, "scratch"); // 批 3：本地工具宿主落点
    renderer.appendLine(`run=${runId} · 工作区根=${args.runsRoot} · ${peerReal !== null ? `桥接=真内核 serve（内核=${peerReal.kernelDir}）` : `桥接=${args.mockPath}`}`);
    renderer.appendLine("──────── 过程流（与 append-only 日志逐条对应）────────");

    // B4（L1b-D2=A）：跨进程续跑检测——既有会话流存在＝由事实日志重放重建（INV-A），
    // 首个 prompt 走 continue 通道；挂起待办须经 CLI resume 应答（TUI 内 resume 归后续）。
    let continueMode = existsSync(sessionLogPathFor(args.runsRoot, runId));
    if (continueMode) {
      const stream = await readSessionStream(sessionLogPathFor(args.runsRoot, runId));
      const eventCount = stream.ok ? stream.value.length : 0;
      const pending = stream.ok ? listPendingApprovals(stream.value).length : 0;
      renderer.appendLine(`检测到既有会话（${String(eventCount)} 事件，由事实日志重放重建）${pending > 0 ? `；待办审批 ${String(pending)} 项——须经 CLI resume 应答后才能续跑` : ""}`);
    }

    let instructionText = instruction;
    // B6 D2：历史重放折叠——history 事件缓冲为一批，默认一行摘要（按 h 展开）
    const folder = new HistoryFolder(renderer, { scenario: args.scenarioId, run: runId });
    // A2 确认卡状态（holder 对象承载——onEvent 闭包写、主循环读；跨闭包 let 会被 TS 流
    // 分析误收窄为 never）：pending = 本 turn 末次 propose 携模板的候选（runBranch 前重置、
    // live 事件流更新）；confirmed = 最近一次经卡确认的 {卡, 确认值}（审批弹窗一致性回显源）。
    const cardRef: {
      pending: ConfirmCard | null;
      confirmed: { card: ConfirmCard; confirmed: Record<string, unknown> } | null;
    } = { pending: null, confirmed: null };
    // 批 2.5 A2.5：确认直填——最近一次合成的待派发动作（仅消费一次：传入下一 turn 的
    // continue.pendingAction 后即清空）。
    let pendingSynthesized: PendingConfirmAction | null = null;
    // 批 3 §三：G5 就绪检测（harness 侧确定性——scratch_exec 成功后扫 scratch 找 launch.sh）。
    // pending = 最近一次检测命中；shownKey = 已出过卡（含跳过）的目标键——同一启动目标只出一次。
    let launchReadyPending: LaunchReady | null = null;
    let launchCardShownKey: string | null = null;
    // R-3 接线批：标签体检确认卡（inspect 成功且 pending>0 → 卡数据待建；同（dataset@pin,
    // 报告, 已裁决进度）只出一次卡）。卡数据＝登记面报告只读（peer real 模式可达时）。
    let labelQcPending: { datasetId: string; pin: string; reportDigest: string; reportRef: string } | null = null;
    let labelQcShownKey: string | null = null;
    // 批 2.5 §三.4：静默状态行——live 事件后 2.5s 无新事件 → 追加一行状态（零擦除保持；
    // 下一事件到达即取消计时）。provider 流式＝中期架构项，登记不实施。
    let statusTimer: NodeJS.Timeout | null = null;
    let statusLabel = statusLineFor({ id: 0, ts: "", type: "turn/start", payload: {}, projection: { evidence_event: null } });
    const armStatus = (): void => {
      if (statusTimer !== null) clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        renderer.appendLine(statusLabel);
      }, 2_500);
      statusTimer.unref?.();
    };
    const cancelStatus = (): void => {
      if (statusTimer !== null) clearTimeout(statusTimer);
      statusTimer = null;
    };
    // B4：多轮续跑循环——每个 prompt 一个 turn（审批闸逐 turn 生效）；空输入/Ctrl+C 退出
    for (;;) {
      const provider = new HttpLlmProvider({
        config,
        // 批 3：TUI 装配工作区扩面工具注册表（R-3 接线批后 13 工具）；内核目录不可解析＝既有 9 工具
        tools: toolFace !== undefined && toolFace !== null
          ? toolFace.registry.modelVisible()
          : ToolRegistry.createDefault().modelVisible(),
        // 批 3 §二：技能清单常驻（Pi lazy skills；每技能一行）——skills 装载降级时缺省
        ...(skillsSuffix !== undefined ? { systemSuffix: skillsSuffix } : {}),
      });
      // 会话脚手架形态同 CLI resume（L1a 既有模式）：TUI 不持有场景脚本，只提供会话参数。
      const scenario: Scenario = {
        scenario_id: args.scenarioId,
        version: 1,
        provider: "faux",
        description: "L1 TUI session",
        branches: {
          main: {
            branch_id: "main",
            run_id: runId,
            trigger_instruction: instructionText,
            purpose: "l1-tui",
            setup: { ledger: [] },
            steps: [],
            expect: { outcome: "completed", exit_code: 0 },
          },
        },
      };
      cardRef.pending = null; // 每 turn 重置：卡只认本 turn 末次 propose（跨 turn 陈卡不弹）
      const continuePendingAction = pendingSynthesized; // A2.5：本 turn 消费一次（确认直填派发）
      pendingSynthesized = null;
      const ran = await ScenarioRunner.runBranch(scenario, "main", {
        runsRoot: args.runsRoot,
        // W2 载体 B：peer real 走内置 descriptor（argv/cwd/env 直通 bridge spawn 面）
        mockCommand: peerReal !== null
          ? buildRealPeerDescriptor(peerReal.kernelDir, peerReal.wsRoot, peerReal.home)
          : ["node", args.mockPath],
        modelProvider: provider,
        modelId: config.model,
        approvalSurface: {
          stub: async (input) => await askApproval({
            renderer,
            rl,
            input,
            // A2 三道防线之三：与最近确认卡的只读一致性回显（只提示、不拦截、不改写）
            confirmationEcho: (tool, params) => confirmationEchoLine(tool, params, cardRef.confirmed?.card ?? null, cardRef.confirmed?.confirmed ?? null),
          }),
        },
        onEvent: (event, origin) => {
          folder.handle(event, origin, formatEventLine, formatEventDetailLines);
          if (origin !== "live") return;
          // A2：live propose 成功结果 → 确认卡候选（携带 cluster_params_template/policy_template 才成卡）
          if (event.type === "tool/result") {
            const payload = event.payload as { ok?: unknown; result?: unknown } | null;
            if (payload?.ok === true) {
              const card = confirmCardFromResult(payload.result);
              if (card !== null) cardRef.pending = card;
              // 批 3 §三：scratch_exec 成功结果 → G5 就绪检测命中（harness 确定性产出）
              if (PLAIN_RESULT(payload.result) && typeof (payload.result as Record<string, unknown>)["launch_ready"] === "object") {
                launchReadyPending = (payload.result as Record<string, unknown>)["launch_ready"] as LaunchReady;
              }
              // R-3 接线批：inspect 成功且检出待确认项 → 体检确认卡候选（post-turn 出卡）
              if (PLAIN_RESULT(payload.result)) {
                const inspect = payload.result as Record<string, unknown>;
                const counts = inspect["counts"];
                if (
                  typeof inspect["report_digest"] === "string" &&
                  typeof inspect["report_ref"] === "string" &&
                  PLAIN_RESULT(counts) &&
                  typeof (counts as Record<string, unknown>)["pending"] === "number" &&
                  ((counts as Record<string, unknown>)["pending"] as number) > 0
                ) {
                  labelQcPending = {
                    datasetId: typeof inspect["dataset_id"] === "string" ? inspect["dataset_id"] : "",
                    pin: typeof inspect["pin"] === "string" ? inspect["pin"] : "",
                    reportDigest: inspect["report_digest"] as string,
                    reportRef: inspect["report_ref"] as string,
                  };
                }
              }
            }
          }
          // 批 2.5 §三.4：静默状态行（调用中/思考中——事件驱动重挂 2.5s 单发定时器）
          statusLabel = statusLineFor(event);
          armStatus();
        },
        ...(continueMode
          ? {
              continue: {
                instruction: instructionText,
                ...(continuePendingAction !== null ? { pendingAction: continuePendingAction } : {}),
              },
            }
          : {}),
        ...(effectiveScopeMode(args) !== "headless" ? { scopeMode: effectiveScopeMode(args) } : {}),
        // 批 3：工作区工具面注入（注册表扩面＋本地分派宿主；缺省不注入＝既有行为）
        ...(toolFace !== undefined ? { toolFace } : {}),
      });
      if (!ran.ok) {
        renderer.appendLine(`✗ ${formatThreePartLines({
          fact: "turn 启动失败（本 turn 未执行）",
          cause: `[${ran.error.code}] ${ran.error.message}`,
          fix: peerReal !== null
            ? "peer=real：bind/run 前置失败时先用走查 prep 脚本建立 runs/<run-id> 十目录骨架再重试（骨架不自动建，D-4）；否则核对 ws-root 与内核就绪"
            : "核对 runs-root 与桥接脚本路径；continue 前置不满足时按提示先处理待办/改走全新会话",
        })}`);
        process.exitCode = 1;
        break;
      }
      const report: BranchRunReport = ran.value;
      folder.flushSummary(); // runBranch 收口：历史批次未达 live 也补摘要（幂等）
      renderer.appendLine("──────── 终局 ────────");
      // D-f-2：不显示步数——原「模型调用=N 次」代理步数计删除；事件数保留（append-only
      // 日志对账口径，非进度指标）。
      renderer.appendLine(`outcome=${report.outcome.kind} exit=${String(report.exit_code)} 事件数=${String(report.events.length)}`);
      // A3（L1c 提前批）：completed turn 产品化摘要——做了什么／产生了什么／下一步建议
      // （TUI 侧确定性推导，账本轨零新增；failure 径对称物＝下方 collapseLines）。
      if (report.outcome.kind === "completed") {
        for (const line of completedSummaryLines(report.events)) {
          renderer.appendLine(line);
        }
      }
      if (report.outcome.kind === "turn_failed") {
        // D-1/D-f：turn 级失败收口＝会话保持存活，控制权交还用户——D-1 阈值径与 D-f 四径
        // （budget_exhausted／provider_failure／same_call_repeat／no_progress）同版式渲染；
        // TTY 与 completed 同路径进新指令循环；headless 非 TTY 照旧退出，exit 1。
        renderer.appendLine("──── turn 收口（会话保持存活）────");
        for (const line of collapseLines(report.outcome.summary)) {
          renderer.appendLine(line);
        }
      }
      if (report.outcome.kind === "failed") {
        renderer.appendLine(formatThreePartLines({
          fact: "run 终局 failed（本 turn 未完成即收口）",
          cause: `[${report.outcome.error.code}] ${report.outcome.error.message}`,
          fix: "按原因修正后重新发起会话；已落盘事件可经 CLI resume/--list 追溯",
        }));
        process.exitCode = report.exit_code;
        break;
      }
      if (report.outcome.kind !== "completed" && report.outcome.kind !== "turn_failed") {
        const block = report.outcome.block;
        renderer.appendLine(`block: ${block.reason} —— ${block.message}`);
        if (report.outcome.kind === "suspended") {
          renderer.appendLine("挂起可续：node dist/cli/resume.js --answer <granted|advised|denied|abort> --runs-root … --run-id … --scenario-id …（应答后重进本 TUI 续跑）");
        }
        process.exitCode = report.exit_code;
        break;
      }
      process.exitCode = report.exit_code;
      // B3：reset 键 ＋ B4：多轮续跑入口——仅交互终端（非 TTY 冒烟单 turn 后直接退出）
      if (process.stdin.isTTY !== true) break;
      let nextInstruction: string | null = null;
      // A2 确认卡挂点（触发＝turn 收口后且本 turn 末次 propose 成功携带模板；载体＝B8 流内
      // 多行＋输入行应答；不劫持输入——跳过卡＝直接输入其他指令，直接回车＝退出）。确认后
      // harness 译码（canonicalConfirmationText）作为下一 turn 用户指令落 user/message。
      if (cardRef.pending !== null) {
        // 显式宽化读取：上文 `cardRef.pending = null`（每 turn 重置）会把属性收窄成 never，
        // 而 onEvent 闭包的真实写入 TS 流分析不可见——此处强制回到声明联合类型。
        const card: ConfirmCard = cardRef.pending as ConfirmCard;
        rl.resume();
        for (const line of confirmCardLines(card)) {
          renderer.appendLine(line);
        }
        const cardKindLabel = card.kind === "cluster" ? "聚类参数" : "划分策略";
        const confirmed: Record<string, unknown> = { ...card.template };
        let cardOutcome: "confirmed" | "skip" | "exit" = "exit";
        const first = (await ask(rl, "确认卡应答（1=按推荐确认 2=逐项修改；直接输入其他指令＝跳过）> ")).trim();
        if (first === "1") {
          cardOutcome = "confirmed";
        } else if (first === "2") {
          for (const field of cardFields(card)) {
            if (field.hidden || !field.editable) continue; // 内置项/待定项卡面折叠不暴露（批 2.5 §三.2）
            const value = await ask(rl, `${field.label}（当前 ${field.valueText}，回车保留）> `);
            applyFieldInput(card, field.key, value, confirmed);
          }
          cardOutcome = "confirmed";
        } else if (first !== "") {
          nextInstruction = first; // 跳过卡＝该输入即新指令
          cardOutcome = "skip";
        }
        if (cardOutcome === "confirmed") {
          cardRef.confirmed = { card, confirmed };
          instructionText = canonicalConfirmationText(card, confirmed);
          pendingSynthesized = synthesizeAction(card, confirmed); // A2.5：确定性合成（无 LLM 参与）
          continueMode = true;
          cardRef.pending = null;
          renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·${cardKindLabel} 选择=按卡确认（参数以确认文本为准）`);
          renderer.appendLine("──────── 新 turn（同一 run 绑定下续跑；由事实日志重放重建上下文）────────");
          continue;
        }
        if (cardOutcome === "skip") {
          cardRef.pending = null;
          renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·${cardKindLabel} 选择=跳过（直接按输入指令续跑）`);
        } else {
          break; // 直接回车＝退出（与主循环语义一致）
        }
      }
      // 批 3 §三：训练启动确认卡（G5 就绪：launch_ready_but_not_executed）——确认后经 A2.5
      // 既有 pendingAction 机制派发 atf_launch_execute（审批弹窗第二道人审不变）；同一启动
      // 目标（launch.sh+配置指纹）只出一次卡（跳过/输入新指令后不再重弹）。
      if (nextInstruction === null && launchReadyPending !== null) {
        const ready: LaunchReady = launchReadyPending;
        const readyKey = launchCardKey(ready);
        if (readyKey !== launchCardShownKey) {
          rl.resume();
          for (const line of launchCardLines(ready)) {
            renderer.appendLine(line);
          }
          const launchAnswer = (await ask(rl, "训练启动确认应答（1=确认放行并启动；直接输入其他指令＝暂不启动）> ")).trim();
          launchCardShownKey = readyKey;
          if (launchAnswer === "1") {
            launchReadyPending = null;
            instructionText = launchConfirmationText(ready);
            pendingSynthesized = synthesizeLaunchAction(ready);
            continueMode = true;
            renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·训练启动 选择=放行并启动`);
            renderer.appendLine("──────── 新 turn（同一 run 绑定下续跑；由事实日志重放重建上下文）────────");
            continue;
          }
          if (launchAnswer !== "") {
            nextInstruction = launchAnswer; // 暂不启动＝该输入即新指令
            renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·训练启动 选择=暂不启动`);
          }
        }
      }
      // R-3 接线批：标签体检确认卡（inspect 成功且待确认>0）——待确认项列表＋依据/条款/出处
      // 展示＋逐项处置（九项闭集×检查类约束）＋未决不默认处置；确认后 A2.5 确定性合成
      // atf_label_qc_resolve（模型不转写用户裁决），审批弹窗第二道人审不变。卡数据＝登记面
      // 报告只读（peer real 模式且 wsRoot 可达；否则降级一行提示，不造数）。
      // 显式宽化读取（同 cardRef 口径）：onEvent 闭包的真实写入 TS 流分析不可见， Alias 判空。
      const pendingQc = labelQcPending as { datasetId: string; pin: string; reportDigest: string; reportRef: string } | null;
      if (nextInstruction === null && pendingQc !== null) {
        if (peerReal === null) {
          renderer.appendLine("· 体检出待确认项——确认卡需 --peer real（读取登记面体检报告）；当前对端无工作区，请按报告待确认清单人工裁决");
          labelQcPending = null;
        } else {
          const qcReport = await readLabelQcReport(peerReal.wsRoot, pendingQc.reportRef, pendingQc.reportDigest);
          if (!qcReport.ok) {
            renderer.appendLine(`✗ 体检确认卡未出：${qcReport.error.message}`);
            labelQcPending = null;
          } else {
            const resolvedIds = await readResolvedItemIds(peerReal.wsRoot, pendingQc.reportRef, pendingQc.reportDigest);
            const qcItems = pendingItemsOf(qcReport.value, resolvedIds);
            const qcKey = labelQcCardKey(pendingQc.datasetId, pendingQc.pin, pendingQc.reportDigest, resolvedIds.size);
            if (qcItems.length === 0) {
              renderer.appendLine("· 体检待确认项已全部确认——可直接重新请求数据准入");
              labelQcPending = null;
            } else if (qcKey === labelQcShownKey) {
              // 同一（dataset@pin, 报告, 已裁决进度）只出一次卡——跳过
            } else {
              rl.resume();
              for (const line of labelQcCardLines(qcReport.value, qcItems, resolvedIds.size)) renderer.appendLine(line);
              const gateAnswer = (await ask(rl, "处置应答（1=开始逐项处置；直接输入其他指令＝暂不处置）> ")).trim();
              labelQcShownKey = qcKey;
              if (gateAnswer === "1") {
                const drafts: LabelQcDecisionDraft[] = [];
                const imageRefs: (string | null)[] = [];
                for (const item of qcItems) {
                  const sliceRef = item.evidence[0]?.ref;
                  imageRefs.push(sliceRef !== undefined ? await readSliceImageRef(peerReal.wsRoot, sliceRef) : null);
                }
                for (let index = 0; index < qcItems.length; index += 1) {
                  const item = qcItems[index] as LabelQcItem;
                  for (const line of labelQcItemLines(item, index + 1, qcItems.length, imageRefs[index] ?? null)) renderer.appendLine(line);
                  for (const line of labelQcItemLines(item, index + 1, qcItems.length, imageRefs[index] ?? null)) renderer.appendLine(line);
                  // 应答解析：非法就地重问；空输入＝s（暂不处置，未决不默认）
                  let answer = parseLabelQcAnswer(item, await ask(rl, labelQcItemPrompt(item)));
                  while (answer.kind === "invalid") {
                    renderer.appendLine(`> ${answer.message}`);
                    answer = parseLabelQcAnswer(item, await ask(rl, labelQcItemPrompt(item)));
                  }
                  if (answer.kind === "skip") continue;
                  let draft: LabelQcDecisionDraft;
                  if (answer.kind === "reject") {
                    draft = { item_id: item.item_id, action: "reject" };
                  } else if (answer.kind === "suggest") {
                    const hint = (item.suggested_action?.disposition_hint ?? "") as LabelQcDecisionDraft["disposition"];
                    draft = {
                      item_id: item.item_id,
                      action: "accept",
                      disposition: hint,
                      ...(item.suggested_action?.target_candidate_id !== undefined ? { target_candidate_id: item.suggested_action.target_candidate_id } : {}),
                    };
                  } else {
                    draft = { item_id: item.item_id, action: "modify", disposition: answer.disposition };
                  }
                  // 处置必填附加字段逐项追问（建议已携带的字段不重复问）
                  for (const field of requiredFieldsOf(draft.disposition ?? "")) {
                    const filled = (draft as unknown as Record<string, unknown>)[field];
                    if (typeof filled === "string" && filled !== "") continue;
                    draft = applyLabelQcField(draft, field, await ask(rl, labelQcFieldPrompt(draft.disposition ?? "", field, item)), item);
                  }
                  // Q2 项：判断备注（对照整图的依据，可空——judgement basis=user 恒附）
                  if (item.check_class === "q2_same_box_same_value_diff_field") {
                    const note = await ask(rl, "│   判断备注（对照整图的依据，可空直接回车）> ");
                    if (note !== "") draft.judgement_note = note;
                  }
                  drafts.push(draft);
                }
                if (drafts.length === 0) {
                  renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·标签体检 选择=全部暂不处置（未决项不默认处置）`);
                } else {
                  const params = buildLabelQcResolveParams({ report: qcReport.value, actor: TUI_ACTOR, decidedAt: new Date().toISOString(), drafts });
                  if (!params.ok) {
                    renderer.appendLine(`✗ 裁决合成失败（未提交任何项）：${params.error.message}`);
                  } else {
                    const submitted = Array.isArray(params.value["decisions"]) ? (params.value["decisions"] as unknown[]).length : 0;
                    pendingSynthesized = synthesizeLabelQcResolveAction(params.value);
                    instructionText = labelQcConfirmationText(qcReport.value, submitted, qcItems.length - submitted);
                    continueMode = true;
                    renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·标签体检 选择=提交 ${String(submitted)} 项（未决 ${String(qcItems.length - submitted)} 项保持待确认）`);
                    renderer.appendLine("──────── 新 turn（同一 run 绑定下续跑；由事实日志重放重建上下文）────────");
                    continue;
                  }
                }
              } else if (gateAnswer !== "") {
                nextInstruction = gateAnswer; // 暂不处置＝该输入即新指令
                renderer.appendLine(`> 确认留痕 ${new Date().toISOString()} 动作=确认卡·标签体检 选择=暂不处置`);
              }
            }
          }
        }
      }
      if (nextInstruction === null) {
        for (;;) {
          rl.resume();
          const post = (await ask(rl, "新指令（直接回车=退出，r=重绘，e=展开/折叠长事件，h=展开历史）> ")).trim();
          if (post === "r" || post === "R") {
            renderer.reset();
            renderer.appendLine("（界面已重绘：过程流为 append-only 日志的纯重放，语义不变）");
            continue;
          }
          // B6 D1：折叠展开双向切换（切换后 reset 重放；仅展示层，日志零改动）
          if (post === "e" || post === "E") {
            renderer.setFoldExpanded(!renderer.isFoldExpanded);
            renderer.reset();
            renderer.appendLine(`（长事件已${renderer.isFoldExpanded ? "全部展开" : "重新折叠（阈值 20 物理行）"}）`);
            continue;
          }
          // B6 D2：h 展开历史重放（逐条，沿用 D1 渲染规则；日志零改动）
          if (post === "h" || post === "H") {
            if (!folder.reveal()) renderer.appendLine("（当前无可展开的历史批次——已展开或本会话无重放）");
            continue;
          }
          if (post !== "") nextInstruction = post;
          break;
        }
      }
      if (nextInstruction === null) break;
      instructionText = nextInstruction;
      continueMode = true;
      renderer.appendLine("──────── 新 turn（同一 run 绑定下续跑；由事实日志重放重建上下文）────────");
    }
  } finally {
    rl.close();
    // W2 D-1：隔离 HOME 退出即清（best-effort；kill -9 残留交 /tmp 自清理）
    if (peerReal !== null) rmSync(peerReal.home, { recursive: true, force: true });
    // 批 3：mock 模式下工作区工具宿主 HOME 退出即清（peer real 模式与对端隔离 HOME 同源，上面已清）
    if (peerReal === null && execHome !== null) rmSync(execHome, { recursive: true, force: true });
  }
};

await main();
