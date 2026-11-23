/**
 * F5 改动四 4.1（2026-09-26）——confirm 型请示（抽取契约发布确认）核心。
 *
 * 缺陷（F5 指令 §一）：v077g4 实证 user-confirmation.json 由模型伪造（倒填时间戳），
 * 发布面只做存在性校验即放行——确认凭据无真人确认背书。本模块给 harness 侧补上
 * 「真人确认」的确定性通道：
 *   ① 卡面——确认报告（prompt 实文/字段序/分组/坐标策略）渲染为用户可读卡面
 *     （renderConfirmRequestLines；单源呈现，长文本截断留痕）；
 *   ② 落账——确认经问答轨（approval/request → approval/response，approval_session_id），
 *     应答本身即账面记录（两道人审不互替：确认＝请示落账，发布调用审批＝放行闸）；
 *   ③ 凭据——确认成立后确定性合成 user_confirmation（by/at 取自应答事件，candidate_digest
 *     由 harness 对候选文件复算，approval_ref＝approval_session_id 随凭据下发；内核侧
 *     仅透传落账与格式校验，真实性对账在 harness——对齐 F5 改动一 1.3）。
 *
 * 纪律：本模块零 fs、零桥接——文件读取归 workspace handler（host 注入）；凭据只由
 * harness 从账面应答事件合成，不经模型转写（确认保真同 confirmCard 三道防线口径）。
 */
import { canonicalDigestHex } from "./canonicalDigest.js";

/** 无生产者字段声明（E15b 卡面消费形态；候选单源＝field_projection.unproduced_targets，
 *  内核四键 {field_id,reason,declared_by,declared_at}——卡面只取三键，declared_at 留内核）。 */
export interface UnproducedField {
  field_id: string;
  reason: string;
  declared_by: string;
}

/** 确认报告投影（build_contract_confirmation_report.py 输出的 harness 消费形态；
 *  深形态归内核——harness 只取卡面渲染所需字段，不做第二权威）。 */
export interface ContractConfirmationReport {
  /** 卡面标题（缺省「抽取契约发布确认」） */
  title?: string;
  /** Prompt 实文（训练/评估双 Prompt 全文，按提交顺序） */
  prompt_texts: string[];
  /** 字段序（候选契约的实际字段清单，顺序敏感——空字段序即空心报告，拒绝渲染） */
  field_ids: string[];
  /** 字段分组（可选；与 field_ids 同序或不给） */
  field_groups?: string[];
  /** 坐标策略声明（如 pixel——与 label_semantics 对账归内核） */
  coordinate_policy: string;
  /** 无生产者字段（E15b——业务要、数据零页的显式声明；仅非空时卡面出现该节。
   *  单源＝候选契约 field_projection.unproduced_targets，缺省不传＝卡面零该节） */
  unproduced_fields?: UnproducedField[];
  /** 报告文件引用（workspace 相对路径；inline 形态可缺省） */
  report_ref?: string;
}

/** 确认请求的解析形态（ask_user_for_input(kind=confirm) 的 params 投影）。 */
export interface ConfirmRequestBody {
  kind: "confirm";
  title?: string;
  /** 候选契约 JSON 文件（workspace 相对路径；candidate_digest 由 harness 对该文件复算） */
  candidate_ref: string;
  report_ref?: string;
  prompt_texts?: string[];
  field_ids?: string[];
  field_groups?: string[];
  coordinate_policy?: string;
  /** E15b：本键不收 inline 值（单源＝候选文件 field_projection.unproduced_targets，
   *  handler 解析后回填 report——params 面零新增，避免两个权威）；类型在位仅为
   *  report 投影复用同形。 */
  unproduced_fields?: UnproducedField[];
}

/** 卡面渲染的行内截断上限（超长 prompt 实文截断留痕——卡面是人读面，全文在报告文件）。 */
export const CONFIRM_CARD_PROMPT_CAP_CHARS = 400;

/** 无生产者字段卡面条目上限（E15b——超限截断并注明共 N 项；截断只影响卡面，数据不丢）。 */
export const CONFIRM_CARD_UNPRODUCED_CAP = 20;

