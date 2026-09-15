/**
 * 前端一（自有 UI · TUI）——会话事件 → 过程流行（L1 门 2 T02，VERIFY 验收项 2 的呈现侧）。
 *
 * 同源纪律：行内容只由 SessionEvent 本体推导（core 投影面投出的已落盘事实），不引入
 * 第二套语义——UI 每行带事件 id 前缀 `#NNNN`，与 append-only 日志逐条对应（smoke:l1ui
 * 两侧比对断言）。origin=history（resume 装载的既有流）加「历史」标记，防与本次进程
 * 新落盘事件混淆。脱敏：本模块只做展示格式化，不新增任何载荷来源。
 */

import type { SessionEvent } from "../core/session/index.js";
import type { ProjectionOrigin } from "../core/index.js";
import { type ToolResultPayload } from "../core/run/index.js";

/** 单行截断上限（展示面；日志本体不受影响）。 */
const DETAIL_MAX = 160;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const truncate = (text: string, max = DETAIL_MAX): string =>
  text.length <= max ? text : `${text.slice(0, max)}…(截断)`;

const detailOf = (value: unknown): string => truncate(oneLine(JSON.stringify(value) ?? ""));

const payloadStr = (payload: unknown, key: string): string => {
  if (typeof payload !== "object" || payload === null) return "";
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/** 事件 → 过程流行（固定 `#id [历史] 类型 详情` 形态；id 与日志逐条对应）。 */
export const formatEventLine = (event: SessionEvent, origin: ProjectionOrigin): string => {
  const prefix = `#${String(event.id).padStart(4, "0")} ${origin === "history" ? "[历史] " : ""}${event.type.padEnd(18)} `;
  const payload: unknown = event.payload;
  switch (event.type) {
    case "turn/start":
      return `${prefix}开始（scenario=${payloadStr(payload, "scenario_id")} branch=${payloadStr(payload, "branch_id")}）`;
    case "turn/end": {
      const reason = payloadStr(payload, "reason");
      const stop = payloadStr(payload, "stop_reason");
      return `${prefix}收口 reason=${reason}${stop !== "" ? ` stop_reason=${stop}` : ""}`;
    }
    case "user/message":
      return `${prefix}${truncate(oneLine(payloadStr(payload, "text")))}`;
    case "assistant/message":
      return `${prefix}${truncate(oneLine(payloadStr(payload, "text")))}`;
    case "assistant/attempt":
      return `${prefix}reason=${payloadStr(payload, "reason") || payloadStr(payload, "code")} ${oneLine(JSON.stringify(payload))}`.trimEnd();
    case "tool/call":
      return `${prefix}${payloadStr(payload, "tool")} 参数=${detailOf((payload as { params?: unknown } | undefined)?.params)}`;
    case "tool/result": {
      const result = payload as ToolResultPayload;
      if (result.ok) {
        return `${prefix}ok=true ${result.tool} 结果=${detailOf(result.result)}`;
      }
      const blockReason = result.block?.reason;
      return `${prefix}ok=false ${result.tool} 原因=${result.reason}${blockReason !== undefined ? `(${blockReason})` : ""}${result.reason === "failed" && result.detail !== undefined ? ` 明细=${detailOf(result.detail)}` : ""}`;
    }
    case "approval/request":
      return `${prefix}session=${payloadStr(payload, "approval_session_id")} attempt=${payloadStr(payload, "attempt")} tool=${payloadStr(payload, "tool")}${payloadStr(payload, "supersedes") !== "" ? " supersedes" : ""}`;
    case "approval/response": {
      const advice = payloadStr(payload, "advice_text");
      const reason = payloadStr(payload, "reason");
      const note = advice !== "" ? advice : reason;
      return `${prefix}verdict=${payloadStr(payload, "verdict")} actor=${payloadStr(payload, "actor")}${note !== "" ? ` 备注=${truncate(oneLine(note), 60)}` : ""}`;
    }
    case "provider/switch":
      return `${prefix}${payloadStr(payload, "from_provider")} → ${payloadStr(payload, "to_provider")}`;
    default:
      return `${prefix}${detailOf(payload)}`;
  }
};
