/**
 * 标签体检确认卡数据面（R-3 接线批 2026-09-23，owner 裁定 §一.2）。
 *
 * 职责：从登记面**只读**体检报告与裁决产物（TCB：run 数据只读，workspace 相对引用禁越界），
 * 供 TUI 体检确认卡构建「待确认项列表＋依据/条款/出处展示」，并把用户逐项确认的裁决
 * **确定性合成**为 atf_label_qc_resolve 参数（A2.5 同构：模型不重生成参数）。
 *
 * 单源纪律：报告/裁决产物的权威＝内核登记面；`report_digest` 以 inspect 返回值为单源
 * （本模块只在卡面一致性校验用）；九项 disposition 闭集与检查类组合表是**呈现层镜像**
 * （权威在内核 label_qc.py，漂移由内核 invalid_params fail-closed 拦截如实暴露——同
 * approvalCopy.CLUSTER_PARAM_LABELS 的呈现层引用口径）。未决项绝不默认处置：合成 params
 * 只含显式确认项（分批 partial 由内核 §13.14 支持同一 report_digest 增量提交）。
 * 裁定 B：Q2 判断＝整图理解——卡片只展示 `image_workspace_ref`（仅 workspace 内来源给值），
 * harness 不做裁切、不代做 multimodal 判定（judgement basis=user＝人裁决）。
 */
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";

/** 检查类闭集（与内核 label_qc.py ALL_CHECK_CLASSES 逐字对齐）。 */
export const LABEL_QC_CHECK_CLASSES = [
  "q1_same_box_same_value_same_field",
  "q2_same_box_same_value_diff_field",
  "q3_value_box_shape_mismatch",
  "q4_box_out_of_bounds",
] as const;
export type LabelQcCheckClass = (typeof LABEL_QC_CHECK_CLASSES)[number];

/** 九项 disposition 闭集（呈现层镜像；权威＝内核 DISPOSITION_CLOSED）。 */
export const LABEL_QC_DISPOSITIONS = [
  "keep_first",
  "keep_second",
  "keep_both",
  "drop_both",
  "set_value",
  "dedupe",
  "fix_field",
  "clip_to_bounds",
  "no_action",
] as const;
export type LabelQcDisposition = (typeof LABEL_QC_DISPOSITIONS)[number];

/** 检查类 → 允许 disposition 组合闭集（呈现层镜像；权威＝内核 DISPOSITIONS_BY_CHECK_CLASS，
 *  注意内核组合表含 no_action 供 reject 语义；本表供自选处置菜单展示，accept/modify 处置
 *  菜单不含 no_action——维持原状走 reject）。 */
export const DISPOSITIONS_BY_CHECK_CLASS: Readonly<Record<LabelQcCheckClass, readonly LabelQcDisposition[]>> = {
  q1_same_box_same_value_same_field: ["dedupe", "no_action"],
  q2_same_box_same_value_diff_field: ["keep_first", "keep_second", "keep_both", "drop_both", "set_value", "no_action"],
  q3_value_box_shape_mismatch: ["set_value", "fix_field", "drop_both", "no_action"],
  q4_box_out_of_bounds: ["clip_to_bounds", "no_action"],
};

/** disposition → 必填附加字段（呈现层镜像；权威＝内核 REQUIRED_DECISION_FIELDS）。 */
export const REQUIRED_DECISION_FIELDS: Readonly<Record<LabelQcDisposition, readonly string[]>> = {
  dedupe: ["keep_ref"],
  keep_first: ["target_candidate_id"],
  keep_second: ["target_candidate_id"],
  keep_both: ["reason_text"],
  drop_both: ["reason_text"],
  set_value: ["modified_value"],
  fix_field: ["target_field"],
  clip_to_bounds: [],
  no_action: [],
};

export interface LabelQcCandidate {
  candidate_id: string;
  value: string;
  source: string;
}

export interface LabelQcEvidence {
  kind: string;
  ref: string;
  digest: string;
}

export interface LabelQcItem {
  item_id: string;
  check_class: string;
  human_label: string;
  suggested_action: { action_hint?: string; disposition_hint?: string; target_candidate_id?: string };
  locator: { sample_id?: string; page?: string; field?: string };
  evidence: LabelQcEvidence[];
  candidates: LabelQcCandidate[];
}

