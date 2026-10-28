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
 * --negative-ratio-target <下限,上限>——D90 用户确认值通路 harness 侧补派：本次训练方案卡
 * 确认值经本参进实验门；显式给才下传且审批卡/返回体标来源，「缺省不静默」同 D89）。
 * E3（缺口 D 产品管道半）增 experiment_setup 段预算三参——max_total_tokens／
 * image_min_pixels／image_max_pixels（内核 b8 argparse --max-total-tokens／
 * --image-min-pixels／--image-max-pixels，harness 先行按惯例 flag 名，re-pin 对账）：
 * 显式 > run 目录 webui/config-snapshot.json 确认快照兜底 > unspecified（不下传）；
 * 来源逐参独立标注 user_specified|config_snapshot|unspecified（审批卡与返回体均
 * 呈现终值与来源）；像素对成对校验（min<max，判据单源 configConfirm
 * pixelPairViolationOf——先于审批，卡前快败业务文案）。方案确认值经本通路进
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
 *   落点（唯一）＝<workspace_path>/experiments/<exp>/<run_id>（RunLayout/v3；v2 存量
 *   <exp>/runs/<run_id> 只读兼容）——本工具内 resolveRunDir 退役
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
 *
 * 询问闸（DecisionGate/v1）权限档传导：本段命令的子进程 env 追加 ATF_ACCESS_MODE
 * ＝会话权限档（sandboxModeOf(ctx,exec)===DANGER_FULL_ACCESS_SANDBOX ? full : limited；
 * sandbox 值判据单源在 trainingPreset，档位名可改语义不可改）。「问不问」的裁决面在
 * 内核（可推导/策略默认类在完全访问档按数据事实自动推进、受限档停下来问、业务取舍类
 * 恒问），harness 只做确定性传导、零规则复制。用 env 而非 CLI 旗标：pin 内旧内核不认识
 * --access-mode 会让整条链 argparse 失败，env 未识别＝被忽略——升级前后同一份 harness
 * 都安全，re-pin 后自动生效。返回体回传内核渲染的 decision_report（措辞内核单源，段内
 * 判定账 <run>/analysis/decisions/decisions.jsonl 同源；旧内核无该块＝零键降级）。
 */
import { execFile } from "node:child_process";
import { DANGER_FULL_ACCESS_SANDBOX, sandboxModeOf } from "./trainingPreset.js";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { appendSegmentFact, SEGMENT_FACT_BY_KERNEL_STAGE } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunFile, resolveRunSubdir, runFileCandidates, runSubdirCandidates } from "../../../../src/core/workspace/runLayout.js";
import { scanLocalModels } from "../../../../src/core/workspace/modelInventory.js";
import { scanKernelErrorFace } from "../../../../src/core/workspace/kernelErrorFace.js";
// E3：像素对成对校验判据单源（configConfirm pixelPairViolationOf——文案与本次训练方案卡同源）
import { formAskQuestion, editsFromFormAnswers, visibleDevicesViolationsOf, type ChoiceAskQuestion, type FormAskService } from "./confirmFace.js";
import { pixelPairViolationOf } from "../../../../src/webui/configConfirm.js";
// E4-乙：bs 内核缺省分档单源＋accum 派生（training_overrides 桥 convention/derived 兜底）
import { TRAINING_PIN_CONSTANTS, deriveGradAccum, kernelBsDefaultOf } from "../../../../src/core/workspace/smartDefaults.js";
import { fieldNameMapOf, readExperimentGrouping, renderGroupingSection } from "../../../../src/core/workspace/experimentGrouping.js";
import { fieldsDigestOf, groupingDecisionPathOf, readGroupingDecision, writeGroupingDecision } from "./groupingDecision.js";
import { fieldChoiceDetailOf, readFieldChoice, readFieldLabels, writeFieldChoice } from "./fieldChoice.js";
import { decorateOutcome, projectUserNotice, receiptIsFailure, type UserSummary } from "./receiptSummary.js";
import { join } from "node:path";

import { tmpdir } from "node:os";

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

/** 段名 → 用户面业务话（回执三句话用；不念内部段名）。 */
export const STAGE_BUSINESS: Readonly<Record<string, string>> = {
  register: "登记数据集",
  label_qc: "标注检查",
  experiment_setup: "实验配置",
  candidate_build: "候选样本构造",
  publish: "发布",
  family_split: "版式划分",
  admission: "准入检查",
  training_prep: "训练准备",
};

/** 段回执 → 用户面三句话（业务语言；成败都说清停在哪、下一步是什么）。 */
export const stageUserSummaryOf = (receipt: Record<string, unknown>, ok: boolean, stage: string): UserSummary => {
  const stageLabel = STAGE_BUSINESS[stage] ?? "这一段";
  if (ok) {
    return {
      conclusion: `${stageLabel}跑完了`,
      stage: `${stageLabel}的产物已落到这个 run 目录`,
      next: "看回执里的分组表与缺口提示，确认后继续下一段；要改哪一项直接说",
    };
  }
  return {
    conclusion: `${stageLabel}没跑成`,
    stage: "停在本段，前面的产物没有被改",
    next: "按回执里的说明补齐条件后重试；连续没成功会升级给你处理",
  };
};

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

// ── D89（G2 退役词汇表）：experiment_setup 段分组方案标识 ──────────────────────
//
// 历史：本处曾内置 {A,B} 闭集，并把**某一批测试样本**的字段名抄成了「各组包含哪些字段」的
// 产品默认文案。owner 2026-10-26 裁定：
// harness 不再持有该词表，分组方案的取值集合与组构成由训练内核声明（内核 argparse choices ＋
// SKILL），harness 只做形状校验与透传。
//
// 通道为何不整套退役（owner 给的两个选项里选「标 deprecated 保留透传」）：内核
// build_experiment_setup.py 的 `--grouping-preset` 是 **required**（choices 由内核自己定义），
// 退掉本通道会让该段内核调用直接缺参失败——退役权在内核侧，harness 单方面摘通道＝把产品
// 打坏。故本通道降级为「值由内核定义、harness 只校形状」的透传位。

/** 分组方案标识的形状校验（不枚举取值——取值集合归内核）：1-32 位的字母数字／下划线／连字符。
 *  越界即拒（不静默纠正、不猜缺省）。 */
export const GROUPING_PRESET_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

/** 审批卡分组方案行（仅 experiment_setup 段追加——分组方案是 owner 卡上要确认的决策点）。
 *  「缺省不静默」：未给时明示「不预设」——G2 后内核无内置预设，分组唯一来源是
 *  field-config 的 group 键（旧文案「按内核缺省处理」是退役预设的死值残留）。 */
export const groupingPresetApprovalLine = (preset: string): string => {
  if (preset !== "") return `分组方案：${preset}（候选方案由训练内核定义，组构成以内核产出为准）`;
  return "分组方案：未指定——不预设（按字段配置中的分组键走，组构成以内核产出为准）";
};
// ── C2：分组候选（候选制）＝参数面＋四态卡面 ────────────────────────────────
//
// 真实契约（内核 skills/atf-admit-training-data/scripts/grouping_proposal.py）：
//   {schema_version:"GroupingProposal/v1",
//    candidates:[{name, recommended?, groups:[{name, fields:[]}], reason}]}
// 候选标识＝candidates[].name；推荐＝某候选 recommended:true（有且仅一个）；组内字段＝fields。
// 内核校验返回 {ok, errors, recommended:<索引>} 且**不抛异常**——errors 原样进回执。
// 分组不是 harness 的决策：agent 只能提候选，选定权在用户；字段配置里自带 group＝用户
// 已经给了 → 不出卡；完全权限档（既有授权判据 sandboxModeOf===danger-full-access）按
// 推荐候选自动选定、不打断用户（owner 裁定 §8-1-A）。用户可见面只说「分组」。

/** 分组候选语义版本（与内核 GroupingProposal/v1 同字面）。 */
export const GROUPING_PROPOSAL_SCHEMA = "GroupingProposal/v1";

export interface GroupingProposalGroup {
  /** 组名（内核 groups[].name）。 */
  name: string;
  /** 组内字段 id（内核 groups[].fields）。 */
  fields: string[];
}

export interface GroupingProposalCandidate {
  /** 候选名（内核 candidates[].name——卡面标题就是它）。 */
  name: string;
  groups: GroupingProposalGroup[];
  /** 候选理由（内核 candidates[].reason——卡面描述末句）。 */
  reason: string;
}

export interface GroupingProposal {
  candidates: GroupingProposalCandidate[];
  /** 推荐候选下标（由 candidates[].recommended 唯一为 true 的那一项推出）。 */
  recommendedIndex: number;
}

/** 分组四态：source＝回执 grouping_source；decision＝怎么定的（用户选／授权档自动／无）。 */
export interface GroupingFace {
  /** 分组来源五态，优先级即声明顺序：
   *  字段配置自带 group ＞ **上次用户选定（账本沿用）** ＞ 完全权限档自动 ＞ 出卡候选 ＞ 平铺无分组。
   *  prior_decision 是 D-c 的落点：同一次 run 里选过一次就不再重复问。 */
  source: "user_provided" | "prior_decision" | "proposal" | "policy_auto" | "none";
  decision: "user_selected" | "inherited" | "auto" | "none";
  /** 选定候选的 name（user_provided／none 为 null）。 */
  candidate_name: string | null;
  groups: GroupingProposalGroup[];
  evidence: Record<string, unknown> | null;
  /** 透传内核的候选原文（用户选定后把 recommended 旗标挪到他选的那个）。 */
  payload: Record<string, unknown> | null;
  note: string;
}

const asRecordOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** 分组建议校验：形状不合＝逐条 errors 原样回传（不猜、不纠、不压成一句话）。 */
export const parseGroupingProposal = (
  raw: unknown,
): { ok: true; proposal: GroupingProposal; payload: Record<string, unknown> } | { ok: false; errors: string[] } => {
  const root = asRecordOf(raw);
  if (root === null) {
    return { ok: false, errors: ["grouping_proposal 须为对象：{schema_version:'GroupingProposal/v1', candidates:[…]}"] };
  }
  const errors: string[] = [];
  const schema = typeof root["schema_version"] === "string" ? root["schema_version"] : "";
  if (schema !== "" && schema !== GROUPING_PROPOSAL_SCHEMA) {
    errors.push(`schema_version 须为 ${GROUPING_PROPOSAL_SCHEMA}（得「${schema}」）`);
  }
  const candidatesRaw = Array.isArray(root["candidates"]) ? (root["candidates"] as unknown[]) : null;
  if (candidatesRaw === null || candidatesRaw.length === 0) {
    errors.push("candidates 须为非空数组——每个候选是一套完整分组，供用户挑一套");
  }
  const candidates: GroupingProposalCandidate[] = [];
  let recommendedIndex = -1;
  for (const [index, entry] of (candidatesRaw ?? []).entries()) {
    const row = asRecordOf(entry);
    if (row === null) {
      errors.push(`candidates[${String(index)}] 不是对象`);
      continue;
    }
    const name = typeof row["name"] === "string" ? row["name"].trim() : "";
    if (name === "") errors.push(`candidates[${String(index)}].name 缺失（候选名就是卡面标题）`);
    if (row["recommended"] === true) {
      if (recommendedIndex >= 0) errors.push("recommended 只能有一个候选为 true（同时推荐了多个）");
      else recommendedIndex = index;
    }
    const groupsRaw = Array.isArray(row["groups"]) ? (row["groups"] as unknown[]) : [];
    if (groupsRaw.length === 0) errors.push(`candidates[${String(index)}].groups 须为非空数组（每组给组名与字段列表）`);
    const groups: GroupingProposalGroup[] = [];
    for (const [gi, groupEntry] of groupsRaw.entries()) {
      const grow = asRecordOf(groupEntry);
      if (grow === null) {
        errors.push(`candidates[${String(index)}].groups[${String(gi)}] 不是对象`);
        continue;
      }
      const groupName = typeof grow["name"] === "string" ? grow["name"].trim() : "";
      if (groupName === "") errors.push(`candidates[${String(index)}].groups[${String(gi)}].name 缺失`);
      const fieldsRaw = Array.isArray(grow["fields"]) ? (grow["fields"] as unknown[]) : null;
      if (fieldsRaw === null || fieldsRaw.length === 0) {
        errors.push(`candidates[${String(index)}].groups[${String(gi)}].fields 须为非空字符串数组`);
      }
      const fields = (fieldsRaw ?? [])
        .filter((field): field is string => typeof field === "string" && field.trim() !== "")
        .map((field) => field.trim());
      groups.push({ name: groupName, fields });
    }
    candidates.push({ name, groups, reason: typeof row["reason"] === "string" ? row["reason"].trim() : "" });
  }
  if (recommendedIndex < 0 && candidates.length > 0) {
    errors.push("recommended 缺失——须恰好有一个候选标 recommended:true（推荐首选）");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, proposal: { candidates, recommendedIndex }, payload: root };
};

/** 读字段配置里自带的 group（用户在字段配置里已给分组＝不出卡）；读不到/无 group＝null。 */
export const fieldGroupsOf = (path: string): GroupingProposalGroup[] | null => {
  if (path === "" || !existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  const root = asRecordOf(parsed);
  const fields = root !== null && Array.isArray(root["fields"]) ? (root["fields"] as unknown[]) : [];
  const buckets = new Map<string, string[]>();
  for (const entry of fields) {
    const row = asRecordOf(entry);
    if (row === null) continue;
    const groupName = typeof row["group"] === "string" ? row["group"].trim() : "";
    const fieldId = typeof row["field_id"] === "string" ? row["field_id"].trim() : "";
    if (groupName === "" || fieldId === "") continue;
    const bucket = buckets.get(groupName) ?? [];
    bucket.push(fieldId);
    buckets.set(groupName, bucket);
  }
  return buckets.size === 0 ? null : [...buckets].map(([name, ids]) => ({ name, fields: ids }));
};

/** 字段业务名（读显式字段配置；读不到＝空表）——分组表显示「货名（goods_name）」而非裸 id。 */
export const fieldNamesOfFieldConfig = (path: string): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  if (path === "" || !existsSync(path)) return names;
  try {
    const root = asRecordOf(JSON.parse(readFileSync(path, "utf8")) as unknown);
    const fields = root !== null && Array.isArray(root["fields"]) ? (root["fields"] as unknown[]) : [];
    for (const entry of fields) {
      const row = asRecordOf(entry);
      if (row === null) continue;
      const fieldId = typeof row["field_id"] === "string" ? row["field_id"].trim() : "";
      const zh = typeof row["zh"] === "string" ? row["zh"].trim() : "";
      if (fieldId !== "" && zh !== "") names.set(fieldId, zh);
    }
  } catch { /* 坏件＝不显示业务名，不阻塞段回报 */ }
  return names;
};

