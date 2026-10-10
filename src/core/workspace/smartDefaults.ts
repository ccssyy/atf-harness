/**
 * 批㊶-P P-1——训练参数智能缺省三层口径（单源；附录 A 全参数对账基准）。
 *
 * 层次：
 *   L1 固定智能缺省（用户不感知，确认卡不展开）——量化/LoRA/优化器/工程面；
 *   L2 派生智能缺省——global_batch=256 目标 → grad_accum = 256/(bs×nproc) 派生＋整除校验
 *     （除不尽/矛盾组合返回问题串，禁止静默取整）；warmup/save_steps 随总量派生；nnodes/nproc；
 *   L3 模型建议缺省（确认卡主显示，harness clamp）——epochs 1–10、lr 5e-5–5e-4、
 *     lora_rank ∈ {16,32,64,128}（alpha=2×rank 联动）、cutoff_len ≤12800（基准 9000）、
 *     image_max_pixels ∈ {800000, 1600000}（image_min_pixels 65536 固定）。
 * OOM 降档：bs 2→1、grad_accum 翻倍、global_batch 保持 256（预填重发指令用，不自动代发）。
 *
 * 深度学习缺省（ds_z3_offload_config.json）＝内核 assets 既有资产（批㊶-P BUILD 首验核实
 * 在位，零内核写入），经 confirmFace deepspeed 缺省切换引用。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ── L1 固定智能缺省（附录 A 第一层）──
export const FIXED_SMART_DEFAULTS: Readonly<Record<string, string>> = {
  quantization_bit: "4",
  quantization_method: "bnb",
  bf16: "true",
  flash_attn: "fa2",
  lora_target: "q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
  lora_dropout: "0.01",
  freeze_vision_tower: "true",
  freeze_multi_modal_projector: "true",
  optim: "adamw_torch_fused",
  max_grad_norm: "1.0",
  lr_scheduler_type: "cosine",
  seed: "42",
  data_seed: "42",
  logging_steps: "2",
  preprocessing_num_workers: "16",
  dataloader_num_workers: "8",
  ddp_timeout: "180000000",
  save_only_model: "false",
  plot_loss: "true",
  overwrite_output_dir: "true",
  overwrite_cache: "true",
  enable_thinking: "false",
  report_to: "none",
  swanlab: "false",
  trust_remote_code: "true",
  image_min_pixels: "65536",
  disable_gradient_checkpointing: "false", // 激活重计算始终默认开启（owner 修订）——显式 false 即不传该参
};

// ── L3 模型建议 clamp 域 ──
export const CLAMP_DOMAINS = {
  epochs: { min: 1, max: 10 },
  lr: { min: 5e-5, max: 5e-4 },
  lora_rank: [16, 32, 64, 128] as number[],
  cutoff_len: { base: 9000, max: 12800 },
  image_max_pixels: [800000, 1600000] as number[],
};

/** 全局批量目标（owner 修订：iteration-config 全局目标）。 */
export const GLOBAL_BATCH_TARGET = 256;
/** 单实例 GPU 数（N-2 附录：nproc 8 卡固定缺省）。 */
export const NPROC_DEFAULT = 8;

/** L2 派生：grad_accum = 256/(bs×nproc)；除不尽/矛盾组合返回问题串（禁止静默取整）。 */
export const deriveGradAccum = (bs: number, nproc: number = NPROC_DEFAULT): { accum: number; globalBatch: number } | { error: string } => {
  if (!Number.isFinite(bs) || bs <= 0 || !Number.isInteger(bs)) return { error: `grad_accum_derive_invalid_bs:${bs}` };
  if (!Number.isFinite(nproc) || nproc <= 0 || !Number.isInteger(nproc)) return { error: `grad_accum_derive_invalid_nproc:${nproc}` };
  const world = bs * nproc;
  if (GLOBAL_BATCH_TARGET % world !== 0) {
    return { error: `grad_accum_not_divisible:256 % (bs ${bs} × nproc ${nproc}) = ${GLOBAL_BATCH_TARGET % world} ≠ 0——禁止静默取整，须调整 bs 或停点` };
  }
  const accum = GLOBAL_BATCH_TARGET / world;
  if (accum <= 0) return { error: `grad_accum_non_positive:${accum}` };
  return { accum, globalBatch: GLOBAL_BATCH_TARGET };
};

