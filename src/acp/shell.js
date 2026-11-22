/**
 * 前端二（ACP agent 外壳）——外壳主体（L1 门 2 T04，《ATF独立Harness_L1门2任务书_20260915.md》§2.3）。
 *
 * 会话映射（v1 一 session 一 run）：sessionId ≡ run_id（跨进程 session/load 可直接按
 * runsRoot/<sessionId>/session.jsonl 重放——INV-A 兑现）。治理完整保留：账本轨/问答轨、
 * CAS 一次性消费、三层工作区、append-only 日志、退出码语义全在 core；本外壳只做
 * 协议映射与投影（D7：不声明、不使用宿主能力面代理）。
 *
 * turn 语义（设计稿 §6.6）：session/prompt = 一次 turn；授权挂起（宿主取消/超时）
 * 折算 suspended 收口本 turn（「取消非否决」，机制复用超时挂起），后续 prompt 经
 * 待办授权续答（resume 语义，L1a 既有路径）。
 */
import { ScenarioRunner, deriveLoopStateFromEvents, listPendingApprovals, readSessionStream, sessionLogPathFor, } from "../core/run/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import { createLlmProviderFromConfig } from "../llm/index.js";
import { setCompactionContextWindow } from "../core/session/constantsBudget.js";
import { jsonRpcError } from "../rpc/index.js";
import { buildPermissionRequest, requestPermissionOverPeer } from "./permission.js";
import { projectSessionEvent } from "./projection.js";
import { ACP_AGENT_NAME, ACP_AGENT_TITLE, ACP_METHODS, ACP_PROTOCOL_VERSION, } from "./protocol.js";
export class AcpShell {
    options;
    sessions = new Map();
    sessionSeq = 0;
    providerFactory;
    scopeMode;
    hostId;
    constructor(options) {
        this.options = options;
        // 微补丁（2026-09-23，走查 run-full-v0762 首启发现）：缺省工厂切装配单点（pi-ai 面可用；测试注入 providerFactory 面零改动）
        this.providerFactory = options.providerFactory ?? ((config) => createLlmProviderFromConfig({ config, tools: ToolRegistry.createDefault().modelVisible() }));
        this.scopeMode = options.scopeMode ?? "headless";
        this.hostId = options.hostId ?? "acp-client";
    }
    /** JSON-RPC 请求入口（RpcPeer.onRequest）。 */
    handleRequest = async (method, params) => {
        switch (method) {
            case ACP_METHODS.initialize:
                return this.initialize(params);
            case ACP_METHODS.sessionNew:
                return this.sessionNew();
            case ACP_METHODS.sessionPrompt:
                return await this.sessionPrompt(params);
            case ACP_METHODS.sessionLoad:
                return await this.sessionLoad(params);
            default:
                return { ok: false, error: jsonRpcError(-32601, `未知方法: ${method}（ACP v1 使用面见 src/acp/protocol.ts）`) };
        }
    };
    /** JSON-RPC 通知入口（RpcPeer.onNotification）——v1 仅 session/cancel。 */
    handleNotification = (method, params) => {
        if (method !== ACP_METHODS.sessionCancel)
            return;
        const notification = params;
        const session = typeof notification.sessionId === "string" ? this.sessions.get(notification.sessionId) : undefined;
        if (session !== undefined && session.status === "running") {
            // 本 turn 收口请求：授权等待折算挂起（取消非否决）；迟到宿主应答由 stub 面丢弃
            session.cancelRequested = true;
        }
    };
    // -------------------------------------------------------------------------
    // initialize（轴三协商＋能力声明；D7：不声明 fs/terminal 能力面）
    // -------------------------------------------------------------------------
    initialize(params) {
        const clientInfo = params.clientCapabilities?._meta?.clientInfo;
        if (clientInfo?.name !== undefined && clientInfo.name !== "")
            this.hostId = clientInfo.name;
        const result = {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true },
            authMethods: [],
        };
        void params.protocolVersion; // 协商策略：我方恒应答 v1（见 protocol.ts ★轴三注）
        return { ok: true, result: { ...result, _meta: { agent: { name: ACP_AGENT_NAME, title: ACP_AGENT_TITLE } } } };
    }
    // -------------------------------------------------------------------------
    // session/new（v1 一 session 一 run；sessionId ≡ run_id；目录/日志惰建于首次 prompt）
    // -------------------------------------------------------------------------
    sessionNew() {
        this.sessionSeq += 1;
        const sessionId = `acp-${Date.now().toString(36)}-${String(this.sessionSeq)}`;
        this.sessions.set(sessionId, { sessionId, status: "new", cancelRequested: false, toolCallIdByRequest: new Map() });
        return { ok: true, result: { sessionId } };
    }
    // -------------------------------------------------------------------------
    // session/load（重放 append-only 日志重建 loop 状态——INV-A 兑现）
    // -------------------------------------------------------------------------
    async sessionLoad(params) {
        const sessionId = params.sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
            return { ok: false, error: jsonRpcError(-32602, "session/load 缺 sessionId") };
        }
        const stream = await readSessionStream(sessionLogPathFor(this.options.runsRoot, sessionId));
        if (!stream.ok) {
            return { ok: false, error: jsonRpcError(-32000, `会话流读取失败: ${stream.error.message}`) };
        }
        const loopState = deriveLoopStateFromEvents(stream.value);
        const status = loopState.turns.length > 0 && loopState.turns[loopState.turns.length - 1]?.closed_reason === "suspended" ? "suspended" : loopState.turns_opened > 0 ? "completed" : "new";
        this.sessions.set(sessionId, { sessionId, status, cancelRequested: false, toolCallIdByRequest: this.indexToolCalls(stream.value) });
        const summary = {
            turns_opened: loopState.turns_opened,
            turns: loopState.turns.length,
            last_closed_reason: loopState.turns[loopState.turns.length - 1]?.closed_reason ?? null,
            events: stream.value.length,
            pending_approvals: listPendingApprovals(stream.value).length,
        };
        return { ok: true, result: { _meta: { atf: { loopState: summary, run_id: sessionId } } } };
    }
    indexToolCalls(events) {
        const map = new Map();
        for (const event of events) {
            if (event.type !== "approval/request")
                continue;
            const payload = event.payload;
            if (typeof payload.tool_call_id === "number")
                map.set(event.id, payload.tool_call_id);
        }
        return map;
    }
    // -------------------------------------------------------------------------
    // session/prompt（一次 turn）
    // -------------------------------------------------------------------------
    async sessionPrompt(params) {
        const session = typeof params.sessionId === "string" ? this.sessions.get(params.sessionId) : undefined;
        if (session === undefined) {
            return { ok: false, error: jsonRpcError(-32602, `未知 sessionId: ${String(params.sessionId)}（先 session/new 或 session/load）`) };
        }
        if (session.status === "running") {
            return { ok: false, error: jsonRpcError(-32000, "该 session 的 turn 正在执行（v1 不支持并发 prompt）") };
        }
        if (session.status === "completed" || session.status === "aborted" || session.status === "failed") {
            return { ok: false, error: jsonRpcError(-32000, `run 已终局（${session.status}）——v1 一 session 一 run，请新建 session`) };
        }
        const text = (params.prompt ?? [])
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n");
        if (text === "") {
            return { ok: false, error: jsonRpcError(-32602, "session/prompt 缺文本内容块") };
        }
        session.cancelRequested = false;
        // 挂起续答路径：向宿主重发授权请求（fresh request），allow_once/reject_once → resume 语义
        const suspended = await this.isSuspended(session.sessionId);
        session.status = "running";
        let resume;
        if (suspended) {
            const pending = await this.latestPending(session.sessionId);
            if (pending !== null) {
                const asked = await requestPermissionOverPeer({
                    peer: this.options.peer,
                    params: buildPermissionRequest({ sessionId: session.sessionId, toolCallId: String(pending.tool_call_id) }),
                    hostId: this.hostId,
                    cancelledDueToSessionCancel: { get current() { return session.cancelRequested; } },
                });
                if (session.cancelRequested) {
                    session.status = "suspended";
                    return { ok: true, result: { stopReason: "cancelled" } };
                }
                if ("error" in asked) {
                    session.status = "suspended";
                    return { ok: false, error: jsonRpcError(-32000, `续答授权失败: ${asked.error.message}`) };
                }
                if (asked.verdict === "granted") {
                    resume = { verdict: "granted", actor: "acp-host", channel: "acp", host_id: this.hostId, request_event_id: pending.request_event_id };
                }
                else if (asked.verdict === "denied") {
                    resume = { verdict: "denied", actor: "acp-host", channel: "acp", host_id: this.hostId, request_event_id: pending.request_event_id };
                }
                else {
                    // cancelled 对话框/其它：维持挂起，不开 turn
                    session.status = "suspended";
                    return { ok: true, result: { stopReason: "cancelled" } };
                }
            }
        }
        const scenario = {
            scenario_id: `acp-${session.sessionId}`,
            version: 1,
            provider: "faux",
            description: "L1 ACP session",
            branches: {
                main: {
                    branch_id: "main",
                    run_id: session.sessionId,
                    trigger_instruction: text,
                    purpose: "l1-acp",
                    // 授权治理（T04 设计裁定）：ACP 面恒有宿主在线 → 我方不做任何账本预录——
                    // 全部须审批动作（含 gate query）走问答轨由宿主应答（D4-C：宿主"自动允许"
                    // 设置＝人的显式预授权，留痕 requires_human_review）。L1a headless trial 的
                    // gate(query) 预录在此不适用：无宿主场景才有预录必要；且 scope 级账本记录
                    // 会被首个高危动作消费（记录与动作无绑定，契约 v2 审计辅助口径），预录反而
                    // 构成盗用面。VERIFY 4 的"无人工干预"由宿主自动允许策略承载（acpx --approve-all）。
                    setup: { ledger: [] },
                    steps: [],
                    expect: { outcome: "completed", exit_code: 0 },
                },
            },
        };
        session.toolCallIdByRequest = new Map();
        // A1.5.2（L1c 提前批）：compaction 触发水位同源注入（与 TUI/trial 一致；未配置回退 24K）。
        setCompactionContextWindow(this.options.providerConfig.context_window);
        const ran = await ScenarioRunner.runBranch(scenario, "main", {
            runsRoot: this.options.runsRoot,
            mockCommand: [...this.options.mockCommand],
            modelProvider: this.providerFactory(this.options.providerConfig),
            modelId: this.options.providerConfig.model,
            approvalSurface: {
                stub: async (input) => await this.permissionStub(session, input),
            },
            onEvent: (event, origin) => this.projectEvent(session, event, origin),
            ...(resume !== undefined ? { resume } : {}),
            ...(this.scopeMode !== "headless" ? { scopeMode: this.scopeMode } : {}),
        });
        if (!ran.ok) {
            session.status = "failed";
            return { ok: false, error: jsonRpcError(-32000, `run 启动失败: ${ran.error.message}`) };
        }
        const report = ran.value;
        switch (report.outcome.kind) {
            case "completed":
                session.status = "completed";
                return { ok: true, result: { stopReason: "end_turn" } };
            case "suspended":
                session.status = "suspended";
                return { ok: true, result: { stopReason: "cancelled" } };
            case "aborted":
            case "approval_missing":
                session.status = "aborted";
                return { ok: true, result: { stopReason: "refusal" } };
            default: {
                session.status = "failed";
                const error = report.outcome.kind === "failed" ? report.outcome.error : undefined;
                return {
                    ok: false,
                    error: jsonRpcError(-32000, `run 终局 failed${error !== undefined ? `: [${error.code}] ${error.message}` : ""}`),
                };
            }
        }
    }
    // -------------------------------------------------------------------------
    // 授权（问答轨 stub 的 ACP 实现：request_permission 往返）
    // -------------------------------------------------------------------------
    permissionStub = async (session, input) => {
        // approval/request 事件先于本 stub 调用落盘（approvalTrack 顺序），由此反查 tool_call_id
        const toolCallEventId = await this.latestToolCallIdForPendingRequest(session, input.approval_session_id, input.attempt);
        const asked = await requestPermissionOverPeer({
            peer: this.options.peer,
            params: buildPermissionRequest({ sessionId: session.sessionId, toolCallId: String(toolCallEventId ?? input.approval_session_id) }),
            hostId: this.hostId,
            cancelledDueToSessionCancel: { get current() { return session.cancelRequested; } },
        });
        if ("error" in asked) {
            return { verdict: "denied", actor: "acp-host", reason: `授权请求失败（${asked.error.message}）——fail-closed 未执行`, channel: "acp", host_id: this.hostId };
        }
        return asked;
    };
    async latestToolCallIdForPendingRequest(session, approvalSessionId, attempt) {
        const stream = await readSessionStream(sessionLogPathFor(this.options.runsRoot, session.sessionId));
        if (!stream.ok)
            return null;
        for (let i = stream.value.length - 1; i >= 0; i -= 1) {
            const event = stream.value[i];
            if (event === undefined || event.type !== "approval/request")
                continue;
            const payload = event.payload;
            if (payload.approval_session_id === approvalSessionId && payload.attempt === attempt && typeof payload.tool_call_id === "number") {
                return payload.tool_call_id;
            }
        }
        return null;
    }
    async isSuspended(runId) {
        const stream = await readSessionStream(sessionLogPathFor(this.options.runsRoot, runId));
        if (!stream.ok)
            return false;
        const loopState = deriveLoopStateFromEvents(stream.value);
        return loopState.turns.length > 0 && loopState.turns[loopState.turns.length - 1]?.closed_reason === "suspended";
    }
    async latestPending(runId) {
        const stream = await readSessionStream(sessionLogPathFor(this.options.runsRoot, runId));
        if (!stream.ok)
            return null;
        const pending = listPendingApprovals(stream.value);
        const last = pending[pending.length - 1];
        return last !== undefined ? { request_event_id: last.request_event_id, tool_call_id: last.tool_call_id } : null;
    }
    // -------------------------------------------------------------------------
    // 投影（live 事件 → session/update；D9 措辞见 projection.ts）
    // -------------------------------------------------------------------------
    projectEvent(session, event, origin) {
        if (origin !== "live")
            return; // v1：宿主以当前 turn 观察过程（历史不重放投影）
        if (event.type === "approval/request") {
            const payload = event.payload;
            if (typeof payload.tool_call_id === "number")
                session.toolCallIdByRequest.set(event.id, payload.tool_call_id);
        }
        for (const update of projectSessionEvent(event, (requestEventRef) => session.toolCallIdByRequest.get(requestEventRef) ?? null)) {
            this.options.peer.notify(ACP_METHODS.sessionUpdate, { sessionId: session.sessionId, update });
        }
    }
}
