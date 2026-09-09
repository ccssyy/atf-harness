import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseScenario } from "../../src/llm/index.js";

/**
 * S5 场景脚本解析测试（owner 口径 #2：draft-v0 → v1 定稿入库 scenarios/，严格白名单）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const loadV1 = async (): Promise<unknown> => JSON.parse(await readFile(join(repoRoot, "scenarios", "admission-to-g2.json"), "utf8"));

describe("S5 场景脚本 v1 定稿解析", () => {
  it("v1 文件解析通过：4 分支齐备、步骤/期望形态合法", async () => {
    const parsed = parseScenario(await loadV1());
    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.error) : "").toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scenario_id).toBe("admission-to-g2");
    expect(parsed.value.version).toBe(1);
    expect(Object.keys(parsed.value.branches).sort()).toEqual([
      "B1_success_path",
      "B2_block_then_self_correct",
      "B3_no_approval_exit78",
      "B4_t0_ref_forbidden",
    ]);
    const b1 = parsed.value.branches["B1_success_path"];
    expect(b1?.steps).toHaveLength(8);
    expect(b1?.expect).toMatchObject({ outcome: "completed", exit_code: 0, gate_status: "pass", promoted: true });
    expect(b1?.setup.ledger).toHaveLength(2);
    expect(parsed.value.branches["B3_no_approval_exit78"]?.setup.ledger).toHaveLength(0);
  });

  it("反例族：版本/步骤白名单/未声明字段/branch_id 不一致/run_id 逃逸/期望枚举 一律拒绝", async () => {
    const base = (await loadV1()) as Record<string, unknown>;

    const badVersion = structuredClone(base) as Record<string, unknown>;
    badVersion["version"] = 2;
    expect(parseScenario(badVersion).ok).toBe(false);

    const branches = structuredClone((base as { branches: Record<string, unknown> }).branches);
    const unknownStep = structuredClone(branches);
    (unknownStep["B1_success_path"] as { steps: unknown[] }).steps[0] = { type: "deploy_to_prod", text: "x" };
    expect(parseScenario({ ...base, branches: unknownStep }).ok).toBe(false);

    const undeclared = structuredClone(branches);
    (undeclared["B1_success_path"] as { steps: unknown[] }).steps[0] = { type: "final_answer", text: "x", evil: 1 };
    expect(parseScenario({ ...base, branches: undeclared }).ok).toBe(false);

    const mismatched = structuredClone(branches);
    (mismatched["B1_success_path"] as { branch_id: string }).branch_id = "other";
    expect(parseScenario({ ...base, branches: mismatched }).ok).toBe(false);

    const escape = structuredClone(branches);
    (escape["B1_success_path"] as { run_id: string }).run_id = "../escape";
    expect(parseScenario({ ...base, branches: escape }).ok).toBe(false);

    const badExpect = structuredClone(branches);
    (badExpect["B1_success_path"] as { expect: Record<string, unknown> }).expect["outcome"] = "whatever";
    expect(parseScenario({ ...base, branches: badExpect }).ok).toBe(false);

    const badToolCall = structuredClone(branches);
    (badToolCall["B1_success_path"] as { steps: unknown[] }).steps[3] = { type: "tool_call", tool: "atf_gate" };
    expect(parseScenario({ ...base, branches: badToolCall }).ok).toBe(false);

    const badPromote = structuredClone(branches);
    (badPromote["B1_success_path"] as { steps: unknown[] }).steps[6] = { type: "promote", source: "x.md", command: [] };
    expect(parseScenario({ ...base, branches: badPromote }).ok).toBe(false);
  });
});
