/**
 * core 投影面（L1 门 2 T01，《ATF独立Harness_L1门2任务书_20260915.md》§2.1/D1）。
 *
 * 三层前端（src/ui/ TUI · src/acp/ · src/mcp/）共享的唯一投影源 = append-only 会话事件流：
 * core 在每个事件真实落盘（GuardedSessionLog append 成功、进入内存事件序列）后向外投影，
 * 订阅方看到的事件顺序与日志逐条一致——UI 里看到的、编辑器里看到的、工具结果里看到的
 * 是同一条真相（INV-A 投影侧收益）。被铁律一/校验拒绝的事件不落盘、不投影。
 *
 * 边界：本面只投「已落盘事实」；思考内容等线缆域信息不进本面（D6 的「仅投影域」由
 * 外壳层在其自身投影映射中处置，core 会话日志恒不含 thinking）。投影不是第二真相源——
 * 账本轨/问答轨的权威记录仍是 append-only 日志本体。
 */

import type { SessionEvent } from "./session/index.js";

/** 投影来源：live = 本次进程新落盘事件；history = resume/load 场景装载的既有流（按日志顺序）。 */
export type ProjectionOrigin = "history" | "live";

/** 投影订阅者（同步、无返回值；投影失败不得反压执行路径——订阅方异常由其自负）。 */
export type RunEventSubscriber = (event: SessionEvent, origin: ProjectionOrigin) => void;

/** 多订阅投影 hub（TUI 渲染与审计观察等可并存订阅）。零依赖、纯内存、无队列——
 *  订阅者在 emit 调用栈内同步执行，事件顺序 = 落盘顺序。单订阅者异常被 hub 隔离
 *  （投影是观察面：失败不得反压执行路径，也不得饿死其他订阅者）；需感知故障的
 *  订阅方在自身回调内 try/catch。 */
export interface ProjectionHub {
  subscribe: (subscriber: RunEventSubscriber) => () => void;
  emit: (event: SessionEvent, origin: ProjectionOrigin) => void;
}

export const createProjectionHub = (): ProjectionHub => {
  const subscribers = new Set<RunEventSubscriber>();
  return {
    subscribe: (subscriber): (() => void) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    emit: (event, origin): void => {
      for (const subscriber of subscribers) {
        try {
          subscriber(event, origin);
        } catch {
          // 投影观察面不反压执行路径（见上）；订阅方需感知故障时自行捕获。
        }
      }
    },
  };
};
