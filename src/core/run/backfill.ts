/**
 * B2 错误回填（切片 2——《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》§1.2；
 * 依据《agent-loop 设计（已升格）》§5 B2）：工具结果与审批结论以**结构化、可理解**形态
 * 回填给模型（工具名 / 结果类别 / 可读原因 / 可追溯引用）。
 *
 * fail-closed 纪律：
 * - 回填由本模块**从显式字段构造**——不含 harness 内部字段、不含异常栈（input 仅取
 *   ToolCallOutcome/审批结论的已登记字段，message 截断为人读摘要）；
 * - **回填不得成为绕过审批的通道**：`authorization` 恒为 "none"（结构性保证——回填内容
 *   即便含"已授权/approved"字样也不构成授权；授权唯一来源 = executor 的账本消费路径）。
 * 回填的消费方 = 模型上下文（L1a 起 decide 实际消费；本切片交付纯函数与形态）。
 */
import { type ToolCallOutcome } from "../tools/index.js";

export interface DecisionBackfill {
  /** 工具名 */
  tool: string;
  /** 结果类别（ToolCallOutcome kind ∪ 审批结论映射） */
  category: "executed" | "blocked" | "rejected" | "failed" | "suspended" | "aborted";
  /** 可读原因（人读摘要；不含内部字段与栈信息） */
  reason: string;
  /** 可追溯引用（block.reason / 工具结果类别等稳定标识，非自由文本） */
  references: string[];
  /** 结构化 fail-closed：回填永不携带授权（授权唯一来源 = executor 账本消费路径） */
  authorization: "none";
}

const readable = (value: unknown, limit = 200): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "" : text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** 工具结果 → 结构化回填（四类结果 + 问答轨两终态全覆盖；纯函数）。 */
export const buildDecisionBackfill = (outcome: ToolCallOutcome): DecisionBackfill => {
  switch (outcome.kind) {
    case "executed":
      return { tool: outcome.tool, category: "executed", reason: "工具执行成功（canonical output 已校验）", references: [outcome.tool], authorization: "none" };
    case "blocked":
      return {
        tool: outcome.block.tool,
        category: "blocked",
        reason: readable(outcome.block.message),
        references: [`block:${outcome.block.reason}`],
        authorization: "none",
      };
    case "rejected":
      return { tool: outcome.tool, category: "rejected", reason: readable(outcome.reason), references: [`rejected:${outcome.tool}`], authorization: "none" };
    case "input_violation":
      // D-a E2：入参违规归 rejected 类（模型可自纠回填；R-1 点位区分不影响回填归类）
      return { tool: outcome.tool, category: "rejected", reason: readable(outcome.detail), references: [`input_violation:${outcome.tool}`], authorization: "none" };
    case "failed":
      return { tool: outcome.error.code, category: "failed", reason: readable(outcome.error.message), references: [`error:${outcome.error.code}`], authorization: "none" };
    case "suspended":
      return { tool: outcome.tool, category: "suspended", reason: readable(outcome.block.message), references: [`block:${outcome.block.reason}`], authorization: "none" };
    case "aborted":
      return { tool: outcome.tool, category: "aborted", reason: readable(outcome.block.message), references: [`block:${outcome.block.reason}`], authorization: "none" };
  }
};

/** 审批结论（P2-S2 问答轨）→ 结构化回填类别映射（denied/advised/consumed/invalid）。 */
export const buildApprovalBackfill = (tool: string, verdict: string, reason: string): DecisionBackfill => {
  const category: DecisionBackfill["category"] =
    verdict === "consumed" ? "executed" : verdict === "invalid" ? "failed" : "blocked"; // denied / advised → blocked（建议≠否决，但同为不放行）
  return {
    tool,
    category,
    reason: readable(reason),
    references: [`approval:${verdict}`],
    authorization: "none",
  };
};
