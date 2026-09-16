/**
 * L1 门 2 T06 冒烟——smoke:l1acp（前端二 ACP 外壳 × acpx@0.15.1 真对端全链；
 * 《ATF独立Harness_L1门2任务书_20260915.md》§4 VERIFY 3/4/5/6 自动化承载；
 * acpx = 开发期对照工具（D2/D10：不入库、不进 dependencies，npx 锁版本拉起））。
 *
 * 链路：本地回环假 LLM 端点（沿用 L1a 形态）＋ provider 两层配置 → acpx 以
 * `--agent` 拉起 dist/acp/main.js（--approve-all＝宿主自动允许＝人的显式预授权，
 * D4-C 口径）→ initialize（轴三协商）→ session/new → session/prompt → 投影全链
 * → 高危动作 request_permission（恰两选项）→ 宿主 allow_once → 真执行 → 终局。
 * 断言：协议层逐段原文（transcript）＋落盘证据（granted 留痕/call_ref 配对）＋
 * 零外连＋脱敏。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeLlmEndpoint } from "../llm/fakeEndpoint.js";
import { LLM_CONFIG_SCHEMA_VERSION, PROVIDER_ENV_VARS } from "../llm/providerConfig.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 显式标注 fake 的假 key（仓内零凭据纪律：仅运行期注入环境变量）。 */
const FAKE_API_KEY = "fake-l1acp-api-key-DO-NOT-USE";
const FAKE_KEY_ENV = "ATF_LLM_KEY_L1ACP_FAKE";
const FAKE_PROVIDER = "local-fake";
const FAKE_MODEL = "fake-model-l1acp";
const FINAL_TEXT = "l1acp 冒烟：只读链自主完成，数据集 ds-l1acp 已准入登记（宿主放行）。";

