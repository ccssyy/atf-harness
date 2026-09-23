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
import { err, ok, type Result } from "../../bridge/index.js";
import { AtfBridgeConnection } from "../../bridge/index.js";import {
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
} from "../../llm/index.js";
import type { LlmProvider } from "../../llm/index.js";
import { isLengthAwareLlmProvider } from "../../llm/index.js";
import { loopMaxStepsPerTurn, loopMaxTurns } from "../session/constants.js";
import { resolveExhaustionStop, resolveLengthRecovery, type LoopStopReason } from "./stopReason.js";
import { REJECT_LOOP_LIMIT } from "./constants.js";
import {
  NoProgressDetector,
  NO_PROGRESS_NUDGE_NOTE,
  TOOL_CUT_NOTE,
  TOOL_CUT_REASON,
  type NoProgressObservation,
} from "./noProgress.js";
import { gapCardFor, guidanceLineFor, isMaterialGapCode, lengthTruncatedGapCard } from "./blockGuidance.js";
import { injectMemoryEntries, type MemoryReadInjector } from "./memoryInjection.js";
import {
  approvalParamsDigest,
  resolveHeadlessExitCode,
  ToolExecutor,
  ToolRegistry,
  type LocalToolHandler,
  type LocalToolHost,
  type ScopeRef,
  type ToolBlock,
  type ToolCallOutcome,
} from "../tools/index.js";
import {
  GuardedSessionLog,
  loadCatalog,
  promoteArtifact,
  readRunProvenance,
  RunWorkspace,
  sha256Hex,
  type CatalogEntry,
  type GuardedReplayOutcome,
  type ProvenanceInput,
  type WorkspaceError,
} from "../workspace/index.js";
import {
  hasDomainRefs,
  projectContext,
  type DomainRef,
  type SessionError,
  type SessionEvent,
  type SessionEventInput,
} from "../session/index.js";
import { compactionTriggerTokens, turnTokenBudget, TURN_BUDGET_WARN_RATIO, TURN_HARD_STEP_FUSE_DEFAULT } from "../session/constantsBudget.js";
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
import { GATE_LEGAL_IDS, type ApprovalGate } from "../tools/index.js";
import { FactScanResolver } from "./factScanResolver.js";
import type { RunEventSubscriber } from "../projection.js";
import { deriveLoopStateFromEvents } from "./loopState.js";
import {
  buildAnswerPayload,
  listPendingApprovals,
  parseSessionStream,
  resolveAnswerTarget,
  type ChannelVerdict,
} from "./resume.js";

export type RunErrorCode =
  | "invalid_input" // 场景/分支/选项非法（分支不存在、run_id 逃逸等）
  | "bridge_failure" // mock 对端 spawn/握手失败
  | "setup_failure" // 账本预录等 setup 失败
  | "workspace_failure" // 工作区创建 / scratch 写入 / 晋升失败
  | "session_failure" // 会话事件写入失败 / 铁律一意外缺位
  | "provider_failure" // provider 故障 / 决策序列耗尽而未收束
  | "model_decision_forbidden" // 切片 0：provider 返回值含模型面外步骤（运行时守卫 fail-closed，exit 1）
  | "budget_exhausted" // 切片 1：轮次预算耗尽（max_steps_per_turn / max_turns；A2，复用 exit 1）
  | "credential_indeterminate" // 问答轨凭据状态不确定（A3：run 终态，需人工核对，exit 1）
  | "reject_loop_exhausted"; // 快修批 D-a R-2：单 turn 连续工具错误回流达 REJECT_LOOP_LIMIT（exit 1）

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

/** 三件小批 D-1（2026-09-21）：turn 级失败收口摘要——阈值触发（reject_loop_exhausted）时
 *  随 turn/end payload（failure_summary，可选字段）与 BranchOutcome.turn_failed 携带；
 *  受众＝用户（TUI 呈现）与审计（模型上下文投影 turn/end 为 skip，模型侧纠错依据＝
 *  已回流的 rejected tool/result ＋ atf_gate 描述常驻合法清单）。
 *  D-f 批（2026-09-21）扩展：reason 扩为五值并集（reject_loop_exhausted 保首，新增
 *  same_call_repeat／no_progress／budget_exhausted／provider_failure）；rejected/limit 改可选
 *  （reject 径恒填满，其余径按需）；新增阻塞说明（卡在哪/已用轮次——TUI 不显示步数，
 *  steps_used 仅 payload 机查）、缺口卡四段（D-f-6 请示式收口）、切断工具清单。
 *  pi-ai 换库批（2026-09-23）再扩一值：length_truncated（R1/R2——finish_reason=length 的
 *  结构化分型收口；turn/end payload 自由 JSON，五值 stop_reason 枚举零改）。 */
export type TurnFailureReason =
  | "reject_loop_exhausted"
  | "same_call_repeat"
  | "no_progress"
  | "budget_exhausted"
  | "provider_failure"
  | "length_truncated";

export interface TurnBlockingDescription {
  /** 卡在哪（一句话，具体到环节/对象） */
  stuck_at: string;
  /** 本 run 已用 turn 数（用户可见维度=轮次，非步数） */
  turns_used: number;
  /** 本 turn 已用步数（仅 payload 机查，不上屏） */
  steps_used: number;
  /** 微补丁（2026-09-23）：provider HTTP 错误可诊断性——status＋body_excerpt（≤500；错误体
   *  经 httpProvider redact 漏斗前置脱敏，通常不含凭据）＋dump 模式结构性 request_summary
   *  （仅 max_tokens/消息条数/总字符数/工具数，禁全量 body）。完整体不落盘。 */
  provider_error?: {
    status?: number;
    body_excerpt?: string;
    request_summary?: Record<string, unknown>;
  };
}

export interface TurnGapCardOption {
  text: string;
  recommended?: boolean;
}

/** 缺口卡四段（D-f-6 轻形态甲＋：卡在哪·缺什么·为什么需要·可选项≤3 标推荐）。 */
export interface TurnGapCard {
  stuck: string;
  missing: string;
  why: string;
  options: TurnGapCardOption[];
}

export interface TurnFailureSummary {
  reason: TurnFailureReason;
  /** reject_loop_exhausted：REJECT_LOOP_LIMIT；budget_exhausted：LOOP_MAX_STEPS_PER_TURN */
  limit?: number;
  /** reject_loop_exhausted 径携带（≤LIMIT 条连续被拒调用留痕） */
  rejected?: Array<{ tool: string; reason: string; params_digest: string }>;
  /** D-f-2 阻塞说明（卡在哪/已用轮次） */
  blocked_description?: TurnBlockingDescription;
  /** D-f-6 缺口卡（收口时按最后 material-gap 回流自动组装） */
  gap_card?: TurnGapCard;
  /** no_progress 族收口时本 turn 已切断的工具 */
  cut_tools?: string[];
  hint: {
    /** 仅被拒工具含 atf_gate 时携带：合法 GateId 清单（GATE_LEGAL_IDS 单源） */
    gate_ids?: string[];
    note: string;
  };
}

/** 微补丁（2026-09-23）：provider 错误 detail 白名单提取——只取 status/body_excerpt（≤500
 *  再截断）/request_summary；request_body 永不进摘要/审计（大对象不落盘）。 */
const providerErrorDetailOf = (error: { detail?: unknown }): NonNullable<TurnBlockingDescription["provider_error"]> => {
  if (typeof error.detail !== "object" || error.detail === null) return {};
  const detail = error.detail as Record<string, unknown>;
  const out: NonNullable<TurnBlockingDescription["provider_error"]> = {};
  if (typeof detail["status"] === "number") out["status"] = detail["status"];
  if (typeof detail["body_excerpt"] === "string" && detail["body_excerpt"] !== "") {
    out["body_excerpt"] = detail["body_excerpt"].length > 500 ? `${detail["body_excerpt"].slice(0, 500)}…` : detail["body_excerpt"];
  }
  if (typeof detail["request_summary"] === "object" && detail["request_summary"] !== null && !Array.isArray(detail["request_summary"])) {
    out["request_summary"] = detail["request_summary"] as Record<string, unknown>;
  }
  return out;
};

