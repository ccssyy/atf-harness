/**
 * 权限分档单源（D90，owner 2026-10-29 裁定「方案一」）。
 *
 * 三档语义（**授权与提问是两件事，不得混同**）：
 *  1) `guarded`（未开完全权限）：审批卡照弹、问题卡照弹——授权与决策输入都归用户。
 *  2) `full-access`（完全权限档）：**只免审批卡**（谁能碰多远＝授权）；问题卡照弹——
 *     分组方案、增强倍数这类「决策输入」不是授权，免掉审批不等于替用户做决定。
 *  3) `unattended`（全新一档，预设 `atf-unattended` ＋ 完全权限两轴齐备）：
 *     审批卡与问题卡都不弹；需要用户决定的点由 **agent 自行判断**，落账标注
 *     `decided_by: agent`——**不得**因为没有弹卡就把「用户没决定」当默认值。
 *
 * 三档都建立在同一事实源上：`sandboxModeOf`（用户给的权限）＋`agentPresetOf`（会话形态）。
 * 判据只看 sandbox 值不看档位名（档位名可改、语义不可改）——与 trainingPreset 同源。
 *
 * ⚠ 边界：本文件只回答「谁能碰多远、能不能问人」，不回答「该问什么」。
 * 决策点清单归各工具面（见 constructionGate.ts 的构造参数确认）。
 */
import {
  DANGER_FULL_ACCESS_SANDBOX,
  agentPresetOf,
  sandboxModeOf,
  type ExecSessionFace,
  type ServiceCtxFace,
} from "./trainingPreset.js";

/** 权限三档（顺序＝授权从紧到松，档位只增不改语义）。 */
export type PermissionTier = "guarded" | "full-access" | "unattended";

/** 全自动档的预设 machine id（profile 层 preset 注册同名 id）。 */
export const ATF_UNATTENDED_PRESET = "atf-unattended";

/**
 * 当前会话的权限档。
 * - sandbox ≠ danger-full-access → `guarded`（预设不影响：没给完全权限就没人被免）；
 * - sandbox = danger-full-access 且预设 = 全自动 → `unattended`；
 * - 其余完全权限 → `full-access`（含没选预设的裸会话）。
 */
export const permissionTierOf = (ctx: ServiceCtxFace, exec: ExecSessionFace): PermissionTier => {
  if (sandboxModeOf(ctx, exec) !== DANGER_FULL_ACCESS_SANDBOX) return "guarded";
  return agentPresetOf(ctx, exec) === ATF_UNATTENDED_PRESET ? "unattended" : "full-access";
};

/** 审批卡是否可免（完全权限与全自动两档都免；guarded 档零变化）。 */
export const approvalBypassed = (tier: PermissionTier): boolean => tier !== "guarded";

/** 审批决定来源三值（切片 2·C1'——Approval Ledger decided_by 权威词表；非法值 fail-closed 在消费端校验）。 */
export type ApprovalDecidedBy = "auto" | "policy" | "owner";

/**
 * 档位 → 审批决定来源（切片 2·C2'，owner 确认口径）：可判定推导，零时间启发式——
 * 账面如实记「策略自动」而非「谁点的」事实。1112 真机实锚：38 次 2-27ms 自动放行
 * 全被记成 owner 批准=账面伪造；本推导修正该语义。
 *
 * @param tier 权限档（permissionTierOf 单源判定）。
 * @return auto=无人值守自动；policy=完全权限策略档自动放行；owner=guarded 档真提问卡等待。
 */
export const approvalDecidedByOf = (tier: PermissionTier): ApprovalDecidedBy =>
  tier === "unattended" ? "auto" : tier === "full-access" ? "policy" : "owner";

/**
 * 审批 reason 尾句按档位分支（切片 2·C3'：文案与行为一致——「仅 owner 可点」只在真提问档出现）。
 *
 * @param tier 权限档。
 * @return 尾句（带前导换行，拼接进既有 reason 主体）。
 */
export const approvalTailLineOf = (tier: PermissionTier): string =>
  tier === "guarded"
    ? "\n仅 owner 可点；执行方不得代点"
    : tier === "full-access"
      ? "\n按当前权限档位自动放行（审计落账 decided_by=policy，owner 未交互）"
      : "\n无人值守档自动放行（审计落账 decided_by=auto）";

/** 问题卡是否还能弹给人（只有全自动档不弹——全自动不是「不问」，是「agent 自己决定」。 */
export const questionsAllowed = (tier: PermissionTier): boolean => tier !== "unattended";

/** 决策来源标注（落账与回执共用词表——用户面只出中文，本词表只进机器面）。 */
export type DecisionMaker = "user" | "agent";

/** 决策来源 → 用户面文案（业务语言，零内部档位名）。 */
export const decisionMakerLine = (maker: DecisionMaker, what: string): string =>
  maker === "user" ? `${what}：你已确认` : `${what}：本次由我判断（无人确认）`;
