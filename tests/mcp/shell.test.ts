/**
 * MCP server 外壳 E2E（L1 门 2 T05）：RpcPeer 客户端桩 ↔ McpShell 双向互连（PassThrough，
 * 内核桥接 = 真实 mock 夹具子进程）。覆盖：initialize 版本轴协商／tools/list 恰 7 工具
 * （D11）／绑定界（未绑定 isError、重复绑定拒绝）／只读与高危工具治理（账本轨 miss →
 * 问答轨 mcp 通道留痕 D4）／账本工具直通／退出码进 tool result／审计流落盘。
 */
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RpcPeer, type RpcHandlerOutcome } from "../../src/rpc/index.js";
import { McpShell } from "../../src/mcp/shell.js";
import { MCP_METHODS, type McpToolDescriptor } from "../../src/mcp/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

interface Fixture {
  client: RpcPeer;
  runsRoot: string;
  close: () => void;
}

const setupFixture = async (): Promise<Fixture> => {
  const runsRoot = await mkdtemp(join(tmpdir(), "mcp-shell-test-"));
  const clientToShell = new PassThrough();
  const shellToClient = new PassThrough();
  const shell = new McpShell({
    runsRoot,
    mockCommand: ["node", mockPath],
    hostId: "workbuddy-test",
  });
  const shellPeer = RpcPeer.create({
    input: clientToShell,
    output: shellToClient,
    onRequest: shell.handleRequest,
    onNotification: (method) => shell.handleNotification(method),
  });
  const client = RpcPeer.create({ input: shellToClient, output: clientToShell });
  shellPeer.start();
  client.start();
  return {
    client,
    runsRoot,
    close: () => {
      client.close();
      shellPeer.close();
      clientToShell.end();
      shellToClient.end();
    },
  };
};

const initialize = async (client: RpcPeer, protocolVersion = "2025-03-26"): Promise<Record<string, unknown>> => {
  const outcome = await client.request(MCP_METHODS.initialize, {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "workbuddy-test", version: "0.0.1" },
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.result as Record<string, unknown>;
};

/** initialize + notifications/initialized（标准握手序列）。 */
const handshake = async (client: RpcPeer, protocolVersion?: string): Promise<Record<string, unknown>> => {
  const result = await initialize(client, protocolVersion);
  client.notify(MCP_METHODS.initialized, {});
  return result;
};

const callTool = async (client: RpcPeer, name: string, args: Record<string, unknown> = {}): Promise<{ body: Record<string, unknown>; isError: boolean }> => {
  const outcome = await client.request(MCP_METHODS.toolsCall, { name, arguments: args });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`tools/call 协议失败: ${JSON.stringify(outcome.error)}`);
  const result = outcome.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
  return { body, isError: result.isError === true };
};

const listTools = async (client: RpcPeer): Promise<McpToolDescriptor[]> => {
  const outcome = await client.request(MCP_METHODS.toolsList, {});
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return (outcome.result as { tools: McpToolDescriptor[] }).tools;
};

