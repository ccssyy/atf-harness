/**
 * L1a 门 2——最小人工应答通道（《ATF独立Harness_L1a门2任务书_20260914.md》§1.3；ADR-07 fails-closed）。
 *
 * 通道接口（v1 定死）：
 *   - list pending：listPendingApprovals(events)——待人工应答的审批请求（纯函数，事件流推导）；
 *   - submit answer：四类应答 granted / advised / denied / abort（abort ↔ 问答轨 verdict "aborted"）。
 * CLI 前端 = 本接口的第一个消费者（src/cli/resume.ts）；socket / 界面后续作为新前端接入，
 * 不改会话语义。**红线**：通道只能由人触发——本模块不含任何自动应答路径，应答唯一的
 * 写入点 = 调用方显式提交（CLI 子命令）；harness 侧的 approval/response 只有 timeout
 * （actor="harness"，超时审计留痕，非应答）与 runner 内问答轨编排两条既有路径。
 *
 * pending 判定（事件流纯函数，durability 公理同范式）：
 *   approval/request 为待办 ⇔ 流内不存在以它为 request_event_ref 的非 timeout 应答；
 *   同一 approval_session 内仅最新一条候选为待办（更早的候选 = 已被 supersedes 链替代）。
 *   仅 timeout 应答的请求仍待人工（「超时非否决」——owner 语义）。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";
import { asSessionEvent, validateEventEnvelope, sessionError, type DigestResolver, type SessionError, type SessionEvent } from "../session/index.js";
import { GuardedSessionLog } from "../workspace/index.js";
import { type ApprovalVerdict } from "./approvalTrack.js";
import { deriveLoopStateFromEvents } from "./loopState.js";

/** 通道四类应答（任务书 §1.3 闭集）。 */
export type ChannelVerdict = "granted" | "advised" | "denied" | "abort";

export const CHANNEL_VERDICTS: readonly ChannelVerdict[] = ["granted", "advised", "denied", "abort"];

/** CLI 应答 actor（账面标识；通道只由人触发，身份登记沿用 stub-host 同粒度）。 */
export const CHANNEL_ACTOR = "cli-operator";

/** 通道应答 → 问答轨 verdict（abort ↔ aborted；其余同名）。 */
export const channelToApprovalVerdict = (verdict: ChannelVerdict): ApprovalVerdict =>
  verdict === "abort" ? "aborted" : verdict;

export interface ResumeChannelError {
  code: "invalid_input" | "no_pending" | "ambiguous" | "not_pending";
  message: string;
}