/** 候选一行描述（组名 × 每组字段数＋候选理由——用户面只看分组与理由）。 */
export const groupingCandidateDescriptionOf = (candidate: GroupingProposalCandidate): string => {
  const groups = candidate.groups.map((group) => `${group.name} × ${String(group.fields.length)} 个字段`).join("、");
  const head = `${String(candidate.groups.length)} 组：${groups}`;
  return candidate.reason === "" ? head : `${head}；理由：${candidate.reason}`;
};

/** 分组表（markdown：分组｜字段数｜字段），供 agent 原样贴到对话——两档共用同一张表。 */
export const renderGroupingReportMarkdown = (
  groups: readonly GroupingProposalGroup[],
  fieldNames: ReadonlyMap<string, string> = new Map<string, string>(),
): string => {
  const lines = ["| 分组 | 字段数 | 字段 |", "| --- | --- | --- |"];
  for (const group of groups) {
    const fields = group.fields
      .map((id) => {
        const zh = fieldNames.get(id) ?? "";
        return zh === "" ? id : `${zh}（${id}）`;
      })
      .join("、");
    lines.push(`| ${group.name} | ${String(group.fields.length)} | ${fields === "" ? "（无）" : fields} |`);
  }
  return lines.join("\n");
};

/** 审批卡上的分组行（业务话；四态各一句）。 */
export const groupingApprovalLine = (face: GroupingFace): string => {
  if (face.source === "user_provided") return `分组来源：字段配置自带的分组（${String(face.groups.length)} 组）——按你给的走，不出卡`;
  if (face.source === "policy_auto") return `分组来源：完全权限档按推荐候选「${face.candidate_name ?? ""}」自动选定（${String(face.groups.length)} 组）`;
  if (face.source === "prior_decision")
    return `分组来源：沿用你上次在这次 run 里选定的「${face.candidate_name ?? ""}」（${String(face.groups.length)} 组）——同一次 run 不重复问；要换直接说`;
  if (face.source === "proposal") {
    return face.decision === "user_selected"
      ? `分组来源：你在候选里选定的「${face.candidate_name ?? ""}」（${String(face.groups.length)} 组）`
      : `分组来源：候选建议本次未确认——${face.note}`;
  }
  return "分组来源：无——全部平铺（字段没有分组、也没给候选建议）";
};

/** 内核判分组建议不合格时的 errors 原文（内核返回 {ok,errors,recommended} 且不抛异常）。 */
export const groupingProposalErrorsOf = (summary: unknown, stderr: string): unknown[] | null => {
  const fromSummary = groupingErrorsIn(asRecordOf(summary));
  if (fromSummary !== null) return fromSummary;
  for (const marker of ['{"ok": false', '{"ok":false', '{"error": "grouping_proposal_invalid"']) {
    const fromStderr = groupingErrorsIn(extractJsonBody(stderr, marker));
    if (fromStderr !== null) return fromStderr;
  }
  return null;
};

/** 从内核错误体取 errors（ok:false 或错误码在前才算不合格——不猜）。 */
const groupingErrorsIn = (body: Record<string, unknown> | null): unknown[] | null => {
  if (body === null) return null;
  const errors = body["errors"];
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return body["ok"] === false || body["error"] === "grouping_proposal_invalid" ? (errors as unknown[]) : null;
};

/** 分组四态判定（仅 experiment_setup 段调用）。
 *  优先级：字段自带 group（用户已给）＞ 候选建议（完全权限档自动选定／其余档出卡）＞ 都没有＝平铺。 */
export const resolveGroupingFace = async (input: {
  ctx: { get(service: string): unknown };
  exec: { agent?: unknown; signal?: unknown };
  runId: string;
  fieldConfigPath: string;
  proposalRaw: unknown;
  /** run 根（定位分组选择账本 `<run>/runtime/webui/grouping-choice.json`）。
   *  缺省＝不读不写账本（保持旧调用方零改动；本工具内恒传）。 */
  runDir?: string;
  /** 本次是否已有「用户在字段清单卡上确认过」的记录（D-f 的判据）。
   *  缺省 undefined＝按未确认处理（宁可多问一次，不把 agent 自拟当用户决定）。 */
  fieldChoiceConfirmed?: boolean;
}): Promise<GroupingFace | { ok: false; errors: string[] }> => {
  const provided = fieldGroupsOf(input.fieldConfigPath);
  if (provided !== null) {
    // D-f（owner 2026-10-28）：判据从「文件里有 group」改成「用户确认过」。
    // 现场：agent 为出卡先写了 17 个 group 占位值 → 被判「用户已给」→ 卡永远出不来 →
    // 它读内核源码自救 9 分钟。**agent 自己写进配置的东西，不能当成用户的决定。**
    const hasProposal = input.proposalRaw !== undefined && input.proposalRaw !== null;
    // 真机教训（b17 之后的第一次真机）：**不能拿「字段清单确认过」当分组判据**——
    // 用户确认「要训哪些字段」≠ 认可 agent 写进配置的那套分组。当时的现场是：
    // 用户在字段卡上确认了 17 个字段 → 这里的判据为真 → agent 写的 4 组**占位分组**
    // 被当成「用户已给」→ 审批卡写「分组来源：字段配置自带的分组（4 组）——不出卡」。
    // 正确判据是**分组自己的账本**（用户在分组卡上真的选过一套，且字段集合未变）。
    const groupingConfirmed =
      input.runDir !== undefined
        ? readGroupingDecision(input.runDir, fieldsDigestOf(input.fieldConfigPath)).ok
        : false;
    if (groupingConfirmed || !hasProposal) {
      return {
        source: "user_provided",
        decision: "none",
        candidate_name: null,
        groups: provided,
        evidence: null,
        payload: null,
        note:
          groupingConfirmed
            ? `分组按字段配置里的 group 走（${String(provided.length)} 组）——这套分组你在分组卡上选定过`
            : `分组按字段配置里的 group 走（${String(provided.length)} 组）——**注意：这组分组来自 agent 写入的字段配置，你没在卡上确认过**`,
      };
    }
    // 未确认 + agent 给了候选：不短路，继续走候选出卡（下面 parse proposal 那段）
  }
  // ── D-c：用户上次在这个 run 里选过的分组方案 ─────────────────────────────
  // 真机（dev 2026-10-28）：卡弹出、用户选定、随后该段失败零写入 → 选择蒸发，
  // agent 原话「那次零写入，选定记录没存下来」；重跑只能再问一遍，换会话必然重问。
  // 现在先查账本：字段集合没变就沿用（不出卡），变了才作废重问（不拿旧选择套新字段）。
  const priorDecision =
    input.runDir === undefined
      ? ({ ok: false, reason: "absent", note: "" } as const)
      : readGroupingDecision(input.runDir, fieldsDigestOf(input.fieldConfigPath));
  if (priorDecision.ok) {
    const record = priorDecision.record;
    return {
      source: "prior_decision",
      decision: "inherited",
      candidate_name: record.candidate_name,
      groups: record.groups as unknown as GroupingProposalGroup[],
      evidence: {
        inherited_from: groupingDecisionPathOf(input.runDir as string),
        decided_at: record.decided_at,
        field_count_at_decision: record.field_count,
      },
      payload: record.payload,
      note:
        `沿用你 ${record.decided_at} 选定的「${record.candidate_name}」（${String(record.groups.length)} 组）`
        + `——同一次 run 里不重复问；字段集合与当时一致（${String(record.field_count)} 个字段）。`
        + `要换分组直接说，我重新出卡再选一次。`,
    };
  }
  if (input.proposalRaw === undefined || input.proposalRaw === null) {
    return {
      source: "none",
      decision: "none",
      candidate_name: null,
      groups: [],
      evidence: null,
      payload: null,
      note: "本次没有分组：没有候选建议、字段也没有自带 group——全部平铺（不假装有分组）",
    };
  }
  const parsed = parseGroupingProposal(input.proposalRaw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const proposal = parsed.proposal;
  const pick = (index: number): GroupingProposalCandidate => proposal.candidates[index] ?? proposal.candidates[0]!;
  const evidence: Record<string, unknown> = {
    candidate_count: proposal.candidates.length,
    recommended_index: proposal.recommendedIndex,
    recommended_name: pick(proposal.recommendedIndex).name,
    candidates: proposal.candidates.map((candidate, index) => ({
      name: candidate.name,
      recommended: index === proposal.recommendedIndex,
      group_count: candidate.groups.length,
    })),
  };
  // 用户选定＝把 recommended 旗标挪到他选的那个（内核只认 recommended:true，不新增字段）
  const withChoice = (candidateName: string): Record<string, unknown> => {
    const rawCandidates = Array.isArray(parsed.payload["candidates"]) ? (parsed.payload["candidates"] as unknown[]) : [];
    return {
      ...parsed.payload,
      candidates: rawCandidates.map((entry) => {
        const row = asRecordOf(entry) ?? {};
        return { ...row, recommended: (typeof row["name"] === "string" ? row["name"] : "") === candidateName };
      }),
    };
  };

  // 闸门口径更正（owner 2026-10-28）：**任何权限档位下，只要 agent 传了分组候选，就必须出选项卡**。
  // 理由：传候选这个动作本身就等于「在征求用户意见」——此时按档位静默替他选，用户永远看不到
  // 候选对比，也就永远纠正不了 agent 拟错的分组（真机：full 档下直接「按推荐候选自动选定」，用户
  // 连有第二套方案都不知道）。
  // 覆盖旧裁定 §8-1-A（full 档自动选定、不问）——新口径优先。
  // 仍保留的「不打扰」语义：用户没要求选（agent 不传候选）时，本函数根本走不到这里。
  const svc = input.ctx.get("userQuestions") as FormAskService | undefined;
  if (svc === undefined || typeof svc.ask !== "function") {
    const recommended = pick(proposal.recommendedIndex);
    return {
      source: "proposal",
      decision: "none",
      candidate_name: recommended.name,
      groups: recommended.groups,
      evidence,
      payload: null,
      note: "选择卡通道不可用——不替你选：先问用户要哪套分组，再把选定候选单独传进来重推（本次未下传分组建议）",
    };
  }
  const question: ChoiceAskQuestion = {
    id: `grouping-${input.runId}`,
    question: `分组方案确认 — ${input.runId}`,
    header: "分组",
    detail: [
      `这里有 ${String(proposal.candidates.length)} 套分组，请选一套：`,
      ...proposal.candidates.map((candidate) => `  · ${candidate.name}：${groupingCandidateDescriptionOf(candidate)}`),
      "选完按这套分组生成训练样本，分组表会贴给你看。",
    ].join("\n"),
    options: proposal.candidates.map((candidate) => ({
      label: candidate.name,
      description: groupingCandidateDescriptionOf(candidate),
    })),
    multiSelect: false,
  };
  try {
    const answers = await svc.ask({ questions: [question], agent: input.exec.agent, signal: input.exec.signal });
    const selectedName = answers.answers.flatMap((answer) => [...answer.selected])[0] ?? "";
    const chosen = proposal.candidates.find((candidate) => candidate.name === selectedName) ?? pick(proposal.recommendedIndex);
    const chosenPayload = withChoice(chosen.name);
    // ── D-c：选定即落账（**这里就写，不等段成功**）──────────────────────────
    // 顺序是刻意的：段随后可能 blocked/异常，若等段成功再写，选择又会蒸发一次。
    // 落点 runtime/webui（卡面输入态，与 config-snapshot／pending-confirm 同域）——
    // **不是** analysis/decisions：那是内核 DecisionGate 的判定账，语义不同层。
    let decisionPath: string | null = null;
    let decisionWriteNote = "";
    if (input.runDir !== undefined) {
      try {
        decisionPath = writeGroupingDecision(input.runDir, {
          run_id: input.runId,
          candidate_name: chosen.name,
          groups: chosen.groups as unknown as Record<string, unknown>[],
          payload: chosenPayload,
          fields_digest: fieldsDigestOf(input.fieldConfigPath),
          field_count: chosen.groups.reduce((sum, group) => sum + group.fields.length, 0),
          decided_at: new Date().toISOString(),
          source: "user_selected",
        });
      } catch (cause) {
        // 落账失败不改判选择本身（选择仍然本次生效），但必须如实说出「没存住」——
        // 静默失败＝下次又重问一遍，用户会以为系统没记住。
        decisionWriteNote = `（注意：选择已生效，但落账失败 ${String(cause).slice(0, 120)}——重跑可能再问一次）`;
      }
    }
    return {
      source: "proposal",
      decision: "user_selected",
      candidate_name: chosen.name,
      groups: chosen.groups,
      evidence: decisionPath !== null ? { ...evidence, decision_ledger: decisionPath } : evidence,
      payload: chosenPayload,
      note:
        `用户选定了「${chosen.name}」（${String(chosen.groups.length)} 组）——按这套分组走`
        + (decisionPath !== null ? `；已记账本，同一次 run 重跑不再重复问` : "")
        + decisionWriteNote,
    };
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    const recommended = pick(proposal.recommendedIndex);
    return {
      source: "proposal",
      decision: "none",
      candidate_name: recommended.name,
      groups: recommended.groups,
      evidence,
      payload: null,
      note:
        code === "ASK_CANCELLED"
          ? "用户关掉了分组卡（未选）——按未确认处理：不要替用户假定分组，本次未下传分组建议"
          : `分组卡应答失败：${String(cause).slice(0, 160)}——按未确认处理，本次未下传分组建议`,
    };
  }
};

// ── D99：experiment_setup 段负样本目标带（内核 argparse --negative-ratio-target，
//    D90 用户确认值通路的 harness 侧补派——本次训练方案卡 negative_ratio_target 确认值
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

// ── A 面：构造参数确认段（分组确认／mode5 增广／targeted 建议）──────────
//
//  三条都是「必须用户确认」的参数（内核 SKILL：字段分组与 mode5 增广必须用户确认，
//  mode5 扩充倍数不得固定值；targeted 必带字段由风险分析推荐后经用户确认写入配置）。
//  此前 harness 侧**没有任何参数通道**，模型即使分析出建议也表达不出来——这正是
//  「为什么行数这么少」的真实原因之一（分组未确认 → mode1 不生成）。

/** 构造参数确认段（仅 experiment_setup 段追加）：三行如实呈现确认态与建议值。
 *
 *  「缺省不静默」：未确认一律明说对应 kind 不生成，不让缺省偷偷生效；
 *  有 agent 建议时把建议值、理由与出处校验态一起摆到卡上（建议不自动生效）。 */
export const constructionParamsApprovalLines = (input: {
  groupingConfirm: boolean;
  mode5Random: number | undefined;
  targetedAdvice: { carry: string[]; min: number | null; max: number | null; reason: string; evidence: string[]; evidenceStatus: string } | undefined;
  riskSignalsProvided?: boolean;
}): string => {
  // 问题 6（owner 2026-10-28）：mode0/mode1/mode5/targeted 是工程内部叫法，
  // 一律不得出现在用户可见文案里——按「这套参数会产出什么样本」说人话。
  const partGroup = input.groupingConfirm
    ? "分组方案：已确认（按组逐图各生成一条样本）"
    : "分组方案：未确认——本轮不生成分组抽取样本（需显式确认分组方案）";
  const partM5 =
    input.mode5Random === undefined
      ? "随机子集增强：未确认——本轮不生成（增强倍数不得用固定值，需用户给值或确认建议）"
      : input.mode5Random === 0
        ? "随机子集增强：0 倍（用户显式不启用）"
        : `随机子集增强：${input.mode5Random} 倍（用户指定）`;
  let partTargeted: string;
  const adv = input.targetedAdvice;
  if (adv === undefined) {
    partTargeted = "重点字段组合：未提供建议（必带字段与字段数区间按当前生效值构造）";
  } else {
    const range = adv.min !== null && adv.max !== null ? `${adv.min}-${adv.max} 字段` : "区间不主张";
    // 出处三态：已校验／待内核校验（风险信号已随调用带上）／无信号不校验
    // ——审批前拿不到内核结论，不能把「待校验」说成「无风险信号」（会误导 owner）。
    const ev =
      adv.evidenceStatus === "verified"
        ? "出处已校验"
        : input.riskSignalsProvided === true
          ? "出处待内核按本批风险信号校验"
          : "未提供风险信号，出处不做校验";
    partTargeted =
      `重点字段组合建议：必带 ${adv.carry.length > 0 ? adv.carry.join("、") : "(无)"}、${range}` +
      `（建议未自动生效；${ev}）——理由：${adv.reason}`;
  }
  return `构造参数确认：\n- ${partGroup}\n- ${partM5}\n- ${partTargeted}`;
};

// ── E3 补：run 落点解析与内核 canonical RunLayout 对齐 ──

/** run 落点解析（与内核 RunLayout/v3 同序，单源）：
 *   ① v3 实验树 `<wp>/experiments/<exp>/<runId>`（canonical，唯一写面与主读面）；
 *   ② v2 实验树 `<wp>/experiments/<exp>/runs/<runId>`（存量只读兼容）；
 *   ③ legacy `<wp>/workspace/runs/<runId>`（v1 固定名桶）／④ `<wp>/runs/<runId>`。
 *  ①② 与 ③（v1 固定名桶）归 "canonical"，④ 归 "legacy"（存量兼容）。
 *  全缺＝run 尚未创建 → 返回 v3 占位（不建目录，实验归属按内核同式推导为 <YYYYMMDD>-adhoc，
 *  落位归 register 段 create_run）。命中项为软链即拒（E2 同纪律——不接受镜像/软链自救）。 */
export const resolvePipelineRunDir = (
  workspacePath: string,
  runId: string,
): { runDir: string; layout: "canonical" | "legacy" } | { error: "run_dir_symlink_rejected"; note: string } => {
  const symlinkRejected = (dir: string): { error: "run_dir_symlink_rejected"; note: string } | null => {
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        return { error: "run_dir_symlink_rejected", note: "run 目录落点是软链——请使用真实工作区路径（不接受镜像/软链）" };
      }
    } catch { /* 不存在/不可探测——按不命中处理 */ }
    return null;
  };
  const experiments = join(workspacePath, "experiments");
  const expNames: string[] = [];
  try {
    for (const entry of readdirSync(experiments, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) expNames.push(entry.name);
    }
  } catch { /* 无实验树＝纯 legacy 工作区 */ }
  // v3 全树优先于 v2 全树（同 run 在 v3/v2 并存时认 v3——不按实验名字典序偶然择一）
  for (const v3 of [true, false]) {
    for (const name of expNames) {
      const candidate = v3 ? join(experiments, name, runId) : join(experiments, name, "runs", runId);
      if (!existsSync(candidate)) continue;
      const rejected = symlinkRejected(candidate);
      if (rejected !== null) return rejected;
      return { runDir: candidate, layout: "canonical" };
    }
  }
  // v1 固定名桶 `<wp>/workspace/runs/<id>` 仍归 canonical 档（存量只读兼容，语义不变）；
  // `<wp>/runs/<id>`（ADR-0005 旧桶）才是 legacy。
  const v1Bucket = join(workspacePath, "workspace", "runs", runId);
  if (existsSync(v1Bucket)) {
    const rejected = symlinkRejected(v1Bucket);
    if (rejected !== null) return rejected;
    return { runDir: v1Bucket, layout: "canonical" };
  }
  const legacy = join(workspacePath, "runs", runId);
  if (existsSync(legacy)) {
    const rejected = symlinkRejected(legacy);
    if (rejected !== null) return rejected;
    return { runDir: legacy, layout: "legacy" };
  }
  // 全缺＝run 尚未创建：返回**与内核同式的 v3 占位路径**（纯路径计算，不建目录）。
  // 内核 walkthrough_pipeline 的 _resolve_run_target 同样在 run 不在场时取 canonical 占位、
  // 由 register 段 create_run 落位；占位实验归属推导序与之逐条同源
  // （①显式 --experiment ②既有 run 的 experiment_id ③按日期 <YYYYMMDD>-adhoc）。
  // ①② 在此恒不成立（能命中就已在上面的候选扫描里返回；本工具无 --experiment 入参），
  // 故落 ③。**旧实现在此返回 `<wp>/runs/<run_id>`（legacy 桶）当新建落点——写侧自己造
  // 游离 run，正是本轮要消灭的错位桶 bug 的另一半。**
  return { runDir: join(experiments, adhocExperimentId(new Date()), runId), layout: "canonical" };
};

