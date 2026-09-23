/**
 * pi-ai 换库批（门 2，2026-09-23）——R1/R2 length 分型恢复 runner 级测试（指令 §四.2）。
 *
 * 三分支（full runBranch，PiAiLlmProvider × SSE 假端点 × mock 对端——零真实调用）：
 * - A 思考吞预算截断 → 有界自动重试恰 1 次（R2：assistant/attempt 留痕）→ 重试产出 final_answer
 *   → completed；
 * - B 重试仍截断 → turn 级收口（length_truncated）＋缺口卡（降思考等级/输入新指令）＋exit 1，
 *   run 状态机不变（turn_failed 非终局，run 未硬阻断语义）；
 * - C 非空截断（部分产出）→ 不重试（恰 1 次调用）→ 收口＋续跑引导缺口卡。
 * 预算护栏语义不变：重试是新的 decide 调用，计入 provider 内部 max_calls_per_run 计数。
 * 纯函数判据（resolveLengthRecovery）随附单测。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PiAiLlmProvider, type LengthTruncationSignal } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";
import type { ModelVisibleTool } from "../../src/core/tools/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import { resolveLengthRecovery, LENGTH_RETRY_LIMIT } from "../../src/core/run/stopReason.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const CONFIG = {
  provider_id: "deepseek",
  protocol: "pi-ai",
  base_url: "http://127.0.0.1:45329",
  api_key: "fake-runner-key",
  model: "deepseek-flash",
  reasoning: true,
  reasoning_effort: "max",
  max_tokens: 393216,
  context_window: null,
  compat: { supports_developer_role: false, supports_reasoning_effort: true },
  timeout_ms: 5_000,
  max_retries: 1,
  max_calls_per_run: 50,
} as never;

const TOOLS: ModelVisibleTool[] = [{ name: "atf_fact_scan", description: "d", parameters: { type: "object", required: [], properties: {} } }];

// ---------------------------------------------------------------- SSE 假端点

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const sse = (parts: string[]): Response =>
  new Response(parts.join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
const sseLengthThinkingOnly = (): Response => sse([chunk({ reasoning_content: "思考中…" }), chunk({}, "length")]);
const sseLengthWithText = (text: string): Response => sse([chunk({ role: "assistant", content: text }), chunk({}, "length")]);
const sseFinalAnswer = (text: string): Response => sse([chunk({ role: "assistant", content: text }), chunk({}, "stop")]);

const scriptedFetch = (script: Response[]): { fetchImpl: typeof fetch; bodies: string[] } => {
  const bodies: string[] = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    const response = script[Math.min(call, script.length - 1)] as Response;
    call += 1;
    return response;
  };
  return { fetchImpl, bodies };
};

const runBranchWith = async (script: Response[]): Promise<{ report: BranchRunReport; provider: PiAiLlmProvider; bodies: string[] }> => {
  const { fetchImpl, bodies } = scriptedFetch(script);
  const provider = new PiAiLlmProvider({ config: CONFIG, tools: TOOLS, fetchImpl });
  const ran = await ScenarioRunner.runBranch(
    {
      scenario_id: "piai-length",
      version: 1,
      provider: "faux",
      description: "pi-ai length 恢复测试",
      branches: {
        main: {
          branch_id: "main",
          run_id: `piai-length-${randomUUID().slice(0, 8)}`,
          trigger_instruction: "走查 length 恢复",
          purpose: "R1/R2 验收",
          setup: { ledger: [] },
          steps: [],
          expect: { outcome: "completed", exit_code: 0 },
        },
      },
    },
    "main",
    {
      runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
      mockCommand: ["node", mockPath],
      modelProvider: provider,
    },
  );
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return { report: ran.value, provider, bodies };
};

const attemptEvents = (report: BranchRunReport, reason: string): Array<Record<string, unknown>> =>
  report.events
    .filter((event) => event.type === "assistant/attempt")
    .map((event) => event.payload as Record<string, unknown>)
    .filter((payload) => payload["reason"] === reason);

const failureSummaryOf = (report: BranchRunReport): Record<string, unknown> | null => {
  const turnEnd = [...report.events].reverse().find((event) => event.type === "turn/end");
  if (turnEnd === undefined) return null;
  return ((turnEnd.payload as Record<string, unknown>)["failure_summary"] as Record<string, unknown>) ?? null;
};

describe("R1/R2：length 分型恢复（runner 级）", () => {
  it("A：思考吞预算 → 重试恰 1 次（R2 留痕）→ 重试产出 final_answer → completed", async () => {
    const { report, provider } = await runBranchWith([sseLengthThinkingOnly(), sseFinalAnswer("已完成任务")]);
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    expect(provider.calls).toBe(2); // 首调＋恰 1 次重试
    const retries = attemptEvents(report, "length_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1, content_empty: true });
    // 重试的第二次调用计入 call 预算（provider 计数断言如上）；过程流不缺提示事件
  });

  it("B：重试仍截断 → turn 级收口 length_truncated＋缺口卡（降档推荐）＋exit 1", async () => {
    const { report, provider } = await runBranchWith([sseLengthThinkingOnly(), sseLengthThinkingOnly()]);
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    expect(provider.calls).toBe(2); // 恰重试 1 次，无无限轮转
    expect(attemptEvents(report, "length_retry")).toHaveLength(1);
    const summary = failureSummaryOf(report) as Record<string, unknown>;
    expect(summary["reason"]).toBe("length_truncated");
    const gapCard = summary["gap_card"] as Record<string, unknown>;
    expect(String(gapCard["stuck"])).toContain("思考耗尽输出预算");
    expect((gapCard["options"] as Array<{ text: string }>)[0]?.text).toContain("降低思考等级");
    const blocked = summary["blocked_description"] as Record<string, unknown>;
    expect(String(blocked["stuck_at"])).toContain("重试 1 次仍截断");
    // 五值 stop_reason 枚举零改：length 分型走 "error"（机查粗分型）＋reason 精确分型
    const turnEnd = [...report.events].reverse().find((event) => event.type === "turn/end");
    expect((turnEnd?.payload as Record<string, unknown>)["stop_reason"]).toBe("error");
  });

  it("C：非空截断（部分产出）→ 不自动重试 → 收口＋续跑引导缺口卡", async () => {
    const { report, provider } = await runBranchWith([sseLengthWithText("部分产出…")]);
    expect(report.outcome.kind).toBe("turn_failed");
    expect(report.exit_code).toBe(1);
    expect(provider.calls).toBe(1); // 不重试
    expect(attemptEvents(report, "length_retry")).toHaveLength(0);
    const summary = failureSummaryOf(report) as Record<string, unknown>;
    expect(summary["reason"]).toBe("length_truncated");
    const gapCard = summary["gap_card"] as Record<string, unknown>;
    expect((gapCard["options"] as Array<{ text: string }>)[0]?.text).toContain("输入新指令");
  });
});

describe("resolveLengthRecovery（纯函数判据）", () => {
  it("空内容：恰 1 次有界重试；耗尽后收口", () => {
    expect(LENGTH_RETRY_LIMIT).toBe(1);
    expect(resolveLengthRecovery(true, 0)).toEqual({ action: "retry" });
    expect(resolveLengthRecovery(true, 1)).toEqual({ action: "collapse", cause: "retry_exhausted" });
    expect(resolveLengthRecovery(true, 5)).toEqual({ action: "collapse", cause: "retry_exhausted" });
  });

  it("非空截断：恒收口（不重试）", () => {
    expect(resolveLengthRecovery(false, 0)).toEqual({ action: "collapse", cause: "partial_content" });
  });
});

// 类型面哨兵：LengthTruncationSignal 形状（防结构漂移）
export type _SignalShape = LengthTruncationSignal;
