/**
 * 构造参数决策闸（D90 第二半：问题卡不能被审批豁免吞掉）。
 *
 * 现场（10-29 UAT 真机，同事 1029 工作区，完全权限档）：八段跑完、35 次审批全被自动
 * 放行，**一张问题卡都没有**；分组方案与随机增强从未确认，于是分组样本与增强样本
 * 一段都没生成——agent 事后才说「需要用户确认」，而用户从头到尾没被问过。根因不是
 * 某个分支写错，而是**把「决策输入」塞进了审批卡的正文**：审批一免，确认跟着一起免。
 *
 * 本文件的职责边界：
 *  - 审批卡＝授权（能不能执行）；问题卡＝决策（用哪套参数）。两者**不得**互相代替。
 *  - 完全权限档下审批免了，构造参数一旦缺失就必须**当场问人**（原生选项卡），
 *    不许「按缺省跑完，再在回执里写一句未确认」。
 *  - 全自动档下不问人，由 agent 自决，但必须落账 `decided_by: agent`——
 *    不许把「没人回答」当成「用户默认同意」。
 *
 * 落点纪律：卡面输入态一律 `<run>/runtime/webui/`（与 config-snapshot／pending-confirm
 * 同域），不进 `analysis/decisions/`（那是内核 DecisionGate 的判定账，语义不同层）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChoiceAskQuestion, FormAskService } from "./confirmFace.js";
import {
  approvalBypassed,
  permissionTierOf,
  questionsAllowed,
  type DecisionMaker,
} from "./permissionTier.js";
import type { ExecSessionFace, ServiceCtxFace } from "./trainingPreset.js";

/** 构造参数当前态（调度方已按调用参数解析出来的值）。 */
export interface ConstructionParamsState {
  readonly groupingConfirm: boolean;
  readonly mode5Random: number | undefined;
  /** D177:targeted 重点字段增强倍率(与 mode5 分用不同倍率,owner 2026-11-04 裁定)。 */
  readonly targetedMultiplier?: number;
  /** D177:构造样本序列长度上限(构造开始前与倍率同卡确认;agent 显式传参时不问)。 */
  readonly cutoffLen?: number;
  /** D177:卡面呈现的智能默认(targeted 倍率推导值,缺信号时 undefined 呈现说明)。 */
  readonly targetedSuggested?: number;
  /** mode5 每图条数的智能分析建议值(agent 依 mode5_advice_stats 传;缺=未经分析)。 */
  readonly mode5Suggested?: number;
}

/** 决策闸结论：解析后的构造参数＋谁定的＋为什么。 */
export interface ConstructionDecision extends ConstructionParamsState {
  /** 本闸是否真的发起了提问（false＝参数齐备或不该问）。 */
  readonly asked: boolean;
  readonly decided_by: DecisionMaker;
  /** 用户面一句话（业务语言，零内部键名/档位名）。 */
  readonly note: string;
  /** 落点（问到人／全自动自决时写；通道不可用时为 null）。 */
  readonly ledgerPath: string | null;
}

/** 分组两态（要不要按分组生成——组构成由内核按字段配置产出，本问只收意愿）。 */
const GROUPING_YES = "要（按分组生成）";
const GROUPING_NO = "不要（一图一条）";

/** 增强倍数档位（值→文案单源；内核只认数字，不认文案）。 */
const AUGMENT_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "不增强", value: 0 },
  { label: "每图 2 条", value: 2 },
  { label: "每图 3 条", value: 3 },
];

/** 自由输入解析（仅 custom 通道：用户手打「3」「三倍」「不增强」这类文字）。
 *
 * 选项卡的 selected 回传的是 label 本身（契约 confirmFace.ts:199——选项编码），
 * 等值命中在调用方完成，不经本函数。本函数只服务自由输入：认数字认否定，
 * 认不出按未答处理（不猜）。N5 教训：不要为「回传形态可能变形」加猜测层——
 * 形态不对修回传端（对齐契约），解析端不加启发式。
 */
