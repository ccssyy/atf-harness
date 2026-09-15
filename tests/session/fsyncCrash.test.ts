import { spawn, execSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDigestResolver } from "../../src/core/session/digestResolver.js";
import { SessionLog } from "../../src/core/session/sessionLog.js";

/**
 * P2-S1 fsync 崩溃恢复测试（任务书 §2 设计要求 6–8 / 验收 4 / owner 口径 #4 / 决议四）。
 *
 * durability 契约按档（写入中途 SIGKILL → replay 校验确认点内事件无缺失、流结构完好）：
 * - 逐条档（默认）：确认点 = append 返回（ack ⇒ 已 fsync）——全部 acked ⊆ 落盘流；
 * - 批量档：确认点 = 刷盘水位线（攒满 N 条 / T 毫秒窗口 fsync）——水位线内事件 ⊆ 落盘流；
 *   水位线外已写入事件可能随进程终止丢失（性能档位的既定语义），但不产生半行/坏流。
 * 子进程经 dist 运行（vitest 不编译 TS），缺/旧则先 npm run build。
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const distEntry = join(repoRoot, "dist", "session", "index.js");
const fixturePath = join(repoRoot, "tests", "fixtures", "p2s1_fsync_child.mjs");
const srcMarker = join(repoRoot, "src", "session", "sessionLog.ts");

let built = false;
const ensureDist = async (): Promise<void> => {
  if (built) return;
  let stale = true;
  try {
    const dist = await stat(distEntry);
    const src = await stat(srcMarker);
    stale = dist.mtimeMs < src.mtimeMs;
  } catch {
    stale = true;
  }
  if (stale) execSync("npm run build", { cwd: repoRoot, stdio: "pipe" });
  built = true;
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-fsync-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface CrashRun {
  logPath: string;
  acked: number[];
  flushedWatermark: number;
  killed: boolean;
}

/** 启动子进程写入 count 条事件，收到 killAfterAcks 个 ack 后 SIGKILL。 */
const crashRun = (mode: "per-append" | "batch", count: number, killAfterAcks: number): Promise<CrashRun> =>
  new Promise((resolveRun, rejectRun) => {
    void (async () => {
      await ensureDist();
      const logPath = join(workDir, "session.jsonl");
      const child: ChildProcess = spawn(
        process.execPath,
        [fixturePath, distEntry, logPath, mode, String(count), "4", "30"],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      if (child.stdout === null) {
        rejectRun(new Error("子进程 stdout 缺失"));
        return;
      }
      const acked: number[] = [];
      let flushedWatermark = 0;
      let buffer = "";
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newlineAt = buffer.indexOf("\n");
        while (newlineAt !== -1) {
          const line = buffer.slice(0, newlineAt);
          buffer = buffer.slice(newlineAt + 1);
          try {
            const parsed = JSON.parse(line) as { acked?: number; flushed?: number };
            if (typeof parsed.acked === "number") acked.push(parsed.acked);
            if (typeof parsed.flushed === "number" && parsed.flushed > flushedWatermark) flushedWatermark = parsed.flushed;
          } catch {
            // 非法行忽略（kill 竞态下可能截断）
          }
          if (acked.length >= killAfterAcks && !child.killed) child.kill("SIGKILL");
          newlineAt = buffer.indexOf("\n");
        }
      });
      child.on("error", (cause) => {
        if (!settled) {
          settled = true;
          rejectRun(cause);
        }
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        resolveRun({ logPath, acked, flushedWatermark, killed: signal === "SIGKILL" });
      });
    })();
  });

const replayIdCount = async (logPath: string): Promise<number> => {
  const resolver = MockDigestResolver.withDigests([]);
  const replayed = await SessionLog.replay(logPath, resolver);
  expect(replayed.ok, `replay 失败: ${replayed.ok ? "" : JSON.stringify(replayed.error)}`).toBe(true);
  if (!replayed.ok) return 0;
  const events = replayed.value.events;
  expect(events.map((event) => event.id)).toEqual(Array.from({ length: events.length }, (_, i) => i + 1)); // id 连续，无半行损坏
  return events.length;
};

describe("fsync 崩溃恢复（写入中途 SIGKILL → replay 确认点内事件无缺失）", () => {
  it("逐条档（默认）：12 个 ack 后 kill——ack 过的事件全部在落盘流中", async () => {
    const run = await crashRun("per-append", 60, 12);
    expect(run.killed).toBe(true);
    expect(run.acked.length).toBeGreaterThanOrEqual(12);

    const durableCount = await replayIdCount(run.logPath);
    for (const ackedId of run.acked) {
      expect(ackedId).toBeLessThanOrEqual(durableCount); // ack ⇒ 已 fsync（durability 契约）
    }
  }, 30_000);

  it("批量档（N=4 / T=30ms）：8 个 ack 后 kill——刷盘水位线内事件全部在落盘流中", async () => {
    const run = await crashRun("batch", 60, 8);
    expect(run.killed).toBe(true);
    expect(run.acked.length).toBeGreaterThanOrEqual(8);
    expect(run.flushedWatermark).toBeGreaterThanOrEqual(4); // 至少完成过一次 N 阈值刷盘

    const durableCount = await replayIdCount(run.logPath);
    expect(durableCount).toBeGreaterThanOrEqual(run.flushedWatermark); // 水位线 ⇒ 已 fsync
  }, 30_000);
});

