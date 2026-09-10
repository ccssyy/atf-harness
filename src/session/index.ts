/**
 * 会话层公开出口。后续 slice（工具层 / 冒烟 / runner）只从这里 import。
 */
export {
  SESSION_ENABLED_EVENT_TYPES,
  SESSION_EVENT_TYPES,
  SESSION_RESERVED_EVENT_TYPES,
  SESSION_SCHEMA_VERSION,
  asSessionEvent,
  hasDomainRefs,
  isEnabledEventType,
  isSessionEventType,
  validateDomainRef,
  validateEventEnvelope,
  type DomainRef,
  type InvalidRefEntry,
  type Projection,
  type SessionEvent,
  type SessionEventInput,
  type SessionEventType,
} from "./schema.js";
export {
  COMPACTION_CHUNK,
  COMPACTION_KEEP_RECENT,
  COMPACTION_TRIGGER_EVENTS,
  COMPACTION_TRIGGER_TOKENS,
  FSYNC_BATCH_MAX_EVENTS,
  FSYNC_BATCH_WINDOW_MS,
  FSYNC_DEFAULT_MODE,
  TOKEN_ESTIMATE_DIVISOR,
} from "./constants.js";
export {
  buildCompactionRecord,
  computeCompactionWhitelist,
  convertToLlm,
  estimateTokens,
  materialOf,
  planCompaction,
  projectContext,
  type CompactionPlan,
  type CompactionRecordPayload,
  type CompactionTriggerReason,
  type LlmContextEvent,
} from "./compaction.js";
export {
  sessionError,
  type InvalidRef,
  type RefInvalidCause,
  type SessionBlock,
  type SessionError,
  type SessionErrorCode,
} from "./errors.js";
export { MockDigestResolver, type DigestLookup, type DigestResolver } from "./digestResolver.js";
export {
  MAX_SESSION_LINE_BYTES,
  SessionLog,
  type AppendOutcome,
  type FsyncMode,
  type FsyncOptions,
  type ReplayOutcome,
  type SessionLogOptions,
} from "./sessionLog.js";
export { transformContext } from "./pipeline.js";
