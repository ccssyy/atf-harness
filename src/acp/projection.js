import {} from "./protocol.js";
const TOOL_KINDS = {
    atf_fact_scan: "read",
    atf_workspace_status: "read",
    atf_admit_data: "edit",
};
/** kind 映射（gate 按 action 分流：query=read / advance=edit，后者为保守扩展登记项）。 */
export const toolKindFor = (tool, params) => {
    if (tool === "atf_gate") {
        const action = typeof params === "object" && params !== null ? params.action : undefined;
        return action === "advance" ? "edit" : "read";
    }
    return TOOL_KINDS[tool] ?? "other";
};
const summarizeParams = (params) => {
    const text = JSON.stringify(params ?? null) ?? "null";
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};
const summarizeResult = (result) => {
    const text = JSON.stringify(result ?? null) ?? "null";
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};
/** 审批 verdict → 工具调用状态投影（D9 措辞口径）。 */
const approvalVerdictUpdate = (payload, toolCallId) => {
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
export const projectSessionEvent = (event, resolveToolCallId) => {
    switch (event.type) {
        case "assistant/message":
            return [
                {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: String(event.payload.text ?? "") },
                },
            ];
        case "tool/call": {
            const payload = event.payload;
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
            const payload = event.payload;
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
            const payload = event.payload;
            const toolCallId = payload.request_event_ref !== undefined ? resolveToolCallId(payload.request_event_ref) : null;
            return [approvalVerdictUpdate(payload, String(toolCallId ?? event.id))];
        }
        case "tool/result": {
            const payload = event.payload;
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
