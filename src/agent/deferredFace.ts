/**
 * 丙 v1.1（批 P 增补漏项补全）→ 丙 v2 实体化（批 P 续作，指令 6227dbfc §四.3）——
 * deferred：伴生子任务原语（"训练中 ckpt 抽查"场景）。
 *
 * 库原语（pi-ai）：stopReason="deferred"＋DeferredHandle＋Api.fetchDeferred/cancelDeferred
 * ——模型可对长时操作返回 deferred 句柄，harness 稍后 fetch 取回结果。丙线挂接＝
 * **伴生子任务注册面**：发起（spawn）→ 继续主链 → 有界轮询（poll）／取回（fetch）／
 * 取消（cancel）；执行器注入面缺省 faux（B 档 faux 即可），装配期换装为子 Agent 执行器
 * （subagent.createChildInstructionRunner）。
 *
 * v2 实体化纪律（指令 §三.3 钉死项）：
 *   - 生命周期 spawn/poll/cancel：伴生任务生命周期长于主 turn（registry 由装配持有，
 *     跨 turn 存活）；轮询语义走 followUp/boundary（B9 planRunBoundary 对接——driveFace），
 *     **禁 while True 无界轮询**：poll 以 max_polls 有界（缺省/上限常量封顶）＋超时收口
 *     （timeout 终态照返，不阻塞主链）；
 *   - poll 不消费任务：timeout/running 后任务仍在册，可再次 poll 或 cancel；
 *   - start 为 v1.1 既有入口（既有消费零回归），spawn 为 v2 正名别名（同一语义）。
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

/** poll 结果（有界轮询闭集）：done=取回结果；cancelled/failed=终态照返；running=轮次内
 *  未收口；timeout=max_polls 耗尽超时收口（任务仍在册）。 */
export type DeferredPollOutcome =
  | { outcome: "done"; result: string; polls_used: number }
  | { outcome: "cancelled"; polls_used: number }
  | { outcome: "failed"; error: string; polls_used: number }
  | { outcome: "running"; polls_used: number }
  | { outcome: "timeout"; polls_used: number };

/** poll 有界参数：缺省/上限常量单源（禁无界轮询的机制面）。 */
export const DEFERRED_POLL_MAX_POLLS_DEFAULT = 10;
export const DEFERRED_POLL_MAX_POLLS_CEILING = 100;
export const DEFERRED_POLL_INTERVAL_MS_DEFAULT = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DeferredSubtaskRegistry {
  /** 发起伴生子任务（执行器异步跑；主链不被阻塞）。v1.1 入口，既有消费零回归。 */
  start(label: string, executor: () => Promise<string>): DeferredSubtaskHandle;
  /** v2 正名别名（spawn/poll/cancel 生命周期；与 start 同一语义）。 */
  spawn(label: string, executor: () => Promise<string>): DeferredSubtaskHandle;
  /** 取回（pi fetchDeferred 语义：未完成 = running 照返，不阻塞主链；不轮询）。 */
  fetch(handle: DeferredSubtaskHandle): Promise<DeferredSubtaskStatus>;
  /** 有界轮询取回（pi fetchDeferred 的收口形态）：至多 maxPolls 次、每次间隔
   *  intervalMs；终态即刻返回；轮次耗尽＝timeout 收口（无 while True）。 */
  poll(
    handle: DeferredSubtaskHandle,
    opts?: { maxPolls?: number; intervalMs?: number },
  ): Promise<DeferredPollOutcome>;
  /** 取消（pi cancelDeferred 语义；已终态任务幂等照认）。 */
  cancel(handle: DeferredSubtaskHandle): Promise<void>;
  list(): Array<{ handle: DeferredSubtaskHandle; status: DeferredSubtaskStatus }>;
}

export const createDeferredSubtaskRegistry = (): DeferredSubtaskRegistry => {
  const tasks = new Map<string, { handle: DeferredSubtaskHandle; status: DeferredSubtaskStatus; promise: Promise<void> }>();
  const start = (label: string, executor: () => Promise<string>): DeferredSubtaskHandle => {
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
  };
  const registry: DeferredSubtaskRegistry = {
    start,
    spawn: start,
    fetch: async (handle) => tasks.get(handle.id)?.status ?? { state: "failed", error: "未知句柄" },
    poll: async (handle, opts) => {
      const maxPolls = Math.min(opts?.maxPolls ?? DEFERRED_POLL_MAX_POLLS_DEFAULT, DEFERRED_POLL_MAX_POLLS_CEILING);
      const intervalMs = opts?.intervalMs ?? DEFERRED_POLL_INTERVAL_MS_DEFAULT;
      for (let used = 1; used <= maxPolls; used += 1) {
        const status = await registry.fetch(handle);
        if (status.state === "done") return { outcome: "done", result: status.result, polls_used: used };
        if (status.state === "cancelled") return { outcome: "cancelled", polls_used: used };
        if (status.state === "failed") return { outcome: "failed", error: status.error, polls_used: used };
        if (used < maxPolls) await sleep(intervalMs);
      }
      return { outcome: "timeout", polls_used: maxPolls };
    },
    cancel: async (handle) => {
      const entry = tasks.get(handle.id);
      if (entry !== undefined && entry.status.state === "running") entry.status = { state: "cancelled" };
      await entry?.promise.catch(() => undefined);
    },
    list: () => [...tasks.values()].map((entry) => ({ handle: entry.handle, status: entry.status })),
  };
  return registry;
};
