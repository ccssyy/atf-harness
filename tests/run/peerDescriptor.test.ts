/**
 * W2 门 2：对端 spawn descriptor 归一化（载体 B）——runBranch 以描述符形态（argv/cwd/env）
 * 驱动 mock 对端全链（spawn→握手→bind→一步收束），证明归一后与 argv 形态语义一致；
 * 既有 argv 消费点（其余测试全量）零回归由套件整体承载。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import type { Scenario } from "../../src/llm/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

describe("W2：PeerSpawnDescriptor 直通 runBranch", () => {
  it("描述符形态（argv+cwd+env）驱动 mock 对端：一步 final_answer 收束 completed/exit 0", async () => {
    const scenario: Scenario = {
      scenario_id: "w2-peer-descriptor",
      version: 1,
      provider: "faux",
      description: "W2 对端 spawn 描述符归一化测试",
      branches: {
        main: {
          branch_id: "main",
          run_id: "w2-descriptor-run",
          trigger_instruction: "W2 描述符归一化触发指令",
          purpose: "描述符形态 spawn→握手→bind→收束",
          setup: { ledger: [] },
          steps: [{ type: "final_answer", text: "描述符形态收束" }],
          expect: { outcome: "completed", exit_code: 0 },
        },
      },
    };
    const ran = await ScenarioRunner.runBranch(scenario, "main", {
      runsRoot: join(repoRoot, "tmp", "runs", `w2-descriptor-${randomUUID()}`),
      mockCommand: {
        argv: ["node", mockPath],
        cwd: repoRoot,
        env: { ATF_W2_DESCRIPTOR_PROBE: "1" },
      },
    });
    expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const report: BranchRunReport = ran.value;
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
  });
});
