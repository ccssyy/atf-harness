import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err } from "../../src/bridge/index.js";
import { sessionError } from "../../src/core/session/errors.js";
import { MockDigestResolver, type DigestResolver } from "../../src/core/session/digestResolver.js";
import { SessionLog } from "../../src/core/session/sessionLog.js";
import type { InvalidRefEntry, SessionEvent, SessionEventInput } from "../../src/core/session/schema.js";

/**
 * S2 会话事件流测试（Phase 1 任务书 §2 验收 1/2 + owner 启动指令口径 #1/#2）。
 * digest 校验经注入式 DigestResolver（契约 mock）承载——不触桥接层。
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

const ref = (digest: string, factId = "fact-1", journalType = "run_journal") => ({
  journal_type: journalType,
  fact_id: factId,
  sha256_digest: digest,
});

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-session-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const logPath = (name = "session.jsonl"): string => join(workDir, name);

const createLog = async (
  resolver: DigestResolver,
  path: string = logPath(),
): Promise<SessionLog> => {
  const created = await SessionLog.create(path, resolver);
  expect(created.ok, `create 失败: ${created.ok ? "" : JSON.stringify(created.error)}`).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  return created.value;
};

const replay = async (resolver: DigestResolver, path: string = logPath()) => {
  const result = await SessionLog.replay(path, resolver);
  expect(result.ok, `replay 失败: ${result.ok ? "" : JSON.stringify(result.error)}`).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
};

/** 断言 append 结果为 appended_blocked，返回事件与 block。 */
const expectBlocked = (
  appended: Awaited<ReturnType<SessionLog["append"]>>,
): { event: SessionEvent; invalidRefs: InvalidRefEntry[] } => {
  expect(appended.ok).toBe(true);
  if (!appended.ok) throw new Error("unreachable");
  expect(appended.value.status, "期望 appended_blocked").toBe("appended_blocked");
  if (appended.value.status !== "appended_blocked") throw new Error("unreachable");
  return { event: appended.value.event, invalidRefs: appended.value.event.ref_invalid ?? [] };
};

/** 逐条 append 一组输入，返回落盘事件序列。 */
const appendAll = async (log: SessionLog, inputs: SessionEventInput[]): Promise<SessionEvent[]> => {
  const events: SessionEvent[] = [];
  for (const input of inputs) {
    const appended = await log.append(input);
    expect(appended.ok, `append 失败: ${appended.ok ? "" : JSON.stringify(appended.error)}`).toBe(true);
    if (!appended.ok) throw new Error("unreachable");
    events.push(appended.value.event);
  }
  return events;
};

describe("S2 验收用例 1——重建（写入 20+ 事件 → replay → 与内存序列逐条一致）", () => {
  it("24 条混合事件（7 类型全覆盖，含 domain_refs / ui）replay 逐条一致，blocks 为空", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
      { journal_type: "run_journal", fact_id: "fact-2", sha256_digest: DIGEST_B },
    ]);
    const log = await createLog(resolver);

    const inputs: SessionEventInput[] = [
      { type: "turn/start", payload: { turn: 1, scenario: "admission-to-g2" } },
      { type: "user/message", payload: { text: "把数据准入到 G2" }, ui: { channel: "cli" } },
      { type: "assistant/message", payload: { text: "先查工作区状态" } },
      { type: "assistant/attempt", payload: { text: "误调 atf_gate", error: "evidence_missing" }, ui: { suppressed: true } },
      { type: "tool/call", payload: { tool: "atf_workspace_status", params: {} } },
      {
        type: "tool/result",
        payload: { tool: "atf_workspace_status", ok: true },
        domain_refs: [ref(DIGEST_A, "fact-1"), ref(DIGEST_B, "fact-2")],
      },
    ];
    for (let i = 0; i < 17; i += 1) {
      inputs.push({ type: "tool/call", payload: { tool: "atf_fact_scan", seq: i } });
      inputs.push({
        type: "tool/result",
        payload: { tool: "atf_fact_scan", seq: i, ok: true },
        domain_refs: [ref(DIGEST_A, "fact-1")],
      });
    }
    inputs.push({ type: "assistant/message", payload: { text: "证据链已闭合" } });
    inputs.push({ type: "turn/end", payload: { turn: 1, outcome: "pass" } });
    expect(inputs.length).toBe(6 + 17 * 2 + 2); // 42 条 ≥ 任务书要求的 20+

    const written = await appendAll(log, inputs);
    expect(written.map((event) => event.id)).toEqual(Array.from({ length: written.length }, (_, i) => i + 1));

    const { events, blocks } = await replay(resolver);
    expect(blocks).toEqual([]);
    expect(events).toEqual(written); // 逐条一致（deep equal）
  });

  it("append 时已标记 ref_invalid 的事件，replay（resolver 状态不变）读回同样标记——标记是确定的", async () => {
    const resolver = new MockDigestResolver(); // 空表：fact-404 必然 not_found
    const log = await createLog(resolver);

    const { event } = expectBlocked(
      await log.append({ type: "tool/result", payload: { ok: true }, domain_refs: [ref(DIGEST_C, "fact-404")] }),
    );
    expect(event.ref_invalid).toHaveLength(1);

    const { events, blocks } = await replay(resolver);
    expect(events).toEqual([event]);
    expect(blocks).toHaveLength(1);
  });
});