const SCRIPT = [
  { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-l1acp" } }] } },
  { kind: "response", response: { final_answer: FINAL_TEXT } },
] as const;

const smoke = async (): Promise<string[]> => {
  const evidence: string[] = [];
  const workDir = await mkdtemp(join(tmpdir(), `l1acp-smoke-${randomUUID()}`));
  const runsRoot = join(workDir, "runs");
  await mkdir(runsRoot);

  const endpoint = await FakeLlmEndpoint.start({
    protocol: "openai-chat",
    script: [...SCRIPT],
    expectedApiKey: FAKE_API_KEY,
    model: FAKE_MODEL,
  });

  let acpx: ReturnType<typeof spawn> | undefined;
  try {
    const configPath = join(workDir, "llm-provider.config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schema_version: LLM_CONFIG_SCHEMA_VERSION,
          default_provider: FAKE_PROVIDER,
          default_model: FAKE_MODEL,
          timeout_ms: 10_000,
          max_retries: 1,
          max_calls_per_run: 50,
          providers: {
            [FAKE_PROVIDER]: {
              protocol: "openai-chat",
              base_url: endpoint.baseUrl,
              api_key_env: FAKE_KEY_ENV,
              models: [{ id: FAKE_MODEL, reasoning: false, max_tokens: 4096 }],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await chmod(configPath, 0o600);

    // acpx@0.15.1（D2/D10 锁版本）以 --agent 拉起我方 ACP 外壳；
    // --approve-all = 宿主自动允许设置（人的显式预授权，D4-C）。
    const agentCmd = `node ${join(repoRoot, "dist", "acp", "main.js")} --runs-root ${runsRoot}`;
    acpx = spawn("npx", [
      "-y", "acpx@0.15.1",
      "--agent", agentCmd,
      "--approve-all",
      "--format", "json",
      "--timeout", "120",
      "exec", "查询工作区状态，并把数据集 ds-l1acp 准入登记。",
    ], {
      cwd: repoRoot,
      env: { ...process.env, [PROVIDER_ENV_VARS.configPath]: configPath, [FAKE_KEY_ENV]: FAKE_API_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    let stderrText = "";
    acpx.stdout?.on("data", (chunk: Buffer | string) => {
      transcript += String(chunk);
    });
    acpx.stderr?.on("data", (chunk: Buffer | string) => {
      stderrText += String(chunk);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`acpx 超时（240s）；transcript 尾部:\n${transcript.slice(-1200)}`)), 240_000);
      acpx?.on("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      acpx?.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // ① 全链 exit 正常（VERIFY 3）
    if (exitCode !== 0) throw new Error(`acpx 退出码非 0: ${String(exitCode)}\nstderr: ${stderrText.slice(-800)}`);
    evidence.push("acpx@0.15.1 全链 exit=0（initialize→session/new→session/prompt→投影→授权→终局）");

    // ② 协议层逐段原文断言（transcript = acpx --format json 的线缆日志）
    const expectTranscript = (fragment: string, what: string): void => {
      if (!transcript.includes(fragment)) throw new Error(`transcript 缺 ${what}:\n${transcript.slice(-1200)}`);
    };
    expectTranscript('"method":"initialize"', "initialize 请求");
    expectTranscript('"protocolVersion":1', "轴三协商应答 v1");
    expectTranscript('"method":"session/new"', "session/new");
    expectTranscript('"method":"session/prompt"', "session/prompt");
    expectTranscript("未执行：等待人工审批", "VERIFY 6 pending 标注不丢");
    expectTranscript('"method":"session/request_permission"', "授权请求");
    expectTranscript('"kind":"allow_once"', "D5 选项 allow_once");
    expectTranscript('"kind":"reject_once"', "D5 选项 reject_once");
    expectTranscript('"optionId":"allow_once"', "宿主 allow_once 应答（VERIFY 5）");
    expectTranscript("宿主已应答放行", "放行投影");
    // canonical 在投影 content 内为 JSON-in-string（引号转义），按字段名/值断言
    expectTranscript("journal_type", "admit 真执行 canonical 字段");
    expectTranscript("dataset-registry", "admit 真执行 canonical 值（VERIFY 5 落盘/可复核）");
    expectTranscript(FINAL_TEXT, "终答投影");
    expectTranscript('"stopReason":"end_turn"', "prompt 终局 stopReason");
    evidence.push("协议原文九段齐全：轴三 v1 ＋ 两选项授权 ＋ pending 标注 ＋ 放行执行 ＋ canonical 终局");

    // ③ 落盘证据（append-only 日志 = 唯一跨进程凭证）
    const sessionMatch = /"sessionId":"([^"]+)"/.exec(transcript);
    if (sessionMatch === null) throw new Error("transcript 缺 sessionId");
    const sessionId = sessionMatch[1] as string;
    const streamText = await readFile(join(runsRoot, sessionId, "session.jsonl"), "utf8");
    const lines = streamText.split("\n").filter((line) => line !== "");
    const granted = lines.find((line) => line.includes('"verdict":"granted"') && line.includes('"channel":"acp"'));
    if (granted === undefined) throw new Error("会话流缺 channel=acp 的 granted 应答（D4 留痕缺失）");
    const grantedPayload = JSON.parse(granted) as { payload: Record<string, unknown> };
    if (grantedPayload.payload["requires_human_review"] !== true) throw new Error("D4 审计位 requires_human_review 缺失");
    if (grantedPayload.payload["actor"] !== "acp-host") throw new Error("授权来源 actor 非法");
    const callLine = lines.find((line) => line.includes('"type":"tool/call"') && line.includes("atf_admit_data"));
    const resultLine = lines.find((line) => line.includes('"type":"tool/result"') && line.includes('"ok":true') && line.includes("atf_admit_data"));
    if (callLine === undefined || resultLine === undefined) throw new Error("会话流缺 admit 调用/成功回填");
    const callRef = (JSON.parse(resultLine) as { payload: { call_ref?: number } }).payload.call_ref;
    if (callRef !== (JSON.parse(callLine) as { id: number }).id) throw new Error("call_ref 与 tool/call 不配对");
    const turnEnd = lines.find((line) => line.includes('"type":"turn/end"') && line.includes('"reason":"completed"'));
    if (turnEnd === undefined) throw new Error("会话流缺 completed 收口");
    evidence.push(`落盘证据: granted（channel=acp，requires_human_review=true）+ tool/result(ok=true, call_ref=${String(callRef)} 配对) + turn/end(completed)`);

    // ④ 零外连 + 脱敏
    const requests = endpoint.requests;
    if (requests.length !== 3) throw new Error(`假端点请求数不符: ${String(requests.length)} ≠ 3`);
    for (const record of requests) {
      if (record.path !== "/v1/chat/completions") throw new Error(`零外连违例：请求打到 ${record.path}`);
      if (record.auth !== "ok") throw new Error("认证头缺失或不匹配");
      if (record.apiKeyInBody) throw new Error("脱敏违例：api_key 出现在请求体");
    }
    if ((transcript + stderrText + streamText).includes(FAKE_API_KEY)) throw new Error("脱敏违例：fake key 出现在输出/会话流");
    evidence.push(`零外连+脱敏: ${String(requests.length)} 笔请求全回环、认证一致、key 未入请求体/输出`);

    // ⑤ 清理兜底（acpx 正常退出应已回收 agent；防御性定点清理）
    await new Promise<void>((resolve) => {
      const cleaner = spawn("pkill", ["-f", agentCmd], { stdio: "ignore" });
      cleaner.on("close", () => resolve());
      cleaner.on("error", () => resolve());
    });

    return evidence;
  } finally {
    acpx?.kill();
    await endpoint.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

try {
  const evidence = await smoke();
  console.log("L1 ACP 冒烟（smoke:l1acp，acpx@0.15.1 对端）通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
} catch (cause) {
  console.error(`✗ smoke:l1acp 失败: ${(cause as Error).message}`);
  process.exitCode = 1;
}
