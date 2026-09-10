/**
 * P2-S1 手工冒烟命令（Phase 2 任务书 §2：compaction + fsync + schema v1）。
 *
 * 演示：schema v1 白名单（保留位拒写）→ 长会话 append 触发压缩（承证白名单豁免）→
 * session/compaction 审计留痕 → replay 后投影与内存逐条一致 → fsync 双档 ack 即落盘。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:p2s1
 *
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { sessionError, type SessionError } from "./errors.js";
import { MockDigestResolver } from "./digestResolver.js";
import { COMPACTION_TRIGGER_EVENTS } from "./constants.js";
import { transformContext } from "./pipeline.js";
import { SESSION_RESERVED_EVENT_TYPES } from "./schema.js";
import { SessionLog } from "./sessionLog.js";
import type { SessionEvent, SessionEventInput } from "./schema.js";

const DIGEST_GOOD = "3a7f".repeat(16); // 演示用 64 位 hex

const smoke = async (): Promise<Result<undefined, SessionError>> => {
  const dir = await mkdtemp(join(tmpdir(), "atf-smoke-p2s1-"));
  const path = join(dir, "session.jsonl");
  const resolver = MockDigestResolver.withDigests([
    { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_GOOD },
  ]);
  try {
    console.log(`[1/5] schema v1：保留位类型拒写（${SESSION_RESERVED_EVENT_TYPES.join(" / ")}）`);
    {
      const probe = await SessionLog.create(join(dir, "probe.jsonl"), resolver);
      if (!probe.ok) return probe;
      for (const reserved of SESSION_RESERVED_EVENT_TYPES) {
        const rejected = await probe.value.append({ type: reserved, payload: {} });
        if (rejected.ok) return err(sessionError("schema_violation", `保留位 ${reserved} 未被拒写`));
      }
      console.log(`      ${String(SESSION_RESERVED_EVENT_TYPES.length)} 类保留位全部拒写 ✓`);
    }

    console.log(`[2/5] append ${String(COMPACTION_TRIGGER_EVENTS + 4)} 条（含承证对，触发压缩）: ${path}`);
    const log = await SessionLog.create(path, resolver, { fsync: { mode: "per-append" } });
    if (!log.ok) return log;
    const written: SessionEvent[] = [];
    const push = async (input: SessionEventInput): Promise<void> => {
      const appended = await log.value.append(input);
      if (!appended.ok) {
        await log.value.close();
        throw new Error(`append 失败: ${appended.error.message}`);
      }
      written.push(appended.value.event);
    };
    await push({ type: "turn/start", payload: { turn: 1 } });
    await push({ type: "tool/call", payload: { tool: "atf_admit_data", params: {} } });
    await push({
      type: "tool/result",
      payload: { tool: "atf_admit_data", ok: true },
      domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_GOOD }],
    });
    for (let i = 0; i < COMPACTION_TRIGGER_EVENTS + 1; i += 1) {
      await push({ type: "user/message", payload: { seq: i } });
    }
    const closed = await log.value.close();
    if (!closed.ok) return closed;
    console.log(`      落盘 ${String(written.length)} 条（逐条 fsync）✓`);

    console.log("[3/5] 压缩投影：摘要 + 承证白名单豁免原文 + 保留窗");
    const view = transformContext(written);
    const summary = view[0];
    if (summary?.type !== "session/compaction") {
      return err(sessionError("schema_violation", "压缩未触发或摘要不在投影首位"));
    }
    const payload = summary.payload as { folded_count: number; kept_ids: number[] };
    if (!view.some((item) => item.id === 3) || (payload.kept_ids ?? []).length !== 2) {
      return err(sessionError("schema_violation", "承证白名单未豁免原文"));
    }
    console.log(`      折叠 ${String(payload.folded_count)} 条、豁免承证 ${String(payload.kept_ids.length)} 条 ✓`);

    console.log("[4/5] 审计留痕 + replay 重建投影一致");
    const replayed = await SessionLog.replay(path, resolver);
    if (!replayed.ok) return replayed;
    const audits = replayed.value.events.filter((event) => event.type === "session/compaction");
    if (audits.length === 0) return err(sessionError("schema_violation", "压缩动作未落盘留痕"));
    if (JSON.stringify(transformContext(replayed.value.events)) !== JSON.stringify(view)) {
      return err(sessionError("schema_violation", "replay 后投影与内存不一致"));
    }
    console.log(`      审计 ${String(audits.length)} 条（covers=${JSON.stringify((audits[0]?.payload as { covers: unknown }).covers)}），重建一致 ✓`);

    console.log("[5/5] fsync 批量档：攒满 N 条即刷、ack 即持久化");
    const batchPath = join(dir, "batch.jsonl");
    const batch = await SessionLog.create(batchPath, resolver, {
      fsync: { mode: "batch", batchMaxEvents: 4, batchWindowMs: 500 },
    });
    if (!batch.ok) return batch;
    for (let i = 0; i < 6; i += 1) {
      const appended = await batch.value.append({ type: "user/message", payload: { seq: i } });
      if (!appended.ok) {
        await batch.value.close();
        return appended;
      }
    }
    const flushed = await batch.value.flush();
    if (!flushed.ok) return flushed;
    const closedBatch = await batch.value.close();
    if (!closedBatch.ok) return closedBatch;
    const lines = (await readFile(batchPath, "utf8")).split("\n").filter((line) => line !== "");
    if (lines.length !== 6) return err(sessionError("io_error", "批量档刷盘后行数不符"));
    console.log("      批量档 6 条全部刷盘 ✓");
    return ok(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const result = await smoke();
if (!result.ok) {
  console.error(`P2-S1 冒烟失败: ${result.error.message}`);
  process.exitCode = 1;
} else console.log("P2-S1 冒烟通过 ✓");
