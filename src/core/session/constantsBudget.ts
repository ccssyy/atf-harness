/**
 * 模型面体量预算常量与解析器（L1c 提前批 A1.5，2026-09-22）。
 *
 * 放行件 v7（`b2ae6b36…` ★段）解冻配套的**唯一新增常量文件**——把「模型上下文窗口」
 * 折算为两个预算，供两径同源消费：
 *  ① compaction 触发水位（planCompaction 的 trigger tokens）——投影径（compaction.ts
 *     → projectContext）与审计径（sessionLog.ts:463）共用同一解析，禁只改一处（同源铁律）；
 *  ② 单条工具结果摘要的字符上限（adapter 成功结构化体；tokens→chars 换算 ×2，与
 *     TOKEN_ESTIMATE_DIVISOR 同一保守估算口径，注明于 resolveSummaryResultCapChars）。
 *
 * 设计依据：设计要点 v3 §(一).3（一步到位：水位＝context_window − reserve）＋§(八) 主流对标
 * （Pi 窗口−reserve／CC `MAX_MCP_OUTPUT_TOKENS` 25K tokens cap＋25K/200K=12.5% 比例纪律／
 * arXiv:2608.26218 harness 配置 ≈ 换模型）。reserve＝max(压缩摘要输出预算, 单条绝对上限)
 * ＝max(20K, 25K)＝25K tokens（A1.5.2 推导式；20K 为 CC 摘要预算口径，owner 指引）。
 *
 * 行为中立回退（三铁律之二）：未配置 context_window（holder 为 null）时两解析器返回既有
 * 常量值（触发 24_000／摘要 6_000 字符），与历史行为逐字节一致；且水位/上限**只升不降**
 * （窗口折算低于现值时维持现值——数据驱动只用于放开方向，任何配置下不比历史更激进）。
 * 纯度：planCompaction 仍是 (events, triggerTokens) 的纯函数；holder 仅承载进程级配置，
 * 外壳（TUI / trial）在 runBranch 前注入一次（providerConfig 解析出的 context_window），
 * 运行期只读——同一进程内 live 与 replay 折算一致。
 */
import { COMPACTION_TRIGGER_TOKENS } from "./constants.js";

/** 压缩摘要输出预算（tokens；参照 Claude Code compact 摘要预算 20K 口径，owner 指引）。 */
export const SUMMARY_COMPACT_BUDGET_TOKENS = 20_000;

/** 单条工具结果绝对上限（tokens；沿 CC `MAX_MCP_OUTPUT_TOKENS` 缺省 25K 口径）。 */
export const SUMMARY_RESULT_CAP_TOKENS = 25_000;

/** compaction 触发水位的 reserve（A1.5.2 推导式：max(摘要输出预算, 单条绝对上限)）。 */
export const COMPACTION_RESERVE_TOKENS = Math.max(SUMMARY_COMPACT_BUDGET_TOKENS, SUMMARY_RESULT_CAP_TOKENS);

/** 比例上限：context_window × 12.5%（与 CC 25K/200K 比例同构，设计要点 §(八) 表一）。 */
export const SUMMARY_RESULT_RATIO = 0.125;

/** 单条摘要上限的未配置回退（字符；设计要点 §(一).2 丙案取值）。 */
export const SUMMARY_RESULT_FALLBACK_CHARS = 6_000;

/** tokens → chars 换算（×2；与 compaction 估算 TOKEN_ESTIMATE_DIVISOR=2 同一保守口径）。 */
export const TOKENS_TO_CHARS = 2;

/** 保键降级参数：超限时顶层长字符串值截至 512 字符＋余量标记（键集与结构恒保全）。 */
export const SUMMARY_STRING_VALUE_MAX_CHARS = 512;
/** 保键降级参数：超限时顶层数组保留前 50 项＋计数标记。 */
export const SUMMARY_ARRAY_MAX_ITEMS = 50;

// ---------------------------------------------------------------------------
// 进程级 context_window 注入位（外壳 → core 的唯一配置通道；runner seam 与审计径同源读取）
// ---------------------------------------------------------------------------

let activeContextWindowTokens: number | null = null;

