/**
 * L1b B7 N1：atf_gate 审批按 action 分派（owner 裁定 2026-09-17）。
 * query（只读）免审批自主执行——含未知 gate 名（对端 unknown_gate 结果直返模型、零弹窗）；
 * advance（推进）仍须审批（问答轨）；admit_data 不变；MCP 面同一 executor 同语义。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BridgeTransport, requiresApprovalFor, TOOL_DEFINITIONS, ToolExecutor, ToolRegistry } from "../../src/core/tools/index.js";
import { AtfBridgeConnection, type BridgeError } from "../../src/bridge/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scopeRef = {
  project_id: "agentic-training-flow",
  scope_type: "run",
  scope_id: `b7-gate-${randomUUID()}`,
  scope_mode: "canonical",
};

class SpyTransport implements BridgeTransport {
  public readonly methods: string[] = [];
  public handlerCalls = 0;
  public seed: Array<Record<string, unknown>> = [];

  public async request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }> {
    this.methods.push(method);
    if (method === "ledger_query") {
      return { ok: true, value: { ok: true, records: this.seed } };
    }
    if (method === "atf_gate") {
      // mock 语义：未知 gate 名 → 对端业务拒绝（unknown_gate 结果直返模型）
      const gate = (params as { gate?: string }).gate;
      if (gate === "zzz-not-a-gate") {
        return { ok: false, error: { code: "request_rejected" as const, message: "unknown_gate", detail: { code: "unknown_gate" } } };
      }
      return { ok: true, value: { ok: true, gate, status: "pass" } };
    }
    return { ok: false, error: { code: "protocol_error" as const, message: `桩未实现: ${method}` } };
  }
}

const executorOf = (transport: SpyTransport): ToolExecutor =>
  new ToolExecutor(transport, ToolRegistry.createDefault(), scopeRef);

const gateHandlerOf = (transport: SpyTransport) => ({
  handler: async (input: { tool: string; params: unknown; approval_key: string }) => {
    transport.handlerCalls += 1;
    return { kind: "granted" as const };
  },
});

describe("B7 N1：gate 审批按 action 分派", () => {
  it("谓词面：query 免审批；advance/缺 action 须审批；其余工具旗标不变", () => {
    const gate = TOOL_DEFINITIONS.find((definition) => definition.name === "atf_gate");
    const admit = TOOL_DEFINITIONS.find((definition) => definition.name === "atf_admit_data");
    const scan = TOOL_DEFINITIONS.find((definition) => definition.name === "atf_fact_scan");
    expect(gate).toBeDefined();
    expect(requiresApprovalFor(gate!, { gate: "g1", action: "query" })).toBe(false);
    expect(requiresApprovalFor(gate!, { gate: "g1", action: "advance" })).toBe(true);
    expect(requiresApprovalFor(gate!, { gate: "g1" })).toBe(true); // 缺 action = fail-closed 按须审批
    expect(requiresApprovalFor(admit!, {})).toBe(true);
    expect(requiresApprovalFor(scan!, {})).toBe(false);
  });

  it("gate(query)：零账本请求、零审批调用、直执行（自主只读）", async () => {
    const transport = new SpyTransport();
    const outcome = await executorOf(transport).execute(
      "atf_gate", { gate: "g1", action: "query" },
      gateHandlerOf(transport),
    );
    expect(outcome.kind).toBe("executed");
    expect(transport.methods).toEqual(["atf_gate"]); // 无 ledger_query/consume（免审批）
    expect(transport.handlerCalls).toBe(0); // 零弹窗
  });

  it("未知 gate 名 query：零弹窗，unknown_gate 结果直返模型（rejected 结构化回填）", async () => {
    const transport = new SpyTransport();
    const outcome = await executorOf(transport).execute(
      "atf_gate", { gate: "zzz-not-a-gate", action: "query" },
      gateHandlerOf(transport),
    );
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" ? outcome.reason : "").toBe("unknown_gate");
    expect(transport.handlerCalls).toBe(0);
    expect(transport.methods).toEqual(["atf_gate"]);
  });

  it("gate(advance)：仍须审批（handler 被调用；账本查询在先——账本轨优先不变）", async () => {
    const transport = new SpyTransport();
    const outcome = await executorOf(transport).execute(
      "atf_gate", { gate: "g1", action: "advance" },
      gateHandlerOf(transport),
    );
    expect(outcome.kind, JSON.stringify(outcome)).toBe("executed");
    expect(transport.methods).toEqual(["ledger_query", "atf_gate"]); // 账本轨查询在先（无预录→问答轨；无消费）
    expect(transport.handlerCalls).toBe(1);
  });
});

describe("B7 N1：MCP 面同语义（真实 mock 对端，同一 executor）", () => {
  it("query 免审批直执行；advance 走问答轨（mcp 通道留痕）", async () => {
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockPath, "--no-auto-bind"] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    const connection = spawned.value;
    try {
      const executor = new ToolExecutor(connection, ToolRegistry.createDefault(), scopeRef);
      let qaCalls = 0;
      const gate = { handler: async () => { qaCalls += 1; return { kind: "granted" as const }; } };

      const query = await executor.execute("atf_gate", { gate: "g1", action: "query" }, gate);
      expect(query.kind).toBe("executed");
      expect(qaCalls).toBe(0); // 免审批

      const unknown = await executor.execute("atf_gate", { gate: "zzz-not-a-gate", action: "query" }, gate);
      // mock 契约忠实化（三件小批 D-1/D-2）：未收录 gate 名 → unknown_gate 结构化回填（rejected）
      expect(unknown.kind).toBe("rejected");
      if (unknown.kind === "rejected") expect(unknown.reason).toBe("unknown_gate");
      expect(qaCalls).toBe(0); // 零弹窗（本断言为本例要点）

      const advance = await executor.execute("atf_gate", { gate: "g1", action: "advance" }, gate);
      expect(advance.kind).toBe("executed");
      expect(qaCalls).toBe(1); // advance 仍须审批（本例账本无预录 → 问答轨放行）
    } finally {
      await connection.close().catch(() => undefined);
    }
  });
});
