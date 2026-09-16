/**
 * L1 门 2 T02 冒烟——smoke:l1ui（前端一 TUI 主入口全链；《ATF独立Harness_L1门2任务书_20260915.md》
 * §3 T02 / §4 VERIFY 1、2 的自动化承载；真实交互验收由 owner 手工执行）。
 *
 * 链路：本地回环假 LLM 端点（沿用 L1a 形态，零外连）＋ provider 两层配置（凭据只留引用）
 * → 子进程实跑 dist/ui/tui.js（同进程直连 core 的产品入口）→ stdin 脚本化人工应答：
 *   发起会话（绑定 run）→ 过程流可见（只读工具自主执行）→ 高危动作触发审批弹窗
 *   → 人在同一界面放行（granted+备注）→ 工具真执行 → 终局可见 → exit 0。
 * 断言：UI 事件行与 append-only 日志逐条同源（VERIFY 2）；落盘证据（granted 留痕 actor=
 * tui-operator、call_ref 配对）；脱敏（假 key 不入输出/请求体）；零外连（全回环）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeLlmEndpoint } from "../llm/fakeEndpoint.js";
import { LLM_CONFIG_SCHEMA_VERSION, PROVIDER_ENV_VARS } from "../llm/providerConfig.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const tuiPath = join(repoRoot, "dist", "ui", "tui.js");

/** 显式标注 fake 的假 key（仓内零凭据纪律：仅运行期注入环境变量，不进配置文件、不进仓）。 */
const FAKE_API_KEY = "fake-l1ui-api-key-DO-NOT-USE";
const FAKE_KEY_ENV = "ATF_LLM_KEY_L1UI_FAKE";
const FAKE_PROVIDER = "local-fake";
const FAKE_MODEL = "fake-model-l1ui";
const SCENARIO_ID = "l1ui-smoke";
const RUN_ID = "run-l1ui-smoke";
const FINAL_TEXT = "数据集 ds-l1ui 已准入登记（人工放行）；工作区状态只读查询自主完成。";

const SCRIPT = [
  { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-l1ui" } }] } },
  { kind: "response", response: { final_answer: FINAL_TEXT } },
] as const;

/** stdout 期望环：谓词命中即决出；超时带缓冲尾部报错。 */
class StdoutExpect {
  private buffer = "";
  private waiter: { predicate: (buffer: string) => boolean; resolve: () => void } | null = null;

  public constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (chunk: Buffer | string) => {
      this.buffer += String(chunk);
      this.pump();
    });
  }

  public waitFor(description: string, predicate: (buffer: string) => boolean, timeoutMs = 45_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`期望超时（${description}）；stdout 尾部:\n${this.buffer.slice(-1200)}`));
      }, timeoutMs);
      this.waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.pump();
    });
  }

  /** 当前累计输出快照（同源断言用）。 */
  public snapshot(): string {
    return this.buffer;
  }

  private pump(): void {
    if (this.waiter !== null && this.waiter.predicate(this.buffer)) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve();
    }
  }
}

const hasLine = (buffer: string, match: (line: string) => boolean): boolean =>
  buffer.split("\n").some(match);

