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
 * 账本/setup 纪律：预录经桥接 ledger_record（owner 口径 #3：mock 对端进程内状态承载）；
 * 预录 params 与工具调用 params 严格一致（审批键 = tool + params digest，脚本内显式重复可审计）。
 */
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { AtfBridgeConnection } from "../bridge/index.js";import {
  FauxProvider,
  type Scenario,
  type ScenarioBranch,
  type ScenarioExpect,
} from "../llm/index.js";
import {
  approvalKeyFor,
  resolveHeadlessExitCode,
  ToolExecutor,
  ToolRegistry,
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
import { type ApprovalGate } from "../tools/index.js";
import { SurfaceScanResolver } from "./surfaceScanResolver.js";

export type RunErrorCode =
  | "invalid_input" // 场景/分支/选项非法（分支不存在、run_id 逃逸等）
  | "bridge_failure" // mock 对端 spawn/握手失败
  | "setup_failure" // 账本预录等 setup 失败
  | "workspace_failure" // 工作区创建 / scratch 写入 / 晋升失败
  | "session_failure" // 会话事件写入失败 / 铁律一意外缺位
  | "provider_failure" // provider 故障 / 决策序列耗尽而未收束
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

    try {
      // ---------------- setup：账本预录（经桥接，owner 口径 #3） ----------------
      for (const entry of branch.setup.ledger) {
        const recorded = await connection.request("ledger_record", approvalKeyFor(entry.tool, entry.params));
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
      const resolver = new SurfaceScanResolver(connection);
      const guarded = await GuardedSessionLog.create(ws.sessionLogPath, resolver, ws.scratchDir, { now });
      if (!guarded.ok) {
        outcome = { kind: "failed", error: runError("session_failure", "会话日志创建失败", guarded.error) };
        return finalize();
      }
      const session = guarded.value;
      const executor = new ToolExecutor(connection, ToolRegistry.createDefault());
      const provider = FauxProvider.fromBranch(branch);

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

      await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
      await appendEvent({ type: "user/message", payload: { text: branch.trigger_instruction } });

      let lastAdmittedFact: DomainRef | undefined;
      let turnOpen = true;

      // ---------------- 决策循环（Faux 线性回放，owner 口径 #5） ----------------
      for (;;) {
        const decided = await provider.decide(transformContext(events));
        if (!decided.ok) {
          outcome = { kind: "failed", error: runError("provider_failure", `provider 决策失败: ${decided.error.message}`, decided.error) };
          break;
        }
        const step = decided.value;
        if (step === null) {
          outcome = { kind: "failed", error: runError("provider_failure", "分支决策序列耗尽而未收束（须以 final_answer 收尾或以 block 终局）") };
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
        if (closed !== null) turnOpen = false;
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
