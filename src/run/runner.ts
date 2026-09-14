/**
 * 冒烟 runner（任务书 §5 / owner 口径 #4/#5/#6）：场景分支执行器——
 *   FauxProvider 线性回放决策 → runner 分派（工具面 / 工作区动作 / 引用尝试）→
 *   GuardedSessionLog 承载会话（B4 由此天然获得 T0 拒绝能力）→ 分支报告 + 期望核验。
 *
 * 退出码纪律（owner 口径 #4）：
 * - 0 = completed；78 专属 approval_missing（经 S3 resolveHeadlessExitCode 锚点决出，单一出口）；
 * - 会话层拒绝（t0_ref_forbidden）与各类故障 = 1（不走 78）；
 * - 分支级归约在本文件登记（resolveRunExitCode），工具面锚点仍在 src/tools/executor.ts。
 *
 * 账本/setup 纪律（契约 v2，2026-09-13 契约修订）：预录经桥接 ledger_record（owner 口径 #3：
 * mock 对端进程内状态承载），形态 = {scope_ref, tool, params_digest}（审批链键模型下
 * tool + params_digest 为审计检索辅助）；账本查询/消费以 scope_ref 定位 +
 * {approval_ref, record_id} 消费（executor 承载）。本 runner 以
 * {project_id: scenario_id, scope_type: "run", scope_id: run_id, scope_mode: "headless"}
 * 确定性派生 scope_ref，setup 预录与执行期查询天然同域。
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { AtfBridgeConnection } from "../bridge/index.js";import {
  FauxProvider,
  createDefaultProviderRegistry,
  assertModelDecision,
  MODEL_DECISION_FORBIDDEN,
  type ProviderSegment,
  type ProviderRegistry,
  type Scenario,
  type ScenarioBranch,
  type ScenarioExpect,
  type ScenarioStep,
  type ScriptedStepSource,
} from "../llm/index.js";
import type { LlmProvider } from "../llm/index.js";
import {
  approvalParamsDigest,
  resolveHeadlessExitCode,
  ToolExecutor,
  ToolRegistry,
  type ScopeRef,
  type ToolBlock,
  type ToolCallOutcome,
} from "../tools/index.js";
import {
  GuardedSessionLog,
  loadCatalog,
  promoteArtifact,
  RunWorkspace,
  sha256Hex,
  type CatalogEntry,
  type GuardedReplayOutcome,
  type WorkspaceError,
} from "../workspace/index.js";
import {
  hasDomainRefs,
  transformContext,
  type DomainRef,
  type SessionError,
  type SessionEvent,
  type SessionEventInput,
} from "../session/index.js";
import {
  createApprovalTrackHandler,
  readStreamMaxId,
  type ApprovalStub,
} from "./approvalTrack.js";
import {
  buildSwitchPayload,
  checkSwitchBoundary,
  verifyDigestContinuity,
  type ProviderSwitchBlock,
} from "./providerSwitch.js";
import { type ApprovalGate } from "../tools/index.js";
import { FactScanResolver } from "./factScanResolver.js";

export type RunErrorCode =
  | "invalid_input" // 场景/分支/选项非法（分支不存在、run_id 逃逸等）
  | "bridge_failure" // mock 对端 spawn/握手失败
  | "setup_failure" // 账本预录等 setup 失败
  | "workspace_failure" // 工作区创建 / scratch 写入 / 晋升失败
  | "session_failure" // 会话事件写入失败 / 铁律一意外缺位
  | "provider_failure" // provider 故障 / 决策序列耗尽而未收束
  | "model_decision_forbidden" // 切片 0：provider 返回值含模型面外步骤（运行时守卫 fail-closed，exit 1）
  | "credential_indeterminate"; // 问答轨凭据状态不确定（A3：run 终态，需人工核对，exit 1）

export interface RunError {
  code: RunErrorCode;
  message: string;
  detail?: unknown;
}

export const runError = (code: RunErrorCode, message: string, detail?: unknown): RunError => {
  const error: RunError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** 分支终局(六态穷尽互斥;业务级 gate blocked 是合法 canonical 产出,不是终局——B2 语义):
 *  Phase 1 四态 + P2-S2 问答轨两终态 suspended(75,非终态可恢复)/ aborted(79)。 */
export type BranchOutcome =
  | { kind: "completed" }
  | { kind: "approval_missing"; block: ToolBlock }
  | { kind: "session_rejected"; block: T0RefBlockShape }
  | { kind: "suspended"; block: ToolBlock }
  | { kind: "aborted"; block: ToolBlock }
  | { kind: "failed"; error: RunError };

// 避免与 workspace 层类型产生导入环的轻量别名（结构同构于 T0RefBlock）
interface T0RefBlockShape {
  reason: "t0_ref_forbidden";
  message: string;
  invalid_refs: Array<{ index: number; journal_type: string; fact_id: string }>;
}

