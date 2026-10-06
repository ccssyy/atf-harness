/**
 * 镜像面②测试（批㊶-H 共享内核收口）：审批账本闸骨架单源 runLedgerGate。
 * 锚：①全序骨架（query 参数形态→链首比对→consume 逐值一致→onGranted；operation_id
 * 可选透传）②无可消费记录→onNoRecord（records 全量透传，consume 零触达）③失败载荷
 * 原始透传（桥接错误/canonical 违规恰一者在位，未折叠——两线各自折叠的输入面）
 * ④两线等价（复用契约 mock 对端夹具：同一审批场景下甲线 executor 与丙线 approvalHook
 * 经同一骨架逐位一致——预录→query→consume→放行，账本同入 consumed 态）。
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import type { BridgeError } from "../../src/bridge/errors.js";
import { runLedgerGate, type LedgerGateFailure } from "../../src/core/tools/ledgerGate.js";
import { ToolExecutor, ToolRegistry } from "../../src/core/tools/index.js";
import { approvalParamsDigest, type LedgerRecord, type ScopeRef } from "../../src/core/tools/approvalKey.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "../../src/agent/approvalHook.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
const spawnMock = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok, spawned.ok ? "" : JSON.stringify(spawned.error)).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const SCOPE: ScopeRef = { project_id: "proj-gate", scope_type: "run", scope_id: "run-gate", scope_mode: "headless" };

/** 决策点映射（以返回值暴露触达点位；未触达点位不会出现在断言面）。 */
const tracker = (): {
  mapping: { onQueryFailure(f: LedgerGateFailure): string; onNoRecord(records: LedgerRecord[]): string; onConsumeFailure(f: LedgerGateFailure): string; onGranted(recordId: string): string };
} => ({
  mapping: {
    onQueryFailure: () => "query_failure",
    onNoRecord: () => "no_record",
    onConsumeFailure: () => "consume_failure",
    onGranted: () => "granted",
  },
});

describe("镜像面② 函数级单测（runLedgerGate 骨架）", () => {
  it("① 全序骨架：ledger_query（scope_ref）→ 链首比对 → ledger_consume（{approval_ref, record_id} 逐值一致）→ onGranted(record_id)；operation_id 可选透传", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "ledger_query") {
          return { ok: true as const, value: { ok: true, records: [{ record_id: "r-1", approval_id: "apr-1", sequence: 1, state: "pending" }] } };
        }
        return { ok: true as const, value: { ok: true, record_id: "r-1", state: "consumed" } };
      },
    };
    const t = tracker();
    t.mapping.onGranted = (recordId) => `granted:${recordId}`;

    const result = await runLedgerGate(transport, () => SCOPE, t.mapping);
    expect(result).toBe("granted:r-1");
    expect(calls).toEqual([
      { method: "ledger_query", params: { scope_ref: SCOPE } },
      { method: "ledger_consume", params: { approval_ref: "apr-1", record_id: "r-1" } },
    ]);

    // L1b B5：operationId 透传形态（缺省不传＝上方首断言；传入即入查询参数）
    calls.length = 0;
    await runLedgerGate(transport, () => SCOPE, t.mapping, { operationId: "op-x" });
    expect(calls[0]).toEqual({ method: "ledger_query", params: { scope_ref: SCOPE, operation_id: "op-x" } });
    expect(calls[1]?.method).toBe("ledger_consume");
  });

  it("② 无可消费记录：onNoRecord 收全量 records（空账本），ledger_consume 零触达", async () => {
    const calls: string[] = [];
    const transport = {
      request: async (method: string) => {
        calls.push(method);
        return { ok: true as const, value: { ok: true, records: [] } };
      },
    };
    const t = tracker();
    const recordsSeen: LedgerRecord[][] = [];
    t.mapping.onNoRecord = (records) => {
      recordsSeen.push(records);
      return "no_record";
    };
    const result = await runLedgerGate(transport, () => SCOPE, t.mapping);
    expect(result).toBe("no_record");
    expect(recordsSeen).toEqual([[]]);
    expect(calls).toEqual(["ledger_query"]); // consume 未触达
  });

  it("③ 失败载荷原始透传：桥接错误/canonical 违规恰一者在位（未折叠——两线映射层的输入面）", async () => {
    // 查询步·桥接失败：bridgeError 为原始 BridgeError 对象（引用同一）
    const bridgeFailure = { code: "closed", message: "连接尚未就绪" } as BridgeError;
    const failTransport = { request: async () => ({ ok: false as const, error: bridgeFailure }) };
    const grab: LedgerGateFailure[] = [];
    const grabMapping = {
      onQueryFailure: (failure: LedgerGateFailure) => {
        grab.push(failure);
        return "x";
      },
      onNoRecord: () => "no_record",
      onConsumeFailure: (failure: LedgerGateFailure) => {
        grab.push(failure);
        return "x";
      },
      onGranted: () => "granted",
    };
    expect(await runLedgerGate(failTransport, () => SCOPE, grabMapping)).toBe("x");
    expect(grab[0]?.bridgeError).toBe(bridgeFailure);
    expect(grab[0]?.canonicalError).toBeUndefined();

    // 查询步·canonical 违规（缺 records）：canonicalError 为校验 err 载荷（schema_violation）
    grab.length = 0;
    const badCanonical = { request: async () => ({ ok: true as const, value: { ok: true } }) };
    expect(await runLedgerGate(badCanonical, () => SCOPE, grabMapping)).toBe("x");
    expect(grab[0]?.bridgeError).toBeUndefined();
    expect(grab[0]?.canonicalError?.code).toBe("schema_violation");

    // 消费步失败（查询成功、消费桥接失败）：同载荷形态在 consume 点位透传
    grab.length = 0;
    const consumeFail = {
      request: async (method: string) =>
        method === "ledger_query"
          ? { ok: true as const, value: { ok: true, records: [{ record_id: "r-1", approval_id: "apr-1", sequence: 1, state: "pending" }] } }
          : { ok: false as const, error: bridgeFailure },
    };
    expect(await runLedgerGate(consumeFail, () => SCOPE, grabMapping)).toBe("x");
    expect(grab[0]?.bridgeError).toBe(bridgeFailure);
  });
});

