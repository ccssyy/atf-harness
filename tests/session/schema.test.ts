import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDigestResolver } from "../../src/core/session/digestResolver.js";
import {
  SESSION_ENABLED_EVENT_TYPES,
  SESSION_EVENT_TYPES,
  SESSION_RESERVED_EVENT_TYPES,
  SESSION_SCHEMA_VERSION,
} from "../../src/core/session/schema.js";
import { SessionLog } from "../../src/core/session/sessionLog.js";

/**
 * schema 常量与白名单（v0 语义 owner 口径 #3 → P2-S1 bump v1：11 类一次定死 + 保留位拒写）
 * + projection 字段位、落盘流损坏 fail-closed、v0 → v1 迁移向后兼容。
 */

const DIGEST_A = "a".repeat(64);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-session-schema-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const logPath = (name = "session.jsonl"): string => join(workDir, name);
const resolver = MockDigestResolver.withDigests([
  { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
]);

const createAndWrite = async (lines: string[], path: string = logPath()): Promise<void> => {
  // 完整流语义:每行以 LF 结尾(S1a 起,无结尾 LF 的末段 = 未确认尾部,走容忍路径,
  // 属 tailRepair.test.ts 的管辖范围——本文件全部损坏用例均为 LF 结尾的完整行)
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
};

describe("schema v1 常量与白名单（P2-S3 启用位推进：12/12 全启用，保留位集合为空）", () => {
  it("白名单 12 类，启用 12 类（P2-S3 推进 11→12：provider/switch），保留位机制保留但集合为空，schema 版本仍 1", () => {
    expect(SESSION_SCHEMA_VERSION).toBe(1);
    expect(SESSION_EVENT_TYPES).toEqual([
      "user/message",
      "assistant/message",
      "assistant/attempt",
      "tool/call",
      "tool/result",
      "turn/start",
      "turn/end",
      "session/compaction",
      "session/repair",
      "approval/request",
      "approval/response",
      "provider/switch",
    ]);
    expect(SESSION_ENABLED_EVENT_TYPES).toEqual([
      "user/message",
      "assistant/message",
      "assistant/attempt",
      "tool/call",
      "tool/result",
      "turn/start",
      "turn/end",
      "session/compaction",
      "session/repair",
      "approval/request",
      "approval/response",
      "provider/switch",
    ]);
    // P2-S3 后保留位机制保留、集合为空（后续新增类型先进保留位）
    expect(SESSION_RESERVED_EVENT_TYPES).toEqual([]);
  });

  it("保留位拒绝写入机制保留（当前集合为空——循环空转即断言通过）+ provider/switch 已可写入", async () => {
    const path = logPath();
    const log = await SessionLog.create(path, resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;

    for (const reserved of SESSION_RESERVED_EVENT_TYPES) {
      const rejected = await log.append({ type: reserved, payload: {} });
      expect(rejected.ok, `${reserved} 应被拒绝`).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.code).toBe("schema_violation");
        expect(rejected.error.message).toContain("未启用");
        expect(rejected.error.message).toContain(reserved);
      }
    }

    // P2-S3 启用位推进：provider/switch 可写入（载荷形态由 runner/契约承载）
    const appended = await log.append({ type: "provider/switch", payload: { from: { provider_id: "faux" }, to: { provider_id: "faux-alt" }, boundary: { turn_index: 1, after_event_id: 1 } } });
    expect(appended.ok).toBe(true);

    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1); // 只有 switch 事件落盘
  });

  it("provider/switch 出现于落盘流 → replay 通过（P2-S3 启用位推进的向后兼容正例）", async () => {
    await createAndWrite([
      JSON.stringify({
        id: 1,
        ts: new Date().toISOString(),
        type: "provider/switch",
        payload: { from: { provider_id: "faux" }, to: { provider_id: "faux-alt" }, boundary: { turn_index: 1, after_event_id: 1 } },
        projection: { evidence_event: null },
      }),
    ]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.events).toHaveLength(1);
      expect(replayed.value.events[0]?.type).toBe("provider/switch");
    }
  });

  it("schema v1 迁移：v0 形态落盘流（7 类事件）可 replay——向后兼容，无需改写", async () => {
    const mk = (id: number, type: string): string =>
      JSON.stringify({ id, ts: new Date().toISOString(), type, payload: { v0: true }, projection: { evidence_event: null } });
    await createAndWrite([mk(1, "turn/start"), mk(2, "user/message"), mk(3, "assistant/message"), mk(4, "turn/end")]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.events.map((event) => event.type)).toEqual(["turn/start", "user/message", "assistant/message", "turn/end"]);
      expect(replayed.value.blocks).toEqual([]);
    }
  });

  it("未知 type 拒绝写入（owner 口径 #3）——err 且文件零增长", async () => {
    const path = logPath();
    const log = await SessionLog.create(path, resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;

    const rejected = await log.append({ type: "tool/call", payload: {} });
    expect(rejected.ok).toBe(true); // 合法类型先写入，确认文件可写
    const bogus = await log.append({ type: "agent/whim" as never, payload: {} });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) {
      expect(bogus.error.code).toBe("schema_violation");
      expect(bogus.error.message).toContain("agent/whim");
    }

    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1); // 只有第一条落盘
  });

  it("payload 缺失（undefined）拒绝写入——undefined 不是合法 JSON 值", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    const rejected = await log.append({ type: "user/message", payload: undefined });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("schema_violation");
  });

  it("domain_refs 语法非法（大写 hex / 位数不足 / 空字段）拒绝写入", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    for (const digest of ["A".repeat(64), "a".repeat(63), ""]) {
      const rejected = await log.append({
        type: "tool/result",
        payload: {},
        domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: digest }],
      });
      expect(rejected.ok, `digest ${JSON.stringify(digest)} 应被拒绝`).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("schema_violation");
    }
  });

  it("payload 含循环引用（不可序列化）→ err，不落盘", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const rejected = await log.append({ type: "user/message", payload: circular });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("schema_violation");
  });

  it("projection 字段位：append 产出的事件恒带 { evidence_event: null }（ADR-06 细则 3）", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    const appended = await log.append({ type: "turn/start", payload: {} });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.value.event.projection).toEqual({ evidence_event: null });

    const raw = JSON.parse((await readFile(logPath(), "utf8")).split("\n")[0] as string) as Record<string, unknown>;
    expect(raw["projection"]).toEqual({ evidence_event: null }); // 落盘形态同样必须带字段位
  });
});

