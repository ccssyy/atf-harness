/**
 * F5 改动四 runner 级端到端用例（2026-09-26）：
 *   4.1 confirm 型请示——ask_user_for_input 经问答轨落账（approval/request → granted
 *       response）→ tool/result 携确认凭据（user_confirmation：by/at 账面事实、
 *       approval_ref＝approval_session_id、candidate_digest＝harness 复算）；
 *       denied 非终局；headless 无审批面 exit 78；空心卡面 fail-closed 拒绝。
 *   4.2 内容绑定提案键——同 argv 脚本重写前后两次提案 approval_key 不同且 content_digest
 *       随 request 落账。
 * 注：预写 scratch 文件的用例声明 fresh:false（跳过工作区清场——既有 scratch 料在位语义）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { ScenarioRunner } from "../../src/core/run/index.js";
import { ToolRegistry, WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/index.js";
import { canonicalDigestHex } from "../../src/core/canonicalDigest.js";
import { findPython3 } from "../../src/core/workspace/index.js";
import type { ApprovalStubResponse, BranchRunReport, ToolResultPayload } from "../../src/core/run/index.js";
import type { LlmDecision, LlmProvider, Scenario } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";

const mockPath = new URL("../../tests/fixtures/mock_atf.mjs", import.meta.url).pathname ?? "tests/fixtures/mock_atf.mjs";
const python = findPython3();

interface Env {
  runsRoot: string;
  host: LocalToolHost;
  cleanup: () => void;
}

const makeEnv = (): Env => {
  const runsRoot = mkdtempSync(join(tmpdir(), "atf-f5-runs-"));
  const home = mkdtempSync(join(tmpdir(), "atf-f5-home-"));
  const host: LocalToolHost = {
    scratchDir: "",
    kernelDir: runsRoot, // 本批用例不经 skill 面；kernelDir 仅占位
    home,
    baseEnv: { ATF_SKILLS_AUTO_INSTALL: "0" },
    pythonPath: python,
    launchWaitMs: 15_000,
  };
  return {
    runsRoot,
    host,
    cleanup: (): void => {
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const scenarioOf = (runId: string): Scenario => ({
  scenario_id: `f5-confirm-${randomUUID()}`,
  version: 1,
  provider: "faux" as const,
  description: "F5 confirm 型请示",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: "契约发布确认",
      purpose: "f5",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed" as const, exit_code: 0 as const },
    },
  },
});

/** 决策步骤：decision 前可选挂 sideEffect（脚本重写等测试内动作）。 */
interface F5Step {
  decision: LlmDecision;
  sideEffect?: () => void;
}

const CONFIRM_PARAMS = {
  kind: "confirm" as const,
  title: "抽取契约发布确认",
  candidate_ref: "candidate.json",
  prompt_texts: ["训练 Prompt 实文", "评估 Prompt 实文"],
  field_ids: ["invoice_number", "total"],
  coordinate_policy: "pixel",
};

