import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { err, type Result } from "../../src/bridge/index.js";
import type { BridgeError } from "../../src/bridge/errors.js";
import { ToolExecutor, ToolRegistry, resolveHeadlessExitCode, type BridgeTransport } from "../../src/core/tools/index.js";
import { approvalParamsDigest, type LedgerRecord, type ScopeRef } from "../../src/core/tools/approvalKey.js";

/**
 * S3 工具执行测试（Phase 1 任务书 §3 验收 + owner 启动指令口径 #1/#3/#4）。
 * 4 个工具方法 + MockLedger（审批链预录/查询/消费/一次性语义）均由契约 mock 对端承载。
 * 契约 v2（2026-09-13 契约修订）：账本查询以 scope_ref 定位、消费以 {approval_ref, record_id}
 * 逐值一致校验；atf_fact_scan 为 v1 证据面扫描方法的改名形态（facts 数组）。
 */

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));
const spawnMock = (...flags: string[]) => AtfBridgeConnection.spawn({ command: ["node", mockAtf, ...flags] });

const openConnections: AtfBridgeConnection[] = [];
const track = (connection: AtfBridgeConnection): AtfBridgeConnection => {
  openConnections.push(connection);
  return connection;
};

const SCOPE_REF: ScopeRef = { project_id: "proj-test", scope_type: "run", scope_id: "run-test", scope_mode: "headless" };

const makeExecutor = async (...flags: string[]): Promise<{ connection: AtfBridgeConnection; executor: ToolExecutor }> => {
  const spawned = await spawnMock(...flags);
  expect(spawned.ok, spawned.ok ? "" : JSON.stringify(spawned.error)).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  const connection = track(spawned.value);
  return { connection, executor: new ToolExecutor(connection, ToolRegistry.createDefault(), SCOPE_REF) };
};

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const ADMIT_PARAMS = { dataset_id: "ds-2026-001", source_ref: "smoke" };

/** 经桥接在对端 MockLedger 预录一条审批链记录（测试 setup 基建；re-pin R2 后按 K4 §13.8
 *  wire 形态：{scope_ref, command_id, actor, operation_id, attempt_id, subject_ref,
 *  evidence_refs}；tool/params_digest 入 subject_ref/evidence_refs 作审计检索辅助）。 */
