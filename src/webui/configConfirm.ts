/**
 * 批⑬ v2（2026-09-29，owner 2026-10-26 改名与重排）——「本次训练方案」确认（config_confirm）
 * 与纯文字应答。
 *
 * 方案面＝训练迭代配置的 17 个关键值（运行环境／训练规模／长度与预算／优化设置／数据构造／
 * 只读信息六区块，见 CONFIG_CONFIRM_BLOCKS）。缺省来源＝批⑪ TRAINING_REQUIRED_KEY_DEFAULTS
 * 同源语义（生成侧缺省表），已用缺省的键卡面标「已用缺省⚠」；显式来源（用户/登记面）标
 * 「来自登记」。纯文字应答（"lr 改 2e-4 其他 ok"）与点卡双按钮落同一凭据语义（§四 无静默双写）。
 * config-snapshot：已确认配置按 run 持久化——续跑不重复问同一套方案（用户明说改配置除外）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { CLAMP_DOMAINS, TRAINING_PIN_CONSTANTS } from "../core/workspace/smartDefaults.js";

// ── 六区块（owner 2026-10-26 重排裁定：卡面按「问什么」分组，不按实现键序）──────────
// 排序理由（owner 明示，改动前先读这段）：
//  A 运行环境：唯一无法推导、必须先问的机器事实（卡数/卡位/基模型路径）——不问就无从生成
//    任何后续参数；且 visible_devices 的个数必须等于 nproc_per_node，两者同区相邻才能当场
//    校验（跨区摆放＝把一条不变式拆成两屏，用户看不见冲突）。
//  B 训练规模：梯度累积由单卡 batch × 卡数派生（全局 batch 不变），故 bs 在前、accum 在后，
//    改 bs 时 accum 的联动在同一屏内可见。
//  C 长度与预算：预算/截断/推理窗口三行联动（预算 ≤ cutoff、预算 ≤ max_model_len 两条不变式），
//    像素上下限成对（min < max）——成对项相邻才谈得上「成对确认」。
//  D 优化设置：学习率与 LoRA 容量（rank→alpha 联动）＋显存策略是一个决策面。
//  E 数据构造：负样本带是构造配额，独立成区。
//  F 只读信息：内核实算/派生值——只呈现不收集，放最后折叠。
/** 卡面区块（title＝用户可见业务标题；keys＝区块内键序单源）。 */
export interface ConfigBlock {
  readonly id: string;
  readonly title: string;
  readonly keys: readonly string[];
}

export const CONFIG_CONFIRM_BLOCKS: readonly ConfigBlock[] = [
  { id: "environment", title: "运行环境", keys: ["nproc_per_node", "visible_devices", "base_model_path"] },
  { id: "scale", title: "训练规模", keys: ["per_device_train_batch_size", "gradient_accumulation_steps", "num_train_epochs"] },
  { id: "budget", title: "长度与预算", keys: ["cutoff_len", "max_total_tokens", "max_model_len", "image_min_pixels", "image_max_pixels"] },
  { id: "optimization", title: "优化设置", keys: ["learning_rate", "lora_rank", "lora_alpha", "deepspeed"] },
  { id: "data", title: "数据构造", keys: ["negative_ratio_target"] },
  { id: "readonly", title: "只读信息", keys: ["dataset_keys"] },
];

/** 键 → 所属区块（卡面标签前缀与只读折叠共用）。 */
export const configBlockOf = (key: string): ConfigBlock | undefined =>
  CONFIG_CONFIRM_BLOCKS.find((block) => block.keys.includes(key));

/** 区块顺序展平的键序（CONFIG_CONFIRM_KEYS 必须按此序声明——单源防两份排序漂移）。 */
export const CONFIG_BLOCK_ORDER: readonly string[] = CONFIG_CONFIRM_BLOCKS.flatMap((block) => block.keys);

/** 方案键与缺省值（顺序＝六区块序，见 CONFIG_CONFIRM_BLOCKS；缺省语义与
 *  generate_iteration_config 批⑪缺省表同源对齐）。 */
