/**
 * 工具层错误与 block 模型（与桥接/会话层同一边界纪律：只作 Result err 载荷，永不抛出）。
 */
import { type BridgeError } from "../bridge/index.js";

export type ToolErrorCode =
  | "schema_violation" // canonical output 校验失败（owner 口径 #4）/ 参数违反模型可见 schema
  | "unknown_tool" // 请求了注册表面之外的工具（工具面收敛，owner 口径 #5）
  | "bridge_failure"; // 桥接层故障透传（连接不可用 / 超时 / 协议违规等），原始 BridgeError 附于 detail

export interface ToolError {
  code: ToolErrorCode;
  /** 人读摘要（中文，面向 harness 开发者与日志） */
  message: string;
  /** 结构化补充（如 canonical 校验详情、原始 BridgeError、对端错误码） */
  detail?: unknown;
}

export const toolError = (code: ToolErrorCode, message: string, detail?: unknown): ToolError => {
  const error: ToolError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** 由桥接层错误折算工具层错误（保持原始 BridgeError 可归因）。 */
export const toolErrorFromBridge = (cause: BridgeError): ToolError =>
  toolError("bridge_failure", `桥接层失败（${cause.code}）: ${cause.message}`, { bridge: cause });

/** 审批 block 原因枚举：approval_missing 为账本轨既有语义（exit 78 锚点不挪用）；
 *  其余为 P2-S2 问答轨新增（决议 §3.2 口径 #6 / 门 2 A3）：
 *  - approval_denied / credential_consumed / credential_invalid：结构化 block 回填，模型可换路径（exit 1）；
 *  - credential_indeterminate：事实缺口，run 终态（exit 1，A3：不得被后续写失败覆盖）；
 *  - credential_persist_failed / approval_track_failed：harness 侧持久化/写路径失败，不放行（exit 1）；
 *  - approval_timeout（exit 75，suspended 非终态可恢复）/ approval_aborted（exit 79，终态主动终止）。 */
export type ToolBlockReason =
  | "approval_missing"
  | "approval_denied"
  | "credential_consumed"
  | "credential_invalid"
  | "credential_indeterminate"
  | "credential_persist_failed"
  | "approval_track_failed"
  | "approval_timeout"
  | "approval_aborted";

/** 结构化 block 结果（账本轨：approval_missing 恒 exit 78；问答轨：按上表语义映射 1/75/79，
 *  全部经 resolveHeadlessExitCode 单出口决出）。 */
export interface ToolBlock {
  reason: ToolBlockReason;
  message: string;
  tool: string;
  /** headless 退出码：approval_missing = 78（ADR-07 锚点）；问答轨按原因映射 1 / 75 / 79 */
  exit_code: 78 | 1 | 75 | 79;
  detail?: unknown;
}

export const approvalMissingBlock = (tool: string, message: string, detail?: unknown): ToolBlock => ({
  reason: "approval_missing",
  message,
  tool,
  exit_code: 78,
  ...(detail !== undefined ? { detail } : {}),
});

/** 问答轨结构化 block 构造（exit_code 由原因决定：denied/credential_* = 1）。 */
export const approvalTrackBlock = (
  tool: string,
  reason: ToolBlockReason,
  message: string,
  detail?: unknown,
): ToolBlock => ({
  reason,
  message,
  tool,
  exit_code: 1,
  ...(detail !== undefined ? { detail } : {}),
});
