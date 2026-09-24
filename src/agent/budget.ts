/**
 * 丙 v1（批 P）——预算护栏 hook 化＋headless 终局闭集。
 *
 * 预算（二期门 1 适配表：「turn 数 → finishTurn 计数」「预算耗尽从收口语义降格为 hook
 * 返回 end」）：createBudgetFinishTurn 每完成 assistant turn 计一次，达 max_turns 且
 * 循环将继续时 {action:"end"}。env 可配沿 runner 先例：ATF_LOOP_MAX_TURNS 正整数生效、
 * 未设/空/非法 fail-closed 回退缺省（8）——同 env 变量名（跨线一致，不引入第二口径）。
 *
 * 终局闭集（v1 口径）：词汇对齐 runner 七态（core/run/runner.ts BranchOutcome，本线
 * 本地定义不 import runner 代码）；差异面如实登记——预算耗尽在 runner 归 turn_failed/
 * failed 类，丙 v1 立显式态 budget_exhausted（headless 如实退出 1）。suspended/aborted
 * 词汇预留（问答轨门 2+ 落位，届时 75/79）。
 */
import type { AgentTurnDecision, AgentTurnContext } from "@earendil-works/pi-agent-core";

/** 丙 v1 终局闭集（穷尽互斥）。 */
export type V1RunOutcome =
  | { kind: "completed" }
  | { kind: "approval_missing"; tool: string; reason: string }
  | { kind: "budget_exhausted"; turns_used: number; max_turns: number }
  | { kind: "failed"; error: string };

/** headless 退出码（ADR-07 锚不挪用：0=completed；78=approval_missing；其余=1；
 *  75/79 预留问答轨）。单一出口防语义漂移。 */
export const resolveV1ExitCode = (outcome: V1RunOutcome): 0 | 1 | 78 => {
  switch (outcome.kind) {
    case "completed":
      return 0;
    case "approval_missing":
      return 78;
    case "budget_exhausted":
    case "failed":
      return 1;
  }
};

/** ATF_LOOP_MAX_TURNS 解析（正整数生效；未设/空/非法 fail-closed 回退缺省 8——
 *  runner loopBudgetEnv 同语义；生效值回填 out.rejects 供终局 payload）。 */
export const maxTurnsFromEnv = (env: NodeJS.ProcessEnv = process.env, fallback = 8): number => {
  const raw = env["ATF_LOOP_MAX_TURNS"];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
};

export interface BudgetFinishTurnDeps {
  maxTurns: number;
  /** 预算触发的写入位（触发时置 budget_exhausted——终局判定单一来源）。 */
  outcomeBox: { current: V1RunOutcome | undefined };
}

/** finishTurn 预算 hook（Agent finishTurn 直用）：turn 计数达上限且循环将继续时终止。
 *  返回 undefined = 正常调度（预算未到）。 */
export const createBudgetFinishTurn =
  (deps: BudgetFinishTurnDeps) =>
  (turn: AgentTurnContext): AgentTurnDecision | undefined => {
    const hadToolCalls = turn.toolResults.length > 0 || turn.message.content.some((block) => block.type === "toolCall");
    if (!hadToolCalls) return undefined; // 收束 turn（final_answer）——预算不拦截正常完成
    deps.outcomeBox.current ??= undefined;
    const turnsUsed = countTurns(turn);
    if (turnsUsed >= deps.maxTurns) {
      deps.outcomeBox.current = {
        kind: "budget_exhausted",
        turns_used: turnsUsed,
        max_turns: deps.maxTurns,
      };
      return { action: "end" };
    }
    return undefined;
  };

/** 已完成 turn 计数（context.messages 中 assistant 消息数——转录面真相，无本地漂移）。 */
const countTurns = (turn: AgentTurnContext): number =>
  turn.context.messages.filter((message) => (message as { role?: string }).role === "assistant").length;
