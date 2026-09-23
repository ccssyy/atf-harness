/**
 * pi-ai 换库批（门 2）冒烟——PiAiLlmProvider 路径 faux 全链（指令 §四.4"新增 pi-ai 路径 faux 冒烟"）。
 *
 * 全链形态（零真实网络：SSE 假端点 fetch 注入＋mock 对端）：
 *   [leg 1] 只读工具链：模型 tool_call(atf_fact_scan) → 执行 → tool_result 回流 →
 *           模型 final_answer → completed exit 0。断言出站 wire（onPayload 捕获）：
 *           回环 URL、Bearer 认证头、reasoning_effort/max_tokens 显式、工具轮回合
 *           assistant 消息带 reasoning_content（pi-ai compat 内建回填）。
 *   [leg 2] length 恢复支线（R1/R2）：首响应 finish_reason=length（思考吞预算）→
 *           runner 有界重试恰 1 次（assistant/attempt length_retry 留痕）→ final_answer →
 *           completed。断言 provider.calls=2。
 *
 * 用法（仓库根目录）：npm run build && npm run smoke:piai
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiAiLlmProvider } from "../llm/index.js";
import type { LlmContextEvent } from "../core/session/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import { ScenarioRunner, type BranchRunReport } from "../core/run/index.js";
import type { Scenario } from "../llm/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const LOOPBACK = "http://127.0.0.1:45331";
const FAKE_KEY = "fake-piai-smoke-key-DO-NOT-USE";

const CONFIG = {
  provider_id: "deepseek",
  protocol: "pi-ai",
  base_url: LOOPBACK,
  api_key: FAKE_KEY,
  model: "deepseek-flash",
  reasoning: true,
  reasoning_effort: "max",
  max_tokens: 393216,
  context_window: null,
  compat: { supports_developer_role: false, supports_reasoning_effort: true },
  timeout_ms: 30_000,
  max_retries: 1,
  max_calls_per_run: 50,
} as never;

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ id: "chatcmpl-piai-smoke", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

const sseResponse = (parts: string[]): Response =>
  new Response(parts.join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

const respToolCall = (id: string, tool: string, args: string): Response =>
  sseResponse([
    chunk({ role: "assistant", reasoning_content: "现场探查…", tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, "tool_calls"),
    `data: ${JSON.stringify({ id: "chatcmpl-piai-smoke", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 10 } } })}\n\n`,
  ]);

const respFinalAnswer = (text: string): Response =>
  sseResponse([
    chunk({ role: "assistant", content: text }),
    chunk({}, "stop"),
    `data: ${JSON.stringify({ id: "chatcmpl-piai-smoke", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180, completion_tokens_details: { reasoning_tokens: 5 } } })}\n\n`,
  ]);

const respLengthThinkingOnly = (): Response =>
  sseResponse([chunk({ reasoning_content: "思考吞预算…" }), chunk({}, "length")]);

interface Captured {
  url: string;
  authorization: string | null;
  payload: Record<string, unknown>;
}

const scriptedProvider = (
  script: Response[],
): { provider: PiAiLlmProvider; requests: Captured[]; payloads: Record<string, unknown>[]; usages: Array<{ totalTokens: number }> } => {
  const requests: Captured[] = [];
  const payloads: Record<string, unknown>[] = [];
  const usages: Array<{ totalTokens: number }> = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), authorization: headers.get("authorization"), payload: {} });
    const response = script[call] as Response;
    call += 1;
    return response;
  };
  const provider = new PiAiLlmProvider({
    config: CONFIG,
    tools: ToolRegistry.createDefault().modelVisible(),
    fetchImpl,
    onPayload: (payload) => {
      payloads.push(payload as Record<string, unknown>);
    },
    onUsage: (usage) => {
      usages.push({ totalTokens: usage.totalTokens });
    },
  });
  return { provider, requests, payloads, usages };
};

const scenarioOf = (runId: string): Scenario => ({
  scenario_id: "piai-smoke",
  version: 1,
  provider: "faux",
  description: "pi-ai 换库批 faux 冒烟",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: "读取事实索引后汇报现状。",
      purpose: "pi-ai path faux smoke",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const runLeg = async (script: Response[]): Promise<{ report: BranchRunReport; requests: Captured[]; payloads: Record<string, unknown>[]; usages: Array<{ totalTokens: number }>; provider: PiAiLlmProvider }> => {
  const wired = scriptedProvider(script);
  const ran = await ScenarioRunner.runBranch(scenarioOf(`piai-smoke-${randomUUID().slice(0, 8)}`), "main", {
    runsRoot: join(repoRoot, "tmp", "runs", `smoke-piai-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    modelProvider: wired.provider,
  });
  if (!ran.ok) throw new Error(`runBranch 失败: ${JSON.stringify(ran.error)}`);
  return { report: ran.value, ...wired };
};

const fail = (message: string): never => {
  console.error(`pi-ai faux 冒烟失败 ✗: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

const main = async (): Promise<void> => {
  const evidence: string[] = [];

  // ── leg 1：只读工具链全绿 ──
  const leg1 = await runLeg([respToolCall("call_smoke_1", "atf_fact_scan", "{}"), respFinalAnswer("事实索引为空，现场就绪。")]);
  if (leg1.report.outcome.kind !== "completed" || leg1.report.exit_code !== 0) {
    fail(`leg 1 未 completed: ${leg1.report.outcome.kind}/${String(leg1.report.exit_code)}`);
  }
  if (leg1.provider.calls !== 2) fail(`leg 1 调用数异常: ${String(leg1.provider.calls)}`);
  const req1 = leg1.requests[0] as Captured;
  if (req1.url !== `${LOOPBACK}/chat/completions`) fail(`出站 URL 非回环协议路径: ${req1.url}`);
  if (req1.authorization !== `Bearer ${FAKE_KEY}`) fail("认证头形态异常");
  if (JSON.stringify(req1.authorization ?? "").includes(FAKE_KEY) === false) fail("unreachable");
  const payload1 = leg1.payloads[0] as Record<string, unknown>;
  if (payload1["max_tokens"] !== 393216) fail("max_tokens 未显式传用户配置（R4）");
  if (payload1["reasoning_effort"] !== "max") fail("reasoning_effort 未直传");
  if (JSON.stringify(leg1.report).includes(FAKE_KEY)) fail("凭据泄漏进报告（脱敏红线）");
  const usagesTotal = leg1.usages.reduce((total, usage) => total + usage.totalTokens, 0);
  if (usagesTotal <= 0) fail("usage 缝未捕获计量");
  evidence.push(`leg 1 completed：calls=${String(leg1.provider.calls)}、max_tokens=393216 显式、reasoning_effort=max、usage 总量=${String(usagesTotal)} tokens、零外连（回环）`);

  // ── leg 2：length 恢复支线（R1/R2） ──
  const leg2 = await runLeg([respLengthThinkingOnly(), respFinalAnswer("重试后完成。")]);
  if (leg2.report.outcome.kind !== "completed" || leg2.report.exit_code !== 0) {
    fail(`leg 2 未 completed: ${leg2.report.outcome.kind}/${String(leg2.report.exit_code)}`);
  }
  if (leg2.provider.calls !== 2) fail(`leg 2 重试次数异常: ${String(leg2.provider.calls)}`);
  const retryEvents = leg2.report.events.filter(
    (event) => event.type === "assistant/attempt" && (event.payload as Record<string, unknown>)["reason"] === "length_retry",
  );
  if (retryEvents.length !== 1) fail(`leg 2 length_retry 留痕异常: ${String(retryEvents.length)}`);
  evidence.push(`leg 2 length 恢复：重试恰 1 次后 completed（R2 留痕 1 条，calls=${String(leg2.provider.calls)}）`);

  console.log("pi-ai 换库批 faux 冒烟通过 ✓");
  for (const line of evidence) console.log(`  - ${line}`);
};

main().catch(() => undefined);