/** 体检报告卡面投影（LabelQcReport/v1 的最小充分集；深形态校验归内核）。 */
export interface LabelQcReportFile {
  schema_version: string;
  dataset_id: string;
  pin: string;
  report_digest: string;
  counts: { total_items?: number; pending?: number; resolved?: number };
  items: LabelQcItem[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** workspace 相对引用安全解析：禁绝对路径与 `..` 逃逸，解析后必须仍在 root 内
 *  （与内核 evidence_ref 解析禁则同构——defense-in-depth，TCB 只读纪律）。 */
export const resolveWorkspaceRef = (root: string, ref: string): Result<string, { code: string; message: string }> => {
  if (ref === "" || ref.includes("\0")) return err({ code: "label_qc_report_unreadable", message: `工作区引用为空或含非法字符: ${ref.slice(0, 40)}` });
  const absoluteRef = resolve(root, ref);
  const absoluteRoot = resolve(root);
  if (!absoluteRef.startsWith(absoluteRoot + sep)) {
    return err({ code: "label_qc_report_unreadable", message: `工作区引用越界（禁 .. 逃逸与绝对路径）: ${ref.slice(0, 80)}` });
  }
  return ok(absoluteRef);
};

/** 读体检报告（workspace 相对 report_ref）＋最小充分形态校验；digest 与 inspect 返回值
 *  不符 → 不出卡（fail-honest：卡面数据必须与内核单源一致）。 */
export const readLabelQcReport = async (
  wsRoot: string,
  reportRef: string,
  expectDigest?: string,
): Promise<Result<LabelQcReportFile, { code: string; message: string }>> => {
  const path = resolveWorkspaceRef(wsRoot, reportRef);
  if (!path.ok) return path;
  let raw: string;
  try {
    raw = await readFile(path.value, "utf8");
  } catch (error) {
    return err({ code: "label_qc_report_unreadable", message: `体检报告不可读: ${String((error as Error).message).slice(0, 120)}` });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({ code: "label_qc_report_unreadable", message: "体检报告非合法 JSON（fail-honest：不出卡）" });
  }
  if (!isPlainObject(parsed)) return err({ code: "label_qc_report_unreadable", message: "体检报告形态非法（顶层非对象）" });
  const document = parsed as Record<string, unknown>;
  const items = Array.isArray(document["items"]) ? document["items"] : undefined;
  const reportDigest = document["report_digest"];
  if (typeof reportDigest !== "string" || reportDigest === "" || items === undefined) {
    return err({ code: "label_qc_report_unreadable", message: "体检报告缺 report_digest 或 items（形态非法，fail-honest）" });
  }
  if (expectDigest !== undefined && reportDigest !== expectDigest) {
    return err({
      code: "label_qc_report_digest_mismatch",
      message: `体检报告与 inspect 返回身份不符（文件=${reportDigest.slice(0, 20)}… 返回=${expectDigest.slice(0, 20)}…）——fail-honest 不出卡`,
    });
  }
  const report: LabelQcReportFile = {
    schema_version: typeof document["schema_version"] === "string" ? document["schema_version"] : "",
    dataset_id: typeof document["dataset_id"] === "string" ? document["dataset_id"] : "",
    pin: typeof document["pin"] === "string" ? document["pin"] : "",
    report_digest: reportDigest,
    counts: isPlainObject(document["counts"]) ? (document["counts"] as LabelQcReportFile["counts"]) : {},
    items: items.filter(isPlainObject).map((item) => ({
      item_id: typeof item["item_id"] === "string" ? item["item_id"] : "",
      check_class: typeof item["check_class"] === "string" ? item["check_class"] : "",
      human_label: typeof item["human_label"] === "string" ? item["human_label"] : "",
      suggested_action: isPlainObject(item["suggested_action"])
        ? (item["suggested_action"] as LabelQcItem["suggested_action"])
        : {},
      locator: isPlainObject(item["locator"]) ? (item["locator"] as LabelQcItem["locator"]) : {},
      evidence: Array.isArray(item["evidence"])
        ? item["evidence"].filter(isPlainObject).map((entry) => ({
            kind: typeof entry["kind"] === "string" ? entry["kind"] : "",
            ref: typeof entry["ref"] === "string" ? entry["ref"] : "",
            digest: typeof entry["digest"] === "string" ? entry["digest"] : "",
          }))
        : [],
      candidates: Array.isArray(item["candidates"])
        ? item["candidates"].filter(isPlainObject).map((entry) => ({
            candidate_id: typeof entry["candidate_id"] === "string" ? entry["candidate_id"] : "",
            value: typeof entry["value"] === "string" ? entry["value"] : "",
            source: typeof entry["source"] === "string" ? entry["source"] : "",
          }))
        : [],
    })),
  };
  return ok(report);
};

/** 读已裁决项集合（登记面 label-qc-decisions.json 累积产物；**fail-open**——读不到/解析
 *  失败返回空集：卡面宁多勿漏，幂等冲突由内核 fail-closed 拦截）。仅统计同 report_digest
 *  的裁决（防跨报告误剔）。 */
export const readResolvedItemIds = async (wsRoot: string, reportRef: string, reportDigest: string): Promise<Set<string>> => {
  const decisionsRef = reportRef.replace(/[^/]+\.json$/, "label-qc-decisions.json");
  if (decisionsRef === reportRef) return new Set();
  const path = resolveWorkspaceRef(wsRoot, decisionsRef);
  if (!path.ok) return new Set();
  try {
    const parsed: unknown = JSON.parse(await readFile(path.value, "utf8"));
    if (!isPlainObject(parsed) || parsed["report_digest"] !== reportDigest || !Array.isArray(parsed["decisions"])) return new Set();
    const ids = new Set<string>();
    for (const decision of parsed["decisions"]) {
      if (isPlainObject(decision) && typeof decision["item_id"] === "string") ids.add(decision["item_id"]);
    }
    return ids;
  } catch {
    return new Set();
  }
};

/** 卡面待确认项＝报告项 − 已裁决项（报告项初始一律 pending；resolved 事实来自裁决累积）。 */
export const pendingItemsOf = (report: LabelQcReportFile, resolvedIds: Set<string>): LabelQcItem[] =>
  report.items.filter((item) => item.item_id !== "" && !resolvedIds.has(item.item_id));

/** 整图引用投影（裁定 B）：证据切片内的 image_workspace_ref（仅 workspace 内来源给值；
 *  外部来源 null）。fail-soft：切片不可读 → null（卡面如实标注「切片不可读」，不造数）。 */
export const readSliceImageRef = async (wsRoot: string, evidenceRef: string): Promise<string | null> => {
  const path = resolveWorkspaceRef(wsRoot, evidenceRef);
  if (!path.ok) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.value, "utf8"));
    if (!isPlainObject(parsed)) return null;
    const ref = parsed["image_workspace_ref"];
    return typeof ref === "string" && ref !== "" ? ref : null;
  } catch {
    return null;
  }
};