const smoke = async (): Promise<string[]> => {
  const evidence: string[] = [];
  const workDir = join(tmpdir(), `l1ui-smoke-${randomUUID()}`);
  const runsRoot = join(workDir, "runs");
  await mkdir(runsRoot, { recursive: true });

  // ① 本地假端点（127.0.0.1 回环；回放式；零外连）
  const endpoint = await FakeLlmEndpoint.start({
    protocol: "openai-chat",
    script: [...SCRIPT],
    expectedApiKey: FAKE_API_KEY,
    model: FAKE_MODEL,
  });

  let child: ReturnType<typeof spawn> | undefined;
  try {
    // ② provider 配置文件（修订 v2 两层清单；凭据只留引用；0600；假 key 经环境变量注入）
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

    // ③ 子进程实跑 TUI（产品入口本体；同进程直连 core）
    child = spawn(process.execPath, [
      tuiPath,
      "--runs-root", runsRoot,
      "--run-id", RUN_ID,
      "--instruction", "查询工作区状态，并把数据集 ds-l1ui 准入登记。",
      "--scenario-id", SCENARIO_ID,
      "--mock", mockPath,
    ], {
      cwd: repoRoot,
      env: { ...process.env, [PROVIDER_ENV_VARS.configPath]: configPath, [FAKE_KEY_ENV]: FAKE_API_KEY },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const expectator = new StdoutExpect(child.stdout!);
    let stderrText = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrText += String(chunk);
    });

    // ④ 发起会话 → 过程流可见：banner + 首屏四块指引（B2）+ 只读工具自主执行（无人工干预）
    await expectator.waitFor("TUI 启动横幅", (buffer) => buffer.includes("同进程直连 core"));
    await expectator.waitFor("首屏四块指引（B2）", (buffer) =>
      buffer.includes("使用指引") && buffer.includes("① 当前状态") && buffer.includes("② 你可以输入") && buffer.includes("③ 常用指令示例") && buffer.includes("④ 退出方式"));
    evidence.push("首屏四块指引: 绑定状态/可输入什么/常用指令示例/退出方式 全部渲染（B2）");
    await expectator.waitFor("过程流可见（只读工具）", (buffer) =>
      hasLine(buffer, (line) => line.includes("tool/call") && line.includes("atf_workspace_status")));
    evidence.push("发起会话→过程流可见: banner + tool/call(atf_workspace_status) 已渲染（模型自主只读）");

    // ⑤ 高危动作触发审批 → 人在同一界面放行（granted + 备注）
    await expectator.waitFor("审批弹窗（同一界面）", (buffer) =>
      buffer.includes("审批请求") && buffer.includes("atf_admit_data"));
    evidence.push("高危动作触发审批: 弹窗（问答轨渲染）在过程流同界面出现，tool=atf_admit_data");
    child.stdin?.write("g 已备案放行（l1ui 冒烟）\n");

    // ⑥ 放行 → 工具真执行（回填可见）→ 模型收束 → 终局可见
    await expectator.waitFor("放行后执行回填", (buffer) =>
      hasLine(buffer, (line) => line.includes("tool/result") && line.includes("ok=true") && line.includes("atf_admit_data")));
    await expectator.waitFor("终局", (buffer) => buffer.includes("终局") && buffer.includes(FINAL_TEXT));
    evidence.push("人工放行→真执行→终局可见: tool/result(ok=true, atf_admit_data) + final_answer + 终局行渲染");

    // ⑦ 子进程退出码 = run 终局码
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child?.on("error", reject);
      child?.on("close", (code) => resolve(code));
    });
    if (exitCode !== 0) throw new Error(`TUI 退出码非 0: ${String(exitCode)}\nstderr: ${stderrText}`);
    evidence.push(`TUI 进程退出码 = 0（= run 终局码，单一出口）`);

    // ⑧ 落盘证据（append-only 日志 = 唯一跨进程凭证）
    const streamText = await readFile(join(runsRoot, RUN_ID, "session.jsonl"), "utf8");
    const lines = streamText.split("\n").filter((line) => line !== "");
    const granted = lines.find((line) => line.includes('"verdict":"granted"') && line.includes('"actor":"tui-operator"'));
    if (granted === undefined) throw new Error("会话流缺 granted 应答（actor=tui-operator）——弹窗应答未落账本轨");
    const callLine = lines.find((line) => line.includes('"type":"tool/call"') && line.includes("atf_admit_data"));
    const resultLine = lines.find((line) => line.includes('"type":"tool/result"') && line.includes('"ok":true') && line.includes("atf_admit_data"));
    if (callLine === undefined || resultLine === undefined) throw new Error("会话流缺 admit 调用/成功回填（真执行证据不足）");
    const callId = (JSON.parse(callLine) as { id: number }).id;
    const callRef = (JSON.parse(resultLine) as { payload: { call_ref?: number } }).payload.call_ref;
    if (callRef !== callId) throw new Error(`call_ref=${String(callRef)} 与 tool/call id=${String(callId)} 不配对`);
    evidence.push(`落盘证据: granted（actor=tui-operator）+ tool/result(ok=true, call_ref=${String(callId)} 配对) 全在流内`);

    // ⑨ 同源断言（VERIFY 2）：stdout 过程流行 id 集合 ≡ 日志事件 id 集合
    const eventLineIds = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: number };
      eventLineIds.add(parsed.id);
    }
    const uiIds = new Set<number>();
    for (const line of expectator.snapshot().split("\n")) {
      const match = /^#(\d{4,}) /.exec(line);
      if (match !== null) uiIds.add(Number(match[1]));
    }
    if (uiIds.size !== eventLineIds.size || [...eventLineIds].some((id) => !uiIds.has(id))) {
      throw new Error(`同源违例: UI 行 id 集合(${String(uiIds.size)}) ≠ 日志事件集合(${String(eventLineIds.size)})`);
    }
    evidence.push(`同源断言: UI 过程流 ${String(uiIds.size)} 行与 append-only 日志 ${String(eventLineIds.size)} 事件逐条对应（#id 全等）`);

    // ⑩ 脱敏 + 零外连
    const outputs = expectator.snapshot() + stderrText + streamText;
    if (outputs.includes(FAKE_API_KEY)) throw new Error("脱敏违例：fake key 出现在输出/会话流");
    const requests = endpoint.requests;
    if (requests.length !== 3) throw new Error(`假端点请求数不符: ${String(requests.length)} ≠ 3`);
    for (const record of requests) {
      if (record.path !== "/v1/chat/completions") throw new Error(`零外连违例：请求打到 ${record.path}`);
      if (record.auth !== "ok") throw new Error("认证头缺失或不匹配");
      if (record.apiKeyInBody) throw new Error("脱敏违例：api_key 出现在请求体");
    }
    evidence.push(`零外连+脱敏: ${String(requests.length)} 笔请求全回环、认证一致、key 未入请求体/输出`);

    return evidence;
  } finally {
    child?.kill();
    await endpoint.close().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

try {
  const evidence = await smoke();
  console.log("L1 UI 冒烟（smoke:l1ui）通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
} catch (cause) {
  console.error(`✗ smoke:l1ui 失败: ${(cause as Error).message}`);
  process.exitCode = 1;
}
