/**
 * atf_pipeline_stage：按段驱动 walkthrough_pipeline 段模式（内核 tag v0.7.18b0 起的
 * --stage 单段执行面，修复批A2.2b 落点单源改造；tag v0.7.19b0 起 K-E14a base 模型语义
 * 拆分——本工具 A-E14b 增 training_prep 段 base_model_path 显式下传；内核 main E10a
 * （2eed2c2，未发版，pin 不动）起 family_split 段 --auto-style-cluster 三态——本工具
 * E10b 增 auto_style_cluster 透传；内核 main E10e/E10f 拒绝带 user_message 业务文案＋
 * --allow-small-cluster-test——本工具 E10d 拒绝面业务化：user_message 原样透传
 * （未带按业务语言兜底并标注来源）、note 改「原样告知 user_message」指引、增
 * allow_small_cluster_test 透传；D89 增 experiment_setup 段 grouping_preset 透传
 * （内核 argparse --grouping-preset A/B，缺省 B——「缺省不静默」：未给按内核缺省处理
 * 并在返回体标注分组来源，审批卡呈现分组方案）；D93 增三参透传（train_all／
 * assignment_source／reuse_experiment_setup——内核全局 argparse 参数，只透传不新增语义）；
 * D99 增 experiment_setup 段 negative_ratio_target 透传（内核 argparse
 * --negative-ratio-target <下限,上限>——D90 用户确认值通路 harness 侧补派：九要素卡
 * 确认值经本参进实验门；显式给才下传且审批卡/返回体标来源，「缺省不静默」同 D89）。
 * E3（缺口 D 产品管道半）增 experiment_setup 段预算三参——max_total_tokens／
 * image_min_pixels／image_max_pixels（内核 b8 argparse --max-total-tokens／
 * --image-min-pixels／--image-max-pixels，harness 先行按惯例 flag 名，re-pin 对账）：
 * 显式 > run 目录 webui/config-snapshot.json 确认快照兜底 > unspecified（不下传）；
 * 来源逐参独立标注 user_specified|config_snapshot|unspecified（审批卡与返回体均
 * 呈现终值与来源）；像素对成对校验（min<max，判据单源 configConfirm
 * pixelPairViolationOf——先于审批，卡前快败业务文案）。九要素确认值经本通路进
 * 实验门——确认卡（落快照）与本段工具（快照兜底下传）同源成环，替代任何代写。
 * E4-乙（改动 1）增 training_prep 段 training_overrides——九键白名单（训练参数
 * 单源桥，内核 b9 TRAINING_OVERRIDES_KEYS 逐字同源）：显式 > 确认快照构造
 * （webui/config-snapshot.json confirmed 九键子集）；accum 缺而 bs×nproc 终值在场
 * 时按 global_batch=256 派生（除不尽停点，禁静默取整）；bs 缺按内核缺省分档
 * （cutoff<10000→2）、deepspeed 缺按 ds_z3_offload——convention 态只呈现不注入
 * （缺省单源在内核）。逐键来源 user_confirmed|config_snapshot|derived|convention
 * 双呈现（审批卡与返回体）；像素对与 TokenBudget 三键禁入（分别走 experiment_setup
 * 预算三参与 token 预算链路，双源即红）；其它段收到该参忽略并记 note。注入通路
 * （E5·H1 D139·b10 对齐）：--training-overrides 随本段命令 argv 正常下传（内核 b10
 * 起 walkthrough 段命令接线该参并透传生成器——取代 E4-乙补的「返回体 json＋next_step
 * 指引 agent 经 atf_scratch_exec 直调生成器」过渡形态，该指引已撤销、返回体仅留兼容
 * 说明；b9 快照 walkthrough 无此声明面——PARAM_FACE_WAIVERS 前瞻豁免，re-pin b10
 * 随快照退役）——被采纳键内核落 param_sources=
 * {source:user_confirmed, ref:stage:training_overrides}（取代 confirmFace 直写
 * iteration-config 的旧通道；快照仍是确认值唯一出口）。
 * E5·H3 D140（落点可见）：training_prep 段返回体与审批卡呈现训练输出目录 output_dir
 * 终值——盘上 IterationConfig 的 output.output_dir 单源（live/legacy 双形态探测，
 * prelaunchFace detectIterationConfig 同序；harness 零公式复制），缺席时按内核
 * ADR-0005 run 布局呈现预期值 join(runDir,"training") 并标注来源（段产出后以落盘
 * 终值为准）。
 * E8b·H1（内核 b13 准入闸槽位化对齐）：register 段说明与错误回流改新口径——同一
 * run 可继续登记其它单据（无需 --rerun，多类联合训练共用一个 run）；同单据本段
 * 重复登记为幂等跳过 register_already_done_skip（ok 零产物不覆写，非错误）；
 * walkthrough_run_dir_not_empty 收缩为「非空但缺合法 run.json」兜底，错误回流
 * 指引（kernelErrorFace）改指补齐 run.json，不引导换 run（换 run 会落成 ADR-0017
 * 明禁的 N+1）。
 *
 * 接口契约（引自内核件 K-A2.2a §二，双件同步；A-E14b 增补 K-E14a 命令面；E10b 增补
 * E10a 命令面；E10d 增补 E10f 命令面；D89 增补 --grouping-preset 命令面；D93 增补
 * 全局三参命令面）：
 *   段名闭集（权威＝内核 STAGE_ORDER，八项，禁增删改序）＝register／label_qc／
 *   experiment_setup／candidate_build／publish／family_split／admission／training_prep。
 *   命令面（段模式）：--workspace 必填／--stage 八段之一／--run-id 建议显式／
 *   --source-root 仅 register 必填其余可省／--base-model 仅 training_prep（本地模型目录
 *   绝对路径；K-E14a 拆分后渲染位吃 --base-model-family，内核段模式另有盘上只读再水合，
 *   harness 案 a＝必填显式值卡前快败；E8 起 assemble 模式豁免——run 级联合装配由内核
 *   再水合单源，恢复不了内核 blocked 指路）／--assemble 仅 training_prep（E8 store_true：
 *   true＝run 级联合装配——枚举单据槽位合并＋生成迭代配置与启动件，与 --doc-type 单类
 *   语义互斥，true 时不传 doc_type）／--base-model-family 全局（内核缺省 qwen3_vl
 *   不下传；显式给且非空才追加——渲染口径用，E8 联合装配链透传面）／--auto-style-cluster 仅 family_split（三态
 *   auto|on|off，缺省 auto；其它段不下传不报错）／--grouping-preset 仅 experiment_setup
 *   （A|B，缺省 B；未给不下传——按内核缺省处理，D89）／--negative-ratio-target 仅
 *   experiment_setup（<下限,上限> 形态如 0.03,0.06；显式给才下传——内核以该值进实验门
 *   并标 user_specified，缺省按构造器常量带兜底，D99）／--train-all／--assignment-source／
 *   --reuse-experiment-setup 全局三参（内核 argparse 已声明、多段读取；给才下传，D93）。
 *   本工具下传 argv 只含上述参数，禁传内核未声明
 *   参数、禁拼第二套路径。
 *   落点（唯一）＝<workspace_path>/runs/<run_id>——本工具内 resolveRunDir 退役
 *   （内核与 harness 同一决定者，其余工具不受影响）。
 *   register 段准入口径（E8b·内核 b13 起）：非空 run 目录不再整体拦——带合法
 *   run.json 即 canonical 复用，同一 run 可继续登记其它单据（无需 --rerun）；
 *   同单据本段已放行且无 --rerun → register_already_done_skip（ok 零产物不覆写）；
 *   walkthrough_run_dir_not_empty 收缩为「非空但缺合法 run.json」兜底（错误回流
 *   kernelErrorFace 指引补齐 run.json，不引导换 run）。
 *   退出码：0 贯通／2 有拒绝（越序等，blocked）／3 环境错误。
 *   摘要面（E10b）：真内核段模式摘要落盘不落 stdout——stdout 解析缺席时回读内核
 *   缺省落点 <runDir>/stage-<段>.summary.json（同一份内核摘要；run_id/stage 双对账
 *   防陈旧件），rejections／聚类证据五键等既有透传面据此在真跑下生效。
 *
 * 事实轨与绑定（A2/A3 延续）：exit 0 → appendSegmentFact(runDir, 映射键, 本工具)＋
 *   appendBinding(runDir, sessionId)（sessionId 取不到如实跳过）；exit 2/3 一律零写入。
 *   映射表（kernel stage → UI segment）：experiment_setup→experiment_config、
 *   candidate_build→candidate、family_split→split、training_prep→null（只落事实轨
 *   不点灯——null 即按内核原文名落事实，该名不在前缀闭包读面）；candidate 键亦不在
 *   前缀闭包内（闭包语义不动）。
 *
 * D24h：段放行调用追加账本身份三参——--actor sessionIdOf(exec)??unattributed（会话缺失
 * 如实 unattributed，不伪造 owner 字面量）／--approval-mode ui／--round-dir runDir（本段
 * 落点 run 目录，内核账本 round_dir 字段面）；内核 stdout 携 approval_id 时回传返回体
 * approval_entry_id（解析失败省略键不阻断段回报，stderr 记一条）；卡面追加放行权属行
 * 「仅 owner 可点；执行方不得代点」。
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { appendSegmentFact, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { scanKernelErrorFace } from "../../../../src/core/workspace/kernelErrorFace.js";
// E3：像素对成对校验判据单源（configConfirm pixelPairViolationOf——文案与九要素卡同源）
import { pixelPairViolationOf } from "../../../../src/webui/configConfirm.js";
// E4-乙：bs 内核缺省分档单源＋accum 派生（training_overrides 桥 convention/derived 兜底）
import { deriveGradAccum, kernelBsDefaultOf } from "../../../../src/core/workspace/smartDefaults.js";
import { join } from "node:path";

/** 段名闭集（权威＝内核 STAGE_ORDER 八项——禁增删改序；旧六段名别名不保留）。 */
export const PIPELINE_STAGES: readonly string[] = [
  "register",
  "label_qc",
  "experiment_setup",
  "candidate_build",
  "publish",
  "family_split",
  "admission",
  "training_prep",
];