/**
 * runner 统一出口(owner 口径 #4 + 决议 §3.2 口径 #9,单一出口):0 = completed;
 * 78 = approval_missing(S3 锚点,不挪用);75 = suspended;79 = aborted;
 * 会话层拒绝 / credential_indeterminate / 各类故障 = 1。
 */
export const resolveRunExitCode = (outcome: BranchOutcome): 0 | 1 | 75 | 78 | 79 => {
  switch (outcome.kind) {
    case "completed":
      return 0;
    case "approval_missing":
      return resolveHeadlessExitCode({ kind: "blocked", block: outcome.block });
    case "session_rejected":
    case "failed":
      return 1;
    case "suspended":
      return 75;
    case "aborted":
      return 79;
  }
};

/** tool/result 事件 payload 形态(结构化回填,供 Faux 断言失败路径与 B2 block 回填验证)。
 *  P2-S2(A1/R3):call_ref = 被回填的 tool/call 事件 id——凭据消费事实的显式配对键。 */
export type ToolResultPayload =
  | { tool: string; ok: true; result: unknown; call_ref: number }
  | { tool: string; ok: false; reason: string; call_ref: number; block?: ToolBlock; detail?: unknown };

/** A3:credential_indeterminate 终态的人工核对上报材料(固定五项)。 */
export interface CredentialIndeterminateReport {
  approval_session_id: string;
  tool_call_id: number;
  tool: string;
  approval_key: string;
  window: { granted_id: number | null; watermark: number };
}

/** P2-S3:turn 归属(多 provider 段分支报告;一个 provider 段 = 一个 turn)。 */
export interface TurnAttribution {
  /** 从 1 起,按落盘 turn/start 顺序 */
  turn_index: number;
  provider_id: string;
  /** 本 turn 的 turn/start 事件 id */
  first_event_id: number;
  /** 本 turn 的 turn/end 事件 id(收口后回填) */
  last_event_id: number;
  /** 本 turn 内由该 provider 产出的决策数(含被拒的 provider_switch 请求) */
  decision_count: number;
}

/** P2-S3:切换记录(switched = 事件已落盘且新 provider 已生效;rejected = 未落任何事件,非终局)。 */
export type SwitchRecord =
  | { status: "switched"; from: string; to: string; event_id: number; turn_index: number; reason?: string }
  | { status: "rejected"; to: string; block: ProviderSwitchBlock };

export interface BranchRunReport {
  scenario_id: string;
  branch_id: string;
  run_id: string;
  purpose: string;
  workspace_root: string;
  outcome: BranchOutcome;
  exit_code: 0 | 1 | 75 | 78 | 79;
  /** 本次分支实际落盘的事件序列（内存序列，与磁盘 replay 对账） */
  events: SessionEvent[];
  /** GuardedSessionLog.replay 结果（null = replay 基础设施故障，见 replay_error） */
  replay: GuardedReplayOutcome | null;
  replay_error: SessionError | null;
  /** Artifact Catalog 登记项（读取失败 = 空数组 + catalog_error） */
  catalog: CatalogEntry[];
  catalog_error: WorkspaceError | null;
  /** 期望核验违例清单（空 = 分支验收通过） */
  expect_violations: string[];
  /** A3:问答轨 indeterminate 终态的上报材料(仅该终态出现) */
  credential_indeterminate?: CredentialIndeterminateReport;
  /** P2-S3:turn 归属与切换记录(仅多 provider 段分支或发生过切换请求时携带) */
  turns?: TurnAttribution[];
  switches?: SwitchRecord[];
}

export interface RunBranchOptions {
  /** runs 根目录（owner 口径 #1：harness 仓测试工作区，如 <repo>/tmp/runs） */
  runsRoot: string;
  /** mock 对端 spawn argv（如 ["node", <repo>/tests/fixtures/mock_atf.mjs]） */
  mockCommand: readonly string[];
  /** 默认 true：运行前清理同 run_id 既有工作区（验收运行语义，防既有流污染） */
  fresh?: boolean;
  /** 时间源注入（默认 UTC ISO 8601） */
  now?: () => string;
  /** P2-S2:问答轨审批面声明。缺省 = 账本轨-only(Phase 1 行为逐位一致,headless 等价性);
   *  声明后:账本轨优先,未命中走问答轨(桩对端应答,决议 §3.2 口径 #6/#8)。 */
  approvalSurface?: { stub: ApprovalStub };
  /** 切片 0（任务书 §2.2 守卫可测性 seam）：注入**模型面 provider**（LlmProvider）——其返回值
   *  经运行时守卫 assertModelDecision 校验（守卫作用域 = provider 接口）。缺省 = 既有行为
   *  逐位不变（段模式缺省注册表 / 单段 FauxProvider.fromBranch，均为脚本执行器，守卫豁免）。 */
  modelProvider?: LlmProvider;
}

