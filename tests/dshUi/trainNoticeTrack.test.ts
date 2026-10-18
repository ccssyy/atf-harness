// 批C1-1 D5——训练终态跃迁通知轨（纯状态机＋持久化）。
//
// - 观测态推导：与 snapshot.segmentStatus 训练段同优先级（活跃＞完成锚＞failed＞pending）；
// - 跃迁闭集：活跃/未启动 → done/failed 一跳产通知；首见即终态、终态间互跳不产（禁每轮全亮）；
// - 幂等：同一跃迁一个 id；重训（终态→活跃→终态）新时刻新 id 再报；
// - 持久化：坏文件空态重来（fail-closed 首见语义不重报）；通知账 per-run 上限 8。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTrainNoticeTransitions,
  isEmittingTransition,
  readTrainNoticeState,
  trainObservedStateOf,
  TRAIN_NOTICE_LOG_CAP,
  TRAIN_NOTICE_STATE_FILENAME,
  TRAIN_NOTICE_TEXT,
  writeTrainNoticeState,
  type TrainObservedState,
} from "../../src/core/workspace/trainNoticeTrack.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-trainnotice-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("批C1-1 D5 观测态推导（与段显示态同优先级镜像）", () => {
  it("活跃＞完成锚＞failed＞pending", () => {
    expect(trainObservedStateOf({ segments: { training: true }, training: { active: true } })).toBe("active");
    expect(trainObservedStateOf({ segments: { training: true }, training: { active: false } })).toBe("done");
    expect(trainObservedStateOf({ segments: { training: "failed" }, training: { active: false } })).toBe("failed");
    expect(trainObservedStateOf({ segments: { training: false }, training: { active: false } })).toBe("pending");
    expect(trainObservedStateOf({})).toBe("pending");
  });
});

describe("批C1-1 D5 跃迁闭集（活跃/未启动→终态才产；禁每轮全亮）", () => {
  it("起跳×落点矩阵：仅四格产", () => {
    const states: Array<[TrainObservedState | undefined, TrainObservedState, boolean]> = [
      ["active", "done", true],
      ["active", "failed", true],
      ["pending", "done", true],
      ["pending", "failed", true],
      [undefined, "done", false], // 首见即终态：无观测跃迁不产
      [undefined, "failed", false],
      ["done", "failed", false], // 终态间互跳不产
      ["failed", "done", false],
      ["active", "pending", false],
      ["done", "active", false],
    ];
    for (const [prev, next, emit] of states) {
      expect(isEmittingTransition(prev, next), `${String(prev)}→${next}`).toBe(emit);
    }
  });
});

describe("批C1-1 D5 状态机推进（applyTrainNoticeTransitions）", () => {
  it("活跃→done 一跳：training_done 通知（id＝kind:run:时刻；text 单源文案）", () => {
    const out = applyTrainNoticeTransitions({ r1: "active" }, [{ run_id: "r1", state: "done" }], "2026-10-18T02:00:00.000Z");
    expect(out.next).toEqual({ r1: "done" });
    expect(out.notices).toEqual([{
      id: "train:training_done:r1:2026-10-18T02:00:00.000Z",
      kind: "training_done",
      run_id: "r1",
      at: "2026-10-18T02:00:00.000Z",
      text: TRAIN_NOTICE_TEXT.training_done,
    }]);
  });
  it("pending→failed 一跳：training_failed 通知（文案含只读指路）", () => {
    const out = applyTrainNoticeTransitions({ r1: "pending" }, [{ run_id: "r1", state: "failed" }], "t2");
    expect(out.notices[0]?.kind).toBe("training_failed");
    expect(out.notices[0]?.text).toContain("训练未完成退出");
    expect(out.notices[0]?.text).toContain("日志");
  });
  it("无跃迁周期零产出；终态→活跃（重训）→再终态＝新 id 再报", () => {
    const t1 = applyTrainNoticeTransitions({ r1: "done" }, [{ run_id: "r1", state: "done" }], "t1");
    expect(t1.notices).toEqual([]);
    const t2 = applyTrainNoticeTransitions({ r1: "done" }, [{ run_id: "r1", state: "active" }], "t2");
    expect(t2.notices).toEqual([]);
    const t3 = applyTrainNoticeTransitions({ r1: "active" }, [{ run_id: "r1", state: "done" }], "t3");
    expect(t3.notices[0]?.id).toBe("train:training_done:r1:t3");
  });
  it("多 run 混合：只有命中跃迁的 run 产通知；states 全量推进", () => {
    const out = applyTrainNoticeTransitions(
      { a: "active", b: "pending", c: "done" },
      [
        { run_id: "a", state: "done" },
        { run_id: "b", state: "pending" },
        { run_id: "c", state: "failed" },
        { run_id: "d", state: "done" },
      ],
      "now",
    );
    expect(out.notices.map((n) => n.run_id)).toEqual(["a"]);
    expect(out.next).toEqual({ a: "done", b: "pending", c: "failed", d: "done" });
  });
});

describe("批C1-1 D5 持久化（train-notice-state.json）", () => {
  it("写入→读回往返；通知账 per-run 截上限 8", () => {
    const root = tempRoot();
    const path = join(root, TRAIN_NOTICE_STATE_FILENAME);
    const notices = Array.from({ length: 10 }, (_, i) => ({
      id: `train:training_done:r1:t${i}`, kind: "training_done" as const, run_id: "r1",
      at: `t${i}`, text: TRAIN_NOTICE_TEXT.training_done,
    }));
    writeTrainNoticeState(path, { states: { r1: "done" }, notices: { r1: notices } });
    const back = readTrainNoticeState(path);
    expect(back.states).toEqual({ r1: "done" });
    expect(back.notices["r1"]).toHaveLength(TRAIN_NOTICE_LOG_CAP);
    expect(back.notices["r1"]?.[0]?.id).toBe("train:training_done:r1:t2");
  });
  it("坏文件/缺席＝空态重来（fail-closed：首见语义不重报）；坏 notice 行剔除", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const path = join(root, TRAIN_NOTICE_STATE_FILENAME);
    expect(readTrainNoticeState(path)).toEqual({ states: {}, notices: {} });
    writeFileSync(path, "{not json", "utf8");
    expect(readTrainNoticeState(path)).toEqual({ states: {}, notices: {} });
    writeFileSync(path, JSON.stringify({
      states: { r1: "done", r2: "bogus" },
      notices: { r1: [{ id: "x", kind: "training_done", run_id: "r1", at: "t", text: "s" }, null, 5] },
    }), "utf8");
    const back = readTrainNoticeState(path);
    expect(back.states).toEqual({ r1: "done" });
    expect(back.notices["r1"]).toHaveLength(1);
  });
  it("写盘裁剪：空账 run 不留键（文件体积有界）", () => {
    const root = tempRoot();
    const path = join(root, TRAIN_NOTICE_STATE_FILENAME);
    writeTrainNoticeState(path, { states: {}, notices: { r1: [] } });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { notices: Record<string, unknown> };
    expect(raw.notices).toEqual({});
  });
});
