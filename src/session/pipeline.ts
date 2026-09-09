/**
 * 双管道占位实现（Phase 1 任务书 S2-3，借鉴 Pi 的双上下文管道设计）。
 * 函数签名在本 slice 定死，内部逻辑 Phase 2 再长：
 * - transformContext：组装模型请求上下文——本阶段只做拼接 + 过滤 assistant/attempt；
 * - convertToLlm：白名单投影——UI-only 字段与内部字段一律不进入模型可见形态。
 * 二者为纯函数（输入类型已保证合法，无失败路径），故不返回 Result。
 */
import { type SessionEvent } from "./schema.js";

/**
 * 模型上下文事件——convertToLlm 的白名单输出形态（session.contract.yaml pipeline 节）。
 * 仅 { id, ts, type, payload, domain_refs? }；ui / projection / ref_invalid 及
 * 未来任何新增字段一律不出现（内部字段不发模型，与 S3 工具 schema 同一收敛哲学）。
 */
export interface LlmContextEvent {
  id: number;
  ts: string;
  type: SessionEvent["type"];
  payload: unknown;
  domain_refs?: SessionEvent["domain_refs"];
}

/** 单事件白名单投影：剔除 UI-only 与内部字段。 */
export const convertToLlm = (event: SessionEvent): LlmContextEvent => {
  const projected: LlmContextEvent = {
    id: event.id,
    ts: event.ts,
    type: event.type,
    payload: event.payload,
  };
  if (event.domain_refs !== undefined) projected.domain_refs = event.domain_refs;
  return projected;
};

/**
 * 组装模型请求上下文：按会话顺序拼接，过滤 assistant/attempt（失败尝试落盘但不进模型历史）。
 * compaction / 领域事实白名单逻辑为 Phase 2 顺延项，此处不实现。
 */
export const transformContext = (events: readonly SessionEvent[]): LlmContextEvent[] =>
  events.filter((event) => event.type !== "assistant/attempt").map(convertToLlm);