export class ScenarioRunner {
  /**
   * 执行单个场景分支并产出报告（会话重建 / catalog / 期望核验全部在报告中承载）。
   * 失败路径：Result err（setup 前的基础设施故障）；分支内失败 = report.outcome.failed。
   */
  public static async runBranch(
    scenario: Scenario,
    branchId: string,
    options: RunBranchOptions,
  ): Promise<Result<BranchRunReport, RunError>> {
    const branchLookup = scenario.branches[branchId];
    if (branchLookup === undefined) {
      return err(runError("invalid_input", `场景 ${scenario.scenario_id} 无此分支: ${branchId}`, { available: Object.keys(scenario.branches) }));
    }
    const branch: ScenarioBranch = branchLookup;
    const now = options.now ?? ((): string => new Date().toISOString());
    const workspaceRoot = join(options.runsRoot, branch.run_id);
    if (options.fresh !== false) {
      try {
        await rm(workspaceRoot, { recursive: true, force: true });
      } catch (cause) {
        return err(runError("workspace_failure", `清理既有 run 工作区失败: ${(cause as Error).message}`, { workspaceRoot }));
      }
    }

    const spawned = await AtfBridgeConnection.spawn({ command: [...options.mockCommand] });
    if (!spawned.ok) {
      return err(runError("bridge_failure", "mock 对端 spawn/握手失败", spawned.error));
    }
    const connection = spawned.value;

    let outcome: BranchOutcome = { kind: "failed", error: runError("provider_failure", "分支未执行（占位，不应外泄）") };
    const events: SessionEvent[] = [];
    let credentialIndeterminate: CredentialIndeterminateReport | undefined;
    let replay: GuardedReplayOutcome | null = null;
    let replayError: SessionError | null = null;
    let catalog: CatalogEntry[] = [];
    let catalogError: WorkspaceError | null = null;
    /** P2-S3:turn 归属与切换记录(finalize 组装报告用;仅段分支/有切换请求时非空) */
    const turnRecords: TurnAttribution[] = [];
    const switchRecords: SwitchRecord[] = [];
    const segmentMode = (branch.segments?.length ?? 0) > 0;

    try {
      // ---------------- setup：账本预录（经桥接，owner 口径 #3；契约 v2 审批链形态） ----------------
      const scopeRef: ScopeRef = {
        project_id: scenario.scenario_id,
        scope_type: "run",
        scope_id: branch.run_id,
        scope_mode: "headless",
      };
      for (const entry of branch.setup.ledger) {
        const recorded = await connection.request("ledger_record", {
          scope_ref: scopeRef,
          tool: entry.tool,
          params_digest: approvalParamsDigest(entry.params),
        });
        if (!recorded.ok) {
          outcome = { kind: "failed", error: runError("setup_failure", `账本预录失败（${entry.tool}）`, recorded.error) };
          return finalize();
        }
      }

      // ---------------- 工作区 + 会话（GuardedSessionLog 承载，owner 口径 #6） ----------------
      const workspace = await RunWorkspace.create(
        workspaceRoot,
        { run_id: branch.run_id, trigger_instruction: branch.trigger_instruction, model_id: "faux" },
        { now },
      );
      if (!workspace.ok) {
        outcome = { kind: "failed", error: runError("workspace_failure", "run 工作区创建失败", workspace.error) };
        return finalize();
      }
      const ws = workspace.value;
      const resolver = new FactScanResolver(connection, branch.run_id);
      const guarded = await GuardedSessionLog.create(ws.sessionLogPath, resolver, ws.scratchDir, { now });
      if (!guarded.ok) {
        outcome = { kind: "failed", error: runError("session_failure", "会话日志创建失败", guarded.error) };
        return finalize();
      }
      const session = guarded.value;
      const executor = new ToolExecutor(connection, ToolRegistry.createDefault(), scopeRef);

      // P2-S3:多 provider 段分支(segments)= 一段一个 turn,段边界即合法切换边界;
      // 缺省 = 单 provider 分支(FauxProvider.fromBranch 既有路径逐位不变)。
      // 切片 0:决策面双轨——LlmProvider(模型面,经运行时守卫)| ScriptedStepSource(测试脚本
      // 执行器,非模型面,守卫豁免);options.modelProvider 为模型面注入 seam(守卫可测性)。
      const segments: readonly ProviderSegment[] = branch.segments ?? [];
      const registry: ProviderRegistry | null = segmentMode ? createDefaultProviderRegistry() : null;
      let segIdx = 0;
      let provider: LlmProvider | ScriptedStepSource | null =
        options.modelProvider !== undefined
          ? options.modelProvider
          : segmentMode && registry !== null
            ? registry.create((segments[0] as ProviderSegment).provider_id, branch.branch_id, (segments[0] as ProviderSegment).steps)
            : FauxProvider.fromBranch(branch);
      if (segmentMode && provider === null) {
        // 注册面未命中(防御路径,parseScenario 已拦一致性与非空;此处兜底 fail-closed)
        outcome = {
          kind: "failed",
          error: runError("invalid_input", `初始 provider 未注册: ${(segments[0] as ProviderSegment).provider_id}`, { registered: registry?.ids() ?? [] }),
        };
      }

      // A2:恢复水位线——打开会话后立即取值并固定(流内最大事件 id,全新 run = 0,含 session/repair
      // 审计事件);取值后不随后续 append 变化,问答轨凭据判定以此区分旧遗留与新注入。
      const recoveryWatermark = await readStreamMaxId(async () =>
        readFile(ws.sessionLogPath, "utf8").then(
          (text) => text,
          () => "",
        ),
      );
      const approvalHandler = options.approvalSurface === undefined
        ? undefined
        : createApprovalTrackHandler({
            appendEvent: async (input) => await appendEvent(input),
            events,
            // R2 持久化前置:runner 的会话恒为逐条 fsync 档(未注入 fsync 选项),ack 即已持久化——
            // 「档位断言」路径成立,此处恒确认成功;批量档下的 flush 确认由 handler 层注入测试覆盖
            // (SessionLog.flush 公开口),跨进程恢复的批量档语义属 Phase 3 run-resume。
            flush: async () => ({ ok: true }),
            recoveryWatermark,
            stub: options.approvalSurface.stub,
          });

      /** 追加事件（无引用步骤不应触发铁律一——命中即 harness 故障）。 */
      const appendEvent = async (input: SessionEventInput): Promise<SessionEvent | null> => {
        const appended = await session.append(input);
        if (!appended.ok) {
          outcome = { kind: "failed", error: runError("session_failure", `会话事件写入失败（${input.type}）`, appended.error) };
          return null;
        }
        if (appended.value.status === "rejected") {
          outcome = { kind: "failed", error: runError("session_failure", "非引用步骤被铁律一拒绝（守卫意外命中）", appended.value.block) };
          return null;
        }
        events.push(appended.value.event);
        return appended.value.event;
      };

      const appendTurnEnd = async (reason: string): Promise<void> => {
        const appended = await session.append({ type: "turn/end", payload: { reason } });
        if (appended.ok && appended.value.status === "appended") {
          events.push(appended.value.event);
          closeTurnRecord();
          return;
        }
        // 收口写失败：不覆盖既有终局语义（78 / 会话拒绝 / 1 锚点与原因优先留痕）；
        // 仅成功分支折算失败（completed 语义依赖完整 turn）
        if (outcome.kind === "completed") {
          outcome = {
            kind: "failed",
            error: runError("session_failure", "turn 收口写入失败", appended.ok ? appended.value.status : appended.error),
          };
        }
      };

      // ---------------- P2-S3:turn 归属与切换协议(多 provider 段) ----------------
      let currentTurn: TurnAttribution | null = null;
      let turnDecisionCount = 0;

      const openTurnRecord = (turnProvider: LlmProvider | ScriptedStepSource): void => {
        const first = events[events.length - 1];
        currentTurn = {
          turn_index: turnRecords.length + 1,
          provider_id: turnProvider.providerId,
          first_event_id: first?.id ?? 0,
          last_event_id: first?.id ?? 0,
          decision_count: 0,
        };
        turnDecisionCount = 0;
      };

      const closeTurnRecord = (): void => {
        if (currentTurn === null) return;
        currentTurn.decision_count = turnDecisionCount;
        const last = events[events.length - 1];
        currentTurn.last_event_id = last?.id ?? currentTurn.first_event_id;
        turnRecords.push(currentTurn);
        currentTurn = null;
        turnDecisionCount = 0;
      };

      /**
       * 段边界切换协议(口径 #5–#7,顺序固定):注册面 → 边界复核 → digest 前复核 →
       * 落盘 switch 事件 → digest 后复核 → 激活新 provider。任一前置失败 = 不落事件、
       * 不切换;落盘后复核失败 = 流不可信 → run 终局(新 provider 不激活,无半生效)。
       */
      const performSwitch = async (
        fromProvider: LlmProvider | ScriptedStepSource,
        segment: ProviderSegment,
      ): Promise<{ kind: "switched"; provider: LlmProvider | ScriptedStepSource; eventId: number } | { kind: "rejected"; block: ProviderSwitchBlock } | { kind: "failed"; error: ReturnType<typeof runError> }> => {
        if (registry === null) return { kind: "failed", error: runError("invalid_input", "非段分支不得切换") };
        const next = registry.create(segment.provider_id, branch.branch_id, segment.steps);
        if (next === null) {
          return {
            kind: "rejected",
            block: {
              reason: "provider_switch_unknown_provider",
              message: `切换目标 provider 未注册: ${segment.provider_id}(不落 switch 事件,不放行切换)`,
              detail: { provider_id: segment.provider_id, registered: registry.ids() },
            },
          };
        }
        const boundaryBlock = checkSwitchBoundary(turnOpen, { to: segment.provider_id });
        if (boundaryBlock !== null) return { kind: "rejected", block: boundaryBlock };
        const pre = await verifyDigestContinuity(events, resolver, "pre");
        if (!pre.ok) return { kind: "rejected", block: pre.error };
        const closedTurnIndex = currentTurn?.turn_index ?? turnRecords.length;
        const lastEvent = events[events.length - 1];
        const payload = buildSwitchPayload(
          fromProvider.providerId,
          segment.provider_id,
          closedTurnIndex,
          lastEvent?.id ?? 0,
          segment.reason,
        );
        const appended = await appendEvent({ type: "provider/switch", payload });
        if (appended === null) {
          return { kind: "failed", error: runError("session_failure", "provider/switch 事件落盘失败(fail-closed,不切换)") };
        }
        const post = await verifyDigestContinuity(events, resolver, "post");
        if (!post.ok) {
          return { kind: "failed", error: runError("session_failure", "provider/switch 落盘后 digest 复核失败(流不可信,新 provider 不激活)", post.error) };
        }
        return { kind: "switched", provider: next, eventId: appended.id };
      };

      if (provider !== null) {
        await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
        await appendEvent({ type: "user/message", payload: { text: branch.trigger_instruction } });
        openTurnRecord(provider);
      }

      let lastAdmittedFact: DomainRef | undefined;
      let turnOpen = provider !== null;

      // ---------------- 决策循环（Faux 线性回放，owner 口径 #5；P2-S3 起支持多 provider 段） ----------------
      for (;;) {
        if (provider === null) break; // 初始注册失败已折算(防御路径,不进入决策)
        const decided = await provider.decide(transformContext(events));
        if (!decided.ok) {
          outcome = { kind: "failed", error: runError("provider_failure", `provider 决策失败: ${decided.error.message}`, decided.error) };
          break;
        }
        const raw = decided.value;
        if (raw === null) {
          // P2-S3:段分支脚本耗尽 = 段边界——非末段执行切换协议;末段/单 provider 分支 = 既有未收束终局
          if (segmentMode && segIdx < segments.length - 1) {
            const nextSegment = segments[segIdx + 1] as ProviderSegment;
            await appendTurnEnd("provider_switch");
            turnOpen = false;
            const switched = await performSwitch(provider, nextSegment);
            if (switched.kind === "switched") {
              switchRecords.push({
                status: "switched",
                from: provider.providerId,
                to: nextSegment.provider_id,
                event_id: switched.eventId,
                turn_index: turnRecords.length,
                ...(nextSegment.reason !== undefined ? { reason: nextSegment.reason } : {}),
              });
              provider = switched.provider;
              segIdx += 1;
              await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
              openTurnRecord(provider);
              turnOpen = true;
              continue;
            }
            if (switched.kind === "rejected") {
              // 段边界切换被拒:不落 switch 事件、不放行切换——无决策可用,分支按故障终局(fail-closed)
              switchRecords.push({ status: "rejected", to: nextSegment.provider_id, block: switched.block });
              outcome = { kind: "failed", error: runError("provider_failure", `段边界切换被拒(${switched.block.reason}): ${switched.block.message}`, switched.block) };
              break;
            }
            outcome = { kind: "failed", error: switched.error };
            break;
          }
          outcome = { kind: "failed", error: runError("provider_failure", "分支决策序列耗尽而未收束（须以 final_answer 收尾或以 block 终局）") };
          break;
        }
        // 切片 0 运行时守卫（任务书 §2.2）：作用域 = LlmProvider 接口（模型面）返回值——
        // 脚本执行器（decisionFace = "script"，测试路径）类型级豁免（保全路径 b）。
        // 非模型面步骤 → fail-closed：assistant/attempt 落事件留痕（含被拒 type）+ failed 终局，
        // 不吞错、不降级忽略。
        if (!("decisionFace" in provider)) {
          const guard = assertModelDecision(raw);
          if (!guard.ok) {
            const rejectedType =
              typeof raw === "object" && raw !== null && "type" in raw ? String((raw as { type: unknown }).type) : typeof raw;
            const attempted = await appendEvent({
              type: "assistant/attempt",
              payload: { rejected_type: rejectedType, reason: MODEL_DECISION_FORBIDDEN, message: guard.reason },
            });
            if (attempted === null) {
              outcome = { kind: "failed", error: runError("session_failure", "守卫留痕事件（assistant/attempt）写入失败") };
              turnOpen = false;
              await appendTurnEnd("failed");
              break;
            }
            outcome = {
              kind: "failed",
              error: runError("model_decision_forbidden", `模型决策含模型面外步骤（fail-closed）: type=${rejectedType}（${guard.reason}）`, {
                rejected_type: rejectedType,
                reason: guard.reason,
              }),
            };
            turnOpen = false;
            await appendTurnEnd("failed");
            break;
          }
        }
        const step: ScenarioStep = raw;
        turnDecisionCount += 1;

        if (step.type === "provider_switch") {
          // 越界切换请求(turn 内,口径 #5):拒绝,不落 switch 事件,非终局——同 provider 继续
          const block = checkSwitchBoundary(turnOpen, { to: step.to, ...(step.reason !== undefined ? { reason: step.reason } : {}) });
          if (block !== null) {
            switchRecords.push({ status: "rejected", to: step.to, block });
            continue;
          }
          // 决策循环内 turn 恒开——到达此处 = harness 不变式违反,折算故障(fail-closed)
          outcome = { kind: "failed", error: runError("session_failure", "不变式违反:决策循环内出现已收口 turn(切换请求无边界可依)") };
          break;
        }

        if (step.type === "assistant_message" || step.type === "final_answer") {
          const appended = await appendEvent({ type: "assistant/message", payload: { text: step.text } });
          if (appended === null) break;
          if (step.type === "final_answer") {
            outcome = { kind: "completed" };
            turnOpen = false;
            await appendTurnEnd("completed");
            break;
          }
          continue;
        }

        if (step.type === "tool_call") {
          const call = await appendEvent({ type: "tool/call", payload: { tool: step.tool, params: step.params } });
          if (call === null) break;
          // P2-S2:审批面缺省 = 账本轨-only(Phase 1 逐位一致,headless 等价性);
          // 声明后账本轨优先,未命中走问答轨(handler 发起/延续审批会话)。
          const gate: ApprovalGate | undefined = approvalHandler === undefined
            ? undefined
            : { handler: (gateInput) => approvalHandler({ ...gateInput, tool_call_id: call.id }) };
          const result: ToolCallOutcome = await executor.execute(step.tool, step.params, gate);

          // 证据链：cite_admitted_fact = 把最近一次成功准入的三元组作为本 tool/result 的 domain_refs
          let refs: DomainRef[] | undefined;
          if (step.cite_admitted_fact === true) {
            if (lastAdmittedFact === undefined) {
              outcome = { kind: "failed", error: runError("invalid_input", "cite_admitted_fact=true 但此前无成功准入事实（脚本与执行序不一致）") };
              break;
            }
            refs = [lastAdmittedFact];
          }

          // 问答轨终态先行处理:调用未执行,无结果回填——审批链(tool/call + request + response)即事实
          if (result.kind === "suspended" || result.kind === "aborted") {
            outcome = result.kind === "suspended"
              ? { kind: "suspended", block: result.block }
              : { kind: "aborted", block: result.block };
            turnOpen = false;
            await appendTurnEnd(outcome.kind);
            break;
          }

          const payload: ToolResultPayload =
            result.kind === "executed"
              ? { tool: step.tool, ok: true, result: result.result, call_ref: call.id }
              : result.kind === "rejected"
                ? { tool: step.tool, ok: false, reason: result.reason, call_ref: call.id, detail: result.detail }
                : result.kind === "failed"
                  ? { tool: step.tool, ok: false, reason: "failed", call_ref: call.id, detail: result.error }
                  : { tool: step.tool, ok: false, reason: result.block.reason, call_ref: call.id, block: result.block };
          const appended = await appendEvent({ type: "tool/result", payload, domain_refs: refs });
          if (appended === null) break;

          if (result.kind === "executed") {
            if (step.tool === "atf_admit_data") {
              // canonical output 已保证三元组字段存在（S3 逐次校验）
              const fact = result.result as { journal_type: string; fact_id: string; sha256_digest: string };
              lastAdmittedFact = { journal_type: fact.journal_type, fact_id: fact.fact_id, sha256_digest: fact.sha256_digest };
            }
            continue;
          }
          if (result.kind === "blocked") {
            if (result.block.reason === "approval_missing") {
              // headless 账本轨终局(ADR-07):approval_missing 即终止——无自动应答、不重试(语义零改动)
              outcome = { kind: "approval_missing", block: result.block };
              turnOpen = false;
              await appendTurnEnd("approval_missing");
              break;
            }
            if (result.block.reason === "credential_indeterminate") {
              // A3:事实缺口 → run 终态 failed(1) + 固定五项上报材料;终态不被后续写失败覆盖(既有收口规则)
              const detail = (result.block.detail ?? {}) as {
                credential?: { approval_session_id: string; request_event_ref: number };
                window?: { granted_id: number | null; watermark: number };
              };
              outcome = {
                kind: "failed",
                error: runError("credential_indeterminate", result.block.message, result.block.detail),
              };
              credentialIndeterminate = {
                approval_session_id: detail.credential?.approval_session_id ?? "",
                tool_call_id: call.id,
                tool: step.tool,
                approval_key: detail.credential !== undefined ? (result.block.detail as { approval_key?: string }).approval_key ?? "" : "",
                window: {
                  granted_id: detail.window?.granted_id ?? null,
                  watermark: detail.window?.watermark ?? recoveryWatermark,
                },
              };
              turnOpen = false;
              await appendTurnEnd("credential_indeterminate");
              break;
            }
            if (result.block.reason === "credential_persist_failed" || result.block.reason === "approval_track_failed") {
              // harness 侧持久化/编排失败:不放行且不可安全继续 → 终局(fail-closed)
              outcome = {
                kind: "failed",
                error: runError("session_failure", result.block.message, result.block.detail),
              };
              turnOpen = false;
              await appendTurnEnd("approval_track_failed");
              break;
            }
            // approval_denied / credential_consumed / credential_invalid:结构化回填已落盘,
            // 模型可换路径(重提计数由编排器状态承载,达阈值升级)——非终局
            if (outcome.kind === "failed" && outcome.error.code === "session_failure") break; // 会话写路径已真实折算失败(初始占位不算)
            continue;
          }
          // rejected / failed：结构化回填已落盘，分支按故障终局（不猜测成功）
          outcome =
            result.kind === "rejected"
              ? { kind: "failed", error: runError("bridge_failure", `对端业务拒绝（${step.tool}）: ${result.reason}`, result.detail) }
              : { kind: "failed", error: runError("bridge_failure", `工具执行故障（${step.tool}）: ${result.error.message}`, result.error) };
          turnOpen = false;
          await appendTurnEnd(outcome.kind === "failed" ? "failed" : "rejected");
          break;
        }

        if (step.type === "scratch_write") {
          const written = await ws.scratchWrite(step.path, step.content);
          if (!written.ok) {
            outcome = { kind: "failed", error: runError("workspace_failure", `scratch 写入失败（${step.path}）`, written.error) };
            break;
          }
          continue;
        }

        if (step.type === "promote") {
          const registered = await ws.registerReproduce(step.source, step.command);
          if (!registered.ok) {
            outcome = { kind: "failed", error: runError("workspace_failure", `复现命令登记失败（${step.source}）`, registered.error) };
            break;
          }
          const promoted = await promoteArtifact(ws, step.source, { now });
          if (!promoted.ok) {
            outcome = { kind: "failed", error: runError("workspace_failure", `晋升失败（${step.source}）`, promoted.error) };
            break;
          }
          if (promoted.value.kind !== "promoted") {
            outcome = { kind: "failed", error: runError("workspace_failure", "单次晋升被闸门拒绝（与脚本预期不符，须人工核查）", promoted.value.block) };
            break;
          }
          continue;
        }

        if (step.type === "cite_t0") {
          // 引用真实 T0 产物：digest 取自 scratch 文件字节（无占位符）
          let sourceBytes: Buffer;
          try {
            sourceBytes = await readFile(join(ws.scratchDir, step.source));
          } catch (cause) {
            outcome = { kind: "failed", error: runError("workspace_failure", `被引用的 T0 产物不存在: ${step.source}`, String(cause)) };
            break;
          }
          const cited: DomainRef = {
            journal_type: "workspace_artifact",
            fact_id: `scratch/${step.source}`,
            sha256_digest: sha256Hex(sourceBytes),
          };
          const attempted = await session.append({ type: "assistant/message", payload: { text: step.text }, domain_refs: [cited] });
          if (!attempted.ok) {
            outcome = { kind: "failed", error: runError("session_failure", "引用尝试事件处理失败", attempted.error) };
            break;
          }
          if (attempted.value.status === "rejected") {
            // 铁律一生效：事件不落盘，分支终局（owner 口径 #4：会话层拒绝 = exit 1，不走 78）
            outcome = { kind: "session_rejected", block: attempted.value.block };
            turnOpen = false;
            await appendTurnEnd("session_rejected");
            break;
          }
          outcome = { kind: "failed", error: runError("session_failure", "T0 引用未被拒绝（铁律一守卫缺位，fail-closed 折算故障）") };
          break;
        }
      }

      if (turnOpen) {
        // 循环以故障退出时补收口（尽量保留完整 turn 形态；写失败不改写既有终局语义）
        const closed = await appendEvent({ type: "turn/end", payload: { reason: outcome.kind } });
        if (closed !== null) {
          closeTurnRecord();
          turnOpen = false;
        }
      }

      // S2a C-2：会话句柄显式关闭（决议 §3.3，消除 FileHandle GC 回收警告）。
      // 逐条档 flush 为空操作；关闭失败仅留此注记、不改写既有终局语义（零行为变化）。
      await session.close().catch(() => undefined);

      // ---------------- 会话重建 + catalog（验收承载；resolver 仍经存活连接查询 mock 状态） ----------------
      const replayed = await GuardedSessionLog.replay(ws.sessionLogPath, resolver, ws.scratchDir);
      if (replayed.ok) replay = replayed.value;
      else replayError = replayed.error;
      const catalogLoaded = await loadCatalog(ws.catalogPath);
      if (catalogLoaded.ok) catalog = catalogLoaded.value.artifacts;
      else catalogError = catalogLoaded.error;

      return finalize();
    } finally {
      await connection.close().catch(() => undefined);
    }

    /** 组装报告（含期望核验；以函数收口避免 try 内多处 return 的资源遗漏）。 */
    function finalize(): Result<BranchRunReport, RunError> {
      const report: BranchRunReport = {
        scenario_id: scenario.scenario_id,
        branch_id: branch.branch_id,
        run_id: branch.run_id,
        purpose: branch.purpose,
        workspace_root: workspaceRoot,
        outcome,
        exit_code: resolveRunExitCode(outcome),
        events,
        replay,
        replay_error: replayError,
        catalog,
        catalog_error: catalogError,
        expect_violations: evaluateExpectations(branch.expect, {
          outcome,
          exit_code: resolveRunExitCode(outcome),
          events,
          replay,
          catalog,
        }),
        ...(credentialIndeterminate !== undefined ? { credential_indeterminate: credentialIndeterminate } : {}),
        ...(segmentMode || switchRecords.length > 0
          ? { turns: [...turnRecords], switches: [...switchRecords] }
          : {}),
      };
      return ok(report);
    }
  }
}

