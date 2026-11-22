/**
 * 无进展检测（D-f 批 D-f-4，2026-09-21）：控制面检测——模型推理之外观测。
 *
 * 范式与 loopState.ts 同款 durability 纪律：检测所需状态只由本侧事件流事实推导
 * （turn 内 tool/call + tool/result + approval/response），进程内增量维护、可由事件流
 * 重建；一切阈值常量模型不可见（session/constants.ts 纪律：不进 prompt / 工具参数 /
 * 决策对象）。
 *
 * 检测对象 = 动作指纹（工具名 + 规范化参数 digest）× 结果指纹（归一化结果 digest）：
 *   - exact repeat（同 pair 再次出现，期间无状态变化）→ 三档升级：nudge → 切断 → 收口；
 *   - no-op（executed 结果指纹与此前「不同动作」的结果指纹恒等，期间无状态变化）→ 同档处置；
 * 轮询豁免（白名单判据化）：同 pair 两次出现之间若发生过状态变化事实，视为合法重询、
 * 计数重置——轮询的合法性来自「中间发生过可能翻转被询状态的事实」，而非工具名枚举。
 * 切断作用域 = 本 turn（fail-closed 不解除，防换参绕行）；恢复 = turn 边界（检测器随
 * openTurnRecord 重建，与 deriveLoopStateFromEvents 的 turn/start 事实对齐）。
 */
import { createHash } from "node:crypto";
import { approvalParamsDigest, stableStringify } from "../tools/approvalKey.js";
/** 档 1 触发：同 pair / 同结果第 2 次出现（无中间状态变化）→ 回流附 nudge 指引。 */
export const NO_PROGRESS_NUDGE_THRESHOLD = 2;
/** 档 2 触发：第 3 次出现 → 该工具本 turn 切断（后续调用短路，不发桥接请求）。 */
export const NO_PROGRESS_CUT_THRESHOLD = 3;
/** 档 3 触发：本 turn 内第 2 个不同工具被切断 → turn 级收口（run 非终局）。 */
export const NO_PROGRESS_COLLAPSE_CUT_TOOLS = 2;
/** 状态变化事实来源（轮询豁免判据的单源常量，维护方式同 toolDefinition.GATE_LEGAL_IDS：
 *  一处定义、注释登记、PR 变更）。成功执行 = 可能翻转被询状态的事实。 */
export const POLLING_STATE_CHANGERS = ["atf_admit_data", "atf_data_admission_request"];
/** 静态豁免名单（初始空：当前 5 工具无一属纯轮询读）。未来确有纯轮询读工具时在此登记。 */
export const NO_PROGRESS_EXEMPT_TOOLS = [];
/** 切断回填的稳定原因码（工具结果层；机器可查）。 */
export const TOOL_CUT_REASON = "tool_cut_no_progress";
/** nudge 指引文案（回流 payload.nudge 载体；模型下一拍可见）。 */
export const NO_PROGRESS_NUDGE_NOTE = "控制面提示：该调用与此前调用重复且无新信息。请改用其他工具/路径、修正参数，或如实向用户说明情况；勿继续重复探查。";
/** 切断回填附注（payload.guidance 载体；模型与 TUI 可见）。 */
export const TOOL_CUT_NOTE = "该工具在本 turn 内因重复无进展已被切断：请改用其他工具或路径，或如实向用户说明情况；新 turn（新指令）自动恢复。";
export const actionFingerprint = (tool, params) => `${tool}:${approvalParamsDigest(params)}`;
/** 结果指纹：executed 取 canonical 结果载荷；回流类取（kind+稳定码）——同码同档归并。 */
export const resultFingerprint = (observation) => {
    const basis = observation.kind === "executed"
        ? `ok:${stableStringify(observation.result ?? null)}`
        : observation.kind === "rejected"
            ? `rej:${observation.reason ?? ""}`
            : observation.kind === "input_violation"
                ? `vio:${observation.reason ?? ""}`
                : `blk:${observation.blockReason ?? ""}`;
    return createHash("sha256").update(basis, "utf8").digest("hex");
};
/**
 * 每 turn 一个实例（openTurnRecord 重建 = 切断与计数的恢复语义）。
 * 线程模型：单进程决策循环串行调用，无并发。
 */
