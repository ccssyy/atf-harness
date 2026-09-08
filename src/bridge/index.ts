/**
 * S1 桥接层公开出口。工具层（S3）与会话层（S2）只从这里 import。
 */
export { err, ok, type Result } from "./result.js";
export {
  STDERR_TAIL_LIMIT,
  bridgeError,
  stringifyCause,
  takeStderrTail,
  type BridgeError,
  type BridgeErrorCode,
} from "./errors.js";
export {
  DEFAULT_MAX_FRAME_BYTES,
  LineFrameDecoder,
  asKernelFrame,
  encodeRequestFrame,
  validateKernelFrame,
  type DecodedItem,
  type ErrorResponseFrame,
  type EventFrame,
  type KernelFrame,
  type OkResponseFrame,
  type RequestFrame,
  type ResponseErrorBody,
  type ResponseFrame,
} from "./frames.js";
export {
  AtfBridgeConnection,
  EXPECTED_CONTRACT_VERSION,
  REQUEST_TIMEOUT_MS,
  type AtfBridgeEventData,
  type AtfVersionInfo,
  type BridgeCloseInfo,
  type BridgeSpawnOptions,
} from "./connection.js";
export {
  ATF_UPSTREAM_COMMIT_SHA,
  ATF_UPSTREAM_TAG,
  atfCliPathFromEnv,
  deriveAtfCommand,
  probeAtfHelp,
  readGitHeadSha,
  type AtfCliInvocation,
} from "./atfCommand.js";
