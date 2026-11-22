/**
 * 跨进程通道层的通用件（Result 边界纪律 + BridgeError 错误模型）——实现内聚
 * core（core 边界守卫：core 不 import 外壳目录 ui/acp/mcp）；外壳 src/mcp 与
 * atf-tools/webui 等消费面经 src/mcp/index.js 的 re-export 取用（G5 自 src/bridge
 * 迁移承接——原文件级边界纪律原文保留）。
 */

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type BridgeErrorCode =
  | "spawn_failed" // 子进程无法启动（可执行路径不存在、stdio 配置异常等）
  | "handshake_failed" // 握手未通过（早退、结果 schema 不符、版本协商失败）
  | "protocol_error" // 线缆协议违规（坏 JSON 行、未知帧型、超限帧、空行）
  | "request_rejected" // 对端返回错误响应（应用层错误，如 method_not_found）
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
