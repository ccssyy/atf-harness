/**
 * L1a 门 2 冒烟——D4 试用任务全链（《ATF独立Harness_L1a门2任务书_20260914.md》§0 D4 / §3 VERIFY 3/4/5）。
 *
 * 任务（owner 裁定 D4）：读 run 事实索引 → 报数据集登记与闸门状态 → 提下一步建议；
 * 中途故意触发一次 atf_admit_data 以验挂起与放行。
 *
 * 全链形态（门 2 只连本地假端点，零真实网络）：
 *   [run 1]  模型（HttpLlmProvider × 假端点回放）自主只读链 bind_run → workspace_status →
 *            fact_scan → gate(query)（账本预录授权）→ atf_admit_data（无预录）→ 问答轨
 *            approval/request → headless 等待耗尽 → timeout（actor=harness，超时非否决）
 *            → 挂起 exit 75（INV-2：turn 收口 reason=suspended）。
 *   [CLI]    resume --list（子进程实跑）→ 看到待办。
 *   [run 2]  resume --answer granted --note …（子进程实跑）→ approval/response 落事件
 *            → 开新 turn（INV-1）→ 重派原 tool/call → 凭据 available 放行 → 真正执行
 *            （tool/result ok=true 且 call_ref 配对）→ 模型收束 final_answer → exit 0。
 *
 * 断言面：零外连（假端点请求台账：全部命中回环协议路径、认证头一致、key 不入请求体）；
 * 脱敏（全事件 + 报告 + 会话流序列化不含 fake key）；挂起/放行证据落盘。
 *
 * 用法（仓库根目录）：npm run smoke:l1a
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  FakeLlmEndpoint,
  HttpLlmProvider,
  loadLlmProviderConfig,
  PROVIDER_ENV_VARS,
  type FakeEndpointScriptItem,
} from "../llm/index.js";
import { approvalParamsDigest, ToolRegistry } from "../tools/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "./index.js";
import type { Scenario } from "../llm/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const cliPath = join(repoRoot, "dist", "cli", "resume.js");

/** 显式标注 fake 的假 key（仓内零凭据纪律：仅运行期生成于 tmp/，不进仓；不可被误用）。 */
const FAKE_API_KEY = "fake-l1a-api-key-DO-NOT-USE";
const FAKE_MODEL = "fake-model-l1a";
const SCENARIO_ID = "l1a-trial";
const RUN_ID = "run-l1a-trial";

/** D4 试用脚本（openai-chat canonical 面；假端点经 encodeWireResponse 回放）。 */
const TRIAL_SCRIPT: FakeEndpointScriptItem[] = [
  { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_fact_scan", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_gate", params: { gate: "g1", action: "query" } }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-l1a-trial" } }] } },
  {
    kind: "response",
    response: {
      final_answer:
        "数据集 ds-l1a-trial 已准入登记（人工放行）；G1 闸门查询通过；建议下一步：复核准入事实三元组并推进 G2 评估。",
    },
  },
];