/** 外壳在 runBranch 前注入（providerConfig 解析的 model.context_window；未配置传 null）。 */
export const setCompactionContextWindow = (tokens: number | null): void => {
  activeContextWindowTokens = tokens;
};

/** 当前生效的 context_window（tokens；null = 未配置）。 */
export const getCompactionContextWindow = (): number | null => activeContextWindowTokens;

/** 触发水位解析（纯函数）：null → 既有常量 24K（逐字节回退）；否则 max(窗口−reserve, 24K)。 */
export const resolveCompactionTriggerTokens = (contextWindowTokens: number | null): number => {
  if (contextWindowTokens === null) return COMPACTION_TRIGGER_TOKENS;
  return Math.max(contextWindowTokens - COMPACTION_RESERVE_TOKENS, COMPACTION_TRIGGER_TOKENS);
};

/** 进程级生效触发水位（两径同源读这个：runner seam 与 sessionLog 审计径禁各算各的）。 */
export const compactionTriggerTokens = (): number => resolveCompactionTriggerTokens(activeContextWindowTokens);

/**
 * 单条工具结果摘要字符上限（纯函数）：min(窗口×12.5%, 25K tokens) × 2 换算字符；
 * 未配置回退 6_000 字符；折算结果只升不降（低于回退值时维持回退值——小窗口不比历史更激进）。
 */
export const resolveSummaryResultCapChars = (contextWindowTokens: number | null): number => {
  if (contextWindowTokens === null) return SUMMARY_RESULT_FALLBACK_CHARS;
  const ratioCapTokens = Math.floor(contextWindowTokens * SUMMARY_RESULT_RATIO);
  const capTokens = Math.min(ratioCapTokens, SUMMARY_RESULT_CAP_TOKENS);
  return Math.max(capTokens * TOKENS_TO_CHARS, SUMMARY_RESULT_FALLBACK_CHARS);
};

// ---------------------------------------------------------------------------
// 批 2.5 §二：turn 级 token 预算（去"32 步"形态的四层之一；放行件 `9a5df272…` §一 区 5）
// **单位标注（门 2 处置②）**：本层与 fuse 的单位＝**est tokens**（payload chars/2，与
// compaction 估算同源同除数）；A1 单条摘要上限（resolveSummaryResultCapChars）的单位＝
// **chars**。两者数值可能同为 6000，但单位与作用域不同——turn **增量**预算（本 turn 可
// 烧多少）vs 单条**消息**上限（一条回流最长多少）。文档与报告一律带单位表述。
// ---------------------------------------------------------------------------

/** 渐进警告水位：turn 预算的 80% 触达即向模型注入收敛提示（经 tool/result nudge 既有通道）。 */
export const TURN_BUDGET_WARN_RATIO = 0.8;

/** turn 预算默认推导分母：数据驱动缺省＝compaction 触发水位的 1/2（走查修复小批 §二.1
 *  放宽：原 1/4 过紧——模型面常规收口即本径，1M 窗应有 500k est tokens/turn 量级）。 */
export const TURN_BUDGET_WATERMARK_DIVISOR = 2;

/** 兜底保险丝缺省（**步**数单位——防 bug 死循环的最后防线，正常不触达；run options 可配）。 */
export const TURN_HARD_STEP_FUSE_DEFAULT = 200;

let explicitTurnTokenBudget: number | null = null;

/** 外壳注入 llm.json 旋钮（turn_token_budget，est tokens；null＝未配置走数据驱动缺省）。 */
export const setTurnTokenBudget = (tokens: number | null): void => {
  explicitTurnTokenBudget = tokens;
};

/** turn 预算解析（纯函数）：显式配置 > 数据驱动 floor(触发水位/2)；未配置窗口 → 12_000 est tokens。 */
export const resolveTurnTokenBudget = (contextWindowTokens: number | null, explicit?: number | null): number => {
  if (explicit !== undefined && explicit !== null) return explicit;
  return Math.floor(resolveCompactionTriggerTokens(contextWindowTokens) / TURN_BUDGET_WATERMARK_DIVISOR);
};

/** 进程级生效 turn 预算（est tokens；runner 判定与外壳注入同源——A1.5.2 holder 同款模式）。 */
export const turnTokenBudget = (): number => resolveTurnTokenBudget(activeContextWindowTokens, explicitTurnTokenBudget);
