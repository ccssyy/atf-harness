/**
 * run 域常量（快修批 D-a 门 1 裁定 R-4：run 侧常量位，与 approvalTrack.DENIAL_LOOP_LIMIT
 * 同域同先例，不落 session/constants.ts）。
 */

/** 单 turn 内连续「对端业务拒绝/入参违规」回流上限（D-a R-2）：模型面决策循环中，
 *  rejected/input_violation 连续达阈值 → turn 终局 failed（reject_loop_exhausted），
 *  防模型修参死循环；任何非回流类工具结果（executed/blocked）即打断连续计数。
 *  LOOP_MAX_STEPS_PER_TURN 仍为总步数兜底。 */
export const REJECT_LOOP_LIMIT = 3;
