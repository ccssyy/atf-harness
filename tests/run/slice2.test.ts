import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { SESSION_EVENT_TYPES, SESSION_RESERVED_EVENT_TYPES, type LlmContextEvent } from "../../src/session/index.js";
import {
  buildApprovalBackfill,
  buildDecisionBackfill,
  deriveLoopStateFromEvents,
  injectMemoryEntries,
  type DecisionBackfill,
  type MemoryReadInjector,
} from "../../src/run/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/run/index.js";
import type { ToolCallOutcome } from "../../src/tools/index.js";

/**
 * 切片 2 验收测试（任务书 §3 VERIFY 2/3/4/5/6/7）：
 * 多工具展开的逐工具审批、错误回填形态与"回填不构成授权"、TEM 读闸注入点、
 * durability 公理（事件流 → 状态纯函数）、N1 语义边界（未新增事件类型、留痕在 tool/result）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (steps: Scenario["branches"][string]["steps"], ledger: Array<{ tool: string; params: Record<string, unknown> }> = []): Scenario => ({
  scenario_id: "slice2-adapter",
  version: 1,
  provider: "faux",
  description: "切片 2 adapter 与公理兑现测试场景",
  branches: {
    main: {
      branch_id: "main",
      run_id: "slice2-adapter-run",
      trigger_instruction: "切片 2 测试触发指令",
      purpose: "adapter 展开 / 错误回填 / TEM 注入 / 公理断言",
      setup: { ledger },
      steps,
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const queueProvider = (queue: (LlmDecision | null)[]): { provider: LlmProvider; contexts: string[] } => {
  const contexts: string[] = [];
  return {
    contexts,
    provider: {
      providerId: "faux",
      decide: async (context: readonly LlmContextEvent[]) => {
        contexts.push(JSON.stringify(context));
        const next = queue.shift();
        return ok(next ?? null);
      },
    },
  };
};

const runBranch = async (
  scenario: Scenario,
  options?: { modelProvider?: LlmProvider; memoryInjector?: MemoryReadInjector },
): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    ...(options?.modelProvider !== undefined ? { modelProvider: options.modelProvider } : {}),
    ...(options?.memoryInjector !== undefined ? { memoryInjector: options.memoryInjector } : {}),
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

describe("切片 2 · VERIFY 2 多工具展开——逐工具守卫与逐工具审批（禁止共享授权）", () => {
  it("展开后的两个高危决策顺序执行：第一个消费账本记录，第二个被独立拒绝（不得沿用授权）", { timeout: 60_000 }, async () => {
    // 一次"模型响应"展开出的两个高危决策（adapter 展开产物），经 modelProvider seam 注入 loop：
    // 账本仅预录一条 atf_admit_data 记录——第一个决策消费之；第二个决策必须独立被拒。
    const { provider, contexts } = queueProvider([
      { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-first" } },
      { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-second" } },
      { type: "final_answer", text: "done" },
    ]);
    const r = await runBranch(
      scenarioOf([{ type: "final_answer", text: "irrelevant" }], [
        { tool: "atf_admit_data", params: { dataset_id: "ds-first" } },
      ]),
      { modelProvider: provider },
    );

    // 两个决策都过了切片 0 守卫（无 model_decision_forbidden）
    expect(r.outcome.kind).not.toBe("failed");
    const results = r.events.filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(2);
    // 第一个：预录记录存在 → 消费放行 → 执行成功
    expect((results[0]?.payload as { ok?: boolean }).ok).toBe(true);
    // 第二个：账本无可消费记录（一次性语义，记录已被第一个消费）→ blocked approval_missing
    const second = results[1]?.payload as { ok?: boolean; reason?: string; block?: { reason?: string } };
    expect(second?.ok).toBe(false);
    expect(second?.block?.reason).toBe("approval_missing");
    // 授权确实未被沿用：第二条 tool/result 之后的调用没有产生第二个成功结果
    expect(results.filter((event) => (event.payload as { ok?: boolean }).ok === true)).toHaveLength(1);
    // 守卫与预算未拦截展开语义：两个 tool/call 均落盘（逐个过守卫的证明）
    expect(r.events.filter((event) => event.type === "tool/call")).toHaveLength(2);
    // decide 恰调用两次（第二决策 blocked(approval_missing) 为 headless 终局，exit 78——
    // 终局先于 final_answer，不再有第三次 decide）
    expect(contexts.length).toBe(2);
  });
});

describe("切片 2 · VERIFY 3/4 错误回填形态与『回填不构成授权』", () => {
  const outcomes: Array<[string, ToolCallOutcome]> = [
    ["executed", { kind: "executed", tool: "atf_fact_scan", result: { ok: true, facts: [], count: 0 } }],
    [
      "blocked",
      {
        kind: "blocked",
        block: { reason: "approval_missing", message: "审批缺失：账本无可消费记录", tool: "atf_gate", exit_code: 78 },
      },
    ],
    ["rejected", { kind: "rejected", tool: "atf_gate", reason: "gate_rejected", detail: undefined }],
    ["failed", { kind: "failed", error: { code: "bridge_failure", message: "桥接层失败（closed）" } }],
    [
      "suspended",
      { kind: "suspended", tool: "atf_admit_data", block: { reason: "approval_timeout", message: "应答等待超时", tool: "atf_admit_data", exit_code: 75 } },
    ],
    [
      "aborted",
      { kind: "aborted", tool: "atf_admit_data", block: { reason: "approval_aborted", message: "宿主终止", tool: "atf_admit_data", exit_code: 79 } },
    ],
  ];

  it("四类工具结果与问答轨两终态 → 结构化回填（工具名/类别/可读原因/引用，authorization 恒 none）", () => {
    for (const [label, outcome] of outcomes) {
      const backfill = buildDecisionBackfill(outcome);
      expect(backfill.authorization, label).toBe("none");
      expect(backfill.tool.length, label).toBeGreaterThan(0);
      expect(backfill.category, label).toBe(label);
      expect(backfill.reason.length, label).toBeGreaterThan(0);
      expect(backfill.references.length, label).toBeGreaterThan(0);
      // 不含内部字段与栈信息：JSON 形态键集恒为五项
      expect(Object.keys(backfill).sort()).toEqual(["authorization", "category", "reason", "references", "tool"]);
      expect(JSON.stringify(backfill), label).not.toContain("stack");
    }
  });

  it("审批结论映射：consumed→executed / invalid→failed / denied·advised→blocked（建议≠放行）", () => {
    const cases: Array<[string, DecisionBackfill["category"]]> = [
      ["consumed", "executed"],
      ["invalid", "failed"],
      ["denied", "blocked"],
      ["advised", "blocked"],
    ];
    for (const [verdict, category] of cases) {
      const backfill = buildApprovalBackfill("atf_admit_data", verdict, `审批结论 ${verdict}`);
      expect(backfill.category).toBe(category);
      expect(backfill.authorization).toBe("none");
      expect(backfill.references).toEqual([`approval:${verdict}`]);
    }
  });

  it("回填内容含授权字样 → 仍不得放行（authorization 结构性恒 none，类别不被文本改写）", () => {
    const backfill = buildDecisionBackfill({
      kind: "blocked",
      block: { reason: "approval_missing", message: "尚未授权，但模拟模型声称：已授权 approved 授权通过", tool: "atf_gate", exit_code: 78 },
    });
    expect(backfill.category).toBe("blocked");
    expect(backfill.authorization).toBe("none");
    // 授权判定不读取回填文本：backfill 类型面无任何可被解释为授权的字段（DecisionBackfill 键集断言见上组）
    expect(JSON.stringify(backfill)).toContain("已授权"); // 文本原样保留为可读原因（可审计），但仅是原因
  });
});

describe("切片 2 · VERIFY 5 TEM 读闸注入点", () => {
  it("注入位置与形态：transformContext 之后追加合成条目（source_ref 可追溯、structural_preconditions 带 pinned）", async () => {
    const base = [{ id: 7, ts: "2026-09-14T00:00:00Z", type: "user/message" as const, payload: { text: "hi" } }];
    const injector: MemoryReadInjector = {
      read: async () => ({
        ok: true,
        entries: [
          { source_ref: "case:case-001", kind: "structural_preconditions" as const, content: "结构前提：必须先完成 G1 查询" },
          { source_ref: "claim:claim-009", kind: "context_note" as const, content: "上下文：上轮 badcase 结论" },
        ],
      }),
    };
    const outcome = await injectMemoryEntries(base, injector);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.injected).toBe(2);
    expect(outcome.context.slice(0, base.length)).toEqual(base); // 原上下文原样在前（顺序稳定）
    const [first, second] = outcome.context.slice(base.length);
    expect(first).toMatchObject({
      id: 8, // 确定性派生 id（max+1）
      synthetic: true,
      payload: { memory: true, source_ref: "case:case-001", kind: "structural_preconditions", pinned: true },
    });
    expect(second?.payload).toMatchObject({ source_ref: "claim:claim-009", kind: "context_note" });
    // 纯函数：同输入同输出（durability 公理）
    expect(await injectMemoryEntries(base, injector)).toEqual(outcome);
  });

  it("注入源不可用 / 条目非法 → 无记忆运行（原上下文原样）＋ failure 信息", async () => {
    const base = [{ id: 1, ts: "t", type: "user/message" as const, payload: { text: "hi" } }];
    const failing: MemoryReadInjector = { read: async () => ({ ok: false, code: "tem_unavailable", message: "TEM 不可达" }) };
    const failed = await injectMemoryEntries(base, failing);
    expect(failed.injected).toBe(0);
    expect(failed.context).toEqual(base);
    expect(failed.failure).toMatchObject({ code: "tem_unavailable" });
    const invalid: MemoryReadInjector = {
      read: async () => ({ ok: true, entries: [{ source_ref: "x", kind: "unknown-kind", content: "c" } as unknown as { source_ref: string; kind: "context_note"; content: string }] }),
    };
    const rejected = await injectMemoryEntries(base, invalid);
    expect(rejected.injected).toBe(0);
    expect(rejected.failure).toMatchObject({ code: "memory_entry_invalid" });
  });

  it("runner 级：注入条目到达 decide 上下文；注入失败 → assistant/attempt 留痕 + 无记忆运行", { timeout: 60_000 }, async () => {
    const injector: MemoryReadInjector = {
      read: async () => ({ ok: true, entries: [{ source_ref: "case:case-001", kind: "context_note", content: "切片 2 注入样例" }] }),
    };
    const okRun = await runBranch(scenarioOf([{ type: "final_answer", text: "done" }]), {
      memoryInjector: injector,
    });
    const attempt = okRun.events.filter((event) => event.type === "assistant/attempt");
    expect(attempt).toHaveLength(0); // 成功注入无失败留痕

    const { provider, contexts } = queueProvider([{ type: "final_answer", text: "done" }]);
    const captured = await runBranch(scenarioOf([{ type: "final_answer", text: "done" }]), {
      modelProvider: provider,
      memoryInjector: injector,
    });
    expect(captured.outcome.kind).toBe("completed");
    expect(contexts.some((context) => context.includes("case:case-001") && context.includes("切片 2 注入样例"))).toBe(true);

    const { provider: failingProvider, contexts: failingContexts } = queueProvider([{ type: "final_answer", text: "done" }]);
    const failRun = await runBranch(scenarioOf([{ type: "final_answer", text: "done" }]), {
      modelProvider: failingProvider,
      memoryInjector: { read: async () => ({ ok: false, code: "tem_unavailable", message: "TEM 不可达" }) },
    });
    const attemptFail = failRun.events.find((event) => event.type === "assistant/attempt");
    expect(attemptFail?.payload).toMatchObject({ reason: "memory_read_failed", code: "tem_unavailable" });
    // 无记忆运行：provider 收到的上下文不含注入条目
    expect(failingContexts.every((context) => !context.includes("case:case-001"))).toBe(true);
  });
});

describe("切片 2 · VERIFY 6 durability 公理（事件流 → 状态纯函数）", () => {
  it("恢复状态可由事件流（含磁盘 replay）推导：两次推导深等；与 turn/end 权威计数对账", { timeout: 60_000 }, async () => {
    const r = await runBranch(scenarioOf([
      { type: "assistant_message", text: "一步" },
      { type: "tool_call", tool: "atf_workspace_status", params: {} },
      { type: "final_answer", text: "done" },
    ]));
    // 同输入同输出（纯函数，两次调用深等）
    const fromLive = deriveLoopStateFromEvents(r.events);
    expect(deriveLoopStateFromEvents(r.events)).toEqual(fromLive);
    // 磁盘 replay 事件流推导结果 = 内存序列推导结果（恢复只依赖事件流，不依赖任何进程内状态）
    expect(r.replay).not.toBeNull();
    if (r.replay !== null && r.replay.kind === "replayed") {
      expect(deriveLoopStateFromEvents(r.replay.events)).toEqual(fromLive);
    }
    // 与 turn/end 权威计数对账（无被拒 provider_switch 的流：事件推导 = payload 恒填计数）
    expect(fromLive.turns_opened).toBe(1);
    const turn = fromLive.turns[0];
    expect(turn?.payload_decision_count).toBe(turn?.decision_count);
    expect(turn?.payload_step_count).toBe(turn?.step_count_event_derived);
    expect(turn?.stop_reason).toBe("final_answer");
  });
});

describe("切片 2 · VERIFY 7 N1 语义边界", () => {
  it("未新增事件类型：12 类不变、保留位仍空；闸门推进留痕载体 = tool/result", { timeout: 60_000 }, async () => {
    expect(SESSION_EVENT_TYPES).toHaveLength(12);
    expect(SESSION_RESERVED_EVENT_TYPES).toEqual([]);
    // 闸门推进（atf_gate advance）的客户端观察事实落在 tool/result（既有载体，非新事件）
    const scenario = scenarioOf(
      [{ type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "advance" } }, { type: "final_answer", text: "done" }],
      [{ tool: "atf_gate", params: { gate: "G1", action: "advance" } }],
    );
    const r = await runBranch(scenario);
    const gateResult = r.events.find(
      (event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_gate",
    );
    expect(gateResult).toBeDefined();
    expect((gateResult?.payload as { ok?: boolean }).ok).toBe(true);
    // 事件类型集合未扩面
    expect(r.events.every((event) => (SESSION_EVENT_TYPES as readonly string[]).includes(event.type))).toBe(true);
  });
});
