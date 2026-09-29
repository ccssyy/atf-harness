/**
 * 批⑬ v2（2026-09-29，指令 ed9206c4）——WebUI 会话管理器与 agent 宿主。
 *
 * 定位（指令 §0）：Web 对话壳＝第四种 harness 宿主——同一个 agent loop（assembleV1Agent）、
 * 同一套工具投影（bridge 面＋A7 文件面＋本批只读四件）、同一个审批/确认语义（ApprovalSurface
 * ＋confirm 卡）。run 真相在内核 run 目录，会话只是壳（§三：绑定互斥/config-snapshot 免重问/
 * 断点续跑凭据在账本）。
 *
 * 调用护栏＝纯运维面（§二）：ATF_WEBUI_PARSE_BUDGET（缺省 5）连续解析失败 → 放弃解析、以
 * 结构化问题向用户索取信息（优雅降级）；ATF_WEBUI_CHAT_BUDGET（缺省 0＝不设限）防失控兜底，
 * 触发呈现为人话（"任务已终止并记录原因"），禁技术字样直出对话流。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/result.js";
import { AtfBridgeConnection } from "../bridge/index.js";
import type { AtfAgentToolDeps } from "../agent/atfAgentTools.js";
import type { FileToolHost } from "../agent/fileTools.js";
import { assembleV1Agent, type AssembledV1Agent } from "../agent/cli.js";
import { createProviderStreamFn } from "../agent/providerStreamFn.js";
import type { ApprovalRequestInfo, ApprovalSurface, ApprovalSurfaceVerdict } from "../agent/approvalSurface.js";
import { createFauxStreamFn, fauxAssistantMessage } from "../agent/fauxStream.js";
import { createJsonlSessionRepo, setLaneModelFace } from "../agent/sessionMirror.js";
import { ensureTemBranch } from "../agent/tem/store.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { ChatEvent } from "./chatModel.js";
import { CONFIG_CONFIRM_KEYS, buildConfigConfirmFields, hasConfigSnapshot, loadConfigSnapshot, parseConfigEditText, saveConfigSnapshot } from "./configConfirm.js";
import { computeContextUsage, type ApprovalPolicy, type ContextUsage, type ScenarioProfileId, type SettingsStore } from "./settings.js";
import { buildReadOnlyAgentTools } from "./readOnlyTools.js";

/** 分布式 Omit（union 收窄安全）。 */
export type ChatEventInput = ChatEvent extends infer T ? (T extends { seq: number } ? Omit<T, "seq"> : never) : never;

/** 运维面 env 读取（缺省：解析 5、对话 0＝不设限）。 */
export const parseBudgetFromEnv = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env["ATF_WEBUI_PARSE_BUDGET"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
};
export const chatBudgetFromEnv = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env["ATF_WEBUI_CHAT_BUDGET"];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export interface SessionSummary {
  id: string;
  title: string;
  state: "idle" | "running" | "awaiting_confirm" | "completed" | "paused";
  boundRunId?: string;
  resultSummary?: string;
}

interface PendingConfirm {
  seq: number;
  cardType: "config_confirm" | "approval";
  currentValues: Record<string, string>;
  resolve: (answer: { verdict: "confirmed" | "edited" | "denied"; edits: Record<string, string>; via: "button" | "text" }) => void;
  pendingAsk?: { resolve: (verdict: ApprovalSurfaceVerdict) => void; info: ApprovalRequestInfo };
}

interface Session {
  id: string;
  title: string;
  state: SessionSummary["state"];
  boundRunId?: string;
  resultSummary?: string;
  events: ChatEvent[];
  seq: number;
  /** 批⑭：上下文用量粗估（chars/2，每 turn 后更新——§二.2 剩余量递减） */
  contextUsedTokens: number;
  /** 批⑭：运行时热切覆盖（缺省＝settings default；新 turn 生效不重启 loop——pi-ai 换实例语义） */
  providerOverride?: { provider_id: string; model: string; effort?: string };
  pending?: PendingConfirm;
  agent: import("@earendil-works/pi-agent-core").Agent | null;
  bridge: AtfBridgeConnection | null;
  modelCalls: number;
  parseFailures: number;
  subscribers: Array<(event: ChatEvent) => void>;
}

