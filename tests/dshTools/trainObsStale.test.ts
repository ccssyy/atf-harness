/**
 * D16——训练状态假活修复测试锚：源新鲜度门（trainer_log mtime 超窗 → 写一次 stale 快照后
 * 停写，updated_at/source_updated_at 回写源 mtime 不得 now）；新日志正常写零 stale；
 * progressFresh(stale:true)=false（旧文件无字段行为不变）；stat 失败同 stale 一次后停；
 * 源 mtime 变新 → 过门复活（新鲜日志不误杀）。
 */
import { describe, expect, it } from "vitest";
import { progressFresh, type RunProgress } from "../../src/core/workspace/runFacts.js";
import { resetTrainObsForTest, trainObsTick, type TrainObsDeps } from "../../src/core/workspace/trainObsSync.js";

/** A800 现网真实样本行（84.95%——合并窗截图「训练中 85%」假活源）。 */
const REAL_LINE = '{"current_steps": 158, "total_steps": 186, "loss": 0.31, "epoch": 2.55, "percentage": 84.95, "remaining_time": "0:12:00"}';

const tail84 = () => ({
  current_steps: 158,
  total_steps: 186,
  loss: 0.31,
  epoch: 2.55,
  percentage: 84.95,
  remaining_time: "0:12:00",
});

const SOURCE_MTIME = "2026-10-11T02:41:00.000Z"; // 事故 run 源 mtime（9 天前）
const NOW = "2026-10-20T04:00:00.000Z";

interface Recorder {
  writes: RunProgress[];
}

const staleDeps = (rec: Recorder, opts: { mtime: number | null; stale?: boolean } = { mtime: Date.parse(SOURCE_MTIME) }): TrainObsDeps => ({
  readTail: () => tail84(),
  sourceMtime: () => (opts.mtime === undefined ? null : opts.mtime),
  env: { ATF_TRAIN_ACTIVE_WINDOW_MS: "180000" },
  now: () => new Date(NOW),
  // 盘面既有快照（真实流程 readProgress 读上次写——percentage 等面从此承接）
  lastProgress: () => ({ round: 6, percentage: 84.95, updated_at: SOURCE_MTIME }),
  writeProg: (_runDir, progress) => { rec.writes.push(progress); },
});

describe("D16 源新鲜度门与 progressFresh 防御", () => {
  it("①旧日志（mtime 超窗）→ 写一次 stale：updated_at=源 mtime（不得 now）＋stale=true；再 tick 已停不写", async () => {
    const rec: Recorder = { writes: [] };
    resetTrainObsForTest();
    const deps = staleDeps(rec);
    const r1 = await trainObsTick("run-old", "/tmp/whatever", null, deps);
    expect(r1).toBe("stale-stopped");
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0]?.stale).toBe(true);
    expect(rec.writes[0]?.updated_at).toBe(SOURCE_MTIME); // 回写源 mtime——不得 now
    expect(rec.writes[0]?.source_updated_at).toBe(SOURCE_MTIME);
    expect(rec.writes[0]?.percentage).toBe(84.95); // {...last} 快照面
    // 再 tick：stale 快照已在盘——不再写（already-stopped）
    const r2 = await trainObsTick("run-old", "/tmp/whatever", null, deps);
    expect(r2).toBe("already-stopped");
    expect(rec.writes).toHaveLength(1);
  });

  it("②新日志（mtime 窗口内）→ 正常写：updated_at=now、零 stale 字段", async () => {
    const rec: Recorder = { writes: [] };
    resetTrainObsForTest();
    const deps = staleDeps(rec, { mtime: Date.parse(NOW) - 30_000 }); // 30s 前——窗内
    const r = await trainObsTick("run-fresh", "/tmp/whatever", 3, deps);
    expect(r).toBe("written");
    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0]?.stale).toBeUndefined(); // 零 stale 字段
    expect(rec.writes[0]?.source_updated_at).toBeUndefined();
    expect(rec.writes[0]?.updated_at).toBe(NOW);
    expect(rec.writes[0]?.round).toBe(3); // epoch 2.55 → floor+1
  });

  it("③progressFresh：stale=true 恒 false（updated_at 再新也不续命）；旧文件无 stale 字段行为不变", () => {
    const nowMs = Date.parse(NOW);
    expect(progressFresh({ stale: true, updated_at: NOW }, nowMs, 180_000)).toBe(false);
    expect(progressFresh({ stale: true, updated_at: SOURCE_MTIME }, nowMs, 180_000)).toBe(false);
    // 旧形态（无 stale 字段）：窗口内 true／过期 false——行为不变
    expect(progressFresh({ updated_at: NOW }, nowMs, 180_000)).toBe(true);
    expect(progressFresh({ updated_at: SOURCE_MTIME }, nowMs, 180_000)).toBe(false);
    expect(progressFresh(null, nowMs, 180_000)).toBe(false);
  });

  it("④stat 失败（源 mtime 不可得）→ stale 一次后停；updated_at 沿用 last（无 last＝now，不造源时刻）", async () => {
    // 有 last：沿用 last.updated_at（源最后已知时刻）
    const rec: Recorder = { writes: [] };
    resetTrainObsForTest();
    const deps = staleDeps(rec, { mtime: null });
    const r1 = await trainObsTick("run-gone", "/tmp/whatever", null, deps);
    expect(r1).toBe("stale-stopped");
    expect(rec.writes[0]?.stale).toBe(true);
    expect(rec.writes[0]?.updated_at).toBe(SOURCE_MTIME); // last.updated_at
    expect(rec.writes[0]?.source_updated_at).toBe(SOURCE_MTIME);
    const r2 = await trainObsTick("run-gone", "/tmp/whatever", null, deps);
    expect(r2).toBe("already-stopped");
    expect(rec.writes).toHaveLength(1);
    // 无 last：now 兜底（诚实无源时刻——stale:true 已令 progressFresh=false，不构成续命）
    const rec2: Recorder = { writes: [] };
    resetTrainObsForTest();
    const deps2 = staleDeps(rec2, { mtime: null });
    deps2.lastProgress = () => null;
    await trainObsTick("run-gone2", "/tmp/whatever", null, deps2);
    expect(rec2.writes[0]?.updated_at).toBe(NOW);
  });

  it("⑤复活过门：stale 后源 mtime 变新（新行落盘）→ 恢复正常写零 stale（新鲜日志不误杀）", async () => {
    const rec: Recorder = { writes: [] };
    resetTrainObsForTest();
    let mtime: number | null = Date.parse(SOURCE_MTIME);
    const deps = staleDeps(rec, { mtime: null });
    deps.sourceMtime = () => mtime;
    const r1 = await trainObsTick("run-revive", "/tmp/whatever", null, deps);
    expect(r1).toBe("stale-stopped");
    const r2 = await trainObsTick("run-revive", "/tmp/whatever", null, deps);
    expect(r2).toBe("already-stopped");
    // 新行落盘 → mtime 变新 → 过门复活
    mtime = Date.parse(NOW) - 10_000;
    const r3 = await trainObsTick("run-revive", "/tmp/whatever", 3, deps);
    expect(r3).toBe("written");
    const lastWrite = rec.writes[rec.writes.length - 1];
    expect(lastWrite?.stale).toBeUndefined();
    expect(lastWrite?.updated_at).toBe(NOW);
  });
});
