/**
 * 前端一（自有 UI · TUI）——审批交互流内化（L1b B8-D1；owner 2026-09-17 裁定）。
 *
 * 形态（B8 起）：**审批请求＝过程流一行式**（与事件流同一渲染路径：随流打印、随流折行、
 * 随流折叠、**永不擦除**）；应答走普通输入行（回显即过程流的一部分）。废除底部弹窗与
 * 一切擦除路径——「擦除/残留」bug 类自架构上消除。
 *
 * 纪律（任务书 §2.2 / ADR-07）：本请求行 = core 问答轨在 UI 的**渲染**，不是新通道——
 * 应答经 ScenarioRunner 的 approvalSurface stub 回调进入既有问答轨编排（approvalTrack），
 * 账本轨仍是唯一真相源；无任何自动应答路径（不提供超时自动放行/自动拒绝；SIGINT = 人
 * 主动中止，落 aborted 留痕）。actor 恒 "tui-operator"（账面标识，登记粒度同 CLI 通道）。
 * 有意不提供 allow_always/reject_always 类选项（CAS 一次性消费语义）。
 */

import type readline from "node:readline";
import { type DiffRenderer } from "./renderer.js";
import { approvalCopyFor, contentDigestPrefix } from "../core/tools/index.js";
import type { ApprovalStubResponse } from "../core/run/index.js";

/** TUI 应答 actor（账面标识；通道只由人触发）。 */
export const TUI_ACTOR = "tui-operator";

export interface ApprovalPromptInput {
  approval_session_id: string;
  tool: string;
  params: unknown;
  approval_key: string;
  /** F5 4.2：内容摘要（脚本类提案引用脚本内容 sha256；卡面附前缀——同路径重写可辨） */
  content_digest?: string;
  attempt: number;
  round: number;
}

/** 应答键位：1/g=放行 granted、2/a=给意见 advised、3/d=拒绝 denied、4/x=中止 abort
 *  （双键位；无 always 类——CAS 一次性消费语义）。 */
const VERDICT_KEYS: Readonly<Record<string, { verdict: "granted" | "advised" | "denied" | "aborted"; label: string }>> = {
  g: { verdict: "granted", label: "放行(granted)" },
  a: { verdict: "advised", label: "给意见(advised)" },
  d: { verdict: "denied", label: "拒绝(denied)" },
  x: { verdict: "aborted", label: "中止(abort)" },
};
const NUMBER_KEYS: Readonly<Record<string, string>> = { "1": "g", "2": "a", "3": "d", "4": "x" };

/** 一行式审批请求行（长内容随流折行/折叠——与事件行同一渲染路径）。
 *  R1 D-4（2026-09-20）：登记了人读文案映射的工具以产品语言呈现（机制词不暴露）；
 *  未登记映射的工具维持既有渲染（零行为变化）。 */
const requestLine = (input: ApprovalPromptInput): string => {
  const copy = approvalCopyFor({ tool: input.tool, params: input.params });
  const subject = copy ?? `${input.tool} 参数=${JSON.stringify(input.params ?? null)}`;
  // F5 4.2：脚本类提案附内容摘要前缀（同路径重写的提案在卡面可辨；缺省＝既有渲染零变化）
  const contentNote = input.content_digest !== undefined ? `｜内容摘要=${contentDigestPrefix(input.content_digest) ?? input.content_digest}` : "";
  return `⛔ 审批请求：${subject} 会话=${input.approval_session_id} 第 ${String(input.attempt)} 次提案 key=${input.approval_key}${contentNote}`;
};

const question = (rl: readline.Interface, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });

/**
 * 过程流一行式请求＋普通输入行应答（ScenarioRunner approvalSurface stub 的 TUI 实现）。
 * 非法输入（未知键位）不落任何事件，以过程流行提示后就地重问；SIGINT = 人主动中止 →
 * aborted 留痕。应答后落审计行（动作/选择/时间戳）。全程零擦除——无残留 bug 类。
 * W1（走查前置止血批 2026-09-20）：advised 且无备注时追问一次意见内容（直接回车＝按
 * 无意见提交，防卡死）；granted/denied/aborted 空备注维持现状；SIGINT 兜底路径不变。
 * A2（L1c 提前批 2026-09-22）：可选 confirmationEcho——写调用与来源确认卡的只读一致性
 * 回显（一致/不一致差异；只提示、不拦截、不改写——拦截归内核闭集校验）。
 */
