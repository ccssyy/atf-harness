/**
 * 批⑱-M2——确认卡工具面（ui-atf-confirm 的数据与语义源）。
 *
 * atf_config_confirm：九要素训练配置确认卡——构造/改参/重呈/快照全链复用手搓
 * src/webui/configConfirm.ts（buildConfigConfirmFields/saveConfigSnapshot——逻辑零重写）。
 * 批㊶-W F5 合并版表单化（R2）：第一段改参收集＝DSH 原生问题卡 form intent 表单卡
 * （vendor patch 0003——逐键输入框＋现值预填＋clamp 域提示；结构化 key=value selected 回传，
 * 协议零改动）；第二段授权＝审批卡 Allow once（账本留痕不变）。审批卡 Reject → 回表单卡
 * （带上次值）循环；纯文字 amend 解析链退役（工具链零文字解析引用——自由文本
 * 永不直达生成面，agent 语义理解走结构化 edits 参数）。
 * atf_publish_confirm：发布确认 digest 卡（契约件 digest 凭据同构）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildConfigConfirmFields, saveConfigSnapshot, renderTokenBudgetRows, pixelPairViolationOf, READONLY_CONFIG_KEYS } from "../../../../src/webui/configConfirm.js";

/** 卡面字段（buildConfigConfirmFields 返回形态——本地结构类型；批㊶-Q 增第四态 agent_recommend，
 *  仅全自动档采纳 agent 参数推荐时由本文件后处理标注，buildConfigConfirmFields 不产出该态）。
 *  A1 导出：configFormFieldsOf／回归断言共用。 */
export type ConfigConfirmField = { key: string; value: string; tag: "need_confirm" | "from_registry" | "default_used" | "agent_recommend" };
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { appendAskFailureDiagnostic } from "./askDiagnostics.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { evalAgentRecommend, type RecommendVerdict } from "../../../../src/core/workspace/agentRecommend.js";
import { isAutoTrainingTier, AUTO_TRAINING_PRESET } from "./autoTrainingTier.js";
import {
  FIXED_SMART_DEFAULTS,
  CLAMP_DOMAINS,
  TRAINING_PIN_CONSTANTS,
  deriveGradAccum,
  clampLearningRate,
  clampEpochs,
  clampLoraRank,
  loraAlphaFor,
  clampCutoffLen,
  clampImageMaxPixels,
  clampNegativeRatio,
  checkTokenBudget,
  SMART_DEEPSPEED_DEFAULT,
  kernelBsDefaultOf,
  detectAvailableGpuCount,
  guardNprocAntiPatterns,
  defaultBaseModelPath,
} from "../../../../src/core/workspace/smartDefaults.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { legacyCandidatePath, listDocSlots } from "../../atf-ui/src/docSlots.js";
import { readLaunchKpi } from "../../../../src/core/workspace/trainingPreflight.js";
import { isValidRunId, resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";
// F1 前置预检共用交互流（循环 import 安全：两侧顶层均零执行对方导出——函数体内引用）
import { preflightScriptAvailable, runPreflightFlow, resolvePreflightRunDir, type PreflightDeps, type PreflightRunDirSource } from "./preflightFace.js";
import { openSettingsStore } from "../../../../src/webui/settings.js";
import { instanceSettingsPath } from "../../../../src/webui/storageSettings.js";

/** 批㊶-N N-5：会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};
import { asToolValue } from "./schemaTranslate.js";

/** DSH user-questions 服务消费面（结构类型——零 import；plan-mode 同款直调 ask() 通道）。
 *  批㊶-P1 S3：导出共享——atf_run_training 双启请示闸同走本通道（请示是一等工具）。 */
export interface FormAskService {
  ask(request: {
    questions: ReadonlyArray<{
      id: string;
      question: string;
      header?: string;
      detail?: string;
      intent: {
        kind: "form";
        fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>;
        submitLabel?: string;
      };
    }>;
    agent?: unknown;
    signal?: unknown;
  }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string>; custom?: string }> }>;
}

/** 表单卡问题对象单源（A1：confirmFace/trainingFace 两调用面与源面回归断言
 *  tests/dshTools/askFormIntent.test.ts 同构——intent 形态漂移即测试红）。
 *  可选键条件 spread（typert lossless 拒绝嵌套 undefined——批㊶-W 真机修正同纪律）。 */
export const formAskQuestion = (q: {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>;
  submitLabel: string;
}): {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  intent: { kind: "form"; fields: ReadonlyArray<{ key: string; label: string; value?: string; placeholder?: string; hint?: string; required?: boolean }>; submitLabel: string };
} => ({
  id: q.id,
  question: q.question,
  ...(q.header !== undefined ? { header: q.header } : {}),
  ...(q.detail !== undefined ? { detail: q.detail } : {}),
  intent: { kind: "form", fields: q.fields, submitLabel: q.submitLabel },
});

/** b5 像素对复用补丁：像素对两键卡面中文名（用户面零内部键名——指令 b5 §三；表单卡
 *  输入框 key 与结构化回传面不变，仅呈现名替换）。其余键维持键名既有形态。 */
const PIXEL_PAIR_LABELS: Record<string, string> = {
  image_min_pixels: "最小像素",
  image_max_pixels: "最大像素",
};

/** 确认卡字段 → 表单卡逐键输入行（label＝键名·现值预填·clamp 域 hint；max_total_tokens
 *  空值＝必填拦空兜底＋建议值前置（D36——参考值口径引 TRAINING_PIN_CONSTANTS 单源，
 *  批次 R H1-2 改值后建议值＝9000 惯例基线；必填拦空兜底保留——用户清空提交仍拦）。
 *  批次 R H1-1：max_model_len 只读——不生成输入框（值恒单源惯例基线，卡面三要素区只读呈现，
 *  独立取值禁 cutoff 推导）。A1：与回归断言单源。b5 像素对：两键呈现名中文化＋hint 尾
 *  来源标注（默认/用户——指令 b5 §三）。 */
/** 卡面只读行（D92 单源）：dataset_keys 不入表单输入框（READONLY_CONFIG_KEYS 过滤），
 *  实算值经只读行如实呈现——值在＝「数据集键（实算，只读）：<值>」；值缺（IterationConfig
 *  缺席/未实算）＝如实「实算值未产出」，不造占位数。 */
export const datasetKeysFaceLineOf = (fields: ReadonlyArray<{ key: string; value: string }>): string => {
  const value = (fields.find((field) => field.key === "dataset_keys")?.value ?? "").trim();
  return value === "" ? "数据集键（实算，只读）：实算值未产出（IterationConfig 缺席）" : `数据集键（实算，只读）：${value}`;
};

export const configFormFieldsOf = (fields: ConfigConfirmField[], gpuCount: number | null) =>
  fields
    // D92：只读键单源过滤（max_model_len 惯例基线＋dataset_keys 内核实算——卡上可编辑值不消费）
    .filter((field) => !READONLY_CONFIG_KEYS.has(field.key))
    .map((field) => {
    const hint = domainHintOf(field.key, gpuCount);
    const pixelPair = PIXEL_PAIR_LABELS[field.key] !== undefined;
    const sourceNote = pixelPair ? `（来源：${field.tag === "need_confirm" ? "用户" : "默认"}）` : "";
    return {
      key: field.key,
      label: PIXEL_PAIR_LABELS[field.key] ?? field.key,
      value: field.value,
      ...(hint !== undefined || sourceNote !== "" ? { hint: `${hint ?? ""}${sourceNote}` } : {}),
      ...(field.key === "max_total_tokens" && field.value.trim() === ""
        ? {
            required: true,
            placeholder: `必填——建议直接填 ${TRAINING_PIN_CONSTANTS.max_total_tokens}（单样本 token 上限，超长单据在数据构造期截断/拒绝；确认卡已核可再改）`,
          }
        : {}),
    };
  });

/** 表单卡答案 → 结构化 edits（selected 逐条 `key=value`——首个 = 拆分；结构化解析，
 *  非自由文本正则——批㊶-W F5 文字解析链退役后的唯一回传面）。 */
export const editsFromFormAnswers = (answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }): Record<string, string> => {
  const edits: Record<string, string> = {};
  for (const item of answers.answers) {
    for (const entry of item.selected) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq).trim();
      if (key !== "") edits[key] = entry.slice(eq + 1).trim();
    }
  }
  return edits;
};

