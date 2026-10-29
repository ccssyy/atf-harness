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
import { mkdirSync, writeFileSync } from "node:fs";
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
  { label: "2 倍", value: 2 },
  { label: "3 倍", value: 3 },
];

/** 自由输入解析：用户可能写「3」「三倍」「不增强」——认不出按未答处理（不猜）。 */
export const augmentFromText = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const hit = AUGMENT_OPTIONS.find((option) => option.label === trimmed);
  if (hit !== undefined) return hit.value;
  const num = Number(trimmed.replace(/[^0-9.]/g, ""));
  if (Number.isFinite(num) && num >= 0) return num;
  if (/不|否|none|off/i.test(trimmed)) return 0;
  return undefined;
};

/** 分组的自由输入解析：只认明确的正/负，其余 undefined（保持现值）。 */
export const groupingFromText = (text: string): boolean | undefined => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed === GROUPING_YES) return true;
  if (trimmed === GROUPING_NO) return false;
  if (/^不|不要|否|no|n$/i.test(trimmed)) return false;
  if (/要|是|分组|yes|y$/i.test(trimmed)) return true;
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
export const constructionGapOf = (state: ConstructionParamsState): boolean =>
  state.groupingConfirm !== true || state.mode5Random === undefined;

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
  // 只问真缺的（已确认的不重复问）：agent 传了分组候选／已确认分组时，只剩增强这一个决策点。
  const needGrouping = input.state.groupingConfirm !== true;
  const needAugment = input.state.mode5Random === undefined;
  const questions: ChoiceAskQuestion[] = [];
  if (needGrouping) {
    questions.push({
      id: `construction-grouping-${input.runId}`,
      question: "分组生成沿用默认（按数据事实分组）还是改成一图一条？",
      header: "分组",
      detail: [
        "默认（推荐）：按数据事实分组，每图每组各出一条样本；组数已按标准压到常规区间。",
        "一图一条：每张图只出一条样本，字段照样全部带上，样本数＝图数。",
        "不改也行——本轮会按默认生成，这里只是让你知道默认值是什么、并能当场改。",
      ].join("\n"),
      options: [
        { label: GROUPING_YES, description: "样本更多，覆盖同一张图的多种字段组合" },
        { label: GROUPING_NO, description: "样本数＝图数，最稳" },
      ],
      multiSelect: false,
    });
  }
  if (needAugment) {
    questions.push({
      id: `construction-augment-${input.runId}`,
      question: "随机子集增强沿用建议倍数（2 倍）还是要改？",
      header: "增强",
      detail: [
        "默认（推荐）：按建议值 2 倍生成——原始样本之外再生成约等量的随机子集样本。",
        "倍数相对原始条数：2 倍＝总量约翻一倍；也可选不增强。",
        "选了就会真的生成，不是占位；默认值同样会生成，这里只是给你改的机会。",
      ].join("\n"),
      options: AUGMENT_OPTIONS.map((option) => ({
        label: option.label,
        description: option.value === 0 ? "只保留原始样本" : `总量约 ${String(option.value)} 倍`,
      })),
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
    const groupingAnswer = needGrouping ? byId.get(`construction-grouping-${input.runId}`) : undefined;
    const augmentAnswer = needAugment ? byId.get(`construction-augment-${input.runId}`) : undefined;
    const groupingText = [...(groupingAnswer?.selected ?? [])].join("") || (groupingAnswer?.custom ?? "");
    const augmentText = [...(augmentAnswer?.selected ?? [])].join("") || (augmentAnswer?.custom ?? "");
    const groupingConfirm = groupingFromText(groupingText) ?? input.state.groupingConfirm;
    const mode5Random = augmentFromText(augmentText) ?? input.state.mode5Random;
    const ledgerPath = writeLedger(input.runDir, "construction-choice.json", {
      schema: "ConstructionChoice/v1",
      run_id: input.runId,
      decided_at: new Date().toISOString(),
      decided_by: "user",
      grouping_confirm: groupingConfirm,
      mode5_random: mode5Random ?? null,
      answers: { grouping: groupingText, augment: augmentText },
    });
    const augmentLine = mode5Random === undefined || mode5Random === 0 ? "不增强" : `${String(mode5Random)} 倍`;
    return {
      groupingConfirm,
      mode5Random,
      asked: true,
      decided_by: "user",
      note: `你在卡上选定：分组＝${groupingConfirm ? "按分组生成" : "一图一条"}；增强＝${augmentLine}`,
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
