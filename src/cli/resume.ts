/**
 * L1a 门 2——CLI 最小应答通道前端（《ATF独立Harness_L1a门2任务书_20260914.md》§1.3）。
 *
 * 形态（v1 只做 CLI；socket / 界面不实现，接口预留——通道接口面在 src/core/run/resume.ts）：
 *   node dist/cli/resume.js --list --runs-root <dir> --run-id <id>
 *   node dist/cli/resume.js --answer <granted|advised|denied|abort> [--note "…"] [--request <事件id>]
 *       --runs-root <dir> --run-id <id> --scenario-id <id> [--mock <对端脚本路径>]
 *   node dist/cli/resume.js --recover-orphan-turn --runs-root <dir> --run-id <id>
 *       （B2 孤儿 turn 受控修复：仅当末 turn 无 turn/end 且流内零审批待办时合成收口
 *       turn/end（reason=orphan_recovered）；否则拒绝并给指引——fail-closed 不放松）
 *
 * 红线（ADR-07）：本命令即「人触发」的动作本身——答复由人显式给出，无任何非交互/
 * 自动应答模式；provider 配置经 ATF_LLM_CONFIG（0600）或 ATF_LLM_* 环境变量注入（D2）。
 *
 * 退出码 = resume run 的终局退出码（granted/advised/denied 继续跑完按实际终局；
 * abort = 79；前置/配置/目标非法 = 1）；--list 恒 0（有待办）/ 0（无待办，打印说明）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadLlmProviderConfig,
  createLlmProviderFromConfig,
  type ResolvedLlmProviderConfig,
} from "../llm/index.js";
import { formatThreePartLines, providerConfigThreePart } from "../core/index.js";
import { ToolRegistry, WORKSPACE_TOOL_HANDLERS, buildSkillsSystemSuffix, type LocalToolHost } from "../core/tools/index.js";
import { resolveKernelDir } from "../ui/tuiArgs.js";
import {
  ScenarioRunner,
  parseResumeArgs,
  listPendingApprovals,
  readSessionStream,
  recoverOrphanTurn,
  sessionLogPathFor,
  type BranchRunReport,
  type RunBranchOptions,
} from "../core/run/index.js";
import type { Scenario } from "../llm/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultMockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const printPendingList = async (runsRoot: string, runId: string): Promise<number> => {
  const stream = await readSessionStream(sessionLogPathFor(runsRoot, runId));
  if (!stream.ok) {
    console.error(`resume --list 失败: ${stream.error.message}`);
    return 1;
  }
  const pending = listPendingApprovals(stream.value);
  if (pending.length === 0) {
    console.log("无待人工应答的审批请求。");
    return 0;
  }
  console.log(`待人工应答的审批请求（${String(pending.length)} 条）：`);
  for (const item of pending) {
    console.log(`  request=${String(item.request_event_id)}  session=${item.approval_session_id}  tool=${item.tool}  attempt=${String(item.attempt)}  status=${item.status}`);
    console.log(`    params=${JSON.stringify(item.params)}`);
    console.log(`    tool_call_event=${String(item.tool_call_id)}  approval_key=${item.approval_key}`);
  }
  console.log("应答：node dist/cli/resume.js --answer <granted|advised|denied|abort> [--note \"…\"] [--request <事件id>] --runs-root … --run-id … --scenario-id …");
  return 0;
};

const runAnswer = async (
  runsRoot: string,
  runId: string,
  scenarioId: string,
  verdict: string,
  note: string | undefined,
  requestEventId: number | undefined,
  mockPath: string,
  scopeMode: "canonical" | "simulation" | "headless" | undefined,
): Promise<number> => {
  const config = await loadLlmProviderConfig();
  if (!config.ok) {
    console.error(formatThreePartLines(providerConfigThreePart(config.error.message, "配置文件经 ATF_LLM_CONFIG 指定（两层清单，0600）")));
    return 1;
  }
  // 批 3：工作区工具面装配（与 TUI 同构；内核目录可解析才启用，缺省 7 工具行为不变）。
  // 注意：resume 的执行 HOME 用进程 HOME（CLI 通道无对端隔离 home；内核配置根以本机为准）。
  let toolFace: RunBranchOptions["toolFace"] = undefined;
  let skillsSuffix: string | undefined;
  const kernelDirResolved = resolveKernelDir(process.env, repoRoot);
  if (kernelDirResolved.ok) {
    const home = process.env["HOME"] ?? "";
    const localHost: LocalToolHost = {
      scratchDir: join(runsRoot, runId, "scratch"),
      kernelDir: kernelDirResolved.path,
      home,
      baseEnv: { ...(process.env["ATF_WORKSPACE_ROOT"] !== undefined ? { ATF_WORKSPACE_ROOT: process.env["ATF_WORKSPACE_ROOT"] as string } : {}) },
    };
    skillsSuffix = await buildSkillsSystemSuffix(kernelDirResolved.path);
    toolFace = {
      registry: ToolRegistry.createWithWorkspaceTools(),
      local: { handlers: WORKSPACE_TOOL_HANDLERS, host: localHost },
    };
  }
  // pi-ai 换库批：protocol="pi-ai" → PiAiLlmProvider（库底座）；其余协议 → HttpLlmProvider
  //（既有行为逐位不变）。分发单点 = createLlmProviderFromConfig。
  const provider = createLlmProviderFromConfig({
    config: config.value as ResolvedLlmProviderConfig,
    tools: toolFace !== undefined ? toolFace.registry.modelVisible() : ToolRegistry.createDefault().modelVisible(),
    ...(skillsSuffix !== undefined ? { systemSuffix: skillsSuffix } : {}),
  });
  // provenance 三元组以既有 run 为准（RunWorkspace.create 内等值校验）；此处仅提供占位形态。
  // provider 字段类型面为 "faux"（场景脚本词汇）；resume 路径不消费该字段（无 segments），
  // 实际 provider = modelProvider 注入的装配产物（createLlmProviderFromConfig 按 protocol 分发）。
  const scenario: Scenario = {
    scenario_id: scenarioId,
    version: 1,
    provider: "faux",
    description: "L1a CLI resume",
    branches: {
      main: {
        branch_id: "main",
        run_id: runId,
        trigger_instruction: "(resume：以既有 provenance 为准)",
        purpose: "l1a-resume",
        setup: { ledger: [] },
        steps: [],
        expect: { outcome: "completed", exit_code: 0 },
      },
    },
  };
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot,
    mockCommand: ["node", mockPath],
    modelProvider: provider,
    ...(scopeMode !== undefined ? { scopeMode } : {}),
    // 批 3：工作区工具面注入（内核目录可解析时；缺省＝既有行为）
    ...(toolFace !== undefined ? { toolFace } : {}),
    resume: {
      verdict: verdict as "granted" | "advised" | "denied" | "abort",
      ...(note !== undefined ? { note } : {}),
      ...(requestEventId !== undefined ? { request_event_id: requestEventId } : {}),
    },
    // 审批面必须声明（resume 凭据放行经问答轨路径）；继续执行中如再次触发人工审批
    // （如 advised 后模型重新提案），headless 等待耗尽 → timeout 挂起（超时非否决），
    // 由人再次 resume 应答——无任何自动应答路径（ADR-07）。
    approvalSurface: { stub: async () => ({ verdict: "timeout" as const }) },
  });
  if (!ran.ok) {
    console.error(formatThreePartLines({
      fact: "resume 执行失败（会话未启动）",
      cause: `[${ran.error.code}] ${ran.error.message}`,
      fix: "核对 --runs-root/--run-id/--scenario-id 与会话流状态后重试；挂起续答应答先经 --list 确认待办",
    }));
    return 1;
  }
  const report: BranchRunReport = ran.value;
  console.log(`resume 终局: outcome=${report.outcome.kind} exit=${String(report.exit_code)} 事件数=${String(report.events.length)}`);
  if (report.outcome.kind === "failed") {
    console.error(`失败原因: [${report.outcome.error.code}] ${report.outcome.error.message}`);
    if (report.outcome.error.detail !== undefined) {
      console.error(`明细: ${JSON.stringify(report.outcome.error.detail)}`);
    }
  } else if (report.outcome.kind === "aborted" || report.outcome.kind === "suspended") {
    console.log(`block: ${report.outcome.block.reason} —— ${report.outcome.block.message}`);
  }
  return report.exit_code;
};

const args = parseResumeArgs(process.argv.slice(2));
if (!args.ok) {
  console.error(`参数非法: ${args.error}`);
  console.error("用法: node dist/cli/resume.js --list|--answer <verdict>|--recover-orphan-turn --runs-root <dir> --run-id <id> [--scenario-id <id>] [--note \"…\"] [--request <id>] [--mock <path>]");
  process.exitCode = 1;
} else if (args.value.mode === "list") {
  process.exitCode = await printPendingList(args.value.runsRoot, args.value.runId);
} else if (args.value.mode === "recover-orphan") {
  // B2（走查修复批 2026-09-23）：孤儿 turn 受控修复——显式旗标触发；条件不满足仍拒绝并给指引
  // （fail-closed 不放松）。修复后经 TUI 同 run 重进续跑（continue 通道；流尾零待办时才可修复，
  // 应答通道无待办可答，continue 即恢复路径）。
  const recovered = await recoverOrphanTurn(sessionLogPathFor(args.value.runsRoot, args.value.runId));
  if (!recovered.ok) {
    console.error(formatThreePartLines({
      fact: "孤儿 turn 修复未执行（会话流未改动）",
      cause: `[${recovered.error.code}] ${recovered.error.message}`,
      fix: recovered.error.code === "pending_approvals"
        ? "先经应答通道处理待办：node dist/cli/resume.js --list --runs-root … --run-id …；待办清零后重试本命令"
        : "核对 --runs-root/--run-id 与会话流状态后重试；无孤儿时无需修复",
    }));
    process.exitCode = 1;
  } else {
    const { event, diagnosis } = recovered.value;
    console.log(
      `孤儿 turn 已收口：turn=${String(diagnosis.turn_index)} 合成 turn/end 事件 id=${String(event.id)}` +
      `（reason=orphan_recovered，step_count=${String(diagnosis.step_count)} 按流内实计）`,
    );
    console.log("续跑：node dist/ui/tui.js --runs-root … --run-id … --instruction \"<新指令>\"（continue 通道，历史由事实日志重放重建）");
    process.exitCode = 0;
  }
} else {
  process.exitCode = await runAnswer(
    args.value.runsRoot,
    args.value.runId,
    args.value.scenarioId as string,
    args.value.verdict as string,
    args.value.note,
    args.value.requestEventId,
    args.value.mockPath ?? defaultMockPath,
    args.value.scopeMode,
  );
}
