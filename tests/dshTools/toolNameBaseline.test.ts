import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFINITIONS } from "@atf/dsh-atf-core";
import { WORKSPACE_TOOL_DEFINITIONS } from "@atf/dsh-atf-core";
import { TOOL_METHOD_OVERRIDES } from "@atf/dsh-atf-core";
import { MODEL_TOOL_NAMES } from "../../packages/extensions/atf-tools/src/mcpToolFace.js";

/**
 * D6 机检（G5 MCP 切换批）：模型可见工具名集合与切换前逐字一致。
 *
 * 基线（tests/dshTools/toolNameBaseline.json）在切换前由 collectBaseline.mjs 从
 * 源码单源采集：mcpModelTools=TOOL_DEFINITIONS 全部 9 件（与内核 15 方法的模型面
 * 9 件经 rpcMethodFor 点→下划线映射逐字一一对应）；localWorkspaceTools=装配面
 * 本地治理 5 件（不经内核）。切换后 MCP 注册名必须逐字复现 mcpModelTools。
 *
 * 内核 15 方法名（KERNEL_METHODS）作为期望常量写在测试里——这是断言数据
 * （对照 G1 内核 session/tools.py registry 逐字清单），不是产品 schema 复制。
 */

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "dshTools", "toolNameBaseline.json"), "utf8"),
) as {
  mcpModelTools: string[];
  localWorkspaceTools: string[];
};

/** 内核 15 方法注册名（G1 基线逐字——session/tools.py registry.register）。 */
const KERNEL_METHODS = [
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
] as const;

/** 非模型面内部方法（任务书路标：由 handler 链式调用，不进模型工具面）。 */
const INTERNAL_METHODS = new Set([
  "atf.bind_run",
  "atf.bind_workspace",
  "ledger_query",
  "ledger_consume",
  "ledger_record",
  "atf_flow_anchor",
]);

const rpcMethodFor = (toolName: string): string => TOOL_METHOD_OVERRIDES[toolName] ?? toolName;

describe("G5 D6 工具名基线机检", () => {
  it("基线文件与 TOOL_DEFINITIONS 名集逐字一致（切换前锚）", () => {
    expect([...TOOL_DEFINITIONS.map((d) => d.name)]).toEqual(baseline.mcpModelTools);
  });

  it("基线文件与装配面本地治理件逐字一致", () => {
    const workspaceNames = new Set(WORKSPACE_TOOL_DEFINITIONS.map((d) => d.name));
    expect(MODEL_TOOL_NAMES.filter((n) => workspaceNames.has(n))).toEqual(baseline.localWorkspaceTools);
  });

  it("基线 9 件经 rpcMethodFor 映射 = 内核 15 方法的模型面子集（逐字）", () => {
    const mapped = baseline.mcpModelTools.map(rpcMethodFor);
    for (const method of mapped) {
      expect(KERNEL_METHODS).toContain(method);
      expect(INTERNAL_METHODS.has(method)).toBe(false);
    }
    // 反向闭包：模型面方法 = 15 - 内部 6，映射必须恰覆盖
    const modelSide = KERNEL_METHODS.filter((m) => !INTERNAL_METHODS.has(m));
    expect([...mapped].sort()).toEqual([...modelSide].sort());
  });

  it("映射表仅含点号方法且目标都在内核 15 方法内（防漂移）", () => {
    for (const [tool, method] of Object.entries(TOOL_METHOD_OVERRIDES)) {
      expect(baseline.mcpModelTools).toContain(tool);
      expect(KERNEL_METHODS).toContain(method);
      expect(method.includes(".")).toBe(true);
    }
  });
});
