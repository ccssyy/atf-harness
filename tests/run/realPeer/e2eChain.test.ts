import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../../src/bridge/connection.js";
import {
  appendJournalEvent,
  assertIsolation,
  createRealPeerFixture,
  realPeerCliPath,
  request,
  writeAdmissionSummary,
  type RealPeerFixture,
} from "./fixture.js";

/**
 * R2 门 2——真实对端端到端主链（验收主链，owner 决议 §4.2）：
 *   bind_run → workspace_status → fact_scan → gate(G 系 query) → admit_data（写，真实落盘）
 *   → gate(G 系 advance，会话内存登记) → 同会话 query 反读 → 优雅关闭。
 * 隔离断言（门 1 §4）：pin 副本 git status 零改动、temp HOME 无 .agents/skills 泄漏。
 * 边界标注（决议 §3.3）：gate advance 与账本消费为会话进程内存事实，验证口径 =
 * 「同会话 query 反读」，不得表述为持久化/可重建。
 * 真实写授权边界（决议 §2.4）：仅限 /tmp/atf-r2-* 夹具根内的合成数据（r2-fixture-*）。
 */

const cli = realPeerCliPath();
const describeIfPinned = cli.ok ? describe : describe.skip;

const openConnections: AtfBridgeConnection[] = [];
const openFixtures: RealPeerFixture[] = [];

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
  while (openFixtures.length > 0) {
    const fixture = openFixtures.pop();
    if (fixture !== undefined) await fixture.cleanup();
  }
});

