/**
 * D50（门 2 收口）——training 段事实＋完成锚测试锚。
 *
 * 覆盖：completion.json 读写形态／status ok → 段事实登记（canonical segments 含
 * training）／status failed → 不登记（不伪装完成）／首写者胜＋重训覆写（新 started
 * 晚于旧 finished）／exit.code 尾声件 → completionFromExitCodeFile 组装（真退出码）／
 * latestCheckpointOf 双拓扑（training/＋prep/iteration-config/——walkthrough 布局）。
 * UI 链收口（scanRunDir 消费）锚在 tests/dshUi/atfUi.test.ts D50 组。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completionFromExitCodeFile,
  latestCheckpointOf,
  readTrainingCompletion,
  readTrainingExitCode,
  readTrainingStartedAt,
  TRAINING_COMPLETION_REL,
  TRAINING_EXIT_CODE_REL,
  writeTrainingCompletion,
  writeTrainingStartedAt,
} from "../../../src/core/workspace/trainingCompletion.js";
import { readSegmentFacts } from "../../../src/core/workspace/segmentFacts.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "zz-d50-completion-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("D50——training/completion.json 完成锚", () => {
  it("status ok → completion.json 落盘（键集闭集）＋ canonical segments 含 training 段事实（source=atf_run_training）", () => {
    const runDir = tempRoot();
    const wrote = writeTrainingCompletion(runDir, {
      status: "ok", exit_code: 0, checkpoint: "checkpoint-6",
      started: "2026-10-22T01:08:57.000Z", finished: "2026-10-22T01:24:00.000Z",
    });
    expect(wrote).toBe(true);
    const completion = readTrainingCompletion(join(runDir));
    expect(completion).toEqual({
      status: "ok", exit_code: 0, checkpoint: "checkpoint-6",
      started: "2026-10-22T01:08:57.000Z", finished: "2026-10-22T01:24:00.000Z",
    });
    const facts = readSegmentFacts(runDir);
    expect(facts.some((fact) => fact.segment === "training" && fact.source === "atf_run_training")).toBe(true);
  });
  it("status failed → completion.json 落盘但 training 段事实不登记（不伪装完成）", () => {
    const runDir = tempRoot();
    writeTrainingCompletion(runDir, {
      status: "failed", exit_code: 78, checkpoint: null,
      started: "2026-10-22T02:00:00.000Z", finished: "2026-10-22T02:01:00.000Z",
    });
    expect(readTrainingCompletion(runDir)?.status).toBe("failed");
    expect(readSegmentFacts(runDir).some((fact) => fact.segment === "training")).toBe(false);
  });
  it("首写者胜（既有 completion 不被旧信息覆写）＋重训新尝试收尾覆写（新 started 晚于旧 finished）", () => {
    const runDir = tempRoot();
    writeTrainingCompletion(runDir, { status: "ok", exit_code: 0, checkpoint: "checkpoint-6", started: "2026-10-22T01:00:00.000Z", finished: "2026-10-22T01:20:00.000Z" });
    // 旧 started 的迟到写者（早于既有 finished）——不覆写
    expect(writeTrainingCompletion(runDir, { status: "failed", exit_code: 1, checkpoint: null, started: "2026-10-22T00:30:00.000Z", finished: "2026-10-22T00:31:00.000Z" })).toBe(false);
    expect(readTrainingCompletion(runDir)?.status).toBe("ok");
    // 重训新尝试（started 晚于旧 finished）收尾——覆写是如实语义
    expect(writeTrainingCompletion(runDir, { status: "failed", exit_code: 1, checkpoint: "checkpoint-3", started: "2026-10-22T03:00:00.000Z", finished: "2026-10-22T03:10:00.000Z" })).toBe(true);
    expect(readTrainingCompletion(runDir)?.status).toBe("failed");
    expect(readTrainingCompletion(runDir)?.checkpoint).toBe("checkpoint-3");
  });
  it("exit.code 尾声件 → completionFromExitCodeFile 权威组装（0=ok 非 0=failed；checkpoint 双拓扑取最大编号；started/finished 自配套件）", () => {
    const runDir = tempRoot();
    // walkthrough 布局：checkpoint 落 prep/iteration-config（双拓扑——training/ 无）
    mkdirSync(join(runDir, "prep", "iteration-config", "checkpoint-5"), { recursive: true });
    mkdirSync(join(runDir, "prep", "iteration-config", "checkpoint-6"), { recursive: true });
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeTrainingStartedAt(runDir, "2026-10-22T01:08:57.000Z");
    writeFileSync(join(runDir, TRAINING_EXIT_CODE_REL), "0", "utf8");
    expect(readTrainingExitCode(runDir)).toBe(0);
    const completion = completionFromExitCodeFile(runDir);
    expect(completion?.status).toBe("ok");
    expect(completion?.exit_code).toBe(0);
    expect(completion?.checkpoint).toBe("checkpoint-6");
    expect(completion?.started).toBe("2026-10-22T01:08:57.000Z");
    expect(completion?.finished).not.toBeNull();
    // 非 0 退出码 → failed
    writeFileSync(join(runDir, TRAINING_EXIT_CODE_REL), "1", "utf8");
    const failed = completionFromExitCodeFile(runDir);
    expect(failed?.status).toBe("failed");
    expect(failed?.exit_code).toBe(1);
    // training/ 侧 checkpoint 与 prep 侧并存 → 最大编号胜
    mkdirSync(join(runDir, "training", "checkpoint-9"), { recursive: true });
    expect(latestCheckpointOf(runDir)).toBe("checkpoint-9");
    // 尾声件缺席 → null（不猜）
    const empty = tempRoot();
    expect(completionFromExitCodeFile(empty)).toBeNull();
    expect(readTrainingStartedAt(empty)).toBeNull();
    expect(readTrainingCompletion(empty)).toBeNull();
  });
  it("坏形态 fail-closed：坏 JSON completion → null；exit.code 非整数 → null", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, TRAINING_COMPLETION_REL), "{not json", "utf8");
    expect(readTrainingCompletion(runDir)).toBeNull();
    writeFileSync(join(runDir, TRAINING_EXIT_CODE_REL), "abc", "utf8");
    expect(readTrainingExitCode(runDir)).toBeNull();
    // 坏 completion 在场 → 写方仍可落（read null＝不在场语义，首写者胜不误吞）
    expect(writeTrainingCompletion(runDir, { status: "ok", exit_code: 0, checkpoint: null, started: null, finished: "2026-10-22T04:00:00.000Z" })).toBe(true);
  });
  it("finished 取尾声件 mtime（进程退出时刻≈尾声落盘时刻）", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, TRAINING_EXIT_CODE_REL), "0", "utf8");
    const stamp = new Date("2026-10-22T01:24:19.000Z");
    utimesSync(join(runDir, TRAINING_EXIT_CODE_REL), stamp, stamp);
    expect(completionFromExitCodeFile(runDir)?.finished).toBe("2026-10-22T01:24:19.000Z");
  });
});