export const augmentFromText = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const exact = AUGMENT_OPTIONS.find((option) => option.label === trimmed);
  if (exact !== undefined) return exact.value;
  const numMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (numMatch !== null) {
    const num = Number(numMatch[1]);
    if (Number.isFinite(num) && num >= 0) return num;
  }
  if (/不|否|none|off/i.test(trimmed)) return 0;
  return undefined;
};

/** targeted 倍率解析:selected 命中智能默认 label→推导值;数字/档位文字→值;未答 undefined。 */
const targetedFromText = (text: string, suggestedLabel: string, suggested: number | undefined): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed === suggestedLabel) return suggested ?? 1.0;
  if (trimmed.includes("不重点扩")) return 1.0;
  const numMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (numMatch !== null) {
    const num = Number(numMatch[1]);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return undefined;
};

/** cutoff_len 解析:数字(选项 label 前缀或 custom);未答 undefined。 */
const cutoffFromText = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const numMatch = trimmed.match(/(\d{3,6})/);
  if (numMatch !== null) {
    const num = Number(numMatch[1]);
    if (Number.isFinite(num) && num >= 1024 && num <= 65536) return num;
  }
  return undefined;
};

/** 分组的自由输入解析：只认明确的正/负，其余 undefined（保持现值）。 */
/** 读既有构造选择落账（ci-bl-1103 多类去重）：decided_by=user 的记录才复用
 *  （全自动档 agent 自决落账不是用户确认,不作为复用凭据）。 */
export const readConstructionChoice = (
  runDir: string | null | undefined,
): { decided_by: string; grouping_confirm: boolean; mode5_random: number | null; targeted_multiplier: number | null; cutoff_len: number | null; path: string } | null => {
  if (runDir === null || runDir === undefined || runDir === "") return null;
  const path = join(runDir, "runtime", "webui", "construction-choice.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      decided_by?: unknown; grouping_confirm?: unknown; mode5_random?: unknown;
      targeted_multiplier?: unknown; cutoff_len?: unknown;
    };
    if (typeof parsed.decided_by !== "string") return null;
    return {
      decided_by: parsed.decided_by,
      grouping_confirm: parsed.grouping_confirm === true,
      mode5_random: typeof parsed.mode5_random === "number" ? parsed.mode5_random : null,
      // D177:旧落账无新键返回 null(复用侧回落 undefined,不编造)
      targeted_multiplier: typeof parsed.targeted_multiplier === "number" ? parsed.targeted_multiplier : null,
      cutoff_len: typeof parsed.cutoff_len === "number" ? parsed.cutoff_len : null,
      path,
    };
  } catch {
    return null;
  }
};

export const groupingFromText = (text: string): boolean | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed === GROUPING_YES) return true;
  if (trimmed === GROUPING_NO) return false;
  if (/^不|不要|否|no|n$/i.test(trimmed)) return false;
  if (/要|是|分组|yes|y/i.test(trimmed)) return true;
  return undefined;
};

const writeLedger = (
  runDir: string | undefined,
  fileName: string,
  payload: Record<string, unknown>,
): string | null => {
  if (runDir === undefined || runDir === "") return null;
  try {
    const dir = join(runDir, "runtime", "webui");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, fileName);
    writeFileSync(target, JSON.stringify(payload, null, 1) + "\n", "utf-8");
    return target;
  } catch {
    return null;
  }
};

/** 构造参数是否还有缺口（缺口＝必须问人，或必须由 agent 明确代决）。 */

/** D163：读登记账本 inputs.json 的分组出处（缺席/坏行按"没有分组依据"呈现）。 */
const groupingCardLeadOf = (runDir: string): string => {
  try {
    const parsed = JSON.parse(readFileSync(join(runDir, "config", "inputs.json"), "utf8")) as {
      grouping?: { source?: unknown; quote?: unknown; group_count?: unknown };
    };
    const g = parsed.grouping ?? {};
    const source = typeof g.source === "string" ? g.source : "absent";
    const quote = typeof g.quote === "string" && g.quote.trim() !== "" ? g.quote.trim() : "";
    const n = typeof g.group_count === "number" ? g.group_count : 0;
    if (source === "user_supplied") {
      return quote !== "" ? `分组按你说的「${quote}」走（${n} 组）` : `分组按你给的配置走（${n} 组）`;
    }
    if (source === "agent_written") return "这套分组是助手写进配置的，还没经你确认";
    if (source === "degenerate") return "字段是一字段一组，没形成业务分组";
    return "当前没有分组依据";
  } catch {
    return "当前没有分组依据";
  }
};