describeIfPinned("R2 真实对端——端到端主链（含真实写落盘证据）", () => {
  it(
    "bind_run → status → fact_scan → G 系 query → admit_data（落盘）→ G 系 advance → query 反读 → 优雅关闭",
    { timeout: 60_000 },
    async () => {
      const fixture = await createRealPeerFixture();
      openFixtures.push(fixture);
      await appendJournalEvent(fixture.wsRoot, fixture.runId, { action: "experiment_setup" });
      await appendJournalEvent(fixture.wsRoot, fixture.runId, { action: "eval_service_generated", refs: { manifest: "a".repeat(64) } });
      await appendJournalEvent(fixture.wsRoot, fixture.runId, { action: "train_launch_generated", out: "launch" });
      await writeAdmissionSummary(fixture.wsRoot, fixture.runId, "lane-a", ["pass", "pass", "pass", "pass"]);

      const spawned = await AtfBridgeConnection.spawn({ command: fixture.serveSpawn().argv, cwd: fixture.serveSpawn().cwd, env: fixture.serveSpawn().env });
      expect(spawned.ok, spawned.ok ? undefined : JSON.stringify(spawned.error)).toBe(true);
      if (!spawned.ok) return;
      const connection = spawned.value;
      openConnections.push(connection);

      // 1) bind_run：绑定成功；留痕 event（内核形态：首绑也发，payload 键 from_run_id/to_run_id——决议 §3.2 差异面）
      const events: { name: string; payload?: unknown }[] = [];
      connection.onEvent((event) => events.push(event));
      const bound = await request(connection, "atf.bind_run", { run_id: fixture.runId });
      expect(bound.ok).toBe(true);
      if (bound.ok) {
        expect(bound.value).toMatchObject({ ok: true, run_id: fixture.runId });
      }
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({ name: "session/run-bound", payload: { to_run_id: fixture.runId } });

      // 2) workspace_status：空登记面 → admitted_count=0
      const status0 = await request(connection, "atf_workspace_status", {});
      expect(status0).toMatchObject({ ok: true, value: { ok: true, run_id: fixture.runId, admitted_count: 0 } });

      // 3) fact_scan：3 行 journal → 3 条 operation-journal 事实（行号连续）
      const scan0 = await request(connection, "atf_fact_scan", {});
      expect(scan0.ok).toBe(true);
      if (scan0.ok) {
        const value = scan0.value as { count: number; facts: { journal_type: string; fact_id: string; sha256_digest: string }[] };
        expect(value.count).toBe(3);
        expect(value.facts[0]).toMatchObject({ journal_type: "operation-journal", fact_id: `journal-event:${fixture.runId}:1` });
        for (const fact of value.facts) expect(fact.sha256_digest).toMatch(/^[0-9a-f]{64}$/);
      }

      // 4) G 系 query：lane-a 全 pass → G1 pass（大小写归一化 g1 → G1）
      const g1Query = await request(connection, "atf_gate", { gate: "g1", action: "query" });
      expect(g1Query.ok).toBe(true);
      if (g1Query.ok) {
        expect(g1Query.value).toMatchObject({ ok: true, gate: "G1", status: "pass" });
      }

      // 5) admit_data：真实写（授权范围 /tmp/atf-r2-* 夹具根、合成数据）——落盘证据
      const admitted = await request(connection, "atf_admit_data", {
        dataset_id: "r2-fixture-ds-1",
        source_ref: "r2-fixture-source-1",
      });
      expect(admitted.ok).toBe(true);
      let factId = "";
      if (admitted.ok) {
        const value = admitted.value as { journal_type: string; fact_id: string; sha256_digest: string; dataset_id: string };
        expect(value.journal_type).toBe("dataset-registry");
        expect(value.dataset_id).toBe("r2-fixture-ds-1");
        expect(value.sha256_digest).toMatch(/^[0-9a-f]{64}$/);
        factId = value.fact_id;
        expect(factId).toMatch(/^r2-fixture-ds-1@[0-9a-f]{12}$/);
      }
      // 落盘证据：registration.json 存在、身份与目录名一致、文件字节 sha256 可复算（R2 唯一真实磁盘写）
      const regPath = join(fixture.wsRoot, "datasets", factId, "registration.json");
      const regBytes = await readFile(regPath, "utf8");
      const record = JSON.parse(regBytes) as { dataset_id: string; pin: string };
      expect(record.dataset_id).toBe("r2-fixture-ds-1");
      expect(record.pin).toBe(factId.split("@")[1]);
      const fileSha = createHash("sha256").update(regBytes, "utf8").digest("hex");
      expect(fileSha).toMatch(/^[0-9a-f]{64}$/);

      // 6) 写后复读：admitted_count=1；fact_scan 增 dataset-registry 事实（count 3→4）
      const status1 = await request(connection, "atf_workspace_status", {});
      expect(status1).toMatchObject({ ok: true, value: { admitted_count: 1 } });
      const scan1 = await request(connection, "atf_fact_scan", {});
      expect(scan1.ok).toBe(true);
      if (scan1.ok) {
        const value = scan1.value as { count: number; facts: { journal_type: string }[] };
        expect(value.count).toBe(4);
        expect(value.facts.map((fact) => fact.journal_type)).toContain("dataset-registry");
      }

      // 7) G 系 advance（写 = 会话内存登记；边界标注：以同会话 query 反读为证，非持久化）
      const g1Advance = await request(connection, "atf_gate", { gate: "G1", action: "advance" });
      expect(g1Advance.ok).toBe(true);
      if (g1Advance.ok) {
        expect(g1Advance.value).toMatchObject({ ok: true, gate: "G1", status: "pass" });
      }
      const g1Replay = await request(connection, "atf_gate", { gate: "G1", action: "query" });
      expect(g1Replay.ok).toBe(true);
      if (g1Replay.ok) {
        expect(g1Replay.value).toMatchObject({ ok: true, gate: "G1", status: "pass" });
      }

      // 8) 优雅关闭
      const closed = await connection.close();
      expect(closed.ok).toBe(true);
      if (closed.ok) expect(closed.value.exitCode).toBe(0);

      await assertIsolation(fixture);
    },
  );

  it(
    "多 lane 最坏裁决聚合：G2 = warn（reason_codes 并集），advance 登记后反读一致",
    { timeout: 60_000 },
    async () => {
      const fixture = await createRealPeerFixture();
      openFixtures.push(fixture);
      await writeAdmissionSummary(fixture.wsRoot, fixture.runId, "lane-a", ["pass", "pass", "pass", "pass"]);
      await writeAdmissionSummary(fixture.wsRoot, fixture.runId, "lane-b", ["pass", "warn", "pass", "pass"], [
        [],
        ["split_checksum_stale"],
        [],
        [],
      ]);
      const spawned = await AtfBridgeConnection.spawn({ command: fixture.serveSpawn().argv, cwd: fixture.serveSpawn().cwd, env: fixture.serveSpawn().env });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      const connection = spawned.value;
      openConnections.push(connection);

      const bound = await request(connection, "atf.bind_run", { run_id: fixture.runId });
      expect(bound.ok).toBe(true);

      const g2 = await request(connection, "atf_gate", { gate: "G2", action: "query" });
      expect(g2.ok).toBe(true);
      if (g2.ok) {
        expect(g2.value).toMatchObject({ ok: true, gate: "G2", status: "warn", reason_codes: ["split_checksum_stale"] });
      }
      const g2Advance = await request(connection, "atf_gate", { gate: "G2", action: "advance", evidence_refs: [] });
      expect(g2Advance.ok).toBe(true);
      if (g2Advance.ok) {
        expect(g2Advance.value).toMatchObject({ ok: true, gate: "G2", status: "warn" });
      }

      const closed = await connection.close();
      expect(closed.ok).toBe(true);
      if (closed.ok) expect(closed.value.exitCode).toBe(0);
      await assertIsolation(fixture);
    },
  );
});

if (!cli.ok) {
  it("ATF_CLI_PATH 未设置 → R2 真对端组跳过（mock 轨完整可用）", () => {
    expect(cli.ok).toBe(false);
  });
}
