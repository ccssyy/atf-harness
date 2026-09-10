/**
 * 会话层错误模型。SessionError 只作为 Result err 的载荷存在，
 * 永不作为异常抛出（与桥接层同一边界纪律，见 src/bridge/result.ts）。
 */

export type SessionErrorCode =
  | "schema_violation" // 事件结构违反 schema v1（未知/未启用 type / 字段缺失 / digest 格式非法 / payload 不可序列化 / projection 提前激活）
  | "resolver_failure" // DigestResolver 查询自身失败——不落盘、不标记、不猜测（基础设施故障 ≠ 引用无效）
  | "corrupt_stream" // 落盘流损坏（坏 JSON 行 / 中间空行 / id 不连续 / 行超限）
  | "io_error"; // 落盘读写失败

export interface SessionError {
  code: SessionErrorCode;
  /** 人读摘要（中文，面向 harness 开发者与日志） */
  message: string;
  /** 结构化补充信息（如违规字段路径、IO errno） */
  detail?: unknown;
}

export const sessionError = (code: SessionErrorCode, message: string, detail?: unknown): SessionError => {
  const error: SessionError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** digest 校验失败的归因（session.contract.yaml digest_check.block.cause 枚举）。 */
export type RefInvalidCause = "digest_mismatch" | "fact_not_found";

/** 单条失效引用明细。 */
export interface InvalidRef {
  /** 在事件 domain_refs 数组中的下标 */
  index: number;
  journal_type: string;
  fact_id: string;
  /** 事件声称的 digest（即未通过校验的那个值） */
  claimed_digest: string;
  cause: RefInvalidCause;
}

/**
 * 结构化 block 结果（owner 口径 #2：本阶段 block = 返回结构化结果即可，
 * 审批 UI / block 的进一步处置属后续 slice）。
 */
export interface SessionBlock {
  reason: "ref_invalid";
  message: string;
  /** 触发 block 的事件 id（append 场景 = 刚落盘的事件；replay 场景 = 校验失败的事件） */
  event_id: number;
  invalid_refs: InvalidRef[];
}
