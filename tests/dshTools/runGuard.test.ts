/**
 * RunGuard 合同测试：判定五态／汇报节流／恢复退避与上限／状态落盘。
 *
 * 全部纯函数＋注入副作用，不触网、不起进程。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARD_THRESHOLDS,
  EMPTY_GUARD_STATE,
  decideGuard,
  guardReportsPathOf,
  guardStatePathOf,
  guardTick,
  readGuardState,
  type GuardFacts,
  type GuardState,
} from "../../src/core/workspace/runGuard.js";

const NOW = Date.parse("2026-10-29T00:00:00Z");

const factsOf = (patch: Partial<GuardFacts> = {}): GuardFacts => ({
  phase: "train",
  active: true,
  done: false,
  processEvidence: true,
  lastProgressAtMs: NOW - 5_000,
  percent: 25,
  progressLabel: "3/12 步",
  exitCode: null,
  oom: false,
  nowMs: NOW,
  ...patch,
});

const stateOf = (patch: Partial<GuardState> = {}): GuardState => ({ ...EMPTY_GUARD_STATE, ...patch });

const freshRunDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"));
  mkdirSync(join(dir, "webui"), { recursive: true });
  return dir;
};

describe("decideGuard 判定", () => {
  it("运行中且距上次汇报不足间隔：不汇报", () => {
    const d = decideGuard(factsOf(), DEFAULT_GUARD_THRESHOLDS, stateOf({ lastReportAtMs: NOW - 60_000 }));
    expect(d.verdict).toBe("running");
    expect(d.report).toBe(false);
    expect(d.text).toBeNull();
  });

  it("运行中且到点：产一条人读进度", () => {
    const d = decideGuard(factsOf(), DEFAULT_GUARD_THRESHOLDS, stateOf({ lastReportAtMs: NOW - 700_000 }));
    expect(d.report).toBe(true);
    expect(d.level).toBe("info");
    expect(d.text).toContain("训练进行中");
    expect(d.text).toContain("3/12 步");
  });

  it("阶段完成：只报一次", () => {
    const first = decideGuard(factsOf({ done: true }), DEFAULT_GUARD_THRESHOLDS, stateOf());
    expect(first.verdict).toBe("finished");
    expect(first.report).toBe(true);
    const again = decideGuard(factsOf({ done: true }), DEFAULT_GUARD_THRESHOLDS, stateOf({ lastVerdict: "finished" }));
    expect(again.report).toBe(false);
  });

  it("OOM：判失败但不动手（降档由既有链路负责）", () => {
    const d = decideGuard(factsOf({ oom: true }), DEFAULT_GUARD_THRESHOLDS, stateOf());
    expect(d.verdict).toBe("failed");
    expect(d.reason).toBe("oom");
    expect(d.recover).toBe(false);
    expect(d.text).toContain("显存不足");
  });

  it("退出码非 0：判失败且允许恢复", () => {
    const d = decideGuard(factsOf({ exitCode: 1 }), DEFAULT_GUARD_THRESHOLDS, stateOf());
    expect(d.verdict).toBe("failed");
    expect(d.reason).toBe("exit_1");
    expect(d.recover).toBe(true);
    expect(d.text).toContain("退出码 1");
  });

  it("进程取证明确为不在：判失败且允许恢复", () => {
    const d = decideGuard(factsOf({ processEvidence: false }), DEFAULT_GUARD_THRESHOLDS, stateOf());
    expect(d.reason).toBe("process_gone");
    expect(d.recover).toBe(true);
  });

  it("进程取证不可用（null）：不据此判死，仍按运行态判定", () => {
    const d = decideGuard(factsOf({ processEvidence: null }), DEFAULT_GUARD_THRESHOLDS, stateOf());
    expect(d.verdict).toBe("running");
  });

  it("软停滞：只报不重启", () => {
    const d = decideGuard(
      factsOf({ lastProgressAtMs: NOW - DEFAULT_GUARD_THRESHOLDS.stallMs - 1_000 }),
      DEFAULT_GUARD_THRESHOLDS,
      stateOf(),
    );
    expect(d.verdict).toBe("stalled");
    expect(d.reason).toBe("stalled");
    expect(d.recover).toBe(false);
    expect(d.level).toBe("warn");
  });

  it("硬停滞：允许重启", () => {
    const d = decideGuard(
      factsOf({ lastProgressAtMs: NOW - DEFAULT_GUARD_THRESHOLDS.hardStallMs - 1_000 }),
      DEFAULT_GUARD_THRESHOLDS,
      stateOf(),
    );
    expect(d.reason).toBe("hard_stalled");
    expect(d.recover).toBe(true);
    expect(d.text).toContain("硬阈值");
  });

  it("已达恢复上限：硬停滞也不再动手", () => {
    const d = decideGuard(
      factsOf({ lastProgressAtMs: NOW - DEFAULT_GUARD_THRESHOLDS.hardStallMs - 1_000 }),
      DEFAULT_GUARD_THRESHOLDS,
      stateOf({ attempts: DEFAULT_GUARD_THRESHOLDS.maxRecoveries }),
    );
    expect(d.recover).toBe(false);
    expect(d.text).toContain("恢复上限");
  });

  it("退避未到：不动手", () => {
    const d = decideGuard(
      factsOf({ exitCode: 2 }),
      DEFAULT_GUARD_THRESHOLDS,
      stateOf({ attempts: 1, lastActionAtMs: NOW - 1_000 }),
    );
    expect(d.recover).toBe(false);
    expect(d.text).toContain("退避");
  });

  it("评估阶段用同一套判定（文案按阶段切换）", () => {
    const d = decideGuard(
      factsOf({ phase: "eval", progressLabel: "generate 2/5" }),
      DEFAULT_GUARD_THRESHOLDS,
      stateOf({ lastReportAtMs: NOW - 700_000 }),
    );
    expect(d.verdict).toBe("running");
    expect(d.text).toContain("评估进行中");
    expect(d.text).toContain("generate 2/5");
  });
});

describe("guardTick 落盘与恢复", () => {
  it("汇报写 alerts 与进度流水，状态推进", async () => {
    const runDir = freshRunDir();
    const result = await guardTick({
      runDir,
      facts: factsOf(),
      thresholds: { ...DEFAULT_GUARD_THRESHOLDS },
      now: () => new Date(NOW),
    });
    expect(result.decision.report).toBe(true);
    expect(readGuardState(runDir).lastVerdict).toBe("running");
    const reports = JSON.parse(readFileSync(guardReportsPathOf(runDir), "utf8")) as unknown[];
    expect(reports.length).toBe(1);
    const alerts = JSON.parse(readFileSync(join(runDir, "webui", "alerts.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(alerts.at(-1)?.["kind"]).toBe("guard");
  });

  it("恢复成功：attempts +1 且落动作时间", async () => {
    const runDir = freshRunDir();
    let called = 0;
    const result = await guardTick({
      runDir,
      facts: factsOf({ exitCode: 3 }),
      relaunch: async () => {
        called += 1;
        return { ok: true, detail: "train.sh relaunched" };
      },
      now: () => new Date(NOW),
    });
    expect(result.recovered).toBe(true);
    expect(called).toBe(1);
    const state = readGuardState(runDir);
    expect(state.attempts).toBe(1);
    expect(state.lastActionAtMs).toBe(NOW);
  });

  it("恢复失败：不记 attempts，但如实写失败通报", async () => {
    const runDir = freshRunDir();
    const result = await guardTick({
      runDir,
      facts: factsOf({ exitCode: 3 }),
      relaunch: async () => ({ ok: false, detail: "port busy" }),
      now: () => new Date(NOW),
    });
    expect(result.recovered).toBe(false);
    expect(readGuardState(runDir).attempts).toBe(0);
    const alerts = JSON.parse(readFileSync(join(runDir, "webui", "alerts.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(alerts.some((a) => String(a["reason"]).endsWith("recover_failed"))).toBe(true);
  });

  it("没有注入恢复动作：只报不动手（fail-closed）", async () => {
    const runDir = freshRunDir();
    const result = await guardTick({
      runDir,
      facts: factsOf({ processEvidence: false }),
      now: () => new Date(NOW),
    });
    expect(result.decision.recover).toBe(true);
    expect(result.recovered).toBe(false);
    expect(readGuardState(runDir).attempts).toBe(0);
  });

  it("状态文件坏件：按空态读，不抛", () => {
    const runDir = freshRunDir();
    writeFileSync(guardStatePathOf(runDir), "{not json", "utf8");
    expect(readGuardState(runDir).attempts).toBe(0);
    expect(existsSync(guardStatePathOf(runDir))).toBe(true);
  });
});