describe("S2 验收用例 2——digest 反例（篡改 → ref_invalid → block，fail-closed）", () => {
  it("append 时 digest 不一致 → 事件带 ref_invalid 标记落盘 + 返回结构化 block", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
    ]);
    const log = await createLog(resolver);

    const appended = await log.append({
      type: "tool/result",
      payload: { ok: true },
      domain_refs: [ref(DIGEST_C)], // 声称 DIGEST_C ≠ 当前 DIGEST_A
    });
    const { event, invalidRefs } = expectBlocked(appended);

    expect(event.ref_invalid).toEqual([
      { index: 0, journal_type: "run_journal", fact_id: "fact-1", claimed_digest: DIGEST_C, cause: "digest_mismatch" },
    ]);
    expect(invalidRefs).toEqual(event.ref_invalid);

    // 结构化 block 结果（owner 口径 #2）——经 outcome 收口后单列断言
    const blocked = appended.ok && appended.value.status === "appended_blocked" ? appended.value.block : undefined;
    expect(blocked).toMatchObject({
      reason: "ref_invalid",
      event_id: 1,
      invalid_refs: event.ref_invalid,
    });
    expect(typeof blocked?.message).toBe("string");

    // 落盘内容同样带标记（事实留痕）
    const { events } = await replay(resolver);
    expect(events[0]?.ref_invalid).toEqual(event.ref_invalid);
  });

  it("落盘文件被篡改 digest → replay 校验报 ref_invalid + block；文件只读不改写", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
    ]);
    const log = await createLog(resolver);
    await appendAll(log, [
      { type: "turn/start", payload: { turn: 1 } },
      { type: "tool/result", payload: { ok: true }, domain_refs: [ref(DIGEST_A)] }, // 合法落盘
      { type: "turn/end", payload: { turn: 1 } },
    ]);

    // 绕过 harness 直接改文件第 2 行的 digest（模拟外部篡改）
    const path = logPath();
    const raw = (await readFile(path, "utf8")).split("\n");
    const tampered = (raw[1] as string).replace(DIGEST_A, DIGEST_C);
    expect(tampered).not.toEqual(raw[1]);
    raw[1] = tampered;
    await writeFile(path, raw.join("\n"), "utf8");

    const { events, blocks } = await replay(resolver); // replay 本身成功——ref_invalid 是 block 报告，不是 replay 失败
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      reason: "ref_invalid",
      event_id: 2,
      invalid_refs: [{ index: 0, cause: "digest_mismatch", claimed_digest: DIGEST_C }],
    });
    expect(events[1]?.ref_invalid).toBeDefined();
    expect(events[0]?.ref_invalid).toBeUndefined(); // 未篡改事件不受牵连
    expect(events).toHaveLength(3);
  });

  it("引用的事实不存在（not_found）→ ref_invalid + block（cause = fact_not_found）", async () => {
    const resolver = new MockDigestResolver();
    const log = await createLog(resolver);

    const appended = await log.append({ type: "tool/result", payload: {}, domain_refs: [ref(DIGEST_C, "fact-404")] });
    const { invalidRefs } = expectBlocked(appended);
    expect(invalidRefs[0]?.cause).toBe("fact_not_found");
  });

  it("混合引用（一好一坏）→ 仅坏引用进入 ref_invalid，好引用不受牵连", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_A },
    ]);
    const log = await createLog(resolver);

    const { event } = expectBlocked(
      await log.append({
        type: "tool/result",
        payload: {},
        domain_refs: [ref(DIGEST_A, "fact-1"), ref(DIGEST_C, "fact-404")],
      }),
    );
    expect(event.ref_invalid).toHaveLength(1);
    expect(event.ref_invalid?.[0]).toMatchObject({ index: 1, cause: "fact_not_found" });
  });

  it("resolver 查询自身失败 → err(resolver_failure)：不落盘、不标记、不猜测", async () => {
    const failing: DigestResolver = {
      lookupDigest: async () => err(sessionError("resolver_failure", "对端不可达")),
    };
    const path = logPath();
    const log = await createLog(failing, path);

    const appended = await log.append({ type: "tool/result", payload: {}, domain_refs: [ref(DIGEST_A)] });
    expect(appended.ok).toBe(false);
    if (!appended.ok) expect(appended.error.code).toBe("resolver_failure");

    const raw = await readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => (cause.code === "ENOENT" ? "" : "<exists>"));
    expect(raw).toBe(""); // 什么都没写
  });
});