/** 用户逐项确认后的单条裁决草案（确认卡的应答产物；字段由处置闭集决定）。 */
export interface LabelQcDecisionDraft {
  item_id: string;
  action: "accept" | "reject" | "modify";
  disposition?: LabelQcDisposition;
  keep_ref?: string;
  target_candidate_id?: string;
  modified_value?: string;
  target_field?: string;
  reason_text?: string;
  /** Q2 判断依据（合成恒附 basis=user——判断主体＝人；裁定 B 口径）。 */
  judgement_note?: string;
}

/** 草案校验＋确定性合成 atf_label_qc_resolve 参数（未决项不进 decisions——调用方只传
 *  显式确认项）。校验=呈现层预检（内核 fail-closed 为最终权威）：组合闭集、必填附加字段、
 *  Q2 判断依据、reject 语义。 */
export const buildLabelQcResolveParams = (input: {
  report: LabelQcReportFile;
  actor: string;
  decidedAt: string;
  drafts: LabelQcDecisionDraft[];
}): Result<Record<string, unknown>, { code: string; message: string }> => {
  if (input.drafts.length === 0) {
    return err({ code: "label_qc_no_decisions", message: "无已确认项可提交（未决项不默认处置）" });
  }
  const itemsById = new Map(input.report.items.map((item) => [item.item_id, item]));
  const decisions: Record<string, unknown>[] = [];
  for (const draft of input.drafts) {
    const item = itemsById.get(draft.item_id);
    if (item === undefined) {
      return err({ code: "label_qc_item_unknown", message: `item_id 不在体检报告内: ${draft.item_id}` });
    }
    const allowed = DISPOSITIONS_BY_CHECK_CLASS[item.check_class as LabelQcCheckClass];
    if (allowed === undefined) {
      return err({ code: "label_qc_item_unknown", message: `检查类越出闭集: ${item.check_class}` });
    }
    if (draft.action === "reject") {
      if (draft.disposition !== undefined && draft.disposition !== "no_action") {
        return err({ code: "label_qc_decision_invalid", message: `${draft.item_id}: reject＝不处置/维持原状，disposition 只可省略或 no_action` });
      }
      decisions.push({ item_id: draft.item_id, action: "reject" });
      continue;
    }
    let disposition = draft.disposition;
    if (disposition === undefined) {
      const hint = item.suggested_action?.disposition_hint;
      if (hint === undefined || hint === "") {
        return err({ code: "label_qc_decision_invalid", message: `${draft.item_id}: 该项无建议处置，须显式给出 disposition` });
      }
      disposition = hint as LabelQcDisposition;
    }
    if (disposition === "no_action") {
      return err({ code: "label_qc_decision_invalid", message: `${draft.item_id}: accept/modify 的 disposition 不得为 no_action（维持原状请用 reject）` });
    }
    if (!allowed.includes(disposition)) {
      return err({ code: "label_qc_decision_invalid", message: `${draft.item_id}: disposition ${disposition} 越出检查类 ${item.check_class} 允许组合闭集` });
    }
    const missing = REQUIRED_DECISION_FIELDS[disposition].filter((field) => {
      const value = (draft as unknown as Record<string, unknown>)[field];
      return typeof value !== "string" || value === "";
    });
    if (missing.length > 0) {
      return err({ code: "label_qc_decision_invalid", message: `${draft.item_id}: 处置 ${disposition} 缺必填附加字段 ${missing.join("/")}` });
    }
    // Q2 项须附外部判断依据（evidence_ref 或非空 judgements 至少其一；本合成走 judgements，
    // basis=user——判断主体＝人；裁定 B：harness 不代做 multimodal 判定）。
    const decision: Record<string, unknown> = {
      item_id: draft.item_id,
      action: draft.action,
      disposition,
      ...(draft.keep_ref !== undefined ? { keep_ref: draft.keep_ref } : {}),
      ...(draft.target_candidate_id !== undefined ? { target_candidate_id: draft.target_candidate_id } : {}),
      ...(draft.modified_value !== undefined ? { modified_value: draft.modified_value } : {}),
      ...(draft.target_field !== undefined ? { target_field: draft.target_field } : {}),
      ...(draft.reason_text !== undefined ? { reason_text: draft.reason_text } : {}),
    };
    if (item.check_class === "q2_same_box_same_value_diff_field") {
      decision["judgements"] = [
        { item_id: draft.item_id, basis: "user", ...(draft.judgement_note !== undefined && draft.judgement_note !== "" ? { reason_text: draft.judgement_note } : {}) },
      ];
    }
    decisions.push(decision);
  }
  return ok({
    dataset_id: input.report.dataset_id,
    ...(input.report.pin !== "" ? { pin: input.report.pin } : {}),
    actor: input.actor,
    decided_at: input.decidedAt,
    report_digest: input.report.report_digest,
    decisions,
  });
};

/** 确认卡去重键：同 dataset@pin 且同报告身份且同已裁决进度只出一次卡。 */
export const labelQcCardKey = (datasetId: string, pin: string, reportDigest: string, resolvedCount: number): string =>
  `${datasetId}@${pin}|${reportDigest}|${String(resolvedCount)}`;

/** 提取检查类短码（q1..q4；卡片与键位展示用）。 */
export const checkClassShort = (checkClass: string): string =>
  LABEL_QC_CHECK_CLASSES.indexOf(checkClass as LabelQcCheckClass) >= 0 ? `q${String(LABEL_QC_CHECK_CLASSES.indexOf(checkClass as LabelQcCheckClass) + 1)}` : checkClass;
