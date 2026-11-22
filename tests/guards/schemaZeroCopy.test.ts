import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * G5 形态条款机检：atf-tools 源码零硬编码复制 15 方法 schema 字面量。
 *
 * 工具 description/inputSchema/outputSchema 全部来自 MCP tools/list 动态拉取
 * （内核 mcp/tools.py 唯一源）——本守卫以「特征片段检索」断言回潮为红：取内核
 * 15 方法声明面的独有特征串（描述开头词/参数枚举闭集/必填键组合），在
 * atf-tools 源码树全文检索，任何命中=第三份声明回潮。
 *
 * 本地治理件（scratch_exec/skill_read/launch_execute/create_experiment/
 * rebind_workspace，harness 自有面、非内核 15 方法）不在检索范围——其定义
 * 单源在 src/core/tools/workspaceTools.ts。
 */

const SRC_ROOT = join(process.cwd(), "packages", "extensions", "atf-tools", "src");

const collectFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
};

/** 内核 15 方法声明面特征片段（取自内核 mcp/tools.py 唯一源的独有串）。 */
const SCHEMA_FINGERPRINTS: ReadonlyArray<{ method: string; needle: string }> = [
  { method: "atf.bind_run", needle: "绑定当前会话的 run（重复绑定覆盖，并留痕）" },
  { method: "atf.bind_workspace", needle: "把会话工作区根切到给定目录" },
  { method: "atf_workspace_status", needle: "只读返回目标 run 的状态：身份、scope_ref、登记计数" },
  { method: "atf_fact_scan", needle: "只读枚举目标 run 可被引用的事实索引" },
  { method: "atf_gate", needle: "闸门名：G1–G4（大小写不敏感）走数据准入闸" },
  { method: "atf_admit_data", needle: "登记数据集资产（显式命名或按双树清单内容寻址派生身份）" },
  { method: "atf_data_admission.request", needle: "对已登记数据集执行真实 source-backed 数据准入" },
  { method: "atf_preparation.propose", needle: "纯读判定数据准备阶段（聚类确认/划分确认）" },
  { method: "atf_style_cluster.execute", needle: "按经确认参数执行确定性版式聚类" },
  { method: "atf_label_qc.inspect", needle: "对已登记数据集做标签级体检（Q1–Q4）" },
  { method: "atf_label_qc.resolve", needle: "提交标签体检裁决批次，累积写不可变裁决产物" },
  { method: "ledger_query", needle: "查询审批链记录（scope_ref 必传）" },
  { method: "ledger_consume", needle: "一次性消费审批记录（CAS，逐值一致校验" },
  { method: "ledger_record", needle: "预录一条人工审批命令并写透至 run 的 facts 日志" },
  { method: "atf_flow_anchor", needle: "纯读返回 run 锚定事实三态（current/stale/missing）" },
];

describe("G5 schema 零复制守卫（atf-tools 源码）", () => {
  it("15 方法 description 特征片段在 atf-tools 源码中零命中（第三份声明防回潮）", () => {
    const sources = collectFiles(SRC_ROOT).map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    }));
    const hits: string[] = [];
    for (const { method, needle } of SCHEMA_FINGERPRINTS) {
      for (const { file, text } of sources) {
        if (text.includes(needle)) hits.push(`${method} → ${file}`);
      }
    }
    expect(hits, `15 方法 schema 字面量回潮：\n${hits.join("\n")}`).toEqual([]);
  });

  it("模型面点号方法名不以字面量形态硬编码进 atf-tools 源码（rawName 单源=rpcMethodFor）", () => {
    const sources = collectFiles(SRC_ROOT).map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    }));
    // 模型面 9 方法中的 5 个点号名——rawName 必经 rpcMethodFor（methodOverrides.ts 单源）。
    // 内部方法（atf.bind_run/atf.bind_workspace/ledger_*）由 handler 链式直调（任务书路标），
    // 字面量调用合法，不在本断言范围。
    const dotted = ["atf_data_admission.request", "atf_preparation.propose", "atf_style_cluster.execute", "atf_label_qc.inspect", "atf_label_qc.resolve"];
    const hits: string[] = [];
    for (const name of dotted) {
      for (const { file, text } of sources) {
        for (const match of text.matchAll(new RegExp(`["'\`]${name.replace(".", "\\.")}["'\`]`, "g"))) {
          hits.push(`${name} 字面量 → ${file}`);
        }
      }
    }
    expect(hits, `模型面点号方法名字面量出现在 atf-tools：\n${hits.join("\n")}`).toEqual([]);
  });
});
