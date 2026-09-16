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