export interface SessionManagerDeps {
  runsRoot: string;
  /** 会话 JSONL 根（webui 会话壳落盘面）。 */
  sessionsRoot: string;
  /** 批⑭：设置存储（providers/审批三档/profile——server 装配点注入）。 */
  settings?: SettingsStore;
  /** 批⑭：场景档（会话头徽标；新 run 携带对应缺省）。 */
  scenarioProfile?: ScenarioProfileId;
  /** 桥接 spawn（mock/real 由调用方定——与 cli.ts 同参形态）。 */
  bridgeCommand: { argv: readonly string[]; cwd?: string; env?: Record<string, string> };
  /** providerConfig（GLM 宿主走 ATF_LLM_CONFIG 解析产物；测试注入 streamFn 时可省）。 */
  providerConfig?: { provider_id: string; model: string; base_url: string; api_key: string };
  /** 测试注入 streamFn（优先于 providerConfig）。 */
  streamFn?: (model: never, context: never, options?: never) => unknown;
  kernelDir?: string;
  parseBudget?: number;
  chatBudget?: number;
}

/** 会话管理器（单进程；WebUI 全部会话共用一个实例）。 */
export class WebUiSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly activeRunBindings = new Map<string, string>();
  private readonly deps: SessionManagerDeps;
  private readonly parseBudget: number;
  private readonly chatBudget: number;
  /** 批⑭：审批策略（三档；切换即时生效于新 turn——已挂起卡不受影响）。 */
  public approvalPolicy: ApprovalPolicy = "per_card";
  /** 批⑭：场景档徽标（会话头）。 */
  public scenarioProfile: ScenarioProfileId = "first_train";

  public constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.parseBudget = deps.parseBudget ?? parseBudgetFromEnv();
    this.chatBudget = deps.chatBudget ?? chatBudgetFromEnv();
    if (deps.settings !== undefined) {
      this.approvalPolicy = deps.settings.get().approval_policy;
      this.scenarioProfile = deps.settings.get().profile;
    }
    if (deps.scenarioProfile !== undefined) this.scenarioProfile = deps.scenarioProfile;
    mkdirSync(deps.sessionsRoot, { recursive: true });
  }

  /** 批⑭：审批策略热切（§一.区2：即时生效于新 turn；已挂起卡不受影响——pending 存活）。 */
  public setApprovalPolicy(policy: ApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  /** 批⑭：模型/effort 运行时热切（§二.1：新 turn 生效不重启 loop——pi-ai 换实例语义）＋对话流留痕。 */
  public setModelOverride(id: string, override: { provider_id: string; model: string; effort?: string }): boolean {
    const session = this.sessions.get(id);
    if (session === undefined) return false;
    session.providerOverride = override;
    this.emit(session, {
      kind: "system_notice",
      level: "info",
      text: `已切换到 ${override.provider_id} · ${override.model}${override.effort !== undefined ? ` · effort ${override.effort}` : ""}（下一条消息生效）`,
      at: new Date().toISOString(),
    });
    return true;
  }

  /** 批⑭：上下文剩余量（§二.2：粗估 chars/2；剩余 <20% low 提示，只提示不强制）。 */
  public contextUsage(id: string, contextWindow: number): ContextUsage | null {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    return computeContextUsage(session.contextUsedTokens, contextWindow);
  }

  /** 新建会话（§一 左栏「+ 新建任务」）。 */
  public createSession(instruction?: string): string {
    const id = `sess-${randomUUID().slice(0, 8)}`;
    const session: Session = {
      id,
      title: instruction !== undefined && instruction !== "" ? instruction.slice(0, 24) : "新任务",
      state: "idle",
      events: [],
      seq: 0,
      contextUsedTokens: 0,
      agent: null,
      bridge: null,
      modelCalls: 0,
      parseFailures: 0,
      subscribers: [],
    };
    this.sessions.set(id, session);
    if (instruction !== undefined && instruction !== "") void this.postUserMessage(id, instruction);
    return id;
  }

  /** 左栏列表（状态行＋结果摘要行）。 */
  public listSessions(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((session) => ({
        id: session.id,
        title: session.title,
        state: session.state,
        ...(session.boundRunId !== undefined ? { boundRunId: session.boundRunId } : {}),
        ...(session.resultSummary !== undefined ? { resultSummary: session.resultSummary } : {}),
      }));
  }

  public getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** 事件增量拉取（SSE/轮询兜底共用）。 */
  public eventsSince(id: string, sinceSeq: number): ChatEvent[] {
    const session = this.sessions.get(id);
    if (session === undefined) return [];
    return session.events.filter((event) => event.seq > sinceSeq);
  }

  /** 订阅（SSE 推送面）。 */
  public subscribe(id: string, listener: (event: ChatEvent) => void): void {
    this.sessions.get(id)?.subscribers.push(listener);
  }

  private emit(session: Session, event: ChatEventInput): ChatEvent {
    const full = { seq: ++session.seq, ...event } as ChatEvent;
    session.events.push(full);
    for (const listener of session.subscribers) {
      try {
        listener(full);
      } catch {
        /* 订阅方异常不阻塞会话 */
      }
    }
    return full;
  }

  /** 同一 run 仅一个活跃会话（§三.3）：第二会话绑定显式拒绝。 */
  public bindRun(id: string, runId: string): Result<{ bound: true }, { code: "run_busy" | "no_session"; message: string }> {
    const session = this.sessions.get(id);
    if (session === undefined) return err({ code: "no_session" as const, message: `会话不存在: ${id}` });
    const active = this.activeRunBindings.get(runId);
    if (active !== undefined && active !== id) {
      this.emit(session, {
        kind: "system_notice",
        level: "warn",
        text: `该 run（${runId}）在另一会话（${active}）活跃——绑定被拒绝。可在该会话中继续，或等其结束后再绑定。`,
        at: new Date().toISOString(),
      });
      return err({ code: "run_busy" as const, message: `该 run 在另一会话活跃（${active}）` });
    }
    this.activeRunBindings.set(runId, id);
    session.boundRunId = runId;
    return ok({ bound: true });
  }

  /** 用户消息入口：confirm 卡应答（点卡/纯文字同凭据语义）或 agent 新指令。 */
  public async postUserMessage(id: string, text: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    this.emit(session, { kind: "user", text, at: new Date().toISOString() });
    const pending = session.pending;
    if (pending !== undefined) {
      await this.resolvePendingByText(session, pending, text);
      return;
    }
    await this.runAgentTurn(session, text);
  }

  /** 点卡应答（与纯文字同一凭据语义——§四）。 */
  public async answerConfirm(id: string, answer: { action: "confirm" | "edit" | "deny"; edits?: Record<string, string>; via: "button" | "text" }): Promise<void> {
    const session = this.sessions.get(id);
    const pending = session?.pending;
    if (session === undefined || pending === undefined) return;
    if (pending.cardType === "approval") {
      const verdict: ApprovalSurfaceVerdict =
        answer.action === "deny" ? { kind: "denied" } : answer.action === "edit" ? { kind: "suspended" } : { kind: "granted" };
      this.markConfirmAnswered(session, pending.seq, answer.action === "edit" ? "edited" : answer.action === "deny" ? "denied" : "confirmed", answer.edits ?? {}, answer.via);
      session.pending = undefined;
      session.state = "running";
      pending.pendingAsk?.resolve(verdict);
      return;
    }
    await this.resolvePendingByText(session, pending, answer.action === "deny" ? "取消，不要继续" : "其他 ok", answer.edits ?? {});
  }

  private markConfirmAnswered(session: Session, seq: number, verdict: "confirmed" | "edited" | "denied", edits: Record<string, string>, via: "button" | "text"): void {
    const event = session.events.find((candidate) => candidate.seq === seq);
    if (event === undefined) return;
    if (event.kind === "confirm_card") {
      event.pending = false;
      event.answered = { verdict, edits, via, at: new Date().toISOString() };
      this.emit(session, { kind: "system_notice", level: "info", text: `确认已记录（${via === "button" ? "点卡" : "文字"}应答，凭据同源落账）`, at: new Date().toISOString() });
    } else if (event.kind === "danger_confirm") {
      event.pending = false;
      event.answered = { verdict: verdict === "denied" ? "denied" : "confirmed", via, at: new Date().toISOString() };
    }
  }

  private async resolvePendingByText(session: Session, pending: PendingConfirm, text: string, buttonEdits: Record<string, string> = {}): Promise<void> {
    if (pending.cardType === "approval") {
      const normalized = text.trim().toLowerCase();
      const verdict: ApprovalSurfaceVerdict = /取消|中止|abort|拒绝|deny|不同意/.test(normalized)
        ? { kind: "denied" }
        : normalized === "" || /等|稍后|suspend/.test(normalized)
          ? { kind: "suspended" }
          : { kind: "granted" };
      this.markConfirmAnswered(session, pending.seq, verdict.kind === "granted" ? "confirmed" : verdict.kind === "denied" ? "denied" : "edited", {}, "text");
      session.pending = undefined;
      session.state = "running";
      pending.pendingAsk?.resolve(verdict);
      return;
    }
    const parsed = parseConfigEditText(text);
    const edits = { ...buttonEdits, ...(parsed?.edits ?? {}) };
    const denying = /取消|不要|停止|deny/.test(text.trim().toLowerCase());
    if (denying) {
      this.markConfirmAnswered(session, pending.seq, "denied", edits, "text");
      session.pending = undefined;
      session.state = "idle";
      this.emit(session, { kind: "agent_text", text: "已停止本轮配置确认。需要调整方向后随时发起新任务。", at: new Date().toISOString() });
      pending.resolve({ verdict: "denied", edits, via: "text" });
      return;
    }
    if (parsed === null && Object.keys(edits).length === 0) {
      this.emit(session, {
        kind: "system_notice",
        level: "warn",
        text: "未能从回复中解析出配置改动——请用『<键> 改 <值>』格式（如 lr 改 2e-4），或点卡片按钮确认。",
        at: new Date().toISOString(),
      });
      return;
    }
    if (parsed?.explicitOnly === true || Object.keys(edits).length > 0) {
      // 改参重呈卡（§五.3）：更新当前值后重出卡等确认
      for (const [key, value] of Object.entries(edits)) pending.currentValues[key] = value;
      this.markConfirmAnswered(session, pending.seq, "edited", edits, "text");
      const event = this.emit(session, {
        kind: "confirm_card",
        cardType: "config_confirm",
        title: "配置确认（已按你的修改更新）",
        fields: buildConfigConfirmFields(pending.currentValues),
        pending: true,
        at: new Date().toISOString(),
      });
      session.pending = { ...pending, seq: event.seq, currentValues: { ...pending.currentValues } };
      pending.resolve({ verdict: "edited", edits, via: "text" });
      return;
    }
    this.markConfirmAnswered(session, pending.seq, "confirmed", edits, "text");
    session.pending = undefined;
    session.state = "running";
    if (session.boundRunId !== undefined) {
      const effective: Record<string, string> = {};
      for (const entry of CONFIG_CONFIRM_KEYS) effective[entry.key] = entry.default;
      saveConfigSnapshot(join(this.deps.runsRoot, session.boundRunId), { ...effective, ...pending.currentValues });
    }
    pending.resolve({ verdict: "confirmed", edits, via: "text" });
  }

  /** 危险动作卡（train.sh 真跑——代价显性化，改进④）＋gpu_window_pending 显式标记。 */
  public emitDangerConfirm(id: string, input: { title: string; gpuCount: number; estimate: string; command: string }): Promise<{ verdict: "confirmed" | "denied" }> {
    return new Promise((resolve) => {
      const session = this.sessions.get(id);
      if (session === undefined) {
        resolve({ verdict: "denied" });
        return;
      }
      const event = this.emit(session, {
        kind: "danger_confirm",
        title: input.title,
        gpuCount: input.gpuCount,
        estimate: input.estimate,
        command: input.command,
        pending: true,
        at: new Date().toISOString(),
      });
      session.state = "awaiting_confirm";
      this.emit(session, { kind: "system_notice", level: "warn", text: "gpu_window_pending：训练段未放行（等待 GPU 窗口与用户确认）", at: new Date().toISOString() });
      session.pending = {
        seq: event.seq,
        cardType: "approval",
        currentValues: {},
        resolve: async (answer) => resolve({ verdict: answer.verdict === "denied" ? "denied" : "confirmed" }),
      };
    });
  }

  /** 段完成落盘（§四 无静默双写）：runs/<id>/report/segment-<n>.md append-only，与状态卡同源。 */
  public writeSegmentReport(runId: string, segment: number, fields: Record<string, unknown>, gpuWindowPending = false): string | null {
    const runDir = join(this.deps.runsRoot, runId);
    if (!existsSync(runDir)) return null;
    const reportDir = join(runDir, "report");
    mkdirSync(reportDir, { recursive: true });
    const path = join(reportDir, `segment-${String(segment)}.md`);
    const body = [
      `# 段 ${String(segment)} 完成记录`,
      "",
      `- 完成时刻：${new Date().toISOString()}`,
      ...Object.entries(fields).map(([key, value]) => `- ${key}：${typeof value === "object" ? JSON.stringify(value) : String(value)}`),
      ...(gpuWindowPending ? ["- gpu_window_pending：训练段未放行（等待 GPU 窗口与用户确认）"] : []),
      "",
    ].join("\n");
    if (existsSync(path)) appendFileSync(path, body, "utf8");
    else writeFileSync(path, body, "utf8");
    return path;
  }

  // ---------------------------------------------------------------- agent 宿主

  private async ensureAgent(session: Session): Promise<Result<import("@earendil-works/pi-agent-core").Agent, string>> {
    if (session.agent !== null) return ok(session.agent);
    const spawned = await AtfBridgeConnection.spawn({
      command: [...this.deps.bridgeCommand.argv],
      ...(this.deps.bridgeCommand.cwd !== undefined ? { cwd: this.deps.bridgeCommand.cwd } : {}),
      ...(this.deps.bridgeCommand.env !== undefined ? { env: this.deps.bridgeCommand.env } : {}),
    });
    if (!spawned.ok) return err(`桥接 spawn/握手失败: ${spawned.error.message}`);
    session.bridge = spawned.value;
    const bridge = spawned.value;
    const runDir = join(this.deps.runsRoot, session.boundRunId ?? session.id);
    const scratchDir = join(runDir, "scratch");
    mkdirSync(scratchDir, { recursive: true });
    const repo = createJsonlSessionRepo(this.deps.sessionsRoot);
    const mirrored = await repo.create({ cwd: this.deps.sessionsRoot }, BACKGROUND_CONTEXT);
    await ensureTemBranch(mirrored);
    setLaneModelFace({ provider: this.deps.providerConfig?.provider_id ?? "webui", modelId: this.deps.providerConfig?.model ?? "webui" });
    const atfToolDeps: AtfAgentToolDeps = { bridge, scopeRefBox: { current: undefined } };
    const fileHost: FileToolHost = { env: process.env, roots: [scratchDir] };
    const surface: ApprovalSurface = {
      ask: async (info: ApprovalRequestInfo) => {
        // 批⑭ 审批三档（§一.区2）：danger_only＝配置/发布确认批量放行（单 run 一次应答），
        // train.sh 真跑（danger 卡走 emitDangerConfirm 不经本面）仍必确认；demo＝只读白名单
        // 自动放行、管线写仍逐卡（永不全免）。已挂起卡不受影响（本面只对新 ask 生效）。
        if (this.approvalPolicy === "danger_only" && (info.tool === "ask_user_for_input" || info.tool === "atf_config_confirm")) {
          this.emit(session, { kind: "system_notice", level: "info", text: `审批策略=危险动作必确认：${info.tool} 批量放行（真跑类仍逐卡）`, at: new Date().toISOString() });
          return { kind: "granted" } as ApprovalSurfaceVerdict;
        }
        if (this.approvalPolicy === "demo" && info.tool === "atf_config_confirm") {
          this.emit(session, { kind: "system_notice", level: "info", text: `审批策略=演示模式：${info.tool} 自动放行（只读白名单；管线写仍逐卡）`, at: new Date().toISOString() });
          return { kind: "granted" } as ApprovalSurfaceVerdict;
        }
        return await new Promise<ApprovalSurfaceVerdict>((resolve) => {
          const event = this.emit(session, {
            kind: "confirm_card",
            cardType: "approval",
            title: `审批请求：${info.tool}`,
            fields: [
              { key: "tool", value: info.tool, tag: "need_confirm" as const },
              { key: "params_digest", value: info.params_digest.slice(0, 16), tag: "from_registry" as const },
              ...(info.content_digest !== undefined ? [{ key: "content_digest", value: info.content_digest.slice(0, 16), tag: "from_registry" as const }] : []),
            ] as Array<{ key: string; value: string; tag: "need_confirm" | "from_registry" }>,

            pending: true,
            at: new Date().toISOString(),
          });
          session.pending = {
            seq: event.seq,
            cardType: "approval",
            currentValues: {},
            pendingAsk: { resolve, info },
            resolve: async () => undefined,
          };
          session.state = "awaiting_confirm";
          });
      },
    };
    const rawStreamFn =
      this.deps.streamFn !== undefined
        ? this.deps.streamFn
        : this.deps.providerConfig !== undefined
          ? createProviderStreamFn(this.deps.providerConfig).streamFn
          : (_model: never, _context: never, _options?: never): unknown =>
              // 无 GLM 配置（ATF_LLM_CONFIG 未设）：结构化降级响应（fail-closed 不装配真 provider）
              createFauxStreamFn([
                fauxAssistantMessage(
                  [{ type: "text", text: "模型宿主未配置（ATF_LLM_CONFIG 未设）——请在设置页区 1 配置 Provider 并设置对应凭据 env 后重试。" }],
                  "stop",
                ),
              ])(_model, _context, _options);
    const assembled = assembleV1Agent({
      bridge,
      session: mirrored as never,
      maxTurns: 64,
      streamFn: this.guardStreamFn(session, rawStreamFn) as never,
      modelTag: this.deps.providerConfig?.model ?? "webui",
      approval: { kind: "surface", surface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      fileTools: { roots: [scratchDir] },
      exemptTools: [
        "atf_config_confirm",
        "atf_run_list",
        "atf_report_read",
        "atf_metrics_compare",
        "atf_gpu_status",
      ],
      extraTools: [
        ...buildReadOnlyAgentTools({ runsRoot: this.deps.runsRoot }),
        ...this.buildConfigConfirmTool(session),
      ] as unknown as AgentTool[],
    });
    void atfToolDeps;
    session.agent = assembled.agent;
    // 工具卡投影（批⑬）：tool_execution_start/end → tool_card（运行中徽标→完成＋结果摘要）
    const toolCardSeqs = new Map<string, number>();
    assembled.agent.subscribe((event: { type: string; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; isError?: boolean }) => {
      if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
        const card = this.emit(session, {
          kind: "tool_card",
          tool: event.toolName,
          running: true,
          params: (event.args ?? {}) as Record<string, unknown>,
          at: new Date().toISOString(),
        });
        if (event.toolCallId !== undefined) toolCardSeqs.set(event.toolCallId, card.seq);
      }
      if (event.type === "tool_execution_end" && event.toolCallId !== undefined) {
        const seq = toolCardSeqs.get(event.toolCallId);
        const card = seq !== undefined ? session.events.find((candidate) => candidate.seq === seq) : undefined;
        if (card !== undefined && card.kind === "tool_card") {
          card.running = false;
          card.resultSummary = event.isError === true ? "执行失败" : "完成";
        }
      }
    });
    return ok(assembled.agent);
  }

  /** config_confirm 工具（interactive 机制在 tools 层实现——指令 §0）：agent 产出迭代配置后
   *  调用本工具 → 九要素卡（缺省标已用缺省⚠；config-snapshot 已确认则不重问）→ 用户点卡/
   *  纯文字应答（同凭据语义）→ 返回确认凭据与生效配置。 */
  private buildConfigConfirmTool(session: Session): AgentTool[] {
    const confirmTool: AgentTool = {
      name: "atf_config_confirm",
      label: "atf_config_confirm",
      description:
        "训练迭代配置确认（须真人应答）：产出 IterationConfig 后调用，harness 以九要素卡面向用户确认（缺省键标『已用缺省⚠』）。" +
        "用户可点卡确认或纯文字改参（如『lr 改 2e-4 其他 ok』）；同一 run 已确认过（config-snapshot 在案）时直接返回既有确认，不重复打扰用户。" +
        "返回的 confirmed_config 即生效配置——把它写入 scratch 的 IterationConfig JSON，勿自行改键。",
      parameters: {
        type: "object",
        properties: {
          config: { type: "object", description: "拟生效的 IterationConfig training 段与数据集键（其余段由管线缺省）" },
        },
        required: [],
      },
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const params = (typeof rawParams === "object" && rawParams !== null ? rawParams : {}) as Record<string, unknown>;
        const proposed = (typeof params["config"] === "object" && params["config"] !== null ? params["config"] : {}) as Record<string, unknown>;
        const currentValues: Record<string, string> = {};
        for (const [key, value] of Object.entries(proposed)) {
          if (typeof value === "string") currentValues[key] = value;
        }
        const runDir = join(this.deps.runsRoot, session.boundRunId ?? session.id);
        if (hasConfigSnapshot(runDir)) {
          const snapshot = loadConfigSnapshot(runDir);
          return {
            content: [{ type: "text", text: JSON.stringify({ reused_snapshot: true, confirmed_config: snapshot }, null, 1) }],
            details: { reused_snapshot: true, confirmed_config: snapshot },
          };
        }
        const answer = await new Promise<{ verdict: "confirmed" | "edited" | "denied"; edits: Record<string, string>; via: "button" | "text" }>((settle) => {
          const event = this.emit(session, {
            kind: "confirm_card",
            cardType: "config_confirm",
            title: "训练配置确认（九要素）",
            fields: buildConfigConfirmFields(currentValues),
            pending: true,
            at: new Date().toISOString(),
          });
          // edited＝改参重呈（resolvePendingByText 已出更新卡）——工具继续等 confirmed/denied
          session.pending = {
            seq: event.seq,
            cardType: "config_confirm",
            currentValues,
            resolve: (result) => {
              if (result.verdict === "edited") return;
              settle(result);
            },
          };
          session.state = "awaiting_confirm";
        });
        if (answer.verdict === "denied") {
          return {
            content: [{ type: "text", text: JSON.stringify({ confirmed: false, note: "用户拒绝本轮配置——请如实停止，勿绕道" }, null, 1) }],
            details: { confirmed: false },
          };
        }
        const confirmedConfig = { ...currentValues };
        if (session.boundRunId !== undefined) saveConfigSnapshot(runDir, confirmedConfig);
        const credential = { by: "webui-operator", at: new Date().toISOString(), channel: "harness-confirm-card" as const, via: answer.via };
        return {
          content: [{ type: "text", text: JSON.stringify({ confirmed: true, confirmed_config: confirmedConfig, user_confirmation: credential }, null, 1) }],
          details: { confirmed: true, confirmed_config: confirmedConfig, user_confirmation: credential },
        };
      },
    };
    return [confirmTool];
  }

  /** streamFn 包装（运维面护栏·对话预算）：超限直接终止并人话呈现（"任务已终止并记录原因"，
   *  禁技术字样直出对话流）；解析护栏在 turn 结束面统计（见 runAgentTurn）——事件流是库内
   *  队列，push 拦截点晚于入队，不可靠。 */
  private guardStreamFn(session: Session, inner: (model: never, context: never, options?: never) => unknown): (model: never, context: never, options?: never) => unknown {
    return (model: never, context: never, options?: never) => {
      session.modelCalls += 1;
      if (this.chatBudget > 0 && session.modelCalls > this.chatBudget) {
        this.emit(session, {
          kind: "system_notice",
          level: "warn",
          text: "任务已终止并记录原因：本轮会话的工作量已达运维配额上限。请把任务拆小后重试，或联系运维调整配额（已产生的结果不受影响）。",
          at: new Date().toISOString(),
        });
        session.state = "paused";
        throw new Error("chat_budget_reached");
      }
      return inner(model, context, options);
    };
  }

  private async runAgentTurn(session: Session, instruction: string): Promise<void> {
    const assembledResult = await this.ensureAgent(session);
    if (!assembledResult.ok) {
      this.emit(session, { kind: "system_notice", level: "error", text: assembledResult.error, at: new Date().toISOString() });
      return;
    }
    session.state = "running";
    const agent = assembledResult.value;
    this.emit(session, {
      kind: "plan_card",
      title: "执行计划",
      items: [
        { label: "理解任务并检查工作区", state: "done" },
        { label: "数据登记与体检（pipeline 前段）", state: "running" },
        { label: "配置确认（九要素）", state: "pending" },
        { label: "候选构建与发布确认", state: "pending" },
        { label: "训练准备与启动确认（danger 卡）", state: "pending" },
      ],
      at: new Date().toISOString(),
    });
    try {
      await agent.prompt(instruction);
      session.state = "completed";
      const lastAssistant = (agent.state.messages as unknown as Array<{ role?: string; content?: Array<{ type: string; text?: string }> }>)
        .filter((message) => message.role === "assistant")
        .at(-1);
      const text = (lastAssistant?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim();
      // 批⑭：上下文用量粗估（输入＋历史＋系统提示，chars/2 每 turn 后更新——§二.2 递减）
      session.contextUsedTokens = computeContextUsage(session.contextUsedTokens, Number.MAX_SAFE_INTEGER).usedTokens +
        Math.ceil((JSON.stringify(agent.state.messages).length + 3200) / 2);
      if (text !== "") {
        this.emit(session, { kind: "agent_text", text, at: new Date().toISOString() });
        session.resultSummary = text.slice(0, 40);
      } else {
        // F7 同口径（批⑬ WebUI 运维面）：空 assistant 文本＝解析不可用——连续达预算 →
        // 放弃解析、以结构化问题向用户索取信息（优雅降级，人话呈现）。
        session.parseFailures += 1;
        if (session.parseFailures >= this.parseBudget) {
          session.parseFailures = 0;
          this.emit(session, { kind: "system_notice", level: "warn", text: "解析连续失败——已放弃本轮自动解析（运维面护栏）。", at: new Date().toISOString() });
          this.emit(session, {
            kind: "agent_text",
            text: "（自动解析连续失败，已放弃本轮解析）请直接用文字告诉我本轮需要的关键信息（例如数据集、训练轮数、目标字段等），我按你说的继续。",
            at: new Date().toISOString(),
          });
          session.state = "idle";
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("chat_budget_reached")) return; // 人话 notice 已在护栏处发出
      this.emit(session, { kind: "system_notice", level: "error", text: `管线异常：${message}`, at: new Date().toISOString() });
      session.state = "idle";
    }
  }
}
