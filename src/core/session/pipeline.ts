/**
 * 双管道（Phase 1 任务书 S2-3 定签名，P2-S1 起真实实现，登记于 session.contract.yaml pipeline 节）：
 * - transformContext：组装模型请求上下文——过滤 assistant/attempt + compaction 投影
 *   （触发阈值 / 白名单 / 折叠算法见 compaction.ts，常量见 constants.ts）；
 * - convertToLlm：白名单投影——UI-only 字段与内部字段一律不进入模型可见形态。
 * 二者为纯函数（输入类型已保证合法，无失败路径），故不返回 Result。
 */
import { projectContext, type LlmContextEvent } from "./compaction.js";
import { type SessionEvent } from "./schema.js";

export { convertToLlm, type LlmContextEvent } from "./compaction.js";

/**
 * 组装模型请求上下文：assistant/attempt（失败尝试落盘但不进模型历史）恒被过滤；
 * 达到压缩阈值后，最旧的可折叠前缀折叠为 session/compaction 摘要，
 * 携带 domain_refs 的事件及其相邻因果链永不折叠（白名单豁免，原文保留）。
 */
export const transformContext = (events: readonly SessionEvent[]): LlmContextEvent[] =>
  projectContext(events);
