/**
 * atf-core 公开出口（G2 迁入）。
 *
 * 迁入来自 `src/core/workspace` 的 A 类 36 文件（方案 §3.2）。迁移＝搬运：
 * 除三个需改接口的文件（t0Guard / skillCatalog / sessionBindings）外，
 * 其余导出与源文件逐项一致。
 *
 * 两个指向 src 的 re-export 是**迁移期过渡面**（方案已判 B 类删除，本批不动 src）：
 * - scratchExec：index 原本从它导出 20 项，现直连 src 原文件，等 G5 走 vendor fs/bash；
 * - 其余 33 个纯领域文件无包外依赖。
 */
export {
  workspaceError,
  type PromoteBlock,
  type PromoteBlockReason,
  type PromoteOutcome,
  type WorkspaceError,
  type WorkspaceErrorCode,
} from "./errors.js";
export {
  CATALOG_FILENAME,
  CATALOG_SCHEMA_VERSION,
  loadCatalog,
  saveCatalog,
  validateCatalogEntry,
  validateCatalogFile,
  type CatalogEntry,
  type CatalogFile,
} from "./catalog.js";
export {
  PROVENANCE_FILENAME,
  REPRODUCE_META_SUFFIX,
  SESSION_LOG_FILENAME,
  RunWorkspace,
  readRunProvenance,
  safeScratchPath,
  type ProvenanceInput,
  type ReproduceMeta,
  type WorkspaceStatus,
} from "./runWorkspace.js";
export {
  MAX_REPRODUCE_STDOUT_BYTES,
  REPRODUCE_TIMEOUT_MS,
  promoteArtifact,
  sha256Hex,
  type PromoteOptions,
} from "./promote.js";
export {
  T0_REF_FORBIDDEN,
  guardT0Append,
  isScratchReference,
  isT0RefBlock,
  scanT0Refs,
  t0AuditSink,
  t0BlockOf,
  type GuardedAppendOutcome,
  type T0AppendPort,
  type T0DomainRef,
  type T0EventShape,
  type T0RefBlock,
  type T0Violation,
} from "./t0Guard.js";
export {
  buildScratchExecEnv,
  ensureExecDirs,
  findBash,
  findPython3,
  guardScratchArgv,
  guardedScratchWrite,
  LAUNCH_WAIT_MS_DEFAULT,
  readLaunchState,
  resolveScratchTmpdir,
  runLaunchScript,
  runScratchCommand,
  scanLaunchReady,
  SCRATCH_EXEC_STDERR_TAIL_BYTES,
  SCRATCH_EXEC_STDOUT_CAP_BYTES,
  SCRATCH_EXEC_TIMEOUT_MS_DEFAULT,
  SCRATCH_WRITE_MAX_BYTES,
  type ArgvGuardVerdict,
  type LaunchReady,
  type ScratchRunOutcome,
} from "../../../../src/core/workspace/scratchExec.js";
export {
  buildLabelQcResolveParams,
  checkClassShort,
  DISPOSITIONS_BY_CHECK_CLASS,
  labelQcCardKey,
  LABEL_QC_CHECK_CLASSES,
  LABEL_QC_DISPOSITIONS,
  pendingItemsOf,
  readLabelQcReport,
  readResolvedItemIds,
  readSliceImageRef,
  REQUIRED_DECISION_FIELDS,
  resolveWorkspaceRef,
  type LabelQcCandidate,
  type LabelQcCheckClass,
  type LabelQcDecisionDraft,
  type LabelQcDisposition,
  type LabelQcEvidence,
  type LabelQcItem,
  type LabelQcReportFile,
} from "./labelQc.js";
export {
  BINDINGS_HISTORY_MAX,
  BINDINGS_SCHEMA_VERSION,
  SESSION_BINDINGS_TABLE,
  SESSION_BINDINGS_UNIT,
  SESSION_BINDINGS_UNIT_VERSION,
  bindSessionRun,
  bindSessionRunInto,
  enumerateBindingCandidates,
  fileSessionBindingStore,
  kvUnitSessionBindingStore,
  migrateFromRunBindings,
  migrateFromRunBindingsInto,
  nextBoundRecord,
  nextUnboundRecord,
  readSessionBinding,
  readSessionBindingFrom,
  resolveActiveRun,
  resolveActiveRunWith,
  resolveBindingsHome,
  sessionBindingsPathOf,
  sessionBindingsUnitDescriptor,
  unbindSession,
  unbindSessionIn,
  type ActiveRunResolution,
  type BindingCandidateEntry,
  type KvUnitPort,
  type ResolveActiveRunOptions,
  type SessionBindingHistoryEntry,
  type SessionBindingSource,
  type SessionBindingStore,
  type SessionBindingsFile,
  type SessionRunBindingRecord,
  type UnboundReason,
} from "./sessionBindings.js";

// ---------------------------------------------------------------- G3 消费面补全
// atf-tools 迁移后需要而原 index 未转发的符号（原先经深路径跨包引用，绕过包边界）。
// 符号清单由 tsc 的「no exported member」报错机械提取；类型走 export type
//（tsconfig 开 verbatimModuleSyntax，混用会报 TS1205）。

export {
  evalAgentRecommend,
} from "./agentRecommend.js";

export type {
  RecommendVerdict,
} from "./agentRecommend.js";

export {
  appendLedgerAuditComment,
  checkApprovalLedgerStartup,
  ledgerEnvPrefixForShell,
  shellSingleQuoted,
} from "./approvalLedger.js";

