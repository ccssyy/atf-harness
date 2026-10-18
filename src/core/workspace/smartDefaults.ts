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
/** 单源值（内核 PIN_DEFAULTS 同轴——批㊶-W F1：种子 token 65536、像素两档 802816/1605632、
 *  负样本构造带 [0.02,0.05]。历史 KB 缺省值组全链退役（字面值不再见于任何配置面——
 *  grep 锚 tests/dshTools/batchW.test.ts）。 */
export const TRAINING_PIN_CONSTANTS = {
  /** max_total_tokens 单源值（缺省已退役——确认卡必填；本值仅作域参考与文档锚）。 */
  max_total_tokens: 65_536,
  /** 像素下限（固定）。 */
  image_min_pixels: 65_536,
  /** 像素上限两档（闭集）。 */
  image_max_pixels: [802_816, 1_605_632] as number[],
  /** 负样本构造配额带（F2 R1 终裁 2%-5%——空对象构造，非空页自然来源）。 */
  negative_ratio: { min: 0.02, max: 0.05 },
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
/** 单实例 GPU 数（N-2 附录：nproc 8 卡固定缺省——批㊶R前置起仅作 kernel 面历史缺省，
 *  确认卡基线改走机器事实探测 detectAvailableGpuCount，不再静态取 8）。 */
export const NPROC_DEFAULT = 8;

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

/** 批㊶R前置：确认卡扩键持久化白名单补充（nproc_per_node 属 training 段字段——
 *  旧链 iteration-config 可能缺席该键，确认值须仍能写回，否则内核生成面沿旧值）。 */
export const CONFIRM_PERSIST_EXTRA_KEYS: ReadonlySet<string> = new Set(["nproc_per_node"]);

/** 把确认快照（confirmed 字段集）回写 iteration-config 的 training 段＋param_sources（harness 侧
 *  生成物后处理——内核 generate_iteration_config 无确认卡通路，实锚；零内核写入）。
 *  批㊶-Q additive：perKeySources 可选——逐键来源覆盖（全自动档：agent 推荐键＝
 *  default:agent-recommend:<简据>、改参键＝user-specified、其余＝default:harness-smart-defaults；
 *  来源串均在内核 param_sources.py 既有文法内（user-specified／default:<依据>），闭集零扩展）。 */
export const applyConfirmedToIterationConfig = (
  iterConfigPath: string,
  confirmed: Record<string, string>,
  source: string = "user-specified",
  perKeySources?: Record<string, string>,
): { updated: string[] } | { error: string } => {
  if (!existsSync(iterConfigPath)) return { error: `iteration_config_missing:${iterConfigPath}` };
  try {
    const config = JSON.parse(readFileSync(iterConfigPath, "utf8")) as Record<string, unknown>;
    const training = (config["training"] ?? {}) as Record<string, unknown>;
    const sources = (config["param_sources"] ?? {}) as Record<string, string>;
    const updated: string[] = [];
    for (const [key, value] of Object.entries(confirmed)) {
      if (key === "base_model_path") {
        // 批㊶-S5 §九：基模型路径＝base_model 段嵌套字段（非 training 段）——确认值写回该位
        const baseModel = (config["base_model"] ?? {}) as Record<string, unknown>;
        baseModel["path"] = value;
        config["base_model"] = baseModel;
        sources[key] = perKeySources?.[key] ?? source;
        updated.push(key);
        continue;
      }
      if (key in training || key in FIXED_SMART_DEFAULTS || CONFIRM_PERSIST_EXTRA_KEYS.has(key)) {
        training[key] = value;
        sources[key] = perKeySources?.[key] ?? source;
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