/** kernel stage → UI segment 映射表（A2.2b 落常量；D3/D4 起单源迁 src/core/workspace/
 *  segmentFacts.ts——import＋re-export 同一常量，atf-ui 兜底源同表消费，禁第二套）。 */
export { SEGMENT_FACT_BY_KERNEL_STAGE };

/** 会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过——confirmFace 同款）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

// ── A-E14b：training_prep 段 base_model_path（案 a 配合 K-E14a 语义拆分）──

/** 卡前快败指路文案（base_model_path_missing）：本地模型目录绝对路径语义＋可用模型清单
 *  来源＝ATF_MODEL_ROOT env（清单经既有 scanLocalModels 单源扫取，零写死模型根、零绝对路径
 *  字面量；清单缺失时只指路 env，不猜）。 */
export const baseModelPathGuidance = (env: Readonly<Record<string, string | undefined>> = process.env): string => {
  const head =
    "training_prep 段必填 base_model_path——本地模型目录绝对路径（目录内须有 config.json）；模型家族名（如 qwen3_vl）不可当路径用";
  const inv = scanLocalModels(env);
  if (inv.models.length > 0) {
    const listing = `${inv.models.slice(0, 3).join("、")}${inv.models.length > 3 ? `（共 ${inv.models.length} 个）` : ""}`;
    return `${head}；可用模型清单（来源 ATF_MODEL_ROOT，前三）：${listing}`;
  }
  return `${head}；可用模型清单来源＝环境变量 ATF_MODEL_ROOT（未设置或无模型时先配置模型存放根再重试）`;
};

/** 返回面 base_model_source 对账值：explicit＝harness 显式下传 --base-model（显式值优先——
 *  内核对显式值不再再水合）；kernel_rehydrated＝内核盘上只读再水合（K-E14a）——对端摘要
 *  携带 base_model_source 字段时透传（对账词汇；本工具 training_prep 必填显式值，
 *  该分支为对端如实回流保留）。 */
export const baseModelSourceOf = (explicit: boolean, summary: unknown): "explicit" | "kernel_rehydrated" | undefined => {
  if (explicit) return "explicit";
  const src = (summary as Record<string, unknown> | null)?.["base_model_source"];
  return src === "kernel_rehydrated" || src === "explicit" ? src : undefined;
};

// ── E10b：family_split 段版式聚类三态透传（内核 main E10a 命令面）──

/** auto_style_cluster 词汇闭集（权威＝内核 argparse choices；缺省 auto 同源）。 */
export const AUTO_STYLE_CLUSTER_VALUES: readonly string[] = ["auto", "on", "off"];

/** 聚类证据提取：内核段摘要在 results[].raw_response.style_cluster_state 随段留痕
 *  （blocked/通过/异常三路统一嵌套，五键形态）——本工具只透传 {state,pages_total,
 *  pages_with_cluster} 三键供解释「为什么没开」；summary 不携带或形态不合法一律
 *  undefined（不猜值不造默认）。 */
export const styleClusterStateOf = (
  summary: unknown,
): { state: string; pages_total: number; pages_with_cluster: number } | undefined => {
  const results = (summary as Record<string, unknown> | null)?.["results"];
  if (!Array.isArray(results)) return undefined;
  for (const entry of results) {
    const raw = (entry as Record<string, unknown> | null)?.["raw_response"];
    const evidence = (raw as Record<string, unknown> | null)?.["style_cluster_state"];
    if (evidence === null || typeof evidence !== "object") continue;
    const state = (evidence as Record<string, unknown>)["state"];
    const pagesTotal = (evidence as Record<string, unknown>)["pages_total"];
    const pagesWithCluster = (evidence as Record<string, unknown>)["pages_with_cluster"];
    if (typeof state === "string" && typeof pagesTotal === "number" && typeof pagesWithCluster === "number") {
      return { state, pages_total: pagesTotal, pages_with_cluster: pagesWithCluster };
    }
  }
  return undefined;
};

/** 聚类状态拒绝码识别（rejections 数组或单对象两形态都认——内核数组、mock 对象）。
 *  闭集＝三态拒绝三码（E10a 两码＋E10e-1 off 矛盾新码——同属「版式分组状态确认」
 *  决策面，note／user_message 兜底同触发；E10d 扩面登记）。 */
export const styleClusterRejectionOf = (rejections: unknown): boolean => {
  const items = Array.isArray(rejections) ? rejections : [rejections];
  const CLUSTER_CODES: readonly string[] = [
    "style_cluster_state_not_clustered",
    "style_cluster_state_ambiguous",
    "style_cluster_declared_but_absent",
  ];
  for (const item of items) {
    const codes = (item as Record<string, unknown> | null)?.["reason_codes"];
    if (!Array.isArray(codes)) continue;
    if (codes.some((code) => CLUSTER_CODES.includes(code as string))) return true;
  }
  return false;
};

/** 聚类拒绝回流指引（E10d 改版——agent 面产品口径）：内核 user_message 原样告知用户，
 *  用户回答后按其选择重试；不向用户展示内部选项名。 */
export const STYLE_CLUSTER_REJECTION_NOTE =
  "把 user_message 原样告知用户；用户回答后按其选择重试（已分组→直接分层；未分组→先分组再分层）。" +
  "不要向用户展示 auto/on/off 等内部选项名。";

/** user_message 业务兜底（内核未携带时——旧版本/异常；E10d）：业务语言，零内部词。 */
export const STYLE_CLUSTER_USER_MESSAGE_FALLBACK =
  "这批数据的版式分组状态无法确认，请确认数据是否已按版式分组后再试。";

/** user_message 提取：内核拒绝在 raw_response.user_message 携带业务文案（E10e 起，
 *  与 reason_code 并列随段记录）——原样取出，不加工不拼接；无串/形态非法＝undefined。 */
export const userMessageOf = (summary: unknown): string | undefined => {
  const results = (summary as Record<string, unknown> | null)?.["results"];
  if (!Array.isArray(results)) return undefined;
  for (const entry of results) {
    const raw = (entry as Record<string, unknown> | null)?.["raw_response"];
    const message = (raw as Record<string, unknown> | null)?.["user_message"];
    if (typeof message === "string" && message !== "") return message;
  }
  return undefined;
};

// ── D89：experiment_setup 段分组方案（内核 argparse --grouping-preset A/B）──

/** grouping_preset 词汇闭集（权威＝内核 argparse choices：A/B；内核缺省 B 同源——
 *  A＝3 组·按单据层级，B＝2 组·单据级 vs 条目级，仅 experiment_setup 段消费）。 */
export const GROUPING_PRESET_VALUES: readonly string[] = ["A", "B"];

/** 分组方案组构成（审批卡/摘要文案单源——组构成与内核 build_experiment_setup 产出
 *  experiment-config.json 的 grouping 面同源，两处禁第二套文案）。 */
const GROUPING_PRESET_PROFILE: Readonly<Record<string, string>> = {
  A: "3 组·按单据层级：doc_identifier／page_summary／goods_item",
  B: "2 组·单据级 vs 条目级：goods_item／doc_level",
};

/** 审批卡分组方案行（仅 experiment_setup 段追加——分组方案是 owner 卡上要确认的决策点；
 *  「缺省不静默」：未给时明示将按内核缺省 B 处理，不让缺省偷偷生效；B 文案单源复用）。 */
export const groupingPresetApprovalLine = (preset: string): string => {
  const profile = GROUPING_PRESET_PROFILE[preset];
  if (profile !== undefined) return `分组方案：${preset}（${profile}）`;
  return `分组方案：未指定——将按内核缺省 B（${GROUPING_PRESET_PROFILE["B"]}）`;
};

// ── D99：experiment_setup 段负样本目标带（内核 argparse --negative-ratio-target，
//    D90 用户确认值通路的 harness 侧补派——九要素卡 negative_ratio_target 确认值
//    经本参进实验门；内核显式才下传实验门脚本，来源标 user_specified）──

/** 负样本构造带缺省形态（内核构造器常量 NEGATIVE_RATIO_CONSTRUCTION_BAND=(0.02,0.05)
 *  同源——TRAINING_PIN_CONSTANTS.negative_ratio 同值；「缺省不静默」呈现与返回体
 *  kernel_default 标注共用）。 */
export const NEGATIVE_RATIO_DEFAULT_BAND = "0.02,0.05";

/** 审批卡负样本带行（仅 experiment_setup 段追加——与分组方案行同款「缺省不静默」：
 *  显式给标注用户指定；未给明示按构造器内置常量带兜底，不让缺省偷偷生效）。 */
export const negativeRatioApprovalLine = (band: string): string => {
  if (band !== "") return `负样本构造带：${band}（用户指定——实验门以该值锁定）`;
  return `负样本构造带：未指定——将按构造器内置常量带（${NEGATIVE_RATIO_DEFAULT_BAND}）兜底`;
};