const trialScenario = (): Scenario => ({
  scenario_id: SCENARIO_ID,
  version: 1,
  provider: "faux",
  description: "L1a 门 2 D4 试用任务",
  branches: {
    main: {
      branch_id: "main",
      run_id: RUN_ID,
      trigger_instruction: "读取本 run 事实索引，报告数据集登记与闸门状态，并给下一步建议；如需数据准入请发起 atf_admit_data。",
      purpose: "L1a D4 trial",
      // 只读链的 gate(query) 走账本轨预录授权（自主完成）；atf_admit_data 无预录 → 问答轨（人工）。
      setup: { ledger: [{ tool: "atf_gate", params: { gate: "g1", action: "query" } }] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const childRun = (cliArgs: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...cliArgs], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (cause) => reject(cause));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const smoke = async (): Promise<string[]> => {
  const evidence: string[] = [];
  const workDir = join(repoRoot, "tmp", `l1a-smoke-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  const runsRoot = join(workDir, "runs");

  // ① 本地假端点（127.0.0.1 回环；回放式）
  const endpoint = await FakeLlmEndpoint.start({
    protocol: "openai-chat",
    script: [...TRIAL_SCRIPT],
    expectedApiKey: FAKE_API_KEY,
    model: FAKE_MODEL,
  });
  try {
    // ② provider 配置文件（owner 指定路径形态：环境变量指向 0600 文件；不入仓）
    const configPath = join(workDir, "llm-provider.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          protocol: "openai-chat",
          base_url: endpoint.baseUrl,
          api_key: FAKE_API_KEY,
          model: FAKE_MODEL,
          timeout_ms: 10_000,
          max_retries: 1,
          max_calls_per_run: 50,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, [PROVIDER_ENV_VARS.configPath]: configPath };

    // ③ run 1：只读链自主完成 → admit 挂起（75）
    const config = await loadLlmProviderConfig(childEnv);
    if (!config.ok) throw new Error(`配置加载失败: ${config.error.message}`);
    const providerRun1 = new HttpLlmProvider({
      config: config.value,
      tools: ToolRegistry.createDefault().modelVisible(),
    });
    const ran1 = await ScenarioRunner.runBranch(trialScenario(), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: providerRun1,
      modelId: FAKE_MODEL,
      // headless 下无人在线：等待窗口耗尽 → timeout（超时非否决；非自动应答——不产生任何放行）
      approvalSurface: { stub: async (): Promise<ApprovalStubResponse> => ({ verdict: "timeout" }) },
    });
    if (!ran1.ok) throw new Error(`run 1 runner 失败: ${ran1.error.message}`);
    const report1: BranchRunReport = ran1.value;
    if (report1.outcome.kind !== "suspended" || report1.exit_code !== 75) {
      throw new Error(`run 1 期望挂起 75，实得 ${report1.outcome.kind}/${String(report1.exit_code)}`);
    }
    const lastTurn1 = report1.events.filter((event) => event.type === "turn/end").at(-1);
    if ((lastTurn1?.payload as { reason?: string } | undefined)?.reason !== "suspended") {
      throw new Error("INV-2 违例：挂起终局未以 turn/end(suspended) 收口");
    }
    const request1 = report1.events.find((event: { type: string }) => event.type === "approval/request");
    if (request1 === undefined) throw new Error("挂起闭环缺 approval/request");
    evidence.push(`run 1: 挂起闭环成立（exit 75；approval/request#${String(request1.id)} tool=atf_admit_data；turn 收口 reason=suspended）`);
    evidence.push(`run 1: 模型调用 ${String(providerRun1.calls)} 次（只读链 + admit 提案），全部经守卫与逐工具审批`);

    // ④ CLI --list（子进程实跑）
    const listed = await childRun(
      ["--list", "--runs-root", runsRoot, "--run-id", RUN_ID],
      childEnv,
    );
    if (listed.code !== 0) throw new Error(`CLI --list 失败(exit=${String(listed.code)}): ${listed.stderr}`);
    if (!listed.stdout.includes(`request=${String(request1.id)}`)) throw new Error(`CLI --list 未列出待办 ${String(request1.id)}`);
    evidence.push(`CLI resume --list: 待办可见（request#${String(request1.id)}，status=timeout_awaiting_human）`);

    // ⑤ CLI --answer granted（子进程实跑；答复落事件 → 开新 turn → 重派执行）
    const answered = await childRun(
      [
        "--answer", "granted",
        "--note", "同意准入 ds-l1a-trial（已备案）",
        "--request", String(request1.id),
        "--runs-root", runsRoot,
        "--run-id", RUN_ID,
        "--scenario-id", SCENARIO_ID,
        "--mock", mockPath,
      ],
      childEnv,
    );
    if (answered.code !== 0) throw new Error(`CLI --answer 失败(exit=${String(answered.code)}): ${answered.stderr}\n${answered.stdout}`);
    evidence.push(`CLI resume --answer granted: exit ${String(answered.code)}；${answered.stdout.trim().split("\n")[0]}`);

    // ⑥ 落盘证据核验（会话流 = 跨进程完整事实链）
    const streamText = await readFile(join(runsRoot, RUN_ID, "session.jsonl"), "utf8");
    const stream = streamText.split("\n").filter((line) => line !== "");
    const responseGranted = stream.find((line) => line.includes('"verdict":"granted"') && line.includes('"actor":"cli-operator"'));
    if (responseGranted === undefined) throw new Error("会话流缺 CLI granted 应答（actor=cli-operator）");
    const turnStarts = stream.filter((line) => line.includes('"type":"turn/start"'));
    if (turnStarts.length !== 2) throw new Error(`INV-1 违例：resume 未开新 turn（turn/start 共 ${String(turnStarts.length)} 条）`);
    const admitResultLine = stream.find((line) => line.includes('"type":"tool/result"') && line.includes('"ok":true') && line.includes("atf_admit_data"));
    if (admitResultLine === undefined) throw new Error("放行后未见 atf_admit_data 执行成功回填");
    const callLine = stream.find((line) => line.includes('"type":"tool/call"') && line.includes("atf_admit_data"));
    const callId = JSON.parse(callLine as string).id as number;
    const resultLine = JSON.parse(admitResultLine as string) as { payload: { call_ref?: number } };
    if (resultLine.payload.call_ref !== callId) throw new Error("call_ref 与原 tool/call 不配对（重派语义破坏）");
    evidence.push(`落盘证据: granted 应答 + 2×turn/start（新进程新 turn）+ tool/result(ok=true, call_ref=${String(callId)}) 全在流内`);

    // ⑦ 零外连 + 认证 + 脱敏断言（假端点请求台账）
    const requests = endpoint.requests;
    if (requests.length !== providerRun1.calls + 1) {
      throw new Error(`假端点请求数不符: 台账 ${String(requests.length)} ≠ run1 ${String(providerRun1.calls)} + resume 1`);
    }
    for (const record of requests) {
      if (record.path !== "/v1/chat/completions") throw new Error(`零外连违例：请求打到 ${record.path}`);
      if (record.auth !== "ok") throw new Error(`认证头缺失或不匹配（${record.auth}）`);
      if (!record.protocolHeaderOk) throw new Error("协议头缺失");
      if (record.apiKeyInBody) throw new Error("脱敏违例：api_key 出现在请求体");
    }
    evidence.push(`零外连断言: ${String(requests.length)} 笔请求全部命中回环 /v1/chat/completions；认证头一致；key 未入请求体`);

    // ⑧ 脱敏断言：全事件 + 报告 + 会话流 + CLI 输出不含 fake key
    const sensitiveSurface = JSON.stringify({
      events: report1.events,
      report: report1,
      stream: streamText,
      cliStdout: listed.stdout + answered.stdout,
      cliStderr: listed.stderr + answered.stderr,
    });
    if (sensitiveSurface.includes(FAKE_API_KEY)) throw new Error("脱敏违例：fake key 出现在事件/报告/会话流/CLI 输出");
    evidence.push("脱敏断言: 事件/报告/会话流/CLI 输出全序列化不含 fake key");

    return evidence;
  } finally {
    await endpoint.close();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

try {
  const evidence = await smoke();
  console.log("L1a 门 2 冒烟（D4 试用任务）通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
} catch (cause) {
  console.error(`L1a 门 2 冒烟失败: ${(cause as Error).message}`);
  process.exitCode = 1;
}