/** 未命名实验（adhoc）标识推导——与内核 `<YYYYMMDD>-adhoc` 同式同值（本地时区日期）。 */
const adhocExperimentId = (now: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-adhoc`;
};

// ── E3：experiment_setup 段预算三参（max_total_tokens／像素对）——显式 > 确认快照
//    兜底 > unspecified（不下传）。本次训练方案卡的预算三要素经本通路进实验门（缺口 D
//    产品管道：确认卡落 config-snapshot.json → 本段工具兜底读并下传，全程零代写）。──


/** 预算三参来源三值闭集（审批卡/返回体逐参标注——「缺省不静默」）。 */
export type ExperimentTokenParamSource = "user_specified" | "config_snapshot" | "unspecified";

/** 预算五参键（参数名与快照 confirmed 键、本次训练方案卡键同名同义）。
 *  C（2026-10-26）五参同门：cutoff_len／max_model_len 与构造上限、像素对一起经本段进
 *  实验门 token_gate——内核 b17 起据此落 <run>/prep/token_budget.json（不再写死基线）。 */
export const EXPERIMENT_TOKEN_PARAM_KEYS: readonly string[] = [
  "max_total_tokens",
  "cutoff_len",
  "max_model_len",
  "image_min_pixels",
  "image_max_pixels",
];

// ── T3：training_prep 段卡位（visible_devices）——显式 > 确认快照 > 不下传（回退 deploy）──
//
// 历史缺口：本次训练方案卡把卡位写进 config-snapshot，但 training_prep 只认工具显式参数，
// 快照桥（training_overrides 九键白名单）**按内核口径排除** visible_devices（内核明确
// 不收该键，执行面走 deploy/launch 的 --visible-devices 旗标）——于是「卡面选了卡位却不生效」。
// 修法不是把它塞进九键（内核会拒），而是让本段的专用旗标也具备「显式 > 快照」来源链，
// 与预算五参同构；两者皆无＝不下传，内核回退 deploy 层 cuda_visible_devices。

/** 卡位来源三值（审批卡/返回体标注——「缺省不静默」）。 */
export type VisibleDevicesSource = "user_specified" | "config_snapshot" | "deploy_default";

export const VISIBLE_DEVICES_SOURCE_LABEL: Readonly<Record<VisibleDevicesSource, string>> = {
  user_specified: "用户指定",
  config_snapshot: "确认快照",
  deploy_default: "未指定——回退部署层（cuda_visible_devices）",
};

/** 快照里的卡位值（confirmed.visible_devices，字符串面；空/非法形态原样返回给调用方判）。 */
export const snapshotVisibleDevicesOf = (runDir: string): string => {
  try {
    const parsed = JSON.parse(readFileSync(resolveRunFile(runDir, "webui/config-snapshot.json"), "utf8")) as {
      confirmed?: Record<string, unknown>;
    };
    const raw = parsed?.confirmed?.["visible_devices"];
    return typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  } catch {
    return "";
  }
};

/** 卡位终值解析（仅 training_prep 段）：显式 > 快照 > 部署缺省；形态非法即拒（不静默纠正、
 *  不猜卡位——卡位错了等于训练跑在错的卡上）。形态判据单源＝confirmFace.visibleDevicesViolationsOf
 *  （与方案卡同一套业务文案）。 */
export const resolveVisibleDevices = (
  args: { visible_devices?: unknown },
  runDir: string,
): { ok: true; value: string; source: VisibleDevicesSource } | { ok: false; error: string; note: string } => {
  const explicit = typeof args.visible_devices === "string" ? args.visible_devices.trim() : "";
  const snapshot = explicit === "" ? snapshotVisibleDevicesOf(runDir) : "";
  const value = explicit !== "" ? explicit : snapshot;
  const source: VisibleDevicesSource = explicit !== "" ? "user_specified" : snapshot !== "" ? "config_snapshot" : "deploy_default";
  if (value === "") return { ok: true, value: "", source };
  const violations = visibleDevicesViolationsOf([{ key: "visible_devices", value }]);
  if (violations.length > 0) {
    const from = source === "config_snapshot" ? "确认快照里的" : "参数里的";
    return { ok: false, error: "visible_devices_invalid", note: `${from}卡位不可用：${violations.join("；")}——请修正后重推（不静默纠正）` };
  }
  return { ok: true, value, source };
};

/** 审批卡卡位行（仅 training_prep 段追加——终值与来源双双可见）。 */
export const visibleDevicesApprovalLine = (value: string, source: VisibleDevicesSource): string =>
  value === ""
    ? `训练绑卡：${VISIBLE_DEVICES_SOURCE_LABEL.deploy_default}`
    : `训练绑卡：${value}（${VISIBLE_DEVICES_SOURCE_LABEL[source]}）`;

/** 五参键值类型（缺项＝键不在，不造占位）。 */
export type ExperimentTokenParams = Partial<
  Record<"max_total_tokens" | "cutoff_len" | "max_model_len" | "image_min_pixels" | "image_max_pixels", number>
>;

/** 来源标注文案（审批卡行单源）。 */
export const TOKEN_PARAM_SOURCE_LABEL: Readonly<Record<ExperimentTokenParamSource, string>> = {
  // 语义纠正（owner 2026-10-28 当场指出）：`user_specified` 的真实含义只是「本次调用显式传了」，
  // 而传值的是 agent、不是用户。原先显示「用户指定」＝把 agent 的臆断说成用户的话
  // （真机：用户从没给过 cutoff_len=8192／max_model_len=16384，卡上却写「用户指定」，
  //  用户看到后第一反应是「推理窗口不是定了默认 12800 吗」——完全合理）。
  user_specified: "本次调用传入，非你在方案卡确认",
  config_snapshot: "你在方案卡确认的",
  unspecified: "未指定——内核按缺省处理",
};

/** 显式参数取值校验：安全正整数（非此形态卡前快败——fail-closed 不猜不修不夹取）。 */
export const isSafePositiveInteger = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isSafeInteger(raw) && (raw as number) > 0;

/** run 目录确认快照兜底读取（webui/config-snapshot.json 的 confirmed 子对象五键；
 *  快照缺席/键非安全正整数＝该键无兜底值（如实 unspecified，不造占位）。 */
export const snapshotTokenParamsOf = (runDir: string): ExperimentTokenParams => {
  const out: ExperimentTokenParams = {};
  try {
    const parsed = JSON.parse(readFileSync(resolveRunFile(runDir, "webui/config-snapshot.json"), "utf8")) as {
      confirmed?: Record<string, unknown>;
    };
    const confirmed = parsed?.confirmed;
    if (confirmed === null || typeof confirmed !== "object") return out;
    for (const key of EXPERIMENT_TOKEN_PARAM_KEYS) {
      const raw = (confirmed as Record<string, unknown>)[key];
      // 快照键值历史形态为字符串（本次训练方案卡值全字符串面）——数字/纯数字串均认
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
      if (isSafePositiveInteger(num)) out[key as keyof ExperimentTokenParams] = num;
    }
  } catch { /* 快照缺席/解析失败＝无兜底值（fail-open：兜底面不阻塞段触发） */ }
  return out;
};

/** 预算五参终值解析（仅 experiment_setup 段调用）：显式参数 > 快照兜底，逐参独立
 *  来源标注；显式值非法形态直接快败（error 不下传不进审批——坏参数不消耗放行）。 */
export const resolveExperimentTokenParams = (
  args: Partial<Record<string, unknown>>,
  runDir: string,
):
  | { ok: true; values: ExperimentTokenParams; sources: Record<string, ExperimentTokenParamSource> }
  | { ok: false; error: string; note: string } => {
  const values: ExperimentTokenParams = {};
  const sources: Record<string, ExperimentTokenParamSource> = {};
  const snapshot = snapshotTokenParamsOf(runDir);
  const labels: Record<string, string> = {
    max_total_tokens: "max_total_tokens（单样本 token 上限，正整数）",
    cutoff_len: "cutoff_len（训练截断长度，正整数；须 ≥ max_total_tokens）",
    max_model_len: "max_model_len（推理窗口，正整数；须 ≥ max_total_tokens）",
    image_min_pixels: "image_min_pixels（最小像素，正整数）",
    image_max_pixels: "image_max_pixels（最大像素，正整数）",
  };
  for (const key of EXPERIMENT_TOKEN_PARAM_KEYS) {
    const raw = (args as Record<string, unknown>)[key];
    if (raw === undefined) {
      const fallback = snapshot[key as keyof ExperimentTokenParams];
      if (fallback !== undefined) {
        values[key as keyof ExperimentTokenParams] = fallback;
        sources[key] = "config_snapshot";
      } else {
        sources[key] = "unspecified";
      }
      continue;
    }
    if (!isSafePositiveInteger(raw)) {
      return { ok: false, error: `${key}_invalid`, note: `${labels[key]}——得 ${String(raw)}（非安全正整数即拒，不夹取）` };
    }
    values[key as keyof ExperimentTokenParams] = raw;
    sources[key] = "user_specified";
  }
  return { ok: true, values, sources };
};

/** 审批卡预算五参行（仅 experiment_setup 段追加——终值与来源双双上卡；unspecified
 *  明示「内核按缺省处理」，缺省不静默）。 */
export const experimentTokenApprovalLine = (
  values: ExperimentTokenParams,
  sources: Record<string, ExperimentTokenParamSource>,
): string =>
  `预算五参（实验门）：${EXPERIMENT_TOKEN_PARAM_KEYS.map((key) => {
    const value = values[key as keyof ExperimentTokenParams];
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

/** 来源标注文案（审批卡行单源；user_confirmed＝当次显式确认值、config_snapshot＝本次训练方案确认值
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
    const parsed = JSON.parse(readFileSync(resolveRunFile(runDir, "webui/config-snapshot.json"), "utf8")) as {
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
  for (const candidate of [...runFileCandidates(runDir, "prep/iteration-config.json"), ...runFileCandidates(runDir, "prep/iteration-config/iteration-config.json")]) {
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


/**
 * 段回执的询问闸报告键：内核段摘要 decisions 块在场才出键（措辞由内核渲染单源，
 * harness 不复刻、不暴露内部 id；旧内核无该块＝零键，不造假空报告）。
 *
 * @param summary 内核段摘要（stdout 解析或落盘回读，可为 null）。
 * @returns 报告键集合（report 文本 + auto/ask 计数）；块缺席返回空对象。
 */
export const decisionReportKeys = (summary: unknown): Record<string, unknown> => {
  const block = (summary as { decisions?: { report?: unknown; auto?: unknown; ask?: unknown; access_mode?: unknown } } | null)?.decisions;
  if (block === undefined || block === null || typeof block !== "object") return {};
  const report = typeof block.report === "string" && block.report !== "" ? block.report : null;
  if (report === null) return {};
  return {
    decision_report: report,
    decisions_auto: typeof block.auto === "number" ? block.auto : 0,
    decisions_ask: typeof block.ask === "number" ? block.ask : 0,
    decisions_access_mode: typeof block.access_mode === "string" ? block.access_mode : null,
  };
};

/** 子进程封装（execFile——非零退出/超时如实回传，不抛；F1 预检工具同源复用）。 */
export const runPipeline = (command: string, args: readonly string[], timeoutMs: number,
  extraEnv?: Readonly<Record<string, string>>): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const [file, ...rest] = command.split(" ");
    execFile(
      file ?? command,
      [...rest, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        // 逐调用追加 env（会话级事实如权限档）——不污染 process.env，多会话并发各归各。
        ...(extraEnv === undefined ? {} : { env: { ...process.env, ...extraEnv } }),
      },
      (error, stdout, stderr) => {
        // 非零退出也返回（如实回报；超时时 code 为 null）
        const rawCode = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : null;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** 从内核 stderr 提取 field_config_invalid 结构化错误体（括号平衡切出，尾部 traceback 不影响）。
 *
 *  C1-L 面（变更单 §3 C1.3）：错误体须原样进回执——压成一句 "ValueError: {...}" 等于
 *  agent 拿不到 skeleton / malformed_fields，只能回头读内核源码（1027-1 现场的样子）。
 *
 *  @param stderr 子进程 stderr 全文。
 *  @return 解析出的对象；不是该错误或解析失败＝null。
 */
/** 从内核输出切出以 marker 开头的结构化错误体（括号平衡；与 field_config 同一手法）。
 *  C2：分组建议不合格时 errors 须原样进回执，不能压成一句话。
 *  @param stderr 子进程 stderr 全文。
 *  @param marker 错误体开头（如 {"ok": false）。
 *  @return 解析出的对象；marker 不在场或解析失败＝null。
 */
const extractJsonBody = (stderr: string, marker: string): Record<string, unknown> | null => {
  const start = stderr.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stderr.length; i += 1) {
    const ch = stderr[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stderr.slice(start, i + 1)) as unknown;
          return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

const extractFieldConfigError = (stderr: string): Record<string, unknown> | null => {
  const marker = '{"error": "field_config_invalid"';
  const start = stderr.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stderr.length; i += 1) {
    const ch = stderr[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(stderr.slice(start, i + 1)) as unknown;
          return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};

/**
 * D-b：`source_root` 传前校验（纯函数，便于单测）。
 *
 * 真机两次实证（dev 2026-10-28，两个不同会话）：agent 都把**单据目录**当批根传了，
 * 内核拼成 `…/awb/awb` 后只回一句「单据来源目录不可解析」；agent 得读源码/试错才悟出
 * 「来源根要传到 batch 这一层」（首次耗时约 4 分钟）。这是纯可发现性缺陷——口径写在
 * 系统里，不该由用户提示词或试错来传达。
 *
 * 判据是**确定性**的，不是猜：内核 register 段要求 `<source_root>/<doc_type>` 必须存在
 * （`walkthrough_pipeline.py` 里 `self.source_root = self.batch_root / self.doc_type`，
 * 再判 `is_dir()`）。所以这里同一口径、同一判据，只是把它提前到拼参之前，并把
 * 「批根下到底有哪些子目录」直接摆出来。
 *
 * 不做的事：doc_type 缺省时**不校验**（内核按数据/登记面自行推断，harness 不复制推断逻辑）。
 *
 * @param given - 调用方给的 source_root（可能相对）。
 * @param docType - 显式单据类型（空串＝未指定，跳过校验）。
 * @returns 通过时给绝对路径；不通过时给判据、批根实际子目录与可直接展示的说明。
 */
export const sourceRootPrecheckOf = (
  given: string,
  docType: string,
):
  | { ok: true; resolved: string }
  | {
      ok: false;
      error: string;
      resolved: string;
      expected_dir: string | null;
      subdirs_present: string[];
      note: string;
    } => {
  const resolved = isAbsolute(given) ? given : resolve(given);
  if (!existsSync(resolved)) {
    return {
      ok: false,
      error: "source_root_not_found",
      resolved,
      expected_dir: null,
      subdirs_present: [],
      note:
        `数据批根指不到目录：「${given}」→ 解析为 ${resolved}（不存在）。`
        + `相对路径按本工具进程的当前目录解析，跨进程传递请一律给绝对路径。`,
    };
  }
  if (docType.trim() === "") return { ok: true, resolved };
  const expected = join(resolved, docType.trim());
  if (existsSync(expected)) return { ok: true, resolved };
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, 12);
  } catch {
    subdirs = [];
  }
  const looksLikeDocDir = basename(resolved) === docType.trim();
  return {
    ok: false,
    error: "source_root_doc_type_subdir_missing",
    resolved,
    expected_dir: expected,
    subdirs_present: subdirs,
    note:
      `数据批根下没有单据类型目录：应为 ${expected}（不存在）。\n`
      + `口径：source_root 传**批根**——内核拼 <批根>/<单据类型>/ 作为单据所在目录，其下可再有多层子目录（递归识别）。\n`
      + `批根 ${resolved} 下现有子目录：${subdirs.length > 0 ? subdirs.join("、") : "(无子目录)"}\n`
      + (looksLikeDocDir
        ? `你给的路径末尾正好是单据类型名「${docType.trim()}」——很可能把**单据目录本身**当成了批根；请改传它的父目录 ${dirname(resolved)}。`
        : `如果单据确实在别处，请把批根改为包含 <${docType.trim()}> 子目录的那一层。`),
  };
};

/**
 * D-a：`--field-config` 传前校验（纯函数，便于单测）。
 *
 * 现场（dev 2026-10-28 webui 真机）：agent 显式传了 field_config（先相对后绝对），本工具原样
 * 下传；内核按**自己进程的 CWD** 解析相对路径，解析不到就静默降级，最后报
 * 「未显式传 --field-config」——错误归因。agent 因此连续四次撞同一句、怀疑传参链路/审批账本/
 * 白名单，最后读内核源码，单次会话 16m41s、808K token。
 *
 * 所以本工具在拼 argv 之前就做两件事：**统一绝对化**（跨进程传相对路径必然歧义）＋
 * **存在性校验**（不存在就当场拒绝，并把解析后的绝对路径摆出来）。
 *
 * @param given - 调用方给的 `field_config`（可能相对）。
 * @param runDir - 本 run 根（用于给出「run 内登记副本槽位」这条正路的路径）。
 * @param docType - 单据类型（可为空；仅用于拼槽位提示）。
 * @returns 通过时给绝对路径；不通过时给解析后路径与可直接展示的说明。
 */
export const fieldConfigPrecheckOf = (
  given: string,
  runDir: string,
  docType?: string,
): { ok: true; resolved: string } | { ok: false; given: string; resolved: string; note: string } => {
  const resolved = isAbsolute(given) ? given : resolve(given);
  if (existsSync(resolved)) return { ok: true, resolved };
  const slot = `${runDir}/config/experiment-setup/${docType ?? "<单据类型>"}/field-config.json`;
  return {
    ok: false,
    given,
    resolved,
    note:
      `字段配置指不到文件：「${given}」→ 解析为 ${resolved}（不存在）。`
      + `相对路径按本次执行进程的当前目录解析，跨进程传递请一律给绝对路径；`
      + `也可以把它放到 run 内登记副本槽位 ${slot}，本段会自行继承（不传 --field-config 亦可）。`,
  };
};

/**
 * F14：label_qc 段被阻断（exit 2）时的续跑指路。
 *
 * 为什么要有它：内核在待确认项 > 0 时阻断该段，正解是「inspect 取 report_digest 与待裁决项 →
 * resolve 提交二选一 → **同一 run** 重跑 label_qc 段」。回执若不说清这条路，agent 会把任务当成
 * 新的重开，于是同实验下不断新增 run 目录（现场 run-awb-01/03/04 即此痕迹）。故 blocked 回执
 * 必须自带 next 与 same_run_required，并点名两个工具的真实名字（可发现性三面之一）。
 *
 * @param stage - 本次段名（只有 label_qc 命中）。
 * @param code - 内核退出码（2＝blocked）。
 * @returns 追加进回执的键；不命中返回空对象。
 */
export const labelQcResumeHintOf = (stage: string, code: number | null): Record<string, unknown> => {
  if (stage !== "label_qc" || code !== 2) return {};
  return {
    next_action: "label_adjudication",
    next: "待确认标注项未裁决——用 atf_label_qc_inspect 取 report_digest 与待裁决清单，逐项二选一后交 atf_label_qc_resolve 提交，再用**同一个 run_id** 重跑 label_qc 段",
    same_run_required: true,
    same_run_note: "禁止新建 run 绕过：新 run 会丢掉本轮已登记的体检结论与裁决留痕，实验下还会多出空壳目录",
  };
};

/**
 * 联合装配判定（D3）：run 下单据槽位 > 1 时，training_prep 不做联合装配就等于产不出可训练启动件。
 *
 * 为什么要有它：内核 manual 档的 training_prep 只产数据面（`walkthrough_pipeline.py:2692`
 * 注释明写「不写 run 级 config/iteration-config 与 launch」），启动件归 assemble 分支；
 * 而 `assemble` 是显式参数、缺省不传，于是多单据场景必然走空。此处按"槽位数"确定性判定，
 * 不猜用户意图：单类（≤1 槽位）保持旧行为。
 *
 * @param requested - 工具参数 assemble（显式值；undefined＝未给）。
 * @param slotDocCount - run 下探测到的单据槽位目录数（探测失败按 0）。
 * @returns assemble＝是否联合装配；source＝判定来源（显式／多槽位自动／单类）。
 */
export const assembleDecisionOf = (
  requested: boolean | undefined,
  slotDocCount: number,
  docTypeProvided = false,
): {
  assemble: boolean;
  source: "explicit_on" | "explicit_off" | "no_doc_type" | "multi_doc_slots" | "single_doc";
} => {
  if (requested === true) return { assemble: true, source: "explicit_on" };
  if (requested === false) return { assemble: false, source: "explicit_off" };
  // 没给 doc_type ＝没有单类入口（内核 assemble=true 时不传 doc_type，数据面分支不可达）——
  // 此时不装配就永远产不出启动件，训练也拉不起来，所以按联合装配处理。
  if (!docTypeProvided) return { assemble: true, source: "no_doc_type" };
  if (slotDocCount > 1) return { assemble: true, source: "multi_doc_slots" };
  return { assemble: false, source: "single_doc" };
};

/** 单据槽位探测（D3）：**布局知识不在此处复制**——走 `runSubdirCandidates` 的候选链
 *  （v2 名 → v3 名的映射单源在 `runSubdirs.ts` 的 V2_TO_V3_DIR_MAP，布局演进时只改那一处）。
 *
 *  **只认含 `train.jsonl` 的子目录**——槽位根下还住着 `images/`（变体图片）这类非单据
 *  目录，按 isDirectory() 计数会把 1 个单据算成 2 个（dev 2026-10-28 实测如此）。
 *
 *  @param runDir - run 根目录。
 *  @returns 单据槽位目录数（`<槽位根>/<doc>/train.jsonl` 的 doc 个数，多候选取最大）。
 */
export const VERTICAL_SLOT_MARKER = "train.jsonl";

export const slotDocCountOf = (runDir: string): number => {
  let best = 0;
  for (const root of runSubdirCandidates(runDir, "prep/variants")) {
    try {
      const count = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(join(root, entry.name, VERTICAL_SLOT_MARKER)))
        .length;
      best = Math.max(best, count);
    } catch {
      // 候选缺席/不可读：换下一个候选（不猜、不阻断）
    }
  }
  return best;
};

/**
 * 启动件在场判定（D3 可发现性面）：train.sh 与 iteration-config.json 齐备才算"能训练"。
 *
 * 回执必须说清这件事——否则现场只能靠 `ls` 三个目录才知道启动件没生成（本轮真机即如此）。
 *
 * @param runDir - run 根目录。
 * @returns present＝两件都在位；缺席时 reason 指明是哪类缺席。
 */
export const launchArtifactsOf = (
  runDir: string,
): {
  present: boolean;
  train_sh: string | null;
  iteration_config: string | null;
  reason: "assemble_not_requested" | "assemble_incomplete" | null;
} => {
  const trainSh = join(runDir, "launch", "train.sh");
  // 迭代配置的落点名同样走单源（读侧 resolveRunFile：v3 映射形态在前、v2 存量形态在后）。
  const iterConfig = resolveRunFile(runDir, "prep/iteration-config/iteration-config.json");
  const hasTrain = existsSync(trainSh);
  const hasIter = existsSync(iterConfig);
  if (hasTrain && hasIter) {
    return {
      present: true,
      train_sh: relative(runDir, trainSh),
      iteration_config: relative(runDir, iterConfig),
      reason: null,
    };
  }
  return {
    present: false,
    train_sh: hasTrain ? relative(runDir, trainSh) : null,
    iteration_config: hasIter ? relative(runDir, iterConfig) : null,
    reason: hasTrain || hasIter ? "assemble_incomplete" : "assemble_not_requested",
  };
};

export const buildPipelineTool = (
  ctx: { get(service: string): unknown },
  pipelineCommand: string,
  pipelineTimeoutMs: number,
): unknown => {
  const tool = defineTool({
    name: "atf_pipeline_stage",
    description:
      `按段驱动 walkthrough_pipeline 段模式（审批必经）：单段触发 ${PIPELINE_STAGES.join("/")} 之一。` +
      `落点＝<workspace_path>/experiments/<exp>/<run_id>（与内核同源唯一落点·RunLayout/v3；v2 存量 <exp>/runs/<run_id> 只读兼容）；workspace_path 可省（缺省解析并回显），` +
      `run_id 必填；source_root 仅 register 段必填（其余段可省——缺了也不影响非 register 段）。` +
      `【source_root 是数据批根，不是单据目录】内核会拼 <source_root>/<doc_type>/ 作为单据所在目录，` +
      `其下可再有多层子目录（递归识别）：例如批根 …/batch ＋ doc_type=awb → 实际读 …/batch/awb/。` +
      `把单据目录本身（路径末尾正好是 <doc_type>）当批根传入，内核会拼成 …/awb/awb 并报目录不可解析——` +
      `此时应改传它的父目录。本工具在 register 段拼参前就按此口径校验：批根下若无 <doc_type> 子目录，` +
      `当场拒绝并列出批根实际子目录（不把错误留到内核侧变成一句「路径不可解析」）。` +
      `register 段准入口径（一个 run 可承载多类单据）：同一 run 可继续登记其它单据（多类联合训练共用一个 run，` +
      `无需换 run-id——逐类带各自 doc_type 调 register 即可）；同单据本段重复登记为幂等跳过` +
      `（register_already_done_skip——成功态、零产物、已确认产物不覆写，可直接继续下一段）。` +
      `base_model_path 仅 training_prep 段必填（本地模型目录绝对路径，含 config.json；模型家族名（如 qwen3_vl）不可当路径用——` +
      `缺参/非绝对路径在审批卡前快败，指路 ATF_MODEL_ROOT 可用模型清单；其它段忽略该参）。` +
      `family_split 段另支持 auto_style_cluster 三态（缺省 auto，其它段忽略该参）：` +
      `auto＝先检测——已聚类则不复聚；未聚类/状态不明会拒绝并指路。` +
      `experiment_setup 段另支持 grouping_proposal 分组建议（候选制）：` +
      `{schema_version:"GroupingProposal/v1",candidates:[{name,recommended,groups:[{name,fields}],reason}]}——` +
      `候选名是卡面标题、recommended 有且仅一个为 true、groups 逐组给组名与字段列表、reason 给候选理由；` +
      `传了就按候选出卡让用户挑一套；不传且字段配置自带 group＝用户已给，不出卡；` +
      `完全权限档不出卡、直接按推荐候选选定（复用既有授权档，不新增档位）。` +
      `返回体如实标注分组来源（user_provided／prior_decision／proposal／policy_auto／none）并附分组表（组名｜字段数｜字段），可原样贴给用户。` +
      `用户选定分组后会记进 <run>/runtime/webui/grouping-choice.json：同一次 run 重跑时若字段集合未变，` +
      `直接沿用上次选择、不再重复出卡（来源标 prior_decision）；字段增删则旧选择作废、重新出卡。` +
      `experiment_setup 段另支持 grouping_preset 方案标识（取值由训练内核声明，内核无内置预设；` +
      `不给＝不预设——分组唯一来源是 field-config 的 group 键，其它段忽略该参）。` +
      // A 面可发现性（工具描述面）：模型此前即使被点名要求，也会「不传覆盖参数、按缺省处理」，
      // 于是确认与建议永远到不了内核（真机实证：模型自述「未带任何覆盖参数」）。
      // 这里把「不传的后果」写进工具描述——系统知识不靠用户提示词承载。
      `【构造参数必须作为工具参数显式传入，只在回复文字里说明不会被采纳】experiment_setup 段另有三个` +
      `确认／建议参数：grouping_confirm（确认当前分组方案；不传＝未确认，mode1 样本本轮不生成）、` +
      `mode5_random（mode5 增广倍数；不传＝未确认，mode5 本轮不生成）、` +
      `targeted_advice（targeted 组合建议：必带字段／字段数区间／理由／出处，格式 ` +
      `{schema_version:"TargetedRulesAdvice/v1",suggested_carry_fields:[…],suggested_min_fields,suggested_max_fields,` +
      `reason,evidence:["field:signal",…],effective:false}；不传＝未提供建议）。` +
      `当用户已确认分组方案、或你已据字段风险分析得出建议时，必须把这些值通过对应参数传入；` +
      `遗漏时内核按「未确认／未提供」处理、对应样本不生成，审批卡与 variants_report 都会如实标注未确认。` +
      `experiment_setup 段另支持 negative_ratio_target 负样本目标带 <下限,上限>（其它段忽略该参）：` +
      `显式给定时实验门以该值锁定并标注用户指定；不给时按构造器内置常量带兜底（审批卡与返回体均如实标注来源）。` +
      `experiment_setup 段另支持预算五参 max_total_tokens／cutoff_len／max_model_len／image_min_pixels／image_max_pixels（其它段忽略）：` +
      `显式给 > run 目录 webui/config-snapshot.json 确认快照兜底 > 皆无则不下传（内核按缺省处理）；` +
      `审批卡与返回体逐参呈现终值与来源（user_specified／config_snapshot／unspecified）；` +
      `像素对须成对提供且 min<max（成对校验先于审批——单端或越界即卡前快败）。` +
      `收到版式聚类状态类拒绝（style_cluster_state_not_clustered／style_cluster_state_ambiguous／` +
      `style_cluster_declared_but_absent）时，必须先问用户「这批数据做过版式聚类吗？」，` +
      `确认后再传 on（未聚类——内核自动补簇并产出 StyleClusterManifest/v1，按簇分层）或 off（已聚类——不再聚）重跑；` +
      `禁止在 auto 被拒后自行猜一个值重跑。` +
      `单据类型／数据后缀／字段配置三件可缺省（缺省不上送，各段均有效；数据后缀是内部键，一般不用传）：` +
      `不传 doc_type 时内核按数据/登记面推断单据类型，无法确定即 blocked（会带业务文案指路）——` +
      `需显式指定或补登记面后重跑；field_config 须为字段配置文件显式路径。` +
      `train_all／assignment_source／reuse_experiment_setup 三件为全局参数（各段均有效，给才下传，缺省不开）：` +
      `train_all 与 assignment_source 互斥——二选一，同时给会被内核拒绝（harness 不复制该校验）。` +
      `越序段会被内核拒绝（blocked，exit 2）——按段序逐段触发。段成功退出（exit 0）即在落点 run 目录落段事实与会话绑定` +
      `（胶囊数据源；experiment_setup/candidate_build/training_prep 按映射口径落事实，点灯以内核段序闭包为准）；` +
      `exit 2（blocked）／exit 3（环境错误）一律零写入。审批面板放行后才会执行。`,
    parameters: {
      stage: { type: "string", required: true, enum: [...PIPELINE_STAGES], description: "要触发的内核管线段（八段原文，单段）" },
      run_id: { type: "string", required: true, description: "run 标识（落点 <workspace_path>/experiments/<exp>/<run_id>·RunLayout/v3；未指定实验归入当日「未命名实验」）" },
      workspace_path: { type: "string", description: "workspace 根（可选覆盖——缺省按会话 cwd→工作区身份→实例配置解析，并回显所用根与依据；显式给时必须含 .atf/workspace.json 或 datasets+splits）" },
      source_root: {
        type: "string",
        description:
          "数据批根（**不是单据目录**）：内核拼 <批根>/<单据类型>/ 作为单据所在目录，其下可再有多层子目录（递归）。" +
          "例：批根 …/batch ＋ doc_type awb → 实际读 …/batch/awb/。" +
          "传成单据目录会拼出 …/awb/awb 并报目录不可解析。仅 register 段必填；其余段可省。",
      },
      base_model_path: { type: "string", description: "本地模型目录绝对路径（含 config.json）；模型家族名（如 qwen3_vl）不可当路径用（training_prep 段必填，其它段忽略；assemble=true 时豁免——内核盘上再水合单源，恢复不了内核 blocked 指路）" },
      assemble: { type: "boolean", description: "run 级联合装配（仅 training_prep 段有效，其它段忽略）：true 时下传 --assemble——内核枚举 run 的单据槽位（prep/variants/<doc>/）合并生成迭代配置与启动件；与 doc_type 单类语义互斥，true 时不传 doc_type。不给且 run 下单据槽位多于一个时本工具自动按联合装配执行（回执 assemble_auto=multi_doc_slots 标注）；回执的 launch_artifacts 恒说明启动件是否已生成" },
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
        description:
          "实验分组方案标识（仅 experiment_setup 段有意义，其它段忽略该参）：取值集合与各方案的分组" +
          "构成均由训练内核声明（本工具不复制词表——按内核报错回流取值即可）。内核无内置预设，不给＝" +
          "不预设（分组唯一来源是 field-config 的 group 键；不静默——返回体如实标 undeclared，审批卡亦明示）",
      },
      grouping_proposal: {
        type: "object",
        additionalProperties: true,
        description:
          "分组建议（候选制）：{schema_version:'GroupingProposal/v1', candidates:[{name, recommended, groups:[{name, fields}], reason}]}——" +
          "name＝候选名（卡面标题）、recommended 有且仅一个候选为 true（推荐首选）、groups 逐组给组名与字段 id 列表、reason 给候选理由。" +
          "传了就按候选出卡让用户选；不传且字段自带 group＝用户已给，不出卡（仅 experiment_setup 段有意义，其它段忽略该参）",
      },
      grouping_confirm: {
        type: "boolean",
        description:
          "确认当前分组方案为选定方案（仅 experiment_setup 段有意义，其它段忽略）：" +
          "确认后内核按组逐图各一条生成 mode1 样本；不给＝未确认，mode1 本轮不生成（卡面明示）。" +
          "分组必须用户确认——agent 给出的只是候选，不得默认成立",
      },
      mode5_random: {
        type: "number",
        description:
          "mode5 增广倍数（仅 experiment_setup 段有意义，其它段忽略；0=不启用）：倍数＝产出总量相对" +
          "「基线行数」的倍数，基线行数＝mode0 全字段透传的行数（一页一行，即页数）；mode1 与 targeted " +
          "产出的行不计入基线。倍数不得固定值——要么用户给定、要么 agent 按数据分析建议后用户确认。" +
          "不给＝未确认，mode5 本轮不生成（卡面明示，不静默用缺省）",
      },
      mode5_advice_stats: {
        type: "object",
        additionalProperties: true,
        description:
          "mode5 建议所依据的数据规模统计（Mode5AdviceStats/v1：images／full_field_baseline_rows／可选 suggested_mode5_random）" +
          "（仅 experiment_setup 段有意义）：给出时内核据此算建议值与理由并随卡呈现；" +
          "建议不自动生效（effective:false），用户仍须给 mode5_random 才定值。可直接给对象，无需自行落盘",
      },
      targeted_advice: {
        type: "object",
        additionalProperties: true,
        description:
          "targeted 组合的 agent 建议（TargetedRulesAdvice/v1）（仅 experiment_setup 段有意义）：" +
          "字段 suggested_carry_fields／suggested_min_fields／suggested_max_fields／reason／" +
          "evidence（形如 container_no:occurrence_rate，须能在本批风险信号里查到）／effective（必须 false）。" +
          "建议不自动生效、随卡呈现；必带字段与区间须由风险分析得出，无理由或无出处会被拒。可直接给对象，无需自行落盘",
      },
      negative_ratio_target: {
        type: "string",
        description:
          "负样本目标带 <下限,上限>（仅 experiment_setup 段有意义，其它段忽略该参）：用户确认的" +
          "负样本构造配额带（如 0.03,0.06）。显式给定时实验门以该值锁定并标注来源为用户指定；" +
          "不给时按构造器内置常量带（0.02,0.05）兜底（不静默——审批卡与返回体如实标注来源）。" +
          "本次训练方案卡的 negative_ratio_target 值在本段触发时应原样带入",
      },
      // owner 2026-10-26（T4 放宽）：像素下限偏离惯例基线时的理由位（harness 侧账，不下传内核）
      pixel_pair_reason: {
        type: "string",
        description:
          "像素下限偏离惯例基线时的理由（仅 experiment_setup 段有意义；**不传给内核**，只进本工具回执与卡面账）：" +
          "下限默认锚定惯例基线（训练/评估用同一对值）。若确需别的下限，在此写清原因即可放行；" +
          "不写原因即拒（不静默放行、也不静默改回基线）",
      },
      // H7h：卡位（仅 training_prep 段；显式 > 确认快照兜底 > 不下传，回退 deploy 层）
      visible_devices: {
        type: "string",
        description:
          "训练绑卡（仅 training_prep 段有意义，其它段忽略该参）：形如 0-7 或 4,5,6,7。" +
          "显式给定时原样下传内核 --visible-devices（nproc ≤ 卡数 由内核校验）；" +
          "不给时读 run 目录 webui/config-snapshot.json 的确认值兜底（本次训练方案卡选的卡位即由此生效）；" +
          "两者皆无＝不下传（回退 deploy 层 cuda_visible_devices）。形态非法即拒（不静默纠正）",
      },
      // E3：预算五参（仅 experiment_setup 段；显式 > 确认快照兜底 > unspecified 不下传）
      max_total_tokens: {
        type: "number",
        description:
          "单样本 token 上限（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数）：与截断/推理窗口、像素对成组进实验门。" +
          "未显式给定时读 run 目录 webui/config-snapshot.json 确认快照兜底（方案确认值通路——原样带入）；" +
          "两者皆无则不下传（内核按缺省处理，来源如实标注 unspecified）",
      },
      cutoff_len: {
        type: "number",
        description:
          "训练截断长度（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数，须 ≥ max_total_tokens）：" +
          "系统惯例基线 **9000**（上限 12800）。与 max_model_len 独立取值、禁互相推导。" +
          "**用户没给就不要传**——不传即按基线走；自行编一个数（如 8192）等于替用户改训练口径，" +
          "且卡面会标成「本次调用传入（非你在方案卡确认的值）」，用户一眼看出不是他要的。" +
          "进实验门后由内核落 <run>/prep/token_budget.json 并注入训练配置；" +
          "未显式给定时读确认快照兜底；皆无则不下传（内核按缺省＝基线处理）",
      },
      max_model_len: {
        type: "number",
        description:
          "推理窗口（仅 experiment_setup 段有意义，其它段忽略该参；安全正整数，须 ≥ max_total_tokens）：" +
          "系统惯例基线 **12800**（这就是用户口中的「默认 12800」）。独立取值、禁由 cutoff 推导；" +
          "**用户没给就不要传**——不传即按 12800；自行编 16384 之类属于替用户改推理口径。" +
          "进实验门后由内核落预算文件并被评估服务引用；" +
          "未显式给定时读确认快照兜底；皆无则不下传（内核按缺省＝基线处理）",
      },
      image_min_pixels: {
        type: "number",
        description:
          "最小像素下限。**固定 65536，不接受任何改动**（数据构造/训练/评估必须用同一对象素值，改下限会让三段各说各话）。" +
          "⚠ 802816 与 1605632 是 **image_max_pixels 的两个可选档位**，与下限没有任何关系——" +
          "不要把 802816 当 min 传（真机发生过：传了就被内核以 pixel_pair_min_not_pinned_without_reason 拦下）。" +
          "一般根本不用传这个参数（不传即 65536；未显式给定时读确认快照兜底，皆无则不下传）。",
      },
      image_max_pixels: {
        type: "number",
        description:
          "最大像素上限，两个可选档位 **802816／1605632**（这是「像素对」里唯一可调的那一端）。" +
          "与 image_min_pixels 成对提供（单端即卡前快败），且须 65536 < 本值。改值影响坐标换算与 token 预算。" +
          "未显式给定时读确认快照兜底；皆无则不下传（内核按第一档 802816）",
      },
      doc_type: { type: "string", description: "单据类型（可缺省——缺省不上送，内核按数据/登记面推断，无法确定即 blocked；给了则显式指定）" },
      lane_suffix: { type: "string", description: "数据后缀（内部键，一般不用传：缺省不上送，内核按全部处理）" },
      field_config: {
        type: "string",
        description:
          "字段配置 JSON 路径（可缺省——缺省不上送，内核走 run 内／登记面既有来源）。" +
          "显式给出时须为 PromptFieldConfig/v1：顶层 document_type／document_zh／" +
          "template（含 {extraction_info} 占位符）／training_excluded_fields（不排除写 []）／" +
          "fields[]，fields 每项须含 field_id／zh／definition／group；group 键声明语义分组" +
          "（mode1 按 group 逐组生成）。传入其他形态会得到一次性全量缺失清单与最小合法骨架。",
      },
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
          " token 预算链路，混入即卡前拒绝）；卡位 visible_devices 走 deploy/launch 亦不收。未显式给时读 run 目录 webui/config-snapshot.json 确认快照构造（方案确认值通路——快照是训练参数唯一出口，" +
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
      args: { stage: string; run_id: string; workspace_path?: string; source_root?: string; base_model_path?: string; assemble?: boolean; base_model_family?: string; auto_style_cluster?: string; allow_small_cluster_test?: boolean; grouping_preset?: string; negative_ratio_target?: string; max_total_tokens?: number; cutoff_len?: number; max_model_len?: number; image_min_pixels?: number; image_max_pixels?: number; pixel_pair_reason?: string; doc_type?: string; lane_suffix?: string; field_config?: string; train_all?: boolean; assignment_source?: string; reuse_experiment_setup?: boolean; token_provider?: string; retry_coordinate_pending?: boolean; visible_devices?: string; training_overrides?: Record<string, unknown>; grouping_proposal?: Record<string, unknown>; grouping_confirm?: boolean; mode5_random?: number; mode5_advice_stats?: Record<string, unknown>; targeted_advice?: Record<string, unknown> },
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
      if (baseModelPath !== "" && !isAbsolute(baseModelPath)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "base_model_path_not_absolute", note: `base_model_path 须为本地模型目录绝对路径（得 ${baseModelPath}）——模型家族名（如 qwen3_vl）不可当路径用；目录内须有 config.json（合法性由内核闸复核）` });
      }
      // D89：分组方案取值（审批前定——卡面要呈现分组方案行；「按未给处理」＝trim 后空串
      // 一律视同未指定，内核缺省 B 生效。harness 不复制枚举外的校验，choices 越界由框架
      // enum 校验与内核 argparse 双闸）。
      const groupingPreset = typeof args.grouping_preset === "string" ? args.grouping_preset.trim() : "";
      // G2：形状校验（取值集合归内核，harness 不再持有 A/B 词表）——形状不合即拒，不猜不改
      if (groupingPreset !== "" && !GROUPING_PRESET_SHAPE.test(groupingPreset)) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: "grouping_preset_invalid", note: `grouping_preset 形状不合法（得「${groupingPreset.slice(0, 32)}」）：应为 1-32 位字母数字／下划线／连字符；具体取值集合以训练内核声明为准` });
      }
      // D99：负样本目标带取值（同 D89 口径——trim 后空串视同未指定；形态合法性由内核
      // 实验门脚本解析（float 化失败即业务拒绝），harness 不复制格式校验不夹取）。
      const negativeRatioTarget = typeof args.negative_ratio_target === "string" ? args.negative_ratio_target.trim() : "";
      // H7h/T3：卡位终值（仅 training_prep；内核 b16 K-E9c 专用旗标）。不走 --training-overrides
      // ——内核九键白名单明确排除 visible_devices；来源链＝显式 > 确认快照 > 不下传，
      // 解析在 runDir 就绪后的 training_prep 分支执行（下方 resolvedDevices）。
      let visibleDevices = "";
      let visibleDevicesSource: VisibleDevicesSource = "deploy_default";
      // E3：落点单源提前到审批前（预算三参快照兜底要读 run 目录）；canonical 在场优先
      // （内核 RunLayout v1 同口径——canonical <wp>/workspace/runs/<id>，legacy 公式兜底；
      // 软链拒）。argv 的 --workspace 仍传用户原值（workspace 根贯通内核——内核自解析
      // 落点，harness 不代传展开后的路径）。
      const resolvedRun = resolvePipelineRunDir(workspacePath, args.run_id);
      if ("error" in resolvedRun) {
        return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      // D3：联合装配判定（显式 assemble 优先；未给时按单据槽位数确定性判定——多类必需、
      // 单类保持旧行为）。argv 与回执同用这一份结论，避免"装配了但回执说没装配"。
      const docTypeGiven =
        typeof args.doc_type === "string" && args.doc_type.trim() !== "";
      const assembleDecision =
        args.stage === "training_prep"
          ? assembleDecisionOf(args.assemble, slotDocCountOf(runDir), docTypeGiven)
          : { assemble: false, source: "single_doc" as const };
      // E3：预算三参（仅 experiment_setup 段）——终值解析（显式 > 确认快照兜底 >
      // unspecified 不下传）＋像素对成对校验（min<max，判据单源 pixelPairViolationOf）；
      // 坏值一律卡前快败不进审批（不消耗放行）；其它段零进入（不加键不下传）。
      let tokenParams:
        | { values: ExperimentTokenParams; sources: Record<string, ExperimentTokenParamSource> }
        | undefined;
      /** T4 例外账（下限偏离基线且理由在场时才填——回执与卡面双呈现）。 */
      let pixelPairException: { image_min_pixels: number; baseline: number; reason: string } | undefined;
      if (args.stage === "experiment_setup") {
        const resolvedParams = resolveExperimentTokenParams(args, runDir);
        if (!resolvedParams.ok) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedParams.error, note: resolvedParams.note });
        }
        // E3：像素对成对校验（内核 b8 main() 参数形状层同款口径——单端即拒，业务
        // 文案对齐；先于审批不消耗放行）＋两端在场时的 min<max 关系校验（判据单源
        // pixelPairViolationOf——与本次训练方案卡同一文案面）。
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
        // T4：像素对不变量下沉到段参数通道（此前只有确认卡 overrides 分支有）——
        // ①上限必须落在两档闭集（单源 TRAINING_PIN_CONSTANTS，与方案卡 clamp 域同源）；
        // ②下限锚定惯例基线（原则一：训练/评估必须同一对值，评估只引用训练确认值）。
        // 越界即拒，**不静默纠正**（clamp 是卡面交互的事，段通道一旦静默改写就等于
        // 用户确认值与实际生效值两份账）。
        if (maxPx !== undefined && !TRAINING_PIN_CONSTANTS.image_max_pixels.includes(maxPx)) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "pixel_pair_max_not_in_closed_set",
            note: `image_max_pixels=${String(maxPx)} 不在两档闭集（${TRAINING_PIN_CONSTANTS.image_max_pixels.map((value) => value.toLocaleString("en-US")).join(" / ")}）——请改选其中一档后重推（不静默纠正）`,
          });
        }
        // owner 裁定（2026-10-26）：护栏防的是「两本账不一致」，不是「用户明确选择的不同下限」——
        // 下限偏离基线时**带理由即放行**（理由进回执与卡面账），缺理由才拒；不静默改写。
        const pixelPairReason = typeof args.pixel_pair_reason === "string" ? args.pixel_pair_reason.trim() : "";
        if (minPx !== undefined && minPx !== TRAINING_PIN_CONSTANTS.image_min_pixels) {
          if (pixelPairReason === "") {
            return asToolValue({
              ok: false,
              stage: args.stage,
              run_id: args.run_id,
              error: "pixel_pair_min_not_pinned_without_reason",
              note: `image_min_pixels=${String(minPx)} 与惯例基线 ${TRAINING_PIN_CONSTANTS.image_min_pixels.toLocaleString("en-US")} 不一致——训练与评估必须用同一对像素值，改下限要有可解释的理由：请在 pixel_pair_reason 写明原因后重推（缺理由即拒；本通道不改写、不静默回退）`,
            });
          }
          pixelPairException = { image_min_pixels: minPx, baseline: TRAINING_PIN_CONSTANTS.image_min_pixels, reason: pixelPairReason };
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
      // A 面：构造参数通道（分组确认／mode5 增广／targeted 建议）。
      // 三条都是「必须用户确认」的参数，此前 harness 侧完全没有通道——模型即使分析出
      // 结论也表达不出来（真机表现：分组未确认 → mode1 不生成 → 行数少）。内联对象
      // 由本层落 <run>/prep 再传路径，模型不需要自己写文件。
      let constructionParams:
        | {
            groupingConfirm: boolean;
            mode5Random: number | undefined;
            targetedAdvice:
              | { carry: string[]; min: number | null; max: number | null; reason: string; evidence: string[]; evidenceStatus: string }
              | undefined;
          }
        | undefined;
      const constructionAdvicePaths: { mode5AdviceStats?: string; targetedAdvice?: string; riskSignals?: string } = {};
      if (args.stage === "experiment_setup") {
        const groupingConfirm = args.grouping_confirm === true;
        const mode5Random = typeof args.mode5_random === "number" ? Number(args.mode5_random) : undefined;
        // run 尚未创建（register 段前）且本次要落 advice 文件时不落任何目录：在占位路径下
        // 建目录会让内核 create_run 判「落点已被占用且缺合法 run.json」而永久拒绝该 run_id。
        // 不带 advice 参数的 experiment_setup 段（常规路径）不受影响——本工具只读不建。
        const wantsAdviceWrite = args.mode5_advice_stats !== undefined || args.targeted_advice !== undefined;
        if (wantsAdviceWrite && !existsSync(runDir)) {
          return asToolValue({
            ok: false, stage: args.stage, run_id: args.run_id, run_dir: runDir,
            error: "run_not_created",
            note: "run 尚未创建（register 段经内核 create_run 落位）——先跑 register 段再带 advice 参数重推；"
              + "本工具不在未创建的 run 路径下建目录（否则内核将无法落位该 run_id）",
          });
        }
        const writeAdviceFile = (name: string, payload: unknown): string => {
          // RunLayout/v3：prep → data（存量 v2 run 的 prep/ 经 resolveRunSubdir 只读兼容）；
          // 产物路径以显式路径回传内核（--mode5-advice-stats/--targeted-advice），落点不猜
          const prepDir = resolveRunSubdir(runDir, "prep");
          mkdirSync(prepDir, { recursive: true });
          const target = join(prepDir, name);
          writeFileSync(target, JSON.stringify(payload, null, 1) + "\n", "utf-8");
          return target;
        };
        if (args.mode5_advice_stats !== undefined) {
          constructionAdvicePaths.mode5AdviceStats = writeAdviceFile("mode5-advice-stats.json", args.mode5_advice_stats);
        }
        let targetedAdvice:
          | { carry: string[]; min: number | null; max: number | null; reason: string; evidence: string[]; evidenceStatus: string }
          | undefined;
        if (args.targeted_advice !== undefined) {
          const raw = args.targeted_advice as Record<string, unknown>;
          constructionAdvicePaths.targetedAdvice = writeAdviceFile("targeted-advice.json", raw);
          const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
          targetedAdvice = {
            carry: asStrings(raw["suggested_carry_fields"]),
            min: typeof raw["suggested_min_fields"] === "number" ? Number(raw["suggested_min_fields"]) : null,
            max: typeof raw["suggested_max_fields"] === "number" ? Number(raw["suggested_max_fields"]) : null,
            reason: String(raw["reason"] ?? ""),
            evidence: asStrings(raw["evidence"]),
            // 卡面先按未校验呈现；真实校验态以内核返回的 construction 为准（下一步会带回来）
            evidenceStatus: "pending_kernel_verify",
          };
        }
        constructionParams = { groupingConfirm, mode5Random, targetedAdvice };
        // 风险信号在场才带：targeted evidence 的出处校验要用它（缺则内核标未校验）
        const riskDocType = typeof args.doc_type === "string" && args.doc_type.trim() !== "" ? args.doc_type.trim() : "do";
        const riskPath = resolveRunFile(runDir, `prep/risk-signals/${riskDocType}/field_risk_signals.json`);
        if (existsSync(riskPath)) constructionAdvicePaths.riskSignals = riskPath;
      }
      // A 面采纳卡：agent 给了建议 → 先问 owner「是否按建议执行」（卡收意愿，审批卡授权）。
      // 依据 SKILL「必带字段由字段风险分析推荐、经用户确认后写入构造配置」——先前只有呈现
      // 没有采纳入口，建议永远停在配置里不改变构造行为。无 userQuestions 服务时降级：
      // 不弹卡、不采纳，卡面与返回体如实标注（不假装采纳过）。
      let targetedAccept = false;
      let acceptNote = "未提供建议，无需采纳";
      if (constructionParams !== undefined && constructionParams.targetedAdvice !== undefined) {
        const adv = constructionParams.targetedAdvice;
        const range = adv.min !== null && adv.max !== null ? `${adv.min}-${adv.max} 字段` : "区间不主张";
        const svc = ctx.get("userQuestions") as FormAskService | undefined;
        if (svc !== undefined && typeof svc.ask === "function") {
          try {
            const answers = await svc.ask({
              questions: [formAskQuestion({
                id: `construction-${args.run_id}`,
                question: `构造参数确认 — ${args.run_id}`,
                header: "targeted 组合建议",
                detail: [
                  `agent 建议：必带 ${adv.carry.length > 0 ? adv.carry.join("、") : "(无)"}；字段数 ${range}`,
                  `理由：${adv.reason}`,
                  `依据：${adv.evidence.join("、")}（${adv.evidenceStatus === "verified" ? "已校验" : "待内核按本批风险信号校验"}）`,
                  `填 yes＝把建议写入本轮构造规则（必带字段与字段数按建议，来源标 advice_accepted）；`,
                  `no/留空＝保持当前生效值，建议只留档不改变构造行为。`,
                  `本卡只收意愿——执行授权仍在随后那张审批卡。`,
                ].join("\n"),
                fields: [{
                  key: "targeted_accept",
                  label: "targeted_accept（是否按建议执行）",
                  value: "no",
                  placeholder: "yes＝按建议写入构造规则；no/留空＝保持当前值",
                  hint: "建议不自动生效；填 yes 后仍需审批卡放行才执行",
                }],
                submitLabel: "提交构造参数选择",
              })],
              agent: exec.agent,
              signal: exec.signal,
            });
            const submitted = editsFromFormAnswers(answers);
            targetedAccept = String(submitted["targeted_accept"] ?? "").trim().toLowerCase() === "yes";
            acceptNote = targetedAccept ? "已采纳建议（写入本轮构造规则）" : "保持当前值（建议仅留档）";
          } catch (cause) {
            acceptNote = `采纳卡应答失败：${String(cause).slice(0, 120)}（按未采纳处理，保持当前值）`;
          }
        } else {
          acceptNote = "user_questions_unavailable——未弹采纳卡，建议仅留档（保持当前值）";
        }
      }
      if (args.stage === "training_prep") {
        // T3：卡位来源链（快照兜底接线——方案卡选的卡位由此真正进启动件）
        const resolvedDevices = resolveVisibleDevices(args, runDir);
        if (!resolvedDevices.ok) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedDevices.error, note: resolvedDevices.note });
        }
        visibleDevices = resolvedDevices.value;
        visibleDevicesSource = resolvedDevices.source;
        const resolvedOverrides = resolveTrainingOverrides(args, runDir);
        if (!resolvedOverrides.ok) {
          return asToolValue({ ok: false, stage: args.stage, run_id: args.run_id, error: resolvedOverrides.error, note: resolvedOverrides.note });
        }
        trainingOverrides = { values: resolvedOverrides.values, sources: resolvedOverrides.sources, passDown: resolvedOverrides.passDown };
      }
      // ── C2 分组四态（仅 experiment_setup 段）：字段自带 group＞候选建议＞都没有＝平铺 ──
      // 完全权限档不出卡、直接按推荐候选选定（owner 裁定 §8-1-A）；其余档出原生选项卡。
      // 字段清单确认已前移到 register 段之后（owner 2026-10-28 顺序纠正：
      // 字段是登记时从标注梳理出来的，确认必须紧跟着做，不能拖到实验配置段）。
      // 这里只读账本，供回执与后续判据使用。
      const fieldChoiceConfirmed = args.stage === "experiment_setup" && readFieldChoice(runDir) !== null;
      let fieldChoiceLine = "";
      if (args.stage === "experiment_setup") {
        const prior = readFieldChoice(runDir);
        if (prior !== null) {
          fieldChoiceLine = `字段清单：${String(prior.total_fields)} 个（你在登记后确认过${
            prior.all_fields ? "，全部训练" : `，训练 ${prior.confirmed_fields.join("、")}`
          }）`;
        }
      }
      let groupingFace: GroupingFace | undefined;
      if (args.stage === "experiment_setup") {
        const fieldConfigPath = typeof args.field_config === "string" ? args.field_config.trim() : "";
        const resolvedGrouping = await resolveGroupingFace({
          ctx,
          exec,
          runId: args.run_id,
          fieldConfigPath,
          proposalRaw: args.grouping_proposal,
          runDir,
          fieldChoiceConfirmed,
        });
        if ("ok" in resolvedGrouping) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "grouping_proposal_invalid",
            errors: resolvedGrouping.errors,
            note: "分组建议格式不合格——errors 是逐条原因（原样，不压缩成一句话）；按它改好再重推，或去掉该参数让字段配置自带的 group 生效",
          });
        }
        groupingFace = resolvedGrouping;
      }
      // 分组节（读内核 experiment-config 的新 keys；列表形态只读 group_plan——groups 是 dict）：
      // 仅当 run 里已有一次实验配置时上卡（重跑/复用场景，用户确认要不要沿用）；
      // 首次跑没有产物就不占卡面视线。
      const priorGrouping = args.stage === "experiment_setup" ? readExperimentGrouping(runDir) : null;
      const priorGroupingSection = priorGrouping === null
        ? undefined
        : `（以下是 run 里已有的一次实验配置，本次会按当前输入重算）\n${renderGroupingSection(priorGrouping, fieldNameMapOf(runDir))}`;
      const verdict = await requestApproval(ctx, exec, "atf_pipeline_stage",
        buildApprovalReason({
          action: "触发管线段",
          target: `「${args.stage}」（run ${args.run_id}）`,
          effect: "在 run 目录内写该段产物（register 段另读源文档根）",
          reversible: "段产物可人工清理；已写数据面不自动回滚",
          // D24h：卡面追加放行权属行（与评估 EVAL_RELEASE 卡同款——点卡权属只在 owner）
        })
        // D89：分组方案行仅 experiment_setup 段呈现（其它段该参无意义不上卡）
        + (args.stage === "experiment_setup" ? `\n${groupingPresetApprovalLine(groupingPreset)}` : "")
        // C2：分组来源行（四态各一句业务话——卡上能看到「按谁的分组走」）
        + (args.stage === "experiment_setup" && groupingFace !== undefined ? `\n${groupingApprovalLine(groupingFace)}` : "")
        // D99：负样本带行仅 experiment_setup 段呈现（与分组方案行同款「缺省不静默」）
        + (args.stage === "experiment_setup" ? `\n${negativeRatioApprovalLine(negativeRatioTarget)}` : "")
        // A 面：构造参数确认段（分组确认／mode5／targeted 建议）仅 experiment_setup 段呈现
        + (args.stage === "experiment_setup" && constructionParams !== undefined
            ? `\n${constructionParamsApprovalLines({ ...constructionParams, riskSignalsProvided: constructionAdvicePaths.riskSignals !== undefined })}`
            : "")
        // A 面：采纳选择行（卡上选了 yes/no 的结果如实呈现在授权卡上）
        + (args.stage === "experiment_setup" && constructionParams?.targetedAdvice !== undefined ? `\n采纳选择：${acceptNote}` : "")
        // E3：预算三参行仅 experiment_setup 段呈现（终值与来源双双上卡）
        + (args.stage === "experiment_setup" && tokenParams !== undefined ? `\n${experimentTokenApprovalLine(tokenParams.values, tokenParams.sources)}` : "")
        + (priorGroupingSection === undefined ? "" : `\n${priorGroupingSection}`)
        // T4 例外：下限偏离基线时把理由摆上卡（用户在自己确认的这一屏能看到差异与原因）
        + (pixelPairException !== undefined
            ? `\n像素下限例外：${String(pixelPairException.image_min_pixels)}（基线 ${pixelPairException.baseline.toLocaleString("en-US")}）——理由：${pixelPairException.reason}`
            : "")
        // E4-乙：训练参数覆盖行仅 training_prep 段呈现（终值与来源逐键上卡；convention 明示只呈现不下传）
        + (args.stage === "training_prep" && trainingOverrides !== undefined ? `\n${trainingOverridesApprovalLine(trainingOverrides.values, trainingOverrides.sources)}` : "")
        // E8·H1：装配模式行仅 training_prep 段呈现（run 级联合装配语义上卡——槽位枚举
        // 与 doc_type 互斥口径可见，卡面不出现落点路径指引）
        + (assembleMode ? "\n装配模式（assemble）：run 级联合装配——枚举本 run 单据槽位合并训练数据并生成迭代配置与启动件（不按单类执行）" : "")
        // E5·H3 D140：训练输出目录行仅 training_prep 段呈现（落点可见——盘上终值优先，
        // 首跑无配置时按内核 ADR-0005 run 布局呈现预期并标注来源）
        + (args.stage === "training_prep" ? `\n${trainingOutputDirApprovalLine(trainingOutputDirOf(runDir))}` : "")
        // T3：卡位终值与来源上卡（仅 training_prep——「卡面选了什么卡」与「实际绑了什么卡」同屏可对账）
        + (args.stage === "training_prep" ? `\n${visibleDevicesApprovalLine(visibleDevices, visibleDevicesSource)}` : "")
        + "\n仅 owner 可点；执行方不得代点");
      if (!verdict.ok) return approvalDeniedResult("atf_pipeline_stage", verdict.outcome);
      // 落点单源（A2.2b）：与内核同一决定者 <workspace_path>/runs/<run_id>；resolveRunDir 本工具内退役
      // （E3：runDir 已提前到审批前计算——预算三参快照兜底同源落点，此处不复算）。
      // argv 只传内核声明参数（register 时含 --source-root；training_prep 时含 --base-model
      // ——A-E14b，其它段不追加；family_split 时含 --auto-style-cluster——E10b，缺省 auto
      // 也显式上线解析值；E10d：allow_small_cluster_test 仅 family_split 且 true 才追加
      // 开关，缺省不出现在 argv，其它段不追加不报错）；禁拼第二套路径。
      const argv: string[] = ["--workspace", workspacePath, "--run-id", args.run_id, "--stage", args.stage];
      if (args.stage === "register") {
        // D-b：传前按内核同一判据校验（批根 + 单据类型 → 子目录必须存在），
        // 不把「拼成 …/awb/awb 不存在」这种可自证的错误留到内核侧只有一句「不可解析」。
        const sourceRootGiven = (args.source_root as string).trim();
        const docTypeForRoot = typeof args.doc_type === "string" ? args.doc_type.trim() : "";
        const rootPrecheck = sourceRootPrecheckOf(sourceRootGiven, docTypeForRoot);
        if (!rootPrecheck.ok) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: rootPrecheck.error,
            source_root_given: sourceRootGiven,
            source_root_resolved: rootPrecheck.resolved,
            doc_type: docTypeForRoot === "" ? null : docTypeForRoot,
            ...(rootPrecheck.expected_dir !== null ? { expected_dir: rootPrecheck.expected_dir } : {}),
            subdirs_present: rootPrecheck.subdirs_present,
            note: rootPrecheck.note,
          });
        }
        argv.push("--source-root", rootPrecheck.resolved);
      }
      // 显式给的基模型一律下传（assemble 模式亦然）：再水合只是「没给」时的兜底，
      // 不能把用户显式值静默丢掉（不静默原则——丢了就是 blocked 与卡上填值不符）。
      // 只有训练准备段接受 --base-model（其它段内核不声明该参数，传了会被 argparse 拒）。
      // 段内：非 assemble 必传（上方已校验非空）；assemble 形态此前被 needsBaseModel 判成
      // 「不需要」而把显式值一起丢掉——真机事故：卡上填了基模型、系统报「路径未提供」。
      if (args.stage === "training_prep" && (needsBaseModel || baseModelPath !== "")) {
        argv.push("--base-model", baseModelPath);
      }
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
      if (fieldConfig !== "") {
        // D-a：传前校验＋绝对化（纯函数单测覆盖；见 fieldConfigPrecheckOf）
        const precheck = fieldConfigPrecheckOf(fieldConfig, runDir, args.doc_type);
        if (!precheck.ok) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "field_config_not_found",
            field_config_given: precheck.given,
            field_config_resolved: precheck.resolved,
            note: precheck.note,
          });
        }
        argv.push("--field-config", precheck.resolved);
      }
      // E8·H1：装配模式旗标（仅 training_prep 段且显式 true 才追加——缺省不出现在
      // argv，其它段不追加不报错；内核 b12 声明面 store_true）。
      if (assembleMode || assembleDecision.assemble) argv.push("--assemble");
      // E8·H2 配套：基模型家族透传（内核全局参数、多段读取——D93 先例不按段 gate；
      // 显式给且 trim 非空才追加，缺省 qwen3_vl 由内核自带不下传——联合装配链经
      // atf_joint_train 透传非缺省家族）。
      const baseModelFamily = typeof args.base_model_family === "string" ? args.base_model_family.trim() : "";
      if (baseModelFamily !== "") argv.push("--base-model-family", baseModelFamily);
      // D89：分组方案透传（仅 experiment_setup 段；显式给且 trim 非空才追加——未给不追加，
      // 内核缺省 B 生效；其它段忽略该参不下传不报错）。与上方段特定/全局追加逻辑并存。
      if (args.stage === "experiment_setup" && groupingPreset !== "") argv.push("--grouping-preset", groupingPreset);
      // C2：分组建议透传（仅 experiment_setup 段且候选已定）——临时 JSON 落系统临时目录，
      // 段命令退出即删（不落工作区，避免被当成产物）；用户选定后推荐值改成他选的那个。
      let groupingProposalPath: string | null = null;
      if (args.stage === "experiment_setup" && groupingFace?.payload != null) {
        const safeRunId = args.run_id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
        const proposalPath = join(tmpdir(), `atf-grouping-proposal-${safeRunId}-${String(process.pid)}.json`);
        try {
          writeFileSync(proposalPath, `${JSON.stringify(groupingFace.payload, null, 1)}\n`, "utf8");
        } catch (cause) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "grouping_proposal_unwritable",
            note: `分组建议落临时文件失败（${proposalPath}）：${String(cause).slice(0, 160)}——本次没有下传分组建议，按字段配置或内核缺省走`,
          });
        }
        groupingProposalPath = proposalPath;
        argv.push("--grouping-proposal", groupingProposalPath);
      }
      // D99：负样本目标带透传（仅 experiment_setup 段；显式给且 trim 非空才追加——内核
      // :1155 显式才下传实验门并标 user_specified；未给不追加，构造器常量带兜底；其它段
      // 忽略该参不下传不报错）。
      if (args.stage === "experiment_setup" && negativeRatioTarget !== "") argv.push("--negative-ratio-target", negativeRatioTarget);
      // A 面：构造参数透传（分组确认/mode5/targeted 建议＋风险信号出处校验文件）
      if (args.stage === "experiment_setup" && constructionParams !== undefined) {
        if (constructionParams.groupingConfirm) argv.push("--grouping-confirm");
        if (constructionParams.mode5Random !== undefined) argv.push("--mode5-random", String(constructionParams.mode5Random));
        if (constructionAdvicePaths.mode5AdviceStats !== undefined) argv.push("--mode5-advice-stats", constructionAdvicePaths.mode5AdviceStats);
        if (constructionAdvicePaths.targetedAdvice !== undefined) argv.push("--targeted-advice", constructionAdvicePaths.targetedAdvice);
        if (constructionAdvicePaths.riskSignals !== undefined) argv.push("--risk-signals", constructionAdvicePaths.riskSignals);
        if (targetedAccept) argv.push("--targeted-accept");
      }
      // E3：预算三参透传（仅 experiment_setup 段；终值在场才追加——显式值与快照兜底值
      // 同面下传（内核 b8 argparse --max-total-tokens／--image-min-pixels／
      // --image-max-pixels）；unspecified 不出现在 argv，零新增语义）。
      // H7h：绑卡下传（仅 training_prep；缺省不追加，回退 deploy 层）
      if (args.stage === "training_prep" && visibleDevices !== "") argv.push("--visible-devices", visibleDevices);
      if (args.stage === "experiment_setup" && tokenParams !== undefined) {
        if (tokenParams.values.max_total_tokens !== undefined) argv.push("--max-total-tokens", String(tokenParams.values.max_total_tokens));
        // C（2026-10-26）：训练截断与推理窗口同门下传（内核 b17 argparse 新增）——
        // 缺项不追加（内核侧门内 null，预算落盘缺项才回退基线）。
        if (tokenParams.values.cutoff_len !== undefined) argv.push("--cutoff-len", String(tokenParams.values.cutoff_len));
        if (tokenParams.values.max_model_len !== undefined) argv.push("--max-model-len", String(tokenParams.values.max_model_len));
        // 问题 4（owner 2026-10-28）：像素下限固定 65536——**在拼参前拦**，不给它走到内核
        // 变成一句 pixel_pair_min_not_pinned_without_reason（那句话只说「与基线不一致」，
        // 没说「802816 其实该填在 max_pixels」，用户和 agent 都得再猜一轮）。
        // 只拦**owner 指出的那种错**：把 image_max_pixels 的档位（802816／1605632）当 min 传。
        // 不拦其它偏离值——下调下限（如小字号数据用 1024）是合法场景，内核允许带
        // pixel_pair_reason 说明理由后放行；harness 比内核更严会造成「内核允许但工具不让」。
        const minPixelsAsMaxTier = [802_816, 1_605_632];
        if (tokenParams.values.image_min_pixels !== undefined && minPixelsAsMaxTier.includes(tokenParams.values.image_min_pixels)) {
          return asToolValue({
            ok: false,
            stage: args.stage,
            run_id: args.run_id,
            error: "image_min_pixels_is_max_tier",
            image_min_pixels_given: tokenParams.values.image_min_pixels,
            note:
              `${String(tokenParams.values.image_min_pixels)} 是 **image_max_pixels 的档位**，不是像素下限——两者没有任何关系。`
              + `像素下限（image_min_pixels）的基线与上限都是 65,536；要调像素请改 image_max_pixels`
              + `（两档 802816／1605632 二选一）。本次未下传任何像素参数。`,
          });
        }
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
      // 询问闸权限档（DecisionGate/v1）：会话权限档＝完全访问时下传 full，其余一律
      // limited——「问不问」的裁决面在内核（同一份规则单源），harness 只做确定性传导。
      // 用 env 而非 CLI 旗标：pin 内旧内核不认识 --access-mode 会让整条链 argparse
      // 失败，env 未识别＝被忽略——升级前后同一份 harness 都安全，re-pin 后自动生效。
      const accessMode = sandboxModeOf(ctx, exec) === DANGER_FULL_ACCESS_SANDBOX ? "full" : "limited";
      const result = await runPipeline(pipelineCommand, argv, pipelineTimeoutMs,
        { ATF_ACCESS_MODE: accessMode });
      // C2：分组建议临时件用完即删（scratch/tmp 语义——不留在工作区冒充产物）
      if (groupingProposalPath !== null) {
        try { rmSync(groupingProposalPath, { force: true }); } catch { /* 删不掉不阻塞段回报 */ }
      }
      // ── 字段清单确认（问题 1）──────────────────────────────────────────────
      // **紧接登记**：字段清单是 register 段从标注梳理出来的（field-labels.json），
      // 所以登记一成功就问「这些字段对不对、要训哪些」——顺序上不能滞后。
      // owner 2026-10-28 当场纠正过一次（原实现拖到 experiment_setup 才问）。
      let fieldChoiceSummary: Record<string, unknown> | undefined;
      if (args.stage === "register" && result.code === 0) {
        const labels = readFieldLabels(runDir);
        if (labels !== null) {
          const prior = readFieldChoice(runDir);
          if (prior !== null) {
            fieldChoiceSummary = {
              confirmed_fields: prior.confirmed_fields,
              all_fields: prior.all_fields,
              total_fields: prior.total_fields,
              reused: true,
              decided_at: prior.decided_at,
            };
          } else {
            const svc = ctx.get("userQuestions") as FormAskService | undefined;
            if (svc !== undefined && typeof svc.ask === "function") {
              try {
                // 提问卡：**两个选项 + 自由输入框**（owner 2026-10-28 指定形态）。
                // vendor `QuestionComposer` 在有 options 时会额外渲染一个自由输入 textarea
                // （`customInline` variant）——它的 placeholder 不进 innerText，所以探针看不见，
                // 但它确实在场。第二项的说明直接指过去，用户不用猜。
                const answers = await svc.ask({
                  questions: [{
                    id: `field-choice-${args.run_id}`,
                    question: `这批数据的字段清单要全用它吗？— ${args.run_id}`,
                    header: "字段清单",
                    detail: fieldChoiceDetailOf(labels),
                    options: [
                      {
                        label: `全部 ${String(labels.label_count)} 个字段都训练`,
                        description: `推荐——共 ${String(labels.box_count)} 个框、覆盖 ${String(labels.page_count)} 页`,
                      },
                      {
                        label: "我要挑几个字段",
                        description: "选这个，然后在下面的输入框里写字段名（如 awb, shipper）；也可以直接在输入框写",
                      },
                    ],
                    multiSelect: false,
                  }],
                  agent: exec.agent,
                  signal: exec.signal,
                });
                const picked = answers.answers.flatMap((answer) => [...answer.selected])[0] ?? "";
                const typed = answers.answers
                  .map((answer) => answer.custom ?? "")
                  .filter((value) => value.trim() !== "")
                  .join("；")
                  .trim();
                const known = new Set(labels.labels.map((item) => item.label));
                const requested = typed
                  .split(/[,，、\s]+/)
                  .map((name) => name.trim())
                  .filter((name) => name !== "");
                const allNamed = requested.length > 0 && requested.every((name) => known.has(name));

                if (allNamed) {
                  // 用户**在输入框里写了字段名且都在清单内** → 按他写的落账（最明确的用户决定）
                  writeFieldChoice(runDir, {
                    run_id: args.run_id,
                    confirmed_fields: requested,
                    all_fields: requested.length === labels.label_count,
                    total_fields: labels.label_count,
                    decided_at: new Date().toISOString(),
                    source: "user_confirmed",
                  });
                  fieldChoiceSummary = {
                    confirmed_fields: requested,
                    all_fields: requested.length === labels.label_count,
                    total_fields: labels.label_count,
                  };
                } else if (picked.startsWith("全部 ") && typed === "") {
                  writeFieldChoice(runDir, {
                    run_id: args.run_id,
                    confirmed_fields: labels.labels.map((item) => item.label),
                    all_fields: true,
                    total_fields: labels.label_count,
                    decided_at: new Date().toISOString(),
                    source: "user_confirmed",
                  });
                  fieldChoiceSummary = {
                    confirmed_fields: labels.labels.map((item) => item.label),
                    all_fields: true,
                    total_fields: labels.label_count,
                  };
                } else {
                  // 选了「挑几个」却没写字段名，或写了清单外的名字 → **不落账**，
                  // 把用户原话交回 agent 核对/追问；不替他改成「全都不要」，也不假确认。
                  fieldChoiceSummary = {
                    confirmed_fields: [],
                    all_fields: false,
                    total_fields: labels.label_count,
                    needs_selection: true,
                    user_words: typed !== "" ? typed : picked,
                    ...(requested.filter((name) => !known.has(name)).length > 0
                      ? { unknown_names: requested.filter((name) => !known.has(name)) }
                      : {}),
                    note:
                      "用户没有确认「全部训练」——请按他说的范围核对具体字段（清单外的名字先确认是笔误还是标注里没有），"
                      + "再以 field_config 显式给出；不要替他勾全选",
                  };
                }
              } catch {
                // 卡被关掉/通道失败 → 不造假确认：下一段前仍会再问（账本没有记录）
                fieldChoiceSummary = { confirmed_fields: [], all_fields: false, total_fields: labels.label_count, skipped: true };
              }
            }
          }
        }
      }
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
      // C1-L 面（变更单 §3 C1.3）：field_config_invalid 的结构化错误体原样透出。
      // 内核以 `ValueError: {"error": "field_config_invalid", ...}` 抛出，stderr 尾部
      // 可能还跟 traceback——用括号平衡切出对象，不靠整段 JSON.parse。
      const fieldConfigError = result.code !== 0 ? extractFieldConfigError(result.stderr) : null;
      // C2：内核判分组建议不合格（grouping_proposal_invalid）时 errors 原样透出——不压成一句话
      const groupingKernelErrors = result.code !== 0 ? groupingProposalErrorsOf(summary, result.stderr) : null;
      // 分组表的字段名：run 内字段配置＋本次显式字段配置（后者优先——用户刚给的那份最新）
      const groupingFieldNames = new Map<string, string>(fieldNameMapOf(runDir));
      for (const [fieldId, zh] of fieldNamesOfFieldConfig(typeof args.field_config === "string" ? args.field_config.trim() : "")) {
        groupingFieldNames.set(fieldId, zh);
      }
      return asToolValue({
        stage: args.stage,
        run_id: args.run_id,
        workspace_path: workspacePath,
        run_dir: runDir,
        // E3 补：落点形态对账（canonical＝内核 RunLayout v1 形态；legacy＝<wp>/runs 旧形态）
        run_dir_layout: resolvedRun.layout,
        // D3：training_prep 段必须说清"启动件有没有生成、装配是显式还是自动"——否则现场只能
        // 靠 ls 三个目录才发现 launch/train.sh 不存在（本轮真机即如此，训练因此没能拉起）。
        ...(args.stage === "training_prep"
          ? (() => {
              const artifacts = launchArtifactsOf(runDir);
              return {
                assemble_auto: assembleDecision.source,
                assemble_effective: assembleMode || assembleDecision.assemble,
                launch_artifacts: artifacts,
                ...(artifacts.present || !(result.code === 0)
                  ? {}
                  : {
                      launch_next:
                        "启动件尚未生成——用 assemble=true 重跑本段（内核枚举 run 的单据槽位合并生成 iteration-config 与 launch/train.sh），" +
                        "或用 atf_joint_train 做联合装配并启动；不要直接调 atf_run_training（缺启动件会空跑）",
                    }),
              };
            })()
          : {}),
        ok: result.code === 0,
        exit_code: result.code,
        // 询问闸：本次权限档 + 内核渲染的判定报告（「怎么执行 → 得到什么结果」，
        // 与内核 <run>/analysis/decisions/decisions.jsonl 同源；旧内核无该块＝省略键）。
        access_mode: accessMode,
        ...decisionReportKeys(summary),
        segment_fact_recorded,
        session_bound,
        ...(fact_segment !== null ? { fact_segment } : {}),
        // D24h：账本 approval_id 回传（解析失败/缺席省略键——typert lossless 拒 undefined 键）
        ...(approvalEntryId !== undefined ? { approval_entry_id: approvalEntryId } : {}),
        // A-E14b：base_model 对账值（explicit＝显式下传优先；对端摘要携带 source 时透传）
        ...(baseModelSourceOf(needsBaseModel, summary) !== undefined ? { base_model_source: baseModelSourceOf(needsBaseModel, summary) } : {}),
        // D89：分组方案标注（仅 experiment_setup 段）——「缺省不静默」：显式给标注 explicit，
        // 未给标 undeclared——内核无内置预设，分组唯一来源是 field-config 的 group 键
        // （可见、可对账；其它段不加两键）
        ...(args.stage === "experiment_setup"
          ? {
              grouping_preset: groupingPreset !== "" ? groupingPreset : null,
              grouping_preset_source: groupingPreset !== "" ? "explicit" : "undeclared",
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
        // E3：预算五参终值与来源（仅 experiment_setup 段五键恒在场——「缺省不静默」：
        // unspecified 如实标注、值未定＝null 呈现不造缺省值；其它段零键）
        ...(args.stage === "experiment_setup" && tokenParams !== undefined
          ? {
              max_total_tokens: tokenParams.values.max_total_tokens ?? null,
              max_total_tokens_source: tokenParams.sources["max_total_tokens"] ?? "unspecified",
              cutoff_len: tokenParams.values.cutoff_len ?? null,
              cutoff_len_source: tokenParams.sources["cutoff_len"] ?? "unspecified",
              max_model_len: tokenParams.values.max_model_len ?? null,
              max_model_len_source: tokenParams.sources["max_model_len"] ?? "unspecified",
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
        ...(args.stage === "training_prep"
          ? { visible_devices: visibleDevices === "" ? null : visibleDevices, visible_devices_source: visibleDevicesSource }
          : {}),
        // 字段清单确认结果（register 段即时确认）——**必须进回执**：
        // 否则 agent 不知道用户只确认了哪几个字段，后续还会按 17 个字段往下走
        // （真机发现：用户在卡上只留了 awb/shipper，agent 的回复里完全没提这件事）。
        ...(fieldChoiceSummary !== undefined ? { field_choice: fieldChoiceSummary } : {}),
        // 分组节（跑完后重读本次产物——卡面与回执同一渲染单源）
        ...(args.stage === "experiment_setup"
          ? { grouping_section: renderGroupingSection(readExperimentGrouping(runDir), fieldNameMapOf(runDir)) }
          : {}),
        // C2：分组四态回执（grouping_source／grouping_decision）＋分组表（两档都必须有，
        // agent 可原样贴到对话）＋内核判不合格时的 errors 原文
        ...(args.stage === "experiment_setup" && groupingFace !== undefined
          ? {
              grouping_source: groupingFace.source,
              grouping_decision: groupingFace.decision,
              grouping_candidate_name: groupingFace.candidate_name,
              grouping_note: groupingFace.note,
              ...(groupingFace.evidence !== null ? { grouping_evidence: groupingFace.evidence } : {}),
              ...(groupingFace.groups.length > 0
                ? { grouping_report: renderGroupingReportMarkdown(groupingFace.groups, groupingFieldNames) }
                : {}),
            }
          : {}),
        ...(groupingKernelErrors !== null ? { grouping_errors: groupingKernelErrors } : {}),
        ...(pixelPairException !== undefined ? { pixel_pair_exception: pixelPairException } : {}),
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
        ...(fieldConfigError !== null ? { field_config: fieldConfigError } : {}),
        // F14：label_qc 阻断 → 续跑指路（同 run 裁决后重跑，不得新建 run）
        ...labelQcResumeHintOf(args.stage, result.code),
      });
    },
  }) as unknown as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
  // F6：回执挂用户面三句话（user_summary）＋连续失败升级——用户不必靠 agent 转述；
  // 回执内容零改写，只增键（decorateOutcome 口径）。
  const runStage = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (args: Record<string, unknown>, exec: unknown) => {
      const receipt = await runStage(args, exec);
      const ok = !receiptIsFailure(receipt);
      const decorated = decorateOutcome(
        receipt,
        sessionIdOfExec(exec) ?? null,
        "atf_pipeline_stage",
        ok,
        stageUserSummaryOf(receipt, ok, String(args["stage"] ?? "")),
      );
      if (decorated.escalate_to_user === true) {
        const summary: UserSummary = {
          ...decorated.user_summary,
          next: "连续两次没成功——需要你介入：看一眼回执里缺的条件，或直接说要不要换做法",
        };
        decorated.user_summary = summary;
        // 升级是「必须被看见」的一条：直接进会话流（不依赖 agent 转述）
        projectUserNotice(exec as { deferContext?: (context: unknown) => void } | undefined, summary);
      }
      return decorated;
    },
  };
};