export const CONFIG_CONFIRM_KEYS: ReadonlyArray<{ key: string; label: string; default: string }> = [
  // ── A 运行环境 ────────────────────────────────────────────────────────────────
  // 批㊶R前置（扩键五同步①）：卡数显性卡——字段名与 config training 段对齐（nproc_per_node）；
  // 静态缺省留空＝机器事实未探测位（confirmFace 以 detectAvailableGpuCount 注入基线——
  // owner 裁定：训练默认拉满可用卡；visible_devices 缺失＝machine-facts 停下问，不设默认值）
  { key: "nproc_per_node", label: "训练卡数 nproc_per_node", default: "" },
  // D76 卡位入卡（指令《ATF_指令_D76_卡位入卡_20261023》§二 harness 1）：键名/语义与内核侧
  // generate_iteration_config 的 visible_devices 逐字一致——逗号分隔整数或 a-b 段、元素 0–7、
  // 不重复、个数须等于 nproc_per_node。缺省必须保持「回退 deploy」（generate_train_launch 读
  // train.visible_devices 覆盖缺省）——静态不给默认值，确认落盘空值不写快照（禁空串覆盖 deploy）。
  { key: "visible_devices", label: "卡位 visible_devices（留空＝全部可见卡）", default: "" },
  // 批㊶-S5 §九：基模型路径入卡（默认＝模型库位置下 Qwen3-VL-32B-Instruct——owner 偏置锚点，
  // confirmFace 以 defaultBaseModelPath 注入基线；卡上可改；写回 iteration-config base_model.path）
  { key: "base_model_path", label: "基模型路径 base_model_path", default: "" },
  // ── B 训练规模 ────────────────────────────────────────────────────────────────
  // E4-乙（改动 2）：bs 静态缺省退役为注入位（confirmFace 以内核缺省分档 kernelBsDefaultOf
  // 注入——cutoff<10000→2 标 convention；静态字面会造成第二套口径）
  { key: "per_device_train_batch_size", label: "单卡 batch", default: "" },
  // 卡数无缺省后（owner 2026-10-26），累积只能由「全局批量 ÷（单卡 batch × 卡数）」派生：
  // 静态缺省 8 会在卡数未定时冒出一个凭空的「已定值」，故清空为派生位（卡面未派生时标「待定」）。
  { key: "gradient_accumulation_steps", label: "梯度累积", default: "" },
  { key: "num_train_epochs", label: "训练轮数 epochs", default: "3" },
  // ── C 长度与预算 ──────────────────────────────────────────────────────────────
  // 批次 R H1-1：TokenBudget 三要素——cutoff_len/max_model_len 缺省改单源惯例基线
  //（owner 2026-10-22；两值独立取值、禁互相推导、禁共用常量——TokenBudget v1 §五）。
  { key: "cutoff_len", label: "训练截断 cutoff_len", default: String(TRAINING_PIN_CONSTANTS.cutoff_len) },
  // 批次 R H1-1/H1-2：max_total_tokens 预填惯例基线 9000（owner 2026-10-22 裁定——缺省来源
  // 从「必填空」改为 owner 惯例并标来源；确认落盘仍显式。清空提交仍被必填拦空兜底拦截
  //（confirmFace configFormFieldsOf）。65536 域参考值退役（不显示、不预填）。
  { key: "max_total_tokens", label: "单样本 token 预算 max_total_tokens（惯例基线预填,可改;超长单据构造期拒绝）", default: String(TRAINING_PIN_CONSTANTS.max_total_tokens) },
  // 批次 R H1-1：推理窗口入卡（只读——卡面不提供自由编辑；独立取值非 cutoff 推导）。
  { key: "max_model_len", label: "推理窗口 max_model_len（只读）", default: String(TRAINING_PIN_CONSTANTS.max_model_len) },
  { key: "image_min_pixels", label: "像素下限（原则一:训练/评估必须同一对值,评估服务只引用训练确认值）", default: String(TRAINING_PIN_CONSTANTS.image_min_pixels) },
  { key: "image_max_pixels", label: "像素上限（与像素下限成对确认;两档闭集）", default: String(TRAINING_PIN_CONSTANTS.image_max_pixels[0]) },
  // ── D 优化设置 ────────────────────────────────────────────────────────────────
  { key: "learning_rate", label: "学习率 lr", default: "1e-4" },
  { key: "lora_rank", label: "lora_rank", default: "32" },
  { key: "lora_alpha", label: "lora_alpha", default: "64" },
  // E4-乙（改动 2）：deepspeed 缺省与内核统一 ds_z3_offload（别名形态——原 ds_z2_config.json
  // 静态缺省退役；显式值/登记值优先不变）
  { key: "deepspeed", label: "deepspeed 配置", default: "ds_z3_offload" },
  // ── E 数据构造 ────────────────────────────────────────────────────────────────
  { key: "negative_ratio_target", label: "负样本构造带（配额 2%-5%,空对象构造;空自然页可作构造输入之一非配额来源）", default: `${TRAINING_PIN_CONSTANTS.negative_ratio.min},${TRAINING_PIN_CONSTANTS.negative_ratio.max}` },
  // ── F 只读信息 ────────────────────────────────────────────────────────────────
  // D92：dataset_keys 改只读展示（内核实算——generate_iteration_config 的
  // dataset_keys: sorted(dataset_info)，单源落盘 IterationConfig dataset 段；卡上可编辑值
  // 内核实算不读＝「可编辑不消费」禁——占位文案「（由登记面推导）」退役，default 留空串）
  { key: "dataset_keys", label: "数据集键（只读·内核实算）", default: "" },
];

