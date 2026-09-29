/**
 * 批⑬ v2（2026-09-29，指令 ed9206c4）——WebUI 对话流模型（第四宿主：与 TUI/ACP/MCP 平级）。
 *
 * 消息组件闭集（7 种，指令 §一）：user／agent_text／plan_card／tool_card／confirm_card／
 * danger_confirm／system_notice。本模块＝类型＋纯函数渲染器（渲染快照可测——前端直接消费
 * 渲染树，展示层零第二权威）。
 */
import type { ContractConfirmationReport } from "../core/confirmRequest.js";

/** 消息组件闭集（kind 判别）。 */
export type ChatEvent =
  | { seq: number; kind: "user"; text: string; at: string }
  | { seq: number; kind: "agent_text"; text: string; at: string }
  | {
      seq: number;
      kind: "plan_card";
      title: string;
      /** checklist 逐行：label＋三态（done=✅/running=🔄/pending=⏸） */
      items: Array<{ label: string; state: "done" | "running" | "pending" }>;
      at: string;
    }
  | {
      seq: number;
      kind: "tool_card";
      tool: string;
      running: boolean;
      params: Record<string, unknown>;
      /** 进度 0-100（可汇报进度的工具；undefined＝不渲染进度条） */
      progress?: number;
      resultSummary?: string;
      at: string;
    }
  | {
      seq: number;
      kind: "confirm_card";
      /** 配置确认（九要素）或审批确认（审批卡） */
      cardType: "config_confirm" | "approval";
      title: string;
      /** 逐项行：键＝等宽、值、右侧三态标签 */
      fields: Array<{
        key: string;
        value: string;
        tag: "need_confirm" | "from_registry" | "default_used" | "done" | "waiting_window";
      }>;
      /** 点卡双按钮（[确认并继续][逐项修改…]）＋提示"也可直接回复如『lr 改 2e-4』" */
      pending: boolean;
      /** 审批卡（ask_user_for_input F5 报告投影）时携带 */
      confirmReport?: ContractConfirmationReport;
      candidateDigest?: string;
      answered?: { verdict: "confirmed" | "edited" | "denied"; edits?: Record<string, string>; via: "button" | "text"; at: string };
      at: string;
    }
  | {
      seq: number;
      kind: "danger_confirm";
      title: string;
      /** 代价显性化（改进④）：GPU 卡数/预计时长 */
      gpuCount: number;
      estimate: string;
      command: string;
      pending: boolean;
      answered?: { verdict: "confirmed" | "denied"; via: "button" | "text"; at: string };
      at: string;
    }
  | { seq: number; kind: "system_notice"; level: "info" | "warn" | "error"; text: string; at: string };

/** 三态标签中文名（渲染单源）。 */
export const FIELD_TAG_LABELS: Record<string, string> = {
  need_confirm: "需确认",
  from_registry: "来自登记",
  default_used: "已用缺省⚠",
  done: "已完成",
  waiting_window: "等窗口",
};

const esc = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const fieldTagHtml = (tag: string): string => {
  const label = FIELD_TAG_LABELS[tag] ?? tag;
  const cls = tag === "default_used" ? "tag-default" : tag === "done" ? "tag-done" : tag === "waiting_window" ? "tag-window" : "tag-confirm";
  return `<span class="tag ${cls}">${esc(label)}</span>`;
};

/** 单条消息 → 渲染树（HTML 片段；纯函数——渲染快照锚直接断言本输出）。 */
export const renderChatEvent = (event: ChatEvent): string => {
  switch (event.kind) {
    case "user":
      return `<div class="msg user"><div class="bubble">${esc(event.text)}</div></div>`;
    case "agent_text":
      return `<div class="msg agent_text"><div class="text">${esc(event.text)}</div></div>`;
    case "plan_card": {
      const items = event.items
        .map((item) => {
          const mark = item.state === "done" ? "✅" : item.state === "running" ? "🔄" : "⏸";
          return `<div class="plan-item state-${item.state}">${mark} ${esc(item.label)}</div>`;
        })
        .join("");
      return `<div class="msg plan_card"><div class="card-title">${esc(event.title)}</div><div class="plan-items">${items}</div></div>`;
    }
    case "tool_card": {
      const progress =
        event.progress === undefined
          ? ""
          : `<div class="progress"><div class="bar" style="width:${String(Math.min(100, Math.max(0, event.progress)))}%"></div></div>`;
      const badge = event.running ? `<span class="badge running">运行中</span>` : `<span class="badge done-badge">完成</span>`;
      const result = event.resultSummary !== undefined ? `<div class="result">${esc(event.resultSummary)}</div>` : "";
      return (
        `<div class="msg tool_card"><div class="card-title">⚙ tool: ${esc(event.tool)} ${badge}</div>` +
        `<pre class="params">${esc(JSON.stringify(event.params, null, 1))}</pre>${progress}${result}</div>`
      );
    }
    case "confirm_card": {
      const answered = event.answered
        ? `<div class="answered">已应答：${esc(event.answered.verdict)}（via ${esc(event.answered.via)}）</div>`
        : event.pending
          ? `<div class="actions"><button class="btn primary" data-action="confirm">确认并继续</button><button class="btn" data-action="edit">逐项修改…</button></div><div class="hint">也可直接回复如『lr 改 2e-4』</div>`
          : "";
      const rows = event.fields
        .map((f) => `<div class="field-row"><span class="key">${esc(f.key)}</span><span class="value">${esc(f.value)}</span>${fieldTagHtml(f.tag)}</div>`)
        .join("");
      const report =
        event.confirmReport === undefined
          ? ""
          : `<div class="confirm-report">Prompt 实文 ${String(event.confirmReport.prompt_texts.length)} 份｜字段序 ${String(event.confirmReport.field_ids.length)} 项｜坐标策略 ${esc(event.confirmReport.coordinate_policy)}</div>`;
      const pauseBadge = event.pending ? `<span class="badge pause">⏸ 需要你确认</span>` : "";
      return (
        `<div class="msg confirm_card amber"><div class="card-title">${esc(event.title)} ${pauseBadge}</div>` +
        report +
        `<div class="fields">${rows}</div>${answered}</div>`
      );
    }
    case "danger_confirm": {
      const answered = event.answered ? `<div class="answered">已应答：${esc(event.answered.verdict)}</div>` : "";
      const button =
        event.pending && !event.answered
          ? `<button class="btn danger" data-action="danger-confirm">确认真实训练 · GPU ${String(event.gpuCount)} 卡 · 预计 ${esc(event.estimate)}</button><button class="btn" data-action="danger-deny">暂不启动</button>`
          : "";
      return (
        `<div class="msg danger_confirm"><div class="card-title">${esc(event.title)}</div>` +
        `<pre class="params">${esc(event.command)}</pre><div class="cost">GPU ${String(event.gpuCount)} 卡 · 预计 ${esc(event.estimate)}</div>${button}${answered}</div>`
      );
    }
    case "system_notice":
      return `<div class="msg system_notice level-${event.level}">${esc(event.text)}</div>`;
  }
};

/** 事件列表 → 整页对话流 HTML（渲染快照锚断言本输出）。 */
export const renderChatHtml = (events: readonly ChatEvent[]): string =>
  events.map((event) => renderChatEvent(event)).join("\n");
