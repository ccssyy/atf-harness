/**
 * 前端二（ACP agent 外壳）——协议面（L1 门 2 T04；《ATF独立Harness_L1门2任务书_20260915.md》§2.3）。
 *
 * ★轴三归属单一文件：ACP 协议版本（ACP_PROTOCOL_VERSION）只在本文件定义——与轴一
 * （会话协议版本，session.contract.yaml）、轴二（桥接契约版本，bridge.contract.yaml）
 * 三轴各自归属单一文件（re-pin 事故防呆口径）。
 *
 * D8（手写）：以下线缆类型为本仓手写本地类型（转写自 ACP v1 官方规范 + acpx@0.15.1
 * 事实底稿，见 docs/_owner/ATF独立Harness_acpx客户端核实_20260915.md），**不引任何
 * SDK**——类型仅编译期使用（import type 擦除），线缆面为纯 JSON。v1 只转写本批实际
 * 使用的方法面；未使用面（fs/*、terminal/*、elicitation/*、authenticate、session/
 * set_mode 等）不声明（D7 能力面代理禁用的镜像纪律）。
 */

/** ★轴三：ACP 协议版本（v1 稳定；本批恒以 1 应答，客户端请求更高版本亦回 1——
 *  我方只讲 v1，协商结果由客户端裁决是否继续）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** agent 标识（initialize 应答；_meta 内亦以此登记 provider 线索）。 */
export const ACP_AGENT_NAME = "atf-harness-acp";
export const ACP_AGENT_TITLE = "ATF Harness（ACP 配件外壳）";

/** 方法名（官方原文方法名，v1 使用面）。 */
export const ACP_METHODS = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionPrompt: "session/prompt",
  sessionLoad: "session/load",
  sessionCancel: "session/cancel",
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const;

// ---------------------------------------------------------------------------
// 线缆类型（手写本地转写；字段名与 ACP v1 规范逐字对齐）
// ---------------------------------------------------------------------------

export interface AcpTextContent {
  type: "text";
  text: string;
}

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** session/request_permission 选项 kind（D5：我方只提供 allow_once / reject_once）。 */
export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

/** 宿主对 request_permission 的应答。 */
export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** session/update 的 update 判别联合（本批投影面）。 */
export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: AcpTextContent }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind: AcpToolKind;
      status: AcpToolCallStatus;
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: AcpToolKind;
      status?: AcpToolCallStatus;
      content?: AcpTextContent[];
    };

// ---------------------------------------------------------------------------
// 请求/响应参数形态（handler 消费面）
// ---------------------------------------------------------------------------

export interface AcpInitializeParams {
  protocolVersion: number;
  /** 宿主能力（v1 只读 _meta.clientInfo 作 host_id 线索；不声明、不使用其能力——D7） */
  clientCapabilities?: Record<string, unknown>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    /** 我们支持 session/load（重放 append-only 日志重建 loop 状态，INV-A） */
    loadSession: boolean;
  };
  authMethods: readonly never[];
}

export interface AcpSessionNewParams {
  /** 宿主工作目录（TCB 纪律：仅记录，不做任何文件访问） */
  cwd?: string;
  mcpServers?: readonly unknown[];
}

export interface AcpSessionNewResult {
  sessionId: string;
}

export interface AcpPromptContentBlock {
  type: string;
  text?: string;
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: readonly AcpPromptContentBlock[];
}

export interface AcpSessionPromptResult {
  stopReason: "end_turn" | "refusal" | "cancelled" | "max_tokens";
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd?: string;
  mcpServers?: readonly unknown[];
}

export interface AcpLoopStateSummary {
  turns_opened: number;
  turns: number;
  last_closed_reason: string | null;
  events: number;
  pending_approvals: number;
}

export interface AcpSessionLoadResult {
  /** _meta 扩展位（ACP 允许）：我方 loop 状态快照（INV-A 兑现证据） */
  _meta: { atf: { loopState: AcpLoopStateSummary; run_id: string } };
}

export interface AcpSessionCancelNotification {
  sessionId: string;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: { toolCallId: string };
  options: readonly AcpPermissionOption[];
}