const readStream = async (runsRoot: string, runId: string): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(join(runsRoot, runId, "session.jsonl"), "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("MCP 外壳 E2E（T05）", () => {
  it("initialize：版本轴命中回显／未命中回最新；clientInfo.name → host_id", async () => {
    const fixture = await setupFixture();
    try {
      const hit = await initialize(fixture.client, "2024-11-05");
      expect(hit["protocolVersion"]).toBe("2024-11-05");
      expect((hit["serverInfo"] as Record<string, unknown>)["name"]).toBe("atf-harness-mcp");
      const fixture2 = await setupFixture();
      try {
        const miss = await initialize(fixture2.client, "1999-01-01");
        expect(miss["protocolVersion"]).toBe("2025-03-26");
      } finally {
        fixture2.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("tools/list：恰 7 细粒度工具（D11），工具名沿用桥接契约；inputSchema 无 optional 旁标记", async () => {
    const fixture = await setupFixture();
    try {
      await handshake(fixture.client);
      const tools = await listTools(fixture.client);
      expect(tools.map((tool) => tool.name)).toEqual([
        "atf_bind_run",
        "atf_workspace_status",
        "atf_fact_scan",
        "atf_gate",
        "atf_admit_data",
        "ledger_query",
        "ledger_consume",
      ]);
      const admit = tools.find((tool) => tool.name === "atf_admit_data");
      expect((admit?.inputSchema as { required: string[] })["required"]).toEqual(["dataset_id"]);
      expect(JSON.stringify(admit?.inputSchema)).not.toContain('"optional"');
    } finally {
      fixture.close();
    }
  });

  it("绑定界：未绑定 isError；atf_bind_run 建工作区+审计流；重复绑定拒绝", async () => {
    const fixture = await setupFixture();
    try {
      await handshake(fixture.client);
      const early = await callTool(fixture.client, "atf_workspace_status");
      expect(early.isError).toBe(true);
      expect(early.body["reason"]).toContain("未绑定 run");

      const bound = await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-1" });
      expect(bound.isError).toBe(false);
      expect(bound.body["exit_code"]).toBe(0);
      expect((bound.body["result"] as Record<string, unknown>)["run_id"]).toBe("mcp-run-1");

      const again = await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-2" });
      expect(again.isError).toBe(true);
      expect(again.body["reason"]).toContain("v1 一进程一绑定");

      const stream = await readStream(fixture.runsRoot, "mcp-run-1");
      expect(stream.some((event) => event["type"] === "tool/call" && (event["payload"] as { tool: string }).tool === "atf_bind_run")).toBe(true);
      expect(stream.some((event) => event["type"] === "tool/result" && (event["payload"] as { ok?: boolean }).ok === true)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("治理：只读免审直执行；gate(query) 与 admit 经问答轨 mcp 通道留痕放行（D4），退出码进 result", async () => {
    const fixture = await setupFixture();
    try {
      await handshake(fixture.client);
      await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-3" });

      // 只读：零审批事件
      const status = await callTool(fixture.client, "atf_workspace_status");
      expect(status.isError).toBe(false);
      expect(status.body["exit_code"]).toBe(0);
      const scan = await callTool(fixture.client, "atf_fact_scan");
      expect(scan.isError).toBe(false);

      // 高危：账本轨 miss → 问答轨 → stub 恒 granted 但强制留痕（channel=mcp + host_id + requires_human_review）
      const gate = await callTool(fixture.client, "atf_gate", { gate: "g1", action: "query" });
      expect(gate.isError).toBe(false);
      expect(gate.body["exit_code"]).toBe(0);
      const admit = await callTool(fixture.client, "atf_admit_data", { dataset_id: "ds-mcp-1" });
      expect(admit.isError).toBe(false);
      expect(admit.body["exit_code"]).toBe(0);
      expect((admit.body["result"] as Record<string, unknown>)["journal_type"]).toBe("dataset-registry");

      const stream = await readStream(fixture.runsRoot, "mcp-run-3");
      const responses = stream.filter((event) => event["type"] === "approval/response");
      expect(responses.length).toBe(2); // gate + admit 各一次
      for (const response of responses) {
        const payload = response["payload"] as Record<string, unknown>;
        expect(payload["verdict"]).toBe("granted");
        expect(payload["channel"]).toBe("mcp");
        expect(payload["host_id"]).toBe("workbuddy-test");
        expect(payload["requires_human_review"]).toBe(true);
        expect(payload["actor"]).toBe("mcp-host");
      }
      // 审计流：tool/call 与 tool/result 逐对配对（call_ref）
      const calls = stream.filter((event) => event["type"] === "tool/call");
      const results = stream.filter((event) => event["type"] === "tool/result");
      expect(calls.length).toBe(results.length);
    } finally {
      fixture.close();
    }
  });

  it("账本工具直通：ledger_query 回可消费记录集；未知工具 → -32602", async () => {
    const fixture = await setupFixture();
    try {
      await handshake(fixture.client);
      await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-4" });
      const query = await callTool(fixture.client, "ledger_query", {
        scope_ref: { project_id: "agentic-training-flow", scope_type: "run", scope_id: "mcp-run-4", scope_mode: "canonical" },
      });
      expect(query.isError).toBe(false);
      expect(query.body["exit_code"]).toBe(0);
      expect(Array.isArray((query.body["result"] as { records: unknown[] }).records)).toBe(true);

      const unknown = await fixture.client.request(MCP_METHODS.toolsCall, { name: "atf_run_prompt", arguments: {} });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.error.code).toBe(-32602);
    } finally {
      fixture.close();
    }
  });
});
