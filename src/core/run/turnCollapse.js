/**
 * G1 拆解单元②（批㉞H-H3，沿门 1 设计稿「控制面三级处置」组件边界）：turn 级失败收口面。
 * 收口类型（TurnFailureSummary 族）/一句话文案表/阻塞说明素材提取/摘要构造器全部收口本单元——
 * 三级处置（nudge→cut→run_close）与 reject 环、budget、provider、length 五类收口共享同一构造，
 * 防 D-1 双份字面量漂移（原 runner 内共享构造器的单元化承接）。自 runner.ts 逐字迁出（零行为变化）。
 */
import { gapCardFor } from "./blockGuidance.js";
import { GATE_LEGAL_IDS } from "../tools/index.js";
/** 微补丁（2026-09-23）：provider 错误 detail 白名单提取——只取 status/body_excerpt（≤500
 *  再截断）/request_summary；request_body 永不进摘要/审计（大对象不落盘）。 */
export const providerErrorDetailOf = (error) => {
    if (typeof error.detail !== "object" || error.detail === null)
        return {};
    const detail = error.detail;
    const out = {};
    if (typeof detail["status"] === "number")
        out["status"] = detail["status"];
    if (typeof detail["body_excerpt"] === "string" && detail["body_excerpt"] !== "") {
        out["body_excerpt"] = detail["body_excerpt"].length > 500 ? `${detail["body_excerpt"].slice(0, 500)}…` : detail["body_excerpt"];
    }
    if (typeof detail["request_summary"] === "object" && detail["request_summary"] !== null && !Array.isArray(detail["request_summary"])) {
        out["request_summary"] = detail["request_summary"];
    }
    return out;
};
/** body_excerpt 首行（人读，≤limit；供收口行一眼判断）。 */
export const firstLineOf = (text, limit) => {
    const line = (text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "").trim();
    return line.length > limit ? `${line.slice(0, limit)}…` : line;
};
/** D-f 收口一句话提示（按 reason 取值；reject 径文案与 D-1 逐字一致，零回归）。 */
export const COLLAPSE_NOTES = {
    reject_loop_exhausted: "修正参数后输入新指令即可继续本会话；被拒调用与错误码见上（模型下一 turn 同样可见）",
    same_call_repeat: "检测到同参数重复调用无进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
    no_progress: "检测到重复动作无新进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
    budget_exhausted: "本轮预算已用完（运行护栏，非进度指标）：控制权已交还——可直接输入新指令继续，或先收窄任务；输入新指令即可继续本会话",
    provider_failure: "provider 决策失败已按 turn 收口：核对 provider 配置/网络后输入新指令即可继续本会话",
    // pi-ai 换库批 R1：length 分型收口——截断响应不作完整决策执行；降档或续跑（缺口卡同源）
    length_truncated: "模型响应被输出上限截断（finish_reason=length）：截断响应未执行、未入历史；可降低思考等级后重试，或输入新指令以既有历史继续本会话",
};
/** 流尾连续 provider_failure 收口轮数（含本拍——调用方从 1 起算；任何非该类收口即截断）。
 *  批 2.5 层三熔断升级的判据源（事件流纯推导——「流尾连续」天然复位，无跨 turn 可变状态）。 */
export const consecutiveProviderFailuresOf = (events) => {
    let consecutive = 1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event.type !== "turn/end")
            continue;
        const reason = event.payload?.failure_summary?.reason;
        if (reason === "provider_failure")
            consecutive += 1;
        else
            break;
    }
    return consecutive;
};
/** D-f：turn 级收口摘要构造器（四类触发同源产出，防 D-1 双份字面量漂移）。
 *  reject 径输出与 D-1 逐字兼容（note 文案不变、gate_ids 逻辑不变、rejected/limit 恒填）。
 *  pi-ai 换库批：gapCardOverride 供 length 分型收口显式出卡（不经 material-gap 推导）。 */
export const buildCollapseSummaryOf = (state, input) => {
    const gap = state.turnLastMaterialGap;
    const gapCard = input.gapCardOverride ?? (gap !== undefined ? gapCardFor(gap.tool, gap.reason) : undefined);
    return {
        reason: input.reason,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.rejected !== undefined ? { rejected: input.rejected } : {}),
        blocked_description: {
            stuck_at: input.stuckAt,
            turns_used: state.turnsOpened,
            steps_used: state.turnStepCount,
            ...(input.providerError !== undefined && Object.keys(input.providerError).length > 0 ? { provider_error: input.providerError } : {}),
        },
        ...(gapCard !== undefined ? { gap_card: gapCard } : {}),
        ...(input.cutTools !== undefined && input.cutTools.length > 0 ? { cut_tools: [...input.cutTools] } : {}),
        ...(input.crossTurn !== undefined ? { cross_turn: input.crossTurn } : {}),
        hint: {
            ...(state.turnRejectCalls.some((call) => call.tool === "atf_gate") ? { gate_ids: [...GATE_LEGAL_IDS] } : {}),
            note: COLLAPSE_NOTES[input.reason],
        },
    };
};
