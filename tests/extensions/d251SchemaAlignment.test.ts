import { describe, expect, it } from "vitest";
import { TOOL_DEFINITIONS } from "../../src/core/tools/toolDefinition.js";

/**
 * D251 对账围栏（无机检不立规；事故来源=1109-2 真机死循环）：桥接层 fail-closed
 * 校验（bridgeFace D244）要求 atf_label_qc_resolve 必带 run_id+workspace_path，
 * 但 toolDefinition schema 此前未列 workspace_path——模型侧 strict 校验拒绝传
 * schema 外参数 → 报错要求带参数、schema 不让带的死循环（agent 烧 13 分钟无解）。
 *
 * 围栏语义：fail-closed 校验要求的参数，必须在模型可见 schema 的 required 与
 * properties 中同时在场——两处不一致即红（对应 harness 纪律「凡双处一致必配
 * diff=0 断言」）。1108 验收报告预警的「Face 工具 schema vs 桥接/内核不对账」
 * 由此测试钉住 resolve 这一最痛实例。
 */

const resolveTool = TOOL_DEFINITIONS.find((t) => t.name === "atf_label_qc_resolve");

describe("D251 label_qc_resolve schema 与 D244 fail-closed 校验对账", () => {
  it("schema required 含 run_id 与 workspace_path（D244 校验必传参数面）", () => {
    expect(resolveTool).toBeDefined();
    expect(resolveTool!.parameters.required).toContain("run_id");
    expect(resolveTool!.parameters.required).toContain("workspace_path");
  });

  it("schema properties 声明了 workspace_path（模型能传 schema 外参数才会死锁）", () => {
    expect(resolveTool).toBeDefined();
    expect(Object.keys(resolveTool!.parameters.properties)).toContain("workspace_path");
    expect(Object.keys(resolveTool!.parameters.properties)).toContain("run_id");
  });

  it("workspace_path 描述含 fail-fast 语义与绝对路径口径（报错即修复指令对齐）", () => {
    expect(resolveTool).toBeDefined();
    const desc = String(
      (resolveTool!.parameters.properties as Record<string, { description?: string }>)["workspace_path"]?.description ?? "",
    );
    expect(desc).toContain("绝对路径");
    expect(desc).toContain("D244");
  });
});
