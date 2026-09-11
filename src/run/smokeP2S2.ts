/**
 * P2-S2 手工冒烟命令(Phase 2 任务书 §3:问答轨六类应答分支)。
 *
 * 六类应答各一组 + 拒绝循环升级 + headless 等价性,经 ScenarioRunner 全链路
 * (mock 对端 + 注入式问答桩;桩属测试基建,非运行时依赖路径)。
 *
 * 用法(仓库根目录):
 *   npm run smoke:p2s2
 *
 * 退出码:全部通过 = 0;任一步失败 = 1。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "../bridge/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "./index.js";
import type { Scenario, ScenarioStep } from "../llm/index.js";
import { sessionError, type SessionError } from "../session/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const ADMIT = { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-smoke-p2s2" } } as const;
const STATUS = { type: "tool_call", tool: "atf_workspace_status", params: {} } as const;
const DONE = { type: "final_answer", text: "收束" } as const;

let seq = 0;
const makeScenario = (steps: readonly ScenarioStep[]): Scenario => ({
  scenario_id: `p2s2-smoke-${++seq}`,
  version: 1,
  provider: "faux",
  description: "P2-S2 问答轨冒烟",
  branches: {
    main: {
      branch_id: "main",
      run_id: `run-p2s2-smoke-${seq}`,
      trigger_instruction: "问答轨冒烟",
      purpose: "smoke",
      setup: { ledger: [] },
      steps: [...steps],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const scriptStub = (responses: ApprovalStubResponse[]) => {
  let i = 0;
  return async (): Promise<ApprovalStubResponse> => {
    const next = responses[i];
    i += 1;
    return next ?? { verdict: "timeout" };
  };
};

const runBranch = async (scenario: Scenario, stub?: (input: never) => Promise<ApprovalStubResponse>): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: join(repoRoot, "tmp", "runs", `smoke-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    ...(stub !== undefined ? { approvalSurface: { stub: stub as never } } : {}),
  });
  if (!ran.ok) throw new Error(`runner 失败: ${ran.error.message}`);
  return ran.value;
};

const smoke = async (): Promise<Result<undefined, SessionError>> => {
  const step = async (name: string, expect: { kind: string; exit: number }, run: () => Promise<BranchRunReport>): Promise<void> => {
    const report = await run();
    if (report.outcome.kind !== expect.kind || report.exit_code !== expect.exit) {
      throw new Error(`${name}: outcome=${report.outcome.kind} exit=${String(report.exit_code)}`);
    }
    console.log(`✓ ${name}(outcome=${report.outcome.kind}, exit=${String(report.exit_code)})`);
  };

  await step("granted 放行执行", { kind: "completed", exit: 0 }, async () =>
    runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "granted", actor: "stub-host" }])));
  await step("advised 重提案(supersedes 链)", { kind: "completed", exit: 0 }, async () =>
    runBranch(makeScenario([ADMIT, ADMIT, DONE]), scriptStub([
      { verdict: "advised", actor: "stub-host", advice_text: "用正式编号" },
      { verdict: "granted", actor: "stub-host" },
    ])));
  await step("denied 换路径(非终局)", { kind: "completed", exit: 0 }, async () =>
    runBranch(makeScenario([ADMIT, STATUS, DONE]), scriptStub([{ verdict: "denied", actor: "stub-host", reason: "未备案" }])));
  await step("clarification 同会话多轮", { kind: "completed", exit: 0 }, async () =>
    runBranch(makeScenario([ADMIT, DONE]), scriptStub([
      { verdict: "clarification", actor: "stub-host", question: "来源?" },
      { verdict: "granted", actor: "stub-host" },
    ])));
  await step("aborted 终态", { kind: "aborted", exit: 79 }, async () =>
    runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "aborted", actor: "stub-host", reason: "取消" }])));
  await step("timeout 挂起", { kind: "suspended", exit: 75 }, async () =>
    runBranch(makeScenario([ADMIT, DONE]), scriptStub([{ verdict: "timeout" }])));
  await step("拒绝循环升级(第 3 次提案)", { kind: "aborted", exit: 79 }, async () =>
    runBranch(makeScenario([ADMIT, ADMIT, ADMIT, DONE]), scriptStub([
      { verdict: "denied", actor: "stub-host", reason: "r1" },
      { verdict: "denied", actor: "stub-host", reason: "r2" },
    ])));
  await step("headless 等价(未声明审批面 → 78)", { kind: "approval_missing", exit: 78 }, async () =>
    runBranch(makeScenario([ADMIT, DONE])));
  return ok(undefined);
};

// S2a C-2 验收断言:会话句柄必须显式关闭——出现 DEP0137(FileHandle 被 GC 回收关闭)警告即判失败
// (进程内 tripwire,先于退出观察到者即失败;全量输出的 grep 核验另在 VERIFY 执行)
const gcHandleWarnings: string[] = [];
process.on("warning", (warning) => {
  if ((warning as NodeJS.ErrnoException).code === "DEP0137") gcHandleWarnings.push(warning.message);
});

const result = await smoke();
if (!result.ok) {
  console.error(`P2-S2 冒烟失败: ${result.error.message}`);
  process.exitCode = 1;
} else if (gcHandleWarnings.length > 0) {
  console.error(`P2-S2 冒烟失败: 出现 ${String(gcHandleWarnings.length)} 条 FileHandle GC 回收警告(句柄未显式 close)`);
  for (const message of gcHandleWarnings) console.error(`  - ${message}`);
  process.exitCode = 1;
} else console.log("P2-S2 冒烟通过 ✓(六类应答 + 升级 + headless 等价 + 无句柄警告)");
