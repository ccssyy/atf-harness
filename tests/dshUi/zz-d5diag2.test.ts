import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** D5 分叉实证:全拷贝正式用例,逐 tick 打 notice state 文件+monitor 观测态。 */
describe("d5 diag2", () => {
  it("全拷贝+打点", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "d5diag2-"));
    const mkRun = (runId: string): string => {
      const runDir = join(root, runId);
      mkdirSync(join(runDir, "training"), { recursive: true });
      mkdirSync(join(runDir, "launch"), { recursive: true });
      writeFileSync(join(runDir, "registration.json"), "{}");
      writeFileSync(join(runDir, "session.jsonl"), "{}\n");
      writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
      writeFileSync(join(runDir, "launch", "train-20260101.log"), "epoch 0\n");
      return runDir;
    };
    const doneRun = mkRun("run-d5-done");
    const failRun = mkRun("run-d5-fail");
    mkRun("run-d5-seen-done");
    const { rmSync: rm } = { rmSync };
    rmSync(join(root, "run-d5-seen-done", "training", "loss-series.json"));
    writeFileSync(join(root, "run-d5-seen-done", "training", "all_results.json"), "{}");
    const { tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
    const readMonitor = () =>
      (JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as { runs: Array<{ run_id: string; training?: { active: boolean }; train_notices: Array<{ id: string }> }> }).runs;
    const dump = (tag: string) => {
      const mon = readMonitor();
      let state = "{}";
      try { state = readFileSync(join(root, "atf-ui", "train-notice-state.json"), "utf8"); } catch { /* 未写 */ }
      console.log(tag, JSON.stringify({
        runs: mon.map((r) => ({ id: r.run_id, active: r.training?.active, n: (r.train_notices ?? []).length })),
        state: state.slice(0, 400),
      }));
    };
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    dump("T1:");
    writeFileSync(join(doneRun, "training", "all_results.json"), "{}");
    const stale = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(join(doneRun, "training", "loss-series.json"), stale, stale);
    utimesSync(join(doneRun, "launch", "train-20260101.log"), stale, stale);
    rmSync(join(failRun, "training", "loss-series.json"));
    writeFileSync(join(failRun, "training", "trainer_state.json"), "{}");
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    dump("T2:");
    rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
