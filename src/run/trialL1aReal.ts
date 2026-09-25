/**
 * L1a 真实端点复跑（owner 授权：《ATF-Harness_Owner决议与指令_配置修订v2验收_推送_20260914.md》§4）。
 *
 * 授权范围：经配置选中的 provider 发起真实 LLM 调用（本复跑取条款内 provider，按量）；
 * 试用任务 = L1a 设计 §2/D4：真实模型自主只读链 → 中途触发一次 atf_admit_data（真实写，
 * 落 /tmp 夹具根）→ CLI 放行 → 动作执行。硬前提：① 合成 tool_result 首行显式标注
 * "[未执行：等待人工审批]"（修订 v2 已落实，本脚本断言）；② 新 snapshot/binding（真实内核
 * mkdtemp 夹具 + bind_run，见下）；③ 凭据仅经 owner .env/配置注入，全程脱敏断言。
 * 预算不放宽：轮次 32/8 + 单 run 调用上限 50（真实调用计入）。
 *
 * 执行序列（真实内核 = ATF_CLI_PATH pin 副本；会话对端经 launcher 子进程承载 cwd/env）：
 *   [preflight] 注入式 serve（恰 1 条预录授权）账本探针：scope 逐字段匹配 → query 1 条 → consume 一次
 *   [run 1]     真实模型自主只读链（bind_run 由 runner 桥接）→ gate(query)（L1b B7 N1：
 *               免审批自主执行）→ atf_admit_data（无预录）→ 问答轨 approval/request →
 *               headless 等待耗尽 timeout → 挂起 75（preflight 预录已被探针自身消费，
 *               不残留授权）
 *   [CLI]       resume --list → 待办可见
 *   [run 2]     resume --answer granted（纯净 serve，账本为空）→ 重派原 tool/call →
 *               凭据 available 放行 → 真实写 datasets/<id>@<pin>/registration.json → 模型收束 → exit 0
 *
 * 脱敏红线：key 值只在进程内比较（不打印、不落报告）；最终对事件/报告/会话流/CLI 输出做
 * 全序列化 not-contains 断言。隔离红线：pin 副本 git status 零改动；temp HOME 无技能泄漏；
 * 真实写仅落 /tmp 夹具根（合成数据）。
 *
 * 用法（仓库根目录）：
 *   ATF_CLI_PATH=<pin 副本> ATF_LLM_CONFIG=<两层配置> npm run trial:l1a-real
 * 凭据：<配置文件同目录>/.env（0600；KEY=VALUE，注入 ATF_LLM_KEY_*，值永不打印）。
 * 退出码：全链通过 = 0；任一步失败 = 1。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "../bridge/index.js";
import { AtfBridgeConnection } from "../bridge/connection.js";
import { ATF_UPSTREAM_COMMIT_SHA, atfCliPathFromEnv, deriveAtfCommand } from "../bridge/atfCommand.js";
import { danglingToolResultContent } from "../llm/codecWire.js";
import {
  HttpLlmProvider,
  PROVIDER_ENV_VARS,
  loadLlmProviderConfig,
  type ResolvedLlmProviderConfig,
} from "../llm/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import { ScenarioRunner, type ApprovalStubResponse, type BranchRunReport } from "../core/run/index.js";
import { setCompactionContextWindow } from "../core/session/constantsBudget.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(repoRoot, "dist", "cli", "resume.js");

const SCENARIO_ID = "l1a-real-trial";
const RUN_ID = "l1a-real-trial-run-1";
const DATASET_ID = "ds-l1a-real-trial";

/** 内核 run 十目录骨架与四组准入 GateId（与 R2 真对端夹具同源的试运行内联版）。 */
const RUN_SKELETON = ["experiment-setup", "l1", "variants", "launch", "training", "models", "eval", "journal", "verification", "decisions"] as const;
const ADMISSION_GATE_IDS = ["extraction-contract-valid", "source-identity-valid", "split-integrity-valid", "training-data-valid"] as const;

function fail(message: string): never {
  throw new Error(message);
}

