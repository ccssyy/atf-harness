import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { AtfMcpConnection } from "../../src/mcp/connection.js";
import { BridgeManager, buildMcpTools } from "../../packages/extensions/atf-tools/src/mcpToolFace.js";

/**
 * G5 真进程链路（装配级端到端）：spawn 真内核 MCP server（G1 手写实现），
 * initialize 握手 → tools/list（15 方法闭集）→ 工厂装配 → callTool 三方法
 * （bind_run/workspace_status/fact_scan）成功返回（D2/D7 行为一致证据）。
 *
 * 门控：env ATF_G5_KERNEL_SRC＝内核仓根（含 src/agentic_training_flow）；
 * 缺席＝本环境无内核副本，整文件 skip（A800 验收时显式设置跑全量）。
 * run/workspace 场景经内核自身 create_run 构造（子进程一次性调用——夹具形态
 * 与内核 tests/mcp/conftest.build_workspace 同源，不复制内核业务逻辑）。
 */

const kernelSrc = process.env["ATF_G5_KERNEL_SRC"];
const d = it.skipIf(kernelSrc === undefined || kernelSrc === "" || !existsSync(join(kernelSrc ?? ".", "src", "agentic_training_flow")));

const childEnv = (): Record<string, string> => ({
  PYTHONPATH: join(kernelSrc ?? ".", "src"),
  PYTHONDONTWRITEBYTECODE: "1",
});

const mcpArgv = (workspace?: string): { command: string[]; cwd: string; env: Record<string, string> } => ({
  command: ["python3", "-m", "agentic_training_flow.mcp"],
  cwd: kernelSrc ?? ".",
  env: workspace !== undefined ? { ...childEnv(), ATF_WORKSPACE_ALLOWLIST: workspace } : childEnv(),
});

/** 内核 create_run 构造 workspace（run 目录+run.json 由内核单源落位）。 */
const makeWorkspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "g5-e2e-ws-"));
  execFileSync(
    "python3",
    [
      "-c",
      "from agentic_training_flow.run_layout import create_run\nimport sys\ncreate_run(__import__('pathlib').Path(sys.argv[1]), 'run-g5-e2e', experiment_id='exp-a')",
      root,
    ],
    { env: { ...process.env, ...childEnv() }, timeout: 30_000 },
  );
  return root;
};

describe("G5 真内核 MCP 链路（ATF_G5_KERNEL_SRC 门控）", () => {
  d("initialize → tools/list：15 方法名逐字（内核注册闭集）+ outputSchema 全携带（A3）", async () => {
    const spawned = await AtfMcpConnection.spawn({ ...mcpArgv() });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.version?.name).toBe("atf-kernel");
    expect(typeof spawned.value.version?.version).toBe("string");
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
    // A3：15 方法成功返回体声明全携带（schema 零复制的装配端实证）
    for (const tool of listed.value) {
      expect(
        tool.outputSchema,
        `tools/list ${tool.name} 缺 outputSchema（A3）`,
      ).toBeDefined();
    }
    await spawned.value.close();
  }, 60_000);

  d("三方法链路：bind_workspace → bind_run → workspace_status → fact_scan 端到端成功", async () => {
    const workspace = makeWorkspace();
    const spawned = await AtfMcpConnection.spawn({ ...mcpArgv(workspace) });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const boundWs = await spawned.value.request("atf.bind_workspace", { workspace_path: workspace });
    expect(boundWs.ok).toBe(true);
    if (!boundWs.ok) return;
    const bound = await spawned.value.request("atf.bind_run", { run_id: "run-g5-e2e" });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(bound.value).toMatchObject({ ok: true, run_id: "run-g5-e2e" });
    const status = await spawned.value.request("atf_workspace_status", {});
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value).toMatchObject({ ok: true });
    }
    const facts = await spawned.value.request("atf_fact_scan", {});
    expect(facts.ok).toBe(true);
    await spawned.value.close();
  }, 60_000);

  d("错误路径：无 run 绑定 → no_run_bound 经 request_rejected 折叠（reason 逐字）", async () => {
    const spawned = await AtfMcpConnection.spawn({ ...mcpArgv() });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    const status = await spawned.value.request("atf_workspace_status", {});
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error.code).toBe("request_rejected");
    const detail = status.error.detail as { code?: string };
    expect(detail.code).toBe("no_run_bound");
    await spawned.value.close();
  }, 60_000);

  d("装配级：buildMcpTools 工厂件（atf_workspace_status）真内核链路——schema 零复制+rejected 回填形态", async () => {
    const workspace = makeWorkspace();
    const argv = mcpArgv(workspace);
    const manager = new BridgeManager(argv.command, argv.cwd, argv.env);
    const ctx = { get: () => undefined };
    const tools = await buildMcpTools(ctx as never, manager, {
      runsRoot: join(workspace, "runs"),
      kernelDir: kernelSrc ?? ".",
      execHome: join(workspace, "exec-home"),
    });
    const names = tools.map((tool) => (tool as { name?: string }).name ?? "");
    expect(names).toContain("atf_workspace_status");
    const statusTool = tools.find((tool) => (tool as { name?: string }).name === "atf_workspace_status") as
      | { name: string; description: string; parameters: unknown; execute: (args: unknown, exec: unknown) => Promise<unknown> }
      | undefined;
    expect(statusTool).toBeDefined();
    if (statusTool === undefined) return;
    // schema 零复制：description 来自 tools/list（内核声明），非本地字面量
    expect(typeof statusTool.description).toBe("string");
    expect(statusTool.description.length).toBeGreaterThan(0);
    // default 连接未绑 run → 内核 no_run_bound → 治理回填形态（reason 逐字——与旧径一致）
    const result = (await statusTool.execute({}, { agent: undefined, callId: "g5-e2e", signal: undefined })) as Record<string, unknown>;
    expect(result).toMatchObject({ tool: "atf_workspace_status", reason: "no_run_bound" });
    await manager.close();
  }, 60_000);
});
