/**
 * 前端一（自有 UI · TUI）——两阶段确认卡（L1c 提前批 A2，2026-09-22；设计要点 §(二)）。
 *
 * 形态判定：**新增「确认卡」形态；载体复用 B8**（过程流多行渲染＋普通输入行应答，零擦除）；
 * **审批轨一字不动**——确认卡＝请示（缺输入），审批＝放行（CAS 高危闸），两道人审不互替；
 * atf_style_cluster_execute / atf_data_admission_request 发起时仍走既有审批链。
 *
 * 触发（tui.ts 挂点）：turn 收口后（completed／turn_failed）且本 turn 末次
 * atf_preparation_propose 成功结果携带 cluster_params_template / policy_template；
 * 不 turn 内阻塞（propose 纯读免审批，turn 内拦会误伤合法复查）；不劫持输入
 * （跳过卡＝直接输入其他指令）。
 *
 * 内容源纪律：**模板回显单源**（推荐值＝内核模板值）＋内核 explanation（语义）；
 * harness 只做呈现层标签表（中文名＋一句含义——文案不是第二权威；值闭集零复制，
 * 漂移由内核 invalid_params fail-closed 拦截如实暴露）。划分模板置 null 的工程待定字段
 * **不向用户要值**（"由 Agent 按模板规则补全，实际值在审批弹窗回显"——owner 21:38 原则：
 * 用户不碰参数名）。
 *
 * 确认保真三道防线（§(二).5）：① harness 译码——确认文本由本模块生成（canonicalConfirmationText，
 * 逐字段精确值），落 user/message，不经模型转写用户口语；② 逐字复制指引——文本内嵌指令，
 * A1 后模板全量可见；③ 内核闭集校验＋审批弹窗逐参数中文回显（approvalCopy）＋与确认卡
 * 只读一致性比对（confirmationEchoLine——只提示、不拦截、不改写）。
 */
import { CLUSTER_PARAM_LABELS } from "../core/tools/index.js";

export type ConfirmCardKind = "cluster" | "split";

export interface ConfirmCard {
  kind: ConfirmCardKind;
  /** 登记身份 "<dataset_id>@<pin>"（模板单源） */
  factId: string;
  /** 模板（cluster_params_template 或 policy_template 原对象——推荐值单源） */
  template: Record<string, unknown>;
}

interface FieldLabel {
  label: string;
  meaning: string;
}

/** 聚类六键呈现层标签表＝core/tools 单源（CLUSTER_PARAM_LABELS，approvalCopy 逐参数回显
 *  与本卡共用——防双表漂移）。 */
export const CLUSTER_FIELD_LABELS: Readonly<Record<string, FieldLabel>> = CLUSTER_PARAM_LABELS;

/** 划分模板已知键标签表；未知键回落键名原文（模板单源，不猜语义）。 */
export const SPLIT_FIELD_LABELS: Readonly<Record<string, FieldLabel>> = {
  target_ratios: { label: "划分比例", meaning: "各分区样本比例（默认 训练:测试 = 8:2，可改）" },
  style_cluster_assignment_ref: { label: "分层依据", meaning: "按已落料的版式聚类产物分层" },
  policy_id: { label: "策略标识", meaning: "待定——由 Agent 按模板规则补全，审批弹窗回显" },
  seed: { label: "随机种子", meaning: "待定——由 Agent 按模板规则补全，审批弹窗回显" },
};

const PLAIN_OBJECT = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 从 propose 成功结果识别确认卡（stage／模板字段判定；无模板 → null——不弹卡）。 */
export const confirmCardFromResult = (result: unknown): ConfirmCard | null => {
  if (!PLAIN_OBJECT(result)) return null;
  const factId = typeof result["fact_id"] === "string" ? (result["fact_id"] as string) : "";
  if (factId === "") return null;
  if (result["stage"] === "cluster_confirmation" && PLAIN_OBJECT(result["cluster_params_template"])) {
    return { kind: "cluster", factId, template: result["cluster_params_template"] as Record<string, unknown> };
  }
  if (result["stage"] === "split_confirmation" && PLAIN_OBJECT(result["policy_template"])) {
    return { kind: "split", factId, template: result["policy_template"] as Record<string, unknown> };
  }
  return null;
};

const labelOf = (card: ConfirmCard, key: string): FieldLabel => {
  const table = card.kind === "cluster" ? CLUSTER_FIELD_LABELS : SPLIT_FIELD_LABELS;
  return table[key] ?? { label: key, meaning: "" };
};

const formatValue = (value: unknown): string => JSON.stringify(value) ?? "";

/** 卡片可编辑字段（null 待定字段不可编辑——不向用户要值）。 */
export const cardFields = (card: ConfirmCard): Array<{ key: string; label: string; meaning: string; valueText: string; editable: boolean }> =>
  Object.entries(card.template).map(([key, value]) => {
    const { label, meaning } = labelOf(card, key);
    return {
      key,
      label,
      meaning,
      valueText: formatValue(value),
      editable: value !== null,
    };
  });

/** 确认卡 → 过程流多行（人读中文＋推荐值；值单源＝模板回显）。
 *  参数值行**不适用工程语静默滤除**：模板回显值＝用户确认的对象本身（bbox_layout_v1/
 *  auto_candidates 类取值正是将提交内核的闭集值），滤除即无法确认——同 notes[]/内核
 *  human 层容忍口径；卡头/说明行为 harness 文案，构造即人读。 */