// ── 决策类闭集（owner 2026-10-26：枚举不再塞进 form 纯文本让用户手打）──────────────
// 形态约定（原生 AskUserQuestionItem 本就支持，ATF 此前零使用）：
//   决策类 → options（需多选开 multiSelect，不设 intent）；录入类 → 保留 form；
//   「其他」自由输入由客户端在选项组末尾自带（custom 字段），与选项视觉分区——本文件只
//   负责把选择映射回 key=value，不认识自由文本的第二套语法。
// deepspeed 档位闭集（单源注释锚）：
/** DeepSpeed 配置档（＝内核 assets/deepspeed 内置闭集，别名经 resolve_deepspeed_name 归一）。
 *  内核侧 DEEPSPEED_CLOSED_SET 恰 7 个配置文件；短名别名 ds_z3_offload／ds_z3_fp8 归一后
 *  同属此集——本表按配置文件名列 7 档，别名由「其他」自由输入承接（不另列重复项）。 */
export const DEEPSPEED_CHOICES: ReadonlyArray<{ value: string; label: string; description: string }> = [
  { value: "ds_z0_config.json", label: "Z0 不卸载", description: "纯数据并行，显存占用最高；单机大显存或小模型" },
  { value: "ds_z2_config.json", label: "Z2 梯度分片", description: "优化器/梯度分片，显存与通信折中" },
  { value: "ds_z2_offload_config.json", label: "Z2 + CPU 卸载", description: "Z2 基础上优化器下 CPU" },
  { value: "ds_z2_tp_offload_config.json", label: "Z2 + 张量并行卸载", description: "张量并行场景的低显存档" },
  { value: "ds_z3_config.json", label: "Z3 参数分片", description: "参数/梯度/优化器全分片，显存最省但通信最多" },
  { value: "ds_z3_fp8_config.json", label: "Z3 + fp8", description: "Z3 配 fp8 上游示例（optimizer-only offload）" },
  { value: "ds_z3_offload_config.json", label: "Z3 + 全卸载（默认）", description: "优化器与参数双下 CPU，显存换内存，保守档" },
];

/** 单值闭集选项（键 → 候选值；标签直接给用户面文案）。 */
export const configChoiceValuesOf = (key: string): ReadonlyArray<{ value: string; label: string; description?: string }> => {
  switch (key) {
    case "deepspeed":
      return DEEPSPEED_CHOICES;
    case "lora_rank":
      // 档位单源＝CLAMP_DOMAINS.lora_rank（alpha=2×rank 联动由 confirmFace 落地）
      return CLAMP_DOMAINS.lora_rank.map((rank) => ({ value: String(rank), label: `rank ${String(rank)}`, description: `alpha＝${String(rank * 2)}（2×rank 联动）` }));
    case "image_max_pixels":
      return TRAINING_PIN_CONSTANTS.image_max_pixels.map((pixels, index) => ({
        value: String(pixels),
        label: `${pixels.toLocaleString("en-US")} 像素${index === 0 ? "（默认档）" : ""}`,
        description: index === 0 ? "保守档：坐标换算与 token 预算更省" : "高清档：长边更大的单据可保真",
      }));
    default:
      return [];
  }
};

