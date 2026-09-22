/**
 * 前端一（自有 UI · TUI）——会话事件 → 过程流行（L1 门 2 T02；L1b B6 D1 去硬截断）。
 *
 * 同源纪律：行内容只由 SessionEvent 本体推导（core 投影面投出的已落盘事实），不引入
 * 第二套语义——UI 每行带事件 id 前缀 `#NNNN`，与 append-only 日志逐条对应（smoke:l1ui
 * 两侧比对断言）。origin=history（resume 装载的既有流）加「历史」标记，防与本次进程
 * 新落盘事件混淆。脱敏：本模块只做展示格式化，不新增任何载荷来源。
 *
 * B6 D1：**不再硬截断**——长内容（tool/result 结果、assistant/message 文本、params 等）
 * 全量输出，交给 B3 折行渲染与 D1 折叠（>20 物理行折叠为前 20 行＋按 e 展开）；
 * reason/错误码等机器码字段零漂移（字段名与取值不改，只去长度截断）。
 */

import type { SessionEvent } from "../core/session/index.js";
import type { ProjectionOrigin } from "../core/index.js";
import { type ToolResultPayload } from "../core/run/index.js";
import { engineeringLeak, humanSummaryLines, isHumanSummaryShape } from "./humanSummary.js";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const detailOf = (value: unknown): string => oneLine(JSON.stringify(value) ?? "");

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
      return `${prefix}${oneLine(payloadStr(payload, "text"))}`;
    case "assistant/message":
      return `${prefix}${oneLine(payloadStr(payload, "text"))}`;
    case "assistant/attempt":
      return `${prefix}reason=${payloadStr(payload, "reason") || payloadStr(payload, "code")} ${oneLine(JSON.stringify(payload))}`.trimEnd();
    case "tool/call":
      return `${prefix}${payloadStr(payload, "tool")} 参数=${detailOf((payload as { params?: unknown } | undefined)?.params)}`;
    case "tool/result": {
      const result = payload as ToolResultPayload;
      // D-f：回填附注（nudge 无进展指引／guidance 阻断码文案）随行展示——展示层零新增来源
      const note = (payload as { nudge?: unknown; guidance?: unknown }).nudge ?? (payload as { guidance?: unknown }).guidance;
      const noteText = typeof note === "string" ? ` 指引=${oneLine(note)}` : "";
      if (result.ok) {
        // F6（2026-09-21）：状态面成功结果 → 机器行人读化（已登记 N 批），概览人读行走
        // formatEventDetailLines 附加通道；禁直出工程语（digest/schema 名/snake_case 码）。
        if (result.tool === "atf_workspace_status") {
          return `${prefix}ok=true atf_workspace_status ${oneLine(statusHeadline(result.result))}${noteText}`;
        }
        // K-Gap-2（2026-09-21）：携带六键 human_summary 的成功结果——机器行只留 headline 摘要，
        // 六段人读版式走 formatEventDetailLines 附加行（直渲染内核人读层，不拼工程语言）。
        // B 静默（L1c 提前批 2026-09-22）：headline 命中工程语 → 摘要段整体不出现
        // （机器行只留 ok=true <tool>，不配中性填充语——headline 未过校验的漏洞一并闭合）。
        const human = (result.result as { human_summary?: unknown } | null | undefined)?.human_summary;
        if (isHumanSummaryShape(human)) {
          const headline = engineeringLeak(oneLine(human.headline)) ? "" : ` ${oneLine(human.headline)}`;
          return `${prefix}ok=true ${result.tool}${headline}${noteText}`;
        }
        return `${prefix}ok=true ${result.tool} 结果=${detailOf(result.result)}${noteText}`;
      }
      const blockReason = result.block?.reason;
      return `${prefix}ok=false ${result.tool} 原因=${result.reason}${blockReason !== undefined ? `(${blockReason})` : ""}${result.reason === "failed" && result.detail !== undefined ? ` 明细=${detailOf(result.detail)}` : ""}${noteText}`;
    }
    case "approval/request":
      return `${prefix}session=${payloadStr(payload, "approval_session_id")} attempt=${payloadStr(payload, "attempt")} tool=${payloadStr(payload, "tool")}${payloadStr(payload, "supersedes") !== "" ? " supersedes" : ""}`;
    case "approval/response": {
      const advice = payloadStr(payload, "advice_text");
      const reason = payloadStr(payload, "reason");
      const note = advice !== "" ? advice : reason;
      return `${prefix}verdict=${payloadStr(payload, "verdict")} actor=${payloadStr(payload, "actor")}${note !== "" ? ` 备注=${oneLine(note)}` : ""}`;
    }
    case "provider/switch":
      return `${prefix}${payloadStr(payload, "from_provider")} → ${payloadStr(payload, "to_provider")}`;
    default:
      return `${prefix}${detailOf(payload)}`;
  }
};

// ---------------------------------------------------------------------------
// F6 harness 侧小批（2026-09-21）：状态面（atf_workspace_status）人读渲染
// ---------------------------------------------------------------------------

