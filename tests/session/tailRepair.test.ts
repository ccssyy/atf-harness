import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { err } from "../../src/bridge/index.js";
import { sessionError } from "../../src/core/session/errors.js";
import { MockDigestResolver } from "../../src/core/session/digestResolver.js";
import { SessionLog } from "../../src/core/session/sessionLog.js";
import { planCompaction, transformContext, type SessionEvent, type SessionEventType } from "../../src/core/session/index.js";

/**
 * S1a 尾部半行策略测试（决议 §2.1 七条 / §3 新增测试 1–5）：
 * 未确认尾部容忍 + 截断留痕成对（session/repair）、位置纪律（中间损坏仍 fail-closed）、
 * repair 对压缩计划/投影透明。
 */

const resolver = MockDigestResolver.withDigests([]);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-tail-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

/** 建一条 N 个完整事件的流（逐条 fsync），返回路径。 */
const seedLog = async (name: string, count: number): Promise<string> => {
  const path = join(workDir, name);
  const created = await SessionLog.create(path, resolver);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  for (let i = 1; i <= count; i += 1) {
    const appended = await created.value.append({ type: "user/message", payload: { seq: i } });
    expect(appended.ok).toBe(true);
  }
  const closed = await created.value.close();
  expect(closed.ok).toBe(true);
  return path;
};

describe("伪造半行尾（容忍 + replay 报告 + create 截断续写）", () => {
  it("向量 \\n{id:13,ty：replay 成功、truncated_tail 非空、丢弃字节数正确；create 截断续写后流 id 连续无残留坏行", async () => {
    const path = await seedLog("half.jsonl", 12);
    await appendFile(path, '\n{"id":13,"ty', "utf8");

    // replay：只读容忍——成功 + truncated_tail 报告；文件不动
    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.events.map((event) => event.id)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(replayed.value.truncated_tail).not.toBeNull();
    expect(replayed.value.truncated_tail?.dropped_bytes).toBe(13); // '\n{"id":13,"ty' 全长（含紧邻空行）
    expect(replayed.value.truncated_tail?.dropped_from_offset).toBeGreaterThan(0);
    const rawAfterReplay = await readFile(path, "utf8");
    expect(rawAfterReplay.endsWith('{"id":13,"ty')).toBe(true); // replay 不改写文件

    // create：先物理截断 + repair 留痕（成对），再可续写
    const reopened = await SessionLog.create(path, resolver);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.truncatedTail).toEqual(replayed.value.truncated_tail);

    const appended = await reopened.value.append({ type: "turn/end", payload: {} });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const finalReplay = await SessionLog.replay(path, resolver);
    expect(finalReplay.ok).toBe(true);
    if (!finalReplay.ok) return;
    // 流内：12 主事件 + repair(13) + turn/end(14)——id 连续、无残留坏行、无残段
    expect(finalReplay.value.events.map((event) => event.id)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(finalReplay.value.truncated_tail).toBeNull();
    const repair = finalReplay.value.events[12];
    expect(repair?.type).toBe("session/repair");
    expect(repair?.payload).toMatchObject({
      dropped_bytes: 13,
      tail_excerpt: '\n{"id":13,"ty',
    });
  });

  it("更短残段（半个字段 {\"i）：同策略容忍 + 修复", async () => {
    const path = await seedLog("shorter.jsonl", 3);
    await appendFile(path, '{"i', "utf8");

    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.truncated_tail?.dropped_bytes).toBe(3);

    const reopened = await SessionLog.create(path, resolver);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const appended = await reopened.value.append({ type: "turn/end", payload: {} });
    expect(appended.ok).toBe(true);
    const finalReplay = await SessionLog.replay(path, resolver);
    expect(finalReplay.ok).toBe(true);
    if (!finalReplay.ok) return;
    expect(finalReplay.value.events.map((event) => event.id)).toEqual([1, 2, 3, 4, 5]); // repair=4, turn/end=5
    expect(finalReplay.value.events[3]?.type).toBe("session/repair");
  });
});

