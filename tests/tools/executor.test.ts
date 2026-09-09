import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { err, type Result } from "../../src/bridge/index.js";
import type { BridgeError } from "../../src/bridge/errors.js";
import { ToolExecutor, ToolRegistry, resolveHeadlessExitCode, type BridgeTransport } from "../../src/tools/index.js";
import { approvalKeyFor, type LedgerEntry } from "../../src/tools/approvalKey.js";

/**
 * S3 工具执行测试（Phase 1 任务书 §3 验收 + owner 启动指令口径 #1/#3/#4）。
 * 4 个工具方法 + MockLedger（预录/查询/消费/一次性语义）均由契约 mock 对端承载。
 */

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));
const spawnMock = (...flags: string[]) => AtfBridgeConnection.spawn({ command: ["node", mockAtf, ...flags] });

const openConnections: AtfBridgeConnection[] = [];
const track = (connection: AtfBridgeConnection): AtfBridgeConnection => {
  openConnections.push(connection);
  return connection;
};

const makeExecutor = async (...flags: string[]): Promise<{ connection: AtfBridgeConnection; executor: ToolExecutor }> => {
  const spawned = await spawnMock(...flags);
  expect(spawned.ok, spawned.ok ? "" : JSON.stringify(spawned.error)).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  const connection = track(spawned.value);
  return { connection, executor: new ToolExecutor(connection, ToolRegistry.createDefault()) };
};

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const ADMIT_PARAMS = { dataset_id: "ds-2026-001", source: "smoke" };

/** 经桥接在对端 MockLedger 预录一条审批（测试 setup 基建方法）。 */
const recordApproval = async (connection: AtfBridgeConnection, tool: string, params: unknown): Promise<string> => {
  const recorded = await connection.request("ledger_record", approvalKeyFor(tool, params));
  expect(recorded.ok, recorded.ok ? "" : JSON.stringify(recorded.error)).toBe(true);
  if (!recorded.ok) throw new Error("unreachable");
  return (recorded.value as { record_id: string }).record_id;
};

describe("S3 验收（成功用例）——预录 → 执行成功 → 账本已消费 → 重复调用 → block", () => {
  it("atf_admit_data 全生命周期：预录 → executed → consumed=true → 重复 blocked(approval_missing)", async () => {
    const { connection, executor } = await makeExecutor();

    const recordId = await recordApproval(connection, "atf_admit_data", ADMIT_PARAMS);
    expect(recordId).toMatch(/^rec-/);

    const first = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(first.kind).toBe("executed");
    if (first.kind !== "executed") return;
    const result = first.result as { ok?: boolean; journal_type?: string; fact_id?: string; sha256_digest?: string };
    expect(result.ok).toBe(true);
    expect(result.journal_type).toBe("run_journal");
    expect(result.fact_id).toBe("fact-ds-2026-001");
    expect(result.sha256_digest).toMatch(/^[0-9a-f]{64}$/);

    // 账本记录变为已消费
    const queried = await connection.request("ledger_query", approvalKeyFor("atf_admit_data", ADMIT_PARAMS));
    expect(queried.ok).toBe(true);
    if (queried.ok) {
      const entries = (queried.value as { entries: LedgerEntry[] }).entries;
      expect(entries).toHaveLength(1);
      expect(entries[0]?.record_id).toBe(recordId);
      expect(entries[0]?.consumed).toBe(true);
    }

    // 重复调用同 request → block（一次性消费语义）
    const replay = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(replay.kind).toBe("blocked");
    if (replay.kind === "blocked") {
      expect(replay.block.reason).toBe("approval_missing");
      expect(replay.block.exit_code).toBe(78);
    }
  });

  it("atf_gate：预录后 advance——无证据 → blocked（canonical 内业务信号）；准入证据后 → pass", async () => {
    const { connection, executor } = await makeExecutor();
    const gateParams = { gate: "G2", action: "advance" as const };

    await recordApproval(connection, "atf_gate", gateParams);
    const noEvidence = await executor.execute("atf_gate", gateParams);
    expect(noEvidence.kind).toBe("executed");
    if (noEvidence.kind === "executed") {
      expect((noEvidence.result as { status?: string }).status).toBe("blocked");
      expect((noEvidence.result as { reason?: string }).reason).toBe("evidence_missing");
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

  it("只读工具免审批：无预录 surface_scan / workspace_status 直接 executed", async () => {
    const { executor } = await makeExecutor();

    const scan = await executor.execute("atf_surface_scan", {});
    expect(scan.kind).toBe("executed");
    if (scan.kind === "executed") expect((scan.result as { count?: number }).count).toBe(0);

    const status = await executor.execute("atf_workspace_status", {});
    expect(status.kind).toBe("executed");
    if (status.kind === "executed") expect((status.result as { run_id?: string }).run_id).toBe("mock-run-1");
  });
});

describe("S3 补充语义——canonical 反例 / 对端拒绝 / 参数白名单 / unknown_tool / 桥接故障（fail-closed）", () => {
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
    const { executor } = await makeExecutor("--reject-method=atf_surface_scan");
    const outcome = await executor.execute("atf_surface_scan", {});
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe("gate_rejected");
    expect(resolveHeadlessExitCode(outcome)).toBe(1);
  });

  it("参数违反模型可见 schema（缺 required / 多余字段）→ failed(schema_violation)，不触桥接", async () => {
    const { executor } = await makeExecutor();

    const missing = await executor.execute("atf_admit_data", { source: "no-dataset-id" });
    expect(missing.kind).toBe("failed");
    if (missing.kind === "failed") {
      expect(missing.error.code).toBe("schema_violation");
      expect(missing.error.message).toContain("dataset_id");
    }

    const extra = await executor.execute("atf_surface_scan", { evil_param: 1 });
    expect(extra.kind).toBe("failed");
    if (extra.kind === "failed") {
      expect(extra.error.code).toBe("schema_violation");
      expect(extra.error.message).toContain("evil_param");
    }
  });

  it("registry 外工具 → failed(unknown_tool)；注册表恰为契约 4 工具（owner 口径 #5）", async () => {
    const { executor } = await makeExecutor();

    const ghost = await executor.execute("atf_deploy_to_production", {});
    expect(ghost.kind).toBe("failed");
    if (ghost.kind === "failed") expect(ghost.error.code).toBe("unknown_tool");

    expect(ToolRegistry.createDefault().names()).toEqual([
      "atf_admit_data",
      "atf_gate",
      "atf_surface_scan",
      "atf_workspace_status",
    ]);
  });

  it("桥接层故障透传：连接未就绪 → failed(bridge_failure)；审批面查询失败同样 fail-closed", async () => {
    const closedTransport: BridgeTransport = {
      request: async (): Promise<Result<unknown, BridgeError>> => err({ code: "closed", message: "连接尚未就绪" }),
    };
    const executor = new ToolExecutor(closedTransport, ToolRegistry.createDefault());

    const readonlyOutcome = await executor.execute("atf_surface_scan", {});
    expect(readonlyOutcome.kind).toBe("failed");
    if (readonlyOutcome.kind === "failed") expect(readonlyOutcome.error.code).toBe("bridge_failure");

    // 须审批工具：ledger_query 即失败 → 无法确认授权状态 → failed（不猜测审批通过）
    const gatedOutcome = await executor.execute("atf_admit_data", ADMIT_PARAMS);
    expect(gatedOutcome.kind).toBe("failed");
    if (gatedOutcome.kind === "failed") expect(gatedOutcome.error.code).toBe("bridge_failure");
  });
});