describe("fsync 双档写入时机（进程内，非 kill）", () => {
  it("逐条档：append 返回即已 fsync（无需 close/flush）", async () => {
    const logPath = join(workDir, "per-append.jsonl");
    const created = await SessionLog.create(logPath, MockDigestResolver.withDigests([]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const log = created.value;
    const first = await log.append({ type: "user/message", payload: { seq: 1 } });
    const second = await log.append({ type: "user/message", payload: { seq: 2 } });
    expect(first.ok && second.ok).toBe(true);
    expect(log.unsyncedEvents).toBe(0);

    const raw = await readFile(logPath, "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2);
    const closed = await log.close();
    expect(closed.ok).toBe(true);
  });

  it("批量档：ack 即已写入（不等窗口）；攒满 N 条即 fsync（水位线归零）；flush 补刷余量", async () => {
    const logPath = join(workDir, "batch-n.jsonl");
    const created = await SessionLog.create(logPath, MockDigestResolver.withDigests([]), {
      fsync: { mode: "batch", batchMaxEvents: 4, batchWindowMs: 60_000 }, // 窗口拉长：只验证 N 阈值路径
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const log = created.value;
    for (let i = 1; i <= 4; i += 1) {
      const appended = await log.append({ type: "user/message", payload: { seq: i } });
      expect(appended.ok).toBe(true); // ack 即返回（不等 60s 窗口）
    }
    expect(log.unsyncedEvents).toBe(0); // 第 4 条触发阈值 fsync，水位线归零

    await log.append({ type: "user/message", payload: { seq: 5 } });
    expect(log.unsyncedEvents).toBe(1); // 未达阈值，停留在已写入未刷盘态

    const flushed = await log.flush();
    expect(flushed.ok).toBe(true);
    expect(log.unsyncedEvents).toBe(0);

    const raw = await readFile(logPath, "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(5);
    const closed = await log.close();
    expect(closed.ok).toBe(true);
  });

  it("批量档：窗口到期（T=30ms）自动 fsync，水位线归零", async () => {
    const logPath = join(workDir, "batch-t.jsonl");
    const created = await SessionLog.create(logPath, MockDigestResolver.withDigests([]), {
      fsync: { mode: "batch", batchMaxEvents: 1024, batchWindowMs: 30 }, // 阈值抬高：只验证窗口路径
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const log = created.value;
    const appended = await log.append({ type: "user/message", payload: { seq: 1 } });
    expect(appended.ok).toBe(true);
    expect(log.unsyncedEvents).toBe(1);

    await vi.waitFor(() => expect(log.unsyncedEvents).toBe(0), { timeout: 2_000 }); // 窗口到期自动刷盘

    const raw = await readFile(logPath, "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1);
    const closed = await log.close();
    expect(closed.ok).toBe(true);
  });

  it("close 后 append 一律拒绝（fail-closed，不猜测写入成功）", async () => {
    const logPath = join(workDir, "closed.jsonl");
    const created = await SessionLog.create(logPath, MockDigestResolver.withDigests([]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const log = created.value;
    const closed = await log.close();
    expect(closed.ok).toBe(true);
    const afterClose = await log.append({ type: "user/message", payload: {} });
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.code).toBe("io_error");
  });
});

describe("kill 后注入半行尾（S1a 修复路径，决议 §3 测试 7）", () => {
  it.each(["per-append", "batch"] as const)("kill 后人为伪造未确认尾部 → replay 容忍 + create 截断留痕（%s）", async (mode) => {
    const run = await crashRun(mode, 30, 10);
    expect(run.killed).toBe(true);
    expect(run.acked.length).toBeGreaterThanOrEqual(10);

    // 人为注入半行尾（真实 SIGKILL 不产生残段，此处补齐该形态）
    const raw = await readFile(run.logPath, "utf8");
    const fragment = raw.endsWith("\n") ? '\n{"id":999,"ty' : '{"id":999,"ty';
    await appendFile(run.logPath, fragment, "utf8");

    const replayed = await SessionLog.replay(run.logPath, MockDigestResolver.withDigests([]));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.truncated_tail?.dropped_bytes).toBe(Buffer.byteLength(fragment, "utf8"));
    expect(replayed.value.events.length).toBeGreaterThanOrEqual(run.acked.length);

    // create 触发截断修复 + repair 留痕；修复后流干净可续写
    const reopened = await SessionLog.create(run.logPath, MockDigestResolver.withDigests([]));
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.truncatedTail).not.toBeNull();
    const finalReplay = await SessionLog.replay(run.logPath, MockDigestResolver.withDigests([]));
    expect(finalReplay.ok).toBe(true);
    if (!finalReplay.ok) return;
    expect(finalReplay.value.truncated_tail).toBeNull();
    expect(finalReplay.value.events.some((event) => event.type === "session/repair")).toBe(true);
  }, 30_000);
});