export const confirmCardLines = (card: ConfirmCard): string[] => {
  const title = card.kind === "cluster" ? "版式聚类参数" : "数据划分策略";
  const lines: string[] = [];
  lines.push(`┌─ 确认卡 · ${title}（数据集 ${card.factId}）`);
  if (card.kind === "cluster") {
    lines.push("│ 聚类把版面相似的样本页归为一类，划分时同类保持在同一分区（训练/测试都覆盖各类版式）。");
  } else {
    lines.push("│ 划分把已登记样本分入训练/测试分区；有聚类料时按版式分层，训练与测试都覆盖各类版式。");
  }
  lines.push("│ 推荐参数（内核模板，可直接采用）：");
  for (const field of cardFields(card)) {
    const valueText = field.editable ? field.valueText : "（由 Agent 按模板规则补全）";
    lines.push(`│   · ${field.label}：${valueText}`);
  }
  lines.push("└─ 应答（1=按推荐确认 2=逐项修改；直接输入其他指令＝跳过）");
  return lines;
};

/**
 * 逐项修改的取值解析：空输入＝保留现值；target_ratios 支持 "7:3" 简写（按键序映射到模板
 * 现有键——键名单源＝模板，harness 不自造）；其余输入可 JSON 解析则用解析值，否则原样字符串。
 */
export const applyFieldInput = (card: ConfirmCard, key: string, input: string, current: Record<string, unknown>): Record<string, unknown> => {
  const trimmed = input.trim();
  const next = { ...current };
  if (trimmed === "") {
    next[key] = card.template[key];
    return next;
  }
  const templateValue = card.template[key];
  if (key === "target_ratios" && PLAIN_OBJECT(templateValue) && /^\d+(\.\d+)?\s*[:：]\s*\d+(\.\d+)?$/.test(trimmed)) {
    const parts = trimmed.split(/[:：]/).map((part) => Number(part.trim()));
    const sum = parts.reduce((acc, part) => acc + part, 0);
    if (sum > 0 && parts.length === Object.keys(templateValue).length) {
      const ratios: Record<string, number> = {};
      Object.keys(templateValue).forEach((ratioKey, index) => {
        ratios[ratioKey] = Number(((parts[index] as number) / sum).toFixed(6));
      });
      next[key] = ratios;
      return next;
    }
  }
  try {
    next[key] = JSON.parse(trimmed) as unknown;
  } catch {
    next[key] = trimmed;
  }
  return next;
};

const formatFieldValueList = (card: ConfirmCard, confirmed: Record<string, unknown>): string =>
  Object.keys(card.template)
    .map((key) => `${key}=${formatValue(confirmed[key] ?? card.template[key])}`)
    .join("、");

/** 比例的人读比式（7:3 形态；非数值键值时回落 JSON 形态）。 */
const ratiosText = (value: unknown): string => {
  if (!PLAIN_OBJECT(value)) return formatValue(value);
  const entries = Object.entries(value);
  if (entries.every(([, item]) => typeof item === "number")) {
    return `${entries.map(([, item]) => String(Math.round((item as number) * 100))).join(":")}（百分比）`;
  }
  return formatValue(value);
};

/**
 * harness 译码（三道防线之一）：确认应答 → 规范化确认文本（逐字段精确值）。
 * 该文本作为下一 turn 的用户指令落 user/message——模型按内嵌指令逐字复制发起写调用。
 */
export const canonicalConfirmationText = (card: ConfirmCard, confirmed: Record<string, unknown>): string => {
  if (card.kind === "cluster") {
    return `【确认卡·聚类参数】数据集 ${card.factId} 聚类参数已逐项确认：${formatFieldValueList(card, confirmed)}。` +
      "请以上述值逐字作为 cluster_params 六键发起 atf_style_cluster_execute（勿改动、勿增删键）。";
  }
  const pendingKeys = Object.keys(card.template).filter((key) => card.template[key] === null);
  const pendingNote = pendingKeys.length > 0
    ? `模板中置 null 的待定字段（${pendingKeys.join("、")}）由你按模板规则补全，实际值将在审批弹窗逐项回显。`
    : "";
  const ratios = confirmed["target_ratios"] ?? card.template["target_ratios"];
  return `【确认卡·划分策略】数据集 ${card.factId} 划分策略已确认：划分比例 ${ratiosText(ratios)}。` +
    `请以上述确认值构造 split_policy 完整 payload（骨架以 atf_preparation_propose 回显的 policy_template 为基准，含 ${formatFieldValueList(card, confirmed)}）发起 atf_data_admission_request。${pendingNote}`;
};

/**
 * 审批弹窗一致性回显（三道防线之三；只提示、不拦截、不改写）：
 * 写调用到达审批点时，与其来源确认卡的确认值逐键比对——一致/不一致/无关联卡（null）。
 */
export const confirmationEchoLine = (
  tool: string,
  params: unknown,
  card: ConfirmCard | null,
  confirmed: Record<string, unknown> | null,
): string | null => {
  if (card === null || confirmed === null) return null;
  const relevant = (card.kind === "cluster" && tool === "atf_style_cluster_execute") || (card.kind === "split" && tool === "atf_data_admission_request");
  if (!relevant) return null;
  const submitted = PLAIN_OBJECT(params)
    ? card.kind === "cluster"
      ? params["cluster_params"]
      : params["split_policy"]
    : undefined;
  if (!PLAIN_OBJECT(submitted)) return "（注意：与确认卡不一致——调用未携带确认的参数对象）";
  const diffs: string[] = [];
  for (const key of Object.keys(card.template)) {
    if (card.template[key] === null) continue; // 待定字段由 Agent 补全，不比
    const expected = confirmed[key] ?? card.template[key];
    const actual = submitted[key];
    if (formatValue(expected) !== formatValue(actual)) {
      diffs.push(`${labelOf(card, key).label}：确认 ${formatValue(expected)} → 实际 ${formatValue(actual ?? "(缺键)")}`);
    }
  }
  if (diffs.length === 0) return "（与确认卡一致）";
  return `（注意：与确认卡不一致——${diffs.join("；")}）`;
};
