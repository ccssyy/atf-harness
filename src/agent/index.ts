/**
 * src/agent——ATF KIE Training Agent 新进程（方案丙，批 P）。
 *
 * 门 1a spike 面：faux streamFn／DeepSeek 装配（一期 wire 经验复用）／工具挂接（单源投影
 * 经桥）／审批 before_tool hook（账本闸继承）／session 树镜像与孤儿恢复／场景驱动。
 * 门 1b TEM 面：EvidenceEvent 镜像（after_tool）／ExperienceCase·PatternClaim 存储／
 * 检索注入 PoC（transform_context）。
 * 依赖方向：agent → {core/tools, bridge, llm}（与三外壳同级——core 的消费者，core 不反依）。
 */
export { createFauxStreamFn, fauxAssistantMessage, fauxFinalAnswer, fauxMessageWithToolCalls, type FauxStreamFn } from "./fauxStream.js";
export { assembleProviderModel, createProviderStreamFn, createDeepSeekStreamFn, type ProviderStreamFnConfig } from "./providerStreamFn.js";
export { buildSpikeAgentTools, spikeToolDefinitions, SPIKE_TOOL_NAMES, toAtfAgentTool, spikeRequiresApproval, toolDefinitionFor, type AtfAgentToolDeps, type SpikeBridgeTransport } from "./atfAgentTools.js";
export { createApprovalBeforeToolCall, createGateLock, type ApprovalAuditEntry, type ApprovalHookDeps, type GateLock } from "./approvalHook.js";
export {
  FILE_TOOL_DEFINITIONS,
  FILE_TOOL_NAMES,
  FILE_TOOL_MAX_BYTES,
  BASH_READONLY_COMMANDS,
  bashCommandRequiresApproval,
  buildFileAgentTools,
  resolveFileToolRoots,
  resolveWhitelistedPath,
  toFileAgentTool,
  type FileToolHost,
} from "./fileTools.js";
export {
  createDeferredSubtaskRegistry,
  DEFERRED_POLL_INTERVAL_MS_DEFAULT,
  DEFERRED_POLL_MAX_POLLS_CEILING,
  DEFERRED_POLL_MAX_POLLS_DEFAULT,
  type DeferredPollOutcome,
  type DeferredSubtaskHandle,
  type DeferredSubtaskRegistry,
  type DeferredSubtaskStatus,
} from "./deferredFace.js";
export {
  buildDeferredAgentTools,
  createDeferredToolSet,
  DEFERRED_TOOL_NAMES,
  type DeferredToolDeps,
} from "./deferredTools.js";
export {
  createChildInstructionRunner,
  createDispatchParallelTrainingSubtaskTool,
  createDispatchTrainingSubtaskTool,
  runChildSubtask,
  DISPATCH_PARALLEL_DEFAULT_CONCURRENCY,
  DISPATCH_PARALLEL_MAX_SUBTASKS,
  type SubagentDeps,
  type SubtaskResult,
} from "./subagent.js";
export { planRunBoundary, planReconcile, type BoundaryPlan, type PlanBoundaryInput, type ReconcilePlan } from "./driveFace.js";
export {
  NodeFsAdapter,
  createJsonlSessionRepo,
  detectOrphanTip,
  ensureMainBranch,
  mirrorMessage,
  readBranchEntries,
  recoverFromOrphan,
  transcriptFromEntries,
  type SessionLike,
} from "./sessionMirror.js";
export { runGate1aSpike, type SpikeDeps, type SpikeResult } from "./spike.js";
export { maxTurnsFromEnv, resolveV1ExitCode, createBudgetFinishTurn, type V1RunOutcome } from "./budget.js";
export { parseCliArgs, runCli, runV1Headless, type CliArgs, type V1HeadlessDeps } from "./cli.js";
export { loadFauxScript, parseFauxScript, createScriptedStreamFn, type FauxScriptStep } from "./fauxScript.js";
export {
  buildEvidenceEvent,
  captureFactRef,
  envFingerprint,
  evidenceParamsDigest,
  mirrorEvidenceEvent,
  scanEvidenceEvents,
  EVIDENCE_CUSTOM_TYPE,
  RESULT_SUMMARY_CAP_CHARS,
  type BuildEvidenceEventInput,
  type EvidenceEvent,
} from "./tem/evidence.js";
export {
  appendPatternClaim,
  ensureTemBranch,
  queryMechanisms,
  readExperienceCase,
  readPatternClaims,
  writeExperienceCase,
  type ExperienceCase,
  type MechanismQuery,
  type PatternClaim,
  type Scored,
} from "./tem/store.js";
export {
  buildTemSection,
  createTemAfterToolMirror,
  createTemTransformContext,
  extractQuerySignals,
  retrieveTemEntries,
  scoreEvidence,
  TEM_INJECTION_QUOTA,
  TEM_SECTION_HEADER,
  tokenize,
  type ScoredEvidence,
  type TemQuerySignals,
} from "./tem/retrieval.js";
export { runGate1bPoc, type Gate1bPocResult } from "./tem/poc.js";
