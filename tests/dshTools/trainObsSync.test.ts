// 批㊶-TRAIN-OBS S6——训练观测环测试（真实 trainer_log 样本行＋fail-closed 三锚＋边界＋投影三同步）。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProgressFromTrainerLog,
  formatEta,
  formatProgressDetail,
  parseRemainingTimeSeconds,
  parseTrainerLogLine,
  readProgress,
  readTrainerLogTail,
  trainerLogPathOf,
  writeProgress,
} from "../../src/core/workspace/runFacts.js";
import {
  readTrainlogTail,
  resetTrainObsForTest,
  TRAINLOG_TAIL_MAX_LINE_CHARS,
  TRAINLOG_TAIL_MAX_LINES,
  TRAIN_OBS_STALE_ROUNDS,
  trainObsRunning,
  trainObsTick,
  truncateCaptureLines,
} from "../../src/core/workspace/trainObsSync.js";
import { scanRunDir } from "../../packages/extensions/atf-ui/src/server.js";
import { buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "train-obs-"));
  tempRoots.push(root);
  return root;
};
beforeEach(() => resetTrainObsForTest());
afterEach(() => {
  resetTrainObsForTest();
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

// A800 现网真实样本行（run-regress-formal-01 trainer_log.jsonl 首行/末行——非玩具数据）
const REAL_LINE = '{"current_steps": 2, "total_steps": 141, "loss": 0.6885, "lr": 7.142857142857143e-06, "epoch": 0.0431266846361186, "percentage": 1.42, "elapsed_time": "0:02:16", "remaining_time": "2:37:53"}';
const REAL_TERMINAL_LINE = '{"current_steps": 141, "total_steps": 141, "epoch": 3.0, "percentage": 100.0, "elapsed_time": "2:03:34", "remaining_time": "0:00:00"}';

const seedRun = (root: string, runId: string, logLines: string[]): string => {
  const runDir = join(root, runId);
  mkdirSync(join(runDir, "training"), { recursive: true });
  writeFileSync(join(runDir, "training", "trainer_log.jsonl"), logLines.join("\n") + "\n", "utf8");
  return runDir;
};

describe("批㊶-TRAIN-OBS 时间换算与显示（T2 缺数不占位）", () => {
  it("parseRemainingTimeSeconds：真实样本 2:37:53→9473；MM:SS 形态；非法形态/越界分秒 → null", () => {
    expect(parseRemainingTimeSeconds("2:37:53")).toBe(9473);
    expect(parseRemainingTimeSeconds("0:00:00")).toBe(0);
    expect(parseRemainingTimeSeconds("42:51")).toBe(2571);
    expect(parseRemainingTimeSeconds("1:01:01")).toBe(3661);
    expect(parseRemainingTimeSeconds("12:75")).toBeNull();
    expect(parseRemainingTimeSeconds("abc")).toBeNull();
    expect(parseRemainingTimeSeconds("")).toBeNull();
  });
  it("formatEta：>1h H:MM:SS／否则 MM:SS／非有限数 null", () => {
    expect(formatEta(9473)).toBe("2:37:53");
    expect(formatEta(2571)).toBe("42:51");
    expect(formatEta(0)).toBe("00:00");
    expect(formatEta(undefined)).toBeNull();
    expect(formatEta(Number.NaN)).toBeNull();
  });
  it("formatProgressDetail：percentage＋eta additive（缺 eta 只显示百分比——不占位不显示 null）", () => {
    const withEta = formatProgressDetail({ percentage: 42.3, eta_s: 2571, updated_at: "" });
    expect(withEta).toBe("42.3% · 预计剩 42:51");
    const noEta = formatProgressDetail({ percentage: 42.3, updated_at: "" });
    expect(noEta).toBe("42.3%");
    expect(noEta).not.toContain("null");
  });
  it("buildProgressFromTrainerLog：真实样本行→percentage/eta_s/step_remaining 全量", () => {
    const tail = parseTrainerLogLine(REAL_LINE);
    expect(tail).not.toBeNull();
    const p = buildProgressFromTrainerLog(tail!, null, "n");
    expect(p.percentage).toBe(1.42);
    expect(p.eta_s).toBe(9473);
    expect(p.step_remaining).toBe(139);
    expect(p.loss).toBe(0.6885);
  });
});

describe("批㊶-TRAIN-OBS T1 状态机（fail-closed 三锚＋12 轮 stale＋终态停环＋防双开）", () => {
  it("fail-closed 锚①文件缺：readTail null → 本轮 skip 不写不抛；计数累进", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-miss");
    mkdirSync(runDir, { recursive: true });
    const r1 = await trainObsTick("r1", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r1).toBe("skipped");
    expect(existsSync(join(runDir, "webui", "progress.json"))).toBe(false); // 不写
    const r2 = await trainObsTick("r1", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r2).toBe("skipped"); // 环不崩
  });
  it("fail-closed 锚②坏行：末行非 JSON → skip（写侧零触碰）；锚③字段缺：缺 percentage → skip", async () => {
    const root = tempRoot();
    const runDir = seedRun(root, "run-bad", ["not-json-at-all"]);
    const r = await trainObsTick("run-bad", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r).toBe("skipped");
    const runDir2 = seedRun(root, "run-missing", ['{"current_steps": 1}']); // 缺必填 total/percentage
    const r2 = await trainObsTick("run-missing", runDir2, null, { capture: async () => null, sessionName: () => null });
    expect(r2).toBe("skipped");
    expect(existsSync(join(runDir2, "webui", "progress.json"))).toBe(false);
  });
  it("真实样本行：有效轮写 progress.json（percentage/eta_s/step_remaining）且计数归零", async () => {
    const root = tempRoot();
    const runDir = seedRun(root, "run-ok", [REAL_LINE]);
    await trainObsTick("run-ok", runDir, null, { capture: async () => null, sessionName: () => null }); // miss 1
    const r = await trainObsTick("run-ok", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r).toBe("written");
    const p = readProgress(runDir);
    expect(p?.percentage).toBe(1.42);
    expect(p?.eta_s).toBe(9473);
    expect(p?.stale).toBeUndefined();
  });
  it("R1-b 修正：曾读有效行后 12 轮 miss → stale 写一次（不设 stopped 允许复活）；模型加载窗（首有效行前）不判 stale", async () => {
    // 场景 1：模型加载窗——trainer_log 缺席（首有效行前不判 stale＝misses 不起算）
    const loadRoot = tempRoot();
    const loadDir = join(loadRoot, "run-load");
    mkdirSync(loadDir, { recursive: true });
    for (let i = 0; i < 20; i++) {
      const r = await trainObsTick("run-load", loadDir, null, { capture: async () => null, sessionName: () => null });
      expect(r).toBe("skipped"); // 加载窗 20 轮全 skip——远超 12 轮阈不触发 stale
    }
    expect(existsSync(join(loadDir, "webui", "progress.json"))).toBe(false); // 加载窗零写

    // 场景 2：曾读有效行后 12 轮 miss → stale 写一次
    const root2 = tempRoot();
    const runDir2 = join(root2, "run-stale");
    mkdirSync(join(runDir2, "training"), { recursive: true });
    // 先放一行有效数据让 seenValid=true，然后删掉文件模拟账本损坏
    writeFileSync(join(runDir2, "training", "trainer_log.jsonl"), '{"current_steps": 4, "total_steps": 40, "loss": 0.3, "epoch": 1, "percentage": 10.0, "remaining_time": "0:01:00"}\n');
    await trainObsTick("run-stale2", runDir2, null, { capture: async () => null, sessionName: () => null }); // seenValid=true
    rmSync(join(runDir2, "training", "trainer_log.jsonl")); // 账本损坏 → tail=null → miss
    const stubWrite = { written: 0 };
    let result = "";
    for (let i = 0; i < TRAIN_OBS_STALE_ROUNDS; i++) {
      result = await trainObsTick("run-stale2", runDir2, null, {
        capture: async () => null,
        sessionName: () => null,
        writeProg: (d, p) => { stubWrite.written += 1; writeProgress(d, p); },
      });
    }
    expect(result).toBe("stale-stopped");
    const p = readProgress(runDir2);
    expect(p?.stale).toBe(true);
    expect(stubWrite.written).toBe(1); // stale 写恰一次
    // 复活路径：stale 后 trainer_log 新行出现 → 新有效行 → 写复写 stale 标记
    writeFileSync(join(runDir2, "training", "trainer_log.jsonl"), '{"current_steps": 8, "total_steps": 40, "loss": 0.2, "epoch": 2, "percentage": 20.0, "remaining_time": "0:00:40"}\n');
    const revived = await trainObsTick("run-stale2", runDir2, null, {
      capture: async () => null,
      sessionName: () => null,
      writeProg: (d, pp) => { stubWrite.written += 1; writeProgress(d, pp); },
    });
    expect(revived).toBe("written"); // 复活——不返回 already-stopped
    const revivedProgress = readProgress(runDir2);
    expect(revivedProgress?.stale).toBeUndefined(); // stale 标记被新有效行覆盖清除
    expect(revivedProgress?.percentage).toBe(20);
  });
  it("终态停环：真实终态行（percentage 100 缺 loss）→ 写一次后停环（真实终态行可解析）", async () => {
    const root = tempRoot();
    const runDir = seedRun(root, "run-fin", [REAL_LINE, REAL_TERMINAL_LINE]);
    const r = await trainObsTick("run-fin", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r).toBe("finished-stopped");
    const p = readProgress(runDir);
    expect(p?.percentage).toBe(100);
    expect(p?.eta_s).toBe(0);
    expect(await trainObsTick("run-fin", runDir, null, { capture: async () => null, sessionName: () => null })).toBe("already-stopped");
  });
  it("D50 补：终态 tick 同点落 completion.json（status ok＋training 段事实——launch 链无 exit.code 尾声也收口）", async () => {
    const root = tempRoot();
    const runDir = seedRun(root, "run-d50", [REAL_LINE, REAL_TERMINAL_LINE]);
    mkdirSync(join(runDir, "prep", "iteration-config", "checkpoint-2"), { recursive: true }); // walkthrough 布局 checkpoint
    const r = await trainObsTick("run-d50", runDir, null, { capture: async () => null, sessionName: () => null });
    expect(r).toBe("finished-stopped");
    const { readTrainingCompletion } = await import("../../src/core/workspace/trainingCompletion.js");
    const { readSegmentFacts } = await import("../../src/core/workspace/segmentFacts.js");
    const completion = readTrainingCompletion(runDir);
    expect(completion?.status).toBe("ok");
    expect(completion?.exit_code).toBeNull(); // 无尾声件＝如实 null（launch 链形态）
    expect(completion?.checkpoint).toBe("checkpoint-2");
    expect(readSegmentFacts(runDir).some((f) => f.segment === "training" && f.source === "atf_run_training")).toBe(true);
    // 幂等：终态后复 tick（already-stopped）不重复写
    expect(await trainObsTick("run-d50", runDir, null, { capture: async () => null, sessionName: () => null })).toBe("already-stopped");
  });
});

describe("批㊶-TRAIN-OBS T3 日志尾部（capture 截断边界＋原子投影写）", () => {
  it("truncateCaptureLines：40 行封顶＋单行 200 字符截断", () => {
    const longLine = "x".repeat(500);
    const raw = Array.from({ length: 60 }, (_, i) => (i === 0 ? longLine : `line-${i}`)).join("\n");
    const lines = truncateCaptureLines(raw);
    expect(lines).toHaveLength(TRAINLOG_TAIL_MAX_LINES);
    expect(lines[0]!.length).toBe(TRAINLOG_TAIL_MAX_LINE_CHARS + 1); // 200 字符＋省略号
    expect(lines[0]!.startsWith("x")).toBe(true);
    expect(lines[39]).toBe("line-39");
    expect(lines.length).toBeLessThanOrEqual(40);
  });
  it("capture 成功 → trainlog.tail.json 两键闭集原子落盘（无 .tmp 残留）；失败 null → 缺席不伪造", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-cap");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_log.jsonl"), REAL_LINE + "\n");
    await trainObsTick("run-cap", runDir, null, {
      capture: async () => truncateCaptureLines("step 1/4\nloss 0.5\nstep 2/4\n"),
      sessionName: () => "dev-atf-training-run-run-cap",
    });
    const tail = readTrainlogTail(runDir);
    expect(tail).not.toBeNull();
    expect(Object.keys(tail ?? {}).sort()).toEqual(["captured_at", "lines"]);
    expect(tail?.lines).toEqual(["step 1/4", "loss 0.5", "step 2/4"]);
    const dirEntries = readdirSync(join(runDir, "webui"));
    expect(dirEntries.some((f) => f.endsWith(".tmp"))).toBe(false); // 原子写无残留
    // capture 失败（会话被杀）→ 既有 tail 保留（不伪造不删除）
    await trainObsTick("run-cap", runDir, null, { capture: async () => null, sessionName: () => "dev-atf-training-run-run-cap" });
    expect(readTrainlogTail(runDir)).not.toBeNull();
  });
  it("原子写：writeProgress 后 webui 目录无 .tmp 残留（tmp+rename 纪律）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-atomic");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeProgress(runDir, { percentage: 1, updated_at: "n" });
    expect(readdirSync(join(runDir, "webui")).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("批㊶-TRAIN-OBS 投影三同步（trainlog_tail：adapter 白名单＋摘要化＋投影用例）", () => {
  it("scanRunDir→monitor：trainlog_tail 两键闭集投影；缺席 null（形态稳定）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-proj");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "trainlog.tail.json"), JSON.stringify({ captured_at: "2026-10-14T01:00:00Z", lines: ["step 1/4", "x".repeat(300)] }));
    const scan = scanRunDir(root, "run-proj");
    expect(Object.keys(scan.trainlog_tail ?? {}).sort()).toEqual(["captured_at", "lines"]);
    expect(scan.trainlog_tail?.lines).toHaveLength(2);
    expect(scan.trainlog_tail?.lines[1]!.length).toBe(TRAINLOG_TAIL_MAX_LINE_CHARS + 1); // 摘要化截断
    const snap = buildMonitorSnapshot([scan], { offline: true });
    expect(snap.runs[0]?.trainlog_tail).toMatchObject({ captured_at: "2026-10-14T01:00:00Z" });
    // 缺席 run：null（形态稳定——client 回退不渲染）
    const bare = scanRunDir(root, "run-bare");
    expect(bare.trainlog_tail).toBeNull();
    expect(buildMonitorSnapshot([bare], { offline: true }).runs[0]?.trainlog_tail).toBeNull();
  });
});

