import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../../src/bridge/connection.js";
import {
  INJECTED_LEDGER,
  KERNEL_SCOPE,
  appendJournalBadLine,
  assertIsolation,
  createRealPeerFixture,
  realPeerCliPath,
  request,
  type RealPeerFixture,
} from "./fixture.js";

/**
 * R2 门 2——fail-closed 反例组 + 注入式账本链路（owner 决议 §4.2）。
 *
 * 反例组（单会话顺序驱动，顺带验证错误后连接保持）：no_run_bound / unknown_run /
 * unknown_gate / admission_state_unavailable / gate_verdict_not_registered /
 * 坏 journal internal_error / 账本空链 not_found / approval_record_mismatch。
 *
 * 注入式账本（D1 裁决，三条约束）：仅测试夹具（本目录），不进 src/ 生产路径；
 * 与 derive_command 同源注入；报告须标注——该路径绕过 CLI argv 入口，且内核"产品级
 * 预录"尚未闭环（审批跨进程可见性已登记内核侧议题）。消费语义是真实的
 * （同一 run_session / build_registry / ApprovalLedger；CAS 一次性跃迁）。
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

describeIfPinned("R2 真实对端——fail-closed 反例组（错误后连接保持）", () => {
  it(
    "八类反例逐一命中预期错误码，同会话继续可用",
    { timeout: 60_000 },
    async () => {
      const fixture = await createRealPeerFixture();
      openFixtures.push(fixture);
      // bare run：无 l1 summary（admission_state_unavailable 制样）；坏 journal run：internal_error 制样
      const bareRunId = "r2-fixture-run-bare";
      const badRunId = "r2-fixture-run-bad";
      for (const extra of [bareRunId, badRunId]) {
        await mkdir(join(fixture.wsRoot, "runs", extra), { recursive: true });
      }
      await appendJournalBadLine(fixture.wsRoot, badRunId);

      const spawned = await AtfBridgeConnection.spawn({ command: fixture.serveSpawn().argv, cwd: fixture.serveSpawn().cwd, env: fixture.serveSpawn().env });
      expect(spawned.ok).toBe(true);
      if (!spawned.ok) return;
      const connection = spawned.value;
      openConnections.push(connection);

      // 1) 未绑定且未显式 → no_run_bound
      const noBound = await request(connection, "atf_fact_scan", {});
      expect(noBound).toMatchObject({ ok: false, error: { code: "no_run_bound" } });

      // 2) 显式不存在的 run → unknown_run（bind 与只读两路都拒）
      const bindUnknown = await request(connection, "atf.bind_run", { run_id: "r2-fixture-run-ghost" });
      expect(bindUnknown).toMatchObject({ ok: false, error: { code: "unknown_run" } });
      const scanUnknown = await request(connection, "atf_fact_scan", { run_id: "r2-fixture-run-ghost" });
      expect(scanUnknown).toMatchObject({ ok: false, error: { code: "unknown_run" } });

      // 3) 绑定主 run（错误后连接保持的证明锚点）
      const bound = await request(connection, "atf.bind_run", { run_id: fixture.runId });
      expect(bound.ok).toBe(true);

      // 4) 七组闭集外闸门名 → unknown_gate
      const unknownGate = await request(connection, "atf_gate", { gate: "not-a-gate", action: "query" });
      expect(unknownGate).toMatchObject({ ok: false, error: { code: "unknown_gate" } });

      // 5) bare run（无 summary）→ G1 query = blocked(admission_state_unavailable)
      //    （gate 无显式 run_id 参数，作用域随会话绑定——换绑 bare run 验证；合法业务产出 ok=true）
      const rebound = await request(connection, "atf.bind_run", { run_id: bareRunId });
      expect(rebound.ok).toBe(true);
      const bareGate = await request(connection, "atf_gate", { gate: "G1", action: "query" });
      expect(bareGate.ok).toBe(true);
      if (bareGate.ok) {
        expect(bareGate.value).toMatchObject({
          ok: true,
          gate: "G1",
          status: "blocked",
          reason_codes: ["admission_state_unavailable"],
        });
      }

      // 6) 完整性 Gate 未登记 → blocked(gate_verdict_not_registered)（合法业务产出）
      const integrity = await request(connection, "atf_gate", { gate: "training-preflight-valid", action: "query" });
      expect(integrity.ok).toBe(true);
      if (integrity.ok) {
        expect(integrity.value).toMatchObject({ ok: true, gate: "training-preflight-valid", status: "blocked" });
      }

      // 7) 坏 journal 行 → internal_error（残缺索引拒绝；显式 run_id 定向坏 run）
      const badScan = await request(connection, "atf_fact_scan", { run_id: badRunId });
      expect(badScan).toMatchObject({ ok: false, error: { code: "internal_error" } });

      // 8) 账本：空链 query → ok, records=[]；前缀不符 → approval_record_mismatch；前缀符链缺 → not_found
      const scopeRef = { ...KERNEL_SCOPE, scope_id: fixture.runId };
      const emptyQuery = await request(connection, "ledger_query", { scope_ref: scopeRef });
      expect(emptyQuery).toMatchObject({ ok: true, value: { ok: true, records: [] } });
      const mismatch = await request(connection, "ledger_consume", {
        approval_ref: "r2-fixture-apr-x",
        record_id: "not-the-matching-record",
      });
      expect(mismatch).toMatchObject({ ok: false, error: { code: "approval_record_mismatch" } });
      const missing = await request(connection, "ledger_consume", {
        approval_ref: "r2-fixture-apr-x",
        record_id: `approval-record:r2-fixture-apr-x:1`,
      });
      expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });

      // 错误后连接保持：同会话最终请求成功
      const finalScan = await request(connection, "atf_fact_scan", {});
      expect(finalScan.ok).toBe(true);

      const closed = await connection.close();
      expect(closed.ok).toBe(true);
      if (closed.ok) expect(closed.value.exitCode).toBe(0);
      await assertIsolation(fixture);
    },
  );
});

describeIfPinned("R2 真实对端——注入式账本链路（D1：测试夹具专用对端）", () => {
  it(
    "预录链 query → consume（一次性）→ 重复消费 approval_already_consumed → include_consumed 复读",
    { timeout: 60_000 },
    async () => {
      const fixture = await createRealPeerFixture();
      openFixtures.push(fixture);
      const spawned = await AtfBridgeConnection.spawn({ command: fixture.injectedServeSpawn().argv, cwd: fixture.injectedServeSpawn().cwd, env: fixture.injectedServeSpawn().env });
      expect(spawned.ok, spawned.ok ? undefined : JSON.stringify(spawned.error)).toBe(true);
      if (!spawned.ok) return;
      const connection = spawned.value;
      openConnections.push(connection);

      const scopeRef = { ...KERNEL_SCOPE, scope_id: fixture.runId };

      // 1) 预录链可见：恰 1 条 approved（record_id = approval-record:<approval_ref>:1）
      const queried = await request(connection, "ledger_query", { scope_ref: scopeRef });
      expect(queried.ok).toBe(true);
      if (queried.ok) {
        const value = queried.value as { records: { record_id: string; approval_id: string; sequence: number; state: string }[] };
        expect(value.records).toHaveLength(1);
        expect(value.records[0]).toMatchObject({
          record_id: `approval-record:${INJECTED_LEDGER.approvalRef}:1`,
          approval_id: INJECTED_LEDGER.approvalRef,
          sequence: 1,
          state: "approved",
        });
      }

      // 2) scope 不匹配 → 空（完全显式定位）
      const otherScope = await request(connection, "ledger_query", { scope_ref: { ...scopeRef, scope_id: "r2-fixture-other" } });
      expect(otherScope).toMatchObject({ ok: true, value: { ok: true, records: [] } });

      // 3) 逐值一致消费 → consumed（响应为证）
      const consumed = await request(connection, "ledger_consume", {
        approval_ref: INJECTED_LEDGER.approvalRef,
        record_id: `approval-record:${INJECTED_LEDGER.approvalRef}:1`,
      });
      expect(consumed).toMatchObject({ ok: true, value: { ok: true, state: "consumed" } });

      // 4) 重复消费 → approval_already_consumed（CAS 一次性跃迁，对端强制）
      const again = await request(connection, "ledger_consume", {
        approval_ref: INJECTED_LEDGER.approvalRef,
        record_id: `approval-record:${INJECTED_LEDGER.approvalRef}:1`,
      });
      expect(again).toMatchObject({ ok: false, error: { code: "approval_already_consumed" } });

      // 5) include_consumed 复读：链上两条（approved head 已消费 + consumed 记录）
      const replay = await request(connection, "ledger_query", { scope_ref: scopeRef, include_consumed: true });
      expect(replay.ok).toBe(true);
      if (replay.ok) {
        const value = replay.value as { records: { state: string }[] };
        expect(value.records.map((record) => record.state).sort()).toEqual(["approved", "consumed"]);
      }
      // 缺省 query 只回可消费记录 → 空（approved head 已被消费）
      const defaultQuery = await request(connection, "ledger_query", { scope_ref: scopeRef });
      expect(defaultQuery).toMatchObject({ ok: true, value: { ok: true, records: [] } });

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