// ── E3 补：run 落点解析与内核 canonical RunLayout 对齐 ──

/** E3（缺口 D 执行中发现的落点公式缺口）：内核 run_layout.resolve_run_dir 的 canonical
 *  形态＝<workspace>/workspace/runs/<run_id>（RunLayout v1——上次八段实锚：workspace=
 *  my-zito 根、run 树落 <root>/workspace/runs/），legacy <wp>/runs/<id> 仅旧 run 兼容。
 *  本工具原 runDir 公式恒 <wp>/runs/<id>——在 canonical 树 run 上事实轨/段摘要回读/
 *  E3 预算三参快照兜底全部读错树。本函数与内核同口径：canonical 在场即用 canonical，
 *  否则维持 legacy 公式（新建 run 形态不变）；canonical 为软链拒（E2 同纪律——
 *  不接受镜像/软链自救形态，不可绕过）。 */
export const resolvePipelineRunDir = (
  workspacePath: string,
  runId: string,
): { runDir: string; layout: "canonical" | "legacy" } | { error: "run_dir_symlink_rejected"; note: string } => {
  const canonical = join(workspacePath, "workspace", "runs", runId);
  try {
    if (existsSync(canonical)) {
      if (lstatSync(canonical).isSymbolicLink()) {
        return { error: "run_dir_symlink_rejected", note: "run 目录落点是软链——请使用真实工作区路径（不接受镜像/软链）" };
      }
      return { runDir: canonical, layout: "canonical" };
    }
  } catch { /* 探测失败按不存在处理——落 legacy 公式 */ }
  return { runDir: join(workspacePath, "runs", runId), layout: "legacy" };
};

// ── E3：experiment_setup 段预算三参（max_total_tokens／像素对）——显式 > 确认快照
//    兜底 > unspecified（不下传）。九要素确认卡的预算三要素经本通路进实验门（缺口 D
//    产品管道：确认卡落 config-snapshot.json → 本段工具兜底读并下传，全程零代写）。──


/** 预算三参来源三值闭集（审批卡/返回体逐参标注——「缺省不静默」）。 */
export type ExperimentTokenParamSource = "user_specified" | "config_snapshot" | "unspecified";

/** 三参键闭集（参数名与快照 confirmed 键、九要素卡键同名同义）。 */
export const EXPERIMENT_TOKEN_PARAM_KEYS: readonly string[] = ["max_total_tokens", "image_min_pixels", "image_max_pixels"];

/** 来源标注文案（审批卡行单源）。 */
export const TOKEN_PARAM_SOURCE_LABEL: Readonly<Record<ExperimentTokenParamSource, string>> = {
  user_specified: "用户指定",
  config_snapshot: "确认快照",
  unspecified: "未指定——内核按缺省处理",
};

/** 显式参数取值校验：安全正整数（非此形态卡前快败——fail-closed 不猜不修不夹取）。 */
export const isSafePositiveInteger = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && (raw as number) > 0;

/** run 目录确认快照兜底读取（webui/config-snapshot.json 的 confirmed 子对象三键；
 *  快照缺席/键非安全正整数＝该键无兜底值（如实 unspecified，不造占位）。 */
export const snapshotTokenParamsOf = (
  runDir: string,
): { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number } => {
  const out: { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number } = {};
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "webui", "config-snapshot.json"), "utf8")) as {
      confirmed?: Record<string, unknown>;
    };
    const confirmed = parsed?.confirmed;
    if (confirmed === null || typeof confirmed !== "object") return out;
    for (const key of EXPERIMENT_TOKEN_PARAM_KEYS) {
      const raw = (confirmed as Record<string, unknown>)[key];
      // 快照键值历史形态为字符串（九要素卡值全字符串面）——数字/纯数字串均认
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (isSafePositiveInteger(num)) out[key as "max_total_tokens" | "image_min_pixels" | "image_max_pixels"] = num;
    }
  } catch { /* 快照缺席/解析失败＝无兜底值（fail-open：兜底面不阻塞段触发） */ }
  return out;
};

/** 预算三参终值解析（仅 experiment_setup 段调用）：显式参数 > 快照兜底，逐参独立
 *  来源标注；显式值非法形态直接快败（error 不下传不进审批——坏参数不消耗放行）。 */
export const resolveExperimentTokenParams = (
  args: { max_total_tokens?: unknown; image_min_pixels?: unknown; image_max_pixels?: unknown },
  runDir: string,
):
  | {
      ok: true;
      values: { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number };
      sources: Record<string, ExperimentTokenParamSource>;
    }
  | { ok: false; error: string; note: string } => {
  const values: { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number } = {};
  const sources: Record<string, ExperimentTokenParamSource> = {};
  const snapshot = snapshotTokenParamsOf(runDir);
  const labels: Record<string, string> = {
    max_total_tokens: "max_total_tokens（单样本 token 上限，正整数）",
    image_min_pixels: "image_min_pixels（最小像素，正整数）",
    image_max_pixels: "image_max_pixels（最大像素，正整数）",
  };
  for (const key of EXPERIMENT_TOKEN_PARAM_KEYS) {
    const raw = (args as Record<string, unknown>)[key];
    if (raw === undefined) {
      const fallback = snapshot[key as keyof typeof snapshot];
      if (fallback !== undefined) {
        values[key as keyof typeof values] = fallback;
        sources[key] = "config_snapshot";
      } else {
        sources[key] = "unspecified";
      }
      continue;
    }
    if (!isSafePositiveInteger(raw)) {
      return { ok: false, error: `${key}_invalid`, note: `${labels[key]}——得 ${String(raw)}（非安全正整数即拒，不夹取）` };
    }
    values[key as keyof typeof values] = raw;
    sources[key] = "user_specified";
  }
  return { ok: true, values, sources };
};

/** 审批卡预算三参行（仅 experiment_setup 段追加——终值与来源双双上卡；unspecified
 *  明示「内核按缺省处理」，缺省不静默）。 */
export const experimentTokenApprovalLine = (
  values: { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number },
  sources: Record<string, ExperimentTokenParamSource>,
): string =>
  `预算三参（实验门）：${EXPERIMENT_TOKEN_PARAM_KEYS.map((key) => {
    const value = values[key as keyof typeof values];
    return `${key}=${value !== undefined ? String(value) : "未定"}（${TOKEN_PARAM_SOURCE_LABEL[sources[key] ?? "unspecified"]}）`;
  }).join("／")}`;

// ── E4-乙（改动 1）：training_prep 段 training_overrides——九键白名单训练参数单源桥 ──
//    （确认卡 → 快照〔唯一出口〕 → 本桥下传；convention 态只呈现不下传——缺省单源在内核）

/** training_overrides 九键白名单（内核 b9 generate_iteration_config TRAINING_OVERRIDES_KEYS
 *  逐字同源——E4-乙补：harness 原第十键 visible_devices 系误列，内核明确排除（执行面走
 *  deploy/launch）；warmup_ratio 补齐）。base_model_path 走 training_prep 段 --base-model
 *  专参（A-E14b）、dataset_keys 内核实算只读（D92）、negative_ratio_target 归
 *  experiment_setup 段（D99）、visible_devices 走 deploy/launch——皆不入本桥。 */
export const TRAINING_OVERRIDE_KEYS: readonly string[] = [
  "per_device_train_batch_size",
  "gradient_accumulation_steps",
  "nproc_per_node",
  "num_train_epochs",
  "learning_rate",
  "lora_rank",
  "lora_alpha",
  "deepspeed",
  "warmup_ratio",
];

/** 整数键闭集（内核 parse_training_overrides 的 isinstance(value,int) 面——下传 JSON 须原生
 *  整数，字符串数字会被 training_overrides_value_invalid 拒；呈现面仍统一字符串）。 */
export const TRAINING_OVERRIDE_INT_KEYS: ReadonlySet<string> = new Set([
  "per_device_train_batch_size",
  "gradient_accumulation_steps",
  "nproc_per_node",
  "num_train_epochs",
  "lora_rank",
  "lora_alpha",
]);

/** 禁入键专项闭集（像素对＋TokenBudget 三键——分别走 experiment_setup 预算三参（E3）
 *  与 token 预算链路（内核 K1-2：cutoff 唯一来源 prep/token_budget.json）；混入本桥
 *  即双源，卡前快败）。 */
export const TRAINING_OVERRIDE_FORBIDDEN_KEYS: readonly string[] = [
  "image_min_pixels",
  "image_max_pixels",
  "max_total_tokens",
  "cutoff_len",
  "max_model_len",
];

/** training_overrides 逐键来源四值闭集（审批卡/返回体标注——「缺省不静默」）。 */
export type TrainingOverrideSource = "user_confirmed" | "config_snapshot" | "derived" | "convention";

/** 来源标注文案（审批卡行单源；user_confirmed＝当次显式确认值、config_snapshot＝九要素
 *  确认快照、derived＝global_batch=256 派生、convention＝内核惯例缺省〔只呈现不下传〕）。 */
export const TRAINING_OVERRIDE_SOURCE_LABEL: Readonly<Record<TrainingOverrideSource, string>> = {
  user_confirmed: "用户确认",
  config_snapshot: "确认快照",
  derived: "派生",
  convention: "内核惯例",
};

