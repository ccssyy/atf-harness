/**
 * 前端二（ACP agent 外壳）——投影映射（L1 门 2 T04，§2.3 投影行）。
 *
 * 会话事件（core 投影面，已落盘事实）→ ACP session/update。纪律：
 * - D9 措辞：闸门推进只投影为**客户端观察事实**（"我方请求并收到宿主应答"），
 *   不得表述为内核状态权威——文案字段全部按此口径措辞；
 * - VERIFY 6：「未执行：等待人工审批」标注不丢（approval/request → status=pending
 *   ＋title 显式标注）；
 * - kind 映射（任务书钉死）：atf_fact_scan→read、atf_workspace_status→read、
 *   atf_gate(query)→read、atf_admit_data→edit；gate(advance) 任务书未列——按写动作
 *   取 edit（保守登记，T07 文档说明）；
 * - thought（D6）：v1 架构性无思考可投——L1a 基线把 thinking 收敛于线缆域
 *   （HttpLlmProvider 剥离、decide() 不返回、会话日志恒无 thinking），投影面
 *   （= append-only 日志）无 thought 事件源；恢复占位与真思考投影登记 L1b
 *   （须先有 wire→投影面的显式 tap，D6 三边界一并落地）。本文件因此无 thought 分支。
 */
import type { SessionEvent } from "../core/session/index.js";
import type { ToolResultPayload } from "../core/run/index.js";
import { type AcpSessionUpdate, type AcpToolCallStatus, type AcpToolKind } from "./protocol.js";

const TOOL_KINDS: Readonly<Record<string, AcpToolKind>> = {
  atf_fact_scan: "read",
  atf_workspace_status: "read",
  atf_admit_data: "edit",
};

/** kind 映射（gate 按 action 分流：query=read / advance=edit，后者为保守扩展登记项）。 */
export const toolKindFor = (tool: string, params: unknown): AcpToolKind => {
  if (tool === "atf_gate") {
    const action = typeof params === "object" && params !== null ? (params as { action?: unknown }).action : undefined;
    return action === "advance" ? "edit" : "read";
  }
  return TOOL_KINDS[tool] ?? "other";
};

const summarizeParams = (params: unknown): string => {
  const text = JSON.stringify(params ?? null) ?? "null";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const summarizeResult = (result: unknown): string => {
  const text = JSON.stringify(result ?? null) ?? "null";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** 审批 verdict → 工具调用状态投影（D9 措辞口径）。 */
const approvalVerdictUpdate = (payload: { verdict?: string; reason?: string; advice_text?: string }, toolCallId: string): AcpSessionUpdate => {
  switch (payload.verdict) {
    case "granted":
      return { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", title: "宿主已应答放行（allow_once）——开始执行" };
    case "denied":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        title: "未执行：宿主应答拒绝（reject_once）",
        content: [{ type: "text", text: `未执行：我方请求并收到宿主拒绝应答${payload.reason !== undefined ? `——${payload.reason}` : ""}` }],
      };
    case "advised":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "pending",
        title: "未执行：宿主给意见，等待重新提案",
        content: [{ type: "text", text: `未执行：我方请求并收到宿主修改意见——${payload.advice_text ?? ""}` }],
      };
    case "aborted":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        title: "未执行：宿主中止任务",
      };
    case "timeout":
    default:
      // 挂起（含 session/cancel 折算挂起）：保持 pending，可经后续 prompt 续答
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "pending",
        title: "未执行：等待人工审批（挂起可续）",
      };
  }
};

/**
 * 会话事件 → 0..n 条 ACP 投影（纯函数；消费方按序 notify）。
 * resolveToolCallId：approval/response 经 request_event_ref 反查对应 approval/request
 * 的 tool_call_id（工具调用配对键；查不到时退化为 request 事件 id——不影响宿主展示）。
 * 未列出的事件类型（turn/*、user/message 等）不投影——宿主以 prompt/工具面观察过程。
 */
export const projectSessionEvent = (
  event: SessionEvent,
  resolveToolCallId: (requestEventRef: number) => number | null,
): AcpSessionUpdate[] => {
  switch (event.type) {
    case "assistant/message":
      return [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String((event.payload as { text?: unknown }).text ?? "") },
        },
      ];
    case "tool/call": {
      const payload = event.payload as { tool?: string; params?: unknown };
      const tool = String(payload.tool ?? "unknown");
      return [
        {
          sessionUpdate: "tool_call",
          toolCallId: String(event.id),
          title: `${tool} ${summarizeParams(payload.params)}`,
          kind: toolKindFor(tool, payload.params),
          status: "in_progress",
          rawInput: payload.params,
        },
      ];
    }
    case "approval/request": {
      const payload = event.payload as { tool_call_id?: number; attempt?: number; tool?: string };
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: String(payload.tool_call_id ?? event.id),
          status: "pending",
          title: `未执行：等待人工审批（attempt ${String(payload.attempt ?? 1)}）`,
          content: [{ type: "text", text: `高危动作 ${String(payload.tool ?? "")} 待宿主授权——尚未执行，无任何自动应答` }],
        },
      ];
    }
    case "approval/response": {
      const payload = event.payload as { verdict?: string; reason?: string; advice_text?: string; request_event_ref?: number };
      const toolCallId = payload.request_event_ref !== undefined ? resolveToolCallId(payload.request_event_ref) : null;
      return [approvalVerdictUpdate(payload, String(toolCallId ?? event.id))];
    }
    case "tool/result": {
      const payload = event.payload as ToolResultPayload;
      const toolCallId = String(payload.call_ref);
      if (payload.ok) {
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            title: "执行完成",
            content: [{ type: "text", text: summarizeResult(payload.result) }],
          },
        ];
      }
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          title: "执行未成功",
          content: [{ type: "text", text: `原因=${payload.reason}${payload.block !== undefined ? `（${payload.block.reason}）` : ""}` }],
        },
      ];
    }
    default:
      return [];
  }
};