export {
  ASSEMBLY_ROLES,
  CONFIDENCE_WORD,
  MISSING_IMPACT,
  ROLE_BUSINESS,
  confidenceBandOf,
  needsUserConfirmation,
  readAssemblyReport,
  renderAssemblyCardDetail,
  renderAssemblySummaryLine,
  renderAttachmentsMarkdown,
} from "./attachmentsReport.js";

export type {
  AssemblyReport,
  AssemblyRole,
} from "./attachmentsReport.js";

export {
  fieldNameMapOf,
  readExperimentGrouping,
  renderGroupingSection,
} from "./experimentGrouping.js";

export {
  humanizeKernelError,
  scanKernelErrorFace,
} from "./kernelErrorFace.js";

export {
  parseTrainerLine,
  startLossIngest,
} from "./lossIngest.js";

export {
  scanLocalModels,
} from "./modelInventory.js";

export {
  buildRunCandidates,
} from "./runDisplay.js";

export {
  appendBinding,
  readNumTrainEpochs,
  resolveSessionRunWorkspace,
  writeProgress,
} from "./runFacts.js";

export {
  canonicalRunDirOf,
  flatRunDirNames,
  isValidRunId,
  resolveRunDir,
  resolveRunFile,
  resolveRunSubdir,
  runCandidateDirs,
  runFileCandidates,
  runSubdirCandidates,
  sessionWorkspaceSlug,
  workspaceOfRunDir,
} from "./runLayout.js";

export {
  SEGMENT_FACT_BY_KERNEL_STAGE,
  appendSegmentFact,
} from "./segmentFacts.js";

export {
  CLAMP_DOMAINS,
  FIXED_SMART_DEFAULTS,
  SMART_DEEPSPEED_DEFAULT,
  TRAINING_PIN_CONSTANTS,
  checkTokenBudget,
  clampCutoffLen,
  clampEpochs,
  clampImageMaxPixels,
  clampLearningRate,
  clampLoraRank,
  clampNegativeRatio,
  defaultBaseModelPath,
  deriveGradAccum,
  detectAvailableGpuCount,
  guardNprocAntiPatterns,
  kernelBsDefaultOf,
  loraAlphaFor,
} from "./smartDefaults.js";

export {
  evalOrchSessionBase,
  probeSession,
  resolveLaunchSessionName,
  tmuxCommand,
  tmuxTrainingEvidenceFor,
  trainingSessionBase,
} from "./tmuxLiveness.js";

export type {
  SessionProbe,
} from "./tmuxLiveness.js";

export {
  appendNotification,
} from "./trainProbe.js";

export {
  latestCheckpointOf,
  readTrainingCompletion,
  readTrainingExitCode,
  readTrainingStartedAt,
  writeTrainingCompletion,
  writeTrainingStartedAt,
} from "./trainingCompletion.js";

export {
  parsePreflightReport,
  readLaunchKpi,
  recordPreflightAt,
  renderPreflightFace,
} from "./trainingPreflight.js";

export type {
  PreflightDecisions,
  PreflightReport,
} from "./trainingPreflight.js";

export {
  buildTrainingPromptPreview,
  renderTrainingPromptPreviewBlock,
} from "./trainingPromptPreview.js";

// ── 清源补齐（2026-11-23）──────────────────────────────────────────
// 原 src/core/workspace 的 34 个副本已删除，正本全部在此。以下为
// 整体转出，保证消费方按符号名取用时无遗漏（G2 具名导出曾漏多个）。
export * from "./agentRecommend.js";
export * from "./approvalLedger.js";
export * from "./atfBootHealth.js";
export * from "./attachmentsReport.js";
export * from "./catalog.js";
export * from "./configBlocks.js";
export * from "./controlledEnv.js";
export * from "./errors.js";
export * from "./evalProgressTrack.js";
export * from "./evalServiceHealth.js";
export * from "./experimentGrouping.js";
export * from "./gpuProbe.js";
export * from "./kernelErrorFace.js";
export * from "./labelQc.js";
export * from "./lossIngest.js";
export * from "./modelInventory.js";
export * from "./oomFallback.js";
export * from "./promote.js";
export * from "./result.js";
export * from "./runDisplay.js";
export * from "./runFacts.js";
export * from "./runGuard.js";
export * from "./runLayout.js";
export * from "./runSubdirs.js";
export * from "./runWorkspace.js";
export * from "./segmentFacts.js";
export * from "./sessionBindings.js";
export * from "./smartDefaults.js";
export * from "./t0Guard.js";
export * from "./tmuxLiveness.js";
export * from "./trainNoticeTrack.js";
export * from "./trainObsSync.js";
export * from "./trainProbe.js";
export * from "./trainingCompletion.js";
export * from "./trainingPreflight.js";
export * from "./trainingPromptPreview.js";

// ── 从 src/webui 迁入（2026-11-23：领域资产归 packages，src 清空）──
export * from "./gpuQueue.js";
export * from "./readOnlyTools.js";
export * from "./settings.js";
export * from "./storageSettings.js";
export * from "./configConfirm.js";

// ── 从 src/core/tools 迁入（2026-11-23）──
export * from "./toolErrors.js";
export * from "./canonical.js";
export * from "./approvalKey.js";
export * from "./approvalCopy.js";
export * from "./ledgerGate.js";
export * from "./methodOverrides.js";
export * from "./registry.js";
export * from "./executor.js";
export * from "./toolDefinition.js";
export * from "./workspaceTools.js";

// ── 从 src/core 迁入（2026-11-23）──
export * from "./canonicalDigest.js";
export * from "./confirmRequest.js";
