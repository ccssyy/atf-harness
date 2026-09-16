/**
 * 前端三（MCP server 外壳）——外壳主体（L1 门 2 T05，《ATF独立Harness_L1门2任务书_20260915.md》§2.4）。
 *
 * 形态：MCP 无 session 概念 → 我方会话以 **atf_bind_run 为界**、进程内维持（绑定即建
 * RunWorkspace＋append-only 日志＋内核桥接＋审批闸）；MCP 无 request_permission 原语 →
 * 授权由客户端工具审批 UI 决定，**我方闸门不放宽**：工具调用本身＝客户端审批面放行后的
 * 产物（D4-C 显式预授权口径），问答轨 stub 恒 granted 但**强制留痕** channel:"mcp" +
 * host_id + requires_human_review:true（D4-B），账本轨优先、CAS 一次性消费、拒绝循环
 * 防护、凭据重入/indeterminate 防线全部保留。MCP 无退出码 → 终局经 resolveHeadlessExitCode
 * 编码进 tool result（0/1/75/78/79 只保留在 ACP 与 CLI 入口）。
 *
 * 工具面（D11）：恰 7 细粒度工具（tools.ts）；工具名与 canonical output 沿用桥接契约。
 */
import {
  GuardedSessionLog,
  RunWorkspace,
  type ProvenanceInput,
} from "../core/workspace/index.js";
import {
  LEDGER_CONSUME_CANONICAL,
  LEDGER_QUERY_CANONICAL,
  ToolExecutor,
  ToolRegistry,
  resolveHeadlessExitCode,
  validateCanonicalOutput,
  type ApprovalGate,
  type BridgeTransport,
  type ScopeRef,
  type ToolBlock,
  type ToolCallOutcome,
} from "../core/tools/index.js";
import {
  createApprovalTrackHandler,
  FactScanResolver,
  type ApprovalStubResponse,
  type ToolResultPayload,
} from "../core/run/index.js";
import type { SessionEvent, SessionEventInput } from "../core/session/index.js";
import { AtfBridgeConnection } from "../bridge/index.js";
import { jsonRpcError, type RpcHandlerOutcome } from "../rpc/index.js";
import { mcpToolDescriptors } from "./tools.js";
import {
  MCP_LATEST_VERSION,
  MCP_METHODS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SUPPORTED_VERSIONS,
  type McpInitializeParams,
  type McpInitializeResult,
  type McpToolCallResult,
  type McpToolsCallParams,
} from "./protocol.js";

interface McpSession {
  runId: string;
  connection: AtfBridgeConnection;
  executor: ToolExecutor;
  guarded: GuardedSessionLog;
  events: SessionEvent[];
  scopeRef: ScopeRef;
}

export interface McpShellOptions {
  runsRoot: string;
  /** 内核桥接 spawn argv（mock 夹具或 L1a launcher） */
  mockCommand: readonly string[];
  /** 账本 scope_ref.scope_mode（缺省 canonical——MCP 面向真实内核；mock 亦接受） */
  scopeMode?: "canonical" | "simulation";
  /** 账本 scope_ref.project_id（缺省内核 canonical 项目标识） */
  projectId?: string;
  /** 宿主标识（D4 留痕；缺省 mcp-client，initialize clientInfo.name 覆盖） */
  hostId?: string;
}

/** 工具结果统一形态：canonical 结果/失败原因＋退出码编码（MCP 无退出码 → 进 tool result）。 */
const toolPayload = (args: {
  tool: string;
  exit_code: 0 | 1 | 75 | 78 | 79;
  result?: unknown;
  reason?: string;
  block?: ToolBlock;
  detail?: unknown;
}): McpToolCallResult => {
  const body: Record<string, unknown> = { tool: args.tool, exit_code: args.exit_code };
  if (args.result !== undefined) body["result"] = args.result;
  if (args.reason !== undefined) body["reason"] = args.reason;
  if (args.block !== undefined) body["block"] = args.block;
  if (args.detail !== undefined) body["detail"] = args.detail;
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: args.exit_code !== 0 ? true : undefined,
  };
};

