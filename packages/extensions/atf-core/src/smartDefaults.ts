/**
 * 批㊶-P P-1——训练参数智能缺省三层口径（单源；附录 A 全参数对账基准）。
 *
 * 层次：
 *   L1 固定智能缺省（用户不感知，确认卡不展开）——量化/LoRA/优化器/工程面；
 *   L2 派生智能缺省——global_batch=256 目标 → grad_accum = 256/(bs×nproc) 派生＋整除校验
 *     （除不尽/矛盾组合返回问题串，禁止静默取整）；warmup/save_steps 随总量派生；nnodes/nproc；
 *   L3 模型建议缺省（确认卡主显示，harness clamp）——epochs 1–10、lr 5e-5–5e-4、
 *     lora_rank ∈ {16,32,64,128}（alpha=2×rank 联动）、cutoff_len ≤12800（基准 9000）、
 *     image_max_pixels ∈ TRAINING_PIN_CONSTANTS 两档（批㊶-W F1 单源）、
 *     negative_ratio_target ∈ [0.02,0.05]（批㊶-W F2 构造配额带）。
 * OOM 降档：bs 2→1、grad_accum 翻倍、global_batch 保持 256（预填重发指令用，不自动代发）。
 *
 * 深度学习缺省（ds_z3_offload_config.json）＝内核 assets 既有资产（批㊶-P BUILD 首验核实
 * 在位，零内核写入），经 confirmFace deepspeed 缺省切换引用。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// ── 批㊶-W F1：训练 pin 单源常量（三面一致：内核种子/护栏闭集/确认卡缺省引用同一组值）──
/** 单源值（内核 PIN_DEFAULTS 同轴——批㊶-W F1：像素两档 802816/1605632、负样本构造带
 *  [0.02,0.05]。历史 KB 缺省值组全链退役（字面值不再见于任何配置面——
 *  grep 锚 tests/dshTools/batchW.test.ts）。 */
export const TRAINING_PIN_CONSTANTS = {
  /** max_total_tokens 单源值（惯例基线（owner 2026-10-22），非缺省填充值——批次 R H1-2 改值）。
   *  卡面建议口径同源；确认落盘仍须显式（禁「没写就是 9000」隐含行为——TokenBudget v1 §六）。 */
  max_total_tokens: 9000,
  /** 像素下限（固定，像素值与 token 无关）。 */
  image_min_pixels: 65_536,
  /** 像素上限两档（闭集）。 */
  image_max_pixels: [802_816, 1_605_632] as number[],
  /** 负样本构造配额带（F2 R1 终裁 2%-5%——空对象构造，非空页自然来源）。 */
  negative_ratio: { min: 0.02, max: 0.05 },
  /** cutoff_len 单源值（惯例基线 owner 2026-10-22）——训练截断。与 max_model_len 分属
   *  训练/推理两个栈（TokenBudget v1 §五）：独立取值，禁互相推导、禁共用常量。 */
  cutoff_len: 9000,
  /** max_model_len 单源值（惯例基线 owner 2026-10-22）——推理窗口。与 cutoff_len 分属
   *  推理/训练两个栈（TokenBudget v1 §五）：独立取值，禁互相推导、禁共用常量。 */
  max_model_len: 12800,
} as const;

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
  // 批㊶-W F1：像素上限闭集改引 TRAINING_PIN_CONSTANTS 单源（历史 KB 像素对退役——字面值不复发）。
  image_max_pixels: TRAINING_PIN_CONSTANTS.image_max_pixels,
  // 批㊶-W F2：负样本构造带（Agent 建议区间——域内任意值可建议，域外拦截回退）。
  negative_ratio: TRAINING_PIN_CONSTANTS.negative_ratio,
};

// ── 批次 R H1-1：TokenBudget 三要素关系校验（服务端单源——confirmFace 确认闸与
//    atf-ui web 面双处消费同一函数，禁两套实现）。设计依据 ATF_设计_TokenBudget_v1 §五：──
//    约束一（训练侧）max_total_tokens ≤ cutoff_len——闸门放行的最大样本训练时必须装得下；
//    约束二（推理侧）max_total_tokens ≤ max_model_len——prompt 装得下，余量给生成；
//    cutoff_len 与 max_model_len 之间无约束（两个栈，禁互相推导）。

