/**
 * 前端一（自有 UI · TUI）——审批弹窗（L1 门 2 T02，VERIFY 验收项 1「人在同一界面放行」）。
 *
 * 纪律（任务书 §2.2 / ADR-07）：本弹窗 = core 问答轨在 UI 的**渲染**，不是新通道——
 * 应答经 ScenarioRunner 的 approvalSurface stub 回调进入既有问答轨编排（approvalTrack），
 * 账本轨仍是唯一真相源；无任何自动应答路径（不提供超时自动放行/自动拒绝；SIGINT = 人
 * 主动中止，落 aborted 留痕）。actor 恒 "tui-operator"（账面标识，登记粒度同 CLI 通道）。
 */

import type readline from "node:readline";
import { type DiffRenderer } from "./renderer.js";
import type { ApprovalStubResponse } from "../core/run/index.js";

/** TUI 应答 actor（账面标识；通道只由人触发）。 */
export const TUI_ACTOR = "tui-operator";

export interface ApprovalPromptInput {
  approval_session_id: string;
  tool: string;
  params: unknown;
  approval_key: string;
  attempt: number;
  round: number;
}

/** 弹窗键位：g=放行 granted / a=给意见 advised / d=拒绝 denied / x=中止 abort。
 *  有意不提供 allow_always/reject_always 类选项（无配额复用，CAS 一次性消费语义）。 */
const VERDICT_KEYS: Readonly<Record<string, { verdict: "granted" | "advised" | "denied" | "aborted"; label: string }>> = {
  g: { verdict: "granted", label: "放行(granted)" },
  a: { verdict: "advised", label: "给意见(advised)" },
  d: { verdict: "denied", label: "拒绝(denied)" },
  x: { verdict: "aborted", label: "中止(abort)" },
};

const dialogLines = (input: ApprovalPromptInput, hint?: string): string[] => {
  const params = JSON.stringify(input.params ?? null);
  return [
    "╔══ 审批请求 · 账本轨未命中 → 问答轨（本弹窗仅为问答轨渲染，非新通道）",
    `║ tool:    ${input.tool}`,
    `║ session: ${input.approval_session_id}   attempt: ${String(input.attempt)}   key: ${input.approval_key}`,
    `║ params:  ${params.length > 200 ? `${params.slice(0, 200)}…` : params}`,
    "║ 应答：g=放行  a=给意见  d=拒绝  x=中止（格式：<字母> [备注]，如：g 同意准入）",
    ...(hint !== undefined ? [`║ ↑ ${hint}`] : []),
    "╚══ 等待人工应答…",
  ];
};

const question = (rl: readline.Interface, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });

/**
 * 渲染弹窗并等待人工应答（ScenarioRunner approvalSurface stub 的 TUI 实现）。
 * 非法输入（未知字母）不落任何事件，就地重问；SIGINT = 人主动中止 → aborted 留痕。
 */
export const askApproval = async (deps: {
  renderer: DiffRenderer;
  rl: readline.Interface;
  input: ApprovalPromptInput;
}): Promise<ApprovalStubResponse> => {
  const { renderer, rl, input } = deps;
  rl.resume();
  let hint: string | undefined;
  let triggerSigint: (() => void) = () => undefined;
  const sigintHandler = (): void => triggerSigint();
  rl.on("SIGINT", sigintHandler);
  try {
    for (;;) {
      renderer.setStatus(dialogLines(input, hint));
      // SIGINT 下 question 回调可能永不触发——race 由 SIGINT 分支兜底收口；
      // 悬挂的 answerPromise 统一挂 catch，防进程收尾时 unhandled rejection。
      const answerPromise = question(rl, "审批应答> ").catch(() => "");
      const sigintPromise = new Promise<"sigint">((resolve) => {
        triggerSigint = (): void => resolve("sigint");
      });
      const outcome = await Promise.race([answerPromise, sigintPromise]);
      if (outcome === "sigint") {
        return { verdict: "aborted", actor: TUI_ACTOR, reason: "SIGINT 中止（人主动）" };
      }
      const text = outcome.trim();
      const mapping = VERDICT_KEYS[text.slice(0, 1).toLowerCase()];
      if (mapping === undefined) {
        hint = `无法识别的应答「${text.slice(0, 20)}」——请输入 g / a / d / x（可跟备注）`;
        continue;
      }
      const note = text.slice(1).trim();
      renderer.appendLine(`> 已提交应答：${mapping.label}${note !== "" ? ` 备注：${note}` : ""}`);
      return mapping.verdict === "advised"
        ? { verdict: "advised", actor: TUI_ACTOR, ...(note !== "" ? { advice_text: note } : {}) }
        : { verdict: mapping.verdict, actor: TUI_ACTOR, ...(note !== "" ? { reason: note } : {}) };
    }
  } finally {
    rl.removeListener("SIGINT", sigintHandler);
    rl.pause();
  }
};