export const constructionGapOf = (state: ConstructionParamsState): boolean =>
  // D177:mode5/targeted 倍率与 cutoff_len 任一未确认即缺口(分用倍率,不共用);
  // groupingConfirm 判定保留(旧语义:分组未确认同样是缺口)
  state.groupingConfirm !== true || state.mode5Random === undefined
  || state.targetedMultiplier === undefined || state.cutoffLen === undefined;

/**
 * 决策闸主体。
 *
 * 触发条件（两条同时成立才动作，保证存量路径零变化）：
 *  ① 当前档位已免审批（完全权限／全自动）——guarded 档仍由审批卡承载，不重复打扰；
 *  ② 构造参数有缺口（分组未确认或增强倍数未给）。
 *
 * **永不 throw**：问询失败按 agent 自决落账，把「没问到」如实写进 note——
 * 失败也必须可读，不能变成工具异常。
 */
export const decideConstructionParams = async (input: {
  readonly ctx: ServiceCtxFace;
  readonly exec: ExecSessionFace;
  readonly runId: string;
  readonly runDir?: string;
  readonly state: ConstructionParamsState;
}): Promise<ConstructionDecision> => {
  const tier = permissionTierOf(input.ctx, input.exec);
  if (!constructionGapOf(input.state)) {
    return { ...input.state, asked: false, decided_by: "user", note: "构造参数已确认", ledgerPath: null };
  }
  if (!approvalBypassed(tier)) {
    // guarded 档：审批卡照弹且如实呈现「未确认」，行为与此前一致（不新增打扰）。
    return {
      ...input.state,
      asked: false,
      decided_by: "agent",
      note: "构造参数未确认（审批卡已如实呈现，等你决定）",
      ledgerPath: null,
    };
  }
  if (!questionsAllowed(tier)) {
    // 全自动档：无人可问——agent 自决，但必须留痕「这是它的判断，不是用户的决定」。
    const ledgerPath = writeLedger(input.runDir, "decisions-auto.json", {
      schema: "ConstructionDecision/v1",
      run_id: input.runId,
      decided_at: new Date().toISOString(),
      decided_by: "agent",
      basis: "unattended",
      decisions: [
        { key: "grouping_confirm", value: input.state.groupingConfirm, decided_by: "agent" },
        { key: "mode5_random", value: input.state.mode5Random ?? null, decided_by: "agent" },
        { key: "targeted_multiplier", value: input.state.targetedMultiplier ?? null, decided_by: "agent" },
        { key: "cutoff_len", value: input.state.cutoffLen ?? null, decided_by: "agent" },
      ],
      note: "全自动档位：无人可问，按当前构造参数继续；需要复核时以此文件为准",
    });
    return {
      ...input.state,
      asked: false,
      decided_by: "agent",
      note: "分组与增强倍数本次由我判断（全自动档位，未向任何人确认）",
      ledgerPath,
    };
  }
  // ci-bl-1103 多类去重：构造参数(分组生成模式/增强倍数)是 run 级决策——多类联合
  // 训练逐类构造时,第二类起复用首类卡上已确认的落账,不再重复弹卡(owner 裁定
  // 口径与 prompt 卡/字段卡同族:用户确认过一次=本 run 有效)。
  const prior = readConstructionChoice(input.runDir);
  if (prior !== null && prior.decided_by === "user") {
    // D177:旧落账无新键时回落 undefined(不编造)——首跑补问一次,落账后多类复用
    return {
      groupingConfirm: prior.grouping_confirm === true,
      mode5Random: prior.mode5_random ?? undefined,
      targetedMultiplier: prior.targeted_multiplier ?? undefined,
      cutoffLen: prior.cutoff_len ?? undefined,
      targetedSuggested: input.state.targetedSuggested,
      asked: false,
      decided_by: "user",
      note: "复用本 run 卡上已确认的构造参数（多类构造不重复弹卡；新参数键缺失时补问一次）",
      ledgerPath: prior.path,
    };
  }
  // 完全权限档：审批已免，但决策输入必须问人——原生选项卡（两问一屏）。
  const svc = input.ctx.get("userQuestions") as FormAskService | undefined;
  if (svc === undefined || typeof svc.ask !== "function") {
    return {
      ...input.state,
      asked: false,
      decided_by: "agent",
      note: "问询通道不可用——本轮按当前构造参数继续，分组与增强未获确认",
      ledgerPath: null,
    };
  }
  // ci-bl-1103(owner 裁定):必须分组——「按分组生成」是产品默认,不再问
  // 「是否分组/一图一条」(原 GROUPING 问题撤除;用户要一图一条可后续在构造
  // 参数显式声明)。卡面只剩真缺的增强倍数一问。
  const needAugment = input.state.mode5Random === undefined;
  // D177:mode5(随机子集增强条数)与 targeted(重点字段倍率)分用不同值;cutoff_len 同卡确认
  const needTargeted = input.state.targetedMultiplier === undefined;
  const needCutoff = input.state.cutoffLen === undefined;
  const questions: ChoiceAskQuestion[] = [];
  if (needAugment) {
    questions.push({
      id: `construction-augment-${input.runId}`,
      // D187:语义如实——mode5_random 是「每图生成条数」不是倍数(内核整数语义);
      // 同图不重样+组内组合空间有限时实际可少于每图条数(构造报告如实披露)。
      // D210 终版(owner 2026-11-05 定论):mode5/targeted 两个倍数建议值都来自
      // agent 结合图片与标签的智能分析,各自独立——建议在场时题面与推荐项
      // 呈现分析值;缺席时如实标『未经智能分析』(不冒充建议)。
      question: input.state.mode5Suggested !== undefined
        ? `随机子集增强：每图生成几条随机字段组合样本？（智能分析建议每图 ${String(input.state.mode5Suggested)} 条）`
        : "随机子集增强：每图生成几条随机字段组合样本？（未经智能分析——产品默认 2 条）",
      header: "随机子集增强",
      detail: [
        input.state.mode5Suggested !== undefined
          ? `分析建议（推荐）：每图 ${String(input.state.mode5Suggested)} 条——依据字段难度与组内组合空间的智能分析（图片+标签）。`
          : "默认：每图 2 条——未经智能分析（agent 未传建议值），这是产品默认值不是分析建议；要看分析建议先走看图分析后重跑。",
        "语义是「每图条数」不是总量倍数：组内组合空间有限时实际会少于该数（同图不重复组合），构造报告会如实披露实产条数与原因。",
        "也可选不增强（只保留原始样本与必做的重点字段增强）。",
      ].join("\n"),
      options: AUGMENT_OPTIONS.map((option) => ({
        label: option.label,
        description: option.value === 0
          ? "只保留原始样本"
          : input.state.mode5Suggested === option.value
            ? `每页生成约 ${String(option.value)} 条组合样本（智能分析建议档）`
            : `每页生成约 ${String(option.value)} 条组合样本`,
      })),
      multiSelect: false,
    });
  }
  if (needTargeted) {
    const suggested = input.state.targetedSuggested;
    questions.push({
      id: `construction-targeted-${input.runId}`,
      question: suggested !== undefined
        ? `重点字段增强倍率按智能推导 ${String(suggested)} 倍（按字段难易度）还是要改？`
        : "重点字段增强倍率用多少？（本轮无字段风险信号，默认 1 倍=不重点扩）",
      header: "重点字段倍率",
      detail: [
        "默认（推荐）：按字段难易度智能推导——低频/复杂版式/多值字段倍率更高，让重点组合获得更多样本。",
        "与「随机子集增强」是两个独立倍率，互不挤占（你在这里改的只影响重点字段组合）。",
        "选了就会真的生成；默认值同样生效，这里只是给你改的机会。",
      ].join("\n"),
      options: [
        { label: suggested !== undefined ? `智能推导（${String(suggested)} 倍）` : "1 倍（不重点扩）", description: "按字段难易度推导的值" },
        { label: "1.5 倍", description: "轻重点" },
        { label: "2 倍", description: "中重点" },
        { label: "3 倍", description: "强重点" },
      ],
      multiSelect: false,
    });
  }
  if (needCutoff) {
    questions.push({
      id: `construction-cutoff-${input.runId}`,
      question: "构造样本的序列长度上限按基线 9000 还是要改？",
      header: "序列长度上限",
      detail: [
        "默认（推荐）：9000——超出上限的样本会被截断，影响长版式单据的完整抽取。",
        "素材多长版式（提单/信用证混排页）时可上调；下调可省显存与训练时长。",
        "确认后写入训练预算（token_budget），训练与评估同口径生效。",
      ].join("\n"),
      options: [
        { label: "9000（基线默认）", description: "适配多数单据版式" },
        { label: "12288", description: "多长版式素材" },
        { label: "8192", description: "省显存短训" },
      ],
      multiSelect: false,
    });
  }
  try {
    const answers = await svc.ask({
      questions,
      agent: input.exec.agent,
      signal: (input.exec as { signal?: unknown }).signal,
    });
    const byId = new Map(answers.answers.map((answer) => [answer.id, answer]));
    const augmentAnswer = needAugment ? byId.get(`construction-augment-${input.runId}`) : undefined;
    const augmentText = [...(augmentAnswer?.selected ?? [])].join("") || (augmentAnswer?.custom ?? "");
    const groupingConfirm = true;
    const mode5Random = augmentFromText(augmentText) ?? input.state.mode5Random;
    // D177:targeted/cutoff 解析(selected label 或 custom;未答保持现值,不猜)
    const targetedAnswer = needTargeted ? byId.get(`construction-targeted-${input.runId}`) : undefined;
    const targetedText = [...(targetedAnswer?.selected ?? [])].join("") || (targetedAnswer?.custom ?? "");
    const suggestedLabel = input.state.targetedSuggested !== undefined ? `智能推导（${String(input.state.targetedSuggested)} 倍）` : "1 倍（不重点扩）";
    const targetedMultiplier = targetedFromText(targetedText, suggestedLabel, input.state.targetedSuggested) ?? input.state.targetedMultiplier;
    const cutoffAnswer = needCutoff ? byId.get(`construction-cutoff-${input.runId}`) : undefined;
    const cutoffText = [...(cutoffAnswer?.selected ?? [])].join("") || (cutoffAnswer?.custom ?? "");
    const cutoffLen = cutoffFromText(cutoffText) ?? input.state.cutoffLen;
    const ledgerPath = writeLedger(input.runDir, "construction-choice.json", {
      schema: "ConstructionChoice/v1",
      run_id: input.runId,
      decided_at: new Date().toISOString(),
      decided_by: "user",
      grouping_confirm: groupingConfirm,
      mode5_random: mode5Random ?? null,
      targeted_multiplier: targetedMultiplier ?? null,
      cutoff_len: cutoffLen ?? null,
      // 视觉通道恒 enabled（SKILL v1.16 owner 裁定:内置默认必开、无 disable、
      // 不弹卡）——键保留读侧兼容,值不再是决策面。
      visual_channel: "enabled",
      answers: { grouping: "(产品默认:按分组生成,不问)", augment: augmentText, targeted: targetedText, cutoff: cutoffText },
    });
    const augmentLine = mode5Random === undefined || mode5Random === 0 ? "不增强" : `${String(mode5Random)} 倍`;
    return {
      groupingConfirm,
      mode5Random,
      targetedMultiplier,
      cutoffLen,
      targetedSuggested: input.state.targetedSuggested,
      asked: true,
      decided_by: "user",
      note: `分组＝按分组生成（产品默认,必分组不提问）；随机子集增强＝${augmentLine}；重点字段倍率＝${targetedMultiplier === undefined ? "未确认" : `${String(targetedMultiplier)} 倍`}；序列长度上限＝${cutoffLen === undefined ? "未确认" : String(cutoffLen)}`,
      ledgerPath,
    };
  } catch (cause) {
    return {
      ...input.state,
      asked: true,
      decided_by: "agent",
      note: `构造参数问询未完成（${String(cause).slice(0, 120)}）——本轮按当前参数继续，分组与增强未获确认`,
      ledgerPath: null,
    };
  }
};
