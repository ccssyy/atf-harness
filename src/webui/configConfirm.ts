/**
 * 批⑬ v2（2026-09-29）——九要素配置确认卡（config_confirm）与纯文字应答。
 *
 * 九要素＝训练迭代配置的关键面（lr/epochs/per_device_batch/grad_accum/cutoff_len/
 * deepspeed/lora_rank/lora_alpha/数据集键数）。缺省来源＝批⑪ TRAINING_REQUIRED_KEY_DEFAULTS
 * 同源语义（生成侧缺省表），已用缺省的键卡面标「已用缺省⚠」；显式来源（用户/登记面）标
 * 「来自登记」。纯文字应答（"lr 改 2e-4 其他 ok"）与点卡双按钮落同一凭据语义（§四 无静默双写）。
 * config-snapshot：已确认配置按 run 持久化——续跑不重复问九要素（用户明说改配置除外，§三.2）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { TRAINING_PIN_CONSTANTS } from "../core/workspace/smartDefaults.js";

/** 九要素键与缺省值（缺省语义与 generate_iteration_config 批⑪缺省表同源对齐）。 */
export const CONFIG_CONFIRM_KEYS: ReadonlyArray<{ key: string; label: string; default: string }> = [
  { key: "learning_rate", label: "学习率 lr", default: "1e-4" },
  // 批㊶R前置（扩键五同步①）：卡数显性卡——字段名与 config training 段对齐（nproc_per_node）；
  // 静态缺省留空＝机器事实未探测位（confirmFace 以 detectAvailableGpuCount 注入基线——
  // owner 裁定：训练默认拉满可用卡；visible_devices 缺失＝machine-facts 停下问，不设默认值）
  { key: "nproc_per_node", label: "训练卡数 nproc_per_node", default: "" },
  // 批㊶-S5 §九：基模型路径入卡（默认＝模型库位置下 Qwen3-VL-32B-Instruct——owner 偏置锚点，
  // confirmFace 以 defaultBaseModelPath 注入基线；卡上可改；写回 iteration-config base_model.path）
  { key: "base_model_path", label: "基模型路径 base_model_path", default: "" },
  { key: "num_train_epochs", label: "训练轮数 epochs", default: "3" },
  { key: "per_device_train_batch_size", label: "单卡 batch", default: "1" },
  { key: "gradient_accumulation_steps", label: "梯度累积", default: "8" },
  { key: "cutoff_len", label: "cutoff_len", default: "9000" },
  { key: "deepspeed", label: "deepspeed 配置", default: "ds_z2_config.json" },
  { key: "lora_rank", label: "lora_rank", default: "32" },
  { key: "lora_alpha", label: "lora_alpha", default: "64" },
  { key: "dataset_keys", label: "数据集键", default: "（由登记面推导）" },
  // 批㊶-W F1：max_total_tokens 4096 缺省删除（必填——表单卡 required 拦空）；像素缺省
  // 改引 TRAINING_PIN_CONSTANTS 单源（历史 KB 像素缺省对全链退役，字面值不再见于本文件）。
  // 批㊶-W §三（owner 终裁）：KB 全链排除——label 不再携带来源标注
  // （不做参考不做提示；引用零残留——grep 锚 tests/dshTools/batchW.test.ts）。
  { key: "max_total_tokens", label: "token 上限（必填｜含义:单样本最大 token 量,超长单据截断/拒绝构造）", default: "" },
  { key: "image_min_pixels", label: "像素下限（原则一:训练/评估必须同一对值,评估服务只引用训练确认值）", default: String(TRAINING_PIN_CONSTANTS.image_min_pixels) },
  { key: "image_max_pixels", label: "像素上限（与像素下限成对确认;两档闭集）", default: String(TRAINING_PIN_CONSTANTS.image_max_pixels[0]) },
  { key: "negative_ratio_target", label: "负样本构造带（配额 2%-5%,空对象构造;空自然页可作构造输入之一非配额来源）", default: `${TRAINING_PIN_CONSTANTS.negative_ratio.min},${TRAINING_PIN_CONSTANTS.negative_ratio.max}` },
];

/** 卡面字段构造：值来源三态（显式覆盖 from_registry/用户值 need_confirm/缺省 default_used）。 */
export const buildConfigConfirmFields = (
  overrides: Record<string, string>,
  options: { fromRegistry?: Record<string, string> } = {},
): Array<{ key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" }> =>
  CONFIG_CONFIRM_KEYS.map((entry) => {
    const registry = options.fromRegistry?.[entry.key];
    if (registry !== undefined) return { key: entry.key, value: registry, tag: "from_registry" as const };
    const explicit = overrides[entry.key];
    if (explicit !== undefined) return { key: entry.key, value: explicit, tag: "need_confirm" as const };
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
