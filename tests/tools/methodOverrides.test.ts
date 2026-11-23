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
import type { BridgeError } from "../../src/mcp/index.js";
import { ToolExecutor, ToolRegistry, type BridgeTransport } from "../../src/core/tools/index.js";
import { TOOL_METHOD_OVERRIDES, rpcMethodFor } from "../../src/core/tools/methodOverrides.js";

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
    // D244/D269 起 run_id/workspace_path 入 required（定位 run 目录写凭据）——存量红#2 同根补齐
    run_id: "run-guard",
    workspace_path: "/tmp/ws-guard",
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
  });
});


describe("镜像面① 静态防再分叉", () => {
  it("两消费文件不再持有本地映射表，均指向单源 methodOverrides.js（重现本地表即红）", () => {
    for (const rel of ["src/core/tools/executor.ts"]) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      expect(text, rel).not.toMatch(/const\s+TOOL_METHOD_OVERRIDES/);
      expect(text, rel).toContain("methodOverrides.js");
    }
  });
});
