/**
 * S2 会话层公开出口。后续 slice（S3 工具层 / S5 冒烟）只从这里 import。
 */
export {
  SESSION_EVENT_TYPES,
  SESSION_SCHEMA_VERSION,
  asSessionEvent,
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
  hasDomainRefs,
  type AppendOutcome,
  type ReplayOutcome,
  type SessionLogOptions,
} from "./sessionLog.js";
export { convertToLlm, transformContext, type LlmContextEvent } from "./pipeline.js";