/** TokenBudget 关系校验结果：violations 空＝可确认；needsSync＝预算与 cutoff 不等
 *  （提示是否同步——同步是用户动作，不自动；不同步须填理由）。 */
export interface TokenBudgetCheck {
  violations: string[];
  needsSync: boolean;
}

/** TokenBudget 两条不变式＋同步理由校验（纯函数，值形态宽松——卡面字符串/数值皆收）。
 *  值缺失/非正整数＝violation（fail-closed，不猜）；预算与 cutoff 不等且未填理由＝
 *  violation（理由空则禁确认）。 */
export const checkTokenBudget = (
  triple: { maxTotalTokens: unknown; cutoffLen: unknown; maxModelLen: unknown },
  opts: { syncReason?: string } = {},
): TokenBudgetCheck => {
  const violations: string[] = [];
  const parse = (raw: unknown, label: string): number | null => {
    const num = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : NaN;
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
      violations.push(`${label} 须为正整数（得 ${String(raw)}）——不猜测`);
      return null;
    }
    return num;
  };
  const mtt = parse(triple.maxTotalTokens, "max_total_tokens");
  const cutoff = parse(triple.cutoffLen, "cutoff_len");
  const mml = parse(triple.maxModelLen, "max_model_len");
  if (mtt === null || cutoff === null || mml === null) return { violations, needsSync: false };
  if (mtt > cutoff) violations.push(`预算超过训练截断，训练会截断样本（max_total_tokens ${mtt} > cutoff_len ${cutoff}）`);
  if (mtt > mml) violations.push(`预算超过推理窗口（max_total_tokens ${mtt} > max_model_len ${mml}）`);
  const needsSync = mtt !== cutoff;
  if (needsSync && (opts.syncReason ?? "").trim() === "") {
    violations.push(`预算与训练截断不等（max_total_tokens ${mtt} ≠ cutoff_len ${cutoff}）——同步 cutoff_len（用户动作，不自动）或填写不同步理由`);
  }
  return { violations, needsSync };
};

// ── 批㊶-S5 §九：默认基模型锚点（owner 10-12 裁定——确认卡基线默认，卡上可改；非全局锁定）──
/** 默认基模型目录名（锚点＝owner 偏置；路径由模型库位置派生，零绝对路径硬编码）。 */
export const DEFAULT_BASE_MODEL_NAME = "Qwen3-VL-32B-Instruct";

/** 默认基模型路径派生（模型库位置 env ＞ null——不猜）。防线①消费同一值（VERIFY §九）。 */
export const defaultBaseModelPath = (env: Readonly<Record<string, string | undefined>>): string | null => {
  const root = env["ATF_MODEL_ROOT"];
  if (typeof root !== "string" || root.trim() === "") return null;
  return join(root.trim(), DEFAULT_BASE_MODEL_NAME);
};

/** 全局批量目标（owner 修订：iteration-config 全局目标）。 */
export const GLOBAL_BATCH_TARGET = 256;

// ⚠ 卡数没有缺省（owner 2026-10-26）：内核 generate_iteration_config 已删
// TRAINING_REQUIRED_KEY_DEFAULTS["nproc_per_node"]，改为五级来源链取卡数、四处皆无即拒绝
// （accum_requires_nproc / nproc_per_node_required），**绝不按 1 或 8 派生**。
// harness 侧同步：本文件不再提供 NPROC_DEFAULT；deriveGradAccum/oomFallbackParams 的卡数
// 参数一律必填——调用方取不到真实卡数时，正确做法是「不派生 accum」，不是拿 8 顶上。

// ── 批㊶R前置：训练卡数机器事实（owner 裁定 10-11：训练默认拉满可用卡·训练时长优先）──