const execFileP = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd: options.cwd, env: options.env }, (error, stdout, stderr) => {
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

/** owner .env 装载（KEY=VALUE；只回变量名清单，值永不返回/打印）。 */
const loadDotEnv = async (dotenvPath: string): Promise<Result<{ values: Record<string, string>; names: string[] }, string>> => {
  const info = await stat(dotenvPath).then(
    (value) => ok(value),
    () => err(`凭据 .env 不存在（期望位于配置文件同目录）`),
  );
  if (!info.ok) return err(info.error);
  const mode = info.value.mode & 0o777;
  if ((mode & 0o077) !== 0) return err(`凭据 .env 权限必须为 0600（实得 0${mode.toString(8)}）`);
  const text = await readFile(dotenvPath, "utf8");
  const values: Record<string, string> = {};
  const names: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "" || value === "") continue;
    values[key] = value;
    names.push(key);
  }
  return ok({ values, names });
};

/** 注入式对端预录脚本（恰 1 条预录授权 = 只读链 gate query 消费；scope 与 runner 查询逐字段一致）。 */
const trialLedgerPrelude = (): string => `
import json, sys
from agentic_training_flow.contracts import ApprovalRef
from agentic_training_flow.contracts.models import ScopeRef
from agentic_training_flow.facts.owners import FactOwners, OperatorCommand
from agentic_training_flow.session.runner import run_session
from agentic_training_flow.session.tools import build_registry

class _Channel:
    def send_event(self, name, payload):
        frame = json.dumps({"type": "event", "name": name, "payload": payload}, ensure_ascii=False)
        sys.stdout.buffer.write((frame + "\\n").encode("utf-8"))
        sys.stdout.buffer.flush()

owners = FactOwners()
scope = ScopeRef("${SCENARIO_ID}", "run", "${RUN_ID}", "canonical")
command = OperatorCommand(
    command_id="l1a-trial-cmd-001", command_type="approval", actor="l1a-trial-owner",
    scope_ref=scope, operation_id="l1a-trial-op-001", attempt_id="l1a-trial-attempt-001",
    subject_ref="l1a-trial-apr-001", evidence_refs=("l1a-trial-evidence",), decision="approve")
ledger = owners.approval_ledger
ledger.register_command(command)
ledger.consume_command(
    command.command_id,
    ApprovalRef("l1a-trial-apr-001", scope, "l1a-trial-op-001", "l1a-trial-attempt-001"),
    "l1a-trial-owner", 0)
run_session(sys.stdin.buffer, sys.stdout.buffer, registry=build_registry(channel=_Channel(), owners=owners))
`;

/** 会话对端 launcher（承载真实内核 spawn 的 cwd/env；runner/CLI 经 `node <launcher>` 使用）。
 *  mode = injected（预录 1 条）/ plain（纯净 serve，账本为空）。运行期生成于临时目录，不入仓。 */