/** body_excerpt 首行（人读，≤limit；供收口行一眼判断）。 */
const firstLineOf = (text: string, limit: number): string => {
  const line = (text.split(/\r?\n/).find((entry) => entry.trim() !== "") ?? "").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/** D-f 收口一句话提示（按 reason 取值；reject 径文案与 D-1 逐字一致，零回归）。 */
const COLLAPSE_NOTES: Record<TurnFailureReason, string> = {
  reject_loop_exhausted: "修正参数后输入新指令即可继续本会话；被拒调用与错误码见上（模型下一 turn 同样可见）",
  same_call_repeat: "检测到同参数重复调用无进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
  no_progress: "检测到重复动作无新进展（控制面护栏）：请换用其他工具/路径，或如实向用户说明情况；输入新指令即可继续本会话",
  budget_exhausted: "本轮预算已用完（运行护栏，非进度指标）：控制权已交还——可直接输入新指令继续，或先收窄任务；输入新指令即可继续本会话",
  provider_failure: "provider 决策失败已按 turn 收口：核对 provider 配置/网络后输入新指令即可继续本会话",
  // pi-ai 换库批 R1：length 分型收口——截断响应不作完整决策执行；降档或续跑（缺口卡同源）
  length_truncated: "模型响应被输出上限截断（finish_reason=length）：截断响应未执行、未入历史；可降低思考等级后重试，或输入新指令以既有历史继续本会话",
};

/** 分支终局(七态穷尽互斥;业务级 gate blocked 是合法 canonical 产出,不是终局——B2 语义):
 *  Phase 1 四态 + P2-S2 问答轨两终态 suspended(75,非终态可恢复)/ aborted(79)
 *  + 三件小批 D-1 turn_failed(turn 级失败收口——本 turn 已收口、run 未终局，
 *  控制权交还调用方：TUI 保持存活可继续输入；headless 以 1 如实退出)。 */
export type BranchOutcome =
  | { kind: "completed" }
  | { kind: "approval_missing"; block: ToolBlock }
  | { kind: "session_rejected"; block: T0RefBlockShape }
  | { kind: "suspended"; block: ToolBlock }
  | { kind: "aborted"; block: ToolBlock }
  | { kind: "turn_failed"; summary: TurnFailureSummary }
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
 * turn_failed = 1（D-1：headless 单 turn 如实退出；交互面由 TUI 保持存活）;
 * 会话层拒绝 / credential_indeterminate / 各类故障 = 1。
 */
export const resolveRunExitCode = (outcome: BranchOutcome): 0 | 1 | 75 | 78 | 79 => {
  switch (outcome.kind) {
    case "completed":
      return 0;
    case "approval_missing":
      return resolveHeadlessExitCode({ kind: "blocked", block: outcome.block });
    case "session_rejected":
    case "turn_failed":
    case "failed":
      return 1;
    case "suspended":
      return 75;
    case "aborted":
      return 79;
  }
};

/** tool/result 事件 payload 形态(结构化回填,供 Faux 断言失败路径与 B2 block 回填验证)。
 *  P2-S2(A1/R3):call_ref = 被回填的 tool/call 事件 id——凭据消费事实的显式配对键。
 *  D-f 批:nudge/guidance 为可选回填附注（无进展 nudge 指引／业务阻断码 guidance 行；
 *  payload 自由 JSON,模型经 convertToLlm 可见——零 schema 变更）。 */
export type ToolResultPayload =
  | { tool: string; ok: true; result: unknown; call_ref: number; nudge?: string }
  | { tool: string; ok: false; reason: string; call_ref: number; block?: ToolBlock; detail?: unknown; nudge?: string; guidance?: string };

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

/** L1a 门 2：resume 应答（通道四类；答复落 approval/response 后于本进程开新 turn 继续——INV-1）。 */
export interface ResumeAnswer {
  verdict: ChannelVerdict;
  /** 人读备注（denied/abort → reason；advised → advice_text；granted 可选 reason） */
  note?: string;
  /** 目标 approval/request 事件 id；缺省 = 恰一个待办时自动指定（多待办缺省 → fail-closed） */
  request_event_id?: number;
  /** 应答 actor 账面标识（缺省 cli-operator） */
  actor?: string;
  /** D4 通道留痕（L1 门 2 T04）：宿主/客户端通道 resume 应答增 channel/host_id
   *  （approval/response 恒增 requires_human_review:true）。缺省不写任何字段——既有通道零改动。 */
  channel?: "acp" | "mcp";
  host_id?: string;
}

/** 对端 spawn 描述符（W2 --peer real：真内核对端需承载 cwd/env；argv 形态的结构化放宽，
 *  归一后直配 AtfBridgeConnection.spawn 既有 cwd/env 面）。 */
export interface PeerSpawnDescriptor {
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** 批 2.5 §一 A2.5：确认直填——harness 确定性合成的待派发动作（确认值已定，模型不重生成参数；
 *  派发经既有审批 gate——第二道人审不变；ui 留痕 origin 恒 "confirm_card"）。 */
export interface PendingConfirmAction {
  tool: string;
  params: Record<string, unknown>;
  origin: "confirm_card";
}

export interface RunBranchOptions {
  /** runs 根目录（owner 口径 #1：harness 仓测试工作区，如 <repo>/tmp/runs） */
  runsRoot: string;
  /** mock 对端 spawn：argv 数组（如 ["node", <repo>/tests/fixtures/mock_atf.mjs]）
   *  或描述符（cwd/env 承载，W2 --peer real）。argv 为联合类型的既有形态，消费点零改动。 */
  mockCommand: readonly string[] | PeerSpawnDescriptor;
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
  /** 切片 2 §1.3：TEM 读闸注入源（v1 可注入桩；缺省不注入 = 无记忆运行）。注入发生在
   *  transformContext 之后、decide 之前（不另起通道）；注入源不可用 → 记事件 + 无记忆运行。 */
  memoryInjector?: MemoryReadInjector;
  /** L1a 门 2：resume 模式——在既有 run 流上应答并开新 turn 继续（任务书 §1.3）。
   *  声明后：不清场重跑、不重做账本预录、不重发首条 user/message；事件流历史装载进本进程
   *  （凭据判定与待办解析据此推导——durability 公理）；须同时声明 modelProvider 与
   *  approvalSurface。fresh 选项在 resume 模式下被忽略（既有流不可清场）。 */
  resume?: ResumeAnswer;
  /** L1b B4（L1b-D2=A）：多轮续跑——在既有 run 流上以新用户指令开新 turn（同进程
   *  多轮与跨进程续跑同一机制：历史由事实日志重放装载）。前置（fail-closed）：
   *  流存在且末 turn 已收口、无待办审批（有待办须经 resume 应答）、turn 预算未耗尽；
   *  须同时声明 modelProvider 与 approvalSurface。fresh 选项被忽略（既有流不可清场）。 */
  continue?: { instruction: string; pendingAction?: PendingConfirmAction };
  /** 批 2.5 §二：run 级预算注入（测试/宿主 seam；缺省走 constantsBudget holder——llm.json 旋钮/env）。
   *  turnTokenBudget 单位＝est tokens（payload chars/2）；hardStepFuse 单位＝步（兜底保险丝）。 */
  budgets?: { turnTokenBudget?: number; hardStepFuse?: number };
  /** 批 3「创作执行面」工具面注入 seam（runner 解冻裁定：本批唯一 runner 改动点——
   *  ① 本 option 字段；② executor 构造一行。缺省不注入＝ToolRegistry.createDefault()＋
   *  无本地分派，既有行为逐位不变）。TUI/resume 注入工作区扩面注册表＋本地工具宿主
   *  （4 个工作区工具：scratch_write/scratch_exec/skill_read/launch_execute）。 */
  toolFace?: {
    registry: ToolRegistry;
    local?: { handlers: Readonly<Record<string, LocalToolHandler>>; host: LocalToolHost };
  };
  /** provenance model_id（缺省 "faux"，既有行为逐位不变；L1a 传入 provider config.model） */
  modelId?: string;
  /** 账本 scope_ref.scope_mode（缺省 "headless"——mock 轨既有行为逐位不变）。
   *  L1a 真实端点复跑适配（复跑报告登记项）：内核 ScopeMode 枚举仅 {canonical, simulation}，
   *  "headless" 为 harness 侧自造值，真实内核拒绝（ledger_query → invalid_params）——
   *  对接真实内核的 run 须显式传 "canonical"。 */
  scopeMode?: "canonical" | "simulation" | "headless";
  /** L1 门 2 T01：投影订阅（core 投影面，src/core/projection.ts）。事件真实落盘后同步
   *  投出（origin=live；resume 装载既有流为 history）——订阅方看到的事件与 append-only
   *  日志逐条一致（INV-A 投影侧）。缺省不订阅 = 既有行为逐位不变。 */
  onEvent?: RunEventSubscriber;
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
    const resumeMode = options.resume !== undefined;
    const continueMode = options.continue !== undefined;
    if (resumeMode && continueMode) {
      return err(runError("invalid_input", "resume 与 continue 互斥（应答续跑与新指令续跑不可同时声明）"));
    }
    const now = options.now ?? ((): string => new Date().toISOString());
    const workspaceRoot = join(options.runsRoot, branch.run_id);
    if (options.fresh !== false && !resumeMode && !continueMode) {
      try {
        await rm(workspaceRoot, { recursive: true, force: true });
      } catch (cause) {
        return err(runError("workspace_failure", `清理既有 run 工作区失败: ${(cause as Error).message}`, { workspaceRoot }));
      }
    }

    // W2：对端 spawn 归一——argv 形态与描述符形态统一到 AtfBridgeConnection.spawn
    //（bridge 原生 cwd/env 面；env 合并在 process.env 之上，语义与生成式 launcher 一致）。
    const peer = options.mockCommand;
    const peerSpawn = "argv" in peer
      ? { command: [...peer.argv], cwd: peer.cwd, env: peer.env }
      : { command: [...peer] };
    const spawned = await AtfBridgeConnection.spawn(peerSpawn);
    if (!spawned.ok) {
      return err(runError("bridge_failure", "mock 对端 spawn/握手失败", spawned.error));
    }
    const connection = spawned.value;

    // L1a 门 2（任务书 §1.4 只读全链）：会话级 run 绑定（atf.bind_run，pin 已含该方法）——
    // 失败 = 会话基线不成立，fail-closed 终局（不猜测未绑定可继续）。
    const bound = await connection.request("atf.bind_run", { run_id: branch.run_id });
    if (!bound.ok) {
      return err(runError("bridge_failure", "atf.bind_run 失败（run 绑定是只读链第一步）", bound.error));
    }

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
      // resume 模式不重做预录（既有授权事实以事件流/内核状态为准，重复预录 = 双份授权面）。
      const scopeRef: ScopeRef = {
        project_id: scenario.scenario_id,
        scope_type: "run",
        scope_id: branch.run_id,
        scope_mode: options.scopeMode ?? "headless",
      };
      // re-pin R2（v0.7.1b0）：setup 预录 wire 切换至 K4 §13.8 形态（typed OperatorCommand）；
      // 场景条目仍以 {tool, params} 表达，runner 映射为 command_id/actor/operation_id/
      // attempt_id/subject_ref/evidence_refs（tool+digest 作审计检索辅助入 evidence_refs）。
      let setupRecordSeq = 0;
      for (const entry of resumeMode || continueMode ? [] : branch.setup.ledger) {
        setupRecordSeq += 1;
        const recorded = await connection.request("ledger_record", {
          scope_ref: scopeRef,
          command_id: `cmd-setup-${entry.tool}-${String(setupRecordSeq)}`,
          actor: "scenario-setup",
          operation_id: `op-${entry.tool}`,
          attempt_id: "1",
          subject_ref: `${entry.tool}:${approvalParamsDigest(entry.params).slice(0, 12)}`,
          evidence_refs: [approvalParamsDigest(entry.params)],
        });
        if (!recorded.ok) {
          outcome = { kind: "failed", error: runError("setup_failure", `账本预录失败（${entry.tool}）`, recorded.error) };
          return finalize();
        }
      }

      // ---------------- 工作区 + 会话（GuardedSessionLog 承载，owner 口径 #6） ----------------
      // L1a：model_id 可经 options.modelId 注入（缺省 "faux"，既有行为逐位不变）；
      // resume 模式以既有 provenance 为准（等值校验在 RunWorkspace.create 内，fail-closed）。
      let provenanceInput: ProvenanceInput = {
        run_id: branch.run_id,
        trigger_instruction: branch.trigger_instruction,
        model_id: options.modelId ?? "faux",
      };
      if (resumeMode || continueMode) {
        const existingProvenance = await readRunProvenance(workspaceRoot);
        if (!existingProvenance.ok) {
          outcome = { kind: "failed", error: runError("invalid_input", "resume 读取既有 provenance 失败", existingProvenance.error) };
          return finalize();
        }
        provenanceInput = existingProvenance.value;
      }
      const workspace = await RunWorkspace.create(workspaceRoot, provenanceInput, { now });
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
      // 批 3：工具面注入 seam（缺省 = createDefault() 无本地分派，既有行为逐位不变）
      const executor = new ToolExecutor(
        connection,
        options.toolFace?.registry ?? ToolRegistry.createDefault(),
        scopeRef,
        options.toolFace?.local,
      );

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

      // L1a resume 前置：模型面 provider 必须注入（resume 无脚本可回放）。
      if ((resumeMode || continueMode) && options.modelProvider === undefined) {
        outcome = { kind: "failed", error: runError("invalid_input", "resume/continue 模式须注入模型面 provider（modelProvider）") };
        return finalize();
      }

      // A2:恢复水位线——打开会话后立即取值并固定(流内最大事件 id,全新 run = 0,含 session/repair
      // 审计事件);取值后不随后续 append 变化,问答轨凭据判定以此区分旧遗留与新注入。
      // L1a resume：水位线取值先于应答落盘（CLI granted 应答 id > 水位线 → 凭据 available，
      // ADR-09 C3 resume(answer) 路径；既有 resolveCredentialState 语义零改动）。
      const recoveryWatermark = await readStreamMaxId(async () =>
        readFile(ws.sessionLogPath, "utf8").then(
          (text) => text,
          () => "",
        ),
      );
      // L1a resume：磁盘历史装载进本进程内存序列——凭据判定 / 待办解析 / turn 归属据此推导
      // （durability 公理：恢复只读本侧事件流）；此后 appendEvent 顺序续接，报告 events = 全流。
      if (resumeMode || continueMode) {
        const historyLabel = resumeMode ? "resume" : "continue";
        const historyText = await readFile(ws.sessionLogPath, "utf8").then(
          (text) => ok(text),
          (cause: NodeJS.ErrnoException) => err({ message: `会话流读取失败: ${String(cause.message)}`, code: cause.code }),
        );
        if (!historyText.ok) {
          outcome = { kind: "failed", error: runError("session_failure", `${historyLabel} 装载既有会话流失败`, historyText.error) };
          return finalize();
        }
        const parsed = parseSessionStream(historyText.value);
        if (!parsed.ok) {
          outcome = { kind: "failed", error: runError("session_failure", `${historyLabel} 既有会话流校验失败（fail-closed）`, parsed.error) };
          return finalize();
        }
        if (continueMode && parsed.value.length === 0) {
          outcome = { kind: "failed", error: runError("invalid_input", "continue 前置不满足：会话流为空（新 run 请走全新会话，勿用 continue）") };
          return finalize();
        }
        events.push(...parsed.value);
        for (const historical of parsed.value) options.onEvent?.(historical, "history");
      }
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

      // ---------------- 批 2.5 §二：turn 级 token 预算（层一/层二） ----------------
      // 估算同源：payload chars/2（与 compaction 同一除数）；自末次 turn/start 起的实质事件
      // 增量（durability 公理——从事件流确定性推导，无跨 turn 可变状态）。单位＝est tokens。
      const BUDGET_WARN_MARKER = "预算提示";
      const turnEstimateTokens = (): number => {
        let start = 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if ((events[i] as SessionEvent).type === "turn/start") {
            start = i;
            break;
          }
        }
        let total = 0;
        for (let i = start; i < events.length; i += 1) {
          const event = events[i] as SessionEvent;
          if (event.type === "session/compaction" || event.type === "session/repair" || event.type === "assistant/attempt") continue;
          total += Math.ceil(JSON.stringify(event.payload).length / 2);
        }
        return total;
      };
      const effectiveTurnTokenBudget = (): number => options.budgets?.turnTokenBudget ?? turnTokenBudget();
      const budgetWarnedThisTurn = (): boolean => {
        let start = 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if ((events[i] as SessionEvent).type === "turn/start") {
            start = i;
            break;
          }
        }
        for (let i = start; i < events.length; i += 1) {
          const event = events[i] as SessionEvent;
          if (event.type !== "tool/result") continue;
          const nudge = (event.payload as { nudge?: unknown } | null | undefined)?.nudge;
          if (typeof nudge === "string" && nudge.includes(BUDGET_WARN_MARKER)) return true;
        }
        return false;
      };

      /** 追加事件（无引用步骤不应触发铁律一——命中即 harness 故障）。 */
      const appendEvent = async (input: SessionEventInput): Promise<SessionEvent | null> => {
        // D-f-4 轮询豁免的状态变化事实源之一：审批 granted 落盘（可能翻转被询状态）。
        // 引用 let 变量在声明前——运行时调用序恒晚于声明（TDZ 不触）。
        if (input.type === "approval/response" && (input.payload as { verdict?: unknown } | null)?.verdict === "granted") {
          turnNoProgress.noteStateChange();
        }
        // 批 2.5 层二：渐进警告——本拍 tool/result 落盘前，若含本拍增量已达预算 80% 且本 turn
        // 未警告过 → nudge 注入收敛提示（复用 D-f 既有 nudge 字段，零新增 payload 字段——
        // 两跳核最强形式：跳 1 schema 零改、跳 2 白名单零扩）。
        if (input.type === "tool/result" && !budgetWarnedThisTurn()) {
          const candidateEstimate = turnEstimateTokens() + Math.ceil(JSON.stringify(input.payload).length / 2);
          const budget = effectiveTurnTokenBudget();
          if (candidateEstimate >= budget * TURN_BUDGET_WARN_RATIO) {
            const payload = input.payload as { nudge?: unknown };
            const existing = typeof payload["nudge"] === "string" ? (payload["nudge"] as string) : undefined;
            const warning = `${BUDGET_WARN_MARKER}：本 turn 估算用量已达 ${Math.min(100, Math.floor((candidateEstimate / budget) * 100))}%（预算 ${String(budget)} est tokens），请尽快收口（给出最终答复或向用户汇报）。`;
            payload["nudge"] = existing !== undefined ? `${warning}；${existing}` : warning;
          }
        }
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
        options.onEvent?.(appended.value.event, "live");
        return appended.value.event;
      };

      const appendTurnEnd = async (reason: string, stopReason?: LoopStopReason, failureSummary?: TurnFailureSummary): Promise<void> => {
        // 切片 1 A1（纯增量）：turn/end.payload 补 step 元数据（step_count = 本 turn 已执行步；
        // decision_count = 本 turn provider 决策数，含被拒的 provider_switch 请求）；
        // stop_reason 仅在 A2 五值判据命中时携带（可选字段，既有 reason 取值零改动）；
        // failure_summary 仅 D-1 阈值收口时携带（可选字段；payload 自由 JSON，类型白名单/schema_version 不动）。
        const payload: Record<string, unknown> = {
          reason,
          step_count: turnStepCount,
          decision_count: turnDecisionCount,
        };
        if (stopReason !== undefined) payload["stop_reason"] = stopReason;
        if (failureSummary !== undefined) payload["failure_summary"] = failureSummary;
        const appended = await session.append({ type: "turn/end", payload });
        if (appended.ok && appended.value.status === "appended") {
          events.push(appended.value.event);
          options.onEvent?.(appended.value.event, "live");
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
      // 切片 1 A1/A2：step 粒度计数与终局判据状态（每 turn 开启时清零）
      let turnStepCount = 0;
      let turnHadFinalAnswer = false;
      // 快修批 D-a R-2：单 turn 连续工具错误回流计数（rejected/input_violation；每 turn 清零，
      // 任何非回流类工具结果打断连续——达 REJECT_LOOP_LIMIT → turn 级失败收口）。
      // 三件小批 D-1：连续被拒调用留痕（供 turn_failed.summary.rejected；≤LIMIT 条）。
      let turnRejectCount = 0;
      let turnRejectCalls: Array<{ tool: string; reason: string; params_digest: string }> = [];
      // D-f-4：无进展检测器（每 turn 重建＝切断与计数的恢复语义，见 noProgress.ts）
      let turnNoProgress = new NoProgressDetector();
      // D-f-3/D-f-6：本 turn 最后一个 material-gap 回流（收口自动出缺口卡用）
      let turnLastMaterialGap: { tool: string; reason: string } | undefined;
      // D-f-2：本 turn 最近工具动作（阻塞说明 stuck_at 素材；不上屏步数）
      let turnLastTool: string | undefined;
      // pi-ai 换库批 R2：本 turn length 有界重试计数（恰 1 次上限；每 turn 重建＝恢复语义同源）
      let turnLengthRetries = 0;
      // 切片 1 A2：run 级 turn 计数（max_turns 预算）
      let turnsOpened = 0;

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
        turnStepCount = 0;
        turnHadFinalAnswer = false;
        turnRejectCount = 0;
        turnRejectCalls = [];
        turnNoProgress = new NoProgressDetector();
        turnLastMaterialGap = undefined;
        turnLastTool = undefined;
        turnLengthRetries = 0;
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

      /** D-f：turn 级收口摘要共享构造器（四类触发同源产出，防 D-1 双份字面量漂移）。
       *  reject 径输出与 D-1 逐字兼容（note 文案不变、gate_ids 逻辑不变、rejected/limit 恒填）。
       *  pi-ai 换库批：gapCardOverride 供 length 分型收口显式出卡（不经 material-gap 推导）。 */
      const buildCollapseSummary = (input: {
        reason: TurnFailureReason;
        limit?: number;
        rejected?: TurnFailureSummary["rejected"];
        cutTools?: readonly string[];
        stuckAt: string;
        providerError?: TurnBlockingDescription["provider_error"];
        gapCardOverride?: TurnFailureSummary["gap_card"];
      }): TurnFailureSummary => {
        const gap = turnLastMaterialGap;
        const gapCard = input.gapCardOverride ?? (gap !== undefined ? gapCardFor(gap.tool, gap.reason) : undefined);
        return {
          reason: input.reason,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.rejected !== undefined ? { rejected: input.rejected } : {}),
          blocked_description: {
            stuck_at: input.stuckAt,
            turns_used: turnsOpened,
            steps_used: turnStepCount,
            ...(input.providerError !== undefined && Object.keys(input.providerError).length > 0 ? { provider_error: input.providerError } : {}),
          },
          ...(gapCard !== undefined ? { gap_card: gapCard } : {}),
          ...(input.cutTools !== undefined && input.cutTools.length > 0 ? { cut_tools: [...input.cutTools] } : {}),
          hint: {
            ...(turnRejectCalls.some((call) => call.tool === "atf_gate") ? { gate_ids: [...GATE_LEGAL_IDS] } : {}),
            note: COLLAPSE_NOTES[input.reason],
          },
        };
      };

      /** D-f：turn 级收口执行器——outcome=turn_failed（run 未终局）＋显式落带 summary 的
       *  turn/end（补正#2：不依赖循环外兜底——兜底路径无 stop_reason/failure_summary）。 */
      const collapseTurn = async (summary: TurnFailureSummary, stopReason?: LoopStopReason): Promise<void> => {
        outcome = { kind: "turn_failed", summary };
        turnOpen = false;
        await appendTurnEnd("failed", stopReason, summary);
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

      if (provider !== null && !resumeMode && !continueMode) {
        turnsOpened += 1; // 切片 1 A2：初始 turn 计数（max_turns 预算的第一次消耗）
        await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
        await appendEvent({ type: "user/message", payload: { text: branch.trigger_instruction } });
        openTurnRecord(provider);
      }

      let lastAdmittedFact: DomainRef | undefined;
      let turnOpen = provider !== null && !resumeMode && !continueMode;

      // ---------------- L1a 门 2：resume 前置（任务书 §1.3；INV-1/INV-2 与 durability 公理） ----------------
      // 顺序（fail-closed 逐级）：① 末 turn 须以 suspended 收口；② turn 预算；
      // ③ 审批面须声明；④ 应答目标解析（无待办/歧义/已答拒绝）；⑤ 答复落 approval/response；
      // ⑥ abort → 终局 79（不开新 turn——无 open turn，INV-2 不涉及）；
      // ⑦ granted/advised/denied → 开新 turn（模型不可见预算计数续自事件流推导）；
      // ⑧ granted → 重派原 tool/call（复用原事件 id，凭据 findExistingCredential → available
      //    放行；一次性消费语义不变）。水位线已在应答落盘前取值（见上）。
      if (resumeMode && provider !== null) {
        const resumeAnswer = options.resume as ResumeAnswer;
        const loopState = deriveLoopStateFromEvents(events);
        const lastTurn = loopState.turns[loopState.turns.length - 1];
        const suspendedPrecondition = lastTurn !== undefined && lastTurn.closed_reason === "suspended";
        if (!suspendedPrecondition) {
          outcome = {
            kind: "failed",
            error: runError("invalid_input", "resume 前置不满足：末 turn 未以 suspended 收口（仅挂起 run 可恢复）", {
              turns_opened: loopState.turns_opened,
              last_closed_reason: lastTurn?.closed_reason ?? null,
            }),
          };
          provider = null;
        } else if (loopState.turns_opened + 1 > loopMaxTurns()) {
          const maxTurns = loopMaxTurns();
          outcome = {
            kind: "failed",
            error: runError("budget_exhausted", `turn 数预算耗尽（max_turns=${String(maxTurns)}），resume 无法开新 turn`, {
              budget: "max_turns",
              limit: maxTurns,
            }),
          };
          provider = null;
        } else if (approvalHandler === undefined) {
          outcome = {
            kind: "failed",
            error: runError("invalid_input", "resume 模式须声明审批面（approvalSurface）——应答经问答轨凭据路径放行"),
          };
          provider = null;
        }
        // 局部捕获（TS 收窄：provider 与审批面同时非空才进入应答路径）
        const resumeHandler = provider !== null ? approvalHandler : undefined;
        if (resumeHandler !== undefined && provider !== null) {
          const pending = listPendingApprovals(events);
          const target = resolveAnswerTarget(pending, resumeAnswer.request_event_id);
          if (!target.ok) {
            outcome = {
              kind: "failed",
              error: runError("invalid_input", `resume 应答目标非法: ${target.error.message}`, {
                pending: pending.map((item) => item.request_event_id),
              }),
            };
            provider = null;
          } else {
            const answered = await appendEvent({
              type: "approval/response",
              payload: buildAnswerPayload(target.value, resumeAnswer.verdict, resumeAnswer.note, resumeAnswer.actor, resumeAnswer.channel !== undefined ? { channel: resumeAnswer.channel, host_id: resumeAnswer.host_id } : undefined),
            });
            if (answered === null) {
              outcome = { kind: "failed", error: runError("session_failure", "resume 应答（approval/response）落盘失败") };
              provider = null;
            } else if (resumeAnswer.verdict === "abort") {
              // 人中止：run 终态 79；本进程不开新 turn（流尾无 open turn，INV-2 不涉及）
              outcome = {
                kind: "aborted",
                block: {
                  reason: "approval_aborted",
                  message: `人经 CLI 通道中止任务: ${resumeAnswer.note ?? "(无理由)"}`,
                  tool: target.value.tool,
                  exit_code: 79,
                },
              };
              provider = null;
            } else {
              // ⑦ 开新 turn（INV-1：应答后 resume 开新 turn）
              turnsOpened += 1;
              await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
              openTurnRecord(provider);
              turnOpen = true;
              if (resumeAnswer.verdict === "granted") {
                // ⑧ 重派原 tool/call（复用原事件 id——不新增 tool/call 事件，凭据配对链完整）
                const originalCall = events.find(
                  (event) => event.id === target.value.tool_call_id && event.type === "tool/call",
                );
                const callPayload = (originalCall?.payload ?? {}) as { tool?: unknown; params?: unknown };
                if (originalCall === undefined || typeof callPayload.tool !== "string" || typeof callPayload.params !== "object" || callPayload.params === null) {
                  outcome = { kind: "failed", error: runError("invalid_input", "resume 重派失败：原 tool/call 事件缺失或形状非法（凭据回溯链断裂，fail-closed）", { tool_call_id: target.value.tool_call_id }) };
                  provider = null;
                } else {
                  const gate: ApprovalGate = {
                    handler: (gateInput) => resumeHandler({ ...gateInput, tool_call_id: originalCall.id }),
                  };
                  const result: ToolCallOutcome = await executor.execute(callPayload.tool, callPayload.params, gate);
                  if (result.kind === "suspended" || result.kind === "aborted") {
                    outcome = result.kind === "suspended"
                      ? { kind: "suspended", block: result.block }
                      : { kind: "aborted", block: result.block };
                    turnOpen = false;
                    await appendTurnEnd(outcome.kind, outcome.kind === "aborted" ? "aborted" : undefined);
                    provider = null;
                  } else {
                    const payload: ToolResultPayload =
                      result.kind === "executed"
                        ? { tool: callPayload.tool, ok: true, result: result.result, call_ref: originalCall.id }
                        : result.kind === "rejected"
                          ? { tool: callPayload.tool, ok: false, reason: result.reason, call_ref: originalCall.id, detail: result.detail }
                          : result.kind === "input_violation"
                            ? { tool: callPayload.tool, ok: false, reason: result.reason, call_ref: originalCall.id, detail: result.detail }
                            : result.kind === "failed"
                              ? { tool: callPayload.tool, ok: false, reason: "failed", call_ref: originalCall.id, detail: result.error }
                              : { tool: callPayload.tool, ok: false, reason: result.block.reason, call_ref: originalCall.id, block: result.block };
                    const backfilled = await appendEvent({ type: "tool/result", payload });
                    if (backfilled === null) {
                      provider = null; // 会话写路径失败已在 appendEvent 内折算
                    } else if (result.kind === "executed") {
                      if (callPayload.tool === "atf_admit_data") {
                        const fact = result.result as { journal_type: string; fact_id: string; sha256_digest: string };
                        lastAdmittedFact = { journal_type: fact.journal_type, fact_id: fact.fact_id, sha256_digest: fact.sha256_digest };
                      }
                      // 执行完成 → 决策循环继续（模型看到 tool/result 后收束或继续）
                    } else if (result.kind === "blocked" && result.block.reason === "approval_missing") {
                      outcome = { kind: "approval_missing", block: result.block };
                      turnOpen = false;
                      await appendTurnEnd("approval_missing");
                      provider = null;
                    } else if (result.kind === "blocked" && (result.block.reason === "credential_indeterminate" || result.block.reason === "credential_persist_failed" || result.block.reason === "approval_track_failed")) {
                      outcome = {
                        kind: "failed",
                        error: runError("credential_indeterminate", result.block.message, result.block.detail),
                      };
                      turnOpen = false;
                      await appendTurnEnd("credential_indeterminate");
                      provider = null;
                    } else if (result.kind === "rejected" || result.kind === "input_violation" || result.kind === "failed") {
                      // 快修批 D-a：E1/E2（rejected/input_violation）对模型面 provider 非终局——
                      // tool/result 已回填（零加工），不置 outcome、不收口、不终止 provider，
                      // 落回决策循环继续（模型修参重试或转述）；连续计数达 REJECT_LOOP_LIMIT → 终局。
                      if (result.kind !== "failed" && !("decisionFace" in provider)) {
                        turnRejectCount += 1;
                        turnRejectCalls.push({ tool: String(callPayload.tool), reason: result.reason, params_digest: approvalParamsDigest(callPayload.params) });
                        if (isMaterialGapCode(result.reason)) turnLastMaterialGap = { tool: String(callPayload.tool), reason: result.reason };
                        if (turnRejectCount >= REJECT_LOOP_LIMIT) {
                          // 三件小批 D-1：阈值触发改 turn 级失败收口（run 未终局，控制权交还调用方）。
                          // provider 生命周期确认点（门 1 放行指令）：此处保留既有 provider = null——
                          // 本 turn 已收口，置空使决策循环首行守卫（provider === null → break）即出，
                          // runBranch 返回 turn_failed；connection 由 finally 统一关闭，无悬空实例。
                          // D-f：摘要改共享构造器（对模型面输出与 D-1 逐字兼容；新增阻塞说明/缺口卡）。
                          provider = null;
                          await collapseTurn(buildCollapseSummary({
                            reason: "reject_loop_exhausted",
                            limit: REJECT_LOOP_LIMIT,
                            rejected: [...turnRejectCalls].slice(-REJECT_LOOP_LIMIT),
                            stuckAt: `resume 重派连续 ${String(REJECT_LOOP_LIMIT)} 次被拒（最近：${String(callPayload.tool)}）`,
                          }));
                        }
                      } else {
                        // 脚本执行器（Faux 断言路径）与 E3/E4（failed）维持既有终局
                        outcome =
                          result.kind === "rejected"
                            ? { kind: "failed", error: runError("bridge_failure", `对端业务拒绝（重派 ${String(callPayload.tool)}）: ${result.reason}`, result.detail) }
                            : result.kind === "input_violation"
                              ? { kind: "failed", error: runError("bridge_failure", `工具入参违反模型可见 schema（重派 ${String(callPayload.tool)}）: ${result.reason}`, result.detail) }
                              : { kind: "failed", error: runError("bridge_failure", `工具执行故障（重派 ${String(callPayload.tool)}）: ${result.error.message}`, result.error) };
                        turnOpen = false;
                        await appendTurnEnd("failed");
                        provider = null;
                      }
                    }
                    // blocked(denied/advised/credential_consumed/credential_invalid) 非终局：循环继续（模型换路径）
                  }
                }
              }
            }
          }
        }
      }

      // ---------------- L1b B4：continue 前置（L1b-D2=A；多轮续跑同一机制） ----------------
      // 顺序（fail-closed 逐级）：① 流非空；② 末 turn 须已收口（open turn = 异常态拒绝）；
      // ③ 无待办审批（有待办须经 resume 应答——continue 不得绕过问答轨）；④ turn 预算；
      // ⑤ 新用户指令落 user/message → 开新 turn（预算计数续自事件流推导，模型不可见）。
      // 历史已由事实日志重放装载（origin=history 投影）；措辞纪律：恢复态只写
      // 「由事实日志重放重建」，不投影真思考（门 1 D6 边界延续）。
      // ---------------- 批 2.5 §一 A2.5：确认直填派发 helper（resume 重派同构区） ----------------
      // harness 确定性合成动作直接派发（模型不重生成参数——执行的就是批准的动作本身）：
      // tool/call（ui 留痕）→ 既有 approvalHandler gate（第二道人审不变）→ 结果回填 →
      // 决策循环继续（模型第一拍读到"已按确认参数执行"的事实）。终局语义与 resume 重派同款。
      const dispatchConfirmAction = async (action: PendingConfirmAction): Promise<void> => {
        const call = await appendEvent({
          type: "tool/call",
          payload: { tool: action.tool, params: action.params },
          ui: { confirm_card: { origin: action.origin, synthesized: true } },
        });
        if (call === null) return; // 会话写路径失败已在 appendEvent 内折算
        turnLastTool = action.tool;
        const gate: ApprovalGate | undefined = approvalHandler === undefined
          ? undefined
          : { handler: (gateInput) => approvalHandler({ ...gateInput, tool_call_id: call.id }) };
        const result: ToolCallOutcome = await executor.execute(action.tool, action.params, gate);
        if (result.kind === "suspended" || result.kind === "aborted") {
          outcome = result.kind === "suspended"
            ? { kind: "suspended", block: result.block }
            : { kind: "aborted", block: result.block };
          turnOpen = false;
          await appendTurnEnd(outcome.kind, outcome.kind === "aborted" ? "aborted" : undefined);
          provider = null;
          return;
        }
        const backfillGuidance = result.kind === "rejected" || result.kind === "input_violation" ? guidanceLineFor(result.reason) : undefined;
        if ((result.kind === "rejected" || result.kind === "input_violation") && isMaterialGapCode(result.reason)) {
          turnLastMaterialGap = { tool: action.tool, reason: result.reason };
        }
        const payload: ToolResultPayload =
          result.kind === "executed"
            ? { tool: action.tool, ok: true, result: result.result, call_ref: call.id }
            : result.kind === "rejected"
              ? { tool: action.tool, ok: false, reason: result.reason, call_ref: call.id, detail: result.detail, ...(backfillGuidance !== undefined ? { guidance: backfillGuidance } : {}) }
              : result.kind === "input_violation"
                ? { tool: action.tool, ok: false, reason: result.reason, call_ref: call.id, detail: result.detail, ...(backfillGuidance !== undefined ? { guidance: backfillGuidance } : {}) }
                : result.kind === "failed"
                  ? { tool: action.tool, ok: false, reason: "failed", call_ref: call.id, detail: result.error }
                  : { tool: action.tool, ok: false, reason: result.block.reason, call_ref: call.id, block: result.block };
        const backfilled = await appendEvent({ type: "tool/result", payload });
        if (backfilled === null) return;
        if (result.kind === "executed") return; // 决策循环继续：模型下一拍读到结果
        if (result.kind === "blocked") {
          if (result.block.reason === "approval_missing") {
            outcome = { kind: "approval_missing", block: result.block };
            turnOpen = false;
            await appendTurnEnd("approval_missing");
            provider = null;
            return;
          }
          if (result.block.reason === "credential_indeterminate" || result.block.reason === "credential_persist_failed" || result.block.reason === "approval_track_failed") {
            outcome = { kind: "failed", error: runError("credential_indeterminate", result.block.message, result.block.detail) };
            turnOpen = false;
            await appendTurnEnd("credential_indeterminate");
            provider = null;
            return;
          }
          return; // denied/credential_consumed/credential_invalid 非终局：模型换路径
        }
        if (result.kind === "rejected" || result.kind === "input_violation") {
          turnRejectCount += 1;
          turnRejectCalls.push({ tool: action.tool, reason: result.reason, params_digest: approvalParamsDigest(action.params) });
          if (turnRejectCount >= REJECT_LOOP_LIMIT) {
            provider = null;
            await collapseTurn(buildCollapseSummary({
              reason: "reject_loop_exhausted",
              limit: REJECT_LOOP_LIMIT,
              rejected: [...turnRejectCalls].slice(-REJECT_LOOP_LIMIT),
              stuckAt: `确认直填动作连续 ${String(REJECT_LOOP_LIMIT)} 次被拒（最近：${action.tool}）——合成值与内核校验面漂移，属 harness 缺陷须修复`,
            }));
          }
          return;
        }
        // failed（E3/E4）：终局（不猜测成功）
        outcome = { kind: "failed", error: runError("bridge_failure", `确认直填动作执行故障（${action.tool}）: ${result.error.message}`, result.error) };
        turnOpen = false;
        await appendTurnEnd("failed");
        provider = null;
      };

      if (continueMode && provider !== null) {
        const continueInstruction = (options.continue as { instruction: string }).instruction;
        const pendingAction = (options.continue as { pendingAction?: PendingConfirmAction }).pendingAction;
        const loopState = deriveLoopStateFromEvents(events);
        const lastTurn = loopState.turns[loopState.turns.length - 1];
        if (lastTurn === undefined) {
          outcome = { kind: "failed", error: runError("invalid_input", "continue 前置不满足：流内无 turn（新 run 请走全新会话）") };
          provider = null;
        } else if (lastTurn.closed_reason === undefined || lastTurn.closed_reason === null) {
          outcome = { kind: "failed", error: runError("invalid_input", "continue 前置不满足：末 turn 未收口（异常态，fail-closed）", {
            turns_opened: loopState.turns_opened,
          }) };
          provider = null;
        } else if (listPendingApprovals(events).length > 0) {
          outcome = { kind: "failed", error: runError("invalid_input", "continue 前置不满足：存在待办审批——挂起续跑须经 resume 应答通道（不得绕过问答轨）") };
          provider = null;
        } else if (loopState.turns_opened + 1 > loopMaxTurns()) {
          const maxTurns = loopMaxTurns();
          outcome = {
            kind: "failed",
            error: runError("budget_exhausted", `turn 数预算耗尽（max_turns=${String(maxTurns)}），continue 无法开新 turn`, {
              budget: "max_turns",
              limit: maxTurns,
            }),
          };
          provider = null;
        } else {
          turnsOpened = loopState.turns_opened;
          turnsOpened += 1;
          await appendEvent({ type: "turn/start", payload: { scenario_id: scenario.scenario_id, branch_id: branch.branch_id } });
          // 批 2.5 A2.5：确认直填轮——确认文本 user/message 附 ui 审计位（L1c 登记缺口随本批闭环；
          // convertToLlm 恒剥离 ui，模型不可见）。
          await appendEvent({
            type: "user/message",
            payload: { text: continueInstruction },
            ui: pendingAction !== undefined ? { confirm_card: { origin: pendingAction.origin, synthesized: true } } : undefined,
          });
          openTurnRecord(provider);
          turnOpen = true;
          if (pendingAction !== undefined) {
            await dispatchConfirmAction(pendingAction);
          }
        }
      }

      // ---------------- 决策循环（Faux 线性回放，owner 口径 #5；P2-S3 起支持多 provider 段；
      // 切片 1 起受轮次预算约束、以 stopReason 判据收敛） ----------------
      for (;;) {
        if (provider === null) break; // 初始注册失败已折算(防御路径,不进入决策)
        // 切片 1 A2 轮次预算＋走查修复小批 §二.1（A1/A2 根因）：单 turn 步数上限**仅脚本执行径**
        // ——达到即 failed(budget_exhausted)，不再调用 provider（确定性判据；不新增退出码，复用
        // exit 1）。批 2.5「模型面去步数化」曾因本前置判定对模型面同样生效而未实际生效（模型面
        // 32 步即落 fuse 径，报 200 文案——步数/缘由/文案三处错）；现模型面不受 32 步拦，仅受
        // 下方 hardFuse 兜底与 token 预算径约束。
        if ("decisionFace" in provider && turnStepCount >= loopMaxStepsPerTurn()) {
          // 脚本执行径（Faux 断言路径语义逐位不变）：维持既有终局 failed(budget_exhausted)
          const maxSteps = loopMaxStepsPerTurn();
          outcome = {
            kind: "failed",
            error: runError("budget_exhausted", `单 turn 步数预算耗尽（max_steps_per_turn=${String(maxSteps)}）`, {
              budget: "max_steps_per_turn",
              limit: maxSteps,
            }),
          };
          turnOpen = false;
          await appendTurnEnd("failed", "budget_exhausted");
          break;
        }
        // 批 2.5 §二 层四＋走查修复小批 §二.1：兜底保险丝——**仅模型面**（无 decisionFace），
        // 缺省 200 步（run options hardStepFuse 可配）：防 bug 死循环的最后防线，正常不触达；
        // 触达即 turn 级收口＋人读"疑似异常循环"（该文案仅限 fuse 径；模型面常规收口＝下方
        // token 预算径）。stop_reason 五值枚举保留（session.contract.yaml:298 零 diff）。
        // provider 生命周期同 D-1 确认点：置空使循环首行守卫即出，connection 由 finally 关闭。
        if (!("decisionFace" in provider)) {
          const hardFuse = options.budgets?.hardStepFuse ?? TURN_HARD_STEP_FUSE_DEFAULT;
          if (turnStepCount >= hardFuse) {
            provider = null;
            await collapseTurn(buildCollapseSummary({
              reason: "budget_exhausted",
              limit: hardFuse,
              stuckAt: turnLastTool !== undefined
                ? `安全熔断线（${String(hardFuse)} 步）触达——疑似异常循环，请核查；最近工具动作：${turnLastTool}`
                : `安全熔断线（${String(hardFuse)} 步）触达——疑似异常循环，请核查`,
            }), "budget_exhausted");
            break;
          }
        }
        // 批 2.5 §二 层一：turn 级 token 预算（est tokens 增量，估算与 compaction 同源 chars/2）——
        // "步数"形态的替代预算：真实资源水位＋下方 80% 渐进警告（appendEvent 注入）＋三档熔断
        // （D-f 既有）＋fuse（上方）。默认＝floor(触发水位/4)（constantsBudget holder，
        // run options budgets.turnTokenBudget 可覆盖）。与 compaction 存量水位两层分明：
        // 本层度量本 turn 增量，compaction 度量会话存量。
        if (!("decisionFace" in provider)) {
          const budget = effectiveTurnTokenBudget();
          if (turnEstimateTokens() >= budget) {
            provider = null;
            await collapseTurn(buildCollapseSummary({
              reason: "budget_exhausted",
              limit: budget,
              stuckAt: turnLastTool !== undefined
                ? `本轮 token 预算（${String(budget)} est tokens）已用完，最近工具动作：${turnLastTool}`
                : `本轮 token 预算（${String(budget)} est tokens）已用完`,
            }), "budget_exhausted");
            break;
          }
        }
        // 切片 2 §1.3 TEM 读闸注入点：transformContext 之后、provider.decide 之前
        // （不另起注入通道）；注入源不可用 → 记事件（assistant/attempt，不进模型历史）+ 无记忆运行。
        // L1c 提前批 A1.5.2（放行件 v7 ★段解冻 seam 991-993 透传）：projectContext 与
        // pipeline.transformContext 为同一实现（纯委托），此处显式注入进程级触发水位
        // （constantsBudget，未配置回退 24K 逐字节中立）；与 sessionLog 审计径同源（同源铁律）。
        const injection = await injectMemoryEntries(projectContext(events, compactionTriggerTokens()), options.memoryInjector);
        if (injection.failure !== undefined) {
          await appendEvent({
            type: "assistant/attempt",
            payload: { reason: "memory_read_failed", code: injection.failure.code, message: injection.failure.message },
          });
        }
        const decided = await provider.decide(injection.context);
        if (!decided.ok) {
          if ("decisionFace" in provider) {
            // 切片 1 A2/INV-2：脚本执行径 provider 自身故障 = error 判据——维持既有终局（逐位不变）
            outcome = { kind: "failed", error: runError("provider_failure", `provider 决策失败: ${decided.error.message}`, decided.error) };
            turnOpen = false;
            await appendTurnEnd("failed", "error");
            break;
          }
          // D-f-1：模型面 provider 故障（网络/超时/形状非法/call_budget 等）= turn 级受控收口
          // （run 非终局；用户核对配置后输入新指令即重试——TUI 每 prompt 重建 provider 实例）。
          // stop_reason="error" 五值枚举保留（机查）；阻塞说明携带原始错误码（原因可区分）。
          // 批 2.5 §二 层三：连续 provider 失败熔断升级——流尾连续 provider_failure 轮数
          // （含本拍）≥3 → 卡在哪行升级为核对配额/网络的人读强提示（任何非该类收口复位——
          // 由"流尾连续"推导天然实现，无跨 turn 可变状态）。
          let consecutiveFailures = 1;
          for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i] as SessionEvent;
            if (event.type !== "turn/end") continue;
            const reason = (event.payload as { failure_summary?: { reason?: unknown } } | null | undefined)?.failure_summary?.reason;
            if (reason === "provider_failure") consecutiveFailures += 1;
            else break;
          }
          // 微补丁（2026-09-23）：provider 错误可诊断性——status/body_excerpt（≤500）与 dump
          // 模式结构性 request_summary 落审计事件（assistant/attempt——落盘不进模型历史，
          // schema 零改）＋失败摘要 provider_error；卡在哪行带 body_excerpt 首行（≤120）。
          const providerError = providerErrorDetailOf(decided.error);
          await appendEvent({
            type: "assistant/attempt",
            payload: {
              reason: "provider_error",
              code: decided.error.code,
              ...(providerError.status !== undefined ? { status: providerError.status } : {}),
              ...(providerError.body_excerpt !== undefined ? { body_excerpt: providerError.body_excerpt } : {}),
              ...(providerError.request_summary !== undefined ? { request_summary: providerError.request_summary } : {}),
            },
          });
          const excerptFirstLine = firstLineOf(providerError.body_excerpt ?? "", 120);
          provider = null;
          await collapseTurn(buildCollapseSummary({
            reason: "provider_failure",
            stuckAt: `provider 决策失败（${decided.error.code}）: ${decided.error.message}` +
              (excerptFirstLine !== "" ? `｜响应首行：${excerptFirstLine}` : "") +
              (consecutiveFailures >= 3 ? `——provider 已连续 ${String(consecutiveFailures)} 轮失败，请核对 provider 配置/额度/网络后重试` : ""),
            ...(Object.keys(providerError).length > 0 ? { providerError } : {}),
          }), "error");
          break;
        }
        const raw = decided.value;
        if (raw === null) {
          // pi-ai 换库批 R1/R2（2026-09-23）：length 结构化分型恢复——优先于耗尽判读。
          // finish_reason=length 经 LengthAwareLlmProvider 信号上抛（不入 provider_failure）：
          // contentEmpty（思考吞预算）→ 有界自动重试恰 1 次（计入 call 预算，R2 单独计数＋
          // assistant/attempt 过程流留痕）；仍截断/非空截断 → turn 级收口＋缺口卡引导
          // （降思考等级／以既有历史续跑），不硬阻断 run。run 状态机零改：仅新增
          // "length→retry(≤1)→收口" 支线。
          if (!segmentMode && !("decisionFace" in provider) && isLengthAwareLlmProvider(provider)) {
            const signal = provider.consumeLengthSignal();
            if (signal !== null) {
              const verdict = resolveLengthRecovery(signal.contentEmpty, turnLengthRetries);
              if (verdict.action === "retry") {
                turnLengthRetries += 1;
                const noted = await appendEvent({
                  type: "assistant/attempt",
                  payload: {
                    reason: "length_retry",
                    attempt: turnLengthRetries,
                    content_empty: signal.contentEmpty,
                    provider_thinking_level: signal.providerThinkingLevel,
                  },
                });
                if (noted === null) break; // 会话写路径失败已在 appendEvent 内折算
                continue; // 再次 decide＝新一次 provider 调用（预算护栏语义不变）
              }
              provider = null;
              await collapseTurn(buildCollapseSummary({
                reason: "length_truncated",
                stuckAt: signal.contentEmpty
                  ? `模型响应被输出上限截断且无可见内容（思考耗尽预算，重试 ${String(turnLengthRetries)} 次仍截断）`
                  : "模型响应被输出上限截断，部分产出未执行",
                gapCardOverride: lengthTruncatedGapCard(signal.contentEmpty, turnLengthRetries),
              }), "error"); // 五值 stop_reason 枚举零改：机查粗分型取 error，精确分型在 failure_summary.reason
              break;
            }
          }
          // P2-S3:段分支脚本耗尽 = 段边界——非末段执行切换协议;末段/单 provider 分支 = 既有未收束终局
          if (segmentMode && segIdx < segments.length - 1) {
            // 切片 1 A2：run 级 turn 预算——开新 turn 前检查（max_turns；不越限才执行切换协议）
            if (turnsOpened + 1 > loopMaxTurns()) {
              const maxTurns = loopMaxTurns();
              outcome = {
                kind: "failed",
                error: runError("budget_exhausted", `turn 数预算耗尽（max_turns=${String(maxTurns)}）`, {
                  budget: "max_turns",
                  limit: maxTurns,
                }),
              };
              turnOpen = false;
              await appendTurnEnd("failed", "budget_exhausted");
              break;
            }
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
              turnsOpened += 1;
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
          // 切片 1 A2 终止判据：null 且本 turn 已产出 final_answer → completed(no_more_tools)；
          // 否则未收束：模型面 = turn 级受控收口（D-f-1；补正#2 显式落带 summary 的 appendTurnEnd，
          // 不依赖循环外兜底——兜底路径无 stop_reason/failure_summary）；脚本/段模式维持既有
          // provider_failure 终局（"以可执行内容为准"：声称完成但无 final_answer 且无待处理动作，
          // 不判成功）。补正#3 可达性结论：HttpLlmProvider.decide 恒不返回 ok(null)（空响应
          // = adapter err，adapter.ts「模型响应为空」），本分支对真实 peer 不可达、仅测试桩
          // 可达——模型面分支为接口契约防御（保留；不触脚本径）。
          const exhaustion = resolveExhaustionStop(turnHadFinalAnswer);
          if (exhaustion !== null) {
            outcome = { kind: "completed" };
            turnOpen = false;
            await appendTurnEnd("completed", exhaustion.stopReason);
            break;
          }
          if (!segmentMode && !("decisionFace" in provider)) {
            provider = null;
            await collapseTurn(buildCollapseSummary({
              reason: "provider_failure",
              stuckAt: "provider 决策序列返回空且未产出 final_answer（未收束）",
            }));
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
          // （切片 1 A1：provider_switch 请求计入 decision_count，不计 step_count——无内容执行）
          const block = checkSwitchBoundary(turnOpen, { to: step.to, ...(step.reason !== undefined ? { reason: step.reason } : {}) });
          if (block !== null) {
            switchRecords.push({ status: "rejected", to: step.to, block });
            continue;
          }
          // 决策循环内 turn 恒开——到达此处 = harness 不变式违反,折算故障(fail-closed)
          outcome = { kind: "failed", error: runError("session_failure", "不变式违反:决策循环内出现已收口 turn(切换请求无边界可依)") };
          break;
        }

        // 切片 1 A1：自此为本 turn 的可执行 step（step_count 口径 = 分派执行的内容步）
        turnStepCount += 1;

        if (step.type === "assistant_message" || step.type === "final_answer") {
          const appended = await appendEvent({ type: "assistant/message", payload: { text: step.text } });
          if (appended === null) break;
          if (step.type === "final_answer") {
            turnHadFinalAnswer = true; // 切片 1 A2：no_more_tools 判据状态（防御性——本路径随即收口）
            outcome = { kind: "completed" };
            turnOpen = false;
            await appendTurnEnd("completed", "final_answer");
            break;
          }
          continue;
        }

        if (step.type === "tool_call") {
          const call = await appendEvent({ type: "tool/call", payload: { tool: step.tool, params: step.params } });
          if (call === null) break;
          turnLastTool = step.tool;
          // D-f-4 档 2：已切断工具的本 turn 剩余调用短路（模型面）——先落 tool/call（可观测性
          // 不缺），不发桥接请求、不触发审批。补正#1 隔离机制＝独立控制面路径：本回填不进
          // E1/E2 计数（turnRejectCount/turnRejectCalls 原样）、不进无进展检测器（防自反馈）、
          // 仅消耗步数（LOOP_MAX_STEPS_PER_TURN 兜底不变）；配套用例「切断 3 次不触发 reject 阈值」。
          if (!("decisionFace" in provider) && turnNoProgress.isCut(step.tool)) {
            const payload: ToolResultPayload = {
              tool: step.tool,
              ok: false,
              reason: TOOL_CUT_REASON,
              call_ref: call.id,
              detail: { control_plane: true, until: "turn_end" },
              guidance: TOOL_CUT_NOTE,
            };
            const refused = await appendEvent({ type: "tool/result", payload });
            if (refused === null) break;
            continue;
          }
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
            // 切片 1 A2：aborted 命中五值判据（suspended 非判据值，不带 stop_reason）
            await appendTurnEnd(outcome.kind, outcome.kind === "aborted" ? "aborted" : undefined);
            break;
          }

          // D-f-4：无进展检测（模型面；脚本径豁免）——在回流 payload 构造前记录，nudge 文案
          // 随本拍回流进模型上下文（payload.nudge）；切断升级的收口检查在本拍回填之后。
          let nudgeNote: string | undefined;
          if (!("decisionFace" in provider) && (result.kind === "executed" || result.kind === "blocked" || result.kind === "rejected" || result.kind === "input_violation")) {
            const observation: NoProgressObservation =
              result.kind === "executed"
                ? { kind: "executed", result: result.result }
                : result.kind === "blocked"
                  ? { kind: "blocked", blockReason: result.block.reason }
                  : { kind: result.kind, reason: result.reason };
            const verdict = turnNoProgress.record(step.tool, step.params, observation);
            if (verdict.tier === "nudge") nudgeNote = NO_PROGRESS_NUDGE_NOTE;
          }
          // D-f-3：业务阻断码 guidance 一行回填（注册表命中才附；未登记码零加工透传）
          const backfillGuidance = result.kind === "rejected" || result.kind === "input_violation" ? guidanceLineFor(result.reason) : undefined;
          if ((result.kind === "rejected" || result.kind === "input_violation") && isMaterialGapCode(result.reason)) {
            turnLastMaterialGap = { tool: step.tool, reason: result.reason };
          }

          const payload: ToolResultPayload =
            result.kind === "executed"
              ? { tool: step.tool, ok: true, result: result.result, call_ref: call.id, ...(nudgeNote !== undefined ? { nudge: nudgeNote } : {}) }
              : result.kind === "rejected"
                ? { tool: step.tool, ok: false, reason: result.reason, call_ref: call.id, detail: result.detail, ...(nudgeNote !== undefined ? { nudge: nudgeNote } : {}), ...(backfillGuidance !== undefined ? { guidance: backfillGuidance } : {}) }
                : result.kind === "input_violation"
                  ? { tool: step.tool, ok: false, reason: result.reason, call_ref: call.id, detail: result.detail, ...(nudgeNote !== undefined ? { nudge: nudgeNote } : {}), ...(backfillGuidance !== undefined ? { guidance: backfillGuidance } : {}) }
                  : result.kind === "failed"
                    ? { tool: step.tool, ok: false, reason: "failed", call_ref: call.id, detail: result.error }
                    : { tool: step.tool, ok: false, reason: result.block.reason, call_ref: call.id, block: result.block, ...(nudgeNote !== undefined ? { nudge: nudgeNote } : {}) };
          const appended = await appendEvent({ type: "tool/result", payload, domain_refs: refs });
          if (appended === null) break;

          // D-f-4 档 3：切断升级收口检查（本拍结果已回填——可观测性优先；run 非终局）
          if (!("decisionFace" in provider) && turnNoProgress.collapseReady()) {
            provider = null;
            await collapseTurn(buildCollapseSummary({
              reason: turnNoProgress.collapseReason(),
              cutTools: turnNoProgress.cutTools(),
              stuckAt: `重复调用无进展（控制面）：${turnNoProgress.cutTools().join("、")} 已被本 turn 切断`,
            }));
            break;
          }

          if (result.kind === "executed") {
            turnRejectCount = 0; // D-a R-2：非回流类结果打断连续计数
            turnRejectCalls = [];
            if (step.tool === "atf_admit_data") {
              // canonical output 已保证三元组字段存在（S3 逐次校验）
              const fact = result.result as { journal_type: string; fact_id: string; sha256_digest: string };
              lastAdmittedFact = { journal_type: fact.journal_type, fact_id: fact.fact_id, sha256_digest: fact.sha256_digest };
            }
            continue;
          }
          if (result.kind === "blocked") {
            turnRejectCount = 0; // D-a R-2：非回流类结果打断连续计数
            turnRejectCalls = [];
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
          // 快修批 D-a（门 1 裁定 R-1/R-2/R-3/R-5）：错误回流分流——
          // E1（rejected，对端业务拒绝）与 E2（input_violation，入参校验点位产出）对模型面
          // provider 非终局：tool/result 已回填（零加工透传），模型下一拍可见并修参重试或
          // 如实转述；连续达 REJECT_LOOP_LIMIT → turn 终局（reject_loop_exhausted，防死循环）。
          // 脚本执行器（"decisionFace" in provider，与 :894 运行时守卫同判别式）维持终局
          // （Faux 断言路径 S3-4 语义零回归）；E3/E4（failed）恒终局不回流。
          if (result.kind === "rejected" || result.kind === "input_violation") {
            if (!("decisionFace" in provider)) {
              turnRejectCount += 1;
              turnRejectCalls.push({ tool: step.tool, reason: result.reason, params_digest: approvalParamsDigest(step.params) });
              if (isMaterialGapCode(result.reason)) turnLastMaterialGap = { tool: step.tool, reason: result.reason };
              if (turnRejectCount >= REJECT_LOOP_LIMIT) {
                // 三件小批 D-1：阈值触发改 turn 级失败收口——本 turn 收口（turn/end failed 含
                // failure_summary），run 未终局；控制权交还调用方（TUI 保持存活可继续输入，
                // headless 以 exit 1 如实退出）。E1/E2 回流与脚本径豁免语义不变。
                // D-f：摘要改共享构造器（输出对 D-1 逐字兼容；新增阻塞说明＋缺口卡自动出卡）。
                provider = null;
                await collapseTurn(buildCollapseSummary({
                  reason: "reject_loop_exhausted",
                  limit: REJECT_LOOP_LIMIT,
                  rejected: [...turnRejectCalls].slice(-REJECT_LOOP_LIMIT),
                  stuckAt: `连续 ${String(REJECT_LOOP_LIMIT)} 次工具调用被拒（最近：${turnRejectCalls[turnRejectCalls.length - 1]?.tool ?? step.tool}）`,
                }));
                break;
              }
              continue;
            }
            // 脚本执行器：维持既有终局（结构化回填已落盘，分支按故障终局，不猜测成功）
            outcome =
              result.kind === "rejected"
                ? { kind: "failed", error: runError("bridge_failure", `对端业务拒绝（${step.tool}）: ${result.reason}`, result.detail) }
                : { kind: "failed", error: runError("bridge_failure", `工具入参违反模型可见 schema（${step.tool}）: ${result.reason}`, result.detail) };
            turnOpen = false;
            await appendTurnEnd("failed");
            break;
          }
          // failed（E3 canonical 输出校验失败 / E4 bridge 故障）：结构化回填已落盘，终局（不猜测成功）
          outcome = { kind: "failed", error: runError("bridge_failure", `工具执行故障（${step.tool}）: ${result.error.message}`, result.error) };
          turnOpen = false;
          await appendTurnEnd("failed");
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
        // resume 模式：CLI 无场景期望文件，期望核验由调用方承担（violations 恒空，非豁免语义）
        expect_violations: resumeMode || continueMode
          ? []
          : evaluateExpectations(branch.expect, {
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