/** clamp 域提示（表单卡逐键 hint——min/max 可读；数值全部单源派生零硬编码）。 */
export const domainHintOf = (key: string, gpuCount: number | null): string | undefined => {
  switch (key) {
    case "learning_rate":
      return `域 [${CLAMP_DOMAINS.lr.min.toExponential().replace("e-", "e-")}, ${CLAMP_DOMAINS.lr.max.toExponential()}]（LoRA 惯用科学计数法）`;
    case "num_train_epochs":
      return `域 [${CLAMP_DOMAINS.epochs.min}, ${CLAMP_DOMAINS.epochs.max}] 整数`;
    case "lora_rank":
      return `档位 {${CLAMP_DOMAINS.lora_rank.join(", ")}}（alpha=2×rank 联动）`;
    case "cutoff_len":
      // 批次 R H1-1：TokenBudget 口径——cutoff 只在训练时生效且会截断（禁当数据筛选阈值）；
      // 变更须与预算同步（等值）或填不同步理由（预算 ≤ cutoff 不变式由 checkTokenBudget 拦）。
      return `≤ ${CLAMP_DOMAINS.cutoff_len.max}；训练截断——须与 max_total_tokens 同步（等值）或填不同步理由（预算超过 cutoff 会禁确认）`;
    case "max_model_len":
      return `只读＝${TRAINING_PIN_CONSTANTS.max_model_len}（推理窗口，独立取值——禁由 cutoff 推导）`;
    case "image_min_pixels":
      // b5 像素对复用补丁：下限域提示（默认单源 TRAINING_PIN_CONSTANTS——不新写域）。
      return `正整数，默认 ${TRAINING_PIN_CONSTANTS.image_min_pixels.toLocaleString("en-US")}（256²）——构造/训练/推理同一对值`;
    case "image_max_pixels":
      // b5 像素对复用补丁：两档闭集沿用＋变更影响提示（指令 b5 §三——提示不阻塞）。
      return `两档 {${(CLAMP_DOMAINS.image_max_pixels as number[]).map((v) => v.toLocaleString("en-US")).join(", ")}}；改后将影响坐标换算与 token 预算（不阻塞，可清空恢复默认）`;
    case "per_device_train_batch_size":
      // E4-乙（改动 2）：卡面 bs 缺省＝内核缺省分档（convention——cutoff<10000→2，否则 1；
      // kernelBsDefaultOf 单源，与 training_overrides 桥同源；删 `?? 2` 硬编码）。
      return "正整数；默认＝内核缺省（convention：cutoff<10000→2，≥10000→1）";
    case "negative_ratio_target":
      return `构造带 [${CLAMP_DOMAINS.negative_ratio.min}, ${CLAMP_DOMAINS.negative_ratio.max}]`;
    case "nproc_per_node":
      return gpuCount !== null ? `[1, 可用卡数 ${gpuCount}]` : "须为本机可用卡数内（机器事实）";
    case "visible_devices":
      // D76 卡位入卡：域提示与内核侧键语义逐字一致（逗号/a-b 段、0–7、个数=nproc；留空回退 deploy）。
      return "逗号分隔卡号或 a-b 区间（如 4,5,6,7 或 4-7）；卡号 0–7、不重复；个数须与训练卡数一致；留空＝全部可见卡（deploy 缺省）";
    case "max_total_tokens":
      // 批次 R H1-2：建议值单源 9000（惯例基线 owner 2026-10-22——65536 域参考值退役）。
      return `正整数；建议 ${TRAINING_PIN_CONSTANTS.max_total_tokens}（单样本 token 上限，超长单据构造期截断/拒绝；与 cutoff/max_model_len 的关系由三要素校验拦）`;
    default:
      return undefined;
  }
};

/** 批次 R H1-1：fields → TokenBudget 三值校验（服务端闸单源入口——手动档表单卡循环与
 *  自动档落快照前共用；violations 非空＝禁确认）。 */
export const tokenBudgetCheckOf = (
  fields: ReadonlyArray<ConfigConfirmField>,
  syncReason: string,
): { violations: string[]; needsSync: boolean } =>
  checkTokenBudget(
    {
      maxTotalTokens: fields.find((f) => f.key === "max_total_tokens")?.value,
      cutoffLen: fields.find((f) => f.key === "cutoff_len")?.value,
      maxModelLen: fields.find((f) => f.key === "max_model_len")?.value,
    },
    { syncReason },
  );

// ── D76 卡位入卡（指令《ATF_指令_D76_卡位入卡_20261023》§二 harness 1/2）──
// 键名/校验语义与内核侧 generate_iteration_config 的 visible_devices 逐字一致
// （逗号分隔整数或 a-b 段、元素 0–7、不重复、个数须等于 nproc_per_node）；
// 卡前拒绝一律业务语言红字，不得出现 visible_devices_nproc_mismatch 等码原文（§四红线）。

/** 卡位卡前校验（卡前红字单源——手动档表单卡循环与自动档落快照前共用）。
 *  留空＝全部可见卡（回退 deploy 缺省，不校验）。返回红字行（业务语言）；空数组＝通过。 */
export const visibleDevicesViolationsOf = (
  fields: ReadonlyArray<{ key: string; value: string }>,
): string[] => {
  const raw = (fields.find((f) => f.key === "visible_devices")?.value ?? "").trim();
  if (raw === "") return [];
  const shapeNote = "卡位形态不对——应为逗号分隔卡号或 a-b 区间（如 4,5,6,7 或 4-7），每张卡最多出现一次";
  const ids: number[] = [];
  for (const token of raw.split(",").map((t) => t.trim()).filter((t) => t !== "")) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range !== null) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [shapeNote];
      for (let i = lo; i <= hi; i++) ids.push(i);
      continue;
    }
    if (!/^\d+$/.test(token)) return [shapeNote];
    ids.push(Number(token));
  }
  const outOfRange = [...new Set(ids.filter((id) => id < 0 || id > 7))];
  if (outOfRange.length > 0) return [`卡位含本机不存在的卡号 ${outOfRange.join("、")}——可用卡号为 0–7`];
  const duplicated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicated.length > 0) return [`卡位有重复卡号 ${duplicated.join("、")}——每张卡只能出现一次`];
  const nprocRaw = (fields.find((f) => f.key === "nproc_per_node")?.value ?? "").trim();
  const nprocNum = Number(nprocRaw);
  if (nprocRaw !== "" && Number.isFinite(nprocNum) && nprocNum > 0 && ids.length !== nprocNum) {
    return [`卡位个数（${String(ids.length)} 张：${raw}）与训练卡数 nproc_per_node（${String(nprocNum)}）不一致——两者须相等，请改齐后提交`];
  }
  return [];
};

/** 确认字段 → 快照 confirmed（D76：卡位留空＝全部可见卡，空值不落快照——禁空串覆盖
 *  deploy 的 cuda_visible_devices 缺省；手动档/自动档落盘共用单源）。 */
export const confirmedSnapshotOf = (fields: ReadonlyArray<ConfigConfirmField>): Record<string, string> => {
  const confirmed: Record<string, string> = {};
  for (const field of fields) {
    if (field.key === "visible_devices" && field.value.trim() === "") continue;
    confirmed[field.key] = field.value;
  }
  return confirmed;
};

/** TokenBudget 三要素区文本（表单卡 detail / pending 卡 / 审批卡 reason 共用单源——
 *  三行呈现＋violations 红字行）。 */
export const tokenBudgetFaceText = (
  fields: ReadonlyArray<ConfigConfirmField>,
  violations: readonly string[],
): string => [
  "TokenBudget（三要素）:",
  ...renderTokenBudgetRows(fields),
  ...(violations.length > 0 ? violations.map((v) => `⚠ ${v}`) : []),
].join("\n");

/** b5 像素对复用补丁：max 变更提示（不阻塞——指令 b5 §三；基线缺省＝惯例档位首值，
 *  与 CONFIG_CONFIRM_KEYS default 同源）。 */
export const pixelPairChangeNoteOf = (
  fields: ReadonlyArray<ConfigConfirmField>,
  baseline: Record<string, string>,
): string | undefined => {
  const maxField = fields.find((f) => f.key === "image_max_pixels");
  if (maxField === undefined) return undefined;
  const before = baseline["image_max_pixels"] ?? String(TRAINING_PIN_CONSTANTS.image_max_pixels[0]);
  return before === maxField.value ? undefined : "最大像素已变更——将影响坐标换算与 token 预算（不阻塞，可清空恢复默认）";
};

/** b5 像素对复用补丁：min<max 关系警示（判据单源 configConfirm pixelPairViolationOf——只提示不阻塞）。 */
export const pixelPairViolationNoteOf = (fields: ReadonlyArray<ConfigConfirmField>): string | undefined => {
  const violation = pixelPairViolationOf(fields.map((f) => ({ key: f.key, value: f.value })));
  return violation === null ? undefined : `⚠ ${violation}`;
};

/** 三态标记（卡面文本化：⚠ 已用缺省／◆ 来自登记／? 需确认——与手搓批⑮三态标签同源语义）。
 *  批㊶-Q 增第四态：◇ agent 推荐（全自动档采纳的 agent 参数推荐——来源标注进 sources/通报）。 */
const TAG_MARK: Record<ConfigConfirmField["tag"], string> = {
  default_used: "已用缺省 ⚠",
  from_registry: "来自登记 ◆",
  need_confirm: "需确认 ?",
  agent_recommend: "agent 推荐 ◇",
};

const renderFields = (fields: ConfigConfirmField[]): string =>
  fields.map((field) => `  ${field.key}: ${field.value}（${TAG_MARK[field.tag]}）`).join("\n");

const cardBlocks = (title: string, fields: ConfigConfirmField[], note: string) => [
  { type: "text" as const, text: `${title}\n${renderFields(fields)}\n${note}` },
];

