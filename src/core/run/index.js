/**
 * S5 run 层公开出口。冒烟命令与测试只从这里 import。
 */
export { FactScanResolver } from "./factScanResolver.js";
export { REJECT_LOOP_LIMIT } from "./constants.js";
export { ScenarioRunner, evaluateExpectations, resolveRunExitCode, runError, } from "./runner.js";
export { createApprovalTrackHandler, readStreamMaxId, DENIAL_LOOP_LIMIT, } from "./approvalTrack.js";
export { buildSwitchPayload, checkSwitchBoundary, verifyDigestContinuity, } from "./providerSwitch.js";
export { LOOP_STOP_REASONS, resolveExhaustionStop } from "./stopReason.js";
export { buildApprovalBackfill, buildDecisionBackfill } from "./backfill.js";
export { injectMemoryEntries, } from "./memoryInjection.js";
export { deriveLoopStateFromEvents } from "./loopState.js";
export { NoProgressDetector, NO_PROGRESS_COLLAPSE_CUT_TOOLS, NO_PROGRESS_CUT_THRESHOLD, NO_PROGRESS_EXEMPT_TOOLS, NO_PROGRESS_NUDGE_NOTE, NO_PROGRESS_NUDGE_THRESHOLD, POLLING_STATE_CHANGERS, TOOL_CUT_NOTE, TOOL_CUT_REASON, actionFingerprint, resultFingerprint, } from "./noProgress.js";
export { CrossTurnNoProgressDetector, CROSS_TURNS_DEFAULT, CROSS_TURNS_OVERLAP_PERMILLE_DEFAULT, CROSS_TURN_NUDGE_NOTE, executionStateChange, resolveCrossTurnNoProgressConfig, } from "./noProgressCrossTurn.js";
export { BLOCK_CODE_GUIDANCE, gapCardFor, guidanceFor, guidanceLineFor, integrityGateBlockedGuidance, isMaterialGapCode, } from "./blockGuidance.js";
export { buildAnswerPayload, channelToApprovalVerdict, CHANNEL_ACTOR, CHANNEL_VERDICTS, diagnoseOrphanTurn, listPendingApprovals, ORPHAN_RECOVERED_REASON, ORPHAN_RECOVERY_ACTOR, ORPHAN_RECOVERY_DENY_REASON, ORPHAN_RECOVERY_ORIGIN, parseResumeArgs, parseSessionStream, readSessionStream, recoverOrphanTurn, resolveAnswerTarget, sessionLogPathFor, } from "./resume.js";