/** 端口占用探测同风格的卡数探测（nvidia-smi -L 逐行 GPU 计数；不可用＝null 不猜测）。 */
const probeGpuCount = (): number | null => {
  try {
    const out = execFileSync("nvidia-smi", ["-L"], { timeout: 8_000, encoding: "utf8" });
    const count = out.split("\n").filter((line) => /^GPU\s+\d+:/.test(line)).length;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
};

/** CUDA_VISIBLE_DEVICES 解析（逗号索引与 a-b 区间两形态；空/非法＝null——不猜）。 */
export const parseVisibleDevicesCount = (raw: string): number | null => {
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  let count = 0;
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range !== null) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
      count += hi - lo + 1;
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    count += 1;
  }
  return count > 0 ? count : null;
};

/** 可用卡数机器事实（解析序：CUDA_VISIBLE_DEVICES env ＞ nvidia-smi 实测；两者皆缺＝null
 *  ——机器事实缺失＝停下问用户，不设默认值）。probe 可注入（vitest 假件直测）。 */
export const detectAvailableGpuCount = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  probe: () => number | null = probeGpuCount,
): number | null => {
  const cvd = env["CUDA_VISIBLE_DEVICES"];
  if (typeof cvd === "string" && cvd.trim() !== "") return parseVisibleDevicesCount(cvd.trim());
  return probe();
};

/** 反模式护栏判定输入（字段形态＝确认卡 fields 子集所需两键）。 */
export interface NprocGuardField {
  key: string;
  value: string;
  tag: "need_confirm" | "from_registry" | "default_used" | "agent_recommend";
}

export interface NprocGuardHit {
  key: "nproc_per_node" | "deepspeed";
  revertedTo: string;
  note: string;
}

/** A-C3b E11：运行形态联动冲突标注（用户显式态不回退——只标注，内核 fail-closed 单源）。 */
export interface NprocLinkageConflict {
  key: "nproc_per_node" | "deepspeed";
  note: string;
}

// ── A-C3b E11 文案单源：内核 skills/atf-admit-training-data/scripts/build_experiment_setup.py
//    _validate_runtime_linkage 的 runtime_linkage_conflict 因由/补救表述逐字引用——harness 只
//    呈现不另写风险描述，阈值与拒绝面均留在内核（不复制成第二份实现）。 ──
export const KERNEL_RUNTIME_LINKAGE_CONFLICT_TEXT =
  "单卡 QLoRA 挂 ZeRO 有静默死亡风险(无 traceback 训练中断,uat 实测 ×2)";
export const KERNEL_RUNTIME_LINKAGE_REMEDY_TEXT =
  "重跑以 --deepspeed off,或改多卡 bf16 后 z2/z3 可用";

/**
 * 反模式拦截（确定性，建卡/生效配置时——批㊶R前置 指令件第 4 项；批㊶-S5 门2修正回退参照；
 * A-C3b E11 拆来源＋判据对齐内核）：
 *   A. nproc_per_node=1 × 任意 deepspeed(≠off) × bnb_4bit(QLoRA)——判据单源对齐内核
 *      _validate_runtime_linkage（内核＝拒绝面；harness 只判"是否冲突并呈现"，不复刻阈值）：
 *      非用户显式（default_used/from_registry/agent_recommend）→ 维持回退可用卡数＋note
 *      （注明内核同规则会拒绝）；用户显式（need_confirm）→ **不回退不改值**，conflicts 标注
 *      冲突原文（内核文案单源）交内核 fail-closed（runtime_linkage_conflict）。
 *      qlora 缺省＝按 QLoRA 判定（确认卡链 L1 固定缺省 quantization_bit=4×method=bnb 单源
 *      形态，卡面无量化键）；非 QLoRA 链（如 bf16）调用方显式传 false——不误报。
 *   B. nproc 与可用卡数不一致 → 拦截：超上限（物理事实）任何来源都回退；低于上限仅在
 *      非用户显式形态（default_used/from_registry/agent_recommend）回退——**回退参照＝
 *      设置面训练卡数基线（baselineNproc，拉满偏置承载点）?? 探测可用卡数**；与参照相等
 *      不回退（设置基线＝操作者显式配置，非静默低配）。降档仅用户明确要求
 *      （need_confirm＝用户显式，放行不改）。B 支判据与文案逐字不动。
 * 可用卡数机器事实缺失时：触发 A/B 需回退即返回 error（machine-facts 停下问），不设默认值。
 */
