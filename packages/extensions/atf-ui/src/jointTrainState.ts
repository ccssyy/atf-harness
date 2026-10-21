/**
 * H5——联合训练共享状态面（D25 多类联合训练；指令 H5 节）。
 *
 * 判定单源：字段选择卡的卡前校验（jointSpecIssues）、FieldSpec/v1 归一
 * （normalizeJointFieldSpec）、发起消息模板（buildJointTrainMessage）都收敛在本模块——
 * 工具面（atf-tools/jointTrainFace.ts 的卡前快败门）直接 import 本模块；
 * UI 面（client.js）因半裸服务不打包无法 require，按仓内先例（CLOSURE_MESSAGE／
 * trainLaunchMessage 双份同语义）在 client.js 内保存同语义双份，两侧测试用同一夹具
 * 对同一判定断言（jointTrain.test.ts×jointTrainUi.test.ts 双钉——双侧同锚）。
 *
 * FieldSpec/v1 形态依据（取证 2026-10-21，内核 pin v0.7.23b0 只读面）：
 * - 内核 builder（tools/build_joint_dataset.py）_load_class_spec 校验闭集＝顶层对象＋
 *   document_zh 非空＋fields 非空＋field_id 非空类内唯一＋definition 非空；
 * - 渲染器（skills/atf-admit-training-data/scripts/render_prompt.py render_flat_prompt）
 *   消费 field.zh（缺即渲染失败）与 field.locators（缺省 []），并读顶层
 *   training_excluded_fields；D25 设计 §4.1 的 locator_keywords 经本模块归一为
 *   locators（内核消费键单源，不发明第二套 schema）。
 */
export const JOINT_FIELD_SPEC_SCHEMA = "FieldSpec/v1";

/** 分组闭集（D25 设计 §4.1：goods=货描／non_goods=非货描；UI 按此分组渲染）。 */
export const JOINT_FIELD_GROUPS: readonly string[] = ["goods", "non_goods"];

/** 字段行（UI 编辑态与归一输入同构；locators/exclusions/confusable 为可选透传面）。 */
export interface JointFieldRow {
  field_id: string;
  zh: string;
  group: string;
  definition: string;
  locators?: string[];
  exclusions?: string[];
  confusable?: string;
}

/** 类草稿（UI 一张 tab 的编辑态；工具面校验只消费 fields 与 doc_type/run_id）。 */
export interface JointClassDraft {
  doc_type: string;
  run_id: string;
  document_zh: string;
  fields: JointFieldRow[];
}

/** 卡前校验问题（code=稳定码——工具面结构化错误同码回流；message=业务话术）。 */
export interface JointIssue {
  code:
    | "joint_datasets_empty"
    | "joint_doc_type_duplicate"
    | "joint_run_id_missing"
    | "joint_document_zh_missing"
    | "joint_field_missing"
    | "joint_field_id_invalid"
    | "joint_field_desc_missing";
  doc_type?: string;
  field_id?: string;
  message: string;
}

const nonBlank = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * 字段选择卡卡前校验（工具面与 UI 面同判定单源——双侧测试同夹具同锚）。
 * 校验闭集（D25 设计 §4.2「校验：字段必须带说明；同一类内 id 唯一」＋内核 builder
 * spec 校验闭集的前置镜像）：类清单非空／doc_type 非空且不重复／run_id 非空／
 * document_zh 非空／每类 fields 非空／field_id 非空且类内唯一／zh 与 definition 非空。
 * 返回问题清单（空数组＝通过）；调用方按首个问题红字指明类/字段（UI）或结构化拒绝（工具）。
 */
export const jointSpecIssues = (classes: unknown): JointIssue[] => {
  const issues: JointIssue[] = [];
  if (!Array.isArray(classes) || classes.length === 0) {
    return [{ code: "joint_datasets_empty", message: "还没有选择任何单据类型——联合训练至少要有一个类型" }];
  }
  const seenDocTypes = new Set<string>();
  for (const raw of classes) {
    const item = (raw ?? {}) as Partial<JointClassDraft>;
    const docType = nonBlank(item.doc_type);
    if (docType === "") {
      issues.push({ code: "joint_doc_type_duplicate", message: "有类型没有填单据类型名——每个类型都要写类型名" });
      continue;
    }
    if (seenDocTypes.has(docType)) {
      issues.push({ code: "joint_doc_type_duplicate", doc_type: docType, message: `单据类型「${docType}」重复——同一类型只能出现一次` });
      continue;
    }
    seenDocTypes.add(docType);
    if (nonBlank(item.run_id) === "") {
      issues.push({ code: "joint_run_id_missing", doc_type: docType, message: `「${docType}」还没有选择实验——每个类型都要指到它数据所在的实验` });
    }
    if (nonBlank(item.document_zh) === "") {
      issues.push({ code: "joint_document_zh_missing", doc_type: docType, message: `「${docType}」缺单据中文名——prompt 渲染必需` });
    }
    const fields = Array.isArray(item.fields) ? item.fields : [];
    const selected = fields.filter((f) => (f as Partial<JointFieldRow> & { selected?: boolean }).selected !== false);
    if (selected.length === 0) {
      issues.push({ code: "joint_field_missing", doc_type: docType, message: `「${docType}」一个字段都没选——至少要为每个类型勾选 1 个字段` });
      continue;
    }
    const seenIds = new Set<string>();
    for (const field of selected) {
      const fieldId = nonBlank(field?.field_id);
      if (fieldId === "") {
        issues.push({ code: "joint_field_id_invalid", doc_type: docType, message: `「${docType}」有字段没填字段名——字段名必填` });
        continue;
      }
      if (seenIds.has(fieldId)) {
        issues.push({ code: "joint_field_id_invalid", doc_type: docType, field_id: fieldId, message: `「${docType}」字段名「${fieldId}」重复——同一类型内字段名不能重名` });
        continue;
      }
      seenIds.add(fieldId);
      if (nonBlank(field?.zh) === "" || nonBlank(field?.definition) === "") {
        issues.push({
          code: "joint_field_desc_missing",
          doc_type: docType,
          field_id: fieldId,
          message: `「${docType}」字段「${fieldId}」缺中文名或字段说明——没有说明就无法写进提取要求`,
        });
      }
    }
  }
  return issues;
};

