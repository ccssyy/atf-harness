/** G1 拆解单元④最小单测（批㉞H-H3）：runHistory.ts——持久性·历史装载读面独立可测锚。 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunHistory, readSessionLogText } from "../../src/core/run/runHistory.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("G1 单元④ runHistory（持久性·历史装载读面）", () => {
  it("loadRunHistory：合法流逐行装载（id 续接基准）；空流 → 空序列（continue 空流拒绝在编排层）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g1hist-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    const envelope = (id: number, type: string, payload: unknown) =>
      JSON.stringify({ id, type, ts: "2026-10-05T00:00:00.000Z", payload, projection: { evidence_event: null } });
    writeFileSync(path, `${envelope(1, "turn/start", {})}\n${envelope(2, "user/message", { text: "hi" })}\n`);
    const loaded = await loadRunHistory(path);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.map((e) => e.id)).toEqual([1, 2]);
      expect(loaded.value[1]?.type).toBe("user/message");
    }
    const emptyPath = join(dir, "empty.jsonl");
    writeFileSync(emptyPath, "");
    const empty = await loadRunHistory(emptyPath);
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toEqual([]);
  });
  it("loadRunHistory：坏行/断号 → parse err（fail-closed）；文件缺失 → read err（message 含路径读失败语义）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g1hist-"));
    dirs.push(dir);
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, "not-json\n");
    const parsed = await loadRunHistory(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe("parse");
    const missing = await loadRunHistory(join(dir, "missing.jsonl"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.kind).toBe("read");
      expect(missing.error.error.message).toContain("会话流读取失败");
    }
    const text = await readSessionLogText(join(dir, "missing.jsonl"));
    expect(text.ok).toBe(false);
  });
});
