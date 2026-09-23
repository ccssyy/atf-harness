/**
 * S4 工作区层公开出口。后续 slice（S5 冒烟）只从这里 import。
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
  GuardedSessionLog,
  T0_REF_FORBIDDEN,
  isScratchReference,
  isT0RefBlock,
  type GuardedAppendOutcome,
  type GuardedReplayOutcome,
  type T0RefBlock,
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
} from "./scratchExec.js";
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
  listSkills,
  parseSkillFrontmatter,
  readSkillBody,
  readSkillFile,
  skillsSuffixText,
  SKILL_FILE_MAX_BYTES,
  type SkillSummary,
} from "./skillCatalog.js";
