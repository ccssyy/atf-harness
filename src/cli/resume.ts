/**
 * L1a 门 2——CLI 最小应答通道前端（《ATF独立Harness_L1a门2任务书_20260914.md》§1.3）。
 *
 * 形态（v1 只做 CLI；socket / 界面不实现，接口预留——通道接口面在 src/core/run/resume.ts）：
 *   node dist/cli/resume.js --list --runs-root <dir> --run-id <id>
 *   node dist/cli/resume.js --answer <granted|advised|denied|abort> [--note "…"] [--request <事件id>]
 *       --runs-root <dir> --run-id <id> --scenario-id <id> [--mock <对端脚本路径>]
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
  HttpLlmProvider,
  type ResolvedLlmProviderConfig,
} from "../llm/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import {
  ScenarioRunner,
  parseResumeArgs,
  listPendingApprovals,
  readSessionStream,
  sessionLogPathFor,
  type BranchRunReport,
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
    console.error(`provider 配置加载失败（fail-closed）: ${config.error.message}`);
    return 1;
  }
  const provider = new HttpLlmProvider({
    config: config.value as ResolvedLlmProviderConfig,
    tools: ToolRegistry.createDefault().modelVisible(),
  });
  // provenance 三元组以既有 run 为准（RunWorkspace.create 内等值校验）；此处仅提供占位形态。
  // provider 字段类型面为 "faux"（场景脚本词汇）；resume 路径不消费该字段（无 segments），
  // 实际 provider = modelProvider 注入的 HttpLlmProvider。
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
    console.error(`resume 执行失败: ${ran.error.message}`);
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
  console.error("用法: node dist/cli/resume.js --list|--answer <verdict> --runs-root <dir> --run-id <id> [--scenario-id <id>] [--note \"…\"] [--request <id>] [--mock <path>]");
  process.exitCode = 1;
} else if (args.value.mode === "list") {
  process.exitCode = await printPendingList(args.value.runsRoot, args.value.runId);
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
