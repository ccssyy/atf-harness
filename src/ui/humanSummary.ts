/**
 * 前端一（自有 UI · TUI）——human_summary 人读投影渲染＋呈现层负向校验
 * （K-Gap-2 接线批，2026-09-21；字段表＝owner 裁定方案 A，六键冻结）。
 *
 * 分工纪律（内核门 1 稿 §2.4/§2.5）：内核供语义与人读内容，harness 供版式与交互——
 * 渲染器直用该层，不自行拼工程语言。字段闭集（方案 A）：
 *   headline                string（一句话结论＋影响面量化）
 *   sections[]              {title, items[]}
 *   metrics[]               {label, value}
 *   actions[]               {title, detail, needs_decision}
 *   pending_confirmations[] {title, detail, options?}
 *   notes[]                 string[]（补充与工程细节降级区——技术定位容许，不作主叙述）
 * 「唯一下一动作」＝actions[] 中 needs_decision=false 的首条（防渲染器再猜）。
 *
 * 负向校验（门 1 放行件 §一.6）：面向用户的主叙述行禁直出 reason_code／schema 名／
 * digest／gate 名——确定性检测（64 位 hex、`<Schema>/v数字`、GateId 闭集、snake_case
 * 工程码）；**B 静默口径（L1c 提前批 2026-09-22，owner 11:0x 二次更正）**：命中行对用户
 * **整体静默**——不显示、不解释、不指路（原"已收起；详情见事实日志"降级文案删除；
 * 事实日志审计不受影响，滤除仅呈现层）。产品化判据：回答不了"用户现在需要知道什么/
 * 做什么"的行就不出现。
 * notes[] 属工程细节降级区，按 §2.4 第 5 条容忍技术定位、不作检测对象。
 */
import { GATE_LEGAL_IDS } from "../core/tools/index.js";

export interface HumanSummarySection {
  title: string;
  items: string[];
}
export interface HumanSummaryAction {
  title: string;
  detail: string;
  needs_decision: boolean;
}
export interface HumanSummaryPending {
  title: string;
  detail: string;
  options?: string[];
}
export interface HumanSummary {
  headline: string;
  sections: HumanSummarySection[];
  metrics: Array<{ label: string; value: string }>;
  actions: HumanSummaryAction[];
  pending_confirmations: HumanSummaryPending[];
  notes: string[];
}

const HEX64 = /\b[0-9a-f]{64}\b/;
const SCHEMA_NAME = /\b[A-Z][A-Za-z]+\/v\d+\b/;
const GATE_NAME = ((): RegExp => {
  const escaped = GATE_LEGAL_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?:${escaped.join("|")}|\\bG[1-4]\\b)`);
})();
/** snake_case 工程码（reason_code / split_policy_missing / skills_ready 类）——人读主叙述
 *  应为中文/自然语；Latin 蛇形 token 即工程码泄漏候选。 */
const SNAKE_CODE = /\b[a-z]+(?:_[a-z0-9]+)+\b/;

/** 主叙述行负向校验：命中任一工程形态即视为泄漏（检测器；单源，eventView/确认卡比对共用）。 */
export const engineeringLeak = (line: string): boolean => HEX64.test(line) || SCHEMA_NAME.test(line) || GATE_NAME.test(line) || SNAKE_CODE.test(line);

/** 主叙述行静默滤除（B 口径）：命中 → null（该行整体不出现——不显示、不解释、不指路；
 *  原"已收起/详情见事实日志"降级文案删除；事实日志审计不受影响，滤除仅呈现层）。 */
export const safeHumanLine = (line: string): string | null => (engineeringLeak(line) ? null : line);

/** 结构嗅探（六键闭集；形态不符回落既有渲染——零回归）。 */
export const isHumanSummaryShape = (value: unknown): value is HumanSummary => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["headline"] === "string" &&
    Array.isArray(record["sections"]) &&
    Array.isArray(record["metrics"]) &&
    Array.isArray(record["actions"]) &&
    Array.isArray(record["pending_confirmations"]) &&
    Array.isArray(record["notes"])
  );
};

const safe = (line: string): string | null => safeHumanLine(line);

/** human_summary → 过程流行（六段版式：结论先行→分组→量化→动作→待确认→补充）。
 *  主叙述行过负向校验，命中行/命中段静默滤除（B 口径：不显示不解释不指路）；
 *  notes[] 为工程细节降级区原样呈现。 */
export const humanSummaryLines = (summary: HumanSummary): string[] => {
  const lines: string[] = [];
  const headline = safe(summary.headline);
  if (headline !== null) lines.push(`结论：${headline}`);
  for (const section of summary.sections) {
    const title = safe(section.title);
    if (title !== null) lines.push(`· ${title}`);
    for (const item of section.items) {
      const safeItem = safe(item);
      if (safeItem !== null) lines.push(`    ${safeItem}`);
    }
  }
  for (const metric of summary.metrics) {
    const label = safe(metric.label);
    const value = safe(metric.value);
    if (label !== null && value !== null) lines.push(`· ${label}：${value}`);
  }
  for (const action of summary.actions) {
    const title = safe(action.title);
    if (title === null) continue;
    const suffix = action.needs_decision ? "（需要你决定）" : "";
    lines.push(`→ ${title}${suffix}`);
    if (action.detail !== "") {
      const detail = safe(action.detail);
      if (detail !== null) lines.push(`    ${detail}`);
    }
  }
  for (const pending of summary.pending_confirmations) {
    const title = safe(pending.title);
    if (title === null) continue;
    lines.push(`? ${title}`);
    if (pending.detail !== "") {
      const detail = safe(pending.detail);
      if (detail !== null) lines.push(`    ${detail}`);
    }
    if (pending.options !== undefined && pending.options.length > 0) {
      const safeOptions = pending.options.map((option) => safe(option)).filter((option): option is string => option !== null);
      if (safeOptions.length > 0) lines.push(`    可选：${safeOptions.join("／")}`);
    }
  }
  for (const note of summary.notes) lines.push(`    注：${note}`);
  return lines;
};

/** 「唯一下一动作」提取（actions 中 needs_decision=false 的首条 detail；防渲染器再猜）。 */
export const nextActionOf = (summary: HumanSummary): string | undefined =>
  summary.actions.find((action) => action.needs_decision === false)?.detail;
