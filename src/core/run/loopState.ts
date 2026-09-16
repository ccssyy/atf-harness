/**
 * durability 公理兑现（切片 2——《ATF独立Harness_切片2任务书_adapter与公理兑现_20260914.md》§1.4；
 * 依据《agent-loop 设计（已升格）》§2.3：loop 恢复依赖的一切状态必须可由本侧事件流推导，
 * 禁止以"再查内核"为恢复依据——内核内存态在进程重启后为空，"不存在"≠"未推进"。
 *
 * 范式：既有 `resolveCredentialState`（src/tools/credentialState.ts）——凭据状态由事件流
 * 纯函数推导。本模块把 loop 骨架的恢复所需状态（turn 计数 / 每 turn 步数与决策数）落为
 * 同款纯函数：输入**只有事件流**（类型层面即无内核连接/provider 参数位）。
 */
import { type SessionEvent } from "../session/index.js";

export interface LoopTurnState {
  turn_index: number;
  /** 事件流可推导的决策数（assistant/message + tool/call + provider/switch 事件计数——
   *  被拒的 provider_switch 请求不落事件，恢复视角下不可见亦无需可见：不影响预算续算口径） */
  decision_count: number;
  /** 事件流可推导的内容步数（assistant/message + tool/call；工作区动作无独立事件，
   *  以 turn/end.payload.step_count 为权威——恢复时优先读 payload，本推导为其交叉校验面） */
  step_count_event_derived: number;
  /** turn 收口原因（turn/end.payload.reason；null = turn 未收口——恢复场景的悬挂 turn） */
  closed_reason: string | null;
  /** 收口负载的权威计数（turn/end.payload 恒填字段；恢复时的首选数据源） */
  payload_step_count: number | null;
  payload_decision_count: number | null;
  stop_reason: string | null;
}

export interface LoopStateSnapshot {
  turns_opened: number;
  turns: LoopTurnState[];
}

/**
 * 事件流 → loop 恢复状态（纯函数：同输入同输出；签名即结构断言——无任何内核/连接参数位）。
 * 与既有 resolveCredentialState 同范式：恢复只读本侧事件流。
 */
export const deriveLoopStateFromEvents = (events: readonly SessionEvent[]): LoopStateSnapshot => {
  const turns: LoopTurnState[] = [];
  let current: LoopTurnState | null = null;
  for (const event of events) {
    if (event.type === "turn/start") {
      current = {
        turn_index: turns.length + 1,
        decision_count: 0,
        step_count_event_derived: 0,
        closed_reason: null,
        payload_step_count: null,
        payload_decision_count: null,
        stop_reason: null,
      };
      turns.push(current);
      continue;
    }
    if (current === null) continue; // turn 外事件（如收口失败边界）不归属任何 turn
    if (event.type === "assistant/message" || event.type === "tool/call") {
      current.decision_count += 1;
      current.step_count_event_derived += 1;
      continue;
    }
    if (event.type === "provider/switch") {
      // 切换落在 turn 边界（INV-3）：归属上一 turn 的决策面（switch 决策不可执行内容，不计 step）
      current.decision_count += 1;
      continue;
    }
    if (event.type === "turn/end") {
      const payload = event.payload as { reason?: unknown; step_count?: unknown; decision_count?: unknown; stop_reason?: unknown };
      current.closed_reason = typeof payload["reason"] === "string" ? payload["reason"] : null;
      current.payload_step_count = typeof payload["step_count"] === "number" ? payload["step_count"] : null;
      current.payload_decision_count = typeof payload["decision_count"] === "number" ? payload["decision_count"] : null;
      current.stop_reason = typeof payload["stop_reason"] === "string" ? payload["stop_reason"] : null;
      current = null;
    }
  }
  return { turns_opened: turns.length, turns };
};
