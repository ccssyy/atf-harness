import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import {
  assertModelDecision,
  LLM_DECISION_TYPES,
  MODEL_DECISION_FORBIDDEN,
  type LlmDecision,
  type LlmProvider,
  type Scenario,
} from "../../src/llm/index.js";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";

/**
 * 切片 0 验收测试（任务书 §4 VERIFY 1/2/3/4/6）：决策类型拆分与运行时守卫。
 *
 * - VERIFY 1 类型边界：@ts-expect-error 编译期断言（tsc 门）+ assertModelDecision 运行时白名单；
 * - VERIFY 2 守卫正例：合法决策（assistant_message / final_answer）经 LlmProvider 正常执行；
 * - VERIFY 3 守卫反例（核心）：四类脚本指令经 provider 返回 → failed(model_decision_forbidden)；
 * - VERIFY 4 能力保全：scratch_write → promote 在脚本路径（ScriptedStepSource，守卫豁免）照常可用；
 * - VERIFY 6 留痕：被拒决策以 assistant/attempt 落盘（含被拒 type 与原因），会话可重建。
 *
 * 守卫作用域 = LlmProvider 接口（模型面）返回值；ScriptedStepSource（decisionFace="script"，
 * 测试路径）类型级豁免——保全路径 b（任务书 §2.3）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const branchOf = (steps: Scenario["branches"][string]["steps"]): Scenario => ({
  scenario_id: "slice0-guard",
  version: 1,
  provider: "faux",
  description: "切片 0 守卫测试场景",
  branches: {
    guard: {
      branch_id: "guard",
      run_id: "slice0-guard-run",
      trigger_instruction: "切片 0 守卫测试触发指令",
      purpose: "决策类型拆分与运行时守卫验收",
      setup: { ledger: [] },
      steps,
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const runGuardBranch = async (provider: LlmProvider, steps: Scenario["branches"][string]["steps"]): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(branchOf(steps), "guard", {
    runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
    mockCommand: ["node", mockPath],
    modelProvider: provider,
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

describe("切片 0 · VERIFY 1 类型边界（模型面不可表达脚本指令）", () => {
  it("编译期证明：四类脚本指令赋值给 LlmDecision 均为类型错误（@ts-expect-error 由 tsc 门校验）", () => {
    // 以下四个赋值若能通过编译（即 LlmDecision 意外包含脚本成员），@ts-expect-error 会
    // 反向报错——本用例在 `tsc -p tsconfig.json` 下构成编译期证明。
    // @ts-expect-error promote 不是模型面决策
    const promote: LlmDecision = { type: "promote", source: "x", command: ["y"] };
    // @ts-expect-error scratch_write 不是模型面决策
    const scratch: LlmDecision = { type: "scratch_write", path: "p", content: "c" };
    // @ts-expect-error cite_t0 不是模型面决策
    const cite: LlmDecision = { type: "cite_t0", source: "s", text: "t" };
    // @ts-expect-error provider_switch 不是模型面决策
    const switchStep: LlmDecision = { type: "provider_switch", to: "faux-alt" };
    expect([promote, scratch, cite, switchStep].length).toBe(4);
  });

  it("运行时白名单：三类合法决策通过；四类脚本指令与面外字段拒绝", () => {
    const legal: LlmDecision[] = [
      { type: "tool_call", tool: "atf_gate", params: { gate: "G1", action: "query" } },
      { type: "assistant_message", text: "hello" },
      { type: "final_answer", text: "done" },
    ];
    for (const decision of legal) {
      expect(assertModelDecision(decision)).toEqual({ ok: true, decision });
    }
    expect(LLM_DECISION_TYPES).toEqual(["tool_call", "assistant_message", "final_answer"]);
    const rejected: unknown[] = [
      { type: "promote", source: "x", command: ["y"] },
      { type: "scratch_write", path: "p", content: "c" },
      { type: "cite_t0", source: "s", text: "t" },
      { type: "provider_switch", to: "faux-alt" },
      { type: "tool_call", tool: "atf_gate", params: {}, cite_admitted_fact: true }, // 模型面外字段
      "not-an-object",
    ];
    for (const value of rejected) {
      const guard = assertModelDecision(value);
      expect(guard.ok, JSON.stringify(value)).toBe(false);
      if (!guard.ok) expect(guard.reason.length, guard.reason).toBeGreaterThan(0);
    }
  });
});

describe("切片 0 · VERIFY 3 守卫反例（核心）——脚本指令经 provider 返回 → fail-closed", () => {
  it.each([
    ["promote", { type: "promote", source: "analysis.md", command: ["cp", "analysis.md", "out/"] }],
    ["scratch_write", { type: "scratch_write", path: "p.md", content: "c" }],
    ["cite_t0", { type: "cite_t0", source: "p.md", text: "引用尝试" }],
    ["provider_switch", { type: "provider_switch", to: "faux-alt" }],
  ])("provider 返回 %s → failed(%s)，assistant/attempt 留痕（含被拒 type），会话可重建", { timeout: 60_000 }, async (_label, decision) => {
    const malicious: LlmProvider = {
      providerId: "faux",
      // 模拟失真/被注入的 provider：类型上宣称 LlmDecision，运行时返回脚本指令（守卫的存在理由）
      decide: async () => ok(decision as LlmDecision),
    };
    const r = await runGuardBranch(malicious, [{ type: "final_answer", text: "irrelevant" }]);

    expect(r.outcome.kind).toBe("failed");
    if (r.outcome.kind === "failed") {
      expect(r.outcome.error.code).toBe(MODEL_DECISION_FORBIDDEN);
    }
    expect(r.exit_code).toBe(1); // 不新增退出码：failed 复用 exit 1

    // VERIFY 6 留痕：assistant/attempt 落盘（含被拒 type + 结构化原因），turn/end 收口
    const attempt = r.events.find((event) => event.type === "assistant/attempt");
    expect(attempt).toBeDefined();
    expect(attempt?.payload).toMatchObject({
      rejected_type: (decision as { type: string }).type,
      reason: MODEL_DECISION_FORBIDDEN,
    });
    const turnEnd = r.events[r.events.length - 1];
    expect(turnEnd?.type).toBe("turn/end");
    expect((turnEnd?.payload as { reason?: string }).reason).toBe("failed");

    // 会话可从磁盘重建且包含留痕事件（跨进程可审计）
    expect(r.replay).not.toBeNull();
    expect(r.replay?.kind).toBe("replayed");
    const replayedTypes = r.replay !== null && r.replay.kind === "replayed" ? r.replay.events.map((event) => event.type) : [];
    expect(replayedTypes).toContain("assistant/attempt");
  });
});

describe("切片 0 · VERIFY 2 守卫正例——合法模型决策正常通过并执行", () => {
  it("assistant_message → assistant/message 事件；final_answer → completed（exit 0）", { timeout: 60_000 }, async () => {
    const legal: LlmDecision[] = [
      { type: "assistant_message", text: "切片 0 守卫正例消息" },
      { type: "final_answer", text: "done" },
    ];
    const provider: LlmProvider = {
      providerId: "faux",
      decide: async () => {
        const next = legal.shift();
        return ok(next ?? null);
      },
    };
    const r = await runGuardBranch(provider, [{ type: "final_answer", text: "irrelevant" }]);
    expect(r.outcome.kind).toBe("completed");
    expect(r.exit_code).toBe(0);
    const types = r.events.map((event) => event.type);
    expect(types).toContain("assistant/message");
    expect(types).not.toContain("assistant/attempt");
  });
});

describe("切片 0 · VERIFY 4 能力保全——脚本路径 scratch_write → promote 照常可用", () => {
  it("默认 Faux 路径（ScriptedStepSource，守卫豁免）：构造工作区状态并晋升（不注入模型面 provider，走既有路径）", { timeout: 60_000 }, async () => {
    const scenario = branchOf([
      { type: "scratch_write", path: "note.md", content: "切片 0 能力保全产物" },
      // 可复现闸：复现命令须独立重产同字节 stdout（B1 同款形态，cwd 非 scratch 根，不可 cat）
      { type: "promote", source: "note.md", command: ["node", "-e", 'process.stdout.write("切片 0 能力保全产物")'] },
      { type: "final_answer", text: "promoted" },
    ]);
    const guardBranch = scenario.branches.guard;
    expect(guardBranch).toBeDefined();
    if (guardBranch !== undefined) guardBranch.expect = { outcome: "completed", exit_code: 0, promoted: true };
    const ran = await ScenarioRunner.runBranch(scenario, "guard", {
      runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
      mockCommand: ["node", mockPath],
      // 不注入 providerRegistry——既有缺省路径（FauxProvider.fromBranch）逐位保持
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const r = ran.value;
    expect(r.outcome.kind, JSON.stringify(r.outcome)).toBe("completed");
    expect(r.exit_code).toBe(0);
    expect(r.expect_violations).toEqual([]);
    // 晋升闸 A 产物登记（三闸语义零改动——由 workspace 既有用例与本断言共同承载）
    expect(r.catalog).toHaveLength(1);
    expect(r.catalog[0]?.artifact_id).toBe("note.md");
  });
});