/** 无生产者字段节标题（E15b 指令逐字——业务要求、数据零页；本轮未训练输出为空属预期）。 */
export const UNPRODUCED_FIELDS_SECTION_TITLE = "无生产者字段（业务要求、数据零页；本轮未训练，输出为空属预期）";

const PLAIN_OBJECT = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const truncate = (text: string): string =>
  text.length > CONFIRM_CARD_PROMPT_CAP_CHARS
    ? `${text.slice(0, CONFIRM_CARD_PROMPT_CAP_CHARS)}…(截断，全文 ${String(text.length)} 字符见报告文件)`
    : text;

/** 候选文本 → 无生产者字段声明（E15b 单源解析：field_projection.unproduced_targets）。
 *  缺省/空数组 → ok 且 fields 缺省（卡面零该节）；形态非法（非数组/元素缺任一必填键）
 *  → ok:false 带指路消息（调用方 invalid_input 拒绝，不渲染半真卡面）。 */
export const unproducedFieldsFromCandidateText = (
  candidateText: string,
): { ok: true; fields?: UnproducedField[] } | { ok: false; message: string } => {
  const GUIDANCE = "候选契约 field_projection.unproduced_targets 须为 [{field_id,reason,declared_by}]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateText);
  } catch {
    return { ok: false, message: `${GUIDANCE}（候选文件不是合法 JSON）` };
  }
  const projection = PLAIN_OBJECT(parsed) ? parsed["field_projection"] : undefined;
  if (projection === undefined) return { ok: true };
  if (!PLAIN_OBJECT(projection)) return { ok: false, message: `${GUIDANCE}（field_projection 须为对象）` };
  const raw = projection["unproduced_targets"];
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, message: `${GUIDANCE}（得非数组）` };
  if (raw.length === 0) return { ok: true };
  const fields: UnproducedField[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!PLAIN_OBJECT(item)) return { ok: false, message: `${GUIDANCE}（第 ${String(i + 1)} 项须为对象）` };
    const fieldId = item["field_id"];
    const reason = item["reason"];
    const declaredBy = item["declared_by"];
    if (typeof fieldId !== "string" || fieldId === "" || typeof reason !== "string" || reason === "" || typeof declaredBy !== "string" || declaredBy === "") {
      return { ok: false, message: `${GUIDANCE}（第 ${String(i + 1)} 项缺 field_id/reason/declared_by 任一必填键）` };
    }
    fields.push({ field_id: fieldId, reason, declared_by: declaredBy });
  }
  return { ok: true, fields };
};

/** 确认报告收集（handler 侧）：inline 字段与报告文件二选一并集——inline 优先（模型显式
 *  给出的即其提请确认的对象），缺项由报告文件补齐；三要素（prompt_texts/field_ids/
 *  coordinate_policy）任一缺失 → null（fail-closed，不渲染空心卡——F5 §一.3 空心报告禁放行）。 */
export const collectConfirmReport = (body: ConfirmRequestBody, reportFile: unknown): ContractConfirmationReport | null => {
  const file = PLAIN_OBJECT(reportFile) ? reportFile : {};
  const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "") && value.length > 0
      ? (value as string[])
      : undefined;
  const prompt_texts = stringArray(body.prompt_texts) ?? stringArray(file["prompt_texts"]);
  const field_ids = stringArray(body.field_ids) ?? stringArray(file["field_ids"]);
  const field_groups = stringArray(body.field_groups) ?? stringArray(file["field_groups"]);
  const coordinate_policy =
    (typeof body.coordinate_policy === "string" && body.coordinate_policy !== "" ? body.coordinate_policy : undefined) ??
    (typeof file["coordinate_policy"] === "string" && file["coordinate_policy"] !== "" ? (file["coordinate_policy"] as string) : undefined);
  if (prompt_texts === undefined || field_ids === undefined || coordinate_policy === undefined) return null;
  return {
    ...(typeof body.title === "string" && body.title !== "" ? { title: body.title } : {}),
    prompt_texts,
    field_ids,
    ...(field_groups !== undefined ? { field_groups } : {}),
    coordinate_policy,
    ...(typeof body.report_ref === "string" && body.report_ref !== "" ? { report_ref: body.report_ref } : {}),
  };
};