describe("D27——trainer_log 双拓扑发现（training/ ＞ prep/iteration-config/）", () => {
  const seedPrepRun = (root: string, runId: string, logLines: string[]): string => {
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "trainer_log.jsonl"), logLines.join("\n") + "\n", "utf8");
    return runDir;
  };

  it("trainerLogPathOf：两路俱缺＝null；training/ 在场优先；仅 prep 拓扑兜底发现", () => {
    const root = tempRoot();
    const bare = join(root, "run-bare");
    mkdirSync(bare, { recursive: true });
    expect(trainerLogPathOf(bare)).toBeNull();
    const dual = seedRun(root, "run-dual", [REAL_LINE]);
    seedPrepRun(root, "run-dual", ['{"current_steps": 5, "total_steps": 10, "percentage": 50.0}']);
    expect(trainerLogPathOf(dual)).toBe(join(dual, "training", "trainer_log.jsonl"));
    const prepOnly = seedPrepRun(root, "run-prep-only", [REAL_LINE]);
    expect(trainerLogPathOf(prepOnly)).toBe(join(prepOnly, "prep", "iteration-config", "trainer_log.jsonl"));
  });

  it("walkthrough prep 拓扑 progress 有数：仅 prep/iteration-config/trainer_log → written＋percentage/eta_s", async () => {
    const root = tempRoot();
    const runDir = seedPrepRun(root, "run-prep", ['{"current_steps": 4, "total_steps": 10, "loss": 0.71, "epoch": 0.4, "percentage": 40.0, "elapsed_time": "0:01:00", "remaining_time": "0:02:00"}']);
    const result = await trainObsTick("run-prep", runDir, null);
    expect(result).toBe("written");
    const progress = readProgress(runDir);
    expect(progress).not.toBeNull();
    expect(progress?.percentage).toBe(40);
    expect(progress?.eta_s).toBe(120);
    expect(readTrainerLogTail(runDir)?.percentage).toBe(40);
  });

  it("双拓扑并存：training/ 在场优先（读训练段日志，prep 旧值不串）", async () => {
    const root = tempRoot();
    const runDir = seedRun(root, "run-both", [REAL_LINE]); // percentage 1.42
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "trainer_log.jsonl"), '{"current_steps": 9, "total_steps": 10, "percentage": 90.0}\n', "utf8");
    const result = await trainObsTick("run-both", runDir, null);
    expect(result).toBe("written");
    expect(readProgress(runDir)?.percentage).toBe(1.42);
  });
});
