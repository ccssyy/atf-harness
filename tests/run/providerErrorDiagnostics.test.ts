/**
 * 微补丁「provider 错误可诊断性」（2026-09-23，DDL 即时）：
 * ① httpProvider 4xx → detail.status/body_excerpt（≤500 截断）＋dump 模式结构性 request_summary
 *    （仅 max_tokens/消息条数/总字符数/工具数，禁全量 body）＋脱敏漏斗（key 串 → [REDACTED]）；
 * ② runner provider_failure 收口 → failure_summary.blocked_description.provider_error＋审计事件
 *    （assistant/attempt——落盘不进模型历史，schema 零改）＋stuck_at 响应首行；
 * ③ 模型不可见：continue 续跑下一 turn 的 decide 上下文不含错误体（assistant/attempt 过滤）；
 * ④ collapseView 收口行带 body_excerpt 首行（≤120）。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/bridge/index.js";
import { HttpLlmProvider } from "../../src/llm/index.js";
import type { LlmDecision, LlmProvider } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import { ScenarioRunner } from "../../src/core/run/index.js";
import { collapseLines } from "../../src/ui/collapseView.js";
import type { TurnFailureSummary } from "../../src/core/run/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const FAKE_KEY = "fake-provider-test-key-DO-NOT-USE";
const CONFIG = () =>
  ({
    provider_id: "fake-provider",
    protocol: "openai-chat",
    base_url: "http://127.0.0.1:45321",
    api_key: FAKE_KEY,
    model: "fake-model-provider",
    reasoning: false,
    reasoning_effort: "low",
    max_tokens: 4096,
    context_window: null,
    compat: { supports_developer_role: false, supports_reasoning_effort: true },
    timeout_ms: 5_000,
    max_retries: 1,
    max_calls_per_run: 50,
  }) as never;
const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];
const CTX: readonly LlmContextEvent[] = [
  { id: 1, ts: "2026-09-23T00:00:00Z", type: "user/message", payload: { text: "任务" } },
] as never;

const withDumpEnv = async <T>(enabled: boolean, fn: () => Promise<T>): Promise<T> => {
  const previous = process.env["ATF_LLM_DEBUG_DUMP"];
  if (enabled) process.env["ATF_LLM_DEBUG_DUMP"] = "1";
  else delete process.env["ATF_LLM_DEBUG_DUMP"];
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env["ATF_LLM_DEBUG_DUMP"];
    else process.env["ATF_LLM_DEBUG_DUMP"] = previous;
  }
};

describe("httpProvider 4xx：detail 携带 status/body_excerpt（≤500）＋dump 模式 request_summary", () => {
  const rejectedBody = (marker: string): string =>
    JSON.stringify({ error: { message: `invalid request: ${marker}`, param: "messages" } }) + "x".repeat(700);

  const decideWith400 = async (dumpEnabled: boolean): Promise<{ decided: Extract<Awaited<ReturnType<HttpLlmProvider["decide"]>>, { ok: false }>; capturedBody: Record<string, unknown> }> => {
    let captured = "";
    const fetchImpl: typeof fetch = (async (_input, init) => {
      captured = String(init?.body ?? "");
      return new Response(rejectedBody("SECRET-BODY-MARKER"), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await withDumpEnv(dumpEnabled, () => provider.decide(CTX));
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error("unreachable");
    expect(captured).not.toContain(FAKE_KEY); // key 只在请求头（codec 纪律）；请求体不含凭据
    return { decided, capturedBody: JSON.parse(captured) as Record<string, unknown> };
  };

  it("无 dump：status=400＋body_excerpt 截断 ≤500（尾 …）；无 request_summary/request_body", async () => {
    const { decided } = await decideWith400(false);
    const detail = decided.error.detail as Record<string, unknown>;
    expect(detail["status"]).toBe(400);
    const excerpt = detail["body_excerpt"] as string;
    expect(excerpt).toContain("SECRET-BODY-MARKER");
    expect(excerpt.length).toBeLessThanOrEqual(501);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(detail["request_summary"]).toBeUndefined();
    expect(detail["request_body"]).toBeUndefined();
  });

  it("dump=1：request_summary 仅结构字段（max_tokens/messages/chars/tools），无消息正文；request_body 仍为既有机制", async () => {
    const { decided, capturedBody } = await decideWith400(true);
    const detail = decided.error.detail as Record<string, unknown>;
    const summary = detail["request_summary"] as Record<string, unknown>;
    // 键闭集断言（结构字段唯一；max_tokens 仅在请求体实际携带时出现——codec 决定，摘要忠实反映）
    for (const key of Object.keys(summary)) {
      expect(["max_tokens", "messages", "chars", "tools"]).toContain(key);
    }
    // 结构摘要与实际请求体自洽（messages 数＝body 实际值：系统提示＋用户消息）
    const bodyMessages = Array.isArray(capturedBody["messages"]) ? (capturedBody["messages"] as unknown[]).length : 0;
    expect(summary["messages"]).toBe(bodyMessages);
    const expectedChars = Array.isArray(capturedBody["messages"])
      ? (capturedBody["messages"] as unknown[]).reduce((total: number, message) => total + JSON.stringify(message).length, 0)
      : 0;
    expect(summary["chars"]).toBe(expectedChars);
    expect(summary["tools"]).toBe(TOOLS.length);
    expect(JSON.stringify(summary)).not.toContain("SECRET-BODY-MARKER");
    expect(detail["request_body"]).toBeDefined();
  });

  it("脱敏漏斗：响应体回显 key 串 → [REDACTED]（body_excerpt 不含原 key）", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ error: { message: `bad key ${FAKE_KEY} rejected` } }), { status: 400 })) as typeof fetch;
    const provider = new HttpLlmProvider({ config: CONFIG(), tools: TOOLS, fetchImpl });
    const decided = await withDumpEnv(false, () => provider.decide(CTX));
    expect(decided.ok).toBe(false);
    if (decided.ok) throw new Error("unreachable");
    expect(JSON.stringify(decided.error)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(decided.error)).toContain("[REDACTED]");
  });
});

describe("runner provider_failure 收口：provider_error 落失败摘要＋审计事件（模型不可见）", () => {
  const scenarioOf = (runId: string, instruction: string): Parameters<typeof ScenarioRunner.runBranch>[0] => ({
    scenario_id: "provider-error-diag",
    version: 1,
    provider: "faux",
    description: "微补丁 provider 错误可诊断性",
    branches: {
      main: {
        branch_id: "main",
        run_id: runId,
        trigger_instruction: instruction,
        purpose: "provider-error-diag",
        setup: { ledger: [] },
        steps: [],
        expect: { outcome: "completed", exit_code: 0 },
      },
    },
  });

  const longExcerpt = "第一行：400 详细原因（人读首行）\n第二行堆栈 x".padEnd(700, "y");

  it("mock provider 返回 400（含 body）→ summary.provider_error（截断生效）＋assistant/attempt 审计事件＋stuck_at 首行", async () => {
    const runId = `ped-${randomUUID()}`;
    const provider: LlmProvider = {
      providerId: "ped-fail-model",
      decide: async () =>
        err({
          code: "provider_failure",
          message: "决策请求被拒绝（HTTP 400，不重试）",
          detail: { host: "127.0.0.1:45321", status: 400, body_excerpt: longExcerpt },
        }),
    };
    const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "跑"), "main", {
      runsRoot: join(repoRoot, "tmp", "runs", `ped-${randomUUID()}`),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report = ran.value;
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    if (report.outcome.kind !== "turn_failed") throw new Error("unreachable");
    const summary = report.outcome.summary;
    expect(summary.reason).toBe("provider_failure");
    const providerError = summary.blocked_description?.provider_error;
    expect(providerError?.status).toBe(400);
    // runner 侧双保险截断：700 → 500＋…
    expect(providerError?.body_excerpt?.length).toBe(501);
    expect(providerError?.body_excerpt?.endsWith("…")).toBe(true);
    expect(providerError?.body_excerpt?.startsWith("第一行：400 详细原因（人读首行）")).toBe(true);
    // 审计事件：assistant/attempt（reason=provider_error）落盘，payload 含完整体（≤500）
    const attempt = report.events.find((event) => event.type === "assistant/attempt");
    expect(attempt).toBeDefined();
    const attemptPayload = attempt?.payload as { reason?: string; code?: string; status?: number; body_excerpt?: string };
    expect(attemptPayload.reason).toBe("provider_error");
    expect(attemptPayload.code).toBe("provider_failure");
    expect(attemptPayload.status).toBe(400);
    expect(attemptPayload.body_excerpt?.length).toBe(501);
    // turn/end stop_reason 五值枚举保留
    const turnEnd = report.events[report.events.length - 1];
    expect(turnEnd?.payload).toMatchObject({ reason: "failed", stop_reason: "error", failure_summary: { reason: "provider_failure" } });
  });

  it("模型可见面分域：decide 上下文经 turn/end failure_summary 携带诊断（模型可自纠）；审计事件本体（assistant/attempt reason=provider_error）被剥离", async () => {
    const runId = `ped-cont-${randomUUID()}`;
    const runsRoot = join(repoRoot, "tmp", "runs", `ped-${randomUUID()}`);
    const failing: LlmProvider = {
      providerId: "ped-fail-model",
      decide: async () =>
        err({ code: "provider_failure", message: "HTTP 400", detail: { status: 400, body_excerpt: "UNIQUE-EXCERPT-MARKER-400-原因" } }),
    };
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "第一轮"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: failing,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    const contexts: string[] = [];
    const continuing: LlmProvider = {
      providerId: "ped-continue-model",
      decide: async (context) => {
        contexts.push(JSON.stringify(context));
        return ok({ type: "final_answer", text: "已恢复" } as LlmDecision);
      },
    };
    const second = await ScenarioRunner.runBranch(scenarioOf(runId, "重试"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath],
      modelProvider: continuing,
      continue: { instruction: "重试" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.outcome.kind).toBe("completed");
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      // 审计事件本体不投影：assistant/attempt 的独有签名（payload.reason=provider_error）被剥离
      expect(context).not.toContain('"reason":"provider_error"');
      expect(context).not.toContain('"type":"assistant/attempt"');
      // 诊断经 turn/end failure_summary 投影（设计内：模型读收口摘要可自纠——如上下文超长类 400）
      expect(context).toContain("UNIQUE-EXCERPT-MARKER");
    }
  });
});

describe("collapseView：收口行带 body_excerpt 首行（≤120）", () => {
  const baseSummary = (providerError?: NonNullable<TurnFailureSummary["blocked_description"]>["provider_error"]): TurnFailureSummary => ({
    reason: "provider_failure",
    blocked_description: {
      stuck_at: "provider 决策失败（provider_failure）: HTTP 400",
      turns_used: 1,
      steps_used: 0,
      ...(providerError !== undefined ? { provider_error: providerError } : {}),
    },
    hint: { note: "provider 决策失败已按 turn 收口" },
  });

  it("有 provider_error：独立行含 HTTP 状态与首行；首行截断 ≤120＋…", () => {
    const longBody = '{"error":{"message":"' + "长".repeat(200) + '"}}';
    const lines = collapseLines(baseSummary({ status: 400, body_excerpt: longBody }));
    const errorLine = lines.find((line) => line.startsWith("provider 错误："));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain("HTTP 400");
    const first = errorLine?.split("｜响应首行：")[1] ?? "";
    expect(first.length).toBeLessThanOrEqual(121);
    expect(first.endsWith("…")).toBe(true);
    expect(lines.join("\n")).not.toContain("长".repeat(200)); // 完整体不上屏
  });

  it("无 provider_error：不出现该行（budget_exhausted 等收口零回归）", () => {
    const lines = collapseLines(baseSummary(undefined));
    expect(lines.some((line) => line.startsWith("provider 错误："))).toBe(false);
    expect(lines.some((line) => line.startsWith("卡在哪："))).toBe(true);
  });

  it("缺状态码：占位（无状态码）不臆造", () => {
    const lines = collapseLines(baseSummary({ body_excerpt: "plain" }));
    expect(lines.find((line) => line.startsWith("provider 错误："))).toContain("HTTP （无状态码）｜响应首行：plain");
  });
});
