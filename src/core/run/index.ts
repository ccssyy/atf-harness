/**
 * S5 run 层公开出口。冒烟命令与测试只从这里 import。
 */
export { FactScanResolver, type FactScanTransport } from "./factScanResolver.js";
export { REJECT_LOOP_LIMIT } from "./constants.js";
export {
  ScenarioRunner,
  evaluateExpectations,
  resolveRunExitCode,
  runError,
  type BranchOutcome,
  type BranchRunReport,
  type CredentialIndeterminateReport,
  type PeerSpawnDescriptor,
  type RunBranchOptions,
  type RunError,
  type RunErrorCode,
  type SwitchRecord,
  type ToolResultPayload,
  type TurnAttribution,
} from "./runner.js";
export {
  createApprovalTrackHandler,
  readStreamMaxId,
  DENIAL_LOOP_LIMIT,
  type ApprovalHandler,
  type ApprovalStub,
  type ApprovalStubResponse,
  type ApprovalTrackDeps,
  type ApprovalTrackInput,
  type ApprovalVerdict,
} from "./approvalTrack.js";
export {
  buildSwitchPayload,
  checkSwitchBoundary,
  verifyDigestContinuity,
  type ProviderSwitchBlock,
  type ProviderSwitchBlockReason,
  type ProviderSwitchPayload,
} from "./providerSwitch.js";
export { LOOP_STOP_REASONS, resolveExhaustionStop, type LoopStopReason } from "./stopReason.js";
export { buildApprovalBackfill, buildDecisionBackfill, type DecisionBackfill } from "./backfill.js";
export {
  injectMemoryEntries,
  type MemoryInjectionOutcome,
  type MemoryReadEntry,
  type MemoryReadInjector,
} from "./memoryInjection.js";
export { deriveLoopStateFromEvents, type LoopStateSnapshot, type LoopTurnState } from "./loopState.js";
export {
  buildAnswerPayload,
  channelToApprovalVerdict,
  CHANNEL_ACTOR,
  CHANNEL_VERDICTS,
  listPendingApprovals,
  parseResumeArgs,
  parseSessionStream,
  readSessionStream,
  resolveAnswerTarget,
  sessionLogPathFor,
  type ChannelVerdict,
  type PendingApproval,
  type ResumeChannelError,
  type ResumeCliArgs,
} from "./resume.js";