export class NoProgressDetector {
    /** 状态变化时钟（approval/response granted 与 POLLING_STATE_CHANGERS 成功执行各 +1） */
    seq = 0;
    /** pair → 出现计数（exact repeat 面） */
    pairs = new Map();
    /** executed 结果指纹 → 出现记录（no-op 面；actionFp 用于区分「不同动作同结果」） */
    executedFps = new Map();
    cutSet = new Set();
    cutForms = [];
    /** 状态变化事实登记（runner 在 approval/response granted 落盘与本类成功执行时调用）。 */
    noteStateChange() {
        this.seq += 1;
    }
    isCut(tool) {
        return this.cutSet.has(tool);
    }
    cutTools() {
        return [...this.cutSet];
    }
    /** 档 3 判定：本 turn 内已有 ≥2 个不同工具被切断。 */
    collapseReady() {
        return this.cutSet.size >= NO_PROGRESS_COLLAPSE_CUT_TOOLS;
    }
    /** 收口原因码（机器可查）：任一切断由 exact repeat 驱动 → same_call_repeat；否则 no_progress。 */
    collapseReason() {
        return this.cutForms.includes("repeat") ? "same_call_repeat" : "no_progress";
    }
    /**
     * 记录一次工具结果观测并给出升级裁决。调用时序（runner 侧）：本方法在结果取得后、
     * 回流 payload 构造前调用（nudge 文案需随本拍回流入模型上下文）；切断升级的收口检查
     * 在本拍结果回填之后进行（可观测性优先）。
     */
    record(tool, params, observation) {
        if (NO_PROGRESS_EXEMPT_TOOLS.includes(tool))
            return { tier: "none" };
        const actionFp = actionFingerprint(tool, params);
        const resultFp = resultFingerprint(observation);
        const now = this.seq;
        // —— exact repeat 面：pair 计数（两次出现之间有状态变化 ⇒ 合法重询，计数重置）
        const pairKey = `${actionFp}#${resultFp}`;
        const priorPair = this.pairs.get(pairKey);
        const repeatCount = priorPair !== undefined && now <= priorPair.lastSeq ? priorPair.count + 1 : 1;
        this.pairs.set(pairKey, { count: repeatCount, lastSeq: now });
        // —— no-op 面（仅 executed）：同结果指纹此前由「不同动作」产出且其间无状态变化
        let noopCount = 1;
        if (observation.kind === "executed") {
            const priorFp = this.executedFps.get(resultFp);
            noopCount = priorFp !== undefined && priorFp.actionFp !== actionFp && now <= priorFp.lastSeq ? priorFp.count + 1 : 1;
            this.executedFps.set(resultFp, { count: noopCount, lastSeq: now, actionFp });
        }
        // —— 三档裁决（取两面较高档；同档优先 repeat——更具体的形态）
        const tierOf = (count) => (count >= NO_PROGRESS_CUT_THRESHOLD ? "cut" : count >= NO_PROGRESS_NUDGE_THRESHOLD ? "nudge" : "none");
        const repeatTier = tierOf(repeatCount);
        const noopTier = observation.kind === "executed" ? tierOf(noopCount) : "none";
        const tier = repeatTier === "cut" || noopTier === "cut" ? "cut" : repeatTier === "nudge" || noopTier === "nudge" ? "nudge" : "none";
        const form = repeatTier === "none" ? "noop" : "repeat";
        // 状态变化事实登记：本拍自身若为状态变化源，登记供后续豁免判定（不影响本拍已算出的计数）
        if (observation.kind === "executed" && POLLING_STATE_CHANGERS.includes(tool))
            this.noteStateChange();
        if (tier === "none")
            return { tier: "none" };
        if (tier === "cut" && !this.cutSet.has(tool)) {
            this.cutSet.add(tool);
            this.cutForms.push(form);
            return { tier: "cut", form, tool };
        }
        return { tier, form };
    }
}
