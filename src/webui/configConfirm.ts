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

/** 九要素键与缺省值（缺省语义与 generate_iteration_config 批⑪缺省表同源对齐）。 */
export const CONFIG_CONFIRM_KEYS: ReadonlyArray<{ key: string; label: string; default: string }> = [
  { key: "learning_rate", label: "学习率 lr", default: "1e-4" },
  { key: "num_train_epochs", label: "训练轮数 epochs", default: "3" },
  { key: "per_device_train_batch_size", label: "单卡 batch", default: "1" },
  { key: "gradient_accumulation_steps", label: "梯度累积", default: "8" },
  { key: "cutoff_len", label: "cutoff_len", default: "9000" },
  { key: "deepspeed", label: "deepspeed 配置", default: "ds_z2_config.json" },
  { key: "lora_rank", label: "lora_rank", default: "32" },
  { key: "lora_alpha", label: "lora_alpha", default: "64" },
  { key: "dataset_keys", label: "数据集键", default: "（由登记面推导）" },
  // 批㉚ 段1（owner 原则二投影面）:KB 来源参数入卡——缺省值＝KB 建议（未校准），
  // label 携带含义＋来源标注＋改法；未经用户确认/修改不得进生效配置
  // （内核实验门 fail-closed 同语义:kb_suggestion 态拒绝产出配置）。
  { key: "max_total_tokens", label: "token 上限（KB 建议·未校准｜含义:单样本最大 token 量,超长单据截断/拒绝构造｜改法:实验门 --max-total-tokens）", default: "4096" },
  { key: "image_min_pixels", label: "像素下限（KB 建议·未校准｜原则一:训练/评估必须同一对值,评估服务只引用训练确认值）", default: "4194304" },
  { key: "image_max_pixels", label: "像素上限（KB 建议·未校准｜与像素下限成对确认）", default: "16384000" },
  { key: "negative_ratio_target", label: "负样本目标带（KB 建议·未校准）", default: "0.02,0.05" },
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
 *  识别键别名：lr＝learning_rate；epochs/轮数＝num_train_epochs；batch＝per_device_train_batch_size；
 *  accum/梯度累积＝gradient_accumulation_steps；cutoff＝cutoff_len；deepspeed/z＝deepspeed；
 *  lora_rank/rank、lora_alpha/alpha。无法解析出任何改动且非纯确认语 → null（交回 agent/提示）。 */
export const parseConfigEditText = (text: string): { edits: Record<string, string>; explicitOnly: boolean } | null => {
  const normalized = text.trim();
  const aliases: Record<string, string> = {
    lr: "learning_rate",
    learning_rate: "learning_rate",
    epochs: "num_train_epochs",
    轮数: "num_train_epochs",
    batch: "per_device_train_batch_size",
    单卡: "per_device_train_batch_size",
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
    // 批㉚ 段1:KB 来源参数别名（原则二投影面——纯文字应答可改这些值）
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