// ── D92：只读键单源（指令《ATF_指令_参数面增补_harness_20261023》）──

/** 卡面只读键（确认卡不生成输入框——「可编辑不消费」禁）：max_model_len＝惯例基线独立取值
 *  （批次 R H1-1 只读）；dataset_keys＝内核实算（generate_iteration_config 的
 *  dataset_keys: sorted(dataset_info)，单源 IterationConfig dataset 段），卡上可编辑值内核
 *  实算不读。只读呈现单源——confirmFace 表单过滤与卡面只读行共用本集。 */
export const READONLY_CONFIG_KEYS: ReadonlySet<string> = new Set(["max_model_len", "dataset_keys"]);

// ── H7c：留空＝回退部署缺省的键，卡面输入框占位提示（呈现层单源）──

/** 卡面输入框占位提示（当前仅卡位：留空＝全部可见卡，回退 deploy 的 cuda_visible_devices）。
 *  纯呈现提示——绝不写入字段值（空值不落快照，禁空串覆盖 deploy；落盘面见
 *  confirmedSnapshotOf／sessionManager）。卡号上界取机器事实可用卡数（gpuCount−1）；
 *  未探测到卡数＝只报「全部可见卡」，不编造区间（不猜）。 */
export const configFieldPlaceholderOf = (key: string, gpuCount: number | null): string | undefined => {
  if (key !== "visible_devices") return undefined;
  const upper = gpuCount !== null && Number.isInteger(gpuCount) && gpuCount > 0 ? gpuCount - 1 : null;
  return upper === null ? "自动（全部可见卡）" : `自动（全部可见卡 0-${String(upper)}）`;
};

// ── 批次 R H1-1：TokenBudget 三要素区（卡面与 web 摘要共用单源渲染）──

/** TokenBudget 三要素键（同屏呈现：预算可编辑，cutoff/max_model_len 只读参照）。 */
export const TOKEN_BUDGET_KEYS: ReadonlyArray<"max_total_tokens" | "cutoff_len" | "max_model_len"> = [
  "max_total_tokens",
  "cutoff_len",
  "max_model_len",
];

/** 三要素来源标注：用户显式改值＝用户指定；agent 推荐＝agent 推荐；其余（缺省/登记值）
 *  ＝惯例基线（owner 2026-10-22）——TokenBudget v1 §六来源口径。 */
export const tokenBudgetSourceNoteOf = (tag: string | undefined): string =>
  tag === "need_confirm" ? "用户指定" : tag === "agent_recommend" ? "agent 推荐" : "惯例基线（owner 2026-10-22）";

/** 三要素区单行输入形态（confirmFace 字段与 atf-ui 摘要行共用宽松形态）。 */
export interface TokenBudgetRow {
  key: string;
  value: string;
  tag?: string;
}

/** TokenBudget 三要素区三行渲染（单源）：预算可编辑；cutoff 只读参照（与预算不等须同步
 *  或填理由——同步是用户动作不自动）；max_model_len 只读独立取值（禁 cutoff 推导）。 */
export const renderTokenBudgetRows = (rows: ReadonlyArray<TokenBudgetRow>): string[] => {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const mtt = byKey.get("max_total_tokens");
  const cutoff = byKey.get("cutoff_len");
  const mml = byKey.get("max_model_len");
  const cutoffNote =
    mtt !== undefined && cutoff !== undefined && mtt.value.trim() === cutoff.value.trim()
      ? "= 预算"
      : "≠ 预算（须同步 cutoff 或填理由）";
  return [
    `单样本 token 预算  max_total_tokens  可编辑  ${mtt?.value ?? "（缺失）"}  [${tokenBudgetSourceNoteOf(mtt?.tag)}]`,
    `训练截断 cutoff    cutoff_len        只读    ${cutoff?.value ?? "（缺失）"}  [${cutoffNote}]`,
    `推理窗口           max_model_len     只读    ${mml?.value ?? "（缺失）"}  [独立取值]`,
  ];
};

// ── b5 像素对复用补丁（2026-10-22）：视觉像素对区（卡面 TokenBudget 三行之后）──
// 只加呈现，不改链：值域两档/默认值单源 TRAINING_PIN_CONSTANTS，clamp 沿既有
// clampImageMaxPixels（confirmFace），改值通道沿既有 chat 别名（像素上限改 1605632）。