const runF5 = async (
  env: Env,
  runId: string,
  steps: readonly F5Step[],
  stub?: (input: { approval_session_id: string; tool: string; approval_key: string; content_digest?: string }) => Promise<ApprovalStubResponse>,
): Promise<BranchRunReport> => {
  let index = 0;
  const provider: LlmProvider = {
    providerId: "f5-stub-model",
    decide: async () => {
      const next = steps[index];
      index += 1;
      if (next === undefined) return ok({ type: "final_answer", text: "收口。" });
      next.sideEffect?.();
      return ok(next.decision);
    },
  };
  const ran = await ScenarioRunner.runBranch(scenarioOf(runId), "main", {
    runsRoot: env.runsRoot,
    mockCommand: ["node", mockPath],
    modelProvider: provider,
    fresh: false, // 预写 scratch 料在位（不清场）
    toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
    ...(stub !== undefined ? { approvalSurface: { stub: stub as never } } : {}),
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

const eventsOf = (report: BranchRunReport): LlmContextEvent[] => report.events as unknown as LlmContextEvent[];

const resultsOf = (report: BranchRunReport, tool: string): ToolResultPayload[] =>
  eventsOf(report)
    .filter((event) => event.type === "tool/result")
    .map((event) => event.payload as ToolResultPayload)
    .filter((payload) => payload.tool === tool);

const approvalPayloads = (report: BranchRunReport): Record<string, unknown>[] =>
  eventsOf(report)
    .filter((event) => event.type === "approval/request" || event.type === "approval/response")
    .map((event) => event.payload as Record<string, unknown>);

describe("F5 4.1：confirm 型请示全链（问答轨落账 → 确认凭据随结果下发）", () => {
  it("granted：tool/result 携 user_confirmation（by/at 取自应答、approval_ref=aps、digest=复算值）", async () => {
    const env = makeEnv();
    try {
      const runId = `f5-ok-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      mkdirSync(env.host.scratchDir, { recursive: true });
      const candidateText = '{"fields":["invoice_number","total"],"coordinate_policy":"pixel"}';
      writeFileSync(join(env.host.scratchDir, "candidate.json"), candidateText);
      let seenSessionId = "";
      const report = await runF5(
        env,
        runId,
        [{ decision: { type: "tool_call", tool: "ask_user_for_input", params: CONFIRM_PARAMS } }],
        async (input) => {
          seenSessionId = input.approval_session_id;
          expect(input.tool).toBe("ask_user_for_input");
          return { verdict: "granted", actor: "tui-operator" };
        },
      );
      expect(report.outcome.kind).toBe("completed");
      expect(report.exit_code).toBe(0);
      const results = resultsOf(report, "ask_user_for_input");
      expect(results).toHaveLength(1);
      const payload = results[0];
      if (!payload || !payload.ok) throw new Error("expected executed result");
      const result = payload.result as Record<string, unknown>;
      expect(result["candidate_digest"]).toBe(canonicalDigestHex(JSON.parse(candidateText)));
      const confirmation = result["user_confirmation"] as Record<string, unknown>;
      expect(confirmation).toMatchObject({
        by: "tui-operator",
        channel: "harness-confirm-card",
        approval_ref: seenSessionId,
        candidate_digest: canonicalDigestHex(JSON.parse(candidateText)),
      });
      expect(typeof confirmation["at"]).toBe("string");
      // 落账面：approval/request + granted response 均在流内，session id 一致
      const payloads = approvalPayloads(report);
      expect(payloads.some((entry) => entry["tool"] === "ask_user_for_input")).toBe(true);
      expect(payloads.some((entry) => entry["verdict"] === "granted" && entry["approval_session_id"] === seenSessionId)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("denied：结构化回填（非终局），结果不携确认凭据", async () => {
    const env = makeEnv();
    try {
      const runId = `f5-deny-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      mkdirSync(env.host.scratchDir, { recursive: true });
      writeFileSync(join(env.host.scratchDir, "candidate.json"), '{"a":1}');
      const report = await runF5(
        env,
        runId,
        [
          { decision: { type: "tool_call", tool: "ask_user_for_input", params: CONFIRM_PARAMS } },
          { decision: { type: "tool_call", tool: "atf_workspace_status", params: {} } }, // 换路径（免审批）
        ],
        async () => ({ verdict: "denied", actor: "tui-operator", reason: "字段序与我对过的版本不一致" }),
      );
      expect(report.outcome.kind).toBe("completed"); // denied 非终局
      const confirmResults = resultsOf(report, "ask_user_for_input");
      expect(confirmResults).toHaveLength(1);
      expect(confirmResults[0]?.ok).toBe(false);
      if (confirmResults[0]?.ok === false) {
        expect(confirmResults[0].reason).toBe("approval_denied");
      }
      expect(approvalPayloads(report).some((entry) => entry["verdict"] === "denied")).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("headless 无审批面 → approval_missing exit 78（fail-closed，ADR-07）", async () => {
    const env = makeEnv();
    try {
      const runId = `f5-headless-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      const report = await runF5(env, runId, [{ decision: { type: "tool_call", tool: "ask_user_for_input", params: CONFIRM_PARAMS } }]);
      expect(report.outcome.kind).toBe("approval_missing");
      expect(report.exit_code).toBe(78);
    } finally {
      env.cleanup();
    }
  });

  it("空心卡面（三要素缺失）→ handler 拒绝 invalid_input（不渲染空心卡）", async () => {
    const env = makeEnv();
    try {
      const runId = `f5-hollow-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      mkdirSync(env.host.scratchDir, { recursive: true });
      writeFileSync(join(env.host.scratchDir, "candidate.json"), '{"a":1}');
      const report = await runF5(
        env,
        runId,
        [{ decision: { type: "tool_call", tool: "ask_user_for_input", params: { kind: "confirm", candidate_ref: "candidate.json" } } }],
        async () => ({ verdict: "granted", actor: "tui-operator" }),
      );
      const confirmResults = resultsOf(report, "ask_user_for_input");
      expect(confirmResults).toHaveLength(1);
      expect(confirmResults[0]?.ok).toBe(false);
      if (confirmResults[0]?.ok === false) {
        expect(confirmResults[0].reason).toBe("invalid_input");
        expect(JSON.stringify(confirmResults[0].detail)).toContain("空心卡面");
      }
    } finally {
      env.cleanup();
    }
  });
});

describe("F5 4.2：同路径重写 → 提案 key 变化（问答轨全管线）", () => {
  it("atf_scratch_exec 同 argv 两次提案：approval_key 不同、content_digest 随 request 落账", { timeout: 60_000 }, async () => {
    const env = makeEnv();
    try {
      const runId = `f5-key-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      mkdirSync(env.host.scratchDir, { recursive: true });
      writeFileSync(join(env.host.scratchDir, "peek.py"), "print('v1')\n");
      const argv = ["python3", "peek.py"];
      const report = await runF5(
        env,
        runId,
        [
          { decision: { type: "tool_call", tool: "atf_scratch_exec", params: { argv } } },
          {
            sideEffect: (): void => writeFileSync(join(env.host.scratchDir, "peek.py"), "print('v2 — rewritten')\n"),
            decision: { type: "tool_call", tool: "atf_scratch_exec", params: { argv } },
          },
        ],
        async () => ({ verdict: "granted", actor: "stub-host" }),
      );
      expect(report.outcome.kind).toBe("completed");
      const requests = eventsOf(report)
        .filter((event) => event.type === "approval/request")
        .map((event) => event.payload as Record<string, unknown>)
        .filter((payload) => payload["tool"] === "atf_scratch_exec");
      expect(requests).toHaveLength(2);
      const first = requests[0] as unknown as { approval_key: string; content_digest?: string };
      const second = requests[1] as unknown as { approval_key: string; content_digest?: string };
      expect(first.approval_key).not.toBe(second.approval_key);
      expect(first.content_digest).toBeDefined();
      expect(second.content_digest).toBeDefined();
      expect(first.content_digest).not.toBe(second.content_digest);
      expect(second.approval_key).toBe(`${first.approval_key.split(":")[0]}:${second.content_digest}`);
    } finally {
      env.cleanup();
    }
  });
});
