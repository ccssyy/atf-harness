/**
 * 丙 v1 批 P 增补 §二 B4——hook 注册面（pi HookRegistry 13 名的丙线映射；本批实际注册
 * 至少 8 名，其余按需）。
 *
 * 13 名 → 丙线映射（raw Agent 面）：before_run（prompt 接纳前）／before_drive（agent_start）
 * ／before_run_end（agent_end）／transform_context（Agent.transformContext）／before_request
 * （Agent.prepareRequest）／before_payload（Agent.onPayload）／after_response（Agent.onResponse）
 * ／before_compaction（compaction 流程闸）——其余 5 名（after_tool/before_tool/after_run/
 * after_drive/on_error 类）由 Agent 专参（beforeToolCall/afterToolCall）与订阅面承载，
 * 按需注册（登记）。
 */
import type { AgentEvent, AgentMessage, PrepareRequestContext } from "@earendil-works/pi-agent-core";

/** 已注册 hook 名闭集（≥8 实注册；其余 5 名由 Agent 专参/订阅面承载，按需）。 */
export const V1_HOOK_NAMES = [
  "before_run",
  "before_drive",
  "before_run_end",
  "transform_context",
  "before_request",
  "before_payload",
  "after_response",
  "before_compaction",
] as const;

export type V1HookName = (typeof V1_HOOK_NAMES)[number];

export type V1HookHandler = (payload: unknown) => Promise<void> | void;

export interface V1HookRegistry {
  register(name: V1HookName, handler: V1HookHandler): void;
  invoke(name: V1HookName, payload: unknown): Promise<void>;
  names(): V1HookName[];
  registeredCount(): number;
}

/** hook 注册面（顺序调用；handler 异常 containment 不反压主链——镜像同纪律）。 */
export const createHookRegistry = (): V1HookRegistry => {
  const handlers = new Map<V1HookName, V1HookHandler[]>();
  return {
    register: (name, handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    invoke: async (name, payload) => {
      for (const handler of handlers.get(name) ?? []) {
        try {
          await handler(payload);
        } catch {
          /* hook 异常不反压主链（containment） */
        }
      }
    },
    names: () => [...V1_HOOK_NAMES],
    registeredCount: () => [...handlers.values()].reduce((sum, list) => sum + list.length, 0),
  };
};

/** Agent 事件 → hook 桥（before_drive/before_run_end 注册面）；返回取消函数。 */
export const wireEventHooks = (
  subscribe: (listener: (event: AgentEvent) => Promise<void> | void) => () => void,
  registry: V1HookRegistry,
): (() => void) =>
  subscribe((event) => {
    if (event.type === "agent_start") return registry.invoke("before_drive", event);
    if (event.type === "agent_end") return registry.invoke("before_run_end", event);
    return undefined;
  });

/** transform_context 链（B3 compaction→TEM 注入→hook 闸）——v1 装配唯一上下文入口。 */
export type TransformChain = (messages: AgentMessage[]) => Promise<AgentMessage[]>;

/** before_request 适配（Agent prepareRequest 面）。 */
export const prepareRequestViaHook =
  (registry: V1HookRegistry) =>
  async (request: PrepareRequestContext): Promise<void> => {
    await registry.invoke("before_request", { model: request.model.id, thinkingLevel: request.thinkingLevel, messages: request.context.messages.length });
  };
