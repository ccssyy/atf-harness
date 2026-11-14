/**
 * L1b B5：ledger_query operation_id 透传（§9⑤ 立项切片，澄清范围）。
 *
 * ① executor seam（ADR-0022 后）：approve 账本授权轨退役——execute 直通执行，
 *    零 ledger_query/ledger_consume；operation_id 契约参数保留（对端过滤行为见②）；
 * ② mock 对端过滤行为：ledger_record 存 operation_id → ledger_query 按 operation_id
 *    过滤（命中/不命中两态）——对端支持实证（不支持即停红线未触发）；
 * ③ MCP tools/list：ledger_query inputSchema 含可选 operation_id（沿用契约，不另造）。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BridgeTransport, ToolExecutor, ToolRegistry } from "../../src/core/tools/index.js";
import { AtfBridgeConnection, type BridgeError } from "../../src/bridge/index.js";
import { mcpToolDescriptors } from "../../src/mcp/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

/** 捕获 ledger_query 请求参数的桩 transport（须审批工具 atf_admit_data 走审批链）。 */
class CapturingTransport implements BridgeTransport {
  public readonly queries: Array<Record<string, unknown>> = [];
  public readonly consumed: Array<Record<string, unknown>> = [];
  public seed: Array<Record<string, unknown>> = [];

  public async request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }> {
    if (method === "ledger_query") {
      this.queries.push(params as Record<string, unknown>);
      return { ok: true, value: { ok: true, records: this.seed } };
    }
    if (method === "ledger_consume") {
      this.consumed.push(params as Record<string, unknown>);
      return { ok: true, value: { ok: true, record_id: "rec-001", state: "consumed" } };
    }
    // 审批链命中后工具执行：atf_admit_data 走到执行面的最小回执
    if (method === "atf_admit_data") {
      return {
        ok: true,
        value: { ok: true, journal_type: "dataset-registry", fact_id: "f-1", sha256_digest: "a".repeat(64) },
      };
    }
    return { ok: false, error: { code: "protocol_error" as const, message: `桩未实现: ${method}` } };
  }
}

describe("B5：executor operation_id 透传（两态）", () => {
  it("带/不带 operationId → 均直通执行，零账本查询零消费（ADR-0022 账本授权轨退役）", async () => {
    const records = [{ record_id: "rec-001", approval_id: "apr-001", sequence: 1, state: "approved" }];
    const withId = new CapturingTransport();
    withId.seed = records;
    const executor = new ToolExecutor(withId, ToolRegistry.createDefault(), {
      project_id: "p", scope_type: "run", scope_id: "r", scope_mode: "canonical",
    });
    const outcome = await executor.execute(
      "atf_admit_data", { dataset_id: "ds-b5" },
      { handler: async () => ({ kind: "granted" as const }) },
      { operationId: "op-42" },
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe("executed");
    expect(withId.queries.length).toBe(0);
    expect(withId.consumed.length).toBe(0);

    const withoutId = new CapturingTransport();
    withoutId.seed = records;
    const executor2 = new ToolExecutor(withoutId, ToolRegistry.createDefault(), {
      project_id: "p", scope_type: "run", scope_id: "r", scope_mode: "canonical",
    });
    const outcome2 = await executor2.execute(
      "atf_admit_data", { dataset_id: "ds-b5" },
      { handler: async () => ({ kind: "granted" as const }) },
    );
    expect(outcome2.kind).toBe("executed");
    expect(withoutId.queries.length).toBe(0);
    expect(withoutId.consumed.length).toBe(0);
  });
});

describe("B5：mock 对端 operation_id 过滤行为（对端支持实证）", () => {
  it("ledger_record 存 operation_id → ledger_query 按其过滤（命中 1 条／不命中 0 条）", async () => {
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockPath, "--no-auto-bind"] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    const connection = spawned.value;
    try {
      const scopeRef = {
        project_id: "agentic-training-flow",
        scope_type: "run",
        scope_id: `b5-op-${randomUUID()}`,
        scope_mode: "canonical",
      };
      const recorded = await connection.request("ledger_record", {
        scope_ref: scopeRef,
        run_id: scopeRef.scope_id, // §13.0：显式 run_id 优先于会话绑定（本例 spawn --no-auto-bind）
        command_id: "cmd-op-filter",
        actor: "test-setup",
        operation_id: "op-target",
        attempt_id: "1",
        subject_ref: "atf_admit_data:setup",
        evidence_refs: ["b".repeat(64)],
      });
      expect(recorded.ok, recorded.ok ? "" : JSON.stringify(recorded.error)).toBe(true);

      const hit = await connection.request("ledger_query", { scope_ref: scopeRef, operation_id: "op-target" });
      expect(hit.ok).toBe(true);
      if (!hit.ok) throw new Error("unreachable");
      // K4 形态：record_id = approval-record:<subject_ref>:<序号>；ledger_query 缺省只回可消费（approved）
      expect((hit.value as { records: unknown[] }).records.length).toBe(1);

      const miss = await connection.request("ledger_query", { scope_ref: scopeRef, operation_id: "op-other" });
      expect(miss.ok).toBe(true);
      if (!miss.ok) throw new Error("unreachable");
      expect((miss.value as { records: unknown[] }).records.length).toBe(0);
    } finally {
      await connection.close().catch(() => undefined);
    }
  });
});

describe("B5：MCP ledger_query 入参暴露（沿用契约，不另造）", () => {
  it("tools/list 的 ledger_query inputSchema 含可选 operation_id；非 required", () => {
    const descriptor = mcpToolDescriptors().find((tool) => tool.name === "ledger_query");
    expect(descriptor).toBeDefined();
    const schema = descriptor?.inputSchema as { required: string[]; properties: Record<string, { type: string }> };
    expect(schema.required).toContain("scope_ref");
    expect(schema.properties["operation_id"]?.type).toBe("string");
    expect(schema.required).not.toContain("operation_id");
  });
});
