import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDigestResolver } from "../../src/session/digestResolver.js";
import { SESSION_EVENT_TYPES, SESSION_SCHEMA_VERSION } from "../../src/session/schema.js";
import { SessionLog } from "../../src/session/sessionLog.js";

/**
 * S2 补充语义——schema v0 白名单（owner 口径 #3）、projection 字段位、落盘流损坏 fail-closed。
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

describe("schema v0 常量与白名单", () => {
  it("白名单恰好 7 类（任务书 S2-1），schema 版本 0", () => {
    expect(SESSION_SCHEMA_VERSION).toBe(0);
    expect(SESSION_EVENT_TYPES).toEqual([
      "user/message",
      "assistant/message",
      "assistant/attempt",
      "tool/call",
      "tool/result",
      "turn/start",
      "turn/end",
    ]);
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
  const createAndWrite = async (lines: string[], path = logPath()): Promise<void> => {
    await writeFile(path, lines.join("\n"), "utf8");
  };

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

  it("末行残缺（崩溃半行：无结尾 LF）→ replay 与续写打开一律 err(corrupt_stream)，不猜测", async () => {
    const log = await SessionLog.create(logPath(), resolver).then((r) => (r.ok ? r.value : undefined));
    expect(log).toBeDefined();
    if (log === undefined) return;
    await log.append({ type: "turn/start", payload: {} });
    await log.append({ type: "user/message", payload: { text: "hi" } });

    // 模拟崩溃：追加半行（JSON 前缀，无 LF）——不可信字节，fail-closed 拒绝解读
    const raw = await readFile(logPath(), "utf8");
    await writeFile(logPath(), `${raw}{"id":3,"ts":"2`, "utf8");

    const replayed = await SessionLog.replay(logPath(), resolver);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) expect(replayed.error.code).toBe("corrupt_stream");

    // 续写打开同样拒绝：在残缺流上继续追加会产生合并坏行
    const reopened = await SessionLog.create(logPath(), resolver);
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.error.code).toBe("corrupt_stream");
  });

  it("不存在的文件 → replay err(io_error)；空文件 → ok 空序列", async () => {
    const missing = await SessionLog.replay(logPath("missing.jsonl"), resolver);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("io_error");

    const emptyPath = logPath("empty.jsonl");
    await writeFile(emptyPath, "", "utf8");
    const empty = await SessionLog.replay(emptyPath, resolver);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual({ events: [], blocks: [] });
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
