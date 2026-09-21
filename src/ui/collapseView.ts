/**
 * 前端一（自有 UI · TUI）——turn 收口统一渲染（D-f 批 D-f-2/D-f-6，2026-09-21）。
 *
 * 纯函数行构造器：输入 TurnFailureSummary，输出过程流行数组——D-1 的 turn_failed
 * 存活分支与 D-f 新增四类收口（budget_exhausted／provider_failure／same_call_repeat／
 * no_progress）共用同一版式。呈现纪律（v4 定稿 §三 D-f-2 / 门 1 设计 (b)）：
 *   - 不显示步数（steps_used 仅 payload 机查；用户可见维度＝已用轮次）；
 *   - 缺口卡仅文字＋分行，不引入交互控件（交互层归 L1c）；
 *   - 一次一问语义由收口行自身承载（说明卡点与所需输入），不加追问逻辑。
 * 同源纪律：行内容只由 summary 本体推导（core 投影面投出的已落盘事实），零新增载荷来源。
 */
import { type TurnFailureSummary } from "../core/run/index.js";

/** turn 收口 → 过程流行（不含「────」分隔头——由调用方按序插入）。 */
export const collapseLines = (summary: TurnFailureSummary): string[] => {
  const lines: string[] = [];
  lines.push(`原因码=${summary.reason}——本 turn 已收口、run 未终止（输入新指令即可继续）`);
  const blocked = summary.blocked_description;
  if (blocked !== undefined) {
    lines.push(`卡在哪：${blocked.stuck_at}（本 run 已用 ${String(blocked.turns_used)} 轮）`);
  }
  for (const call of summary.rejected ?? []) {
    lines.push(`  - ${call.tool} reason=${call.reason} params_digest=${call.params_digest.slice(0, 16)}…`);
  }
  if (summary.cut_tools !== undefined && summary.cut_tools.length > 0) {
    lines.push(`本 turn 已切断工具：${summary.cut_tools.join("、")}（新 turn 自动恢复）`);
  }
  if (summary.hint.gate_ids !== undefined) {
    lines.push(`合法 GateId 清单：${summary.hint.gate_ids.join(" / ")}`);
  }
  const card = summary.gap_card;
  if (card !== undefined) {
    lines.push("── 缺口卡（需要你的输入）──");
    lines.push(`① 卡在哪：${card.stuck}`);
    lines.push(`② 缺什么：${card.missing}`);
    lines.push(`③ 为什么需要：${card.why}`);
    if (card.options.length > 0) {
      lines.push("④ 可选项：");
      for (const option of card.options) {
        lines.push(`   - ${option.text}${option.recommended === true ? "（推荐）" : ""}`);
      }
    } else {
      lines.push("④ 可选项：暂无自然选项——如实停止并等待指示");
    }
  }
  lines.push(summary.hint.note);
  return lines;
};