let recordSeqForTest = 0;
const recordApproval = async (connection: AtfBridgeConnection, tool: string, params: unknown): Promise<string> => {
  recordSeqForTest += 1;
  const recorded = await connection.request("ledger_record", {
    scope_ref: SCOPE_REF,
    command_id: `cmd-${tool}-${String(recordSeqForTest)}`,
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

describe("S3 验收（成功用例）——预录 → 执行成功 → 账本已消费 → 重复调用 → block", () => {
  it("atf_admit_data 全生命周期：预录 → executed → state=consumed → 重复 blocked(approval_missing)", async () => {
    const { connection, executor } = await makeExecutor();

    const recordId = await recordApproval(connection, "atf_admit_data", ADMIT_PARAMS);
    expect(recordId).toMatch(/^approval-record:/);

    const first = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(first.kind).toBe("executed");
    if (first.kind !== "executed") return;
    const result = first.result as { ok?: boolean; journal_type?: string; fact_id?: string; sha256_digest?: string };
    expect(result.ok).toBe(true);
    expect(result.journal_type).toBe("dataset-registry");
    expect(result.fact_id).toMatch(/^ds-2026-001@[0-9a-f]{12}$/);
    expect(result.sha256_digest).toMatch(/^[0-9a-f]{64}$/);

    // 账本记录变为已消费（契约 v2：include_consumed 查询，审批链形态）
    const queried = await connection.request("ledger_query", { scope_ref: SCOPE_REF, include_consumed: true });
    expect(queried.ok).toBe(true);
    if (queried.ok) {
      const records = (queried.value as { records: LedgerRecord[] }).records;
      expect(records).toHaveLength(1);
      expect(records[0]?.record_id).toBe(recordId);
      expect(records[0]?.approval_id).toMatch(/^apr-/);
      expect(records[0]?.sequence).toBe(1);
      expect(records[0]?.state).toBe("consumed");
    }

    // 重复调用同 request → block（一次性消费语义）
    const replay = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(replay.kind).toBe("blocked");
    if (replay.kind === "blocked") {
      expect(replay.block.reason).toBe("approval_missing");
      expect(replay.block.exit_code).toBe(78);
    }
  });

  it("atf_gate：预录后 advance——无证据 → blocked（reason_codes 内业务信号）；准入证据后 → pass", async () => {
    const { connection, executor } = await makeExecutor();
    const gateParams = { gate: "G2", action: "advance" as const };

    await recordApproval(connection, "atf_gate", gateParams);
    const noEvidence = await executor.execute("atf_gate", gateParams);
    expect(noEvidence.kind).toBe("executed");
    if (noEvidence.kind === "executed") {
      expect((noEvidence.result as { status?: string }).status).toBe("blocked");
      expect((noEvidence.result as { reason_codes?: string[] }).reason_codes).toEqual(["evidence_missing"]);
    }

    // 准入一条事实（预录 + 执行），再预录并推进闸门 → pass
    await recordApproval(connection, "atf_admit_data", ADMIT_PARAMS);
    await executor.execute("atf_admit_data", ADMIT_PARAMS);
    await recordApproval(connection, "atf_gate", gateParams);
    const withEvidence = await executor.execute("atf_gate", gateParams);
    expect(withEvidence.kind).toBe("executed");
    if (withEvidence.kind === "executed") {
      expect((withEvidence.result as { status?: string }).status).toBe("pass");
    }
  });

  it("账本查询默认只返回可消费记录：include_consumed 缺省不回已消费记录（契约 v2 变更 #4）", async () => {
    const { connection, executor } = await makeExecutor();
    await recordApproval(connection, "atf_admit_data", ADMIT_PARAMS);
    await executor.execute("atf_admit_data", ADMIT_PARAMS); // 消费唯一记录

    const defaultQuery = await connection.request("ledger_query", { scope_ref: SCOPE_REF });
    expect(defaultQuery.ok).toBe(true);
    if (defaultQuery.ok) expect((defaultQuery.value as { records: unknown[] }).records).toHaveLength(0);
  });
});

describe("S3 验收（反例 1）——无预录 → blocked(approval_missing) → exit 78", () => {
  it("无预录 admit_data → blocked，exit_code 78；resolveHeadlessExitCode 锚点 = 78", async () => {
    const { executor } = await makeExecutor();

    const blocked = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind !== "blocked") return;
    expect(blocked.block.reason).toBe("approval_missing");
    expect(blocked.block.exit_code).toBe(78);
    expect(blocked.block.tool).toBe("atf_admit_data");
    expect(resolveHeadlessExitCode(blocked)).toBe(78);
    expect(resolveHeadlessExitCode({ kind: "executed", tool: "x", result: null })).toBe(0);
  });

  it("只读工具免审批：无预录 fact_scan / workspace_status 直接 executed", async () => {
    const { executor } = await makeExecutor();

    const scan = await executor.execute("atf_fact_scan", {});
    expect(scan.kind).toBe("executed");
    if (scan.kind === "executed") expect((scan.result as { count?: number }).count).toBe(0);

    const status = await executor.execute("atf_workspace_status", {});
    expect(status.kind).toBe("executed");
    if (status.kind === "executed") {
      expect((status.result as { run_id?: string }).run_id).toBe("mock-run-1");
      expect((status.result as { scope_ref?: ScopeRef }).scope_ref).toEqual({
        project_id: "mock-project",
        scope_type: "run",
        scope_id: "mock-run-1",
        scope_mode: "headless",
      });
    }
  });
});

describe("S3 补充语义——canonical 反例 / 对端拒绝 / 参数白名单 / unknown_tool / 桥接故障 / scope_ref 缺省（fail-closed）", () => {
  it("对端响应缺 required 字段（--corrupt-output）→ failed(schema_violation)，不猜测成功", async () => {
    const { executor } = await makeExecutor("--corrupt-output=atf_workspace_status");
    const outcome = await executor.execute("atf_workspace_status", {});
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.error.code).toBe("schema_violation");
    expect(outcome.error.message).toContain("canonical output 校验失败");
    expect(outcome.error.message).toContain("ok");
  });

  it("对端业务拒绝（--reject-method，ok=false）→ rejected 结构化回填，非 harness 故障", async () => {
    const { executor } = await makeExecutor("--reject-method=atf_fact_scan");
    const outcome = await executor.execute("atf_fact_scan", {});
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe("gate_rejected");
    expect(resolveHeadlessExitCode(outcome)).toBe(1);
  });

  it("参数违反模型可见 schema（缺 required / 多余字段）→ input_violation(schema_violation)，不触桥接（快修批 D-a R-1：入参点位独立类别，供 runner 回流）", async () => {
    const requests: string[] = [];
    const countingTransport: BridgeTransport = {
      request: async (method: string) => {
        requests.push(method);
        return { ok: false, error: { code: "request_rejected", message: "不应触达（计数桩）" } as BridgeError };
      },
    };
    const executor = new ToolExecutor(countingTransport, ToolRegistry.createDefault());

    const missing = await executor.execute("atf_admit_data", { source_ref: "no-dataset-id" });
    expect(missing.kind).toBe("input_violation");
    if (missing.kind === "input_violation") {
      expect(missing.reason).toBe("schema_violation");
      expect(JSON.stringify(missing.detail)).toContain("dataset_id");
    }

    const extra = await executor.execute("atf_fact_scan", { evil_param: 1 });
    expect(extra.kind).toBe("input_violation");
    if (extra.kind === "input_violation") {
      expect(extra.reason).toBe("schema_violation");
      expect(JSON.stringify(extra.detail)).toContain("evil_param");
    }
    expect(requests.length).toBe(0); // 未触桥接（E2 点位在桥接请求之前）
  });

  it("registry 外工具 → failed(unknown_tool)；注册表恰为契约 4 工具（owner 口径 #5）", async () => {
    const { executor } = await makeExecutor();

    const ghost = await executor.execute("atf_deploy_to_production", {});
    expect(ghost.kind).toBe("failed");
    if (ghost.kind === "failed") expect(ghost.error.code).toBe("unknown_tool");

    expect(ToolRegistry.createDefault().names()).toEqual([
      "atf_admit_data",
      "atf_gate",
      "atf_fact_scan",
      "atf_workspace_status",
    ]);
  });

  it("桥接层故障透传：连接未就绪 → failed(bridge_failure)；审批面查询失败同样 fail-closed", async () => {
    const closedTransport: BridgeTransport = {
      request: async (): Promise<Result<unknown, BridgeError>> => err({ code: "closed", message: "连接尚未就绪" }),
    };
    const executor = new ToolExecutor(closedTransport, ToolRegistry.createDefault(), SCOPE_REF);

    const readonlyOutcome = await executor.execute("atf_fact_scan", {});
    expect(readonlyOutcome.kind).toBe("failed");
    if (readonlyOutcome.kind === "failed") expect(readonlyOutcome.error.code).toBe("bridge_failure");

    // 须审批工具：ledger_query 即失败 → 无法确认授权状态 → failed（不猜测审批通过）
    const gatedOutcome = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(gatedOutcome.kind).toBe("failed");
    if (gatedOutcome.kind === "failed") expect(gatedOutcome.error.code).toBe("bridge_failure");
  });

  it("契约 v2：scope_ref 缺省 → 须审批工具 failed(scope_ref_missing)，fail-closed 不猜测", async () => {
    const transport: BridgeTransport = {
      request: async (): Promise<Result<unknown, BridgeError>> => err({ code: "closed", message: "连接尚未就绪" }),
    };
    const executor = new ToolExecutor(transport, ToolRegistry.createDefault()); // 未注入 scope_ref
    const outcome = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error.code).toBe("scope_ref_missing");
      expect(outcome.error.message).toContain("scope_ref");
    }
  });
});
