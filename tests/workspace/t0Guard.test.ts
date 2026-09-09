import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MockDigestResolver, SessionLog } from "../../src/session/index.js";
import {
  GuardedSessionLog,
  RunWorkspace,
  T0_REF_FORBIDDEN,
  isScratchReference,
} from "../../src/workspace/index.js";

/**
 * S4 铁律一测试（任务书 §4.4 验收"引用反例" + owner 口径 #4）：
 * GuardedSessionLog 包装 S2 会话校验入口——src/session/ 零改动；
 * scratch/ 引用 → 校验拒绝（t0_ref_forbidden），非 scratch 引用 → S2 既有语义原样。
 */

const runsRoot = join(fileURLToPath(new URL("../..", import.meta.url)), "tmp", "runs");

const opened: string[] = [];
const makeGuardedContext = async () => {
  const dir = join(runsRoot, `test-${randomUUID()}`);
  opened.push(dir);
  const created = await RunWorkspace.create(dir, {
    run_id: "run-t0-1",
    trigger_instruction: "S4 铁律一测试",
    model_id: "faux",
  });
  expect(created.ok, created.ok ? "" : JSON.stringify(created.error)).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  const ws = created.value;
  const resolver = MockDigestResolver.withDigests([
    { journal_type: "run_journal", fact_id: "fact-ds-001", sha256_digest: "b".repeat(64) },
  ]);
  const log = await GuardedSessionLog.create(ws.sessionLogPath, resolver, ws.scratchDir);
  expect(log.ok, !log.ok ? JSON.stringify(log.error) : "").toBe(true);
  if (!log.ok) throw new Error("unreachable");
  return { ws, log: log.value };
};

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const SCRATCH_REF = { journal_type: "workspace_artifact", fact_id: "scratch/analysis.md", sha256_digest: "a".repeat(64) };

