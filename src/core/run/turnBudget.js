import { TURN_BUDGET_WARN_RATIO } from "../session/constantsBudget.js";
/** 预算提示标记（渐进警告 nudge 文案前缀——budgetWarnedThisTurn 的判定锚）。 */
export const BUDGET_WARN_MARKER = "预算提示";
/** 自末次 turn/start 起的实质事件增量（跳过 compaction/repair/attempt；单位＝est tokens）。 */
export const turnEstimateTokensOf = (events) => {
    let start = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "turn/start") {
            start = i;
            break;
        }
    }
    let total = 0;
    for (let i = start; i < events.length; i += 1) {
        const event = events[i];
        if (event.type === "session/compaction" || event.type === "session/repair" || event.type === "assistant/attempt")
            continue;
        total += Math.ceil(JSON.stringify(event.payload).length / 2);
    }
    return total;
};
/** 本 turn 是否已注入过预算警告（末次 turn/start 后的 tool/result nudge 含标记即 true）。 */
export const budgetWarnedThisTurnOf = (events) => {
    let start = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        if (events[i].type === "turn/start") {
            start = i;
            break;
        }
    }
    for (let i = start; i < events.length; i += 1) {
        const event = events[i];
        if (event.type !== "tool/result")
            continue;
        const nudge = event.payload?.nudge;
        if (typeof nudge === "string" && nudge.includes(BUDGET_WARN_MARKER))
            return true;
    }
    return false;
};
/** 渐进警告注入（层二）：tool/result 落盘前按本拍增量判定——含本拍已达预算 80% 且本 turn
 *  未警告过 → payload.nudge 注入收敛提示（复用 D-f 既有 nudge 字段，零新增 payload 字段——
 *  两跳核最强形式：跳 1 schema 零改、跳 2 白名单零扩）。原地附加并返回同一对象（拼接语义：
 *  既有 nudge 在后，与本拍警告以「；」相连）。 */
export const withBudgetWarningNudge = (events, payload, budget) => {
    const candidateEstimate = turnEstimateTokensOf(events) + Math.ceil(JSON.stringify(payload).length / 2);
    if (candidateEstimate < budget * TURN_BUDGET_WARN_RATIO)
        return payload;
    const existing = typeof payload["nudge"] === "string" ? payload["nudge"] : undefined;
    const warning = `${BUDGET_WARN_MARKER}：本 turn 估算用量已达 ${Math.min(100, Math.floor((candidateEstimate / budget) * 100))}%（预算 ${String(budget)} est tokens），请尽快收口（给出最终答复或向用户汇报）。`;
    payload["nudge"] = existing !== undefined ? `${warning}；${existing}` : warning;
    return payload;
};
