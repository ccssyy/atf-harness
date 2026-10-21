/**
 * 批㊶-W F7——九要素确认值 → train.sh 生成面逐键透传对账（awb_r1 首跑回归实锚：
 * nproc 确认 8 生成 1 被静默丢弃——本面使该类偏差 start 面即拒）。
 *
 * 对账输入：config-snapshot confirmed（九要素确认快照；缺席降级 iteration-config training 段）
 * 对账目标：train.sh 文本——export NPROC_PER_NODE=N＋TRAIN_CMD 数组 `--key value` 对
 * 裁决：逐键数值等值（"3.0"≡"3"——数值比较）；任一不符即拒＋diff 呈现；
 *       global batch（bs×accum×nproc）乘积相等校验——不许静默换算。
 * 纯函数零 IO（文本进 JSON 出）——vitest 直测；trainingFace start 面接线消费。
 */

/** 对账键集（train.sh `--key` ↔ 确认卡键；nproc 走 export NPROC_PER_NODE 专项提取）。
 *  批㊶-W 真机细化：max_total_tokens 属内核构造面参数（train.sh 生成面不承载）——
 *  不入对账集（入集会把「生成面本就不含的键」误判为静默丢弃；bw-live-1 首跑实锚）。 */
export const RECONCILE_KEYS: readonly string[] = [
  "learning_rate",
  "num_train_epochs",
  "per_device_train_batch_size",
  "gradient_accumulation_steps",
  "lora_rank",
  "lora_alpha",
  "cutoff_len",
  "image_min_pixels",
  "image_max_pixels",
];

export interface ReconcileMismatch {
  key: string;
  confirmed: string;
  generated: string | null;
}

export interface TrainShReconcileResult {
  ok: boolean;
  /** 提取到的生成面键值（诊断回流）。 */
  extracted: Record<string, string>;
  mismatches: ReconcileMismatch[];
  /** global batch 乘积校验（confirmed 乘积 vs generated 乘积；任一端缺键＝null 跳过）。 */
  globalBatch: { confirmed: number | null; generated: number | null; ok: boolean } | null;
}

/** 数值等值（"3.0"≡"3"；非数值串退回字符串精确比较）。 */
const valueEquals = (a: string, b: string): boolean => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a.trim() === b.trim();
};

/** train.sh 文本 → 生成面键值提取（纯函数）：`--key` `'value'` 对＋export NPROC_PER_NODE。
 *  键值形态（真机实锚 awb_r1/qc-02 生成器输出，2026-10-22 门2 幕4 实证）：TRAIN_CMD 数组
 *  元素逐 token 一行、行尾 ` \` 续行（generate_train_launch.py 渲染 " \\\n  ".join——
 *  b0 与 b3 同构）——正则容 `\`？；同线对（旧夹具形态）继续可解析；
 *  nproc 专项＝/export NPROC_PER_NODE=(\d+)/。同键多次出现取首现（生成器不重键）。 */
export const extractTrainShValues = (trainShText: string): Record<string, string> => {
  const extracted: Record<string, string> = {};
  const nproc = /export\s+NPROC_PER_NODE=(\d+)/.exec(trainShText);
  if (nproc !== null) extracted["nproc_per_node"] = nproc[1] as string;
  const pair = /'--([A-Za-z_][A-Za-z0-9_]*)'\s*,?\s*\\?\s*\n?\s*'([^']*)'/g;
  for (const match of trainShText.matchAll(pair)) {
    const key = match[1] as string;
    const value = match[2] as string;
    if (extracted[key] === undefined) extracted[key] = value;
  }
  return extracted;
};

/** 逐键对账（纯函数）：confirmed 键值 × 生成面提取值。确认值缺席的键跳过（不虚构）；
 *  生成面缺席＝mismatch（generated: null——静默丢弃归此）；值不等＝mismatch。
 *  global batch：bs×accum×nproc 三键两端皆齐才校验，乘积不等＝ok:false（不许静默换算）。 */
export const reconcileConfirmedWithTrainSh = (confirmed: Record<string, string>, trainShText: string): TrainShReconcileResult => {
  const extracted = extractTrainShValues(trainShText);
  const mismatches: ReconcileMismatch[] = [];
  for (const key of RECONCILE_KEYS) {
    const confirmedValue = confirmed[key];
    if (confirmedValue === undefined || String(confirmedValue).trim() === "") continue;
    const generatedValue = extracted[key];
    if (generatedValue === undefined || !valueEquals(String(confirmedValue), generatedValue)) {
      mismatches.push({ key, confirmed: String(confirmedValue), generated: generatedValue ?? null });
    }
  }
  const nprocConfirmed = confirmed["nproc_per_node"];
  if (nprocConfirmed !== undefined && String(nprocConfirmed).trim() !== "") {
    const generatedNproc = extracted["nproc_per_node"] ?? null;
    if (generatedNproc === null || !valueEquals(String(nprocConfirmed), generatedNproc)) {
      mismatches.push({ key: "nproc_per_node", confirmed: String(nprocConfirmed), generated: generatedNproc });
    }
  }
  const triple = (source: Record<string, string>): number | null => {
    const bs = Number(source["per_device_train_batch_size"]);
    const accum = Number(source["gradient_accumulation_steps"]);
    const nproc = Number(source["nproc_per_node"]);
    return Number.isFinite(bs) && Number.isFinite(accum) && Number.isFinite(nproc) ? bs * accum * nproc : null;
  };
  const confirmedBatch = triple(confirmed);
  const generatedBatch = triple(extracted);
  const globalBatch =
    confirmedBatch !== null && generatedBatch !== null
      ? { confirmed: confirmedBatch, generated: generatedBatch, ok: confirmedBatch === generatedBatch }
      : null;
  if (globalBatch !== null && !globalBatch.ok) {
    mismatches.push({ key: "global_batch(bs×accum×nproc)", confirmed: String(confirmedBatch), generated: String(generatedBatch) });
  }
  return { ok: mismatches.length === 0, extracted, mismatches, globalBatch };
};

/** mismatch 人读 diff（拒绝 note 呈现面：「键: 确认值 → 生成值(缺席＝<缺失>)」逐行）。 */
export const formatReconcileDiff = (mismatches: readonly ReconcileMismatch[]): string =>
  mismatches.map((m) => `${m.key}: 确认 ${m.confirmed} → 生成 ${m.generated ?? "<缺失>"}`).join("；");
