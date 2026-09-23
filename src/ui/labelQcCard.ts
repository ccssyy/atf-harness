/**
 * 前端一（自有 UI · TUI）——标签体检确认卡（R-3 接线批 2026-09-23，owner 裁定 §一.2③）。
 *
 * 载体＝批 2.5/批 3 确认卡同款：过程流多行＋输入行应答，不劫持输入。逐项展示「依据/条款/
 * 出处」（human_label／locator／证据引用；Q2 按裁定 B 整图理解口径展示 image_workspace_ref），
 * 逐项处置按检查类约束的九项 disposition 闭集应答；**未决项（s）绝不默认处置**——只提交
 * 显式确认项（分批 partial）。确认后 A2.5 确定性合成 atf_label_qc_resolve（模型不转写用户
 * 裁决），审批弹窗第二道人审不变。
 *
 * 单源：卡面值＝登记面体检报告（core/labelQc 读取）；disposition 闭集/必填字段＝core 呈现层
 * 镜像（权威内核，漂移由 invalid_params 拦截）。判断主体＝人（judgements basis=user——
 * harness 不代做 multimodal 判定，裁定 B）。
 */
import {
  checkClassShort,
  DISPOSITIONS_BY_CHECK_CLASS,
  REQUIRED_DECISION_FIELDS,
  type LabelQcDecisionDraft,
  type LabelQcDisposition,
  type LabelQcItem,
  type LabelQcReportFile,
} from "../core/workspace/index.js";
import type { PendingConfirmAction } from "../core/run/runner.js";

const digest12 = (digest: string): string => (digest.length >= 12 ? `${digest.slice(0, 12)}…` : digest || "—");

const locatorText = (item: LabelQcItem): string => {
  const parts: string[] = [];
  if (item.locator.sample_id !== undefined && item.locator.sample_id !== "") parts.push(`样本 ${item.locator.sample_id}`);
  if (item.locator.field !== undefined && item.locator.field !== "") parts.push(`字段 ${item.locator.field}`);
  if (item.locator.page !== undefined && item.locator.page !== "") parts.push(`页 ${item.locator.page}`);
  return parts.length > 0 ? parts.join(" · ") : "（报告未给出定位）";
};

const suggestText = (item: LabelQcItem): string => {
  const hint = item.suggested_action?.disposition_hint;
  const actionHint = item.suggested_action?.action_hint;
  if (hint !== undefined && hint !== "") return `按建议处置（${hint}${item.suggested_action?.target_candidate_id !== undefined ? `，保留 ${item.suggested_action.target_candidate_id}` : ""}）`;
  if (actionHint === "review") return "仅复核（内核不下结论，请对照整图判断）";
  return "（无建议）";
};

/** 单项卡面（依据/条款/出处展示；多行，与过程流同一渲染路径）。 */
export const labelQcItemLines = (item: LabelQcItem, index: number, total: number, imageRef: string | null): string[] => [
  `├ 待确认项 ${String(index)}/${String(total)} · ${item.item_id}（${checkClassShort(item.check_class)}）`,
  `│   问题：${item.human_label !== "" ? item.human_label : item.check_class}`,
  `│   出处：${locatorText(item)}`,
  `│   依据：${imageRef !== null ? `整图 ${imageRef}（Q2 按整图理解，可自行打开查看）` : "外部来源样本（无工作区整图引用）"}；证据切片 ${
    item.evidence.length > 0 ? item.evidence.map((entry) => `${entry.kind}:${entry.ref}（${digest12(entry.digest)}）`).join("；") : "（无）"
  }`,
  ...(item.candidates.length > 0
    ? [
        `│   候选：${item.candidates
          .map((entry, position) => `${String.fromCharCode(65 + position)}=${entry.candidate_id} 值=${entry.value}（来源 ${entry.source}）`)
          .join("；")}`,
      ]
    : []),
  `│   内核建议：${suggestText(item)}`,
];

/** 单项应答提示（自选处置菜单＝该检查类允许闭集；accept/modify 处置不含 no_action——维持原状走 2）。 */
export const labelQcItemPrompt = (item: LabelQcItem): string => {
  const allowed = (DISPOSITIONS_BY_CHECK_CLASS[item.check_class as keyof typeof DISPOSITIONS_BY_CHECK_CLASS] ?? []).filter((entry) => entry !== "no_action");
  const hasHint = item.suggested_action?.disposition_hint !== undefined && item.suggested_action?.disposition_hint !== "";
  return `│   应答（${hasHint ? "1=按建议 " : ""}2=维持原状 3=自选处置（${allowed.join("/")}） s=暂不处置）> `;
};

export type LabelQcAnswer =
  | { kind: "suggest" }
  | { kind: "reject" }
  | { kind: "dispose"; disposition: LabelQcDisposition }
  | { kind: "skip" }
  | { kind: "invalid"; message: string };

/** 应答解析（纯函数）：1=按建议（无建议则拒）；2=维持原状（reject）；3=自选（可带处置码）；
 *  s/S=暂不处置。 */
