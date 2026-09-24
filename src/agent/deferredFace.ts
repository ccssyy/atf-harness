/**
 * 丙 v1.1（批 P 增补漏项补全）——B11 deferred：伴生子任务原语（"训练中 ckpt 抽查"场景）。
 *
 * 库原语（pi-ai）：stopReason="deferred"＋DeferredHandle＋Api.fetchDeferred/cancelDeferred
 * ——模型可对长时操作返回 deferred 句柄，harness 稍后 fetch 取回结果。丙线挂接＝
 * **伴生子任务注册面**：发起（start）→ 继续主链 → 取回（fetch）/取消（cancel）；
 * 执行器注入面缺省 faux（B 档 faux 即可），v1.1 subagent（dispatch_training_subtask）
 * 落位后可换装为真子 Agent 执行器。
 */
import { randomUUID } from "node:crypto";

/** deferred 句柄（pi DeferredHandle 语义的丙线投影）。 */
export interface DeferredSubtaskHandle {
  readonly id: string;
  readonly label: string;
}

export type DeferredSubtaskStatus =
  | { state: "running" }
  | { state: "done"; result: string }
  | { state: "cancelled" }
  | { state: "failed"; error: string };

export interface DeferredSubtaskRegistry {
  /** 发起伴生子任务（执行器异步跑；主链不被阻塞）。 */
  start(label: string, executor: () => Promise<string>): DeferredSubtaskHandle;
  /** 取回（pi fetchDeferred 语义：未完成 = running 照返，不阻塞主链）。 */
  fetch(handle: DeferredSubtaskHandle): Promise<DeferredSubtaskStatus>;
  /** 取消（pi cancelDeferred 语义）。 */
  cancel(handle: DeferredSubtaskHandle): Promise<void>;
  list(): Array<{ handle: DeferredSubtaskHandle; status: DeferredSubtaskStatus }>;
}

export const createDeferredSubtaskRegistry = (): DeferredSubtaskRegistry => {
  const tasks = new Map<string, { handle: DeferredSubtaskHandle; status: DeferredSubtaskStatus; promise: Promise<void> }>();
  return {
    start: (label, executor) => {
      const handle: DeferredSubtaskHandle = { id: `deferred-${randomUUID()}`, label };
      const entry: { handle: DeferredSubtaskHandle; status: DeferredSubtaskStatus; promise: Promise<void> } = {
        handle,
        status: { state: "running" },
        promise: Promise.resolve(),
      };
      entry.promise = executor()
        .then((result) => {
          if (entry.status.state === "running") entry.status = { state: "done", result };
        })
        .catch((cause: unknown) => {
          if (entry.status.state === "running") entry.status = { state: "failed", error: cause instanceof Error ? cause.message : String(cause) };
        });
      tasks.set(handle.id, entry);
      return handle;
    },
    fetch: async (handle) => tasks.get(handle.id)?.status ?? { state: "failed", error: "未知句柄" },
    cancel: async (handle) => {
      const entry = tasks.get(handle.id);
      if (entry !== undefined && entry.status.state === "running") entry.status = { state: "cancelled" };
      await entry?.promise.catch(() => undefined);
    },
    list: () => [...tasks.values()].map((entry) => ({ handle: entry.handle, status: entry.status })),
  };
};
