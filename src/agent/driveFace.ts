/**
 * 丙 v1.1（批 P 增补漏项补全）——B9 boundary＋B10 reconcile（pi drive 层语义的丙线映射）。
 *
 * B9 boundary（库原语 runtime/drive/boundary.ts：planBoundaryInbox「收口时选并物化输入」
 * ＋finishRunBoundary「before_run_end 后重规划：提交续跑工作或终局 run 结果」）：丙线
 * 挂接＝**run 收口边界规划面**——finishTurn 阶段产出 BoundaryPlan（续跑＝有 steering/
 * followUp 待处理；终局＝预算/收束/审批终局），与 steering 配套（followUpWhenNoTrigger
 * 语义：无 steering trigger 时 followUp 决定续跑）。
 *
 * B10 reconcile（库原语 runtime/drive/reconcile.ts：reconcileOperation「advance one
 * cancelled durable leaf without starting new ordinary work」）：丙线挂接＝孤儿 turn 的
 * **无新工作推进**——孤儿半边合成受控收口（不发起任何模型请求），与 fork 恢复
 * （sessionMirror.recoverFromOrphan，需要续跑时用）构成两径恢复面。
 */
import type { AgentMessage, QueueMode } from "@earendil-works/pi-agent-core";
import type { V1RunOutcome } from "./budget.js";

// ---------------------------------------------------------------- B9 boundary

/** 收口边界规划（库 BoundaryPlacement/finishRunBoundary 语义的丙线投影）。 */
export interface BoundaryPlan {
  kind: "continue_run" | "finish_run";
  /** 续跑触发源（steering 配套：trigger=steering 队列；无 trigger 时 followUp 决定）。 */
  trigger: "steering" | "follow_up" | null;
  queued: { steering: number; followUp: number };
  /** 终局结果（kind=finish_run 时携带；continue_run 为 undefined）。 */
  outcome?: V1RunOutcome;
}

export interface PlanBoundaryInput {
  steeringQueued: number;
  followUpQueued: number;
  /** 当前已判定的终局（预算/审批等；undefined = 模型面未终局）。 */
  pendingOutcome: V1RunOutcome | undefined;
  /** 模型已给出 final_answer（正常收束）。 */
  hasFinalAnswer: boolean;
}

/** 收口边界规划（纯函数；finishTurn/before_run_end 装配面消费）。 */
export const planRunBoundary = (input: PlanBoundaryInput): BoundaryPlan => {
  if (input.pendingOutcome !== undefined) {
    return { kind: "finish_run", trigger: null, queued: { steering: input.steeringQueued, followUp: input.followUpQueued }, outcome: input.pendingOutcome };
  }
  if (input.steeringQueued > 0) {
    return { kind: "continue_run", trigger: "steering", queued: { steering: input.steeringQueued, followUp: input.followUpQueued } };
  }
  if (input.followUpQueued > 0 && !input.hasFinalAnswer) {
    return { kind: "continue_run", trigger: "follow_up", queued: { steering: 0, followUp: input.followUpQueued } };
  }
  if (input.hasFinalAnswer) {
    return {
      kind: "finish_run",
      trigger: null,
      queued: { steering: input.steeringQueued, followUp: input.followUpQueued },
      outcome: { kind: "completed" },
    };
  }
  // 无终局无收束：循环自身会续跑（模型轮未完）——规划面不干预
  return { kind: "continue_run", trigger: null, queued: { steering: input.steeringQueued, followUp: input.followUpQueued } };
};

/** 队列水位（Agent 句柄面取样；peek 不消费）。 */
export const queueLevels = (agent: { hasQueuedMessages(): boolean; peekQueuedMessages(): AgentMessage[]; steeringMode: QueueMode; followUpMode: QueueMode }): { steering: number; followUp: number } => {
  if (!agent.hasQueuedMessages()) return { steering: 0, followUp: 0 };
  // peek 面不区分双队列（库 peek 聚合）——规划面按聚合水位决策（两队列独立 drain 语义由库承载）
  return { steering: agent.peekQueuedMessages().length, followUp: 0 };
};

// ---------------------------------------------------------------- B10 reconcile

export type ReconcilePlan =
  | { action: "none" }
  | { action: "synthesized_close"; orphanEntryId: string; /** 合成收口文案（受控恢复留痕）。 */ note: string }
  | { action: "fork_before"; orphanEntryId: string };

/**
 * 孤儿 reconcile 规划（reconcileOperation 语义对齐：推进已取消的持久叶子、**不发起新工作**）。
 * 丙线两径：synthesized_close＝就地合成 toolResult 收口（转录合法化、零模型请求）；
 * fork_before＝回退到孤儿前完整边（需要以不同上下文续跑时由调用方选用）。
 */
export const planReconcile = (orphan: { orphan: true; orphanEntryId: string } | { orphan: false }): ReconcilePlan => {
  if (!orphan.orphan) return { action: "none" };
  return {
    action: "synthesized_close",
    orphanEntryId: orphan.orphanEntryId,
    note: "orphan_recovered：崩溃半边经受控恢复通道合成收口（未执行任何工具、未发起模型请求——B10 reconcile 对齐）",
  };
};
