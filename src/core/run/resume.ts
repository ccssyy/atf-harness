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
import { join } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";
import { asSessionEvent, validateEventEnvelope, type SessionEvent } from "../session/index.js";
import { type ApprovalVerdict } from "./approvalTrack.js";

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
  channel?: "acp";
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
  const acpChannel = meta?.channel === "acp";
  return {
    approval_session_id: target.approval_session_id,
    request_event_ref: target.request_event_id,
    verdict: channelToApprovalVerdict(verdict),
    actor,
    ...(hasNote ? (verdict === "advised" ? { advice_text: trimmed } : { reason: trimmed }) : {}),
    ...(acpChannel ? { channel: "acp" as const } : {}),
    ...(acpChannel && meta?.host_id !== undefined ? { host_id: meta.host_id } : {}),
    ...(acpChannel ? { requires_human_review: true } : {}),
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
  mode: "list" | "answer";
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

  if (mode === null) return err("须指定 --list 或 --answer <verdict>");
  if (runsRoot === undefined) return err("--runs-root 必填");
  if (runId === undefined) return err("--run-id 必填");
  if (mode === "answer") {
    if (verdict === undefined) return err("--answer 缺少应答值");
    if (scenarioId === undefined) return err("answer 模式须 --scenario-id（账本 scope_ref 定位键）");
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