/** run 目录确认快照兜底读取（webui/config-snapshot.json 的 confirmed 子对象——九键
 *  白名单筛＋bs 分档输入 cutoff_len〔仅判档用，不在白名单、不下传〕；快照缺席/解析
 *  失败＝空兜底（fail-open：兜底面不阻塞段触发）。 */
export const snapshotTrainingOverridesOf = (
  runDir: string,
): { overrides: Record<string, string>; cutoffLen: number | undefined } => {
  const out: Record<string, string> = {};
  let cutoffLen: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "webui", "config-snapshot.json"), "utf8")) as {
      confirmed?: Record<string, unknown>;
    };
    const confirmed = parsed?.confirmed;
    if (confirmed === null || typeof confirmed !== "object") return { overrides: out, cutoffLen };
    for (const key of TRAINING_OVERRIDE_KEYS) {
      const raw = (confirmed as Record<string, unknown>)[key];
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        out[key] = String(raw);
      }
    }
    const rawCutoff = (confirmed as Record<string, unknown>)["cutoff_len"];
    const cutoffNum = typeof rawCutoff === "number" ? rawCutoff : typeof rawCutoff === "string" ? Number(rawCutoff.trim()) : NaN;
    if (Number.isFinite(cutoffNum) && cutoffNum > 0) cutoffLen = cutoffNum;
  } catch { /* 快照缺席/解析失败＝无兜底值 */ }
  return { overrides: out, cutoffLen };
};

/** training_overrides 终值解析（仅 training_prep 段调用）：显式参数 > 确认快照 >
 *  accum 派生（bs×nproc 终值在场时，global_batch=256 整除校验——除不尽停点）>
 *  convention（bs 内核分档缺省／deepspeed ds_z3_offload——只呈现不下传）。
 *  白名单外键/禁入键/值形态非法＝卡前快败（先于审批，坏参数不消耗放行）。 */
export const resolveTrainingOverrides = (
  args: { training_overrides?: unknown },
  runDir: string,
):
  | {
      ok: true;
      values: Record<string, string>;
      sources: Record<string, TrainingOverrideSource>;
      /** 注入面（convention 态不含——缺省单源在内核；数值键已转内核 parse 契约的
       *  原生 number 形态，learning_rate/deepspeed 保持字符串）。 */
      passDown: Record<string, string | number>;
    }
  | { ok: false; error: string; note: string } => {
  const raw = args.training_overrides;
  const explicit: Record<string, string> = {};
  if (raw !== undefined) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "training_overrides_invalid", note: `training_overrides 须为键值对象（得 ${Array.isArray(raw) ? "数组" : typeof raw}）` };
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (TRAINING_OVERRIDE_FORBIDDEN_KEYS.includes(key)) {
        return {
          ok: false,
          error: "training_overrides_forbidden_key",
          note: `training_overrides 不收 ${key}——像素对（image_min_pixels/image_max_pixels）与 TokenBudget 三键（max_total_tokens/cutoff_len/max_model_len）分别走 experiment_setup 段预算三参与 token 预算链路，混入即双源`,
        };
      }
      if (!TRAINING_OVERRIDE_KEYS.includes(key)) {
        return { ok: false, error: "training_overrides_invalid", note: `training_overrides 键 ${key} 不在九键白名单（${TRAINING_OVERRIDE_KEYS.join("/")}）——白名单外参数不收` };
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return { ok: false, error: "training_overrides_invalid", note: `training_overrides[${key}] 须为字符串/数字/布尔（得 ${value === null ? "null" : Array.isArray(value) ? "数组" : typeof value}）` };
      }
      explicit[key] = String(value);
    }
  }
  const snapshotBundle = snapshotTrainingOverridesOf(runDir);
  const snapshot = snapshotBundle.overrides;
  const values: Record<string, string> = {};
  const sources: Record<string, TrainingOverrideSource> = {};
  for (const key of TRAINING_OVERRIDE_KEYS) {
    if (explicit[key] !== undefined) {
      values[key] = explicit[key];
      sources[key] = "user_confirmed";
    } else if (snapshot[key] !== undefined) {
      values[key] = snapshot[key];
      sources[key] = "config_snapshot";
    }
  }
  // derived：accum 无终值而 bs×nproc 终值在场 → global_batch=256 派生（除不尽停点——禁静默取整）
  if (values["gradient_accumulation_steps"] === undefined) {
    const bsNum = Number(values["per_device_train_batch_size"]);
    const nprocNum = Number(values["nproc_per_node"]);
    if (Number.isFinite(bsNum) && bsNum > 0 && Number.isFinite(nprocNum) && nprocNum > 0) {
      const derived = deriveGradAccum(Math.round(bsNum), Math.round(nprocNum));
      if ("error" in derived) {
        return { ok: false, error: "training_overrides_derive_failed", note: `gradient_accumulation_steps 派生失败（bs=${values["per_device_train_batch_size"]}×nproc=${values["nproc_per_node"]}）：${derived.error}——请调整组合或显式给出 accum` };
      }
      values["gradient_accumulation_steps"] = String(derived.accum);
      sources["gradient_accumulation_steps"] = "derived";
    }
  }
  // convention（只呈现不下传——缺省单源在内核）：bs 按 cutoff 分档（cutoff 取快照确认值
  // 〔分档输入，仅判档〕，缺席按惯例基线判档）；deepspeed 与内核统一 ds_z3_offload
  // （E4-乙改动 2 同批）。
  if (values["per_device_train_batch_size"] === undefined) {
    values["per_device_train_batch_size"] = String(kernelBsDefaultOf(snapshotBundle.cutoffLen));
    sources["per_device_train_batch_size"] = "convention";
  }
  if (values["deepspeed"] === undefined) {
    values["deepspeed"] = "ds_z3_offload";
    sources["deepspeed"] = "convention";
  }
  const passDown: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (sources[key] === "convention") continue;
    // 内核 parse 契约：整数键原生 number（字符串数字会被拒）；warmup_ratio number；
    // learning_rate 数值串原样（内核 str(value).strip() 面）；deepspeed 字符串。
    if (TRAINING_OVERRIDE_INT_KEYS.has(key)) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        passDown[key] = Math.round(num);
        continue;
      }
    }
    if (key === "warmup_ratio") {
      const num = Number(value);
      if (Number.isFinite(num)) {
        passDown[key] = num;
        continue;
      }
    }
    passDown[key] = value;
  }
  return { ok: true, values, sources, passDown };
};

/** training_overrides 审批卡行（仅 training_prep 段追加——终值与来源逐键上卡；
 *  convention 态明示「内核惯例（只呈现不下传）」，缺省不静默）。 */
export const trainingOverridesApprovalLine = (
  values: Record<string, string>,
  sources: Record<string, TrainingOverrideSource>,
): string =>
  `训练参数覆盖（training_prep）：${
    TRAINING_OVERRIDE_KEYS.filter((key) => values[key] !== undefined)
      .map((key) => `${key}=${values[key]}（${TRAINING_OVERRIDE_SOURCE_LABEL[sources[key] ?? "convention"]}${sources[key] === "convention" ? "·只呈现不下传" : ""}）`)
      .join("／") || "（无终值——全部按内核缺省处理）"
  }`;

// ── E5·H3（D140）：training_prep 段训练输出目录 output_dir 终值呈现（落点可见）──
//    （盘上 IterationConfig 的 output.output_dir 单源——harness 零公式复制；缺席时按
//    内核 ADR-0005 run 布局呈现预期值并标注来源，段产出后以落盘终值为准）

/** output_dir 来源两值闭集：iteration_config＝盘上配置终值（内核产出）；
 *  kernel_layout＝内核 ADR-0005 run 布局预期（<run>/training——审批时点配置未产出的
 *  首跑场景，落点可见的预期呈现）。 */
export type TrainingOutputDirSource = "iteration_config" | "kernel_layout";

/** 训练输出目录终值解析（training_prep 段专用）：盘上 IterationConfig 的
 *  output.output_dir 原样读出（live prep/iteration-config.json ＞ legacy
 *  prep/iteration-config/iteration-config.json——prelaunchFace detectIterationConfig
 *  同序同源；文件在而 output.output_dir 非串＝不采信，按缺席处理不猜值）；
 *  两形态缺席＝内核 ADR-0005 run 布局预期 join(runDir,"training")。 */
export const trainingOutputDirOf = (
  runDir: string,
): { outputDir: string; source: TrainingOutputDirSource } => {
  for (const candidate of [join(runDir, "prep", "iteration-config.json"), join(runDir, "prep", "iteration-config", "iteration-config.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        output?: { output_dir?: unknown };
      };
      const raw = parsed?.output?.output_dir;
      if (typeof raw === "string" && raw.trim() !== "") return { outputDir: raw, source: "iteration_config" };
    } catch { /* 该形态缺席/解析失败＝试下一形态 */ }
  }
  return { outputDir: join(runDir, "training"), source: "kernel_layout" };
};

/** output_dir 审批卡行（仅 training_prep 段追加——训练产物落点可见；来源随注：
 *  盘上终值〔重跑场景〕或内核 run 布局预期〔首跑——段产出后以落盘终值为准〕）。 */
export const trainingOutputDirApprovalLine = (resolved: { outputDir: string; source: TrainingOutputDirSource }): string =>
  `训练输出目录（output_dir）：${resolved.outputDir}（${resolved.source === "iteration_config" ? "盘上迭代配置终值" : "内核 run 布局预期——段产出后以落盘终值为准"}）`;


