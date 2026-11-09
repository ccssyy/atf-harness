/**
 * D250 输出截断自动续写——续写协调器（纯逻辑，可测核心）。
 *
 * 语义移植自 zcode `turn-output-token-continuation.ts`（Apache-2.0）：
 * 监听 session 事件流，`turn/end` 且 reason.kind === 'max-tokens' 时在预算内
 * 自动向该会话注入一条续写消息（followup，唤醒下一轮）。预算每会话独立、
 * 跨 turn 不重置（一次任务链最多续写 max 次）；含工具调用的 turn 不续写
 * （工具调用轮的截断由 dsh 原生路径处理）；预算耗尽注入不唤醒的告警消息
 * （inject——进对话流用户可见，但不触发模型响应）。
 *
 * 候裁默认动作（任务书）：预算表为进程内存态——server 重启即重置，可接受
 * （重启本身清空所有会话活动状态）。
 */

/** 续写提示词：四要素=直接续/不复述/从断点接/拆小块（zcode 同语义中文化）。 */
export const CONTINUE_PROMPT =
  "输出已达模型单次响应上限。直接继续——不要道歉、不要复述之前的工作。" +
  "如果截断发生在思路中途，从中途接着写下去。把剩余工作拆成更小的块。";

/** 预算耗尽告警：如实说明 + 两条改法（报错即修复指令纪律）。 */
export function exhaustedNotice(max: number): string {
  return (
    `自动续写已达上限（本会话已自动续写 ${max} 次）：本轮输出再次撞到模型单次输出上限，已停止自动续写。` +
    "可选做法：①把当前任务拆成更小的步骤，分多条消息推进；" +
    "②把思考档位从 High 调低到 Medium/Low 后重发\"继续\"。"
  );
}

/** 续写协调器依赖注入面（测试用 mock 替换）。 */
export interface ContinuationDeps {
  /** 按会话 id 取活跃 agent 实例；agent 已释放（会话已关）时返回 undefined。 */
  getAgent(sessionId: string): ContinuationAgent | undefined;
  /** 预算上限（每会话累计，跨 turn 不重置）。 */
  max: number;
}

/** 续写需要的 agent 最小面（对齐 dsh Agent 的 followup/inject）。 */
export interface ContinuationAgent {
  followup(message: unknown): void;
  inject(message: unknown): void;
}

/** 会话内状态：当前 turn 号、本 turn 工具调用数、本会话已用续写次数。 */
interface SessionState {
  turn: number;
  toolCalls: number;
  continuations: number;
  /** 耗尽告警已发过一次——后续撞顶静默（防告警刷屏）。 */
  exhaustedNotified: boolean;
}

/** 构造续写协调器：返回可直接挂到 ctx.on('session/event', …) 的处理器。 */
export function makeContinuationCoordinator(deps: ContinuationDeps) {
  const states = new Map<string, SessionState>();

  const stateOf = (sessionId: string): SessionState => {
    let st = states.get(sessionId);
    if (st === undefined) {
      st = { turn: 0, toolCalls: 0, continuations: 0, exhaustedNotified: false };
      states.set(sessionId, st);
    }
    return st;
  };

  const injectFollowup = (sessionId: string, text: string, kind: string): boolean => {
    const agent = deps.getAgent(sessionId);
    if (agent === undefined) return false;
    const message = {
      role: "user",
      content: [{ type: "text", text }],
      // source.kind 为 user 消息开放集（dsh MessageSourceMap 注释：consumer 对未知
      // kind fall-through；webhook 先例即自定义 kind）。标记来源便于事件流判别（K1）。
      source: { kind },
    };
    if (kind === "atf-continuation-exhausted") {
      agent.inject(message); // 不唤醒：告警进对话流但不触发模型响应
    } else {
      agent.followup(message); // 唤醒：开新轮接着写（K1/K5）
    }
    return true;
  };

  return {
    /** session/event 处理器（对齐 dsh ctx.on 回调签名 (session, event)）。 */
    onSessionEvent(session: { id?: string }, event: { type: string; data?: any }): void {
      const sessionId = session.id;
      if (sessionId === undefined) return;
      switch (event.type) {
        case "turn/start": {
          const st = stateOf(sessionId);
          // 新 turn 开启：重置本 turn 工具调用计数；续写预算跨 turn 累计不重置。
          if (st.turn !== event.data?.turn) {
            st.turn = event.data?.turn ?? 0;
            st.toolCalls = 0;
          }
          break;
        }
        case "tool/call": {
          stateOf(sessionId).toolCalls += 1;
          break;
        }
        case "turn/end": {
          const reason = event.data?.reason;
          if (reason?.kind !== "max-tokens") break;
          const st = stateOf(sessionId);
          // 状态过期防御：turn/end 归属的不是当前跟踪的 turn（乱序/串话）不处理。
          if (st.turn !== event.data?.turn) break;
          // K4：本 turn 有工具调用 → 截断走 dsh 原生路径，不自动续写。
          if (st.toolCalls > 0) break;
          // K3：预算耗尽 → 注入告警（不再续写）；告警只发一次防刷屏。
          if (st.continuations >= deps.max) {
            if (!st.exhaustedNotified) {
              st.exhaustedNotified = true;
              injectFollowup(sessionId, exhaustedNotice(deps.max), "atf-continuation-exhausted");
            }
            break;
          }
          // K1/K2：预算内 → 注入续写提示并唤醒。
          st.continuations += 1;
          injectFollowup(sessionId, CONTINUE_PROMPT, "atf-continuation");
          break;
        }
        default:
          break;
      }
    },
    /** 会话释放时清状态（防 Map 泄漏；对齐 ctx.on('session/disposed') 通道）。 */
    onSessionDisposed(session: { id?: string }): void {
      const sessionId = session.id;
      if (sessionId !== undefined) states.delete(sessionId);
    },
    /** 测试观测面：读某会话当前状态（不暴露 Map 本体）。 */
    stateOfForTest(sessionId: string): SessionState | undefined {
      return states.get(sessionId);
    },
  };
}