describe("位置纪律（容忍不越界到中间）", () => {
  it("中间第 5 行改为非法 JSON（保留 LF）→ 仍 corrupt_stream", async () => {
    const path = await seedLog("mid.jsonl", 6);
    const raw = (await readFile(path, "utf8")).split("\n");
    raw[4] = "{not json"; // 第 5 行（保留行结构，LF 未动）
    await writeFile(path, raw.join("\n"), "utf8");

    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");

    const reopened = await SessionLog.create(path, resolver);
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.error.code).toBe("corrupt_stream");
  });

  it("完整行坏 JSON 位于流末（以 LF 结尾）→ 仍 corrupt_stream（完成行不属未确认尾部）", async () => {
    const path = await seedLog("tailfull.jsonl", 2);
    await appendFile(path, '{broken\n', "utf8"); // 以 LF 结尾 = 完成行，不属于容忍范围
    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");
  });
});

describe("repair 留痕成对性", () => {
  it("payload 四字段齐备且值正确（dropped_bytes / dropped_from_offset / tail_excerpt / tail_sha256）", async () => {
    const path = await seedLog("audit.jsonl", 4);
    const fragment = '{"id":5,"pa';
    await appendFile(path, fragment, "utf8");

    const reopened = await SessionLog.create(path, resolver);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    const repair = replayed.value.events[4];
    expect(repair?.type).toBe("session/repair");
    const payload = repair?.payload as Record<string, unknown>;
    expect(payload["dropped_bytes"]).toBe(Buffer.byteLength(fragment, "utf8"));
    expect(typeof payload["dropped_from_offset"]).toBe("number");
    expect(payload["dropped_from_offset"]).toBeGreaterThan(0);
    expect(payload["tail_excerpt"]).toBe(fragment);
    expect(payload["tail_sha256"]).toBe(createHash("sha256").update(fragment, "utf8").digest("hex"));
  });

  it("留痕写失败 → 修复失败上报（fail-closed）：create err，文件已截断但无 repair 事件", async () => {
    const path = await seedLog("failpair.jsonl", 3);
    await appendFile(path, '{"id":4,"pa', "utf8");

    const appendSpy = vi.spyOn(SessionLog.prototype, "append").mockResolvedValueOnce(
      err(sessionError("io_error", "注入：留痕写失败")),
    );
    const reopened = await SessionLog.create(path, resolver);
    expect(appendSpy).toHaveBeenCalledTimes(1); // 该次 append 即 repair 留痕
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) {
      expect(reopened.error.code).toBe("io_error");
      expect(reopened.error.message).toContain("留痕");
    }

    // 物理截断已发生（前缀完好、残段已除），但无 repair 事件——上报由上层处置
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain('{"id":4,"pa');
    const replayed = await SessionLog.replay(path, resolver);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.events).toHaveLength(3);
      expect(replayed.value.events.some((event) => event.type === "session/repair")).toBe(false);
    }
  });
});

describe("repair 对压缩计划/投影透明", () => {
  const buildBase = (): SessionEvent[] => {
    let seq = 0;
    const ev = (type: SessionEventType, payload: unknown): SessionEvent => ({
      id: ++seq,
      ts: "2026-09-10T00:00:00.000Z",
      type,
      payload,
      projection: { evidence_event: null },
    });
    const base: SessionEvent[] = [];
    for (let i = 0; i < 130; i += 1) base.push(ev("user/message", { seq: i }));
    return base;
  };

  it("含 session/repair 的序列与不含的序列，压缩计划与投影逐条一致", () => {
    const base = buildBase();
    const fakeRepair: SessionEvent = {
      id: 131,
      ts: "2026-09-10T00:00:01.000Z",
      type: "session/repair",
      payload: { dropped_bytes: 12, dropped_from_offset: 4096, tail_excerpt: '{"id":131,"ty', tail_sha256: "f".repeat(64) },
      projection: { evidence_event: null },
    };

    expect(planCompaction([...base, fakeRepair])).toEqual(planCompaction(base));
    expect(transformContext([...base, fakeRepair])).toEqual(transformContext(base));
    expect(transformContext(base).some((item) => item.id === 131)).toBe(false); // 不进入投影
  });
});