const errorResult = (tool: string, message: string): McpToolCallResult =>
  toolPayload({ tool, exit_code: 1, reason: message });

export class McpShell {
  private session: McpSession | null = null;
  private initialized = false;
  private hostId: string;

  public constructor(private readonly options: McpShellOptions) {
    this.hostId = options.hostId ?? "mcp-client";
  }

  /** JSON-RPC 请求入口（RpcPeer.onRequest）。 */
  public readonly handleRequest = async (method: string, params: unknown): Promise<RpcHandlerOutcome> => {
    switch (method) {
      case MCP_METHODS.initialize:
        return this.initialize(params as McpInitializeParams);
      case MCP_METHODS.toolsList:
        return this.initialized
          ? { ok: true, result: { tools: mcpToolDescriptors() } }
          : { ok: false, error: jsonRpcError(-32000, "先 initialize 再调用 tools/list") };
      case MCP_METHODS.toolsCall:
        return await this.toolsCall(params as McpToolsCallParams);
      default:
        return { ok: false, error: jsonRpcError(-32601, `未知方法: ${method}（MCP v1 使用面见 src/mcp/protocol.ts）`) };
    }
  };

  /** JSON-RPC 通知入口——notifications/initialized 完成握手（其余忽略）。 */
  public readonly handleNotification = (method: string): void => {
    if (method === MCP_METHODS.initialized) this.initialized = true;
  };