describe("S4 验收（引用反例）——事件 domain_refs 指向 scratch 文件 → 校验拒绝（铁律一生效证明）", () => {
  it("tool/result 引用 scratch/ 路径 → rejected(t0_ref_forbidden)，事件不落盘", async () => {
    const { ws, log } = await makeGuardedContext();

    const rejected = await log.append({
      type: "tool/result",
      payload: { summary: "试图把 T0 产物当证据" },
      domain_refs: [SCRATCH_REF],
    });
    expect(rejected.ok).toBe(true);
    if (rejected.ok && rejected.value.status === "rejected") {
      expect(rejected.value.block.reason).toBe(T0_REF_FORBIDDEN);
      expect(rejected.value.block.invalid_refs).toEqual([
        { index: 0, journal_type: "workspace_artifact", fact_id: "scratch/analysis.md" },
      ]);
      expect(rejected.value.block.message).toContain("T0 不可引用为证据");
    } else {
      expect.unreachable("应被铁律一拒绝");
    }
    // 直接拒绝 = 不落盘（append-only 流上不出现被拒事件）
    await expect(stat(ws.sessionLogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("绝对路径落于 scratchRoot 内同样命中；词法前缀 'scratch' 与嵌套 'scratch/sub/x' 命中", async () => {
    const { ws, log } = await makeGuardedContext();

    for (const factId of [
      join(ws.scratchDir, "analysis.md"),
      "scratch",
      "scratch/sub/deep.json",
    ]) {
      const rejected = await log.append({
        type: "tool/result",
        payload: { fact_id: factId },
        domain_refs: [{ ...SCRATCH_REF, fact_id: factId }],
      });
      expect(rejected.ok, `应拒绝: ${factId}`).toBe(true);
      if (rejected.ok) {
        expect(rejected.value.status, `应拒绝: ${factId}`).toBe("rejected");
        if (rejected.value.status === "rejected") {
          expect(rejected.value.block.reason).toBe(T0_REF_FORBIDDEN);
        }
      }
    }
  });

  it("isScratchReference 判定面：越出 scratch 的路径 / 普通事实 id 不误伤", () => {
    expect(isScratchReference("scratch/x.md", "/tmp/runs/r1/scratch")).toBe(true);
    expect(isScratchReference("artifacts/x.md", "/tmp/runs/r1/scratch")).toBe(false);
    expect(isScratchReference("facts_scratch_x", "/tmp/runs/r1/scratch")).toBe(false); // 无路径段语义
    expect(isScratchReference("fact-ds-001", "/tmp/runs/r1/scratch")).toBe(false);
    expect(isScratchReference("/tmp/runs/r1/scratch/x.md", "/tmp/runs/r1/scratch")).toBe(true);
    expect(isScratchReference("/tmp/runs/r1/artifacts/x.md", "/tmp/runs/r1/scratch")).toBe(false);
    expect(isScratchReference("/etc/passwd", "/tmp/runs/r1/scratch")).toBe(false);
    expect(isScratchReference("", "/tmp/runs/r1/scratch")).toBe(false);
  });
});

describe("S4 补充语义——S2 既有语义零改动（对照）", () => {
  it("非 scratch 引用照常走 S2 digest 校验：命中 → 干净落盘；失配 → appended_blocked（ref_invalid 留痕）", async () => {
    const { log } = await makeGuardedContext();

    const clean = await log.append({
      type: "tool/result",
      payload: { summary: "引用已登记事实" },
      domain_refs: [{ journal_type: "run_journal", fact_id: "fact-ds-001", sha256_digest: "b".repeat(64) }],
    });
    expect(clean.ok && clean.value.status === "appended" && clean.value.event.ref_invalid === undefined).toBe(true);

    const mismatched = await log.append({
      type: "tool/result",
      payload: { summary: "digest 被篡改" },
      domain_refs: [{ journal_type: "run_journal", fact_id: "fact-ds-001", sha256_digest: "c".repeat(64) }],
    });
    expect(
      mismatched.ok && mismatched.value.status === "appended_blocked" && mismatched.value.block.reason === "ref_invalid",
    ).toBe(true);
    if (mismatched.ok && mismatched.value.status === "appended_blocked") {
      expect(mismatched.value.event.ref_invalid?.[0]?.cause).toBe("digest_mismatch");
    }
  });

  it("replay 同样执行铁律一：流内出现 scratch 引用 → blocked(t0_ref_forbidden)；文件只读不改写；对照：S2 replay 对同一流仅报 ref_invalid", async () => {
    const { ws } = await makeGuardedContext();

    // 手工落一条结构合法、引用 scratch 的事件（模拟绕过 append 的篡改/外部写入）
    const tainted = JSON.stringify({
      id: 1,
      ts: "2026-09-09T00:00:00.000Z",
      type: "tool/result",
      payload: { summary: "被篡改流内混入 T0 引用" },
      projection: { evidence_event: null },
      domain_refs: [SCRATCH_REF],
    });
    await writeFile(ws.sessionLogPath, `${tainted}\n`, "utf8");

    const resolver = MockDigestResolver.withDigests([]);
    const guarded = await GuardedSessionLog.replay(ws.sessionLogPath, resolver, ws.scratchDir);
    expect(guarded.ok).toBe(true);
    if (guarded.ok && guarded.value.kind === "blocked") {
      expect(guarded.value.block.reason).toBe(T0_REF_FORBIDDEN);
      expect(guarded.value.block.invalid_refs[0]?.fact_id).toBe("scratch/analysis.md");
    } else {
      expect.unreachable("replay 应判 blocked");
    }

    // 对照：同一份流走未包装的 S2 replay → 内层 not_found → S2 既有语义（ref_invalid 留痕 block），不判 T0
    const unguarded = await SessionLog.replay(ws.sessionLogPath, resolver);
    expect(unguarded.ok && unguarded.value.events).toHaveLength(1);
    expect(unguarded.ok && unguarded.value.blocks).toHaveLength(1);
    expect(unguarded.ok && unguarded.value.blocks[0]?.reason).toBe("ref_invalid");

    // 落盘流只读不改写（replay 与扫描均不改文件）
    await expect(readFile(ws.sessionLogPath, "utf8")).resolves.toBe(`${tainted}\n`);
  });
});