/** 像素对来源标注（两态口径，指令 b5 §三：用户显式改值＝用户；其余——缺省/登记确认值＝默认）。 */
export const pixelPairSourceNoteOf = (tag: string | undefined): string =>
  tag === "need_confirm" ? "用户" : "默认";

/** 千分位呈现（纯整数；非纯数字原样——用户面可读口径，指令卡面示例 65,536）。 */
export const thousandsOf = (value: string): string =>
  /^\d+$/.test(value.trim()) ? Number(value.trim()).toLocaleString("en-US") : value;

/** 像素对关系警示（单源判据：两侧均可解析为数值且 min ≥ max；数值不可解析不判——交给既有 clamp 链）。
 *  返回 null＝关系成立/不判。只提示不阻塞（指令 b5 §三）。 */
export const pixelPairViolationOf = (
  rows: ReadonlyArray<{ key: string; value: string }>,
): string | null => {
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const min = Number(byKey.get("image_min_pixels") ?? "");
  const max = Number(byKey.get("image_max_pixels") ?? "");
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < max) return null;
  return `最小像素须小于最大像素——当前 ${thousandsOf(String(min))} ≥ ${thousandsOf(String(max))}，请修正或恢复默认（${thousandsOf(String(TRAINING_PIN_CONSTANTS.image_min_pixels))} / ${thousandsOf(String(TRAINING_PIN_CONSTANTS.image_max_pixels[0]))}）`;
};

/** 视觉像素对区渲染（单源，web 摘要与确认卡面共用）：最小/最大两行＋来源标注＋
 *  agent 推荐行（仅推荐在场）＋关系警示。用户面零内部键名、零错误码（指令 b5 §三）；
 *  推荐值与理由来自 agent（快照 sources 单源），此处不生成、不硬编码推荐。 */
export const renderPixelPairRows = (
  rows: ReadonlyArray<{ key: string; value: string; tag?: string }>,
  options: { recommend?: { value: string; brief: string } | null } = {},
): { rows: string[]; violations: string[] } => {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const minRow = byKey.get("image_min_pixels");
  const maxRow = byKey.get("image_max_pixels");
  if (minRow === undefined && maxRow === undefined) return { rows: [], violations: [] };
  const [primary, alternate] = [TRAINING_PIN_CONSTANTS.image_max_pixels[0], TRAINING_PIN_CONSTANTS.image_max_pixels[1]];
  const faceRows = [
    `最小像素  可编辑  ${thousandsOf(minRow?.value ?? "")}  [${pixelPairSourceNoteOf(minRow?.tag)}]`,
    `最大像素  可编辑  ${thousandsOf(maxRow?.value ?? "")}  [${pixelPairSourceNoteOf(maxRow?.tag)}]（候选 ${thousandsOf(String(alternate ?? primary))}）`,
    ...(options.recommend !== undefined && options.recommend !== null && options.recommend.value !== "" && options.recommend.brief !== ""
      ? [`Agent 推荐：${thousandsOf(options.recommend.value)} —— ${options.recommend.brief}`]
      : []),
  ];
  const violation = pixelPairViolationOf(rows);
  return { rows: faceRows, violations: violation !== null ? [violation] : [] };
};