/**
 * FieldSpec/v1 归一（确定性——键序固定，同输入逐字节一致）：D25 设计 §4.1 的
 * locator_keywords 归一为内核渲染器消费的 locators；group 缺席按 goods 落盘
 * （分组是 UI 组织面，内核 builder/渲染器不消费——FieldSpec/v1 落盘需有值，不造第二闭集）。
 */
export const normalizeJointFieldSpec = (docType: string, documentZh: string, fields: ReadonlyArray<Partial<JointFieldRow> & { selected?: boolean; locator_keywords?: string[] }>): Record<string, unknown> => ({
  schema_version: JOINT_FIELD_SPEC_SCHEMA,
  doc_type: docType,
  document_zh: documentZh,
  fields: fields
    .filter((field) => field.selected !== false)
    .map((field) => {
      const locators = Array.isArray(field.locators)
        ? field.locators
        : Array.isArray(field.locator_keywords)
          ? field.locator_keywords
          : [];
      return {
        field_id: String(field.field_id ?? "").trim(),
        zh: String(field.zh ?? "").trim(),
        group: field.group === "non_goods" ? "non_goods" : "goods",
        definition: String(field.definition ?? "").trim(),
        locators,
        ...(Array.isArray(field.exclusions) ? { exclusions: field.exclusions } : {}),
        ...(typeof field.confusable === "string" && field.confusable.trim() !== "" ? { confusable: field.confusable.trim() } : {}),
      };
    }),
});

/** 行数千分位（卡面「预计 3,410 行」口径——手工实现，跨环境确定性）。 */
export const formatRowCount = (count: number): string =>
  String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 发起消息 plan（UI 生成消息的输入；字段规格 JSON 由调用方序列化好带入）。 */
export interface JointTrainMessagePlan {
  target_run_id: string;
  classes: Array<{ doc_type: string; run_id: string; field_count: number }>;
  /** 按类 FieldSpec/v1（doc_type → spec 对象——调用方 normalizeJointFieldSpec 产物）。 */
  field_specs: Record<string, unknown>;
  oversample?: Record<string, number>;
  seed?: number;
  estimated_rows?: number;
}

/**
 * 联合训练发起消息（业务语言单源——client.js 同语义双份双钉；trainLaunchMessage 先例）。
 * 一个入口完成构建＋训练：不出现单类 A/B 两入口，不引导拆步。
 */
export const buildJointTrainMessage = (plan: JointTrainMessagePlan): string => {
  const typeList = plan.classes.map((c) => c.doc_type).join("、");
  const fieldCounts = plan.classes.map((c) => `${c.doc_type} ${c.field_count}`).join(" · ");
  const lines = [
    `发起联合训练（${String(plan.classes.length)} 类：${typeList} → run ${plan.target_run_id}）：`,
    "请用 atf_joint_train 工具一次完成联合数据构建与训练启动（一个入口，不要拆成单类两步）：",
    `datasets：${JSON.stringify(plan.classes.map((c) => ({ run_id: c.run_id, doc_type: c.doc_type })))}`,
    `field_specs：${JSON.stringify(plan.field_specs)}`,
    ...(plan.oversample !== undefined && Object.keys(plan.oversample).length > 0
      ? [`oversample：${JSON.stringify(plan.oversample)}`]
      : ["oversample：省略（全部类型 1 倍）"]),
    ...(typeof plan.seed === "number" ? [`seed：${String(plan.seed)}`] : []),
    `字段数核对：${fieldCounts}${typeof plan.estimated_rows === "number" ? `；预计 ${formatRowCount(plan.estimated_rows)} 行` : ""}。`,
    "我会在确认卡上核对类型／各类字段数／预计行数／合并倍率后放行。",
  ];
  return lines.join("\n");
};
