/**
 * 桥接层错误模型。BridgeError 只作为 Result err 的载荷存在，
 * 永不作为异常抛出（见 result.ts 的边界纪律）。
 */

export type BridgeErrorCode =
  | "spawn_failed" // 子进程无法启动（可执行路径不存在、stdio 配置异常等）
  | "handshake_failed" // 握手未通过（早退、结果 schema 不符、会话协议版本不一致——双轴见 connection.ts 常量注释）
  | "protocol_error" // 线缆协议违规（坏 JSON 行、未知帧型、超限帧、空行）
  | "request_rejected" // 对端返回 ok=false 的错误响应（应用层错误，如 method_not_found）
  | "timeout" // 请求超时
  | "peer_exit" // 对端意外退出（非优雅关闭）
  | "closed" // 连接已失败/已关闭后仍被使用
  | "config_error"; // 环境配置缺失（如 ATF_CLI_PATH 未设置）

export interface BridgeError {
  code: BridgeErrorCode;
  /** 人读摘要（中文，面向 harness 开发者与日志） */
  message: string;
  /** 对端 stderr 尾部摘要（意外退出 / spawn 失败时尽量附带，便于归因） */
  stderrTail?: string;
  /** 结构化补充信息（如对端错误码、原始错误体） */
  detail?: unknown;
}

export interface BridgeErrorInit {
  code: BridgeErrorCode;
  message: string;
  stderrTail?: string;
  detail?: unknown;
}

export const bridgeError = (init: BridgeErrorInit): BridgeError => {
  const error: BridgeError = { code: init.code, message: init.message };
  if (init.stderrTail !== undefined) error.stderrTail = init.stderrTail;
  if (init.detail !== undefined) error.detail = init.detail;
  return error;
};

/** stderr 尾部保留上限：超出部分丢弃头部，保证摘要体积有界。 */
export const STDERR_TAIL_LIMIT = 8 * 1024;

export const takeStderrTail = (text: string): string => {
  if (text.length <= STDERR_TAIL_LIMIT) return text;
  return `…(截断)${text.slice(text.length - STDERR_TAIL_LIMIT)}`;
};

export const stringifyCause = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  return String(cause);
};
