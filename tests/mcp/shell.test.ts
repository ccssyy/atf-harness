/**
 * MCP server 外壳 E2E（L1 门 2 T05）：RpcPeer 客户端桩 ↔ McpShell 双向互连（PassThrough，
 * 内核桥接 = 真实 mock 夹具子进程）。覆盖：initialize 版本轴协商／tools/list 恰 7 工具
 * （D11）／绑定界（未绑定 isError、重复绑定拒绝）／只读与高危工具治理（账本轨 miss →
 * 问答轨 mcp 通道留痕 D4）／账本工具直通／退出码进 tool result／审计流落盘。
 */
import { PassThrough } from "node:stream";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  preauthPath?: string;
  close: () => void;
}

const setupFixture = async (options?: { preauthTools?: readonly string[]; preauthHost?: string; badSchemaVersion?: boolean }): Promise<Fixture> => {
  const runsRoot = await mkdtemp(join(tmpdir(), "mcp-shell-test-"));
  let preauthPath: string | undefined;
  if (options?.preauthTools !== undefined || options?.badSchemaVersion === true) {
    preauthPath = join(runsRoot, "mcp-preauth.json");
    const body = options.badSchemaVersion === true
      ? { schema_version: "McpPreauth/v0-bad", hosts: [{ host_id: options.preauthHost ?? "workbuddy-test", tools: ["atf_admit_data"] }] }
      : { schema_version: "McpPreauth/v1", hosts: [{ host_id: options.preauthHost ?? "workbuddy-test", tools: options.preauthTools ?? ["atf_admit_data"] }] };
    await writeFile(preauthPath, JSON.stringify(body), { mode: 0o600 });
    await chmod(preauthPath, 0o600);
  }
  const clientToShell = new PassThrough();
  const shellToClient = new PassThrough();
  const shell = new McpShell({
    runsRoot,
    mockCommand: ["node", mockPath],
    hostId: "workbuddy-test",
    ...(preauthPath !== undefined ? { preauthPath } : {}),
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
    ...(preauthPath !== undefined ? { preauthPath } : {}),
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

  it("治理（白名单内）：gate(query) 免预授权；admit 经问答轨放行且留痕 pre_authorization（D4+D1=A），退出码进 result", async () => {
    const fixture = await setupFixture({ preauthTools: ["atf_admit_data", "atf_gate"] });
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
      // L1b B1：写类（admit）留 pre_authorization；非写类（gate query）不带该位
      //（approval/response 不含工具名——经 request_event_ref 反查对应 approval/request 的 tool）
      const responseTool = (response: Record<string, unknown>): string | null => {
        const ref = (response["payload"] as { request_event_ref?: number }).request_event_ref;
        const request = stream.find((event) => event["type"] === "approval/request" && event["id"] === ref);
        return request === undefined ? null : ((request["payload"] as { tool?: string }).tool ?? null);
      };
      const admitResponse = responses.find((response) => responseTool(response) === "atf_admit_data");
      expect(admitResponse).toBeDefined();
      expect((admitResponse?.["payload"] as Record<string, unknown>)["pre_authorization"]).toBe(true);
      const gateResponse = responses.find((response) => responseTool(response) === "atf_gate");
      expect(gateResponse).toBeDefined();
      expect((gateResponse?.["payload"] as Record<string, unknown>)["pre_authorization"]).toBeUndefined();
      // 审计流：tool/call 与 tool/result 逐对配对（call_ref）
      const calls = stream.filter((event) => event["type"] === "tool/call");
      const results = stream.filter((event) => event["type"] === "tool/result");
      expect(calls.length).toBe(results.length);
    } finally {
      fixture.close();
    }
  });

  it("B1 默认拒绝（L1b-D1=A）：无白名单 admit/gate(advance) 三段式拒绝且不写 approval/request；gate(query) 不受管辖", async () => {
    const fixture = await setupFixture(); // 无 preauthPath → fail-closed 空白名单
    try {
      await handshake(fixture.client);
      await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-b1" });

      const admit = await callTool(fixture.client, "atf_admit_data", { dataset_id: "ds-b1" });
      expect(admit.isError).toBe(true);
      expect(admit.body["exit_code"]).toBe(1);
      expect(admit.body["reason"]).toBe("mcp_write_not_preauthorized");
      const detail = admit.body["detail"] as string;
      expect(detail).toContain("①写动作被默认拒绝（未执行）");
      expect(detail).toContain("②原因");
      expect(detail).toContain("③修复：在");
      expect(detail).toContain('"host_id":"workbuddy-test"');

      const advance = await callTool(fixture.client, "atf_gate", { gate: "g1", action: "advance" });
      expect(advance.isError).toBe(true);
      expect(advance.body["reason"]).toBe("mcp_write_not_preauthorized");

      // gate(query) 只读：不受白名单管辖，经问答轨照常放行
      const query = await callTool(fixture.client, "atf_gate", { gate: "g1", action: "query" });
      expect(query.isError).toBe(false);

      const stream = await readStream(fixture.runsRoot, "mcp-run-b1");
      // 默认拒绝路径不触发审批链（被拒调用无任何 approval/request|response）
      for (const deniedTool of ["atf_admit_data", "atf_gate"]) {
        const deniedRequests = stream.filter(
          (event) => event["type"] === "approval/request" && JSON.stringify(event["payload"]).includes(`"tool":"${deniedTool}"`),
        );
        // gate 仅有 query 的审批（advance 被拒无审批）；admit 无审批
        if (deniedTool === "atf_admit_data") {
          expect(deniedRequests.length).toBe(0);
        } else {
          const advanceRequests = deniedRequests.filter((event) => (event["payload"] as { params?: { action?: string } }).params?.action === "advance");
          expect(advanceRequests.length).toBe(0);
        }
      }
      const refusal = stream.find((event) => event["type"] === "tool/result" && JSON.stringify(event["payload"]).includes("mcp_write_not_preauthorized"));
      expect(refusal).toBeDefined();
    } finally {
      fixture.close();
    }
  });

  it("B1 fail-closed：配置 schema_version 非法 → 视同空白名单全拒绝", async () => {
    const fixture = await setupFixture({ badSchemaVersion: true, preauthTools: ["atf_admit_data"] });
    try {
      await handshake(fixture.client);
      await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-b1b" });
      const admit = await callTool(fixture.client, "atf_admit_data", { dataset_id: "ds-b1b" });
      expect(admit.isError).toBe(true);
      expect(admit.body["reason"]).toBe("mcp_write_not_preauthorized");
    } finally {
      fixture.close();
    }
  });

  it("B1 gate(advance) 白名单内放行（写类经预授权）", async () => {
    const fixture = await setupFixture({ preauthTools: ["atf_admit_data", "atf_gate"] });
    try {
      await handshake(fixture.client);
      await callTool(fixture.client, "atf_bind_run", { run_id: "mcp-run-b1c" });
      const advance = await callTool(fixture.client, "atf_gate", { gate: "g1", action: "advance" });
      // mock 对端业务面允许 advance（canonical status 或 blocked 均为业务事实；此处断言非白名单拒绝）
      expect(advance.body["reason"]).not.toBe("mcp_write_not_preauthorized");
      const stream = await readStream(fixture.runsRoot, "mcp-run-b1c");
      const advanceRequest = stream.find(
        (event) => event["type"] === "approval/request" && (event["payload"] as { tool?: string; params?: { action?: string } }).tool === "atf_gate" && (event["payload"] as { params?: { action?: string } }).params?.action === "advance",
      );
      expect(advanceRequest).toBeDefined();
      const advanceResponse = stream.find((event) => event["type"] === "approval/response" && (event["payload"] as { request_event_ref?: number }).request_event_ref === advanceRequest?.["id"]);
      expect(advanceResponse).toBeDefined();
      expect((advanceResponse?.["payload"] as Record<string, unknown>)["pre_authorization"]).toBe(true);
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