const PLAIN_OBJECT = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);


/** 保守工程语泄漏静默滤除（B 口径，L1c 提前批 2026-09-22）——判据即 humanSummary.engineeringLeak
 *  （单一函数）；命中行对用户整体静默（不显示、不解释、不指路；原"已收起"降级文案删除；
 *  事实日志审计不受影响）。 */
const safeLine = (line: string): string | null => (engineeringLeak(line) ? null : line);

/** 状态面机器行标题（已登记 N 批；N 取 admitted_count，缺省不给数）。 */
export const statusHeadline = (result: unknown): string => {
  const count = PLAIN_OBJECT(result) && typeof result["admitted_count"] === "number" ? (result["admitted_count"] as number) : undefined;
  return count !== undefined ? `已登记 ${String(count)} 批` : "工作区状态查询完成";
};

/** 状态面概览 → 人读行（禁直出工程语；命中即整行降级为中性提示）：
 *  优先内核 human_summary（结论/分组/待确认，人读层直渲染）；否则按 datasets[] 逐批人读行
 *  （登记身份＋形态摘要＋登记时间——用户所需标识与人读文本）；两者皆无 → 单行人读现状。 */
export const statusOverviewLines = (result: unknown): string[] => {
  if (!PLAIN_OBJECT(result)) return [];
  const lines: string[] = [];
  const push = (line: string | null): void => {
    if (line !== null) lines.push(line);
  };
  const human = result["human_summary"];
  if (PLAIN_OBJECT(human)) {
    push(typeof human["headline"] === "string" && human["headline"] !== "" ? `结论：${human["headline"]}` : null);
    for (const section of Array.isArray(human["sections"]) ? (human["sections"] as unknown[]) : []) {
      if (!PLAIN_OBJECT(section)) continue;
      if (typeof section["title"] === "string") push(`· ${section["title"]}`);
      for (const item of Array.isArray(section["items"]) ? (section["items"] as unknown[]) : []) {
        if (typeof item === "string") push(`    ${item}`);
      }
    }
    for (const pending of Array.isArray(human["pending_confirmations"]) ? (human["pending_confirmations"] as unknown[]) : []) {
      if (!PLAIN_OBJECT(pending)) continue;
      if (typeof pending["title"] === "string") push(`? ${pending["title"]}`);
      if (typeof pending["detail"] === "string") push(`    ${pending["detail"]}`);
    }
  } else if (Array.isArray(result["datasets"]) && (result["datasets"] as unknown[]).length > 0) {
    for (const entry of result["datasets"] as unknown[]) {
      if (!PLAIN_OBJECT(entry)) continue;
      const id = typeof entry["fact_id"] === "string" ? (entry["fact_id"] as string) : typeof entry["dataset_id"] === "string" ? (entry["dataset_id"] as string) : "（未具名登记）";
      const shape = typeof entry["shape_summary"] === "string" ? (entry["shape_summary"] as string) : typeof entry["summary"] === "string" ? (entry["summary"] as string) : "";
      const at = typeof entry["registered_at"] === "string" ? `（登记于 ${entry["registered_at"] as string}）` : "";
      push(`· ${id}${shape !== "" ? `：${shape}` : ""}${at}`);
    }
  } else {
    const count = typeof result["admitted_count"] === "number" ? (result["admitted_count"] as number) : 0;
    push(count > 0 ? `已登记 ${String(count)} 批（形态摘要待状态面提供）` : "工作区暂无已登记数据集");
  }
  return lines.map(safeLine).filter((line): line is string => line !== null);
};

/** F6：状态面人读行的多行附加渲染（tool/result 成功且 tool=atf_workspace_status）。
 *  每行带同事件 id 前缀（smoke:l1ui 的 id 集合断言保持全等）。
 *  机制说明：与接线批（fdf3555）formatEventDetailLines 同款通道，main 侧由本批引入；
 *  接线批 rebase 时两版合并（其版含 humanSummary 六键嗅探，本版限状态面）。 */
/** 人读投影多行附加渲染（并集版，K-Gap-2 接线批 rebase 合并 2026-09-21）：
 *  - atf_workspace_status → 状态面概览人读行（statusOverviewLines，禁直出工程语）；
 *  - 其余工具 ok 且携带六键 human_summary → 六段人读版式（humanSummaryLines，主叙述过负向校验）。
 *  每行带同事件 id 前缀（smoke:l1ui 的 id 集合断言保持全等）。 */
export const formatEventDetailLines = (event: SessionEvent): string[] => {
  if (event.type !== "tool/result") return [];
  const result = event.payload as ToolResultPayload;
  if (!result.ok) return [];
  const idPrefix = `#${String(event.id).padStart(4, "0")} `;
  if (result.tool === "atf_workspace_status") {
    return statusOverviewLines(result.result).map((line) => `${idPrefix}${line}`);
  }
  const human = (result.result as { human_summary?: unknown } | null | undefined)?.human_summary;
  if (!isHumanSummaryShape(human)) return [];
  return humanSummaryLines(human).map((line) => `${idPrefix}${line}`);
};