const writeLauncher = async (dir: string, name: string, pinPath: string, home: string, mode: "injected" | "plain"): Promise<string> => {
  const invocation = deriveAtfCommand(pinPath, mode === "plain" ? ["serve"] : []);
  const argsJson = JSON.stringify(mode === "plain" ? invocation.args : ["-c", trialLedgerPrelude()]);
  const script = `#!/usr/bin/env node
// L1a 真实端点复跑——会话对端 launcher（${mode}）
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(invocation.command)}, ${argsJson}, {
  cwd: ${JSON.stringify(invocation.cwd)},
  env: { ...process.env, ...${JSON.stringify(invocation.env)}, HOME: ${JSON.stringify(home)} },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (cause) => { console.error(cause); process.exit(1); });
`;
  const path = join(dir, name);
  await writeFile(path, script, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

interface TrialFixture {
  pinPath: string;
  home: string;
  wsRoot: string;
  cleanup(): Promise<void>;
}

/** 真实内核夹具（mkdtemp /tmp 三层隔离；atf init 装机 + run 骨架 + journal + 准入 summary）。 */
const createTrialFixture = async (): Promise<TrialFixture> => {
  const cli = atfCliPathFromEnv();
  if (!cli.ok) fail(`ATF_CLI_PATH 未设置: ${cli.error.message}`);
  const pinPath = cli.value;
  const mkdtemp = async (prefix: string): Promise<string> => {
    const dir = join(tmpdir(), `${prefix}${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const home = await mkdtemp("atf-l1a-home-");
  const wsRoot = await mkdtemp("atf-l1a-ws-");
  const baseEnv = (): NodeJS.ProcessEnv => {
    const invocation = deriveAtfCommand(pinPath, []);
    return { ...process.env, ...invocation.env, HOME: home };
  };
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    await rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const init = deriveAtfCommand(pinPath, ["init", "--workspace-root", wsRoot]);
    const ran = await execFileP(init.command, init.args, { cwd: init.cwd, env: baseEnv() });
    if (ran.exitCode !== 0) fail(`atf init 失败(exit=${String(ran.exitCode)}): ${ran.stderr.slice(0, 200)}`);
    if (!ran.stdout.includes(wsRoot)) fail(`atf init 输出未确认 workspace_root: ${ran.stdout.slice(0, 200)}`);
    for (const sub of RUN_SKELETON) await mkdir(join(wsRoot, "runs", RUN_ID, sub), { recursive: true });
    const journalLine = (payload: Record<string, unknown>): string => `${JSON.stringify(payload)}\n`;
    const journalDir = join(wsRoot, "runs", RUN_ID, "journal");
    await mkdir(journalDir, { recursive: true });
    const events = [
      { ts: "2026-09-14T00:00:00Z", action: "experiment_setup", out: null, refs: {} },
      { ts: "2026-09-14T00:00:01Z", action: "eval_service_generated", out: null, refs: { manifest: "a".repeat(64) } },
      { ts: "2026-09-14T00:00:02Z", action: "train_launch_generated", out: "launch", refs: {} },
    ];
    await writeFile(join(journalDir, "journal.jsonl"), events.map(journalLine).join(""), "utf8");
    // re-pin v0.7.7b0 摘要化路径同步（K3 伴随件）：逐闸 evaluated:true 来源标记（modern 形态）。
    const gates = ADMISSION_GATE_IDS.map((gate_id) => ({ gate_id, verdict: "pass", evaluated: true }));
    const laneDir = join(wsRoot, "runs", RUN_ID, "l1", "lane-a");
    await mkdir(laneDir, { recursive: true });
    await writeFile(join(laneDir, "lane-a-source-backed-admission-summary.json"), `${JSON.stringify({ gates }, null, 1)}\n`, "utf8");
  } catch (cause) {
    await cleanup();
    throw cause;
  }
  return { pinPath, home, wsRoot, cleanup };
};

const smoke = async (): Promise<string[]> => {
  const evidence: string[] = [];
  const workDir = join(tmpdir(), `l1a-real-trial-${randomUUID()}`);
  await mkdir(join(workDir, "runs"), { recursive: true });
  const runsRoot = join(workDir, "runs");

  // ── 硬前提 ①：合成 tool_result 未执行标注（修订 v2 落实，此处断言留证） ──
  if (!danglingToolResultContent(["[审批往返] 摘要样例"]).startsWith("[未执行：等待人工审批]")) {
    fail("硬前提①不满足：合成 tool_result 未以 [未执行：等待人工审批] 开头");
  }
  evidence.push("硬前提① 合成 tool_result 首行标注 [未执行：等待人工审批] —— 已在位（修订 v2 codecWire.danglingToolResultContent）");

  // ── 对端就绪：ATF_CLI_PATH 指向 pin 副本（HEAD 与契约 pin 一致） ──
  const cli = atfCliPathFromEnv();
  if (!cli.ok) fail(`ATF_CLI_PATH 未设置: ${cli.error.message}`);
  const head = await execFileP("git", ["-C", cli.value, "rev-parse", "HEAD"]);
  if (head.stdout.trim() !== ATF_UPSTREAM_COMMIT_SHA) {
    fail(`pin 副本 HEAD ${head.stdout.trim()} ≠ 契约 pin ${ATF_UPSTREAM_COMMIT_SHA}`);
  }
  evidence.push(`对端 = pin 副本（HEAD = ${ATF_UPSTREAM_COMMIT_SHA.slice(0, 12)}…，与契约 pin 一致；只读）`);

  // ── 配置与凭据（owner .env；值不打印） ──
  const configPath = process.env[PROVIDER_ENV_VARS.configPath];
  if (configPath === undefined || configPath === "") fail(`${PROVIDER_ENV_VARS.configPath} 未设置（owner 两层配置，如 ~/.atf-harness/llm.json）`);
  const dotenv = await loadDotEnv(join(dirname(configPath as string), ".env"));
  if (!dotenv.ok) fail(dotenv.error);
  const env: NodeJS.ProcessEnv = { ...process.env, ...dotenv.value.values };
  const config = await loadLlmProviderConfig(env);
  if (!config.ok) fail(`配置加载失败: ${config.error.message}`);
  const cfg: ResolvedLlmProviderConfig = config.value;
  // A1.5.2（L1c 提前批）：进程级 compaction 触发水位注入（与 TUI 同源；未配置回退 24K）。
  setCompactionContextWindow(cfg.context_window);
  evidence.push(`配置选中 provider=${cfg.provider_id} model=${cfg.model} protocol=${cfg.protocol} host=${new URL(cfg.base_url).host} api_key_len=${String(cfg.api_key.length)} reasoning_effort=${cfg.reasoning_effort} max_tokens=${String(cfg.max_tokens)}（凭据值不落任何输出）`);

  // ── 硬前提 ②：新 snapshot/binding —— 真实内核 mkdtemp 夹具 + run 骨架/journal/准入 summary + bind_run ──
  const fixture = await createTrialFixture();
  try {
    evidence.push(`硬前提② 新 snapshot/binding：真实内核夹具（/tmp 夹具根，atf init 装机）+ ${RUN_ID} 十目录骨架 + journal×3 + admission-summary（lane-a 全 pass）+ runner bind_run`);

    const launcherInjected = await writeLauncher(workDir, "serve-injected.mjs", fixture.pinPath, fixture.home, "injected");
    const launcherPlain = await writeLauncher(workDir, "serve-plain.mjs", fixture.pinPath, fixture.home, "plain");

    // ── preflight：注入式对端账本探针（scope 逐字段匹配 → 1 条 → consume 一次） ──
    const probe = await AtfBridgeConnection.spawn({ command: ["node", launcherInjected] });
    if (!probe.ok) fail(`preflight 注入式对端 spawn/握手失败: ${JSON.stringify(probe.error)}`);
    const probeConn = probe.value;
    try {
      const queried = await probeConn.request("ledger_query", {
        scope_ref: { project_id: SCENARIO_ID, scope_type: "run", scope_id: RUN_ID, scope_mode: "canonical" },
      });
      if (!queried.ok) fail(`preflight ledger_query 失败: ${JSON.stringify(queried.error)}`);
      const records = (queried.value as { records: Array<{ record_id: string; approval_id: string; state: string }> }).records;
      if (records.length !== 1) fail(`preflight 账本探针期望恰 1 条预录，实得 ${String(records.length)}`);
      const consumed = await probeConn.request("ledger_consume", {
        approval_ref: records[0]?.approval_id,
        record_id: records[0]?.record_id,
      });
      if (!consumed.ok) fail(`preflight ledger_consume 失败: ${JSON.stringify(consumed.error)}`);
      evidence.push("preflight 账本探针通过：预录 scope 与 runner 查询 scope 逐字段一致，1 条 approved 可消费（一次性语义确认）");
    } finally {
      await probeConn.close().catch(() => undefined);
    }

    // ── run 1：真实模型自主只读链 → admit 挂起（75） ──
    const providerRun1 = new HttpLlmProvider({ config: cfg, tools: ToolRegistry.createDefault().modelVisible() });
    const scenario = {
      scenario_id: SCENARIO_ID,
      version: 1 as const,
      provider: "faux" as const,
      description: "L1a 真实端点复跑（owner §4 授权）",
      branches: {
        main: {
          branch_id: "main",
          run_id: RUN_ID,
          trigger_instruction: [
            "你是 ATF 训练流水线上的运行代理。请按序完成试用任务：",
            "1) 先调用 atf_workspace_status 与 atf_fact_scan 了解现场；",
            '2) 然后调用一次 atf_gate（gate="g1", action="query"）读取闸门状态——只查询这一次；',
            `3) 随后发起 atf_admit_data（dataset_id="${DATASET_ID}", source_ref="l1a-real-trial-manual"）将数据集准入训练流水——该写动作需要人工审批，直接发起调用即可；`,
            "4) 全部完成后以纯文本作最终答复：汇总事实索引、数据集登记与闸门状态，并给下一步建议。",
          ].join("\n"),
          purpose: "L1a real-endpoint rerun",
          setup: { ledger: [] },
          steps: [],
          expect: { outcome: "completed" as const, exit_code: 0 as const },
        },
      },
    };
    const ran1 = await ScenarioRunner.runBranch(scenario, "main", {
      runsRoot,
      mockCommand: ["node", launcherInjected],
      modelProvider: providerRun1,
      modelId: cfg.model,
      scopeMode: "canonical", // 内核 ScopeMode 枚举（复跑适配登记项；mock 轨默认 headless 不变）
      approvalSurface: { stub: async (): Promise<ApprovalStubResponse> => ({ verdict: "timeout" }) },
    });
    if (!ran1.ok) fail(`run 1 runner 失败: ${ran1.error.message}`);
    const report1: BranchRunReport = ran1.value;
    if (report1.outcome.kind !== "suspended" || report1.exit_code !== 75) {
      const detail = report1.outcome.kind === "failed" ? JSON.stringify(report1.outcome.error) : "";
      fail(`run 1 期望挂起 75，实得 ${report1.outcome.kind}/${String(report1.exit_code)}（calls=${String(providerRun1.calls)}）${detail}`);
    }
    const callSeq = report1.events
      .filter((event) => event.type === "tool/call")
      .map((event) => {
        const payload = event.payload as { tool: string; params: Record<string, unknown> };
        return `${payload.tool}(${JSON.stringify(payload.params)})`;
      });
    const request1 = report1.events.find(
      (event) => event.type === "approval/request" && (event.payload as { tool?: string }).tool === "atf_admit_data",
    );
    if (request1 === undefined) fail("run 1 缺 atf_admit_data 的 approval/request");
    evidence.push(`run 1 真实模型决策序：${callSeq.join(" → ")}（provider 调用 ${String(providerRun1.calls)} 次，逐决策经守卫与逐工具审批）`);
    evidence.push(`run 1 挂起闭环：approval/request#${String(request1.id)} → turn/end(reason=suspended) → exit 75（INV-2）`);

    // ── CLI --list（子进程实跑） ──
    const listed = await execFileP(process.execPath, [cliEntry, "--list", "--runs-root", runsRoot, "--run-id", RUN_ID], { env });
    if (listed.exitCode !== 0) fail(`CLI --list 失败(exit=${String(listed.exitCode)}): ${listed.stderr}`);
    if (!listed.stdout.includes(`request=${String(request1.id)}`)) fail(`CLI --list 未列出待办 ${String(request1.id)}`);
    evidence.push(`CLI resume --list：待办可见（request#${String(request1.id)}，status=timeout_awaiting_human）`);

    // ── run 2：CLI --answer granted（纯净对端，账本为空 → 重派走人工凭据路径） → 真实写 → 收束 ──
    const providerRun2 = new HttpLlmProvider({ config: cfg, tools: ToolRegistry.createDefault().modelVisible() });
    const scenarioForResume = {
      ...scenario,
      branches: {
        main: {
          ...scenario.branches.main,
          trigger_instruction: "(resume：以既有 provenance 为准)",
          purpose: "L1a real-endpoint rerun resume",
        },
      },
    };
    void scenarioForResume;
    const answered = await execFileP(
      process.execPath,
      [
        cliEntry,
        "--answer", "granted",
        "--note", "同意准入（L1a 真实端点复跑，owner §4 授权范围内）",
        "--request", String(request1.id),
        "--runs-root", runsRoot,
        "--run-id", RUN_ID,
        "--scenario-id", SCENARIO_ID,
        "--mock", launcherPlain,
        "--scope-mode", "canonical",
      ],
      { env },
    );
    if (answered.exitCode !== 0) {
      fail(`CLI --answer 失败(exit=${String(answered.exitCode)}): ${answered.stderr}\n${answered.stdout}`);
    }
    evidence.push(`CLI resume --answer granted：${answered.stdout.trim().split("\n")[0] ?? ""}`);
    void providerRun2; // resume 的真实调用发生在 CLI 子进程内（此处实例不参与执行）

    // ── 落盘证据：registration.json（真实内核唯一磁盘写） ──
    const streamText = await readFile(join(runsRoot, RUN_ID, "session.jsonl"), "utf8");
    const admitResultLine = streamText
      .split("\n")
      .find((line) => line.includes('"type":"tool/result"') && line.includes('"ok":true') && line.includes("atf_admit_data"));
    if (admitResultLine === undefined) fail("会话流缺 atf_admit_data 成功回填");
    const admitted = JSON.parse(admitResultLine) as { payload: { result: { fact_id: string; sha256_digest: string } } };
    const factId = admitted.payload.result.fact_id;
    const regPath = join(fixture.wsRoot, "datasets", factId, "registration.json");
    const regBytes = await readFile(regPath, "utf8");
    const regRecord = JSON.parse(regBytes) as { dataset_id: string; pin: string };
    if (regRecord.dataset_id !== DATASET_ID) fail(`registration.json dataset_id 不符: ${regRecord.dataset_id}`);
    if (regRecord.pin !== factId.split("@")[1]) fail("registration.json pin 与目录名不一致");
    const fileSha = createHash("sha256").update(regBytes, "utf8").digest("hex");
    evidence.push(`真实写落盘证据：datasets/${factId}/registration.json（dataset_id=${regRecord.dataset_id}，pin=${regRecord.pin}，文件 sha256=${fileSha.slice(0, 16)}…；会话流 digest=${admitted.payload.result.sha256_digest.slice(0, 16)}…）`);
    const resumeAssistantTexts = streamText
      .split("\n")
      .filter((line) => line.includes('"type":"assistant/message"'))
      .map((line) => (JSON.parse(line) as { payload: { text: string } }).payload.text);
    evidence.push(`run 2 真实模型续跑：重派执行后经真实调用收束（会话流 assistant/message 共 ${String(resumeAssistantTexts.length)} 条）`);

    // ── 脱敏断言：全部凭据值不出现在任何捕获面 ──
    const grantedLine = streamText.split("\n").find((line) => line.includes('"verdict":"granted"') && line.includes('"actor":"cli-operator"'));
    if (grantedLine === undefined) fail("会话流缺 CLI granted 应答（actor=cli-operator）");
    const sensitiveSurface = JSON.stringify({
      report1,
      stream: streamText,
      cliListed: listed.stdout + listed.stderr,
      cliAnswered: answered.stdout + answered.stderr,
      registration: regBytes,
    });
    for (const name of dotenv.value.names) {
      if (sensitiveSurface.includes(dotenv.value.values[name] ?? "")) fail(`脱敏违例：${name} 的凭据值出现在事件/报告/会话流/CLI 输出`);
    }
    evidence.push("脱敏断言：事件/报告/会话流/CLI 输出/落盘产物全序列化不含任何凭据值");

    // ── 隔离断言：pin 副本零改动；temp HOME 无技能泄漏 ──
    const pinStatus = await execFileP("git", ["-C", fixture.pinPath, "status", "--short"]);
    if (pinStatus.stdout !== "") fail(`隔离违例：pin 副本出现改动: ${pinStatus.stdout}`);
    const skillsLeaked = await stat(join(fixture.home, ".agents", "skills")).then(
      () => true,
      () => false,
    );
    if (skillsLeaked) fail("隔离违例：temp HOME 出现 .agents/skills（技能自举须关闭）");
    evidence.push("隔离断言：pin 副本 git status 零改动；temp HOME 无 .agents/skills 泄漏；真实写仅落 /tmp 夹具根（合成数据）");

    // ── 模型最终答复（D4 汇总）供复跑报告引用 ──
    const assistantTexts = streamText
      .split("\n")
      .filter((line) => line.includes('"type":"assistant/message"'))
      .map((line) => (JSON.parse(line) as { payload: { text: string } }).payload.text);
    evidence.push(`模型最终答复（末条，截 240 字）：${(assistantTexts.at(-1) ?? "（无）").slice(0, 240)}…`);
    evidence.push(`trial 工作目录（证据留存，不入仓）：${workDir}`);
    return evidence;
  } finally {
    await fixture.cleanup();
  }
};

try {
  const evidence = await smoke();
  console.log("L1a 真实端点复跑（owner §4 授权）通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
} catch (cause) {
  console.error(`L1a 真实端点复跑失败: ${(cause as Error).message}`);
  process.exitCode = 1;
}
