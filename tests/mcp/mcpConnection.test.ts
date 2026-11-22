import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { AtfMcpConnection } from "../../packages/extensions/atf-tools/src/mcp/connection.js";

/**
 * G5 MCP 连接器单测（mock 双协议夹具的 MCP 面）——帧分帧/请求关联/超时/
 * 串行队列/优雅关闭/崩溃回收。对端=tests/fixtures/mock_atf.mjs（首帧
 * initialize 探测进 MCP 模式），行为注入旗标沿用旧面。
 */

const repoRoot = process.cwd();
const mockArgv = (flags: string[] = []): string[] => ["node", join(repoRoot, "tests", "fixtures", "mock_atf.mjs"), ...flags];

const spawnMock = (flags: string[], options?: { requestTimeoutMs?: number }) =>
  AtfMcpConnection.spawn({
    command: mockArgv(flags),
    cwd: repoRoot,
    ...(options?.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
  });

describe("G5 MCP 连接器（mock 对端）", () => {
  it("spawn → initialize 握手：version=serverInfo（name/version/protocolVersion）", async () => {
    const spawned = await spawnMock([]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.version?.name).toBe("atf-mock");
    expect(typeof spawned.value.version?.version).toBe("string");
    expect(spawned.value.version?.protocolVersion).toBe("2025-06-18");
    await spawned.value.close();
  }, 20_000);

  it("tools/list：15 方法名逐字（内核 15 方法闭集）", async () => {
    const spawned = await spawnMock([]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const listed = await spawned.value.listTools();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((tool) => tool.name)).toEqual([
      "atf.bind_run",
      "atf.bind_workspace",
      "atf_workspace_status",
      "atf_fact_scan",
      "atf_gate",
      "atf_admit_data",
      "atf_data_admission.request",
      "atf_preparation.propose",
      "atf_style_cluster.execute",
      "atf_label_qc.inspect",
      "atf_label_qc.resolve",
      "ledger_query",
      "ledger_consume",
      "ledger_record",
      "atf_flow_anchor",
    ]);
    await spawned.value.close();
  }, 20_000);

  it("request 成功：callTool → ok(structuredContent)（内核 result 本体）", async () => {
    const spawned = await spawnMock([]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const bound = await spawned.value.request("atf.bind_run", { run_id: "run-mcp-1" });
    expect(bound.ok).toBe(true);
    expect(bound.ok && bound.value).toMatchObject({ ok: true, run_id: "run-mcp-1" });
    const status = await spawned.value.request("atf_workspace_status", {});
    expect(status.ok).toBe(true);
    await spawned.value.close();
  }, 20_000);

  it("request 业务错误：isError → request_rejected，detail=内核错误体（reason=detail.code）", async () => {
    const spawned = await spawnMock(["--no-auto-bind"]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const status = await spawned.value.request("atf_workspace_status", {});
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe("request_rejected");
    const detail = status.error.detail as { code?: string; message?: string };
    expect(detail.code).toBe("no_run_bound");
    await spawned.value.close();
  }, 20_000);

  it("request 参数非法：JSON-RPC -32602 → request_rejected + detail.code=invalid_params（旧 reason 语义保持）", async () => {
    const spawned = await spawnMock([]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    // atf_label_qc.resolve 缺 actor/report_digest/decisions → 内核侧 invalid_params 翻 -32602
    const rejected = await spawned.value.request("atf_label_qc.resolve", { dataset_id: "ds-x" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("request_rejected");
    const detail = rejected.error.detail as { code?: string };
    expect(detail.code).toBe("invalid_params");
    await spawned.value.close();
  }, 20_000);

  it("请求超时：timeout 码回填，连接随后仍可关闭", async () => {
    const spawned = await spawnMock(["--delay-response=2500"], { requestTimeoutMs: 300 });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const slow = await spawned.value.request("atf_workspace_status", {});
    expect(slow.ok).toBe(false);
    if (slow.ok) return;
    expect(slow.error.code).toBe("timeout");
    const closed = await spawned.value.close();
    expect(closed.ok).toBe(true);
  }, 20_000);

  it("串行队列：并发 3 请求各自正确关联（无串包）", async () => {
    const spawned = await spawnMock([]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const results = await Promise.all([
      spawned.value.request("atf.bind_run", { run_id: "run-a" }),
      spawned.value.request("atf.bind_run", { run_id: "run-b" }),
      spawned.value.request("atf.bind_run", { run_id: "run-c" }),
    ]);
    expect(results.map((r) => (r.ok ? (r.value as { run_id?: string }).run_id : `err:${r.error.code}`))).toEqual([
      "run-a",
      "run-b",
      "run-c",
    ]);
    await spawned.value.close();
  }, 20_000);

  it("对端崩溃：首业务请求触崩 → 在途/后续请求 peer_exit 回收", async () => {
    const spawned = await spawnMock(["--crash-on-second-request"]);
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    // initialize=第 1 条 served（通知不计）；首个业务请求即第 2 条 → mock 崩溃
    const first = await spawned.value.request("atf.bind_run", { run_id: "run-x" });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(["peer_exit", "closed", "protocol_error"]).toContain(first.error.code);
    const after = await spawned.value.request("atf_workspace_status", {});
    expect(after.ok).toBe(false);
    if (after.ok) return;
    // 连接态冻结后保留首因（peer_exit）——后续调用 fail-closed 直回同因
    expect(["peer_exit", "closed"]).toContain(after.error.code);
  }, 20_000);

  it("spawn 失败：command 不可执行 → spawn_failed", async () => {
    const spawned = await AtfMcpConnection.spawn({ command: ["/nonexistent/atf-mcp-peer"] });
    expect(spawned.ok).toBe(false);
    if (spawned.ok) return;
    expect(spawned.error.code).toBe("spawn_failed");
  }, 20_000);
});