export const parseLabelQcAnswer = (item: LabelQcItem, text: string): LabelQcAnswer => {
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === "s") return { kind: "skip" };
  if (trimmed === "1") {
    const hint = item.suggested_action?.disposition_hint;
    return hint !== undefined && hint !== "" ? { kind: "suggest" } : { kind: "invalid", message: "该项无建议处置，请用 3=自选处置或 2=维持原状" };
  }
  if (trimmed === "2") return { kind: "reject" };
  if (trimmed === "3" || trimmed.startsWith("3 ")) {
    const inline = trimmed.slice(1).trim();
    const allowed = (DISPOSITIONS_BY_CHECK_CLASS[item.check_class as keyof typeof DISPOSITIONS_BY_CHECK_CLASS] ?? []).filter((entry) => entry !== "no_action");
    if (inline === "") return { kind: "invalid", message: `请带处置码，可选：${allowed.join("/")}` };
    if (!(allowed as readonly string[]).includes(inline)) {
      return { kind: "invalid", message: `处置码 ${inline} 越出该检查类允许闭集（可选：${allowed.join("/")}）` };
    }
    return { kind: "dispose", disposition: inline as LabelQcDisposition };
  }
  return { kind: "invalid", message: "无法识别的应答（1=按建议 2=维持原状 3=自选处置 s=暂不处置）" };
};

/** 处置必填附加字段的追问文案（逐字段一次一问）。 */
export const labelQcFieldPrompt = (disposition: string, field: string, item: LabelQcItem): string => {
  if (field === "target_candidate_id") {
    const candidates = item.candidates
      .map((entry, position) => `${String.fromCharCode(65 + position)}=${entry.candidate_id}（值 ${entry.value}）`)
      .join(" / ");
    return `│   保留哪个候选（${candidates !== "" ? candidates : "报告未给候选，请给 candidate_id"}）> `;
  }
  if (field === "keep_ref") return "│   保留项（marks[<下标>] 形态，指明保留哪条标注）> ";
  if (field === "modified_value") return "│   归一后的新值> ";
  if (field === "target_field") return "│   修正后的字段归属> ";
  if (field === "reason_text") return `│   处置理由（${disposition} 必填）> `;
  return `│   ${field}> `;
};

/** 字段应答落草案（纯函数）：target_candidate_id 接受候选字母（A/B→candidate_id）或全 id；
 *  其余字段非空即收（keep_ref 形态由内核 fail-closed 校验）。 */
export const applyLabelQcField = (draft: LabelQcDecisionDraft, field: string, value: string, item: LabelQcItem): LabelQcDecisionDraft => {
  const trimmed = value.trim();
  if (field === "target_candidate_id") {
    const upper = trimmed.toUpperCase();
    const position = upper.charCodeAt(0) - 65;
    const byLetter = trimmed.length === 1 && position >= 0 && position < item.candidates.length ? item.candidates[position]?.candidate_id : undefined;
    draft.target_candidate_id = byLetter ?? trimmed;
    return draft;
  }
  (draft as unknown as Record<string, unknown>)[field] = trimmed;
  return draft;
};

/** 体检确认卡头（摘要行；pending 数以卡面实际列表为准——未决不默认的呈现面）。 */
export const labelQcCardLines = (report: LabelQcReportFile, items: LabelQcItem[], resolvedCount: number): string[] => [
  "┌─ 确认卡 · 标签体检裁决（Q1–Q4 待确认项逐项处置）",
  `│ 数据集：${report.dataset_id}${report.pin !== "" ? `@${report.pin}` : ""}（报告 ${digest12(report.report_digest)}）`,
  `│ 报告检出一共 ${String(report.counts.total_items ?? report.items.length)} 项，已确认 ${String(resolvedCount)} 项，本次待处置 ${String(items.length)} 项。`,
  "│ 请逐项给出处置：未决项请选 s=暂不处置（绝不默认处置）；全部确认前该数据集准入保持阻断。",
  "│ 注意：裁决逐项留痕，原始标注不做任何改写；Q2 归属判断按整图理解（对照整图，判断主体是你）。",
  "└─",
];

/** 确认文本（落 user/message；模型读事实继续流程，不重述用户口语）。 */
export const labelQcConfirmationText = (report: LabelQcReportFile, submitted: number, remaining: number): string =>
  `【确认卡·标签体检】用户已逐项确认 ${String(submitted)} 项裁决（dataset=${report.dataset_id}，report_digest=${report.report_digest}），系统将按确认参数直接提交（不经模型改写）。` +
  (remaining > 0
    ? `尚有 ${String(remaining)} 项未决（保持待确认，未默认处置）；提交后请读返回的 pending_count 并继续引导剩余项。`
    : "本批为全部待确认项；提交成功后可重新请求数据准入。");

/** 确定性合成（A2.5 同构）：确认 → atf_label_qc_resolve 派发动作（无 LLM 参与）。 */
export const synthesizeLabelQcResolveAction = (params: Record<string, unknown>): PendingConfirmAction => ({
  tool: "atf_label_qc_resolve",
  params,
  origin: "confirm_card",
});

/** 处置必填字段序（卡面追问顺序＝内核 REQUIRED_DECISION_FIELDS 声明序）。 */
export const requiredFieldsOf = (disposition: string): readonly string[] =>
  REQUIRED_DECISION_FIELDS[disposition as keyof typeof REQUIRED_DECISION_FIELDS] ?? [];