/** L3 clamp：lr 解析科学计数法并夹至 [5e-5, 5e-4]；epochs 夹至 [1,10]；rank 取最近档位。 */
export const clampLearningRate = (raw: string | number): string => {
  const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(value)) return "1e-4";
  const clamped = Math.min(CLAMP_DOMAINS.lr.max, Math.max(CLAMP_DOMAINS.lr.min, value));
  // LoRA 域惯用科学计数法形态（1e-4／5e-5／5e-4）
  return clamped.toExponential(0).replace("e+", "e-").replace(/e-0(\d)/, "e-$1");
};

export const clampEpochs = (raw: string | number): number => {
  const value = typeof raw === "number" ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(CLAMP_DOMAINS.epochs.max, Math.max(CLAMP_DOMAINS.epochs.min, Math.round(value)));
};

export const clampLoraRank = (raw: string | number): number => {
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 32;
  let nearest = CLAMP_DOMAINS.lora_rank[0] as number;
  for (const candidate of CLAMP_DOMAINS.lora_rank) {
    if (Math.abs(candidate - value) < Math.abs(nearest - value)) nearest = candidate;
  }
  return nearest;
};

export const loraAlphaFor = (rank: number): number => 2 * rank;

export const clampCutoffLen = (raw: string | number): number => {
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return CLAMP_DOMAINS.cutoff_len.base;
  return Math.min(CLAMP_DOMAINS.cutoff_len.max, Math.max(1, Math.round(value)));
};

export const clampImageMaxPixels = (raw: string | number): number => {
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return CLAMP_DOMAINS.image_max_pixels[0] as number;
  let nearest = CLAMP_DOMAINS.image_max_pixels[0] as number;
  for (const candidate of CLAMP_DOMAINS.image_max_pixels) {
    if (Math.abs(candidate - value) < Math.abs(nearest - value)) nearest = candidate;
  }
  return nearest;
};

/** OOM 降档重发参数（P-1 OOM 策略）：bs 2→1、grad_accum 翻倍、global_batch 保持 256。 */
export const oomFallbackParams = (nproc: number = NPROC_DEFAULT): { bs: number; accum: number; globalBatch: number } | { error: string } => {
  const bs = 1;
  const derived = deriveGradAccum(bs, nproc);
  if ("error" in derived) return derived;
  return { bs, accum: derived.accum, globalBatch: derived.globalBatch };
};

// ── 深度学习资产（P-1c）──
/** 智能缺省 deepspeed 资产名（内核 assets/deepspeed/ds_z3_offload_config.json——BUILD 首验核实在位：
 *  zero3＋optimizer/param 双下 CPU，保守档；别名 ds_z3_offload 经内核 resolve_deepspeed_name 归一）。 */
export const SMART_DEEPSPEED_DEFAULT = "ds_z3_offload_config.json";

// ── param_sources 补丁（批㊶-P 1a：确认卡快照确认值回写 iteration-config 来源标注）──
/** 来源串合法词汇（内核 param_sources.py 闭集）：user-specified／default:<依据>／carried-from:<run_id>。 */
export const paramSourceFor = (tag: "need_confirm" | "from_registry" | "default_used"): string => {
  switch (tag) {
    case "need_confirm":
    case "from_registry":
      return "user-specified";
    case "default_used":
    default:
      return "default:harness-smart-defaults";
  }
};

/** 把确认快照（confirmed 字段集）回写 iteration-config 的 training 段＋param_sources（harness 侧
 *  生成物后处理——内核 generate_iteration_config 无确认卡通路，实锚；零内核写入）。 */
export const applyConfirmedToIterationConfig = (
  iterConfigPath: string,
  confirmed: Record<string, string>,
  source: string = "user-specified",
): { updated: string[] } | { error: string } => {
  if (!existsSync(iterConfigPath)) return { error: `iteration_config_missing:${iterConfigPath}` };
  try {
    const config = JSON.parse(readFileSync(iterConfigPath, "utf8")) as Record<string, unknown>;
    const training = (config["training"] ?? {}) as Record<string, unknown>;
    const sources = (config["param_sources"] ?? {}) as Record<string, string>;
    const updated: string[] = [];
    for (const [key, value] of Object.entries(confirmed)) {
      if (key in training || key in FIXED_SMART_DEFAULTS) {
        training[key] = value;
        sources[key] = source;
        updated.push(key);
      }
    }
    config["training"] = training;
    config["param_sources"] = sources;
    mkdirSync(join(iterConfigPath, ".."), { recursive: true });
    writeFileSync(iterConfigPath, `${JSON.stringify(config, null, 1)}\n`, "utf8");
    return { updated };
  } catch (cause) {
    return { error: `iteration_config_patch_failed:${String(cause).slice(0, 120)}` };
  }
};
