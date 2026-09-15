/**
 * 问答轨审批编排器(P2-S2,设计 v1.1 生效版 / 决议 §3.2 口径 #2–#8 / 门 2 A1–A3)。
 *
 * 职责:账本未命中且已声明审批面时,以 handler 形态被 ToolExecutor 调用——
 * 发起/延续审批会话(approval/request → 桩对端应答 → approval/response)→ 六类分支处置:
 *   granted   → 凭据预检(available)+ 持久化前置(R2)→ 放行执行
 *   advised   → 意见原文回填(block reason = approval_advised,S2a 决议 §3.2:与 denied 区分;
 *               非终局;模型重新提案,新 request 带 supersedes)
 *   denied    → 结构化 block 回填(approval_denied;非终局;模型可换路径,同提案重提计数 +1)
 *   aborted   → run 终态(79)
 *   clarification → 同会话补上下文重发 request(多轮往返)
 *   timeout   → verdict=timeout + actor="harness" 落盘 → run 挂起(75,「超时非否决」)
 *
 * 纪律(四约束):消费判定纯函数(resolveCredentialState,恢复水位线入参);
 * 不新增第 13 类事件;全程不触 ledger_record 等 setup 基建;fail-closed——
 * 唯一放行路径 available 叠加持久化前置,不确定(indeterminate)即 run 终态,不猜已执行。
 */
import { approvalTrackBlock, type ApprovalGate, type ApprovalTrackVerdict, type ToolBlock } from "../tools/index.js";
import { findExistingCredential, resolveCredentialState } from "../tools/index.js";
import { type SessionEvent, type SessionEventInput } from "../session/index.js";

const numField = (payload: unknown, key: string): number | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const strField = (payload: unknown, key: string): string | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/** 拒绝循环阈值(决议口径 #4:常量 2;同提案 = tool 名 + params_digest(approval_key)一致;
 *  同提案被拒 2 次后再次重提(第 3 次提案)即升级,不静默重试)。 */
export const DENIAL_LOOP_LIMIT = 2;

/** 六类应答 verdict(ADR-09 C6;timeout 的 actor 恒为 "harness" 系统标记)。 */
export type ApprovalVerdict = "granted" | "advised" | "denied" | "aborted" | "clarification" | "timeout";

/** 桩对端应答(测试基建;实现由测试注入,不得成为运行时依赖路径)。 */
export interface ApprovalStubResponse {
  verdict: ApprovalVerdict;
  actor?: string;
  reason?: string;
  advice_text?: string;
  question?: string;
}

export type ApprovalStub = (input: {
  approval_session_id: string;
  tool: string;
  params: unknown;
  approval_key: string;
  attempt: number;
  /** clarification 轮次(同一 request 链内从 1 起);首轮 = 0 */
  round: number;
}) => Promise<ApprovalStubResponse>;

/** run 层注入的会话写依赖(由 runner 闭包提供:走 GuardedSessionLog 同一写路径与终局折算)。 */
export interface ApprovalTrackDeps {
  appendEvent: (input: SessionEventInput) => Promise<SessionEvent | null>;
  /** 本次进程的内存事件序列(判定与事件落盘同源) */
  events: readonly SessionEvent[];
  /** 持久化前置(R2):per-append 档为空操作确认,批量档真实刷盘;失败 → 不放行 */
  flush: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** 恢复水位线(A2):打开会话后立即取值并固定(流内最大事件 id,全新 run = 0) */
  recoveryWatermark: number;
  stub: ApprovalStub;
}

export interface ApprovalTrackInput {
  tool: string;
  params: unknown;
  approval_key: string;
  /** 被审批的 tool/call 事件 id(runner 落盘后回填) */
  tool_call_id: number;
}

/** 同提案状态(denied 循环防护 / supersedes 链 / 会话延续;键 = approval_key)。 */
interface ProposalState {
  approval_session_id: string;
  attempt: number;
  denied_count: number;
  last_request_id?: number;
}

export type ApprovalHandler = (input: ApprovalTrackInput) => Promise<ApprovalTrackVerdict>;