/** 确认卡面（用户可读；长 prompt 实文截断留痕）。digest12＝候选摘要前缀（卡面绑定确认对象）。 */
export const renderConfirmRequestLines = (report: ContractConfirmationReport, candidateDigest: string): string[] => {
  const digest12 = candidateDigest.length >= 12 ? candidateDigest.slice(0, 12) : candidateDigest;
  const lines: string[] = [];
  lines.push(`┌─ 确认卡 · ${report.title ?? "抽取契约发布确认"}（候选 sha256:${digest12}…）`);
  lines.push("│ 请核对本卡与候选契约一致后确认；确认凭据将携带候选内容摘要与审批会话号，随发布件提交内核复算。");
  lines.push(`│ 字段序（${String(report.field_ids.length)} 项）：${report.field_ids.join("、")}`);
  if (report.field_groups !== undefined && report.field_groups.length > 0) {
    lines.push(`│ 字段分组：${report.field_groups.join("、")}`);
  }
  // E15b：无生产者字段节（仅非空出现——缺省/空数组卡面零该节；超限截断注明共 N 项，
  // 截断只影响卡面、声明数据不丢）。
  if (report.unproduced_fields !== undefined && report.unproduced_fields.length > 0) {
    lines.push(`│ ${UNPRODUCED_FIELDS_SECTION_TITLE}——${String(report.unproduced_fields.length)} 项：`);
    for (const field of report.unproduced_fields.slice(0, CONFIRM_CARD_UNPRODUCED_CAP)) {
      lines.push(`│ - ${field.field_id}：${field.reason}（声明人 ${field.declared_by}）`);
    }
    if (report.unproduced_fields.length > CONFIRM_CARD_UNPRODUCED_CAP) {
      lines.push(`│ …共 ${String(report.unproduced_fields.length)} 项`);
    }
  }
  lines.push(`│ 坐标策略：${report.coordinate_policy}`);
  lines.push(`│ Prompt 实文（${String(report.prompt_texts.length)} 份）：`);
  for (let i = 0; i < report.prompt_texts.length; i += 1) {
    lines.push(`│   [${String(i + 1)}] ${truncate(report.prompt_texts[i] as string).replaceAll("\n", "⏎")}`);
  }
  if (report.report_ref !== undefined) lines.push(`│ 报告文件：${report.report_ref}`);
  lines.push("└─ 应答走审批键位（1=确认放行 2=给意见 3=拒绝 4=中止）");
  return lines;
};

/** 候选内容摘要复算（candidate JSON 文本 → 规范化 sha256 hex；解析失败 → null，
 *  handler 折 invalid_input——不猜摘要）。算法＝内核 canonical form（canonicalDigest 单源）。 */
export const candidateDigestFromText = (candidateText: string): string | null => {
  try {
    return canonicalDigestHex(JSON.parse(candidateText));
  } catch {
    return null;
  }
};

/** 确认凭据（user_confirmation；改动一 1.1/1.3 对齐形态）。by/at 取自账面应答事件
 *  （actor/ts——真人应答的账面事实，非本进程时钟编造）；approval_ref＝approval_session_id
 *  （内核仅透传落账与格式校验；真实性对账在 harness/操作面）。 */
export interface UserConfirmation {
  by: string;
  at: string;
  channel: "harness-confirm-card";
  candidate_digest: string;
  approval_ref: string;
}

export const synthesizeUserConfirmation = (input: {
  actor: string;
  answeredAt: string;
  candidateDigest: string;
  approvalSessionId: string;
}): UserConfirmation => ({
  by: input.actor,
  at: input.answeredAt,
  channel: "harness-confirm-card",
  candidate_digest: input.candidateDigest,
  approval_ref: input.approvalSessionId,
});
