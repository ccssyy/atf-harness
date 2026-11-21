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
  /** P1-5:targeted 建议解析终值(agent 传参优先→盘面统计件同源兜底;决策闸入参)。 */
  readonly targetedSuggestedResolved?: number;
  /** mode5 每图条数的智能分析建议值(agent 依 mode5_advice_stats 传;缺=未经分析)。 */
  readonly mode5Suggested?: number;
  /** 智能分析完成态(mode5 分析件在盘;approval 旁路路径的卡面呈现用)。 */
  readonly analysisReady?: boolean;
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

/** 增强倍数档位（值→文案单源；内核只认数字，不认文案）。 */
const AUGMENT_OPTIONS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "不增强", value: 0 },
  { label: "每图 2 条", value: 2 },
  { label: "每图 3 条", value: 3 },
  // owner 2026-11-07(「2倍5倍上限也太小了」):档位放开到 10——可行域由预算护栏
  // 动态定(feasible_ceiling),超上限内核按上限执行并在回执披露 capped
  { label: "每图 4 条", value: 4 },
  { label: "每图 5 条", value: 5 },
  { label: "每图 6 条", value: 6 },
  { label: "每图 8 条", value: 8 },
  { label: "每图 10 条", value: 10 },
];

/** B3c（2026-11-21 owner 裁定）：本卡不再做任何「label → value」翻译。
 *
 * vendor 的 `AskUserQuestionAnswerItem` 只给 `selected: string[]`（label 原文）
 * 与 `custom?: string`（手打原文）——官方 `tool-ask-user` 明写「feeds that answer
 * back into the agent loop as an ordinary tool result」，即**答案原样回给 agent**。
 *
 * 原实现（正则 → 闭集查表）是在工具内替 agent 做语义理解：
 *   - 点选路径：label 本来就能被 agent 直接读懂，翻回数字是多余一步
 *   - 手打路径：自由输入不可能穷举，正则/查表注定漏，漏了还要防静默丢
 * 两步都是替 agent 干活，且方法不对。
 *
 * 现在：三个字段的答案（selected / custom）**原样**进 tool result，
 * agent 理解后带结构化参数重调本工具。工具只做确定性动作（落账）。
 */

/** 把某问的答案原样取出（selected 在前、custom 兜底），不做任何解析。 */
const rawAnswerOf = (answer: { selected?: readonly string[]; custom?: string } | undefined): string =>
  answer === undefined ? "" : ([...(answer.selected ?? [])].join("") || (answer.custom ?? "")).trim();

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
    // B3：卡面原话必须原样回传——三问各自的「文字通道」原文与「认出的值」分开收。
    // customTextOf=用户手打的原文（卡片 selected 为空时才有意义）；undefined=没写。
    const customTextOf = (id: string): string => {
      const answer = byId.get(id);
      if (answer === undefined) return "";
      if ((answer.selected ?? []).length > 0) return "";
      return (answer.custom ?? "").trim();
    };
    const answerTextOf = (id: string): string => {
      const answer = byId.get(id);
      if (answer === undefined) return "";
      return [...(answer.selected ?? [])].join("") || (answer.custom ?? "");
    };
    // B3c（2026-11-21 owner 裁定）：答案原样回传，工具不做 label→value 翻译。
    // 三问的原文一律照录（点了选项就是 label，手打就是 custom），由 agent 理解。
    const augmentAnswer = byId.get(`construction-augment-${input.runId}`);
    const targetedAnswer = byId.get(`construction-targeted-${input.runId}`);
    const cutoffAnswer = byId.get(`construction-cutoff-${input.runId}`);
    const augmentAnswerText = rawAnswerOf(augmentAnswer);
    const targetedAnswerText = rawAnswerOf(targetedAnswer);
    const cutoffAnswerText = rawAnswerOf(cutoffAnswer);
    const groupingConfirm = true;

    // 本轮未解析：一律保持现值（不猜、不崩）。agent 理解答案后带参数重调。
    const mode5Random = input.state.mode5Random;
    const targetedMultiplier = input.state.targetedMultiplier;
    const cutoffLen = input.state.cutoffLen;

    // 凡用户作答但工具未解析的，逐条原文回传（一条不丢）。
    const pendingAnswers: ReadonlyArray<{ readonly field: string; readonly said: string }> = [
      ...(needAugment && augmentAnswerText !== ""
        ? [{ field: "随机子集增强每图条数", said: augmentAnswerText }]
        : []),
      ...(needTargeted && targetedAnswerText !== ""
        ? [{ field: "重点字段增强倍率", said: targetedAnswerText }]
        : []),
      ...(needCutoff && cutoffAnswerText !== ""
        ? [{ field: "序列长度上限", said: cutoffAnswerText }]
        : []),
    ];
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
      answers: {
        grouping: "(产品默认:按分组生成,不问)",
        augment: augmentAnswerText, targeted: targetedAnswerText, cutoff: cutoffAnswerText,
      },
      // B3：认不出的原话一并落账——事后可核「用户到底说了什么」，不被解析层吞掉
      ...(pendingAnswers.length > 0 ? { pending_user_answers: pendingAnswers } : {}),
    });
    const augmentLine = mode5Random === undefined || mode5Random === 0 ? "不增强" : `${String(mode5Random)} 倍`;
    // B3 回落链路：第 3 步回传——原话逐条回给 agent（不截断、不改写），
    // 并明说「这几项按现值/原值保留」，让 agent 带结构化参数重调工具。
    const echoLine = pendingAnswers.length === 0
      ? ""
      : `\n用户的作答本卡未做解析，原样照录——${pendingAnswers.map((item) => `「${item.said}」（${item.field}）`).join("、")}；这几项本轮按现值保留。请理解他的意思后带结构化参数重调本工具（不要当作他没说）。`;
    return {
      groupingConfirm,
      mode5Random,
      targetedMultiplier,
      cutoffLen,
      targetedSuggested: input.state.targetedSuggested,
      asked: true,
      decided_by: "user",
      note: `分组＝按分组生成（产品默认,必分组不提问）；随机子集增强＝${augmentLine}；重点字段倍率＝${targetedMultiplier === undefined ? "未确认" : `${String(targetedMultiplier)} 倍`}；序列长度上限＝${cutoffLen === undefined ? "未确认" : String(cutoffLen)}` + echoLine,
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