/** 待办条目（list pending 面）。 */
export interface PendingApproval {
  /** approval/request 事件 id（应答目标） */
  request_event_id: number;
  approval_session_id: string;
  tool: string;
  params: unknown;
  approval_key: string;
  attempt: number;
  /** 被审批的 tool/call 事件 id */
  tool_call_id: number;
  /** 既有应答状态：无应答 = unanswered；仅 timeout = 等待人工（超时非否决） */
  status: "unanswered" | "timeout_awaiting_human";
  last_timeout_response_event_id?: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numField = (payload: unknown, key: string): number | null => {
  if (!isPlainObject(payload)) return null;
  const value = payload[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const strField = (payload: unknown, key: string): string | null => {
  if (!isPlainObject(payload)) return null;
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/** list pending（纯函数）：事件流 → 待人工应答的审批请求（按 request 事件 id 升序）。 */
export const listPendingApprovals = (events: readonly SessionEvent[]): PendingApproval[] => {
  /** request_event_ref → 应答清单（verdict, actor, event_id） */
  const responsesByRequest = new Map<number, Array<{ verdict: string; actor: string; event_id: number }>>();
  for (const event of events) {
    if (event.type !== "approval/response") continue;
    const ref = numField(event.payload, "request_event_ref");
    const verdict = strField(event.payload, "verdict");
    if (ref === null || verdict === null) continue;
    const list = responsesByRequest.get(ref) ?? [];
    list.push({ verdict, actor: strField(event.payload, "actor") ?? "", event_id: event.id });
    responsesByRequest.set(ref, list);
  }

  /** 候选（无非 timeout 应答的请求），按会话分组取最新 */
  const candidates = new Map<string, PendingApproval>();
  for (const event of events) {
    if (event.type !== "approval/request") continue;
    const requestId = event.id;
    const sessionId = strField(event.payload, "approval_session_id");
    const tool = strField(event.payload, "tool");
    const approvalKey = strField(event.payload, "approval_key");
    const attempt = numField(event.payload, "attempt");
    const toolCallId = numField(event.payload, "tool_call_id");
    if (sessionId === null || tool === null || approvalKey === null || attempt === null || toolCallId === null) continue;
    const responses = responsesByRequest.get(requestId) ?? [];
    const blocking = responses.find((response) => response.verdict !== "timeout");
    if (blocking !== undefined) continue; // 已获非 timeout 应答（终态应答/澄清转手）——不待人工
    const timeoutResponses = responses.filter((response) => response.verdict === "timeout");
    candidates.set(sessionId, {
      request_event_id: requestId,
      approval_session_id: sessionId,
      tool,
      params: isPlainObject(event.payload) ? event.payload["params"] : undefined,
      approval_key: approvalKey,
      attempt,
      tool_call_id: toolCallId,
      status: timeoutResponses.length > 0 ? "timeout_awaiting_human" : "unanswered",
      ...(timeoutResponses.length > 0
        ? { last_timeout_response_event_id: timeoutResponses[timeoutResponses.length - 1]?.event_id }
        : {}),
    });
  }
  return [...candidates.values()].sort((a, b) => a.request_event_id - b.request_event_id);
};

/** 应答目标解析（fail-closed）：显式 id 须命中待办；缺省须恰一个待办。 */
export const resolveAnswerTarget = (
  pending: readonly PendingApproval[],
  requestEventId: number | undefined,
): Result<PendingApproval, ResumeChannelError> => {
  if (pending.length === 0) {
    return err({ code: "no_pending", message: "无待人工应答的审批请求" });
  }
  if (requestEventId === undefined) {
    if (pending.length > 1) {
      return err({
        code: "ambiguous",
        message: `存在 ${String(pending.length)} 条待办，须以 request 事件 id 显式指定: ${pending.map((item) => String(item.request_event_id)).join(", ")}`,
      });
    }
    return ok(pending[0] as PendingApproval);
  }
  const hit = pending.find((item) => item.request_event_id === requestEventId);
  if (hit === undefined) {
    return err({ code: "not_pending", message: `request 事件 ${String(requestEventId)} 不在待办中（已应答 / 已被替代 / 不存在）` });
  }
  return ok(hit);
};

/** 应答事件 payload（复用 approval/response 既有字段闭集；不新增 schema 形态）。 */
/** 应答通道留痕(D4,L1 门 2 T04):宿主通道经此把 channel/host_id 带入 approval/response。 */
export interface AnswerChannelMeta {
  channel?: "acp" | "mcp";
  host_id?: string;
}

export const buildAnswerPayload = (
  target: PendingApproval,
  verdict: ChannelVerdict,
  note?: string,
  actor: string = CHANNEL_ACTOR,
  meta?: AnswerChannelMeta,
): Record<string, unknown> => {
  const trimmed = note?.trim();
  const hasNote = trimmed !== undefined && trimmed !== "";
  const channeled = meta?.channel !== undefined;
  return {
    approval_session_id: target.approval_session_id,
    request_event_ref: target.request_event_id,
    verdict: channelToApprovalVerdict(verdict),
    actor,
    ...(hasNote ? (verdict === "advised" ? { advice_text: trimmed } : { reason: trimmed }) : {}),
    ...(channeled && meta?.channel !== undefined ? { channel: meta.channel } : {}),
    ...(channeled && meta?.host_id !== undefined ? { host_id: meta.host_id } : {}),
    ...(channeled ? { requires_human_review: true } : {}),
  };
};

// ---------------------------------------------------------------------------
// 会话流读取（resume 前置：状态与待办只从磁盘事件流推导——durability 公理）
// ---------------------------------------------------------------------------

/** 严格解析会话流文本（逐行 JSON + envelope 校验；坏行/断号即 err——fail-closed）。 */
export const parseSessionStream = (text: string): Result<SessionEvent[], ResumeChannelError> => {
  const events: SessionEvent[] = [];
  let expectedId = 1;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return err({ code: "invalid_input", message: `会话流含非 JSON 行（fail-closed）: ${line.slice(0, 60)}…` });
    }
    const violation = validateEventEnvelope(parsed);
    if (violation !== null) {
      return err({ code: "invalid_input", message: `会话流事件校验失败: ${violation}` });
    }
    const event = asSessionEvent(parsed as Record<string, unknown>);
    if (event.id !== expectedId) {
      return err({ code: "invalid_input", message: `会话流 id 不连续: 期望 ${String(expectedId)}，实得 ${String(event.id)}` });
    }
    expectedId += 1;
    events.push(event);
  }
  return ok(events);
};

/** 从磁盘读会话流（resume 前置读取）。 */
export const readSessionStream = async (sessionLogPath: string): Promise<Result<SessionEvent[], ResumeChannelError>> => {
  let text: string;
  try {
    text = await readFile(sessionLogPath, "utf8");
  } catch (cause) {
    return err({ code: "invalid_input", message: `会话流读取失败: ${(cause as Error).message}` });
  }
  return parseSessionStream(text);
};

// ---------------------------------------------------------------------------
// CLI 参数面（src/cli/resume.ts 的解析单点；纯函数可测）
// ---------------------------------------------------------------------------

export interface ResumeCliArgs {
  mode: "list" | "answer" | "recover-orphan";
  /** answer 模式必填 */
  verdict?: ChannelVerdict;
  note?: string;
  /** 目标 request 事件 id（缺省 = 恰一个待办时自动指定） */
  requestEventId?: number;
  runsRoot: string;
  runId: string;
  /** answer 模式必填（scope_ref.project_id） */
  scenarioId?: string;
  /** mock 对端脚本路径（缺省 = 仓内 tests/fixtures/mock_atf.mjs） */
  mockPath?: string;
  /** 账本 scope_ref.scope_mode（缺省 "headless"；真实内核 run 传 canonical——内核 ScopeMode 枚举） */
  scopeMode?: "canonical" | "simulation" | "headless";
}

/** 解析 CLI argv（未知旗标/缺参 → err，fail-closed）。 */
export const parseResumeArgs = (argv: readonly string[]): Result<ResumeCliArgs, string> => {
  let mode: ResumeCliArgs["mode"] | null = null;
  let recoverFlag = false;
  let verdict: ChannelVerdict | undefined;
  let note: string | undefined;
  let requestEventId: number | undefined;
  let runsRoot: string | undefined;
  let runId: string | undefined;
  let scenarioId: string | undefined;
  let mockPath: string | undefined;
  let scopeMode: NonNullable<ResumeCliArgs["scopeMode"]> | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--list":
        mode = "list";
        break;
      case "--recover-orphan-turn":
        // B2（走查修复批 2026-09-23，指令 7158bf43）：孤儿 turn 受控修复通道——显式旗标，
        // 缺省永不触碰落盘流（fail-closed 语义不放松，见 recoverOrphanTurn）。
        mode = "recover-orphan";
        recoverFlag = true;
        break;
      case "--answer": {
        mode = "answer";
        const next = argv[i + 1];
        if (next === undefined) return err("--answer 缺少应答值");
        if (!(CHANNEL_VERDICTS as readonly string[]).includes(next)) {
          return err(`--answer 非法（允许值: ${CHANNEL_VERDICTS.join(" | ")}）: ${next}`);
        }
        verdict = next as ChannelVerdict;
        i += 1;
        break;
      }
      case "--note": {
        const next = argv[i + 1];
        if (next === undefined) return err("--note 缺少值");
        note = next;
        i += 1;
        break;
      }
      case "--request": {
        const next = argv[i + 1];
        const parsed = next === undefined ? Number.NaN : Number(next);
        if (!Number.isInteger(parsed) || parsed < 1) return err(`--request 非法（须为正整数事件 id）: ${String(next)}`);
        requestEventId = parsed;
        i += 1;
        break;
      }
      case "--runs-root": {
        const next = argv[i + 1];
        if (next === undefined || next === "") return err("--runs-root 缺少值");
        runsRoot = next;
        i += 1;
        break;
      }
      case "--run-id": {
        const next = argv[i + 1];
        if (next === undefined || next === "") return err("--run-id 缺少值");
        runId = next;
        i += 1;
        break;
      }
      case "--scenario-id": {
        const next = argv[i + 1];
        if (next === undefined || next === "") return err("--scenario-id 缺少值");
        scenarioId = next;
        i += 1;
        break;
      }
      case "--scope-mode": {
        const next = argv[i + 1];
        if (next !== "canonical" && next !== "simulation" && next !== "headless") {
          return err(`--scope-mode 非法（允许值: canonical | simulation | headless）: ${String(next)}`);
        }
        scopeMode = next as NonNullable<ResumeCliArgs["scopeMode"]>;
        i += 1;
        break;
      }
      case "--mock": {
        const next = argv[i + 1];
        if (next === undefined || next === "") return err("--mock 缺少值");
        mockPath = next;
        i += 1;
        break;
      }
      default:
        return err(`未知参数: ${arg}（fail-closed）`);
    }
  }