export const guardNprocAntiPatterns = (
  fields: ReadonlyArray<NprocGuardField>,
  ctx: { gpuCount: number | null; baselineNproc?: string | null; qlora?: boolean },
): { hits: NprocGuardHit[]; conflicts: NprocLinkageConflict[] } | { error: string } => {
  const nprocField = fields.find((f) => f.key === "nproc_per_node");
  const deepspeedField = fields.find((f) => f.key === "deepspeed");
  if (nprocField === undefined) return { hits: [], conflicts: [] };
  const nproc = Number.parseInt(nprocField.value, 10);
  if (!Number.isFinite(nproc) || nproc <= 0) return { error: `nproc_per_node 非法（${nprocField.value}）——须为正整数，不猜测` };
  const hits: NprocGuardHit[] = [];
  const conflicts: NprocLinkageConflict[] = [];
  const gpuCount = ctx.gpuCount;
  const deepspeed = deepspeedField?.value ?? "";
  // A：单卡 × 任意 deepspeed(≠off) × QLoRA（判据对齐内核 runtime_linkage_conflict——与值来源
  //    无关地识别冲突，按来源决定呈现方式：非用户显式回退，用户显式只标注）
  const deepspeedActive = deepspeed.trim() !== "" && deepspeed.trim().toLowerCase() !== "off";
  const qlora = ctx.qlora !== false;
  if (nproc === 1 && deepspeedActive && qlora) {
    const cause = `nproc_per_node=1 × deepspeed=${deepspeed} × bnb_4bit(QLoRA)——${KERNEL_RUNTIME_LINKAGE_CONFLICT_TEXT}`;
    if (nprocField.tag === "need_confirm") {
      return {
        hits,
        conflicts: [{
          key: "nproc_per_node",
          note: `运行形态联动冲突：${cause}；内核同规则将拒绝（runtime_linkage_conflict）——本卡不改用户显式值，请先处置：${KERNEL_RUNTIME_LINKAGE_REMEDY_TEXT}`,
        }],
      };
    }
    if (gpuCount === null) return { error: "反模式拦截需回退但可用卡数机器事实缺失（CUDA_VISIBLE_DEVICES/nvidia-smi 皆不可得）——停下问用户，不设默认值" };
    return {
      hits: [{
        key: "nproc_per_node",
        revertedTo: String(gpuCount),
        note: `反模式拦截：${cause}；内核同规则会拒绝（runtime_linkage_conflict）——已按可用卡数回退为 ${gpuCount}（如需单卡：--deepspeed off）`,
      }],
      conflicts,
    };
  }
  if (gpuCount !== null) {
    if (nproc > gpuCount) {
      hits.push({
        key: "nproc_per_node",
        revertedTo: String(gpuCount),
        note: `反模式拦截：训练卡数 ${nproc} 超过本机可用卡数 ${gpuCount}（机器事实物理上限）——已回退为 ${gpuCount}`,
      });
      return { hits, conflicts };
    }
    const reference = ctx.baselineNproc !== undefined && ctx.baselineNproc !== null && ctx.baselineNproc.trim() !== ""
      ? Number.parseInt(ctx.baselineNproc, 10)
      : gpuCount;
    if (nproc < gpuCount && nproc !== reference && nprocField.tag !== "need_confirm") {
      const target = Math.min(reference, gpuCount);
      hits.push({
        key: "nproc_per_node",
        revertedTo: String(target),
        note: `卡数基线回退：训练卡数 ${nproc} 低于基线参照 ${target} 且非用户显式降档（owner 偏置：训练默认拉满、训练时长优先）——已回退为 ${target}`,
      });
    }
  }
  return { hits, conflicts };
};