interface ConfirmDeps {
  runsRoot: string;
  ctx: { get(service: string): unknown };
  /** 批㊶R前置：可用卡数探测注入（vitest 假件；缺省＝真实机器事实通道 nvidia-smi/CUDA_VISIBLE_DEVICES）。 */
  gpuProbe?: () => number | null;
  /** F1：前置预检装配（九要素卡前先出预检卡；缺席＝不出预检卡，九要素链现状语义）。 */
  preflight?: PreflightDeps;
}

/** pending 卡落盘（刷新重建源：<runDir>/webui/pending-confirm.json——runDir 双形态解析归调用方）。 */
const writePending = (runDir: string, payload: Record<string, unknown>): void => {
  const dir = join(runDir, "webui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pending-confirm.json"), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
};

/** 批㊶Q增补二3：pending 卡清理（确认/放行完成后——备份先行改名 .answered.<毫秒戳>.json，
 *  审计留存；文件缺席/改名失败静默 fail-open）。残留实证：P 批 run-regress-large-pl 确认
 *  完成后卡文件留存 8h＋，UI 持续渲染待确认态。批㊶Q增补三段4.2：存量残留在同步器侧
 *  sweepAnsweredPendings 兜底（完成证据判据），本函数只管本 run 完成即清。 */
const clearPending = (runDir: string): void => {
  try {
    const path = join(runDir, "webui", "pending-confirm.json");
    if (!existsSync(path)) return;
    renameSync(path, `${path}.answered.${Date.now()}.json`);
  } catch { /* fail-open */ }
};


/** 批㊶-U §五：双段式共用 helper（问题卡收改参→amend 校验 clamp 重呈→审批卡落闸）。
 *  四张确认卡统一复用（九要素/评估 EVAL_RELEASE/凭据卡退化/S1 publish_model 随后）——
 *  禁每卡手搓。批㊶-W F5：第一段指引改表单卡语义（改参在表单卡改值提交；纯文字应答
 *  通道退役）；第二段授权仍走审批卡 Allow once（账本留痕不变）。凭据卡（amendable=false）
 *  退化形式：仅统一卡面说明＋复核通道，不虚构可调参数（诚实呈现原则）。 */
export const dualStageNote = (cardLabel: string, opts?: { amendable?: boolean; amendNote?: string; extra?: string }): string => {
  const amendable = opts?.amendable !== false;
  const head = amendable
    ? `${cardLabel}（双段式：改参在表单卡改值提交；不改直接提交表单，再于审批卡点 Allow once）`
    : `${cardLabel}（凭据确认卡：无可调参数；如对凭据有疑义请回复说明，复核通道＝聊天重呈）`;
  const tail = [opts?.amendNote, opts?.extra].filter((x): x is string => typeof x === "string" && x !== "");
  return [head, ...tail].join("｜");
};

/** 批㊶-S1 门2修复：atf_bash 围栏可写根注入（run 绑定处写入——随 run 切换更新；
 *  进程级 env last-write-wins，并发会话互踩局限执行报告如实登记）。 */
export const injectBashRunWorkspace = (runDir: string): void => {
  process.env["ATF_BASH_RUN_WORKSPACE"] = runDir;
};

// ── E3（缺口 D）：confirm 写面 run 落点三级单源（同源复用 preflightFace E2 解析器）──

/** 写面落点解析（config_confirm／publish_confirm 共用）：与只读预检同一三级序
 *  （workspace_path 显式 > 会话工作区事实 > 实例 runsRoot 兜底——resolvePreflightRunDir
 *  同一决定者），差别仅在「目录不存在」：预检只读拒之；本面是建卡/确认写面——显式
 *  workspace_path 给定时在显式落点创建 run 目录（非法 runId 拒——路径穿越不进创建面），
 *  未给时按现行 resolveRunDir 桶落点新建（writePending/saveConfigSnapshot 落点一致，
 *  新建 run 现状零破坏）。非绝对路径与 symlink 与预检同拒（红线：确认值永不落镜像位）。
 *  效果：九要素确认快照/pending/段事实/会话绑定与内核 training_prep 读点同棵树。 */
export const resolveConfirmRunDir = (
  deps: ConfirmDeps,
  runId: string,
  workspacePath: string | undefined,
  exec: unknown,
): { ok: true; runDir: string; source: PreflightRunDirSource } | { ok: false; error: string; note: string } => {
  const wp = typeof workspacePath === "string" ? workspacePath.trim() : "";
  const resolved = resolvePreflightRunDir(
    { command: "", timeoutMs: 0, runsRoot: deps.runsRoot, ctx: deps.ctx },
    { runId, apply: false, workspacePath: wp !== "" ? wp : undefined },
    exec,
  );
  if (resolved.ok) return { ok: true, runDir: resolved.runDir, source: resolved.source };
  if (resolved.error === "run_dir_not_found") {
    if (wp !== "") {
      if (!isValidRunId(runId)) {
        return { ok: false, error: "run_id_invalid", note: `run_id 形态非法（${runId}）——拒绝在显式落点创建 run 目录` };
      }
      const runDir = join(wp, "runs", runId);
      try {
        mkdirSync(runDir, { recursive: true });
        return { ok: true, runDir, source: "workspace_path" };
      } catch (cause) {
        return { ok: false, error: "run_dir_create_failed", note: `显式落点 run 目录创建失败（${runDir}）：${String(cause).slice(0, 200)}` };
      }
    }
    // 新建 run 现状形态：实例 runsRoot 桶落点（writePending 落点 mkdir——零破坏）
    return { ok: true, runDir: resolveRunDir(deps.runsRoot, runId, { workspace: sessionWorkspaceSlug(exec) }), source: "instance_runs_root" };
  }
  return { ok: false, error: resolved.error, note: resolved.note };
};

