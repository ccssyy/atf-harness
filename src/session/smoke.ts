/**
 * S2 手工冒烟命令（任务书：每个 slice 一条手工冒烟命令）。
 *
 * 演示会话层全流程：append（含 domain_refs 正例）→ replay 重建 →
 * 篡改 digest 反例（ref_invalid → block，fail-closed）→ convertToLlm 白名单投影。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:s2
 *
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { sessionError, type SessionError } from "../core/session/errors.js";
import { MockDigestResolver } from "../core/session/digestResolver.js";
import { convertToLlm, transformContext } from "../core/session/pipeline.js";
import type { SessionEventInput } from "../core/session/schema.js";
import { SessionLog } from "../core/session/sessionLog.js";

const DIGEST_GOOD = "3a7f".repeat(16); // 演示用 64 位 hex
const DIGEST_EVIL = "dead".repeat(16);

const smoke = async (): Promise<Result<undefined, SessionError>> => {
  const dir = await mkdtemp(join(tmpdir(), "atf-smoke-s2-"));
  const path = join(dir, "session.jsonl");
  const resolver = MockDigestResolver.withDigests([
    { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_GOOD },
  ]);
  try {
    console.log(`[1/5] 创建会话日志: ${path}`);
    const log = await SessionLog.create(path, resolver);
    if (!log.ok) return log;

    console.log("[2/5] append 5 条事件（含 domain_refs 正例与 assistant/attempt）");
    const inputs: SessionEventInput[] = [
      { type: "turn/start", payload: { turn: 1 } },
      { type: "user/message", payload: { text: "冒烟" }, ui: { channel: "cli" } },
      { type: "assistant/attempt", payload: { error: "演示失败尝试" } },
      { type: "tool/result", payload: { ok: true }, domain_refs: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: DIGEST_GOOD }] },
      { type: "turn/end", payload: { turn: 1 } },
    ];
    const written = [];
    for (const input of inputs) {
      const appended = await log.value.append(input);
      if (!appended.ok) return appended;
      if (appended.value.status === "appended_blocked") {
        return err(sessionError("schema_violation", "正例不应触发 block"));
      }
      written.push(appended.value.event);
    }

    console.log("[3/5] replay 从磁盘重建 → 与内存序列逐条一致");
    const replayed = await SessionLog.replay(path, resolver);
    if (!replayed.ok) return replayed;
    if (JSON.stringify(replayed.value.events) !== JSON.stringify(written) || replayed.value.blocks.length !== 0) {
      return err(sessionError("schema_violation", "replay 与内存序列不一致"));
    }
    console.log(`      重建 ${String(replayed.value.events.length)} 条 ✓`);

    console.log("[4/5] 反例：篡改文件中 domain_refs digest → replay 报 ref_invalid + block");
    const raw = (await readFile(path, "utf8")).replace(DIGEST_GOOD, DIGEST_EVIL);
    await writeFile(path, raw, "utf8");
    const tampered = await SessionLog.replay(path, resolver);
    if (!tampered.ok) return tampered;
    if (tampered.value.blocks.length !== 1 || tampered.value.blocks[0]?.reason !== "ref_invalid") {
      return err(sessionError("schema_violation", "篡改未被检出"));
    }
    console.log(`      block: ${tampered.value.blocks[0]?.message}`);

    console.log("[5/5] convertToLlm 白名单投影：ui 字段不出现；transformContext 过滤 attempt");
    const context = transformContext(replayed.value.events);
    if (context.length !== 4 || JSON.stringify(context).includes("channel")) {
      return err(sessionError("schema_violation", "双管道投影不符合白名单"));
    }
    const firstEvent = replayed.value.events[0];
    if (firstEvent === undefined) return err(sessionError("schema_violation", "重建序列为空"));
    console.log(`      投影键集: [${Object.keys(convertToLlm(firstEvent)).join(", ")}]`);
    return ok(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const result = await smoke();
if (!result.ok) process.exitCode = 1;
else console.log("S2 冒烟通过 ✓");
