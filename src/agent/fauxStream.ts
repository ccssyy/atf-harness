/**
 * 门 1a spike（批 P，裁定《ATF-Harness_裁定_方案丙立项与批P授权_20260924.md》）——
 * faux streamFn：脚本化 AssistantMessage 驱动 pi-agent-core Agent 循环，零网络、零真实
 * Provider 调用（批 P 红线：真实调用按需另批）。
 *
 * 事件序列与 pi-ai AssistantMessageEventStream 协议对齐（start → 内容事件 → done）；
 * 循环消费契约（agent-loop streamAssistantResponse）：start 给 partial、done 终结并取
 * result()。脚本耗尽 = 结构化 error 停止原因（fail-closed，不静默续跑）。
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const FAUX_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** faux 响应统一脚手架（字段必填面与真实 wire 响应同形；计数全零）。 */
export const fauxAssistantMessage = (
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "deepseek",
  model: "faux-spike",
  usage: FAUX_USAGE,
  stopReason,
  timestamp: Date.now(),
});

/** 决策形态一＋二（A3 同消息）：assistant 文本（message）＋工具调用（tool_calls）。 */
export const fauxMessageWithToolCalls = (
  text: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments: JsonObject }>,
): AssistantMessage =>
  fauxAssistantMessage(
    [
      ...(text === "" ? [] : [{ type: "text" as const, text }]),
      ...calls.map(
        (call): ToolCall => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments }),
      ),
    ],
    "toolUse",
  );

/** 决策形态三：纯文本 final_answer（无工具调用，循环判定终止）。 */
export const fauxFinalAnswer = (text: string): AssistantMessage =>
  fauxAssistantMessage([{ type: "text", text }], "stop");

/** 脚本化 streamFn：每次调用按序弹出一条脚本响应；耗尽 = error 停止原因（fail-closed）。
 *  issued 计数供测试/演示断言"循环实际发起的模型请求数"。 */
export interface FauxStreamFn extends StreamFn {
  readonly issued: number;
}

export const createFauxStreamFn = (script: readonly AssistantMessage[]): FauxStreamFn => {
  const queue = [...script];
  let issued = 0;
  const fn = ((...[model, context, options]: Parameters<StreamFn>): AssistantMessageEventStream => {
    void model;
    void context;
    void options;
    issued += 1;
    const stream = createAssistantMessageEventStream();
    const next = queue.shift();
    if (next === undefined) {
      const exhausted = fauxAssistantMessage([], "stop");
      stream.push({ type: "start", partial: { ...exhausted, stopReason: "pending" } });
      stream.push({
        type: "error",
        reason: "error",
        error: { ...exhausted, stopReason: "error", errorMessage: "faux 脚本耗尽（fail-closed，不编造响应）" },
      });
      return stream;
    }
    stream.push({ type: "start", partial: { ...next, stopReason: "pending" } });
    stream.push({ type: "done", reason: next.stopReason === "toolUse" ? "toolUse" : "stop", message: next });
    return stream;
  }) as FauxStreamFn;
  Object.defineProperty(fn, "issued", {
    get: () => issued,
    configurable: false,
  });
  return fn;
};
