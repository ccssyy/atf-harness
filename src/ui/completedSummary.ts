/**
 * 前端一（自有 UI · TUI）——completed turn 产品化摘要（L1c 提前批 A3，2026-09-22；
 * 设计要点 §(三)）。
 *
 * 现状对称缺口：failure 收口有 failure_summary＋collapseLines 六段版式，completed 只有
 * outcome 一行——本模块补齐（轻量三段）。
 *
 * 形态取舍：**轻量三段，不伪造六字段**——六字段是内核人读层的冻结形态，harness 自产同形
 * 表会冒充"内核说"；三段（做了什么／产生了什么／下一步）已覆盖 A3 诉求，且纯由已落盘
 * 事件推导（摘要＝投影非第二真相源，账本轨零新增——turn/end payload 不加字段）。
 * 内核 human 层文本（headline／nextActionOf）**直渲染**（同 notes[] 容忍口径——负向校验
 * 的对象是 harness 拼装的行；内核人读层"禁 code 直出"的守门归内核）。
 *
 * 输入＝BranchRunReport.events（全流）；取末 turn 切片（自末次 turn/start 起）确定性推导。
 * 渲染挂点：tui.ts 终局区 completed 分支（与 collapseLines 同级）。ACP/MCP 不在本批（登记
 * L1c 后续）。
 */
import { type SessionEvent } from "../core/session/index.js";
import { type ToolResultPayload } from "../core/run/index.js";
import { isHumanSummaryShape, nextActionOf } from "./humanSummary.js";

/** 工具动作产品名（呈现层 copy 表；带内核 human_summary.headline 的结果以 headline 代机名）。
 *  批 2.5：导出供 StatusTicker（调用中状态行）复用——单源防双表。 */
export const TOOL_PRODUCT_NAMES: Readonly<Record<string, string>> = {
  atf_workspace_status: "查询工作区状态",
  atf_fact_scan: "事实扫描",
  atf_gate: "查询闸门状态",
  atf_admit_data: "登记数据",
  atf_preparation_propose: "查询准备阶段（模板/待确认项）",
  atf_style_cluster_execute: "执行版式聚类",
  atf_data_admission_request: "发起数据准入申请",
  // 批 3「创作执行面」（2026-09-22）：工作区工具产品名与交接指引（§四）。
  atf_scratch_write: "写入工作区文件",
  atf_scratch_exec: "受控执行脚本",
  atf_skill_read: "读取技能操作定义",
  atf_launch_execute: "放行并启动训练",
};

/** 批 3 §四：工作区工具结果 → 产物行（launch/评估/badcase 交接事实，与内核 human 层并列表述）。 */
const workspaceProductLines = (tool: string, result: Record<string, unknown>): string[] => {
  if (tool === "atf_launch_execute") {
    const state = typeof result["state"] === "string" ? (result["state"] as string) : "unknown";
    const logPath = typeof result["log_path"] === "string" ? (result["log_path"] as string) : "";
    const stateText = state === "started" ? "已启动" : state === "waiting_for_start" ? "等待放行（账本无本配置的放行记录）" : `状态 ${state}`;
    return [`训练启动：${stateText}${logPath !== "" ? `（日志 ${logPath}）` : ""}`];
  }
  if (tool === "atf_scratch_exec" && result["launch_ready"] !== undefined) {
    return ["训练计划就绪（launch.sh 已生成，待放行确认）"];
  }
  if (tool === "atf_skill_read" && typeof result["skill"] === "string") {
    return [`技能定义：${result["skill"] as string}（全文已读）`];
  }
  if (tool === "atf_scratch_write" && typeof result["path"] === "string") {
    return [`工作区文件：${result["path"] as string}`];
  }
  return [];
};

const PLAIN_OBJECT = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type OkToolResultPayload = Extract<ToolResultPayload, { ok: true }>;

