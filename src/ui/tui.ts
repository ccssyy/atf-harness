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
import { ToolRegistry } from "../core/tools/index.js";
import { ScenarioRunner, resolveRunExitCode, sessionLogPathFor, listPendingApprovals, readSessionStream, type ApprovalStubResponse, type BranchRunReport } from "../core/run/index.js";
import { HistoryFolder } from "./historyFold.js";
import type { Scenario } from "../llm/index.js";
import { DiffRenderer } from "./renderer.js";
import { formatEventDetailLines, formatEventLine } from "./eventView.js";
import { collapseLines } from "./collapseView.js";
import { askApproval } from "./approval.js";
import { buildInitInvocation, buildRealPeerDescriptor, effectiveScopeMode, parseArgs, repoRootDefault, resolveKernelDir, usage } from "./tuiArgs.js";
import { setCompactionContextWindow } from "../core/session/constantsBudget.js";
import {
  applyFieldInput,
  canonicalConfirmationText,
  cardFields,
  confirmCardFromResult,
  confirmCardLines,
  confirmationEchoLine,
  type ConfirmCard,
} from "./confirmCard.js";
import { completedSummaryLines } from "./completedSummary.js";

const ask = (rl: readline.Interface, prompt: string, fallback?: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed !== "" ? trimmed : (fallback ?? ""));
    });
  });

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
    // B4：多轮续跑循环——每个 prompt 一个 turn（审批闸逐 turn 生效）；空输入/Ctrl+C 退出
    for (;;) {
      const provider = new HttpLlmProvider({
        config,
        tools: ToolRegistry.createDefault().modelVisible(),
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
          // A2：live propose 成功结果 → 确认卡候选（携带 cluster_params_template/policy_template 才成卡）
          if (origin === "live" && event.type === "tool/result") {
            const payload = event.payload as { ok?: unknown; result?: unknown } | null;
            if (payload?.ok === true) {
              const card = confirmCardFromResult(payload.result);
              if (card !== null) cardRef.pending = card;
            }
          }
        },
        ...(continueMode ? { continue: { instruction: instructionText } } : {}),
        ...(effectiveScopeMode(args) !== "headless" ? { scopeMode: effectiveScopeMode(args) } : {}),
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
            if (!field.editable) continue; // null 待定字段不向用户要值（owner 21:38 原则）
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
  }
};

await main();