  if (mode === null) return err("须指定 --list、--answer <verdict> 或 --recover-orphan-turn");
  if (runsRoot === undefined) return err("--runs-root 必填");
  if (runId === undefined) return err("--run-id 必填");
  if (mode === "answer") {
    if (verdict === undefined) return err("--answer 缺少应答值");
    if (scenarioId === undefined) return err("answer 模式须 --scenario-id（账本 scope_ref 定位键）");
  }
  if (recoverFlag && verdict !== undefined) {
    // 应答与孤儿修复互斥：可修复的孤儿流定义上零待办审批（有待办即拒修），应答无从谈起。
    // 以独立旗标位判定（mode 为 last-wins，双旗标同给时 mode 已被覆盖——不能依赖 mode）。
    return err("--recover-orphan-turn 与 --answer 互斥（孤儿修复不涉及应答；见 --list 确认待办）");
  }
  if (recoverFlag && mode !== "recover-orphan") {
    return err("--recover-orphan-turn 与 --list 互斥");
  }
  return ok({
    mode,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(requestEventId !== undefined ? { requestEventId } : {}),
    runsRoot,
    runId,
    ...(scenarioId !== undefined ? { scenarioId } : {}),
    ...(mockPath !== undefined ? { mockPath } : {}),
    ...(scopeMode !== undefined ? { scopeMode } : {}),
  });
};

