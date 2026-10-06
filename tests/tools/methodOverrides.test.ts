/**
 * 镜像面①守护（批㊶-H 共享内核收口）：工具名 → RPC 方法映射单源一致性。
 * 锚：①单源真值（表内容／注册表一致性／恒等折叠）②两线发射一致性——甲线 executor
 * 与丙线 toAtfAgentTool 对全量注册工具名发射同一 RPC 方法（防未来再分叉，本件比
 * 「合并」更重要的产出）③静态防再分叉（两消费文件不得重现本地映射表）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BridgeError } from "../../src/bridge/errors.js";
import { ToolExecutor, ToolRegistry, type BridgeTransport } from "../../src/core/tools/index.js";
import { TOOL_METHOD_OVERRIDES, rpcMethodFor } from "../../src/core/tools/methodOverrides.js";
import { buildAtfAgentTools } from "../../src/agent/atfAgentTools.js";
import { FILE_TOOL_DEFINITIONS } from "../../src/agent/fileTools.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** 过闸入参表（全量注册面逐名可过 checkSchema；甲线审批面由桩账本放行）。 */
const DRIVE_PARAMS: Record<string, unknown> = {
  atf_admit_data: {},
  atf_data_admission_request: { dataset_id: "ds-guard" },
  atf_preparation_propose: { dataset_id: "ds-guard" },
  atf_style_cluster_execute: {
    dataset_id: "ds-guard",
    cluster_params: { algorithm_version: "v1", granularity: "page", metric: "layout", linkage: "ward", threshold: "auto", min_cluster_size: "2" },
  },
  atf_label_qc_inspect: { dataset_id: "ds-guard" },
  atf_label_qc_resolve: {
    dataset_id: "ds-guard",
    actor: "guard",
    report_digest: `sha256:${"a".repeat(64)}`,
    decisions: [{ item_id: "qc-q1-aaaaaaaaaaaa", action: "reject" }],
  },
  atf_gate: { gate: "G2", action: "query" },
  atf_fact_scan: {},
  atf_workspace_status: {},
};

const SCOPE_REF = { project_id: "proj-guard", scope_type: "run", scope_id: "run-guard", scope_mode: "headless" } as const;

describe("镜像面① 单源真值（TOOL_METHOD_OVERRIDES／rpcMethodFor）", () => {
  it("表内容恰为五对点号方法；全部键 ∈ 注册表；表外注册名（含丙线本地治理面）恒等折叠", () => {
    expect({ ...TOOL_METHOD_OVERRIDES }).toEqual({
      atf_data_admission_request: "atf_data_admission.request",
      atf_preparation_propose: "atf_preparation.propose",
      atf_style_cluster_execute: "atf_style_cluster.execute",
      atf_label_qc_inspect: "atf_label_qc.inspect",
      atf_label_qc_resolve: "atf_label_qc.resolve",
    });
    const names = ToolRegistry.createDefault().names();
    for (const key of Object.keys(TOOL_METHOD_OVERRIDES)) {
      expect(names).toContain(key);
      expect(TOOL_METHOD_OVERRIDES[key]).toContain(".");
      expect(rpcMethodFor(key)).toBe(TOOL_METHOD_OVERRIDES[key]);
    }
    for (const name of names) {
      if (!(name in TOOL_METHOD_OVERRIDES)) expect(rpcMethodFor(name), name).toBe(name);
    }
    // 丙线本地治理面（FILE_TOOL_DEFINITIONS）不经桥——恒等折叠同样成立
    for (const definition of FILE_TOOL_DEFINITIONS) expect(rpcMethodFor(definition.name), definition.name).toBe(definition.name);
  });
});

describe("镜像面① 两线发射一致性（防再分叉）", () => {
  it("全量注册工具名：甲线 executor 与丙线 toAtfAgentTool 发射同一 RPC 方法（＝单源 rpcMethodFor）", async () => {
    for (const name of ToolRegistry.createDefault().names()) {
      const params = DRIVE_PARAMS[name];
      expect(params, `守护测试缺驱动参数: ${name}`).toBeDefined();

      // 甲线：executor.execute（须审批工具由桩账本放行；工具方法调用被记录后桩返回离线错误）
      const coreMethods: string[] = [];
      const coreTransport: BridgeTransport = {
        request: async (method: string) => {
          coreMethods.push(method);
          if (method === "ledger_query") {
            return { ok: true, value: { ok: true, records: [{ record_id: "r-guard", approval_id: "apr-guard", sequence: 1, state: "pending" }] } };
          }
          if (method === "ledger_consume") {
            return { ok: true, value: { ok: true, record_id: "r-guard", state: "consumed" } };
          }
          return { ok: false, error: { code: "closed", message: "映射守护桩" } as BridgeError };
        },
      };
      await new ToolExecutor(coreTransport, ToolRegistry.createDefault(), SCOPE_REF).execute(name, params);

      // 丙线：buildAtfAgentTools 装配的 AgentTool execute（工具层无审批——直达桥接调用）
      const agentMethods: string[] = [];
      const agentTransport = {
        request: async (method: string): Promise<{ ok: false; error: BridgeError }> => {
          agentMethods.push(method);
          return { ok: false, error: { code: "closed", message: "映射守护桩" } as BridgeError };
        },
      };
      const [tool] = buildAtfAgentTools({ bridge: agentTransport, scopeRefBox: { current: undefined } }, { names: [name] });
      expect(tool, name).toBeDefined();
      // 桩返回非 request_rejected 桥接错误 → execute 以 throw 折算 error 工具结果（方法已发射）
      await expect(tool?.execute("t-guard", params)).rejects.toThrow();
      const emitted = (methods: string[]): string[] => methods.filter((method) => method !== "ledger_query" && method !== "ledger_consume");
      expect(emitted(coreMethods), `甲线 ${name}`).toEqual([rpcMethodFor(name)]);
      expect(emitted(agentMethods), `丙线 ${name}`).toEqual([rpcMethodFor(name)]);
    }
  });
});

describe("镜像面① 静态防再分叉", () => {
  it("两消费文件不再持有本地映射表，均指向单源 methodOverrides.js（重现本地表即红）", () => {
    for (const rel of ["src/core/tools/executor.ts", "src/agent/atfAgentTools.ts"]) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      expect(text, rel).not.toMatch(/const\s+TOOL_METHOD_OVERRIDES/);
      expect(text, rel).toContain("methodOverrides.js");
    }
  });
});