/**
 * L1a 门 2：跨进程提案状态种子（resume 后同一提案的延续语义）。
 * P2-S2 的提案状态（attempt / denied_count / last_request_id / 同会话延续）是进程内闭包；
 * L1a 起 run 跨进程（挂起 → CLI 应答 → resume 新进程），种子从**事件流**推导（durability
 * 公理同范式——恢复只读本侧流）：同 approval_key 取最大 attempt、最新 request id、
 * 累计 denied 应答数、延续最新 approval_session_id。进程内行为零改动（空流种子 = 空表）。
 */
const seedProposalsFromEvents = (events: readonly SessionEvent[]): Map<string, ProposalState> => {
  const deniedByRequest = new Map<number, number>();
  for (const event of events) {
    if (event.type !== "approval/response") continue;
    const ref = numField(event.payload, "request_event_ref");
    const verdict = strField(event.payload, "verdict");
    if (ref === null || verdict === null || verdict !== "denied") continue;
    deniedByRequest.set(ref, (deniedByRequest.get(ref) ?? 0) + 1);
  }
  const map = new Map<string, ProposalState>();
  for (const event of events) {
    if (event.type !== "approval/request") continue;
    const key = strField(event.payload, "approval_key");
    const session = strField(event.payload, "approval_session_id");
    const attempt = numField(event.payload, "attempt");
    if (key === null || session === null || attempt === null) continue;
    const existing = map.get(key);
    const state: ProposalState = existing ?? { approval_session_id: session, attempt: 0, denied_count: 0 };
    state.approval_session_id = session;
    if (attempt > state.attempt) state.attempt = attempt;
    state.denied_count += deniedByRequest.get(event.id) ?? 0;
    state.last_request_id = event.id; // 事件序最大 = 最新 request（supersedes 链跨进程延续）
    map.set(key, state);
  }
  return map;
};

/** 流内定位 granted 事件 id(A3 窗口区间字段);未找到返回 null。 */
const findGrantedId = (events: readonly SessionEvent[], requestEventRef: number): number | null => {
  const granted = events.find(
    (event) =>
      event.type === "approval/response" &&
      numField(event.payload, "request_event_ref") === requestEventRef &&
      strField(event.payload, "verdict") === "granted",
  );
  return granted === undefined ? null : granted.id;
};