describe("落盘流损坏（fail-closed：replay / 续写一律拒绝）", () => {
  it("坏 JSON 行 → replay err(corrupt_stream)", async () => {
    await createAndWrite(["{not json"]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");
  });

  it("白名单外 type 的落盘行 → replay err(schema_violation)（文件被篡改到结构不可信）", async () => {
    await createAndWrite([JSON.stringify({ id: 1, ts: new Date().toISOString(), type: "hacked/event", payload: {}, projection: { evidence_event: null } })]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("schema_violation");
  });

  it("projection.evidence_event 非 null → replay err(schema_violation)（Phase 3 前禁止提前激活）", async () => {
    await createAndWrite([
      JSON.stringify({ id: 1, ts: new Date().toISOString(), type: "turn/start", payload: {}, projection: { evidence_event: "evt-9" } }),
    ]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.error.code).toBe("schema_violation");
      expect(replayed.error.message).toContain("evidence_event");
    }
  });

  it("id 不连续 → replay err(corrupt_stream)", async () => {
    const mkEvent = (id: number): string =>
      JSON.stringify({ id, ts: new Date().toISOString(), type: "turn/start", payload: {}, projection: { evidence_event: null } });
    await createAndWrite([mkEvent(1), mkEvent(3)]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");
  });

  it("中间空行 → replay err(corrupt_stream)（严格 LF 分帧，与会话协议同口径）", async () => {
    const mkEvent = (id: number): string =>
      JSON.stringify({ id, ts: new Date().toISOString(), type: "user/message", payload: {}, projection: { evidence_event: null } });
    await createAndWrite([mkEvent(1), "", mkEvent(2)]);
    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");
  });

  it("末行残缺（崩溃半行：无结尾 LF）→ S1a 尾部策略：未确认尾部被容忍（replay 成功 + truncated_tail；详细用例见 tailRepair.test.ts）", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    await log.append({ type: "turn/start", payload: {} });
    await log.append({ type: "user/message", payload: { text: "hi" } });

    // 模拟崩溃：追加半行（JSON 前缀，无 LF）——从未被 ack 的残段，S1a 起容忍并丢弃
    const raw = await readFile(logPath(), "utf8");
    await writeFile(logPath(), `${raw}{"id":3,"ts":"2`, "utf8");

    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.events).toHaveLength(2);
      expect(replayed.value.truncated_tail).toEqual({ dropped_bytes: 15, dropped_from_offset: expect.any(Number) });
    }

    // 续写打开：截断修复 + repair 留痕（成对动作）
    const reopened = await SessionLog.create(logPath(), resolver);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.value.truncatedTail).not.toBeNull();
      const appended = await reopened.value.append({ type: "turn/end", payload: {} });
      expect(appended.ok).toBe(true);
      if (appended.ok) expect(appended.value.event.id).toBe(4); // repair 留痕占 id 3，新事件续接
    }
  });

  it("不存在的文件 → replay err(io_error)；空文件 → ok 空序列", async () => {
    const missing = await SessionLog.replay(logPath("missing.jsonl"), resolver);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("io_error");

    const emptyPath = logPath("empty.jsonl");
    await writeFile(emptyPath, "", "utf8");
    const empty = await SessionLog.replay(emptyPath, resolver);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual({ events: [], blocks: [], truncated_tail: null });
  });

  it("父目录不存在 → create 自动建目录；续写打开从既有尾部 id 续接", async () => {
    const nested = join(workDir, "runs", "run-1", "session.jsonl");
    const log = await SessionLog.create(nested, resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    await log.append({ type: "turn/start", payload: {} });
    await log.append({ type: "turn/end", payload: {} });

    const reopened = await SessionLog.create(nested, resolver).then((r) => (r.ok ? r.value : undefined));
    expect(reopened).toBeDefined();
    if (reopened === undefined) return;
    const appended = await reopened.append({ type: "user/message", payload: {} });
    expect(appended.ok).toBe(true);
    if (appended.ok) expect(appended.value.event.id).toBe(3);

    expect((await stat(nested)).isFile()).toBe(true);
  });
});