/** 会话流默认约定路径（与 RunWorkspace.sessionLogPath 同口径；CLI 侧独立拼装用）。 */
export const sessionLogPathFor = (runsRoot: string, runId: string): string => join(runsRoot, runId, "session.jsonl");

// ---------------------------------------------------------------------------
// B2：孤儿 turn 受控修复通道（走查修复批 2026-09-23，指令 7158bf43）
// 现状（走查报告 8628d036 §三 B2）：进程异常退出后末 turn 无 turn/end，resume/continue
// 一律拒收（fail-closed），只能运维手工改 journal。修法：fail-closed 不放松，补显式受控
// 修复通道——仅当「末 turn 无 turn/end 且流内零审批待办」时合成收口 turn/end
// （reason=orphan_recovered，step_count 按流内实计，projection 字段位由 SessionLog.append
// 按既有落盘形态生成，payload.note 留痕）；有待办仍拒绝并给指引。TUI 只提示不自动修。
// ---------------------------------------------------------------------------

/** 合成收口事件的 reason 取值（turn/end.payload.reason 增量取值；payload 自由 JSON 零 schema 变更）。 */
export const ORPHAN_RECOVERED_REASON = "orphan_recovered";

/** 孤儿 turn 诊断（纯函数消费 deriveLoopStateFromEvents，durability 公理同范式）。 */
export interface OrphanTurnDiagnosis {
  /** 末 turn 序号（流内第 N 个 turn/start） */
  turn_index: number;
  /** 按流内实计的内容步数（assistant/message + tool/call——与 loopState 推导同口径） */
  step_count: number;
  /** 按流内实计的决策数（含 provider/switch） */
  decision_count: number;
  /** 合成收口前流内末事件 id（留痕用） */
  last_event_id: number;
}

export interface OrphanRecoveryError {
  code: "invalid_input" | "no_orphan" | "pending_approvals" | "session_failure";
  message: string;
}

/**
 * 孤儿 turn 诊断（纯函数）：末 turn 存在且未收口 → 返回实计诊断；否则 null（无 turn /
 * 末 turn 已收口——无孤儿）。**不读磁盘、不写磁盘**，CLI 与 TUI 共用同一判定单源。
 */
export const diagnoseOrphanTurn = (events: readonly SessionEvent[]): OrphanTurnDiagnosis | null => {
  const state = deriveLoopStateFromEvents(events);
  const last = state.turns[state.turns.length - 1];
  if (last === undefined) return null; // 流内无 turn
  if (last.closed_reason !== null) return null; // 末 turn 已收口（非孤儿）
  const lastEvent = events[events.length - 1];
  return {
    turn_index: last.turn_index,
    step_count: last.step_count_event_derived,
    decision_count: last.decision_count,
    last_event_id: lastEvent?.id ?? 0,
  };
};