const okResults = (turn: readonly SessionEvent[]): OkToolResultPayload[] => {
  const results: OkToolResultPayload[] = [];
  const openCalls = new Map<string, number>();
  for (const event of turn) {
    if (event.type === "tool/call") {
      const tool = (event.payload as { tool?: unknown } | null | undefined)?.tool;
      if (typeof tool === "string") openCalls.set(tool, (openCalls.get(tool) ?? 0) + 1);
      continue;
    }
    if (event.type !== "tool/result") continue;
    const payload = event.payload as ToolResultPayload;
    if (payload.ok !== true) continue;
    const open = openCalls.get(payload.tool) ?? 0;
    if (open === 0) continue; // 无配对 call 的孤儿结果不进摘要（防御；正常流不出现）
    openCalls.set(payload.tool, open - 1);
    results.push(payload);
  }
  return results;
};

const humanSummaryOf = (payload: OkToolResultPayload): unknown =>
  PLAIN_OBJECT(payload.result) ? (payload.result as Record<string, unknown>)["human_summary"] : undefined;

/** completed turn → 过程流行（三段：做了什么／产生了什么／下一步建议；没内容的段不出现）。 */
export const completedSummaryLines = (events: readonly SessionEvent[]): string[] => {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "turn/start") {
      start = i;
      break;
    }
  }
  const turn = events.slice(start);
  const results = okResults(turn);

  // ── 做了什么：逐成功调用聚合（同文案 ×N）；带 headline 的以 headline 代机名 ──
  const didCounts = new Map<string, number>();
  for (const payload of results) {
    const human = humanSummaryOf(payload);
    const headline = isHumanSummaryShape(human) && human.headline !== "" ? human.headline : null;
    const text = headline ?? TOOL_PRODUCT_NAMES[payload.tool] ?? payload.tool;
    didCounts.set(text, (didCounts.get(text) ?? 0) + 1);
  }

  // ── 产生了什么：登记身份／聚类产物／准入判定；无产物则单行说明 ──
  const products: string[] = [];
  for (const payload of results) {
    if (!PLAIN_OBJECT(payload.result)) continue;
    const result = payload.result as Record<string, unknown>;
    if (payload.tool === "atf_admit_data" && typeof result["fact_id"] === "string") {
      products.push(`登记身份：${result["fact_id"] as string}`);
    }
    if (payload.tool === "atf_style_cluster_execute") {
      const ref = typeof result["assignment_ref"] === "string" ? (result["assignment_ref"] as string) : null;
      const count = typeof result["cluster_count"] === "number" ? (result["cluster_count"] as number) : null;
      products.push(`聚类产物：${ref ?? "（产物引用待状态面提供）"}${count !== null ? `（${String(count)} 簇）` : ""}`);
    }
    if (payload.tool === "atf_data_admission_request" && typeof result["status"] === "string") {
      products.push(`准入判定：${result["status"] as string}`);
    }
    products.push(...workspaceProductLines(payload.tool, result));
  }

  // ── 下一步建议：末次内核 human_summary 的「唯一下一动作」；无则该段不出现 ──
  let nextStep: string | null = null;
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const human = humanSummaryOf(results[i] as OkToolResultPayload);
    if (isHumanSummaryShape(human)) {
      nextStep = nextActionOf(human) ?? null;
      if (nextStep !== null) break;
    }
  }
  // 批 3 §四：训练已启动 → 交接指引（评估→badcase 链；内核 human 层缺位时的兜底一行）。
  const launched = results.some((payload) =>
    payload.tool === "atf_launch_execute" && PLAIN_OBJECT(payload.result) &&
    (payload.result as Record<string, unknown>)["state"] === "started");
  if (launched && nextStep === null) {
    nextStep = "训练已启动（长任务）：训练完成后读 atf-evaluate-checkpoints 技能做评估，再读 atf-analyze-badcases 做 badcase 归因（均用 atf_scratch_exec 执行其 scripts）";
  }

  const lines: string[] = [];
  lines.push("──── 本轮小结 ────");
  lines.push("做了什么：");
  if (didCounts.size === 0) {
    lines.push("  · （本 turn 无工具动作）");
  }
  for (const [text, count] of didCounts) {
    lines.push(`  · ${text}${count > 1 ? ` ×${String(count)}` : ""}`);
  }
  lines.push("产生了什么：");
  if (products.length === 0) {
    lines.push("  · 无新产物");
  } else {
    for (const product of products) lines.push(`  · ${product}`);
  }
  if (nextStep !== null) {
    lines.push("下一步建议：");
    lines.push(`  · ${nextStep}`);
  }
  return lines;
};