describe("镜像面② 两线等价（同一审批场景：预录→query→consume→放行）", () => {
  const ADMIT_PARAMS = { dataset_id: "ds-2026-001", source_ref: "smoke" };
  let seq = 0;
  const recordApproval = async (connection: AtfBridgeConnection, scope: ScopeRef, tool: string, params: unknown): Promise<string> => {
    seq += 1;
    const recorded = await connection.request("ledger_record", {
      scope_ref: scope,
      command_id: `cmd-eq-${tool}-${String(seq)}`,
      actor: "test-setup",
      operation_id: `op-${tool}`,
      attempt_id: "1",
      subject_ref: `${tool}:${approvalParamsDigest(params).slice(0, 12)}`,
      evidence_refs: [approvalParamsDigest(params)],
    });
    expect(recorded.ok, recorded.ok ? "" : JSON.stringify(recorded.error)).toBe(true);
    if (!recorded.ok) throw new Error("unreachable");
    return (recorded.value as { record_id: string }).record_id;
  };
  const consumedStateOf = async (connection: AtfBridgeConnection, scope: ScopeRef): Promise<{ state: string; count: number }> => {
    const queried = await connection.request("ledger_query", { scope_ref: scope, include_consumed: true });
    expect(queried.ok).toBe(true);
    if (!queried.ok) throw new Error("unreachable");
    const records = (queried.value as { records: LedgerRecord[] }).records;
    return { state: records[0]?.state ?? "none", count: records.length };
  };

  it("甲线 executor executed ≡ 丙线 approvalHook allow_ledger——同一骨架（runLedgerGate）逐位一致；账本同入 consumed 态、事后无可消费记录", async () => {
    // 甲线：预录 → executor.execute → executed（账本轨 query→consume 放行）
    const connectionA = await spawnMock();
    const scopeA: ScopeRef = { ...SCOPE, scope_id: "run-eq-a" };
    await recordApproval(connectionA, scopeA, "atf_admit_data", ADMIT_PARAMS);
    const outcomeA = await new ToolExecutor(connectionA, ToolRegistry.createDefault(), scopeA).execute("atf_admit_data", ADMIT_PARAMS);
    expect(outcomeA.kind).toBe("executed");
    expect(await consumedStateOf(connectionA, scopeA)).toEqual({ state: "consumed", count: 1 });

    // 丙线：同场景预录 → beforeToolCall hook → 放行（同一骨架 query→consume→granted）
    const connectionB = await spawnMock();
    const scopeB: ScopeRef = { ...SCOPE, scope_id: "run-eq-b" };
    await recordApproval(connectionB, scopeB, "atf_admit_data", ADMIT_PARAMS);
    const audit: ApprovalAuditEntry[] = [];
    const hook = createApprovalBeforeToolCall({ bridge: connectionB, scopeRefBox: { current: scopeB }, audit });
    const verdict = await hook({
      toolCall: { id: "t-eq", name: "atf_admit_data", arguments: ADMIT_PARAMS },
      args: ADMIT_PARAMS,
    } as unknown as Parameters<typeof hook>[0]);
    expect(verdict).toBeUndefined(); // 放行 ≡ 甲线 executed 的闸段结论
    expect(audit.at(-1)?.verdict).toBe("allow_ledger");
    expect((audit.at(-1)?.detail as { record_id?: string }).record_id).toMatch(/^approval-record:/);
    expect(await consumedStateOf(connectionB, scopeB)).toEqual({ state: "consumed", count: 1 });

    // 一次性语义两线同界：事后无可消费记录
    const emptyA = await connectionA.request("ledger_query", { scope_ref: scopeA });
    const emptyB = await connectionB.request("ledger_query", { scope_ref: scopeB });
    expect((emptyA as { ok: true; value: { records: unknown[] } }).value.records).toHaveLength(0);
    expect((emptyB as { ok: true; value: { records: unknown[] } }).value.records).toHaveLength(0);
  });
});
