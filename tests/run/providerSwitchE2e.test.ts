import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ProviderSegment, type Scenario, type ScenarioStep } from "../../src/llm/index.js";
import { ScenarioRunner, type ProviderSwitchPayload } from "../../src/run/index.js";

/**
 * P2-S3 runner 端到端测试（启动决议验收 2：越界切换不落事件断言 / 切换原子性 /
 * 切换后首 turn 归属新 provider / 载荷字段与决议 §4 一致；digest 断裂反例在
 * providerSwitch.test.ts 原语级覆盖——runner 侧 resolver 为 mock 对端通道）。
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

let seq = 0;
const makeSegmentsScenario = (segments: ProviderSegment[]): Scenario => ({
  scenario_id: `p2s3-e2e-${++seq}`,
  version: 1,
  provider: "faux",
  description: "P2-S3 e2e",
  branches: {
    main: {
      branch_id: "main",
      run_id: `run-p2s3-e2e-${seq}-${randomUUID().slice(0, 8)}`,
      trigger_instruction: "多 provider 段",
      purpose: "P2-S3",
      setup: { ledger: [] },
      steps: [],
      segments,
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const runBranch = async (scenario: Scenario) => {
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: join(repoRoot, "tmp", "runs", `test-p2s3-${randomUUID()}`),
    mockCommand: ["node", mockPath],
  });
  expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
  if (!ran.ok) throw new Error("unreachable");
  return ran.value;
};

const segment = (providerId: string, steps: ScenarioStep[], reason?: string): ProviderSegment =>
  ({ provider_id: providerId, steps, ...(reason !== undefined ? { reason } : {}) });

describe("P2-S3 e2e——段边界合法切换（原子性 / 首 turn 归属 / 载荷形态）", () => {
  it("faux → faux-alt 两段：switch 事件落盘且新 provider 生效，无半生效", async () => {
    const report = await runBranch(
      makeSegmentsScenario([
        segment("faux", [{ type: "assistant_message", text: "A1" }]),
        segment("faux-alt", [{ type: "assistant_message", text: "B1" }, { type: "final_answer", text: "B2" }], "轮换"),
      ]),
    );
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);

    const switchEvents = report.events.filter((event) => event.type === "provider/switch");
    expect(switchEvents).toHaveLength(1);
    const switchEvent = switchEvents[0] as SessionEventLike;
    // 载荷与决议 §4 定死形态逐字段一致
    const payload = switchEvent.payload as ProviderSwitchPayload;
    expect(payload).toEqual({
      from: { provider_id: "faux" },
      to: { provider_id: "faux-alt" },
      boundary: { turn_index: 1, after_event_id: switchEvent.id - 1 },
      reason: "轮换",
    });
    // 边界形态：前邻 turn/end(provider_switch)，后邻 turn/start
    const before = report.events.find((event) => event.id === switchEvent.id - 1);
    const after = report.events.find((event) => event.id === switchEvent.id + 1);
    expect(before?.type).toBe("turn/end");
    expect((before?.payload as { reason?: string }).reason).toBe("provider_switch");
    expect(after?.type).toBe("turn/start");

    // 原子性 + 首 turn 归属：switch 事件存在 ⟺ 新 provider 生效，且决策确出自新段脚本
    expect(report.turns ?? []).toHaveLength(2);
    expect(report.turns?.[0]).toMatchObject({ turn_index: 1, provider_id: "faux" });
    expect(report.turns?.[1]).toMatchObject({ turn_index: 2, provider_id: "faux-alt" });
    const turn2First = report.events.find((event) => event.type === "assistant/message" && event.id > (report.turns?.[1]?.first_event_id ?? 0));
    expect((turn2First?.payload as { text?: string }).text).toBe("B1");
    expect(report.switches ?? []).toEqual([{ status: "switched", from: "faux", to: "faux-alt", event_id: switchEvent.id, turn_index: 1, reason: "轮换" }]);

    // 流可重建、零 ref_invalid（digest 连续等价断言的正例面）
    expect(report.replay?.kind).toBe("replayed");
    expect(report.replay?.kind === "replayed" ? report.replay.blocks : []).toEqual([]);
  });
});

describe("P2-S3 e2e——越界切换被拒（不落事件，非终局）", () => {
  it("turn 内 provider_switch → provider_switch_out_of_boundary，原 provider 继续", async () => {
    const report = await runBranch(
      makeSegmentsScenario([
        segment("faux", [
          { type: "assistant_message", text: "A1" },
          { type: "provider_switch", to: "faux-alt", reason: "越界反例" },
          { type: "final_answer", text: "done" },
        ]),
      ]),
    );
    expect(report.outcome.kind).toBe("completed"); // 非终局：run 继续
    expect(report.exit_code).toBe(0);
    expect(report.events.filter((event) => event.type === "provider/switch")).toHaveLength(0); // 不落 switch 事件
    expect(report.switches ?? []).toHaveLength(1);
    expect(report.switches?.[0]?.status).toBe("rejected");
    if (report.switches?.[0]?.status === "rejected") {
      expect(report.switches[0].block.reason).toBe("provider_switch_out_of_boundary");
      expect(report.switches[0].block.message).toContain("仅 turn 边界");
    }
    expect(report.turns ?? []).toHaveLength(1);
    expect(report.turns?.[0]).toMatchObject({ provider_id: "faux", decision_count: 3 });
  });
});

describe("P2-S3 e2e——注册面未命中（口径未覆盖防御路径，fail-closed）", () => {
  it("段边界切换目标未注册 → 不落事件、不放行切换，分支按故障终局", async () => {
    const report = await runBranch(
      makeSegmentsScenario([
        segment("faux", [{ type: "assistant_message", text: "A1" }]),
        segment("faux-ghost", [{ type: "final_answer", text: "x" }]),
      ]),
    );
    expect(report.outcome.kind).toBe("failed");
    expect(report.exit_code).toBe(1);
    expect(report.events.filter((event) => event.type === "provider/switch")).toHaveLength(0); // 不落事件
    expect(report.switches?.[0]?.status).toBe("rejected");
    if (report.switches?.[0]?.status === "rejected") {
      expect(report.switches[0].block.reason).toBe("provider_switch_unknown_provider");
    }
  });
});

interface SessionEventLike {
  id: number;
  type: string;
  payload: unknown;
}
