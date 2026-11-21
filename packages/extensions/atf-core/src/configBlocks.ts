/**
 * 训练配置方案区块与键序（G3 落点，2026-11-21）。
 *
 * 迁移自 `src/webui/configConfirm.ts`——那块随 `src/webui` 退役。这里只保留
 * **领域数据**（17 个训练配置键的区块分组与键序），不含任何 webui 的 HTTP/SSE 机制。
 *
 * 单源纪律：`CONFIG_CONFIRM_BLOCKS` 是键名单源，`CONFIG_BLOCK_ORDER` 由它展平派生；
 * `src/webui/configConfirm.ts` 反向引用本文件，两份不会各持一份排序。
 */

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

/** 区块顺序展平的键序（卡面与推荐护栏共用同一份键集）。 */
export const CONFIG_BLOCK_ORDER: readonly string[] = CONFIG_CONFIRM_BLOCKS.flatMap((block) => block.keys);

/** 键 → 所属区块。 */
export const configBlockOf = (key: string): ConfigBlock | undefined =>
  CONFIG_CONFIRM_BLOCKS.find((block) => block.keys.includes(key));