  /** 客户端断开（stdin end）：关闭会话持有的内核桥接连接，供入口进程收口退出。 */
  public async shutdown(): Promise<void> {
    const session = this.session;
    this.session = null;
    this.initialized = false;
    if (session !== null) await session.connection.close().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // initialize（MCP 协议版本轴协商；serverInfo；clientInfo.name → D4 host_id）
  // -------------------------------------------------------------------------
  private initialize(params: McpInitializeParams): RpcHandlerOutcome {
    if (params.clientInfo?.name !== undefined && params.clientInfo.name !== "") this.hostId = params.clientInfo.name;
    const requested = params.protocolVersion ?? MCP_LATEST_VERSION;
    const negotiated = (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_LATEST_VERSION;
    const result: McpInitializeResult = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    };
    return { ok: true, result };
  }

  // -------------------------------------------------------------------------
  // tools/call 分派
  // -------------------------------------------------------------------------
  private async toolsCall(params: McpToolsCallParams): Promise<RpcHandlerOutcome> {
    if (!this.initialized) {
      return { ok: false, error: jsonRpcError(-32000, "先 initialize（+notifications/initialized）再调用 tools/call") };
    }
    const name = params.name;
    if (typeof name !== "string") {
      return { ok: false, error: jsonRpcError(-32602, "tools/call 缺 name") };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    switch (name) {
      case "atf_bind_run":
        return { ok: true, result: await this.bindRun(args) };
      case "atf_workspace_status":
      case "atf_fact_scan":
      case "atf_gate":
      case "atf_admit_data":
        return { ok: true, result: await this.governedTool(name, args) };
      case "ledger_query":
      case "ledger_consume":
        return { ok: true, result: await this.ledgerTool(name, args) };
      default:
        return { ok: false, error: jsonRpcError(-32602, `未知工具: ${name}（D11 细粒度 7 工具见 src/mcp/tools.ts）`) };
    }
  }

  // -------------------------------------------------------------------------
  // atf_bind_run：会话边界（spawn 内核桥接 → bind → 建工作区+append-only 日志+审批闸）
  // -------------------------------------------------------------------------
  private async bindRun(args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (this.session !== null) {
      return errorResult("atf_bind_run", `已绑定 run ${this.session.runId}（v1 一进程一绑定；换 run 请重启 server）`);
    }
    const runId = args["run_id"];
    if (typeof runId !== "string" || runId === "") {
      return errorResult("atf_bind_run", "参数非法：run_id 须为非空字符串");
    }
    const scopeRef: ScopeRef = {
      project_id: this.options.projectId ?? "agentic-training-flow",
      scope_type: "run",
      scope_id: runId,
      scope_mode: this.options.scopeMode ?? "canonical",
    };
    const spawned = await AtfBridgeConnection.spawn({ command: [...this.options.mockCommand] });
    if (!spawned.ok) {
      return errorResult("atf_bind_run", `内核桥接 spawn/握手失败: ${spawned.error.message}`);
    }
    const connection = spawned.value;
    const bound = await connection.request("atf.bind_run", { run_id: runId });
    if (!bound.ok) {
      await connection.close().catch(() => undefined);
      return errorResult("atf_bind_run", `内核 atf.bind_run 失败: ${bound.error.message}`);
    }
    const workspaceRoot = `${this.options.runsRoot}/${runId}`;
    const provenance: ProvenanceInput = {
      run_id: runId,
      trigger_instruction: "(MCP 会话：以 atf_bind_run 为界，工具调用经客户端审批面授权)",
      model_id: "mcp-host",
    };
    const workspace = await RunWorkspace.create(workspaceRoot, provenance);
    if (!workspace.ok) {
      await connection.close().catch(() => undefined);
      return errorResult("atf_bind_run", `run 工作区创建失败: ${workspace.error.message}`);
    }
    const ws = workspace.value;
    const resolver = new FactScanResolver(connection, runId);
    const guarded = await GuardedSessionLog.create(ws.sessionLogPath, resolver, ws.scratchDir);
    if (!guarded.ok) {
      await connection.close().catch(() => undefined);
      return errorResult("atf_bind_run", `会话日志创建失败: ${guarded.error.message}`);
    }
    const events: SessionEvent[] = [];
    this.session = {
      runId,
      connection,
      executor: new ToolExecutor(connection, ToolRegistry.createDefault(), scopeRef),
      guarded: guarded.value,
      events,
      scopeRef,
    };
    // 绑定动作本身入审计流（tool/call + tool/result）
    const call = await this.appendEvent({ type: "tool/call", payload: { tool: "atf_bind_run", params: { run_id: runId } } });
    if (call !== null) {
      await this.appendEvent({ type: "tool/result", payload: { tool: "atf_bind_run", ok: true, result: bound.value, call_ref: call.id } satisfies ToolResultPayload });
    }
    return toolPayload({ tool: "atf_bind_run", exit_code: 0, result: bound.value });
  }

  // -------------------------------------------------------------------------
  // 4 模型面工具：executor 治理管线（账本轨优先 → 问答轨留痕放行）+ 审计流 + 退出码
  // -------------------------------------------------------------------------
  private async governedTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const session = this.session;
    if (session === null) {
      return errorResult(name, "未绑定 run——先调用 atf_bind_run（我方会话以绑定为界）");
    }
    const call = await this.appendEvent({ type: "tool/call", payload: { tool: name, params: args } });
    if (call === null) {
      return errorResult(name, "会话事件落盘失败（fail-closed，工具未执行）");
    }
    const qaHandler = createApprovalTrackHandler({
      appendEvent: async (input) => await this.appendEvent(input),
      events: session.events,
      // per-append 逐条 fsync 档：ack 即已持久化（与 runner 同口径）
      flush: async () => ({ ok: true }),
      recoveryWatermark: 0,
      stub: async (): Promise<ApprovalStubResponse> => {
        // MCP 无授权原语：工具调用＝客户端审批面放行后的产物（D4-C 显式预授权）。
        // 我方闸门不放宽：账本轨优先/CAS/重入/indeterminate 防线在 handler 内全部保留；
        // 放行恒留痕 channel:"mcp"+host_id+requires_human_review:true（D4-B 审计位）。
        return { verdict: "granted", actor: "mcp-host", channel: "mcp", host_id: this.hostId };
      },
    });
    const gate: ApprovalGate = { handler: (gateInput) => qaHandler({ ...gateInput, tool_call_id: call.id }) };
    const outcome: ToolCallOutcome = await session.executor.execute(name, args, gate);
    const payload: ToolResultPayload =
      outcome.kind === "executed"
        ? { tool: name, ok: true, result: outcome.result, call_ref: call.id }
        : outcome.kind === "rejected"
          ? { tool: name, ok: false, reason: outcome.reason, call_ref: call.id, detail: outcome.detail }
          : outcome.kind === "failed"
            ? { tool: name, ok: false, reason: "failed", call_ref: call.id, detail: outcome.error }
            : { tool: name, ok: false, reason: outcome.block.reason, call_ref: call.id, block: outcome.block };
    await this.appendEvent({ type: "tool/result", payload });
    const exitCode = resolveHeadlessExitCode(outcome);
    if (outcome.kind === "executed") {
      return toolPayload({ tool: name, exit_code: exitCode, result: outcome.result });
    }
    if (outcome.kind === "blocked") {
      return toolPayload({ tool: name, exit_code: exitCode, reason: outcome.block.message, block: outcome.block });
    }
    if (outcome.kind === "rejected") {
      return toolPayload({ tool: name, exit_code: exitCode, reason: outcome.reason, detail: outcome.detail });
    }
    if (outcome.kind === "failed") {
      return toolPayload({ tool: name, exit_code: exitCode, reason: outcome.error.message, detail: outcome.error });
    }
    return toolPayload({ tool: name, exit_code: exitCode, reason: outcome.block.message, block: outcome.block });
  }

  // -------------------------------------------------------------------------
  // 2 账本方法：桥接直通（canonical 沿用契约/executor 常量，不另造一套）+ 审计流
  // -------------------------------------------------------------------------
  private async ledgerTool(name: "ledger_query" | "ledger_consume", args: Record<string, unknown>): Promise<McpToolCallResult> {
    const session = this.session;
    if (session === null) {
      return errorResult(name, "未绑定 run——先调用 atf_bind_run（我方会话以绑定为界）");
    }
    const canonical = name === "ledger_query" ? LEDGER_QUERY_CANONICAL : LEDGER_CONSUME_CANONICAL;
    const call = await this.appendEvent({ type: "tool/call", payload: { tool: name, params: args } });
    if (call === null) {
      return errorResult(name, "会话事件落盘失败（fail-closed，工具未执行）");
    }
    const transport: BridgeTransport = session.connection;
    const response = await transport.request(name, args);
    if (response.ok) {
      const checked = validateCanonicalOutput(name, canonical, response.value);
      if (!checked.ok) {
        await this.appendEvent({ type: "tool/result", payload: { tool: name, ok: false, reason: "schema_violation", call_ref: call.id, detail: checked.error } satisfies ToolResultPayload });
        return toolPayload({ tool: name, exit_code: 1, reason: `canonical 校验失败: ${checked.error.message}` });
      }
      await this.appendEvent({ type: "tool/result", payload: { tool: name, ok: true, result: response.value, call_ref: call.id } satisfies ToolResultPayload });
      return toolPayload({ tool: name, exit_code: 0, result: response.value });
    }
    if (response.error.code === "request_rejected") {
      // 对端业务拒绝（如 approval_already_consumed）：结构化回执，exit 1
      const detail = (response.error.detail ?? {}) as { code?: string };
      await this.appendEvent({ type: "tool/result", payload: { tool: name, ok: false, reason: detail.code ?? "rejected", call_ref: call.id, detail: response.error.detail } satisfies ToolResultPayload });
      return toolPayload({ tool: name, exit_code: 1, reason: detail.code ?? "rejected", detail: response.error.detail });
    }
    await this.appendEvent({ type: "tool/result", payload: { tool: name, ok: false, reason: "failed", call_ref: call.id, detail: response.error } satisfies ToolResultPayload });
    return toolPayload({ tool: name, exit_code: 1, reason: response.error.message });
  }

  /** 审计流追加（GuardedSessionLog 同一写路径；失败已由调用方折算 fail-closed）。 */
  private appendEvent = async (input: SessionEventInput): Promise<SessionEvent | null> => {
    const session = this.session;
    if (session === null) return null;
    const appended = await session.guarded.append(input);
    if (!appended.ok || appended.value.status !== "appended") return null;
    session.events.push(appended.value.event);
    return appended.value.event;
  };
}