/** tool/result 中 gate 结果状态序列（first/last 供期望核验）。 */
const gateStatuses = (events: readonly SessionEvent[]): string[] => {
  const statuses: string[] = [];
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const payload = event.payload as ToolResultPayload;
    if (payload.tool !== "atf_gate" || payload.ok !== true) continue;
    const status = (payload.result as { status?: unknown } | null | undefined)?.status;
    if (typeof status === "string") statuses.push(status);
  }
  return statuses;
};

/** 期望核验：逐项比对脚本 expect 与分支报告，返回违例清单（空 = 通过）。 */
export const evaluateExpectations = (
  expect: ScenarioExpect,
  actual: {
    outcome: BranchOutcome;
    exit_code: 0 | 1 | 75 | 78 | 79;
    events: readonly SessionEvent[];
    replay: GuardedReplayOutcome | null;
    catalog: readonly CatalogEntry[];
  },
): string[] => {
  const violations: string[] = [];
  if (actual.outcome.kind !== expect.outcome) {
    violations.push(`outcome 不符：期望 ${expect.outcome}，实得 ${actual.outcome.kind}`);
  }
  if (actual.exit_code !== expect.exit_code) {
    violations.push(`exit_code 不符：期望 ${String(expect.exit_code)}，实得 ${String(actual.exit_code)}`);
  }
  if (expect.block_reason !== undefined) {
    const reason =
      actual.outcome.kind === "approval_missing"
        ? actual.outcome.block.reason
        : actual.outcome.kind === "session_rejected"
          ? actual.outcome.block.reason
          : undefined;
    if (reason !== expect.block_reason) {
      violations.push(`block_reason 不符：期望 ${expect.block_reason}，实得 ${String(reason)}`);
    }
  }
  if (expect.gate_status !== undefined || expect.first_gate_status !== undefined) {
    const statuses = gateStatuses(actual.events);
    if (expect.first_gate_status !== undefined && statuses[0] !== expect.first_gate_status) {
      violations.push(`首次 gate 状态不符：期望 ${expect.first_gate_status}，实得 ${String(statuses[0])}`);
    }
    if (expect.gate_status !== undefined && statuses[statuses.length - 1] !== expect.gate_status) {
      violations.push(`末次 gate 状态不符：期望 ${expect.gate_status}，实得 ${String(statuses[statuses.length - 1])}`);
    }
  }
  if (expect.promoted === true && actual.catalog.length === 0) {
    violations.push("promoted 不符：catalog 无登记项");
  }
  if (expect.replayable === true) {
    if (actual.replay === null || actual.replay.kind !== "replayed") {
      violations.push(`replayable 不符：replay 未成功${actual.replay === null ? "（基础设施故障）" : "（判 blocked）"}`);
    }
  }
  if (expect.domain_refs_valid === true) {
    if (actual.replay === null || actual.replay.kind !== "replayed") {
      violations.push("domain_refs_valid 不符：replay 未成功，无法核验");
    } else {
      if (actual.replay.blocks.length > 0) {
        violations.push(`domain_refs_valid 不符：replay 发现 ${String(actual.replay.blocks.length)} 个 ref_invalid block`);
      }
      if (!actual.events.some(hasDomainRefs)) {
        violations.push("domain_refs_valid 不符：会话中无任何携带 domain_refs 的事件（证据链为空）");
      }
    }
  }
  return violations;
};
