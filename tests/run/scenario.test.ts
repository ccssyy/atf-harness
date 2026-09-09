import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseScenario } from "../../src/llm/index.js";
import { resolveRunExitCode, ScenarioRunner, type BranchRunReport } from "../../src/run/index.js";
import { sha256Hex } from "../../src/workspace/index.js";

/**
 * S5 冒烟 runner 测试（任务书 §5 四分支 + owner 口径 #1–#6；mock 对端 = 契约 mock，owner 口径 #3）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scenarioPath = join(repoRoot, "scenarios", "admission-to-g2.json");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenario = parseScenario(JSON.parse(await readFile(scenarioPath, "utf8")));
expect(scenario.ok, "场景脚本 v1 须可解析").toBe(true);

const runBranch = async (branchId: string): Promise<BranchRunReport> => {
  if (!scenario.ok) throw new Error("unreachable");
  const ran = await ScenarioRunner.runBranch(scenario.value, branchId, {
    runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
    mockCommand: ["node", mockPath],
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

describe("S5 验收 · B1 成功路径（读状态 → 准入 → 扫描 → G2 PASS → 晋升 → 收束）", () => {
  it("exit 0 + G2 PASS + 证据链闭合（domain_refs 合法）+ 晋升登记 sha + 会话可重建", async () => {
    const r = await runBranch("B1_success_path");
    expect(r.outcome.kind).toBe("completed");
    expect(r.exit_code).toBe(0);
    expect(r.expect_violations).toEqual([]);

    // 事件序列（13 条）：turn/start, user/message, assistant/message, 4×(tool/call+tool/result), assistant/message(final), turn/end
    expect(r.events.map((event) => event.type)).toEqual([
      "turn/start",
      "user/message",
      "assistant/message",
      "tool/call",
      "tool/result",
      "tool/call",
      "tool/result",
      "tool/call",
      "tool/result",
      "tool/call",
      "tool/result",
      "assistant/message",
      "turn/end",
    ]);

    // 证据链闭合：gate tool/result 携带准入事实三元组（digest 经 SurfaceScanResolver 校验通过）
    const gateResult = r.events.find((event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_gate");
    expect(gateResult).toBeDefined();
    expect((gateResult?.payload as { result?: { status?: string } }).result?.status).toBe("pass");
    expect(gateResult?.domain_refs).toEqual([
      { journal_type: "run_journal", fact_id: "fact-ds-ten-doc-round3", sha256_digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    // T0→T1 晋升演示：catalog 恰一条登记，sha256 = artifacts 产物字节
    expect(r.catalog).toHaveLength(1);
    expect(r.catalog[0]?.artifact_id).toBe("analysis_badcase_scan.md");
    const artifactBytes = await readFile(join(r.workspace_root, "artifacts", "analysis_badcase_scan.md"));
    expect(sha256Hex(artifactBytes)).toBe(r.catalog[0]?.sha256);

    // 会话可从磁盘完整重建（内存序列与 replay 一致、digest 校验全过）
    expect(r.replay).not.toBeNull();
    expect(r.replay?.kind).toBe("replayed");
    expect(JSON.stringify(r.replay !== null && r.replay.kind === "replayed" ? r.replay.events : null)).toBe(JSON.stringify(r.events));
    expect(r.replay !== null && r.replay.kind === "replayed" ? r.replay.blocks : []).toEqual([]);
  });
});

describe("S5 验收 · B2 缺证据 → block 回填 → 自纠 → PASS", () => {
  it("首次 gate blocked（业务信号）→ 补准入 → 重提 pass；block 回填会话且可重放", async () => {
    const r = await runBranch("B2_block_then_self_correct");
    expect(r.outcome.kind).toBe("completed");
    expect(r.exit_code).toBe(0);
    expect(r.expect_violations).toEqual([]);

    const gateResults = r.events
      .filter((event) => event.type === "tool/result" && (event.payload as { tool?: string }).tool === "atf_gate")
      .map((event) => event.payload as { ok: boolean; result: { status: string; reason?: string } });
    expect(gateResults).toHaveLength(2);
    expect(gateResults[0]?.ok).toBe(true);
    expect(gateResults[0]?.result.status).toBe("blocked");
    expect(gateResults[0]?.result.reason).toBe("evidence_missing");
    expect(gateResults[1]?.result.status).toBe("pass");

    // block 回填：首次 gate 的 tool/result 事件在会话流内（replay 可重建该事件）
    expect(r.replay !== null && r.replay.kind === "replayed" ? r.replay.events.length : -1).toBe(r.events.length);
    const replayedBlocked = r.replay !== null && r.replay.kind === "replayed"
      ? r.replay.events.some((event) => event.type === "tool/result" && (event.payload as { result?: { status?: string } }).result?.status === "blocked")
      : false;
    expect(replayedBlocked).toBe(true);
  });
});

describe("S5 验收 · B3 无审批 → approval_missing → exit 78", () => {
  it("无预录 → blocked(approval_missing) 即终局，exit 78（78 不扩用）", async () => {
    const r = await runBranch("B3_no_approval_exit78");
    expect(r.outcome.kind).toBe("approval_missing");
    expect(r.exit_code).toBe(78);
    expect(r.expect_violations).toEqual([]);
    if (r.outcome.kind === "approval_missing") {
      expect(r.outcome.block.reason).toBe("approval_missing");
      expect(r.outcome.block.exit_code).toBe(78);
      expect(resolveRunExitCode(r.outcome)).toBe(78);
    }
    // 结构化 block 已作为 tool/result 回填会话（事件留痕），流可重建
    const backfilled = r.events.find(
      (event) => event.type === "tool/result" && (event.payload as { reason?: string }).reason === "approval_missing",
    );
    expect(backfilled).toBeDefined();
    expect(r.events.map((event) => event.type)).toEqual(["turn/start", "user/message", "tool/call", "tool/result", "turn/end"]);
    expect(r.replay?.kind).toBe("replayed");
  });
});

describe("S5 验收 · B4 T0 引用 → 铁律一拒绝 → exit 1 + t0_ref_forbidden", () => {
  it("引用 scratch 产物 → 会话层拒绝（不走 78），事件不落盘，流仍可重建", async () => {
    const r = await runBranch("B4_t0_ref_forbidden");
    expect(r.outcome.kind).toBe("session_rejected");
    expect(r.exit_code).toBe(1);
    expect(r.exit_code).not.toBe(78);
    expect(r.expect_violations).toEqual([]);
    if (r.outcome.kind === "session_rejected") {
      expect(r.outcome.block.reason).toBe("t0_ref_forbidden");
      expect(r.outcome.block.invalid_refs[0]?.fact_id).toBe("scratch/unverified_claim.json");
      expect(resolveRunExitCode(r.outcome)).toBe(1);
    }
    // 被拒事件不在会话流内（直接拒绝语义）；log = turn/start + user/message + turn/end
    expect(r.events.map((event) => event.type)).toEqual(["turn/start", "user/message", "turn/end"]);
    expect(r.events.some((event) => event.type === "tool/call")).toBe(false); // gate 未被触达
    expect(r.replay?.kind).toBe("replayed");
  });
});

describe("S5 runner 统一出口与输入守卫", () => {
  it("resolveRunExitCode 映射：completed→0 / approval_missing→78 / session_rejected→1 / failed→1", () => {
    expect(resolveRunExitCode({ kind: "completed" })).toBe(0);
    expect(
      resolveRunExitCode({
        kind: "approval_missing",
        block: { reason: "approval_missing", message: "m", tool: "atf_admit_data", exit_code: 78 },
      }),
    ).toBe(78);
    expect(
      resolveRunExitCode({
        kind: "session_rejected",
        block: { reason: "t0_ref_forbidden", message: "m", invalid_refs: [] },
      }),
    ).toBe(1);
    expect(resolveRunExitCode({ kind: "failed", error: { code: "session_failure", message: "m" } })).toBe(1);
  });

  it("未知分支 → err(invalid_input)（不猜测）", async () => {
    if (!scenario.ok) throw new Error("unreachable");
    const ran = await ScenarioRunner.runBranch(scenario.value, "B9_nonexistent", {
      runsRoot: join(repoRoot, "tmp", "runs", `test-${randomUUID()}`),
      mockCommand: ["node", mockPath],
    });
    expect(ran.ok).toBe(false);
    if (!ran.ok) expect(ran.error.code).toBe("invalid_input");
  });
});
