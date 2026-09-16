/**
 * 工作区层错误与 block 模型（与桥接/会话/工具层同一边界纪律：只作 Result err 载荷，永不抛出）。
 */
import { type CatalogEntry } from "./catalog.js";

export type WorkspaceErrorCode =
  | "invalid_input" // 调用方输入非法（路径越界 / 路径形态非法 / run_id 空 / 元数据缺失或不符）
  | "provenance_conflict" // 既有 provenance.json 形状非法或与本次创建输入不一致（重开语义 fail-closed）
  | "corrupt_catalog" // Artifact Catalog 或 artifacts/ 目录状态不自洽（登记/文件失配、字段非法、重复 id）
  | "reproduce_failure" // 复现命令基础设施故障（spawn 失败 / 超时 / stdout 超限）——≠ 闸门裁决
  | "io_error"; // 落盘读写失败（产物文件写入 / catalog 写入回滚等）

export interface WorkspaceError {
  code: WorkspaceErrorCode;
  /** 人读摘要（中文，面向 harness 开发者与日志） */
  message: string;
  /** 结构化补充信息（如违规路径、IO errno、复现命令 stderr 尾部） */
  detail?: unknown;
}

export const workspaceError = (code: WorkspaceErrorCode, message: string, detail?: unknown): WorkspaceError => {
  const error: WorkspaceError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/**
 * 晋升闸 A 的 block 原因枚举（任务书 §4.3 两闸的裁决产出）：
 * - already_promoted：幂等闸拒绝（同源重复晋升，已有 Artifact 不覆盖）
 * - not_reproducible：可复现闸拒绝（复现命令退出码非 0 或 stdout hash 与源产物不一致）
 * sha 指纹闸失败（IO / 清单损坏）属基础设施故障，折算 WorkspaceError 而非 block。
 */
export type PromoteBlockReason = "already_promoted" | "not_reproducible";

/** 晋升闸 A 的结构化 block 结果。 */
export interface PromoteBlock {
  reason: PromoteBlockReason;
  message: string;
  /** 晋升请求的 scratch 内相对路径 */
  source: string;
  detail?: unknown;
}

/** 晋升闸 A 结果：promoted（已登记）/ blocked（闸门裁决拒绝）；基础设施路径走 Result err。 */
export type PromoteOutcome =
  | { kind: "promoted"; artifact: CatalogEntry }
  | { kind: "blocked"; block: PromoteBlock };
