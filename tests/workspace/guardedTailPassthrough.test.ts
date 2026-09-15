import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDigestResolver, SessionLog } from "../../src/core/session/index.js";
import { GuardedSessionLog } from "../../src/core/workspace/index.js";

/**
 * S1b L-2 测试（决议 §3 必新增测试 1）：GuardedSessionLog 透传尾部修复事实——
 * 包装 replay 的 truncated_tail 可见且数值正确；无残段时为 null（字段必填收紧闭包）。
 * 铁律一回归（测试 2）复用既有 t0Guard.test.ts 全量用例，不在此重复。
 */

const resolver = MockDigestResolver.withDigests([]);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-s1b-guard-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("S1b L-2——GuardedSessionLog 透传 truncated_tail / truncatedTail", () => {
  it("有残段：包装 replay 的 truncated_tail 可见且数值正确；实例 truncatedTail 同样可见", async () => {
    const path = join(workDir, "session.jsonl");
    const scratch = join(workDir, "scratch");
    const created = await SessionLog.create(path, resolver);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (let i = 1; i <= 3; i += 1) {
      const appended = await created.value.append({ type: "user/message", payload: { seq: i } });
      expect(appended.ok).toBe(true);
    }
    const closed = await created.value.close();
    expect(closed.ok).toBe(true);
    await appendFile(path, '{"id":4,"ty', "utf8"); // 伪造未确认尾部（11 字节）

    // 包装 replay（只读）：残段事实透传
    const replayed = await GuardedSessionLog.replay(path, resolver, scratch);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.kind).toBe("replayed");
    if (replayed.value.kind !== "replayed") return;
    expect(replayed.value.events).toHaveLength(3);
    expect(replayed.value.truncated_tail).toEqual({ dropped_bytes: 11, dropped_from_offset: expect.any(Number) });

    // 包装 create（截断修复）：实例属性透传
    const guarded = await GuardedSessionLog.create(path, resolver, scratch);
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    expect(guarded.value.truncatedTail).toEqual({ dropped_bytes: 11, dropped_from_offset: expect.any(Number) });
  });

  it("无残段：truncated_tail === null（必填收紧）；包装 append 后实例 truncatedTail 恒 null", async () => {
    const path = join(workDir, "clean.jsonl");
    const scratch = join(workDir, "scratch");
    const guarded = await GuardedSessionLog.create(path, resolver, scratch);
    expect(guarded.ok).toBe(true);
    if (!guarded.ok) return;
    for (let i = 1; i <= 2; i += 1) {
      const appended = await guarded.value.append({ type: "user/message", payload: { seq: i } });
      expect(appended.ok).toBe(true);
    }
    expect(guarded.value.truncatedTail).toBeNull();

    const replayed = await GuardedSessionLog.replay(path, resolver, scratch);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    if (replayed.value.kind !== "replayed") {
      expect.fail("干净流不应被铁律一拦截");
      return;
    }
    expect(replayed.value.truncated_tail).toBeNull();
    expect(replayed.value.events).toHaveLength(2);
  });
});