/** 卡面字段构造：值来源三态（显式覆盖 from_registry/用户值 need_confirm/缺省 default_used）。 */
export const buildConfigConfirmFields = (
  overrides: Record<string, string>,
  options: { fromRegistry?: Record<string, string> } = {},
): Array<{ key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" }> =>
  CONFIG_CONFIRM_KEYS.map((entry) => {
    // H7f：优先级＝用户显式 > 已确认快照/派生 > 缺省（派生只填空缺，绝不覆盖用户值）
    const explicit = overrides[entry.key];
    if (explicit !== undefined) return { key: entry.key, value: explicit, tag: "need_confirm" as const };
    const registry = options.fromRegistry?.[entry.key];
    if (registry !== undefined) return { key: entry.key, value: registry, tag: "from_registry" as const };
    return { key: entry.key, value: entry.default, tag: "default_used" as const };
  });

/** 纯文字应答解析（"lr 改 2e-4 其他 ok"→ {learning_rate:"2e-4"}；"其他 ok"＝其余按当前值确认）。
 *  批㊶-W F5：atf_config_confirm 工具链的文字 amend 路径已退役（表单卡 intent 结构化收集）；
 *  本函数仅为 atf-ui 面板既有文字应答通道（sessionManager.resolvePendingByText）保留——
 *  工具链零引用，勿在新链路接入。 */
export const parseConfigEditText = (text: string): { edits: Record<string, string>; explicitOnly: boolean } | null => {
  const normalized = text.trim();
  const aliases: Record<string, string> = {
    lr: "learning_rate",
    learning_rate: "learning_rate",
    epochs: "num_train_epochs",
    轮数: "num_train_epochs",
    batch: "per_device_train_batch_size",
    单卡: "per_device_train_batch_size",
    // 批㊶R前置：卡数别名（纯文字应答可改卡数——「卡数改 4」）
    卡数: "nproc_per_node",
    nproc: "nproc_per_node",
    nproc_per_node: "nproc_per_node",
    基模型: "base_model_path",
    base_model: "base_model_path",
    base_model_path: "base_model_path",
    accum: "gradient_accumulation_steps",
    梯度累积: "gradient_accumulation_steps",
    cutoff: "cutoff_len",
    cutoff_len: "cutoff_len",
    deepspeed: "deepspeed",
    z2: "deepspeed",
    z3: "deepspeed",
    rank: "lora_rank",
    lora_rank: "lora_rank",
    alpha: "lora_alpha",
    lora_alpha: "lora_alpha",
    // 批㉚ 段1 承接（批㊶-W §三 KB 标注已除——键本身保留可改）
    token: "max_total_tokens",
    token上限: "max_total_tokens",
    max_total_tokens: "max_total_tokens",
    像素下限: "image_min_pixels",
    image_min_pixels: "image_min_pixels",
    像素上限: "image_max_pixels",
    image_max_pixels: "image_max_pixels",
    负样本: "negative_ratio_target",
    negative_ratio_target: "negative_ratio_target",
  };
  const edits: Record<string, string> = {};
  const pattern = /([A-Za-z_·\u4e00-\u9fff]+?)\s*(?:改|为|设置成|设置成|=|:|：)\s*([^\s，。；,;]+)/g;
  for (const match of normalized.matchAll(pattern)) {
    const rawKey = (match[1] ?? "").toLowerCase();
    const key = aliases[rawKey] ?? aliases[rawKey.replace(/^lora_?/, "")];
    if (key !== undefined && match[2] !== undefined) edits[key] = match[2] as string;
  }
  const confirmish = /(其他|其余|其它).{0,4}(ok|按|确认|可以)|ok|确认|可以/.test(normalized.toLowerCase());
  if (Object.keys(edits).length === 0 && !confirmish) return null;
  return { edits, explicitOnly: Object.keys(edits).length > 0 };
};

/** config-snapshot 存储（runs/<id>/webui/config-snapshot.json；§三.2 已确认不重问）。 */
export const snapshotPath = (runDir: string): string => join(runDir, "webui", "config-snapshot.json");

export const loadConfigSnapshot = (runDir: string): Record<string, string> | null => {
  const path = snapshotPath(runDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { confirmed?: Record<string, string> };
    return typeof parsed["confirmed"] === "object" && parsed["confirmed"] !== null ? (parsed["confirmed"] as Record<string, string>) : null;
  } catch {
    return null;
  }
};

export const saveConfigSnapshot = (runDir: string, confirmed: Record<string, string>, meta?: { auto?: boolean; tier?: string; sources?: Record<string, string> }): void => {
  const path = snapshotPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  // 批㊶-Q additive：全自动档快照附 auto/tier/sources 通报面（只增不改——既有消费方读 confirmed 不受影响）
  writeFileSync(path, `${JSON.stringify({ schema_version: "WebUiConfigSnapshot/v1", confirmed, ...(meta?.auto === true ? { auto: true, ...(meta.tier !== undefined ? { tier: meta.tier } : {}), ...(meta.sources !== undefined ? { sources: meta.sources } : {}) } : {}) }, null, 1)}\n`, "utf8");
};

export const hasConfigSnapshot = (runDir: string): boolean => existsSync(snapshotPath(runDir));