/** 创建问答轨编排 handler(每次 runBranch 一个实例:会话计数与提案状态为 run 内闭包)。 */
export const createApprovalTrackHandler = (deps: ApprovalTrackDeps): ApprovalHandler => {
  // L1a：会话计数器自流内既有 aps-N 最大值续起（防 resume 后新会话与历史撞号；全新 run = 0）
  let sessionCounter = 0;
  for (const event of deps.events) {
    if (event.type !== "approval/request") continue;
    const session = strField(event.payload, "approval_session_id");
    const match = session === null ? null : /^aps-(\d+)$/.exec(session);
    if (match !== null) sessionCounter = Math.max(sessionCounter, Number(match[1]));
  }
  // L1a：resume 跨进程延续——流内已有提案状态作种子（新 run 空流 = 空表，进程内行为零改动）
  const proposals = seedProposalsFromEvents(deps.events);

  const write = async (input: SessionEventInput): Promise<SessionEvent | null> => deps.appendEvent(input);

  const trackBlock = (tool: string, reason: Parameters<typeof approvalTrackBlock>[1], message: string, detail?: unknown): ToolBlock =>
    approvalTrackBlock(tool, reason, message, detail);

  /** 持久化前置(R2)+ 放行:凭据必须为 available,granted 已落盘且刷盘确认,任一不满足不放行。 */
  const persistAndGrant = async (tool: string, credential: { approval_session_id: string; request_event_ref: number }): Promise<ApprovalTrackVerdict> => {
    const state = resolveCredentialState(deps.events, credential, { recoveryWatermark: deps.recoveryWatermark });
    if (state !== "available") {
      // 防御性复核:consumed = 重入;indeterminate = 旧遗留;invalid = 链断——全部不放行(fail-closed)
      return {
        kind: "blocked",
        block: trackBlock(tool, state === "consumed" ? "credential_consumed" : state === "invalid" ? "credential_invalid" : "credential_indeterminate", `凭据预检不通过(${state}),不放行`, { credential, watermark: deps.recoveryWatermark }),
      };
    }
    const flushed = await deps.flush();
    if (!flushed.ok) {
      return {
        kind: "blocked",
        block: trackBlock(tool, "credential_persist_failed", "granted 持久化确认失败(flush),不放行(fail-closed)", { credential, cause: flushed.message }),
      };
    }
    return { kind: "granted" };
  };

  return async (input: ApprovalTrackInput): Promise<ApprovalTrackVerdict> => {
    const { tool, params, approval_key, tool_call_id } = input;

    // ── 凭据预检(重入/恢复):同 tool_call_id 已有 granted 时不重复问询 ──
    const existing = findExistingCredential(deps.events, tool_call_id);
    if (existing !== null) {
      const state = resolveCredentialState(deps.events, existing, { recoveryWatermark: deps.recoveryWatermark });
      if (state === "consumed") {
        return { kind: "blocked", block: trackBlock(tool, "credential_consumed", "凭据已消费(授权调用已有完成事实),无配额复用", { credential: existing }) };
      }
      if (state === "indeterminate") {
        const grantedId = findGrantedId(deps.events, existing.request_event_ref);
        return {
          kind: "blocked",
          block: trackBlock(tool, "credential_indeterminate", "凭据状态不确定(旧遗留 granted 无完成事实)——不重放,需人工核对", {
            credential: existing,
            approval_key,
            window: { granted_id: grantedId, watermark: deps.recoveryWatermark },
          }),
        };
      }
      if (state === "invalid") {
        return { kind: "blocked", block: trackBlock(tool, "credential_invalid", "既有凭据引用链断裂(视为死凭据)", { credential: existing }) };
      }
      // available → 持久化前置后放行(resume(answer) 注入的新凭据路径,ADR-09 C3)
      return await persistAndGrant(tool, existing);
    }

    // ── 提案状态:拒绝循环防护 / 会话延续 / supersedes 链 ──
    let st = proposals.get(approval_key);
    if (st === undefined) {
      st = { approval_session_id: `aps-${++sessionCounter}`, attempt: 0, denied_count: 0 };
      proposals.set(approval_key, st);
    }
    if (st.denied_count >= DENIAL_LOOP_LIMIT) {
      // 同提案已被拒 2 次,再次重提(第 3 次提案)→ 升级终局,不静默重试(决议口径 #4)
      return {
        kind: "aborted",
        block: { ...trackBlock(tool, "approval_aborted", `拒绝循环升级:同提案重提已达阈值 ${String(DENIAL_LOOP_LIMIT)} 次`, {
          approval_session_id: st.approval_session_id,
          approval_key,
          denied_count: st.denied_count,
          attempt: st.attempt,
        }), exit_code: 79 },
      };
    }
    st.attempt += 1;
    const supersedes = st.last_request_id;

    const request = await write({
      type: "approval/request",
      payload: {
        approval_session_id: st.approval_session_id,
        tool_call_id,
        tool,
        params,
        approval_key,
        attempt: st.attempt,
        ...(supersedes !== undefined ? { supersedes } : {}),
      },
    });
    if (request === null) {
      return { kind: "blocked", block: trackBlock(tool, "approval_track_failed", "approval/request 落盘失败(fail-closed,不问询)") };
    }
    st.last_request_id = request.id;

    // ── 应答循环(clarification 同会话多轮;其余 verdict 一次收敛)──
    let currentRequest = request;
    let round = 0;
    for (;;) {
      round += 1;
      let stubResponse;
      try {
        stubResponse = await deps.stub({
          approval_session_id: st.approval_session_id,
          tool,
          params,
          approval_key,
          attempt: st.attempt,
          round,
        });
      } catch (cause) {
        return { kind: "blocked", block: trackBlock(tool, "approval_track_failed", `桩对端故障: ${String(cause)}`) };
      }

      const verdict = stubResponse.verdict;
      const actor = verdict === "timeout" ? "harness" : (stubResponse.actor ?? "stub-host");
      const response = await write({
        type: "approval/response",
        payload: {
          approval_session_id: st.approval_session_id,
          request_event_ref: currentRequest.id,
          verdict,
          actor,
          ...(stubResponse.reason !== undefined ? { reason: stubResponse.reason } : {}),
          ...(stubResponse.advice_text !== undefined ? { advice_text: stubResponse.advice_text } : {}),
          ...(stubResponse.question !== undefined ? { question: stubResponse.question } : {}),
        },
      });
      if (response === null) {
        return { kind: "blocked", block: trackBlock(tool, "approval_track_failed", "approval/response 落盘失败(fail-closed)") };
      }

      switch (verdict) {
        case "granted":
          return await persistAndGrant(tool, { approval_session_id: st.approval_session_id, request_event_ref: currentRequest.id });
        case "denied": {
          st.denied_count += 1;
          return {
            kind: "denied",
            block: trackBlock(tool, "approval_denied", `问答轨拒绝:${stubResponse.reason ?? "(无理由)"}`, {
              approval_session_id: st.approval_session_id,
              request_event_ref: currentRequest.id,
              denied_count: st.denied_count,
            }),
          };
        }
        case "advised": {
          // 意见原文必留(payload.advice_text);非终局——模型重新提案,新 request 将带 supersedes。
          // S2a(C-1):block reason 用独立 approval_advised——「给意见」与「被否决」在 block 面可区分
          // (权威记录 approval/response 的 verdict 语义不变)
          return {
            kind: "reproposal",
            block: trackBlock(tool, "approval_advised", `问答轨修改意见(重新提案):${stubResponse.advice_text ?? ""}`, {
              approval_session_id: st.approval_session_id,
              request_event_ref: currentRequest.id,
              advice_text: stubResponse.advice_text ?? "",
            }),
          };
        }
        case "clarification": {
          // 补上下文后重发 request(同一审批会话;非拒绝,attempt 不变、无 supersedes)
          const resent = await write({
            type: "approval/request",
            payload: {
              approval_session_id: st.approval_session_id,
              tool_call_id,
              tool,
              params,
              approval_key,
              attempt: st.attempt,
            },
          });
          if (resent === null) {
            return { kind: "blocked", block: trackBlock(tool, "approval_track_failed", "clarification 重发 request 落盘失败") };
          }
          currentRequest = resent;
          continue;
        }
        case "timeout": {
          // 超时非否决:run 挂起(suspended,75),resume(answer) 后凭据 id > 水位线 → available 放行
          return {
            kind: "suspended",
            block: { ...trackBlock(tool, "approval_timeout", "问答轨应答等待超时——run 挂起(resume 可续)", {
              approval_session_id: st.approval_session_id,
              request_event_ref: currentRequest.id,
            }), exit_code: 75 },
          };
        }
        case "aborted": {
          return {
            kind: "aborted",
            block: { ...trackBlock(tool, "approval_aborted", `应答方终止任务:${stubResponse.reason ?? "(无理由)"}`, {
              approval_session_id: st.approval_session_id,
              request_event_ref: currentRequest.id,
            }), exit_code: 79 },
          };
        }
      }
    }
  };
};

/** A2:恢复水位线取值——打开/恢复会话后读取流内最大事件 id(create 已保证 id 自 1 连续,
 *  含 session/repair 审计事件);取值后固定于本次进程上下文,不随后续 append 变化。 */
export const readStreamMaxId = async (readText: () => Promise<string>): Promise<number> => {
  const text = await readText();
  let max = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (typeof parsed.id === "number" && parsed.id > max) max = parsed.id;
    } catch {
      // 打开阶段已由 create 校验/截断;此处防御性跳过非 JSON 行
    }
  }
  return max;
};