export const askApproval = async (deps: {
  renderer: DiffRenderer;
  rl: readline.Interface;
  input: ApprovalPromptInput;
  confirmationEcho?: (tool: string, params: unknown) => string | null;
}): Promise<ApprovalStubResponse> => {
  const { renderer, rl, input } = deps;
  rl.resume();
  const echo = deps.confirmationEcho?.(input.tool, input.params) ?? null;
  renderer.appendLine(echo !== null ? `${requestLine(input)} ${echo}` : requestLine(input));
  let triggerSigint: (() => void) = () => undefined;
  const sigintHandler = (): void => triggerSigint();
  rl.on("SIGINT", sigintHandler);
  try {
    for (;;) {
      // SIGINT 下 question 回调可能永不触发——race 由 SIGINT 分支兜底收口；
      // 悬挂的 answerPromise 统一挂 catch，防进程收尾时 unhandled rejection。
      const answerPromise = question(rl, "审批应答（1=放行 2=给意见 3=拒绝 4=中止，可跟备注）> ").catch(() => "");
      const sigintPromise = new Promise<"sigint">((resolve) => {
        triggerSigint = (): void => resolve("sigint");
      });
      const outcome = await Promise.race([answerPromise, sigintPromise]);
      if (outcome === "sigint") {
        const response: ApprovalStubResponse = { verdict: "aborted", actor: TUI_ACTOR, reason: "SIGINT 中止（人主动）" };
        renderer.appendLine(`> 审批留痕 ${new Date().toISOString()} 动作=${input.tool} 选择=中止(abort) 备注=SIGINT 中止（人主动）`);
        return response;
      }
      const text = outcome.trim();
      const normalized = NUMBER_KEYS[text.slice(0, 1).toLowerCase()] ?? text.slice(0, 1).toLowerCase();
      const mapping = VERDICT_KEYS[normalized];
      if (mapping === undefined) {
        renderer.appendLine(`> 无法识别的应答「${text.slice(0, 20)}」——请输入 1/2/3/4 或 g/a/d/x（可跟备注）`);
        continue;
      }
      let note = text.slice(1).trim();
      // W1：advised＋空备注追问一次（一次性，不循环）；追问等待同样受 SIGINT 兜底——
      // 中断即 aborted 留痕；非空文本 → advice_text 透传（现有字段，不变语义），
      // 空（直接回车）→ 按无意见 advised 提交（防卡死）。granted/denied/aborted 不追问。
      if (mapping.verdict === "advised" && note === "") {
        const followUpPromise = question(rl, "请输入意见内容（直接输入文字回车提交；直接回车＝按无意见提交）> ").catch(() => "");
        const followOutcome = await Promise.race([followUpPromise, sigintPromise]);
        if (followOutcome === "sigint") {
          const response: ApprovalStubResponse = { verdict: "aborted", actor: TUI_ACTOR, reason: "SIGINT 中止（人主动）" };
          renderer.appendLine(`> 审批留痕 ${new Date().toISOString()} 动作=${input.tool} 选择=中止(abort) 备注=SIGINT 中止（人主动）`);
          return response;
        }
        note = followOutcome.trim();
      }
      renderer.appendLine(`> 审批留痕 ${new Date().toISOString()} 动作=${input.tool} 选择=${mapping.label}${note !== "" ? ` 备注：${note}` : ""}`);
      return mapping.verdict === "advised"
        ? { verdict: "advised", actor: TUI_ACTOR, ...(note !== "" ? { advice_text: note } : {}) }
        : { verdict: mapping.verdict, actor: TUI_ACTOR, ...(note !== "" ? { reason: note } : {}) };
    }
  } finally {
    rl.removeListener("SIGINT", sigintHandler);
    rl.pause();
  }
};