export const buildConfirmTools = (deps: ConfirmDeps): unknown[] => {
  const { ctx } = deps;
  // 批㊶R前置②：可用卡数机器事实（建卡期一次探测；null＝缺失→建卡时按 machine-facts 停下问）
  const gpuCount = detectAvailableGpuCount(process.env, deps.gpuProbe);
  // A-C3b E11：QLoRA 形态单源＝FIXED_SMART_DEFAULTS（quantization_bit=4 × method=bnb——
  // 确认卡链 L1 固定缺省，卡面无量化键、形态不经卡改）；仅作护栏判据输入，阈值与拒绝面留在内核。
  const qloraActive = FIXED_SMART_DEFAULTS["quantization_bit"] === "4" && FIXED_SMART_DEFAULTS["quantization_method"] === "bnb";

  const configTool = defineTool({
    name: "atf_config_confirm",
    description:
      "九要素训练配置确认卡：action=present 构造/重呈九要素卡（overrides 传显式覆盖值）；action=amend 应用结构化改参（edits 传键值对象）后重呈。合并版双段式编排（present/amend 同链）：第一段改参收集——工具内部直接以 DSH 原生问题卡 form intent 表单卡向用户呈确认键逐键输入框（现值预填＋clamp 域提示；max_model_len 只读不入输入框——批次 R H1-1 三要素区只读呈现），卡面附 TokenBudget 三要素区（预算/训练截断/推理窗口三行＋两条不变式校验：预算超 cutoff 或超 max_model_len 即红字禁确认；预算与 cutoff 不等须同步（用户动作不自动）或填不同步理由），用户改值/直接提交即回结构化 key=value；第二段授权——有改动走确定性 clamp（越界回退域边界＋可读说明），最终授权一律走审批卡 Allow once（账本留痕不变）；审批卡 Reject → 回表单卡（带上次值）循环，用户关闭表单卡＝取消（结构化拒绝）。问题卡只收集改参、不承载授权（审批≠请示，闸门语义不迁移）；用户在聊天里的改参话术由 agent 语义理解后转 edits 结构化参数（自由文本永不直达生成面）。现值基线＝已确认快照＞run 的 IterationConfig 实值（prep/iteration-config——登记源，卡面与 Web 摘要同源）＞缺省。手动档（权限档）：审批面板 Allow once 确认后 config-snapshot 落盘。全自动训练档（会话档位=auto_training，经界面人工切换）：present 免审批——以智能缺省（L3 clamp 建议＋L2 派生）＋agent 参数推荐直接落快照，卡面内容转为通报（告警行＋alerts.json，每键取值＋来源标注可回看）；改参仍走 amend（同样免阻塞）。" +
      "全自动档 agent 参数推荐（recommend 参数，本档专属）：训练提交前基于任务描述＋数据集统计（样本数/长度分布/模态）＋经验锚点给出 epochs/lr/rank/cutoff/负样本带推荐值并附 reason（理由）。经验锚点（owner 手工训练经验，参考知识非硬规则）：样本 2万–3万 → 3 epochs；4万以上 → 2 epochs；小样本（<1万）宜多轮并防过拟合（配早停观察）。护栏：epochs∈[1,10] 整数、lr∈[5e-5,5e-4]、lora_rank∈{16,32,64,128}（alpha=2×rank 联动）、cutoff≤12800、像素两档∈{802816,1605632}（单源）、负样本构造带∈[0.02,0.05]（F2 R1 终裁——空对象构造配额）、bs 正整数、nproc∈[1,可用卡数]——越界推荐被拦截并回退固定建议（不静默修正），拦截事实进通报；推荐缺失同样回退。lora_alpha 不单独推荐（随 rank 联动）。" +
      "基模型锚点（owner 裁定 2026-10-12 §九）：确认卡基模型字段默认值＝模型库位置下的 Qwen3-VL-32B-Instruct（owner 偏置锚点，非查表推导；卡上可改，改动经防线①本地复核）。评估侧继续锚定 -AWQ 变体（现状不变）。" +
      "卡数偏置（owner 裁定 2026-10-11）：训练卡数默认拉满本机可用卡（nproc_per_node=机器事实可用卡数），训练时长优先；代价（显存/时长）如实呈现给用户，不作降档依据；降档仅在用户任务上下文明确要求时采纳。卡数维度无成文锚点——不编造「数据规模→卡数」映射、不查表推荐，卡数只来自机器事实与用户显式要求；自动档默认低于可用卡的 nproc 推荐会被护栏回退拉满。",
    parameters: {
      action: { type: "string", required: true, enum: ["present", "amend"], description: "present=构造/重呈卡；amend=应用结构化改参后重呈（edits 键值对象）" },
      run_id: { type: "string", required: true, description: "run 标识（快照与 pending 卡落点）" },
      workspace_path: { type: "string", description: "workspace 根（绝对路径——与 atf_pipeline_stage 的 workspace_path 同值；落点 <workspace_path>/runs/<run_id>，未传时按会话工作区事实与实例 runs 根顺次解析——快照/段事实与内核读取同棵树）" },
      overrides: { type: "object", additionalProperties: true, description: "显式覆盖值（present 形态：{learning_rate:\"2e-4\",...}）" },
      edits: { type: "object", additionalProperties: true, description: "amend 结构化改参（用户聊天话术经 agent 语义理解后的键值对象，如 {num_train_epochs:\"4\", learning_rate:\"2e-4\"}）——clamp 校验后随表单卡重呈双确认" },
      recommend: { type: "object", additionalProperties: true, description: "全自动档专属 agent 参数推荐：{epochs:3, learning_rate:\"2e-4\", lora_rank:32, cutoff_len:9000, reason:\"2.8万样本→3 epochs 防欠拟合\"}——越界键被拦截回退，手动档不消费" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    presentCall: function(args: { action: string; run_id: string }) {
      // pending 态卡面——九要素确认标题（具体 fields 在 execute 中构造后经 content 呈现）
      return {
        card: "generic" as const,
        title: args.action === "amend" ? `参数变更请示（仅改动项）— ${args.run_id}` : `九要素训练配置确认 — ${args.run_id}`,
        kind: "other" as const,
      }
    },
    async execute(args: { action: "present" | "amend"; run_id: string; workspace_path?: string; overrides?: Record<string, unknown>; edits?: Record<string, unknown>; recommend?: Record<string, unknown> }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // E3（缺口 D）：run 落点三级单源（workspace_path 显式 > 会话工作区事实 > 实例
      // runsRoot 兜底——preflightFace E2 同一解析器，写面语义见 resolveConfirmRunDir）；
      // 快照/pending/段事实/会话绑定/KPI 全落同一棵树——九要素确认值经此与内核读点同源。
      const resolvedRun = resolveConfirmRunDir(deps, args.run_id, args.workspace_path, exec);
      if (!resolvedRun.ok) {
        return asToolValue({ ok: false, run_id: args.run_id, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      const runDirSource = resolvedRun.source;
      // F1（首跑体验批）§二.2：九要素卡之前先出「首跑预检卡」——顺序机制保证：
      // preflight KPI 事实缺席且预检脚本在场时先跑预检（有问题项才出卡：needs_confirm
      // 合并一屏收集；derivable 项卡上可勾选 apply_derivables，经审批卡放行后内核
      // --apply 执行）。全绿只记 KPI 零介入；全自动训练档免阻塞不出卡（清单进返回体）；
      // 脚本缺席/预检失败＝跳过（九要素链现状零回归——pin 未含脚本过渡态）。预检不
      // 替代各段校验、不阻塞本卡（用户取消预检卡也继续九要素链）；KPI 首写固定天然
      // 幂等（amend 重呈不重跑预检）。
      let preflightNote: string | undefined;
      if (
        deps.preflight !== undefined &&
        readLaunchKpi(runDir)?.preflight === undefined &&
        preflightScriptAvailable(deps.preflight.command)
      ) {
        const outcome = await runPreflightFlow(deps.preflight, { runId: args.run_id, apply: false, workspacePath: args.workspace_path }, exec, {
          presentCard: !isAutoTrainingTier(ctx, exec),
        });
        if (outcome.ok && outcome.report !== undefined && outcome.report.items.length > 0) {
          preflightNote = [
            outcome.checklist ?? "",
            ...(outcome.decisions !== undefined ? [`预检确认决策（请转后续段参数）：${JSON.stringify(outcome.decisions)}`] : []),
          ].filter((line) => line !== "").join("\n");
        }
      }
      // 现值基线：已确认快照（不重问）→ run 的 IterationConfig 实值（批㉛段2：登记源，确认卡
      // 与 Web 摘要同源——deepspeed 等实值不再落回泛化缺省）→ pending 卡现值 → 缺省
      const snapshotPath = join(runDir, "webui", "config-snapshot.json");
      // saveConfigSnapshot 形态＝{schema_version, confirmed}——基线取 confirmed 子对象
      // （批㉛段2 修正：原实现整文件映射，快照确认值从未真正入卡基线）
      const snapshot = (() => {
        if (!existsSync(snapshotPath)) return {} as Record<string, string>;
        try {
          const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as { confirmed?: Record<string, string> };
          return parsed.confirmed ?? ({} as Record<string, string>);
        } catch {
          return {} as Record<string, string>;
        }
      })();
      const iterPath = join(runDir, "prep", "iteration-config", "iteration-config.json");
      let iterTraining: Record<string, string> = {};
      if (existsSync(iterPath)) {
        try {
          const iter = JSON.parse(readFileSync(iterPath, "utf8")) as { training?: Record<string, unknown>; dataset?: Record<string, unknown> };
          if (iter.training !== undefined && iter.training !== null && typeof iter.training === "object") {
            for (const [key, value] of Object.entries(iter.training)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") iterTraining[key] = String(value);
            }
          }
          // D92：dataset_keys 内核实算值随 training 段一并展平入 baseline（单源＝IterationConfig
          // dataset 段——baseline→from_registry 通道把实算值带上卡面只读行；占位推导文案退役）
          const datasetKeys = iter.dataset?.["dataset_keys"];
          if (Array.isArray(datasetKeys) && datasetKeys.every((key) => typeof key === "string")) {
            iterTraining["dataset_keys"] = (datasetKeys as string[]).join("、");
          }
        } catch {
          iterTraining = {};
        }
      }
      // 批㊶-P P-1：三层智能缺省组装——
      //   L3 模型建议值（iteration-config 建议）经 harness clamp（epochs/lr/rank/cutoff/像素）；
      //   L2 派生（global_batch=256 目标 → accum 派生；deepspeed 缺省切 ds_z3_offload）；
      //   L1 固定智能缺省（用户不感知——确认卡不展开，落 train.sh 生成面）。
      // 保守缺省（bs1/accum8）仅作建议值缺失时兜底——链路级修正（bl run bs2/accum8/128 被打回
      // bs1/accum1/8 的根因＝实验门 train 段空时 TRAINING_REQUIRED_KEY_DEFAULTS 直落）。
      const L3_CLAMPERS: Record<string, (raw: string | number) => string | number> = {
        learning_rate: clampLearningRate,
        num_train_epochs: clampEpochs,
        lora_rank: clampLoraRank,
        cutoff_len: clampCutoffLen,
        image_max_pixels: clampImageMaxPixels,
      };
      for (const key of Object.keys(iterTraining)) {
        const clamp = L3_CLAMPERS[key];
        const rawValue = iterTraining[key];
        if (clamp !== undefined && rawValue !== undefined) iterTraining[key] = String(clamp(rawValue));
      }
      if (iterTraining["lora_rank"] !== undefined) iterTraining["lora_alpha"] = String(loraAlphaFor(Number(iterTraining["lora_rank"])));
      const baseline = { ...iterTraining, ...snapshot };
      const rawOverrides = (args.overrides ?? {}) as Record<string, unknown>;
      const overrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawOverrides)) overrides[key] = String(value);
      // H7b：overrides 路径同样联动 alpha=2×rank（此前只有 iteration 建议值那条路联动）
      if (overrides["lora_rank"] !== undefined) {
        overrides["lora_alpha"] = String(loraAlphaFor(Number(overrides["lora_rank"])));
      }
      // H7a：overrides 也走同一道形状校验（此前 clamp 只作用于 iteration 建议值，
      // 导致 image_min_pixels=802816 与 max_total_tokens>cutoff 能直接进卡）
      if (overrides["image_min_pixels"] !== undefined && overrides["image_min_pixels"].trim() !== "65536") {
        return asToolValue({
          ok: false, error: "image_min_pixels_fixed", run_id: args.run_id,
          value: overrides["image_min_pixels"],
          note: "像素下限固定 65536（数据构造/训练/评估同一像素对），不接受改动；只可改上限（image_max_pixels）",
        });
      }
      if (overrides["max_total_tokens"] !== undefined && overrides["cutoff_len"] !== undefined
        && Number(overrides["max_total_tokens"]) > Number(overrides["cutoff_len"])) {
        return asToolValue({
          ok: false, error: "max_total_tokens_exceeds_cutoff", run_id: args.run_id,
          max_total_tokens: overrides["max_total_tokens"], cutoff_len: overrides["cutoff_len"],
          note: "总预算不得超过单条截断长度（cutoff_len）——两者是上下界关系，请先调 cutoff_len 或压低预算",
        });
      }
      let amendNote: string | undefined;
      let amended: Record<string, string> | undefined;
      // 批㊶-W F5：结构化值域 clamp 表（amend edits 与表单卡提交共用——文字解析链退役，
      // clamp 只认结构化值；负样本构造带 F2 入表）。
      const STRUCTURED_CLAMPERS: Record<string, (raw: string | number) => string | number> = {
        learning_rate: clampLearningRate,
        num_train_epochs: clampEpochs,
        lora_rank: clampLoraRank,
        cutoff_len: clampCutoffLen,
        image_max_pixels: clampImageMaxPixels,
        negative_ratio_target: clampNegativeRatio,
      };
      const clampEdits = (edits: Record<string, string>): string[] => {
        const clampedKeys: string[] = [];
        for (const [key, rawValue] of Object.entries(edits)) {
          const clamp = STRUCTURED_CLAMPERS[key];
          if (clamp === undefined) continue;
          const clamped = String(clamp(rawValue));
          if (clamped !== String(rawValue).trim()) {
            edits[key] = clamped;
            clampedKeys.push(`${key}=${String(rawValue).trim()}→${clamped}`);
          }
        }
        return clampedKeys;
      };
      if (args.action === "amend") {
        // 批㊶-W F5：结构化 amend——edits 键值对象（用户聊天话术经 agent 语义理解后转入）；
        // 自由文本解析链退役（自由文本永不直达生成面）。
        const rawEdits = (args.edits ?? {}) as Record<string, unknown>;
        if (Object.keys(rawEdits).length === 0) {
          return asToolValue({ ok: false, run_id: args.run_id, note: "amend 需结构化 edits（键值对象，如 {\"num_train_epochs\":\"4\",\"learning_rate\":\"2e-4\"}）——请把用户改参话术转成具体键值后传入；自由文本不再解析（表单化）" });
        }
        amended = {};
        for (const [key, value] of Object.entries(rawEdits)) amended[key] = String(value);
        // 改参值一律过确定性护栏（同 L3 clamp 域）——越界回退到域边界＋说明可读（不静默）
        const clampedKeys = clampEdits(amended);
        amendNote = `已提交变更请示：${Object.keys(amended).join(", ")}；其余按现值${clampedKeys.length > 0 ? `；越界拦截回退（域边界）：${clampedKeys.join("、")}` : ""}`;
      }
      // 批㊶R前置②：卡数基线＝机器事实拉满（owner 裁定：训练默认拉满可用卡·训练时长优先）——
      // iteration-config/快照显式值（from_registry）优先保留；用户显式覆盖（overrides/amend）
      // 次之且可低于机器事实（降档仅用户明确要求）；两者皆缺且机器事实缺失＝machine-facts
      // 停下问（不设默认值——指令硬约束）
      // 批㊶-S5 §九：基模型路径基线（默认锚点＝模型库位置下 Qwen3-VL-32B-Instruct——owner 偏置，
      // 卡上可改；模型库未配置则不注入、字段走空缺省需确认）
      if (baseline["base_model_path"] === undefined) {
        const anchor = defaultBaseModelPath(process.env);
        if (anchor !== null) baseline["base_model_path"] = anchor;
      }
      // 批㊶-S5 门2修复①：训练卡数基线取值链——设置面五字段块 train_gpu_baseline ＞
      // 未配置回退探测拉满（gpuCount）＞ 机器事实缺失停下问（§二③语义；确认卡仍逐次可改）
      const settingsBaseline: string | null = ((): string | null => {
        try {
          const raw = openSettingsStore(instanceSettingsPath(process.env)).get().storage.train_gpu_baseline.trim();
          return raw !== "" && Number.isFinite(Number(raw)) && Number(raw) > 0 ? raw : null;
        } catch {
          return null;
        }
      })();
      const explicitNproc = overrides["nproc_per_node"] ?? amended?.["nproc_per_node"];
      if (baseline["nproc_per_node"] === undefined && explicitNproc === undefined) {
        if (settingsBaseline !== null) {
          baseline["nproc_per_node"] = settingsBaseline;
        } else if (gpuCount === null) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "machine_facts_missing", note: "训练卡数基线不可得：visible_devices（CUDA_VISIBLE_DEVICES）与 nvidia-smi 皆未提供可用卡数——停下问用户，不设默认值" });
        } else {
          baseline["nproc_per_node"] = String(gpuCount);
        }
      }
      // E4-乙（改动 2）：bs 卡面缺省＝内核缺省分档单源（kernelBsDefaultOf——cutoff<10000→2；
      // 删 `?? 2` 硬编码，与 training_overrides 桥 convention 同源）；注入态标 convention
      // （表单卡 hint 与自动档快照 sources 呈现——「缺省不静默」）。
      const bsConventionInjected = baseline["per_device_train_batch_size"] === undefined;
      if (bsConventionInjected) {
        const cutoffRaw = Number(baseline["cutoff_len"]);
        baseline["per_device_train_batch_size"] = String(kernelBsDefaultOf(Number.isFinite(cutoffRaw) && cutoffRaw > 0 ? cutoffRaw : undefined));
      }
      // L2 派生（bs×nproc 除尽 256 校验——除不尽/矛盾即停点问题串；nproc 用基线/显式卡数非静态缺省）
      const bsNum = Number(baseline["per_device_train_batch_size"]);
      const nprocNum = Number(baseline["nproc_per_node"] ?? explicitNproc);
      if (!Number.isFinite(nprocNum) || nprocNum <= 0) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "nproc_invalid", note: `nproc_per_node 现值（${baseline["nproc_per_node"] ?? explicitNproc}）非正整数——停下核实，不猜测` });
      }
      const accumDerived = deriveGradAccum(Number.isFinite(bsNum) && bsNum > 0 ? bsNum : kernelBsDefaultOf(undefined), nprocNum);
      if ("error" in accumDerived) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: accumDerived.error });
      }
      // H7g：派生只填空缺——用户显式给了 accum 就不派生（今天实测：卡上 2 落盘 16）
      if (overrides["gradient_accumulation_steps"] === undefined) {
        baseline["gradient_accumulation_steps"] = String(accumDerived.accum);
      }
      // P-1c：deepspeed 智能缺省＝ds_z3_offload（显式 > 缺省——iteration-config 显式声明优先）
      if (baseline["deepspeed"] === undefined) baseline["deepspeed"] = SMART_DEEPSPEED_DEFAULT;
      let fields: ConfigConfirmField[] = (() => {
        if (amended === undefined) return buildConfigConfirmFields(overrides, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        // 改参重呈：现值基线保持原三态，仅应答改动项升 need_confirm（值替换）
        const base = buildConfigConfirmFields({}, { fromRegistry: Object.keys(baseline).length > 0 ? baseline : undefined });
        return base.map((field) => (amended[field.key] !== undefined ? { key: field.key, value: String(amended[field.key]), tag: "need_confirm" as const } : field));
      })();
      // 批㊶-Q 段2：全自动档分支——档位=auto_training 时不调用 requestApproval 阻塞，
      // 以智能缺省（L3 clamp 建议＋L2 派生）＋agent 参数推荐（护栏校验）直接落 config-snapshot，
      // 卡面内容转为通报（告警行＋alerts.json，含每键取值＋来源标注）。手动档行为零变化。
      const autoTier = isAutoTrainingTier(ctx, exec);
      const recommendReport: RecommendVerdict[] = [];
      const reason = (() => {
        const rawRecommend = (args.recommend ?? {}) as Record<string, unknown>;
        return typeof rawRecommend["reason"] === "string" ? rawRecommend["reason"] : undefined;
      })();
      if (autoTier && args.action !== "amend") {
        const rawRecommend = (args.recommend ?? {}) as Record<string, unknown>;
        const baselineByKey = new Map(fields.map((field) => [field.key, field.value]));
        for (const [key, value] of Object.entries(rawRecommend)) {
          if (key === "reason") continue;
          const baselineValue = baselineByKey.get(key) ?? "";
          const verdict = evalAgentRecommend(key, value, baselineValue, reason, { maxNproc: gpuCount });
          recommendReport.push(verdict);
          if (verdict.accepted) {
            const field = fields.find((f) => f.key === key);
            if (field !== undefined) {
              field.value = verdict.terminal;
              field.tag = "agent_recommend";
            }
            // alpha 随 rank 联动（确定性，非判断）：rank 推荐被采纳 → alpha=2×rank 同标 agent 推荐
            if (key === "lora_rank") {
              const alphaField = fields.find((f) => f.key === "lora_alpha");
              if (alphaField !== undefined) {
                alphaField.value = String(loraAlphaFor(Number(verdict.terminal)));
                alphaField.tag = "agent_recommend";
                recommendReport.push({ key: "lora_alpha", accepted: true, terminal: alphaField.value, source: verdict.source, note: `alpha 随 rank=${verdict.terminal} 联动（2×rank）` });
              }
            }
          }
        }
        // bs 被推荐改动 → accum 重派生（L2 整除校验，除不尽即停点问题串，禁静默取整）
        const bsField = fields.find((f) => f.key === "per_device_train_batch_size");
        const baselineBs = String(baseline["per_device_train_batch_size"] ?? "");
        if (bsField !== undefined && bsField.value !== baselineBs) {
          const bsNumNew = Number(bsField.value);
          if (!Number.isFinite(bsNumNew) || bsNumNew <= 0 || !Number.isInteger(bsNumNew)) {
            return asToolValue({ ok: false, run_id: args.run_id, error: "recommend_bs_invalid", note: `推荐 bs=${bsField.value} 不是正整数——拦截，未落快照` });
          }
          const reDerived = deriveGradAccum(bsNumNew);
          if ("error" in reDerived) {
            return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: reDerived.error });
          }
          const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
          if (accumField !== undefined) {
            accumField.value = String(reDerived.accum);
            accumField.tag = "agent_recommend";
            recommendReport.push({ key: "gradient_accumulation_steps", accepted: true, terminal: String(reDerived.accum), source: "default:harness-smart-defaults", note: `accum 随 bs=${bsField.value} 派生（gb=${reDerived.globalBatch} 不变）` });
          }
        }
      }
      // 批㊶R前置④：反模式拦截（确定性——建卡时；本 fields 即生效配置输入，拦截先于卡面/快照）
      //   A（A-C3b E11）：单卡×任意 deepspeed×bnb_4bit → 非用户显式回退可用卡数＋note；
      //   用户显式（need_confirm）不回退不改值，conflicts 冲突原文标注上卡面/回执，内核拒；
      //   B. 超机器事实上限/非用户显式低配 → 回退拉满（need_confirm＝用户显式降档放行）；
      //   回退后 accum 随卡数重派生（整除校验不过即停点）。
      const guardResult = guardNprocAntiPatterns(fields, { gpuCount, baselineNproc: settingsBaseline, qlora: qloraActive });
      if ("error" in guardResult) {
        return asToolValue({ ok: false, run_id: args.run_id, error: "nproc_anti_pattern_blocked", note: guardResult.error });
      }
      const guardNotes: string[] = [];
      // A-C3b E11：用户显式冲突标注（不回退）——与回退 note 同走 guardNotes 呈现面
      //（卡面 note/pending 卡/表单卡 detail/审批回执/自动档通报），值保持用户显式原样交内核。
      for (const conflict of guardResult.conflicts) guardNotes.push(conflict.note);
      for (const hit of guardResult.hits) {
        if (hit.key !== "nproc_per_node") continue;
        const nprocField = fields.find((f) => f.key === "nproc_per_node");
        if (nprocField !== undefined) nprocField.value = hit.revertedTo;
        const bsField = fields.find((f) => f.key === "per_device_train_batch_size");
        const bsGuard = Number(bsField?.value ?? String(kernelBsDefaultOf(undefined)));
        const reDerived = deriveGradAccum(Number.isFinite(bsGuard) && bsGuard > 0 ? bsGuard : kernelBsDefaultOf(undefined), Number(hit.revertedTo));
        if ("error" in reDerived) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: reDerived.error });
        }
        const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
        if (accumField !== undefined) accumField.value = String(reDerived.accum);
        guardNotes.push(hit.note);
      }
      const title = args.action === "amend" ? `参数变更请示（仅改动项）— run ${args.run_id}` : `九要素训练配置确认 — run ${args.run_id}`;
      // 批㊶-W F5：双段式文案（共用 helper——表单卡改值提交，聊天打字路径退役）
      const baseNote = dualStageNote("九要素确认卡", { amendNote: amendNote });
      const note = guardNotes.length > 0 ? `${baseNote}\n${guardNotes.join("\n")}` : baseNote;
      if (autoTier) {
        // —— 全自动档：免阻塞落快照＋通报呈现（无静默：每键取值＋来源标注可回看） ——
        // 批次 R H1-1：落快照前 TokenBudget 关系终检（fail-closed——两条不变式不成立/不等无理由
        // 即拒，不静默落盘；agent 推荐理由 reason 或 amend 的 token_budget_sync_reason 兼作
        // 不同步理由——推荐改预算与 cutoff 不等须附理由，无理由即拦）。
        const autoBudgetCheck = tokenBudgetCheckOf(fields, String(amended?.["token_budget_sync_reason"] ?? reason ?? ""));
        if (autoBudgetCheck.violations.length > 0) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "token_budget_invariant_violated", note: `${autoBudgetCheck.violations.join("；")}——快照未落盘；同步 cutoff_len 或补理由后重推` });
        }
        // D76：卡位卡前校验（自动档免卡面——落快照前同样 fail-closed，红字业务语言回传）。
        const autoDeviceViolations = visibleDevicesViolationsOf(fields);
        if (autoDeviceViolations.length > 0) {
          return asToolValue({ ok: false, run_id: args.run_id, error: "visible_devices_invalid", note: `${autoDeviceViolations.join("；")}——快照未落盘；请修正卡位或留空（留空＝全部可见卡，走 deploy 缺省）后重推` });
        }
        const sources: Record<string, string> = {};
        for (const field of fields) {
          sources[field.key] =
            field.tag === "agent_recommend"
              ? (recommendReport.find((v) => v.key === field.key && v.accepted)?.source ?? "default:harness-smart-defaults")
              : field.tag === "need_confirm"
                ? "user-specified"
                : field.key === "per_device_train_batch_size" && bsConventionInjected
                  ? "convention:kernel-bs-default" // E4-乙：bs 内核缺省注入态标 convention（快照 sources 呈现）
                  : "default:harness-smart-defaults";
        }
        const confirmed = confirmedSnapshotOf(fields);
        const rejectedNotes = recommendReport.filter((v) => !v.accepted).map((v) => v.note);
        const recommendSummary = args.action === "amend"
          ? `；改参：${Object.keys(amended ?? {}).join(", ") || "（纯确认）"}`
          : recommendReport.length > 0
            ? `；agent 推荐：${recommendReport.map((v) => `${v.key}=${v.terminal}${v.accepted ? "✓" : "✗"}`).join(" ")}${reason !== undefined && reason.trim() !== "" ? `（理由：${reason.replace(/\s+/g, " ").slice(0, 80)}）` : ""}`
            : "；agent 推荐缺失——全键回退固定建议";
        // b5 像素对复用补丁：变更提示＋关系警示进通报（只提示不阻塞——指令 b5 §三）。
        const pixelChangeAuto = pixelPairChangeNoteOf(fields, baseline);
        const pixelViolationAuto = pixelPairViolationNoteOf(fields);
        const notification = `全自动训练档·配置自动确认（免审批，run ${args.run_id}）——${fields.map((f) => `${f.key}=${f.value}[${sources[f.key]}]`).join(" ")}${recommendSummary}${rejectedNotes.length > 0 ? `；拦截：${rejectedNotes.join("；")}` : ""}${guardNotes.length > 0 ? `；卡数护栏：${guardNotes.join("；")}` : ""}${pixelChangeAuto !== undefined ? `；${pixelChangeAuto}` : ""}${pixelViolationAuto !== undefined ? `；${pixelViolationAuto}` : ""}`;
        // 不写 pending 卡（无卡可应答——卡面内容转为通报）；改参走 amend 纯文字（同样免阻塞）
        appendNotification(runDir, { level: "info", kind: "config_auto", reason: notification, since: new Date().toISOString() });
        saveConfigSnapshot(runDir, confirmed, { auto: true, tier: AUTO_TRAINING_PRESET, sources });
        // 批㊶Q增补二3：自动档同样确认完成——历史残留 pending 卡（如手动卡后切档）一并清理
        clearPending(runDir);
        // E4-乙（改动 2）：停写 iteration-config——快照是训练参数唯一出口（param_sources
        // 与 training 段由内核 training_prep 段写 user_confirmed(ref=stage:training_overrides)；
        // harness 侧回写面整体退役，applyConfirmedToIterationConfig 随删）。
        appendSegmentFact(runDir, "experiment_setup", "atf_config_confirm"); // D96：段事实键对齐内核段名（原 experiment_config 老键退役）
        const sessionIdAuto = sessionIdOfExec(exec);
        if (sessionIdAuto !== undefined) appendBinding(runDir, sessionIdAuto);
        injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复：围栏可写根随 run 切换更新
        return asToolValue({
          ok: true,
          run_id: args.run_id,
          // E3：落点与来源透出（三级单源——快照实际落哪棵树可核对）
          run_dir: runDir,
          run_dir_source: runDirSource,
          confirmed: true,
          auto: true,
          tier: AUTO_TRAINING_PRESET,
          fields,
          sources,
          ...(recommendReport.length > 0 ? { recommend_report: recommendReport } : { recommend: "missing_fallback_defaults" }),
          notification,
          snapshot: "webui/config-snapshot.json",
          ...(preflightNote !== undefined ? { preflight: preflightNote } : {}),
          ...(amendNote !== undefined ? { amend: amendNote } : {}),
        });
      }
      if (args.recommend !== undefined) {
        // 手动档：recommend 为全自动档专属通道——零消费零行为变化（回归红线），仅如实回注
        return asToolValue({ ok: false, run_id: args.run_id, note: "recommend 为全自动训练档专属（当前会话为权限档）——手动档请用 overrides/edits 结构化改参；档位切换须经界面人工操作" });
      }
      // —— 批㊶-W F5：表单卡双段式（手动档）——
      // 第一段＝DSH 原生问题卡 form intent（vendor patch 0003）：逐键输入框＋现值预填＋clamp
      // 域提示；提交回结构化 key=value selected。第二段＝审批卡 Allow once（账本不变）。
      // Reject → 回表单卡（带上次值）循环；关闭表单卡（ASK_CANCELLED）＝结构化取消。
      const userQuestions = ctx.get("userQuestions") as FormAskService | undefined;
      if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
        return asToolValue({ ok: false, run_id: args.run_id, error: "user_questions_unavailable", note: "DSH user-questions 服务未挂载——表单卡通道不可用（fail-closed；不退纯文字链）" });
      }
      // 批次 R H1-1：进卡初始校验态（基线惯例值 9000/9000/12800 恒通过；登记值异常进卡即红字）。
      const initialBudgetViolations = tokenBudgetCheckOf(fields, "").violations;
      // D76：卡位卡前校验态（缺省空恒通过；amend 携 visible_devices 异常值进卡即红字）。
      const initialDeviceViolations = visibleDevicesViolationsOf(fields);
      // b5 像素对复用补丁：进卡关系警示（min<max——只提示不阻塞）。
      const initialPixelViolation = pixelPairViolationNoteOf(fields);
      writePending(runDir, { kind: "config_confirm", run_id: args.run_id, title, fields, note: `${note}\n${tokenBudgetFaceText(fields, initialBudgetViolations)}${initialDeviceViolations.length > 0 ? `\n${initialDeviceViolations.join("\n")}` : ""}${initialPixelViolation !== undefined ? `\n${initialPixelViolation}` : ""}`, at: new Date().toISOString() });
      // TokenBudget 关系校验态（跨轮呈现——violations 非空时表单卡红字重呈，
      // 不进审批卡＝禁用确认；清零后恢复授权链）。卡位校验同机制（D76——红字重呈，
      // 0–7 子集＋个数＝nproc 须成立才放行授权）。
      let budgetViolations: string[] = initialBudgetViolations;
      let deviceViolations: string[] = initialDeviceViolations;
      for (;;) {
        // 批㊶-W 真机修正：typert lossless JSON 拒绝嵌套 undefined（对象键值 undefined
        // 即「not lossless JSON data」）——可选键一律条件 spread，禁显式 undefined 值。
        const formFields = [
          ...configFormFieldsOf(fields, gpuCount),
          // 批次 R H1-1：不同步理由输入行（预算与 cutoff 不等时必填——空即拦确认；
          // 相等时留空。理由是用户输入，不自动生成；不落配置（非配置键）。
          { key: "token_budget_sync_reason", label: "token_budget_sync_reason", value: "", placeholder: "预算与 cutoff 不等时的不同步理由（不等必填；相等留空）——同步请在 cutoff_len 框直接填预算值（用户动作）" },
        ];
        const formDetail = [
          // F1：预检清单首行注入（预检卡在前、九要素卡承接呈现——清单随卡可回看）
          ...(preflightNote !== undefined ? [preflightNote] : []),
          "改参：在输入框改值后提交；不改：直接提交（按现值）。提交后仍需审批卡 Allow once 才生效——表单卡只收改参、不承载授权。",
          // D92：dataset_keys 只读行（输入框已滤——实算值/缺席均如实呈现，不造占位数）
          datasetKeysFaceLineOf(fields),
          ...(amendNote !== undefined ? [amendNote] : []),
          ...(guardNotes.length > 0 ? [`卡数护栏：${guardNotes.join("；")}`] : []),
          tokenBudgetFaceText(fields, budgetViolations),
          // D76：卡位红字行（0–7 子集/不重复/个数＝nproc——业务语言，零内部码）。
          ...(deviceViolations.length > 0 ? deviceViolations : []),
          // b5 像素对复用补丁：像素对关系警示（每轮现算——只提示不阻塞确认链）。
          ...(pixelPairViolationNoteOf(fields) !== undefined ? [pixelPairViolationNoteOf(fields)!] : []),
        ].join("\n");
        let answers: { answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> };
        try {
          answers = await userQuestions.ask({
            questions: [formAskQuestion({
              id: `config-confirm-${args.run_id}`,
              question: `九要素训练配置确认 — ${args.run_id}`,
              header: "训练配置",
              detail: formDetail,
              fields: formFields,
              submitLabel: "确认并继续",
            })],
            agent: exec.agent,
            signal: exec.signal,
          });
        } catch (cause) {
          // A1 伴生缺陷收口：卡通道失败不再零日志——诊断落 run 目录（路径随 note 可定位）
          const diagRel = appendAskFailureDiagnostic(runDir, "atf_config_confirm", `config-confirm-${args.run_id}`, cause);
          if ((cause as { code?: string }).code === "ASK_CANCELLED") {
            return approvalDeniedResult("atf_config_confirm", "cancelled");
          }
          return asToolValue({ ok: false, run_id: args.run_id, error: "form_ask_failed", note: `表单卡应答失败：${String(cause).slice(0, 200)}（通道诊断已落 run 目录 ${diagRel}）` });
        }
        // 结构化 edits（selected key=value——协议零改动的结构化回传面）
        const submitted = editsFromFormAnswers(answers);
        // 与进卡前 fields diff：预填未动的键不算改动（按现值）；必填拦空兜底
        const beforeByKey = new Map(fields.map((f) => [f.key, f.value]));
        const changedEdits: Record<string, string> = {};
        for (const [key, value] of Object.entries(submitted)) {
          if (value === "") continue;
          if (beforeByKey.get(key) !== value) changedEdits[key] = value;
        }
        const clampedKeys = clampEdits(changedEdits);
        // bs/nproc 改动 → accum 随卡数重派生（L2 整除校验——与自动档同语义，防 global batch 破）
        let loopNote = "";
        if (changedEdits["per_device_train_batch_size"] !== undefined || changedEdits["nproc_per_node"] !== undefined) {
          const nprocRaw = changedEdits["nproc_per_node"] ?? fields.find((f) => f.key === "nproc_per_node")?.value;
          const bsRaw = changedEdits["per_device_train_batch_size"] ?? fields.find((f) => f.key === "per_device_train_batch_size")?.value ?? String(kernelBsDefaultOf(undefined));
          const nprocNow = Number(nprocRaw);
          const bsNow = Number(bsRaw);
          if (Number.isFinite(nprocNow) && nprocNow > 0 && Number.isFinite(bsNow) && bsNow > 0) {
            const reDerived = deriveGradAccum(Math.round(bsNow), Math.round(nprocNow));
            if ("error" in reDerived) {
              return asToolValue({ ok: false, run_id: args.run_id, error: "global_batch_derive_failed", note: `改参后 global batch 派生失败（bs=${bsNow}×nproc=${nprocNow}）：${reDerived.error}——请回表单卡调整组合` });
            }
            const accumField = fields.find((f) => f.key === "gradient_accumulation_steps");
            if (accumField !== undefined && changedEdits["gradient_accumulation_steps"] === undefined) {
              changedEdits["gradient_accumulation_steps"] = String(reDerived.accum);
              loopNote = `；accum 随派生更新=${reDerived.accum}（gb=${reDerived.globalBatch} 不变）`;
            }
          }
        }
        for (const [key, value] of Object.entries(changedEdits)) {
          const field = fields.find((f) => f.key === key);
          if (field !== undefined) {
            field.value = value;
            field.tag = "need_confirm";
          }
        }
        if (clampedKeys.length > 0 || loopNote !== "") {
          amendNote = `本轮改参：${Object.keys(changedEdits).join(", ") || "（按现值确认）"}${clampedKeys.length > 0 ? `；越界拦截回退（域边界）：${clampedKeys.join("、")}` : ""}${loopNote}`;
        }
        // b5 像素对复用补丁：max 变更提示（不阻塞——随 amendNote 下一轮 detail/审批卡可见）。
        const pixelChangeNote = pixelPairChangeNoteOf(fields, baseline);
        if (pixelChangeNote !== undefined) {
          amendNote = amendNote !== undefined ? `${amendNote}；${pixelChangeNote}` : pixelChangeNote;
        }
        // 批次 R H1-1：TokenBudget 关系校验（服务端闸——与表单卡 detail 红字同源单源函数）。
        // violations 非空＝禁用确认：不进审批卡，红字重呈表单卡；预算与 cutoff 不等时
        // 同步是用户动作（cutoff_len 框直接填预算值）不自动，不同步须填理由（空即拦）。
        const syncReason = changedEdits["token_budget_sync_reason"] ?? "";
        delete changedEdits["token_budget_sync_reason"];
        budgetViolations = tokenBudgetCheckOf(fields, syncReason).violations;
        // D76：卡位卡前校验（每轮现算——违规红字重呈表单卡，不进审批卡＝禁用确认）。
        deviceViolations = visibleDevicesViolationsOf(fields);
        if (budgetViolations.length > 0 || deviceViolations.length > 0) continue;
        // 第二段＝审批卡（授权唯一落点——Reject 回表单卡循环）；E5 模板四行＋字段表续行
        const verdict = await requestApproval(ctx, exec, "atf_config_confirm",
          buildApprovalReason({
            action: "确认训练配置并落快照",
            target: `（${title}）`,
            effect: "写 run 配置快照（确认值全部键＋TokenBudget 三要素）",
            reversible: "可逆（可改参后重新确认）",
          }) + `\n${renderFields(fields)}\n${tokenBudgetFaceText(fields, [])}\n${note}${amendNote !== undefined ? `\n${amendNote}` : ""}${pixelPairViolationNoteOf(fields) !== undefined ? `\n${pixelPairViolationNoteOf(fields)}` : ""}`);
        if (verdict.ok) break;
        if (verdict.outcome === "rejected") {
          // Reject → 回表单卡（带上次值——fields 已就地更新）
          continue;
        }
        return approvalDeniedResult("atf_config_confirm", verdict.outcome);
      }
      // 确认：全字段按现值落快照（confirmedSnapshotOf 单源——卡位空值不落，D76）
      const confirmed = confirmedSnapshotOf(fields);
      saveConfigSnapshot(runDir, confirmed);
      // 批㊶Q增补二3：确认完成即清 pending 卡（备份改名 .answered——残留则 UI 持续渲染待确认态）
      clearPending(runDir);
      // 批㊶-P P-1a 回写面退役（E4-乙改动 2）：确认快照不再回写 prep/iteration-config——
      // 快照是训练参数唯一出口（红线：停写后 harness 不得再写任何内核产物）；training 段与
      // param_sources 由内核 training_prep 段写（来源 user_confirmed(ref=stage:training_overrides)），
      // prelaunch 报告的「需确认 L1」表由内核侧来源串闭合——harness 侧零代写零后处理。
      // 批㊶-M M-3 段事实轨：实验配置确认成功即登记（experiment_setup 段——D96 键名对齐内核）
      appendSegmentFact(runDir, "experiment_setup", "atf_config_confirm"); // D96：段事实键对齐内核段名（原 experiment_config 老键退役）
      // 批㊶-N N-5：会话绑定
      const sessionIdCfg = sessionIdOfExec(exec);
      if (sessionIdCfg !== undefined) appendBinding(runDir, sessionIdCfg);
      injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复
      return asToolValue({ ok: true, run_id: args.run_id, run_dir: runDir, run_dir_source: runDirSource, confirmed: true, fields, snapshot: "webui/config-snapshot.json", ...(preflightNote !== undefined ? { preflight: preflightNote } : {}), ...(amendNote !== undefined ? { amend: amendNote } : {}) });
    },
  });

  const publishTool = defineTool({
    name: "atf_publish_confirm",
    description:
      "发布确认 digest 卡（审批必经）：对候选契约件（contract-candidate）做发布前确认——卡面呈现 artifact digest（sha256 凭据）与发布目标；Allow once＝确认发布凭据。digest 缺失时如实拒绝（不造数）。",
    parameters: {
      run_id: { type: "string", required: true, description: "run 标识" },
      workspace_path: { type: "string", description: "workspace 根（绝对路径——与 atf_pipeline_stage 的 workspace_path 同值；落点 <workspace_path>/runs/<run_id>，未传时按会话工作区事实与实例 runs 根顺次解析）" },
      digest: { type: "string", description: "契约件 sha256 digest（缺省读契约候选的 digest 字段——E8 槽位形态按类读 publish/<doc>/contract-candidate.json；无槽位 legacy 读 run 根）" },
      doc_type: { type: "string", description: "单据类型键（E8 槽位形态）：多类 run 必填——按类逐一确认，不取任一份冒充全部；单类可省（缺省取该类）；无槽位 legacy run 不得传" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 1) }],
    },
    async execute(args: { run_id: string; workspace_path?: string; digest?: string; doc_type?: string }, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
      // E3（缺口 D 同源）：run 落点三级单源（config_confirm 同款——契约件读取与段事实同棵树）
      const resolvedRun = resolveConfirmRunDir(deps, args.run_id, args.workspace_path, exec);
      if (!resolvedRun.ok) {
        return asToolValue({ ok: false, run_id: args.run_id, error: resolvedRun.error, note: resolvedRun.note });
      }
      const runDir = resolvedRun.runDir;
      const runDirSource = resolvedRun.source;
      // E8：digest 缺省读取槽位优先（listDocSlots——全仓唯一路径表）。多类必须显式 doc_type
      // 按类出卡（每类一张卡逐一确认），不得取任一份冒充全部；单类缺省取该类；无槽位回退
      // run 根契约候选（legacy 只读）。
      const slots = listDocSlots(runDir);
      const wantedDocType = typeof args.doc_type === "string" ? args.doc_type.trim() : "";
      const slotTypes = slots.map((slot) => slot.doc_type);
      let candidatePath: string;
      let cardDocType: string | null = null;
      if (slots.length > 0) {
        const slot = wantedDocType !== "" ? slots.find((entry) => entry.doc_type === wantedDocType) ?? null : slots.length === 1 ? slots[0] ?? null : null;
        if (wantedDocType !== "" && slot === null) {
          return asToolValue({
            ok: false, run_id: args.run_id, error: "doc_slot_unknown", doc_type: wantedDocType, doc_types: slotTypes,
            note: `run ${args.run_id} 没有「${wantedDocType}」的单据槽位（在场类型：${slotTypes.join("、") || "（无）"}）——按在场类型给出 doc_type`,
          });
        }
        if (slot === null) {
          return asToolValue({
            ok: false, run_id: args.run_id, error: "doc_type_required", doc_types: slotTypes,
            note: `run ${args.run_id} 有 ${String(slotTypes.length)} 类单据槽位（${slotTypes.join("、")}）——多类须显式给 doc_type 按类逐一确认，不取任一份冒充全部`,
          });
        }
        candidatePath = slot.candidate_path;
        cardDocType = slot.doc_type;
      } else {
        if (wantedDocType !== "") {
          return asToolValue({
            ok: false, run_id: args.run_id, error: "doc_slot_unknown", doc_type: wantedDocType, doc_types: [],
            note: `run ${args.run_id} 无单据槽位（legacy 形态——契约件在 run 根），不接受 doc_type`,
          });
        }
        candidatePath = legacyCandidatePath(runDir);
      }
      const candidateRel = cardDocType !== null ? `publish/${cardDocType}/contract-candidate.json` : "contract-candidate.json";
      let candidateDigest = args.digest;
      if (candidateDigest === undefined && existsSync(candidatePath)) {
        try {
          const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as Record<string, unknown>;
          candidateDigest = typeof candidate["digest"] === "string" ? (candidate["digest"] as string) : undefined;
        } catch {
          candidateDigest = undefined;
        }
      }
      if (candidateDigest === undefined) {
        return asToolValue({ ok: false, run_id: args.run_id, note: `无契约件 digest（${candidateRel} 缺失或无 digest 字段）——无可发布凭据，不造数` });
      }
      const title = `发布确认（digest 凭据）— run ${args.run_id}${cardDocType !== null ? ` · ${cardDocType}` : ""}`;
      // 批㊶-U §五：凭据卡退化形式——无可调参数不虚构；卡面 note＝统一说明＋复核通道（聊天重呈）
      const body = `  artifact: ${candidateRel}\n  digest: ${candidateDigest}\n  ${dualStageNote("契约凭据卡", { amendable: false })}`;
      writePending(runDir, { kind: "publish_confirm", run_id: args.run_id, title, digest: candidateDigest, ...(cardDocType !== null ? { doc_type: cardDocType } : {}), at: new Date().toISOString() });
      // E5 模板四行（凭据摘要续行；点按指引由审批卡自身承载）
      const verdict = await requestApproval(ctx, exec, "atf_publish_confirm",
        buildApprovalReason({
          action: "确认契约发布",
          target: `（run ${args.run_id}）`,
          effect: "登记发布段事实（写 run 段记录）",
          reversible: "可逆（可重新走确认）",
        }) + `\n${title}\n${body}`);
      if (!verdict.ok) return approvalDeniedResult("atf_publish_confirm", verdict.outcome);
      // 批㊶Q增补二3：放行完成即清 pending 卡（同确认卡语义）
      clearPending(runDir);
      // 批㊶-M M-3 段事实轨：契约发布确认成功即登记（publish 段）
      appendSegmentFact(runDir, "publish", "atf_publish_confirm");
      // 批㊶-N N-5：会话绑定
      const sessionIdPub = sessionIdOfExec(exec);
      if (sessionIdPub !== undefined) appendBinding(runDir, sessionIdPub);
      injectBashRunWorkspace(runDir); // 批㊶-S1 门2修复
      return asToolValue({
        ok: true, run_id: args.run_id, run_dir: runDir, run_dir_source: runDirSource, confirmed: true, digest: candidateDigest,
        artifact: candidateRel, ...(cardDocType !== null ? { doc_type: cardDocType } : {}),
      });
    },
  });

  return [configTool, publishTool];
};