/** 子进程封装（execFile——非零退出/超时如实回传，不抛；F1 预检工具同源复用）。 */
export const runPipeline = (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, ...rest] = command.split(" ");
    execFile(
      file ?? command,
      [...rest, ...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // 非零退出也返回（如实回报；超时时 code 为 null）
        const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export const buildPipelineTool = (
  ctx: { get(service: string): unknown },
  pipelineCommand: string,
  pipelineTimeoutMs: number,
): unknown =>
  defineTool({
    name: "atf_pipeline_stage",
    description:
      `按段驱动 walkthrough_pipeline 段模式（审批必经）：单段触发 ${PIPELINE_STAGES.join("/")} 之一。` +
      `落点＝<workspace_path>/runs/<run_id>（与内核同源唯一落点）；workspace_path 必填绝对路径（贯通内核 workspace），` +
      `run_id 必填；source_root 仅 register 段必填（其余段可省——缺了也不影响非 register 段）。` +
      `register 段准入口径（一个 run 可承载多类单据）：同一 run 可继续登记其它单据（多类联合训练共用一个 run，` +
      `无需换 run-id——逐类带各自 doc_type 调 register 即可）；同单据本段重复登记为幂等跳过` +
      `（register_already_done_skip——成功态、零产物、已确认产物不覆写，可直接继续下一段）。` +
      `base_model_path 仅 training_prep 段必填（本地模型目录绝对路径，含 config.json；模型家族名（如 qwen3_vl）不可当路径用——` +
      `缺参/非绝对路径在审批卡前快败，指路 ATF_MODEL_ROOT 可用模型清单；其它段忽略该参）。` +
      `family_split 段另支持 auto_style_cluster 三态（缺省 auto，其它段忽略该参）：` +
      `auto＝先检测——已聚类则不复聚；未聚类/状态不明会拒绝并指路。` +
      `experiment_setup 段另支持 grouping_preset 分组方案（缺省按内核缺省 B 处理，其它段忽略该参；` +
      `返回体如实标注分组来源，审批卡呈现分组方案供确认）。` +
      `experiment_setup 段另支持 negative_ratio_target 负样本目标带 <下限,上限>（其它段忽略该参）：` +
      `显式给定时实验门以该值锁定并标注用户指定；不给时按构造器内置常量带兜底（审批卡与返回体均如实标注来源）。` +
      `experiment_setup 段另支持预算三参 max_total_tokens／image_min_pixels／image_max_pixels（其它段忽略）：` +
      `显式给 > run 目录 webui/config-snapshot.json 确认快照兜底 > 皆无则不下传（内核按缺省处理）；` +
      `审批卡与返回体逐参呈现终值与来源（user_specified／config_snapshot／unspecified）；` +
      `像素对须成对提供且 min<max（成对校验先于审批——单端或越界即卡前快败）。` +
      `收到版式聚类状态类拒绝（style_cluster_state_not_clustered／style_cluster_state_ambiguous／` +
      `style_cluster_declared_but_absent）时，必须先问用户「这批数据做过版式聚类吗？」，` +
      `确认后再传 on（未聚类——内核自动补簇并产出 StyleClusterManifest/v1，按簇分层）或 off（已聚类——不再聚）重跑；` +
      `禁止在 auto 被拒后自行猜一个值重跑。` +
      `doc_type／lane_suffix／field_config 三件可缺省（缺省不上送，各段均有效）：` +
      `不传 doc_type 时内核按数据/登记面推断单据类型，无法确定即 blocked（会带业务文案指路）——` +
      `需显式指定或补登记面后重跑；field_config 须为字段配置文件显式路径。` +
      `train_all／assignment_source／reuse_experiment_setup 三件为全局参数（各段均有效，给才下传，缺省不开）：` +
      `train_all 与 assignment_source 互斥——二选一，同时给会被内核拒绝（harness 不复制该校验）。` +
      `越序段会被内核拒绝（blocked，exit 2）——按段序逐段触发。段成功退出（exit 0）即在落点 run 目录落段事实与会话绑定` +
      `（胶囊数据源；experiment_setup/candidate_build/training_prep 按映射口径落事实，点灯以内核段序闭包为准）；` +
      `exit 2（blocked）／exit 3（环境错误）一律零写入。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的内核管线段（八段原文，单段）" },
      run_id: { type: "string", required: true, description: "run 标识（落点 <workspace_path>/runs/<run_id>）" },
      workspace_path: { type: "string", required: true, description: "workspace 根（必填绝对路径——内核贯通 workspace；落点单源起点）" },
      source_root: { type: "string", description: "源文档根（仅 register 段必填；其余段可省）" },
      base_model_path: { type: "string", description: "本地模型目录绝对路径（含 config.json）；模型家族名（如 qwen3_vl）不可当路径用（training_prep 段必填，其它段忽略；assemble=true 时豁免——内核盘上再水合单源，恢复不了内核 blocked 指路）" },
      assemble: { type: "boolean", description: "run 级联合装配（仅 training_prep 段有效，其它段忽略）：true 时下传 --assemble——内核枚举 run 的单据槽位（prep/variants/<doc>/）合并生成迭代配置与启动件；与 doc_type 单类语义互斥，true 时不传 doc_type" },
      base_model_family: { type: "string", description: "基模型家族标识（内核全局参数，渲染口径用，缺省 qwen3_vl 不下传；显式给且非空才追加——E8 联合装配链由 atf_joint_train 透传）" },
      auto_style_cluster: {
        type: "string",
        enum: [...AUTO_STYLE_CLUSTER_VALUES],
        description:
          "版式聚类三态（仅 family_split 段有意义，其它段忽略该参）：auto＝先检测（缺省）——已聚类则不复聚；" +
          "未聚类/状态不明会拒绝并指路。on＝显式开启内核自动补簇（问明未聚类后用）。off＝不再聚（问明已聚类后用）。" +
          "收到版式聚类状态类拒绝（style_cluster_state_not_clustered／style_cluster_state_ambiguous／" +
          "style_cluster_declared_but_absent）时，必须先问用户「这批数据做过版式聚类吗？」，" +
          "确认后再传 on 或 off 重跑；禁止在 auto 被拒后自行猜一个值重跑。" +
          "对用户表述用业务语言：问「这批数据是否已经按版式分好组」，不要念枚举值",
      },
      allow_small_cluster_test: {
        type: "boolean",
        description:
          "当所有版式分组都太小、无法留出测试集时，用户坚持要测试集才用；每个小类只留 1 页，测试样本很少" +
          "（仅 family_split 段有意义，其它段忽略；缺省不开，不由系统自动推断）",
      },
      grouping_preset: {
        type: "string",
        enum: [...GROUPING_PRESET_VALUES],
        description:
          "实验分组方案（仅 experiment_setup 段有意义，其它段忽略该参）：A＝3 组·按单据层级" +
          "（doc_identifier／page_summary／goods_item）；B＝2 组·单据级 vs 条目级（goods_item／doc_level）。" +
          "不给时按内核缺省 B 处理（不静默——返回体如实标注分组来源，审批卡亦明示）",
      },
      negative_ratio_target: {
        type: "string",
        description:
          "负样本目标带 <下限,上限>（仅 experiment_setup 段有意义，其它段忽略该参）：用户确认的" +
          "负样本构造配额带（如 0.03,0.06）。显式给定时实验门以该值锁定并标注来源为用户指定；" +
          "不给时按构造器内置常量带（0.02,0.05）兜底（不静默——审批卡与返回体如实标注来源）。" +
          "九要素确认卡的 negative_ratio_target 值在本段触发时应原样带入",
      },
      // E3：预算三参（仅 experiment_setup 段；显式 > 确认快照兜底 > unspecified 不下传）
      max_total_tokens: {
        type: "number",
        description:
          "单样本 token 上限（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数）：与像素对成组进实验门。" +
          "未显式给定时读 run 目录 webui/config-snapshot.json 确认快照兜底（九要素确认值通路——原样带入）；" +
          "两者皆无则不下传（内核按缺省处理，来源如实标注 unspecified）",
      },
      image_min_pixels: {
        type: "number",
        description:
          "最小像素（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数）：与 image_max_pixels 成对提供——" +
          "只给一端会卡前快败（半新半旧的像素对会让坐标换算与 token 预算用两套口径），两端都在场时须 min<max。未显式给定时读确认快照兜底；皆无则不下传",
      },
      image_max_pixels: {
        type: "number",
        description:
          "最大像素（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数）：与 image_min_pixels 成对提供（单端即卡前快败）；" +
          "改值影响坐标换算与 token 预算。未显式给定时读确认快照兜底；皆无则不下传",
      },
      doc_type: { type: "string", description: "单据类型（可缺省——缺省不上送，内核按数据/登记面推断，无法确定即 blocked；给了则显式指定）" },
      lane_suffix: { type: "string", description: "lane 后缀（可缺省——缺省不上送，内核自行推断）" },
      field_config: { type: "string", description: "字段配置文件显式路径（可缺省——缺省不上送，内核走 run 内/登记面既有来源）" },
      train_all: {
        type: "boolean",
        description:
          "全部样本入训（后置全量置 train 分区；缺省不开。与 assignment_source 互斥——二选一，同时给会被内核拒绝）",
      },
      assignment_source: {
        type: "string",
        description:
          "外部划分清单目录绝对路径（含 train.txt 与 test.txt 两份页名清单——高级用法，仅显式给定才生效；与 train_all 互斥）",
      },
      reuse_experiment_setup: {
        type: "boolean",
        description:
          "复用 run 内已有用户确认态实验配置、跳过实验门重生成（配置不在场时内核拒绝；缺省不开）",
      },
      // D108 harness 半：token 真算门禁 provider＋坐标 pending 重试两旗标透传（内核全局
      // argparse 参数，不按段 gate——与 D93 三参同款「给才追加」，段内消费语义归内核单源）
      token_provider: {
        type: "string",
        description:
          "token 真算门禁 provider 脚本路径（CPU-only；传入即对变体行真算 token，超实验门上限拒绝落账）。" +
          "显式通道——预检之外需要真算门禁时给；walkthrough 演示链可经内核豁免通道跳过（本参数与豁免互斥，内核裁决）",
      },
      retry_coordinate_pending: {
        type: "boolean",
        description:
          "坐标换算待处理清单重试（训练准备段只重试 pending 清单里的图，成功自动并入 transforms.jsonl 并从清单移除，不重跑全批；清单缺席即无事可做）。缺省不开",
      },
      // E4-乙（改动 1）：training_prep 段训练参数单源桥（九键白名单；显式 > 确认快照构造；
      // E5·H1 D139：随本段命令 argv 直接下传——无需任何后续注入步骤；其它段忽略并记 note）
      training_overrides: {
        type: "object",
        additionalProperties: true,
        description:
          "训练参数覆盖（仅 training_prep 段消费，其它段忽略并记 note）：九键白名单 per_device_train_batch_size／gradient_accumulation_steps／nproc_per_node／num_train_epochs／learning_rate／" +
          "lora_rank／lora_alpha／deepspeed／warmup_ratio——像素对（image_min_pixels/image_max_pixels）与 TokenBudget 三键（max_total_tokens/cutoff_len/max_model_len）不得出现（分别走 experiment_setup 段预算三参与" +
          " token 预算链路，混入即卡前拒绝）；卡位 visible_devices 走 deploy/launch 亦不收。未显式给时读 run 目录 webui/config-snapshot.json 确认快照构造（九要素确认值通路——快照是训练参数唯一出口，" +
          "本桥不做任何代写）；accum 缺而 bs×nproc 在场时按 global_batch=256 派生（除不尽停点）；bs 缺按内核缺省（cutoff<10000→2）、deepspeed 缺按 ds_z3_offload——逐键来源 user_confirmed/config_snapshot/" +
          "derived/convention 在审批卡与返回体呈现（convention 态只呈现，缺省单源在内核）。注入通路（E5·H1 D139）：终值随本段命令 argv 直接下传内核生成器（--training-overrides）——被采纳键内核落账" +
          " param_sources user_confirmed(ref=stage:training_overrides)；本段命令完成后无需任何后续注入步骤",
      },
    },
    output: {
      schema: looseObjectOutput,
      render: renderAsJsonText,
    },
    async execute(
      args: { stage: string; run_id: string; workspace_path?: string; source_root?: string; base_model_path?: string; assemble?: boolean; base_model_family?: string; auto_style_cluster?: string; allow_small_cluster_test?: boolean; grouping_preset?: string; negative_ratio_target?: string; max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number; doc_type?: string; lane_suffix?: string; field_config?: string; train_all?: boolean; assignment_source?: string; reuse_experiment_setup?: boolean; token_provider?: string; retry_coordinate_pending?: boolean; training_overrides?: Record<string, unknown> },
      exec: { agent?: unknown; callId?: string; signal?: unknown },
    ) {
      // fail-closed 参数面（先于审批——坏参数不消耗放行）：workspace_path 必填绝对路径；
      // register 段 source_root 必填；training_prep 段 base_model_path 必填（A-E14b 卡前快败）。
      const workspacePath = typeof args.workspace_path === "string" ? args.workspace_path.trim() : "";
      if (workspacePath === "") {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "workspace_path_missing", note: "workspace_path 必填（绝对路径，内核贯通 workspace 根）——落点＝<workspace_path>/runs/<run_id>，不做 env 隐式缺省" });
      }
      if (!isAbsolute(workspacePath)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "workspace_path_not_absolute", note: `workspace_path 须为绝对路径（得 ${workspacePath}）` });
      }
      if (args.stage === "register" && (args.source_root === undefined || args.source_root.trim() === "")) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "source_root_missing", note: "register 段必填 source_root（源文档根绝对路径）——其余段可省略该参数" });
      }
      // A-E14b：base_model_path——training_prep 段必填（卡前快败 base_model_path_missing，
      // 指路 ATF_MODEL_ROOT 清单；不触审批面板）；其它段忽略该参（不报错、不下传）。
      // harness 只查非空与绝对路径（家族名形态在此 fail-closed，不等内核 exit 2）——
      // 路径是否合法（目录在位/config.json 在场）＝内核闸单源，harness 不复制。
      // E8（H1）：assemble 模式豁免必填——run 级联合装配的 base-model 由内核盘上只读
      // 再水合单源（experiment-config/iteration-config/launch argv 三源），恢复不了内核
      // blocked 指路；harness 不复制再水合（禁第二套水合面）。
      const assembleMode = args.stage === "training_prep" && args.assemble === true;
      const needsBaseModel = args.stage === "training_prep" && !assembleMode;
      const baseModelPath = typeof args.base_model_path === "string" ? args.base_model_path.trim() : "";
      if (needsBaseModel && baseModelPath === "") {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "base_model_path_missing", note: baseModelPathGuidance() });
      }
      if (needsBaseModel && !isAbsolute(baseModelPath)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "base_model_path_not_absolute", note: `base_model_path 须为本地模型目录绝对路径（得 ${baseModelPath}）——模型家族名（如 qwen3_vl）不可当路径用；目录内须有 config.json（合法性由内核闸复核）` });
      }
      // D89：分组方案取值（审批前定——卡面要呈现分组方案行；「按未给处理」＝trim 后空串
      // 一律视同未指定，内核缺省 B 生效。harness 不复制枚举外的校验，choices 越界由框架
      // enum 校验与内核 argparse 双闸）。
      const groupingPreset = typeof args.grouping_preset === "string" ? args.grouping_preset.trim() : "";
      // D99：负样本目标带取值（同 D89 口径——trim 后空串视同未指定；形态合法性由内核
      // 实验门脚本解析（float 化失败即业务拒绝），harness 不复制格式校验不夹取）。
      const negativeRatioTarget = typeof args.negative_ratio_target === "string" ? args.negative_ratio_target.trim() : "";
      // E3：落点单源提前到审批前（预算三参快照兜底要读 run 目录）；canonical 在场优先
      // （内核 RunLayout v1 同口径——canonical <wp>/workspace/runs/<id>，legacy 公式兜底；
      // 软链拒）。argv 的 --workspace 仍传用户原值（workspace 根贯通内核——内核自解析
      // 落点，harness 不代传展开后的路径）。
      const resolvedRun = resolvePipelineRunDir(workspacePath, args.run_id);
      if ("error" in resolvedRun) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      // E3：预算三参（仅 experiment_setup 段）——终值解析（显式 > 确认快照兜底 >
      // unspecified 不下传）＋像素对成对校验（min<max，判据单源 pixelPairViolationOf）；
      // 坏值一律卡前快败不进审批（不消耗放行）；其它段零进入（不加键不下传）。
      let tokenParams:
        | { values: { max_total_tokens?: number; image_min_pixels?: number; image_max_pixels?: number }; sources: Record<string, ExperimentTokenParamSource> }
        | undefined;
      if (args.stage === "experiment_setup") {
        const resolvedParams = resolveExperimentTokenParams(args, runDir);
        if (!resolvedParams.ok) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedParams.error, note: resolvedParams.note });
        }
        // E3：像素对成对校验（内核 b8 main() 参数形状层同款口径——单端即拒，业务
        // 文案对齐；先于审批不消耗放行）＋两端在场时的 min<max 关系校验（判据单源
        // pixelPairViolationOf——与九要素卡同一文案面）。
        const minPx = resolvedParams.values.image_min_pixels;
        const maxPx = resolvedParams.values.image_max_pixels;
        if ((minPx !== undefined) !== (maxPx !== undefined)) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "pixel_pair_half_given",
            note: "像素对必须成对提供：只给一端会得到半新半旧的像素对（坐标换算与 token 预算会用两套口径）——请把 image_min_pixels 与 image_max_pixels 一起提供，或都不提供（走确认快照或内核缺省）",
          });
        }
        const pixelViolation =
          minPx !== undefined && maxPx !== undefined
            ? pixelPairViolationOf([
                { key: "image_min_pixels", value: String(minPx) },
                { key: "image_max_pixels", value: String(maxPx) },
              ])
            : null;
        if (pixelViolation !== null) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "pixel_pair_violation", note: pixelViolation });
        }
        tokenParams = { values: resolvedParams.values, sources: resolvedParams.sources };
      }
      // E4-乙（改动 1）：training_overrides——仅 training_prep 段解析（九键白名单＋来源四值；
      // 坏值/禁键/派生除不尽一律卡前快败不进审批——不消耗放行）；其它段收到该参忽略并记
      // note（返回体 training_overrides_ignored——非消费段传参不报错）。
      let trainingOverrides:
        | { values: Record<string, string>; sources: Record<string, TrainingOverrideSource>; passDown: Record<string, string | number> }
        | undefined;
      const overridesIgnored = args.training_overrides !== undefined && args.stage !== "training_prep";
      if (args.stage === "training_prep") {
        const resolvedOverrides = resolveTrainingOverrides(args, runDir);
        if (!resolvedOverrides.ok) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedOverrides.error, note: resolvedOverrides.note });
        }
        trainingOverrides = { values: resolvedOverrides.values, sources: resolvedOverrides.sources, passDown: resolvedOverrides.passDown };
      }
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage",
        buildApprovalReason({
          action: "触发管线段",
          target: `「${args.stage}」（run ${args.run_id}）`,
          effect: "在 run 目录内写该段产物（register 段另读源文档根）",
          reversible: "段产物可人工清理；已写数据面不自动回滚",
          cost: "按任务卡",
          // D24h：卡面追加放行权属行（与评估 EVAL_RELEASE 卡同款——点卡权属只在 owner）
        })
        // D89：分组方案行仅 experiment_setup 段呈现（其它段该参无意义不上卡）
        + (args.stage === "experiment_setup" ? `\n${groupingPresetApprovalLine(groupingPreset)}` : "")
        // D99：负样本带行仅 experiment_setup 段呈现（与分组方案行同款「缺省不静默」）
        + (args.stage === "experiment_setup" ? `\n${negativeRatioApprovalLine(negativeRatioTarget)}` : "")
        // E3：预算三参行仅 experiment_setup 段呈现（终值与来源双双上卡）
        + (args.stage === "experiment_setup" && tokenParams !== undefined ? `\n${experimentTokenApprovalLine(tokenParams.values, tokenParams.sources)}` : "")
        // E4-乙：训练参数覆盖行仅 training_prep 段呈现（终值与来源逐键上卡；convention 明示只呈现不下传）
        + (args.stage === "training_prep" && trainingOverrides !== undefined ? `\n${trainingOverridesApprovalLine(trainingOverrides.values, trainingOverrides.sources)}` : "")
        // E8·H1：装配模式行仅 training_prep 段呈现（run 级联合装配语义上卡——槽位枚举
        // 与 doc_type 互斥口径可见，卡面不出现落点路径指引）
        + (assembleMode ? "\n装配模式（assemble）：run 级联合装配——枚举本 run 单据槽位合并训练数据并生成迭代配置与启动件（不按单类执行）" : "")
        // E5·H3 D140：训练输出目录行仅 training_prep 段呈现（落点可见——盘上终值优先，
        // 首跑无配置时按内核 ADR-0005 run 布局呈现预期并标注来源）
        + (args.stage === "training_prep" ? `\n${trainingOutputDirApprovalLine(trainingOutputDirOf(runDir))}` : "")
        + "\n仅 owner 可点；执行方不得代点");
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      // 落点单源（A2.2b）：与内核同一决定者 <workspace_path>/runs/<run_id>；resolveRunDir 本工具内退役
      // （E3：runDir 已提前到审批前计算——预算三参快照兜底同源落点，此处不复算）。
      // argv 只传内核声明参数（register 时含 --source-root；training_prep 时含 --base-model
      // ——A-E14b，其它段不追加；family_split 时含 --auto-style-cluster——E10b，缺省 auto
      // 也显式上线解析值；E10d：allow_small_cluster_test 仅 family_split 且 true 才追加
      // 开关，缺省不出现在 argv，其它段不追加不报错）；禁拼第二套路径。
      const argv: string[] = ["--workspace", workspacePath, "--run-id", args.run_id, "--stage", args.stage];
      if (args.stage === "register") argv.push("--source-root", (args.source_root as string).trim());
      if (needsBaseModel) argv.push("--base-model", baseModelPath);
      if (args.stage === "family_split") argv.push("--auto-style-cluster", args.auto_style_cluster ?? "auto");
      if (args.stage === "family_split" && args.allow_small_cluster_test === true) argv.push("--allow-small-cluster-test");
      // D82：单据类型三件透传（给才追加、trim 后非空才上线，缺省不上送——内核自行推断，
      // doc_type 推断不出即 blocked；各段均有效）。与上方段特定追加逻辑并存，零触碰其语义。
      // E8·H1：assemble 模式与 doc_type 单类语义互斥（内核 argparse 同裁）——true 时
      // doc_type 一律不传（run 级联合装配按槽位枚举，不按单类执行）。
      const docType = typeof args.doc_type === "string" ? args.doc_type.trim() : "";
      if (docType !== "" && !assembleMode) argv.push("--doc-type", docType);
      const laneSuffix = typeof args.lane_suffix === "string" ? args.lane_suffix.trim() : "";
      if (laneSuffix !== "") argv.push("--lane-suffix", laneSuffix);
      const fieldConfig = typeof args.field_config === "string" ? args.field_config.trim() : "";
      if (fieldConfig !== "") argv.push("--field-config", fieldConfig);
      // E8·H1：装配模式旗标（仅 training_prep 段且显式 true 才追加——缺省不出现在
      // argv，其它段不追加不报错；内核 b12 声明面 store_true）。
      if (assembleMode) argv.push("--assemble");
      // E8·H2 配套：基模型家族透传（内核全局参数、多段读取——D93 先例不按段 gate；
      // 显式给且 trim 非空才追加，缺省 qwen3_vl 由内核自带不下传——联合装配链经
      // atf_joint_train 透传非缺省家族）。
      const baseModelFamily = typeof args.base_model_family === "string" ? args.base_model_family.trim() : "";
      if (baseModelFamily !== "") argv.push("--base-model-family", baseModelFamily);
      // D89：分组方案透传（仅 experiment_setup 段；显式给且 trim 非空才追加——未给不追加，
      // 内核缺省 B 生效；其它段忽略该参不下传不报错）。与上方段特定/全局追加逻辑并存。
      if (args.stage === "experiment_setup" && groupingPreset !== "") argv.push("--grouping-preset", groupingPreset);
      // D99：负样本目标带透传（仅 experiment_setup 段；显式给且 trim 非空才追加——内核
      // :1155 显式才下传实验门并标 user_specified；未给不追加，构造器常量带兜底；其它段
      // 忽略该参不下传不报错）。
      if (args.stage === "experiment_setup" && negativeRatioTarget !== "") argv.push("--negative-ratio-target", negativeRatioTarget);
      // E3：预算三参透传（仅 experiment_setup 段；终值在场才追加——显式值与快照兜底值
      // 同面下传（内核 b8 argparse --max-total-tokens／--image-min-pixels／
      // --image-max-pixels）；unspecified 不出现在 argv，零新增语义）。
      if (args.stage === "experiment_setup" && tokenParams !== undefined) {
        if (tokenParams.values.max_total_tokens !== undefined) argv.push("--max-total-tokens", String(tokenParams.values.max_total_tokens));
        if (tokenParams.values.image_min_pixels !== undefined) argv.push("--image-min-pixels", String(tokenParams.values.image_min_pixels));
        if (tokenParams.values.image_max_pixels !== undefined) argv.push("--image-max-pixels", String(tokenParams.values.image_max_pixels));
      }
      // D93：三参透传（内核全局 argparse 参数、多段读取——不按段 gate；train_all 与
      // assignment_source 的互斥校验在内核每次进程 __init__，harness 不复制；开关 false/
      // 路径空白＝「按未给处理」不追加，只传内核已声明参数、零新增语义）。
      if (args.train_all === true) argv.push("--train-all");
      const assignmentSource = typeof args.assignment_source === "string" ? args.assignment_source.trim() : "";
      if (assignmentSource !== "") argv.push("--assignment-source", assignmentSource);
      if (args.reuse_experiment_setup === true) argv.push("--reuse-experiment-setup");
      // D108 harness 半：provider/retry 旗标透传（内核全局参数、不按段 gate——给才追加：
      // token_provider trim 非空才上线（路径合法性＝内核闸单源，harness 不复制）；
      // retry_coordinate_pending 开关 true 才追加，缺省不出现在 argv——零新增语义）
      const tokenProvider = typeof args.token_provider === "string" ? args.token_provider.trim() : "";
      if (tokenProvider !== "") argv.push("--token-provider", tokenProvider);
      if (args.retry_coordinate_pending === true) argv.push("--retry-coordinate-pending");
      // E5·H1 D139（b10 对齐）：training_overrides 作为正常 stage 参数随本段命令下传
      // （内核 b10 起 walkthrough 段命令接线 --training-overrides 并透传生成器；b9 快照
      // 无此声明面——guardFixture PARAM_FACE_WAIVERS 前瞻豁免，re-pin b10 随快照退役）。
      // 仅 training_prep 段且 passDown 非空才追加（convention 态不下传——缺省单源在
      // 内核；全 convention 零键＝argv 零追加）；JSON 数值形态＝内核 parse 契约
      // （整数键原生数字——resolveTrainingOverrides passDown 构造面单源）。
      if (args.stage === "training_prep" && trainingOverrides !== undefined && Object.keys(trainingOverrides.passDown).length > 0) {
        argv.push("--training-overrides", JSON.stringify(trainingOverrides.passDown));
      }
      // D24h：放行登记带会话身份与 ui 模式（actor＝会话 id，缺失＝unattributed——不伪造 owner）；
      // round_dir＝本段落点 run 目录（内核账本 round_dir 字段面，与评估 D20 同构）
      argv.push("--actor", sessionIdOfExec(exec) ?? "unattributed", "--approval-mode", "ui", "--round-dir", runDir);
      const result = await runPipeline(pipelineCommand, argv, pipelineTimeoutMs);
      let summary: unknown = null;
      const trimmed = result.stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart >= 0) {
        try {
          summary = JSON.parse(trimmed.slice(jsonStart)) as unknown;
        } catch {
          summary = null;
        }
      }
      // E10b：真内核段模式摘要落盘不落 stdout（内核 main 缺省落点
      // <runDir>/stage-<段>.summary.json）——stdout 缺席时回读该落盘原文（同一份内核
      // 摘要，零二次解释；run_id/stage 双对账，陈旧件/他 run 件一律不采纳）。
      // 摘要在场（stdout 或落盘）即走既有透传面：rejections／style_cluster_state 等。
      if (summary === null && (result.code === 0 || result.code === 2)) {
        try {
          const disk = JSON.parse(readFileSync(join(runDir, `stage-${args.stage}.summary.json`), "utf8")) as Record<string, unknown>;
          if (disk["run_id"] === args.run_id && disk["stage"] === args.stage) summary = disk;
        } catch { /* 落盘摘要不在场＝如实 null */ }
      }
      // D24h：内核 stdout 账本 approval_id 回传返回体（只认 stdout——落盘摘要回读面不承担
      // 账本回传；解析失败省略键不阻断段回报——stderr 记一条）
      let approvalEntryId: unknown;
      if (jsonStart >= 0) {
        try { approvalEntryId = (JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>)["approval_id"]; }
        catch { console.error("[atf-pipeline-stage] 内核 stdout 非 JSON——返回体省略 approval_entry_id（不阻断段回报）"); }
      }
      // 失败语义：exit 2（blocked——越序等拒绝）／exit 3（环境错误）一律零写入；
      // exit 0 → 段事实（映射键）＋会话绑定。
      const rejections =
        summary !== null && typeof summary === "object" && (summary as Record<string, unknown>)["rejections"] !== undefined
          ? (summary as Record<string, unknown>)["rejections"]
          : null;
      let segment_fact_recorded = false;
      let session_bound = false;
      let fact_segment: string | null = null;
      if (result.code === 0) {
        const mapped = SEGMENT_FACT_BY_KERNEL_STAGE[args.stage] ?? args.stage;
        fact_segment = mapped;
        try {
          appendSegmentFact(runDir, mapped, "atf_pipeline_stage");
          segment_fact_recorded = true;
        } catch { /* fail-open（事实轨写失败不阻塞段回报） */ }
        const sessionId = sessionIdOfExec(exec);
        if (sessionId !== undefined) {
          appendBinding(runDir, sessionId);
          session_bound = true;
        }
      }
      // 批次 R H1-3：失败输出扫描内核错误码（token_budget_* / token_gate_not_configured——
      // 提前接线：内核 v0.7.24b0 未发版，当前无真实来源；发版后经 stdout/stderr 流回即人话）。
      const kernelFace = result.code !== 0 ? scanKernelErrorFace([result.stdout, result.stderr]) : null;
      return asToolValue({
        stage: args.stage,
        run_id: args.run_id,
        workspace_path: workspacePath,
        run_dir: runDir,
        // E3 补：落点形态对账（canonical＝内核 RunLayout v1 形态；legacy＝<wp>/runs 旧形态）
        run_dir_layout: resolvedRun.layout,
        ok: result.code === 0,
        exit_code: result.code,
        segment_fact_recorded,
        session_bound,
        ...(fact_segment !== null ? { fact_segment } : {}),
        // D24h：账本 approval_id 回传（解析失败/缺席省略键——typert lossless 拒 undefined 键）
        ...(approvalEntryId !== undefined ? { approval_entry_id: approvalEntryId } : {}),
        // A-E14b：base_model 对账值（explicit＝显式下传优先；对端摘要携带 source 时透传）
        ...(baseModelSourceOf(needsBaseModel, summary) !== undefined ? { base_model_source: baseModelSourceOf(needsBaseModel, summary) } : {}),
        // D89：分组方案标注（仅 experiment_setup 段）——「缺省不静默」：显式给标注 explicit，
        // 未给按内核缺省 B 标注 kernel_default（可见、可对账；其它段不加两键）
        ...(args.stage === "experiment_setup"
          ? {
              grouping_preset: groupingPreset !== "" ? groupingPreset : "B",
              grouping_preset_source: groupingPreset !== "" ? "explicit" : "kernel_default",
            }
          : {}),
        // D99：负样本带标注（仅 experiment_setup 段）——「缺省不静默」同 D89：显式给标
        // explicit，未给按构造器常量带标注 kernel_default（值与来源两侧可对账；其它段不加两键）
        ...(args.stage === "experiment_setup"
          ? {
              negative_ratio_target: negativeRatioTarget !== "" ? negativeRatioTarget : NEGATIVE_RATIO_DEFAULT_BAND,
              negative_ratio_target_source: negativeRatioTarget !== "" ? "explicit" : "kernel_default",
            }
          : {}),
        // E3：预算三参终值与来源（仅 experiment_setup 段三键恒在场——「缺省不静默」：
        // unspecified 如实标注、值未定＝null 呈现不造缺省值；其它段零键）
        ...(args.stage === "experiment_setup" && tokenParams !== undefined
          ? {
              max_total_tokens: tokenParams.values.max_total_tokens ?? null,
              max_total_tokens_source: tokenParams.sources["max_total_tokens"] ?? "unspecified",
              image_min_pixels: tokenParams.values.image_min_pixels ?? null,
              image_min_pixels_source: tokenParams.sources["image_min_pixels"] ?? "unspecified",
              image_max_pixels: tokenParams.values.image_max_pixels ?? null,
              image_max_pixels_source: tokenParams.sources["image_max_pixels"] ?? "unspecified",
            }
          : {}),
        // E4-乙（改动 1）＋E5·H1 D139：training_overrides 逐键终值与来源（仅 training_prep 段
        // 九键恒在场——无终值键 value=null＋convention）。注入通路已改段命令 argv 直传
        // （内核 b10 接线）——E4-乙补的 training_overrides_json＋training_overrides_next_step
        // （指引经 atf_scratch_exec 直调生成器）主路径撤销；delivery 键＋兼容说明保留（零
        // 指令性措辞——模型可见面不导流任何二次注入步骤）。
        ...(args.stage === "training_prep" && trainingOverrides !== undefined
          ? {
              training_overrides_resolution: Object.fromEntries(
                TRAINING_OVERRIDE_KEYS.map((key) => [
                  key,
                  {
                    value: trainingOverrides.values[key] ?? null,
                    source: trainingOverrides.sources[key] ?? "convention",
                  },
                ]),
              ),
              training_overrides_delivery: Object.keys(trainingOverrides.passDown).length > 0 ? "segment_argv" : "none",
              training_overrides_note:
                "训练参数终值已随本段命令直接下传内核（convention 态除外——缺省单源在内核）；历史版本曾要求把训练参数 JSON 另行注入生成器，该要求已随段命令直传下线，本段完成后无需任何后续注入步骤",
            }
          : {}),
        // E5·H3 D140：训练输出目录终值（仅 training_prep 段——段执行后重读盘上
        // IterationConfig 优先〔内核产出单源〕，缺席按内核 ADR-0005 run 布局预期呈现）。
        ...(args.stage === "training_prep"
          ? (() => {
              const outDir = trainingOutputDirOf(runDir);
              return { output_dir: outDir.outputDir, output_dir_source: outDir.source };
            })()
          : {}),
        ...(overridesIgnored ? { training_overrides_ignored: true, training_overrides_note: "training_overrides 仅 training_prep 段消费——本次忽略（段外传参不报错，argv 零追加）" } : {}),
        // E10b：聚类证据三键透传（内核摘要携带时）——「为什么没开/为什么开」的解释面
        ...(styleClusterStateOf(summary) !== undefined ? { style_cluster_state: styleClusterStateOf(summary) } : {}),
        // E10d：内核拒绝的 user_message 原样透传（不加工不拼接）；聚类状态拒绝未携带时
        // 按业务语言兜底并标注来源 fallback
        ...(userMessageOf(summary) !== undefined ? { user_message: userMessageOf(summary) } : {}),
        ...(userMessageOf(summary) === undefined && styleClusterRejectionOf(rejections)
          ? { user_message: STYLE_CLUSTER_USER_MESSAGE_FALLBACK, user_message_source: "fallback" }
          : {}),
        ...(summary !== null ? { summary } : {}),
        ...(result.code === 2 && rejections !== null ? { rejections } : {}),
        ...(result.code === 2 && rejections === null ? { note: "内核拒绝（blocked）——零写入；摘要未含 rejections 原文" } : {}),
        // E10d：聚类状态拒绝的回流指引（把 user_message 原样告知用户，不展示内部选项名）
        ...(result.code === 2 && styleClusterRejectionOf(rejections) ? { note: STYLE_CLUSTER_REJECTION_NOTE } : {}),
        ...(result.code === 3 || result.code === null
          ? { stderr_tail: result.stderr.slice(-2000), note: "环境错误（exit 3）——零写入；核管线环境（python 依赖/数据在位）后重试" }
          : {}),
        ...(summary === null && result.code === 0 ? { note: "段命令成功退出但无 JSON 摘要输出", stdout_head: trimmed.slice(0, 2000) } : {}),
        // 批次 R H1-3：内核错误码人话回流（提前接线——token_budget_missing /
        // token_budget_inconsistent:<detail> / token_gate_not_configured 构造期码命中即转
        // 人话 note（覆盖上方笼统 note——更具体的用户文案优先）；未命中＝既有 note 不变。
        // D77：完整码不进模型可见返回体——模型照抄进散文即用户可见；对账面＝scratch 观测账。
        ...(kernelFace !== null ? { note: kernelFace.note } : {}),
      });
    },
  });