/** L2 派生：grad_accum = 256/(bs×nproc)；除不尽/矛盾组合返回问题串（禁止静默取整）。
 *  `nproc` **必填**（无缺省）：卡数取不到时应调用方不调用本函数（卡面显示「待定」），
 *  不得用任何常量顶上——否则会出现「卡面预览 8 卡、内核拒绝生成」的两本账。 */
export const deriveGradAccum = (bs: number, nproc: number): { accum: number; globalBatch: number } | { error: string } => {
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

/** 批㊶-W F2：负样本构造带 clamp（"0.03" 单值或 "0.02,0.05" 带两形态；带内逐值夹至
 *  [0.02,0.05]；不可解析＝原样返回交由调用方按需拦截——不猜）。 */
export const clampNegativeRatio = (raw: string | number): string => {
  const text = String(raw).trim();
  const parts = text.split(/[,\uFF0C;；]/).map((p) => Number.parseFloat(p.trim()));
  if (parts.length === 0 || parts.some((p) => !Number.isFinite(p))) return text;
  const { min, max } = CLAMP_DOMAINS.negative_ratio;
  const clamped = parts.map((p) => Math.min(max, Math.max(min, p)));
  return clamped.map((p) => String(Number(p.toFixed(4)))).join(",");
};

/** OOM 降档重发参数（P-1 OOM 策略）：bs 2→1、grad_accum 翻倍、global_batch 保持 256。
 *  `nproc` 必填（同 deriveGradAccum：卡数无缺省）。 */
export const oomFallbackParams = (nproc: number): { bs: number; accum: number; globalBatch: number } | { error: string } => {
  const bs = 1;
  const derived = deriveGradAccum(bs, nproc);
  if ("error" in derived) return derived;
  return { bs, accum: derived.accum, globalBatch: derived.globalBatch };
};

// ── 深度学习资产（P-1c）──
/** 智能缺省 deepspeed 资产名（内核 assets/deepspeed/ds_z3_offload_config.json——BUILD 首验核实在位：
 *  zero3＋optimizer/param 双下 CPU，保守档；别名 ds_z3_offload 经内核 resolve_deepspeed_name 归一）。 */

// ── E4-乙（改动 2）：内核 bs 缺省分档单源（cutoff<10000→2，否则 1）──
/** bs 内核缺省分档阈值（cutoff_len ≥ 10000 的长样本降 bs——内核 b9 缺省面同源）。 */
export const KERNEL_BS_CUTOFF_THRESHOLD = 10_000;

/** per_device_train_batch_size 内核缺省（cutoff<10000→2，否则 1；cutoff 缺席按惯例基线
 *  9000 判档）。confirmFace 卡面展示与派生输入兜底（删 `?? 2` 硬编码）、pipelineFace
 *  training_overrides 桥 convention 兜底三处共用本单源；来源标注 convention（内核惯例）。 */
export const kernelBsDefaultOf = (cutoffLen: number | undefined): number => {
  const cutoff =
    cutoffLen !== undefined && Number.isFinite(cutoffLen) && cutoffLen > 0
      ? cutoffLen
      : TRAINING_PIN_CONSTANTS.cutoff_len;
  return cutoff < KERNEL_BS_CUTOFF_THRESHOLD ? 2 : 1;
};

// ── E4-乙（改动 2）：deepspeed 智能缺省与内核统一 ds_z3_offload（别名形态；内核 b9
//    侧 generate_iteration_config 缺省同步切档——harness 先行对齐，re-pin 对账）──
export const SMART_DEEPSPEED_DEFAULT = "ds_z3_offload";

// ── param_sources 回写面（批㊶-P 1a）——E4-乙（改动 2）整体退役 ──
// 确认快照不再回写 iteration-config（快照是训练参数唯一出口——红线：停写后 harness
// 不得再写任何内核产物）；training 段与 param_sources 由内核 training_prep 段写
// （来源 user_confirmed(ref=stage:training_overrides)，内核 b9 文法——build_prelaunch_report
// 来源校验接受该形态不误拒）。applyConfirmedToIterationConfig／paramSourceFor／
// CONFIRM_PERSIST_EXTRA_KEYS 三件随删（调用点 confirmFace 两处已摘）。
