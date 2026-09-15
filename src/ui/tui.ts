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
 *        [--mock <桥接 serve 脚本路径>] [--help]
 *   缺省：runs-root=<repo>/tmp/ui-runs；mock=tests/fixtures/mock_atf.mjs（真内核可传
 *   L1a launcher 脚本，形态同 trial:l1a-real）；缺 run-id/instruction 时交互补问。
 *
 * 红线：provider 配置经 ATF_LLM_CONFIG（0600）/ATF_LLM_* 注入（沿用 L1a，D2）；应答
 * 只能由人在本界面给出，无任何自动应答（ADR-07）；挂起 run 的续答应答 v1 仍走 CLI
 * resume 通道（登记 L1b 优化：TUI 内 resume）。
 * 退出码 = run 终局码（0/1/75/78/79，单一出口 resolveRunExitCode）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { loadLlmProviderConfig, HttpLlmProvider, type ResolvedLlmProviderConfig } from "../llm/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import { ScenarioRunner, resolveRunExitCode, type ApprovalStubResponse, type BranchRunReport } from "../core/run/index.js";
import type { Scenario } from "../llm/index.js";
import { DiffRenderer } from "./renderer.js";
import { formatEventLine } from "./eventView.js";
import { askApproval } from "./approval.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const defaultMockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const defaultRunsRoot = join(repoRoot, "tmp", "ui-runs");

interface TuiArgs {
  runsRoot: string;
  runId?: string;
  instruction?: string;
  scenarioId: string;
  scopeMode: "headless" | "canonical" | "simulation";
  mockPath: string;
  help: boolean;
}

const usage = (): string =>
  [
    "ATF Harness TUI（前端一 · 主入口，同进程直连 core）",
    "",
    "用法: node dist/ui/tui.js [--runs-root <dir>] [--run-id <id>] [--instruction <text>]",
    "      [--scenario-id <id>] [--scope-mode headless|canonical|simulation] [--mock <path>]",
    "",
    "  --runs-root      run 工作区根目录（缺省 <repo>/tmp/ui-runs）",
    "  --run-id         run 标识（缺省交互补问）",
    "  --instruction    触发指令（缺省交互补问）",
    "  --scenario-id    场景账面标识（缺省 l1ui-session）",
    "  --scope-mode     账本 scope_mode（缺省 headless；真实内核传 canonical）",
    "  --mock           内核桥接 serve 脚本（缺省 mock 夹具；真内核传 L1a launcher）",
    "",
    "红线: provider 配置经 ATF_LLM_CONFIG 注入（沿用 L1a）；审批应答只能由人在本界面给出。",
  ].join("\n");

const parseArgs = (argv: readonly string[]): TuiArgs | { error: string } => {
  const args: TuiArgs = {
    runsRoot: defaultRunsRoot,
    scenarioId: "l1ui-session",
    scopeMode: "headless",
    mockPath: defaultMockPath,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const take = (): string => {
      i += 1;
      return next as string;
    };
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--runs-root":
        args.runsRoot = take();
        break;
      case "--run-id":
        args.runId = take();
        break;
      case "--instruction":
        args.instruction = take();
        break;
      case "--scenario-id":
        args.scenarioId = take();
        break;
      case "--mock":
        args.mockPath = take();
        break;
      case "--scope-mode": {
        const value = take();
        if (value !== "headless" && value !== "canonical" && value !== "simulation") {
          return { error: `--scope-mode 非法: ${value}（允许 headless|canonical|simulation）` };
        }
        args.scopeMode = value;
        break;
      }
      default:
        return { error: `未知参数: ${arg ?? "(空)"}（--help 查看用法）` };
    }
  }
  return args;
};

const ask = (rl: readline.Interface, prompt: string, fallback?: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed !== "" ? trimmed : (fallback ?? ""));
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
    renderer.appendLine(`✗ provider 配置加载失败（fail-closed）: ${configResult.error.message}`);
    process.exitCode = 1;
    return;
  }
  const config: ResolvedLlmProviderConfig = configResult.value;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    renderer.appendLine("══ ATF Harness TUI（前端一 · 同进程直连 core）══");
    renderer.appendLine(`provider=${config.provider_id} model=${config.model}（沿用 L1a 选型）· 零 npm 依赖`);
    const runId = args.runId ?? (await ask(rl, "run-id> "));
    const instruction = args.instruction ?? (await ask(rl, "触发指令> "));
    if (runId === "" || instruction === "") {
      renderer.appendLine("✗ run-id 与触发指令均必填（fail-closed）");
      process.exitCode = 1;
      return;
    }
    rl.pause(); // 运行期收摄输入（审批弹窗内由 askApproval resume）
    mkdirSync(args.runsRoot, { recursive: true });
    renderer.appendLine(`run=${runId} · 工作区根=${args.runsRoot} · 桥接=${args.mockPath}`);
    renderer.appendLine("──────── 过程流（与 append-only 日志逐条对应）────────");

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
          trigger_instruction: instruction,
          purpose: "l1-tui",
          setup: { ledger: [] },
          steps: [],
          expect: { outcome: "completed", exit_code: 0 },
        },
      },
    };
    const ran = await ScenarioRunner.runBranch(scenario, "main", {
      runsRoot: args.runsRoot,
      mockCommand: ["node", args.mockPath],
      modelProvider: provider,
      modelId: config.model,
      approvalSurface: {
        stub: async (input) => await askApproval({ renderer, rl, input }),
      },
      onEvent: (event, origin) => {
        renderer.appendLine(formatEventLine(event, origin));
      },
      ...(args.scopeMode !== "headless" ? { scopeMode: args.scopeMode } : {}),
    });
    if (!ran.ok) {
      renderer.appendLine(`✗ run 启动失败: ${ran.error.message}`);
      process.exitCode = 1;
      return;
    }
    const report: BranchRunReport = ran.value;
    renderer.appendLine("──────── 终局 ────────");
    renderer.appendLine(`outcome=${report.outcome.kind} exit=${String(report.exit_code)} 事件数=${String(report.events.length)} 模型调用=${String(provider.calls)} 次`);
    if (report.outcome.kind === "failed") {
      renderer.appendLine(`失败原因: [${report.outcome.error.code}] ${report.outcome.error.message}`);
    } else if (report.outcome.kind !== "completed") {
      const block = report.outcome.block;
      renderer.appendLine(`block: ${block.reason} —— ${block.message}`);
      if (report.outcome.kind === "suspended") {
        renderer.appendLine("挂起可续：node dist/cli/resume.js --answer <granted|advised|denied|abort> --runs-root … --run-id … --scenario-id …（L1b 起 TUI 内 resume）");
      }
    }
    process.exitCode = report.exit_code;
  } finally {
    rl.close();
  }
};

await main();
