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

/** 审批 block 原因枚举（本阶段仅账本轨 approval_missing；交互问答轨属 Phase 2+）。 */
export type ToolBlockReason = "approval_missing";

/** 结构化 block 结果（owner 口径 #3：approval_missing 时 harness 主进程以 exit 78 终止）。 */
export interface ToolBlock {
  reason: ToolBlockReason;
  message: string;
  tool: string;
  /** headless 退出码锚点：approval_missing 恒为 78（ADR-07 / owner 口径 #3） */
  exit_code: 78;
  detail?: unknown;
}

export const approvalMissingBlock = (tool: string, message: string, detail?: unknown): ToolBlock => ({
  reason: "approval_missing",
  message,
  tool,
  exit_code: 78,
  ...(detail !== undefined ? { detail } : {}),
});