/**
 * 恢复写径的 digest resolver 防御桩：合成 turn/end 恒无 domain_refs（事件语义即无引用），
 * S2/GuardedSessionLog 校验器对无引用事件恒不查询 resolver——此桩永不被触达；若未来触达
 * 即 err（fail-closed 不猜测），与「恢复通道只合成无引用收口事件」的边界互为锁底。
 */
const orphanRecoveryResolver: DigestResolver = {
  lookupDigest: async () =>
    err(sessionError("resolver_failure", "孤儿恢复通道不应产生带引用事件（防御桩被触达，fail-closed）")),
};

/**
 * 孤儿 turn 受控修复：诊断 → 条件核验（零待办）→ 经 GuardedSessionLog（与 runner 同一
 * 写路径：schema 校验 + id/ts/projection 生成 + durability 落盘）合成收口 turn/end。
 * 任一条件不满足 → 结构化拒绝（流零改动，fail-closed 不放松）。
 */
export const recoverOrphanTurn = async (
  sessionLogPath: string,
  options: { now?: () => string } = {},
): Promise<Result<{ event: SessionEvent; diagnosis: OrphanTurnDiagnosis }, OrphanRecoveryError>> => {
  const stream = await readSessionStream(sessionLogPath);
  if (!stream.ok) {
    return err({ code: "invalid_input", message: `会话流读取失败（流未改动）: ${stream.error.message}` });
  }
  const events = stream.value;
  const diagnosis = diagnoseOrphanTurn(events);
  if (diagnosis === null) {
    const state = deriveLoopStateFromEvents(events);
    return err({
      code: "no_orphan",
      message:
        state.turns.length === 0
          ? "流内无 turn（空流无孤儿可修）"
          : "末 turn 已收口（无孤儿；续跑直接走 TUI continue / resume 应答通道）",
    });
  }
  // 待办核验：孤儿流内存在待办审批 = 挂起语义被孤儿截断——先经应答通道，不得绕过问答轨（ADR-07）
  const pending = listPendingApprovals(events);
  if (pending.length > 0) {
    return err({
      code: "pending_approvals",
      message:
        `末 turn 为孤儿且存在 ${String(pending.length)} 条待办审批（request 事件 id: ${pending.map((item) => String(item.request_event_id)).join(", ")}）——孤儿收口拒绝（fail-closed）：` +
        "先经 resume 应答通道处理待办（node dist/cli/resume.js --list / --answer …），待办清零后再修复",
    });
  }
  // scratchRoot 与 RunWorkspace 十目录布局同口径（runs/<run_id>/scratch）；铁律一扫描对
  // 无引用事件为透传，此处取约定路径仅为复用 runner 同一写路径入口（单一落盘口径）。
  const scratchRoot = join(dirname(sessionLogPath), "scratch");
  const guarded = await GuardedSessionLog.create(sessionLogPath, orphanRecoveryResolver, scratchRoot, options.now !== undefined ? { now: options.now } : {});
  if (!guarded.ok) {
    return err({ code: "session_failure", message: `会话日志打开失败（流未改动）: ${guarded.error.message}` });
  }
  const session = guarded.value;
  const payload: Record<string, unknown> = {
    reason: ORPHAN_RECOVERED_REASON,
    step_count: diagnosis.step_count,
    decision_count: diagnosis.decision_count,
    // note 留痕：合成事实与来源通道可追溯（turn/end payload 自由 JSON，纯增量字段）
    note:
      `孤儿 turn 受控修复：进程异常退出致末 turn 未收口，经 CLI --recover-orphan-turn 合成收口` +
      `（流内实计 step_count=${String(diagnosis.step_count)}/decision_count=${String(diagnosis.decision_count)}，合成前末事件 id=${String(diagnosis.last_event_id)}）`,
  };
  const appended = await session.append({ type: "turn/end", payload });
  await session.close().catch(() => undefined);
  if (!appended.ok) {
    return err({ code: "session_failure", message: `合成收口落盘失败: ${appended.error.message}` });
  }
  if (appended.value.status === "rejected") {
    // 铁律一守卫对无引用事件不触达——命中即守卫语义意外变化，fail-closed 上报
    return err({ code: "session_failure", message: "合成收口被会话守卫拒绝（意外命中，fail-closed）" });
  }
  return ok({ event: appended.value.event, diagnosis });
};
