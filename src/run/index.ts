/**
 * S5 run 层公开出口。冒烟命令与测试只从这里 import。
 */
export { SurfaceScanResolver, type SurfaceScanTransport } from "./surfaceScanResolver.js";
export {
  ScenarioRunner,
  evaluateExpectations,
  resolveRunExitCode,
  runError,
  type BranchOutcome,
  type BranchRunReport,
  type CredentialIndeterminateReport,
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
