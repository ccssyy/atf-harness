/**
 * FIXVERIFY 小批（2026-09-23）：LOOP_MAX_TURNS / LOOP_MAX_STEPS_PER_TURN env 覆盖——
 * ATF_LOOP_MAX_TURNS / ATF_LOOP_MAX_STEPS_PER_TURN 正整数生效；未设/空/非法 fail-closed
 * 回退缺省（默认行为零变化）；runner 读取处实测（脚本径步数门随 env 收紧）。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ScenarioRunner } from "../../src/core/run/index.js";
import { loopMaxStepsPerTurn, loopMaxTurns } from "../../src/core/session/constants.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const ENV_KEYS = ["ATF_LOOP_MAX_TURNS", "ATF_LOOP_MAX_STEPS_PER_TURN"] as const;
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = saved.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  saved.clear();
});

const setEnv = (key: (typeof ENV_KEYS)[number], value: string | undefined): void => {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

describe("env 覆盖访问器：生效／回退／缺省零变化", () => {
  it("未设 → 缺省 8 / 32（默认行为零变化）", () => {
    setEnv("ATF_LOOP_MAX_TURNS", undefined);
    setEnv("ATF_LOOP_MAX_STEPS_PER_TURN", undefined);
    expect(loopMaxTurns()).toBe(8);
    expect(loopMaxStepsPerTurn()).toBe(32);
  });

  it("正整数覆盖生效（含与缺省不同的值）", () => {
    setEnv("ATF_LOOP_MAX_TURNS", "16");
    setEnv("ATF_LOOP_MAX_STEPS_PER_TURN", "64");
    expect(loopMaxTurns()).toBe(16);
    expect(loopMaxStepsPerTurn()).toBe(64);
  });

  it("非法值 fail-closed 回退缺省：非数字／0／负数／小数／空串", () => {
    for (const bad of ["abc", "0", "-3", "3.5", "", "  "]) {
      setEnv("ATF_LOOP_MAX_TURNS", bad);
      setEnv("ATF_LOOP_MAX_STEPS_PER_TURN", bad);
      expect(loopMaxTurns()).toBe(8);
      expect(loopMaxStepsPerTurn()).toBe(32);
    }
  });
});

describe("runner 读取处实测：脚本径步数门随 env 收紧／放宽", () => {
  const scenarioOf = (steps: { type: "assistant_message" | "final_answer"; text: string }[]): Parameters<typeof ScenarioRunner.runBranch>[0] => ({
    scenario_id: "loop-env-budget",
    version: 1,
    provider: "faux",
    description: "LOOP_MAX_TURNS env 可配化",
    branches: {
      main: {
        branch_id: "main",
        run_id: `loop-env-${randomUUID()}`,
        trigger_instruction: "走",
        purpose: "loop-env-budget",
        setup: { ledger: [] },
        steps,
        expect: { outcome: "completed", exit_code: 0 },
      },
    },
  });

  it("ATF_LOOP_MAX_STEPS_PER_TURN=4 → 脚本径第 4 步后收口 budget_exhausted(limit=4)", async () => {
    setEnv("ATF_LOOP_MAX_STEPS_PER_TURN", "4");
    const ran = await ScenarioRunner.runBranch(
      scenarioOf([
        { type: "assistant_message", text: "1" },
        { type: "assistant_message", text: "2" },
        { type: "assistant_message", text: "3" },
        { type: "assistant_message", text: "4" },
        { type: "assistant_message", text: "5" },
        { type: "final_answer", text: "到不了" },
      ]),
      "main",
      { runsRoot: join(repoRoot, "tmp", "runs", `loop-env-${randomUUID()}`), mockCommand: ["node", mockPath] },
    );
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    expect(ran.value.outcome.kind).toBe("failed");
    if (ran.value.outcome.kind !== "failed") throw new Error("unreachable");
    expect(ran.value.outcome.error.code).toBe("budget_exhausted");
    expect(JSON.stringify(ran.value.outcome.error)).toContain("max_steps_per_turn=4");
    expect(ran.value.exit_code).toBe(1);
  });

  it("未设 env → 同一脚本自然完成（缺省 32 不触达；默认行为零变化）", async () => {
    setEnv("ATF_LOOP_MAX_STEPS_PER_TURN", undefined);
    const ran = await ScenarioRunner.runBranch(
      scenarioOf([
        { type: "assistant_message", text: "1" },
        { type: "assistant_message", text: "2" },
        { type: "assistant_message", text: "3" },
        { type: "assistant_message", text: "4" },
        { type: "assistant_message", text: "5" },
        { type: "final_answer", text: "完成" },
      ]),
      "main",
      { runsRoot: join(repoRoot, "tmp", "runs", `loop-env-${randomUUID()}`), mockCommand: ["node", mockPath] },
    );
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    expect(ran.value.outcome.kind).toBe("completed");
    expect(ran.value.exit_code).toBe(0);
  });
});
