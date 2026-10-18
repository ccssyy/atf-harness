/**
 * 批C1-2 B2——真摘要器（summarize 接同一 provider；faux 仅降级回落）。
 *
 * 单一职责：把 V1CompactionOptions.summarize 注入面接到会话当前 provider/model
 * （不跨会话串模型）：有界输入（丢弃段按水位预算从尾部截取）＋有界输出
 * （resolveSummaryResultCapChars 字符上限）＋超时；任一失败回落 fauxSummarizer 并经
 * onDegrade 零静默通报（调用方接 system_notice「本轮压缩为降级摘要」）。
 * 摘要调用不注入系统提示词外的任何新知识（提示词＝压缩任务本身）。
 */
import type { MutableModels, Model } from "@earendil-works/pi-ai";
import { estimateTokens, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxSummarizer } from "./agentCapabilities.js";
import { resolveSummaryResultCapChars } from "../core/session/constantsBudget.js";

/** 摘要调用超时缺省（ms——独立于主链 provider timeout；超时即降级不阻塞 run）。 */
export const SUMMARIZER_TIMEOUT_MS_DEFAULT = 60_000;

/** 摘要提示词（压缩任务本身；不含任何领域知识注入）。 */
const SUMMARIZER_SYSTEM_PROMPT =
  "你是会话历史压缩器。把给定对话历史压缩为要点摘要：保留任务目标、关键决定、参数与结论；丢弃寒暄与过程性冗余。直接输出摘要正文，不要任何前后缀说明。";

/** 单条消息转摘要输入文本（工具调用/结果截 200 字符——形态保留、载荷收敛）。 */
const messageToText = (message: AgentMessage): string => {
  const role = (message as { role?: string }).role ?? "unknown";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return `${role}: ${content}`;
  if (Array.isArray(content)) {
    const bits = content.map((block) => {
      const b = block as { type?: string; text?: string; name?: string; id?: string };
      if (b.type === "text" && typeof b.text === "string") return b.text.slice(0, 2_000);
      if (b.type === "toolCall") return `[toolCall ${String(b.name)}]`;
      if (b.type === "toolResult" && typeof b.text === "string") return `[toolResult ${b.text.slice(0, 200)}]`;
      if (b.type === "image") return "[image]";
      return `[${String(b.type ?? "block")}]`;
    });
    return `${role}: ${bits.join(" ")}`;
  }
  return `${role}: (非文本载荷)`;
};

/** 有界输入：丢弃段自尾向前按 est tokens 预算截取（保留最新部分；截断如实标注）。 */
export const tailBoundDropped = (dropped: readonly AgentMessage[], tokenBudget: number): { lines: string[]; truncated: boolean } => {
  const budget = tokenBudget > 0 ? tokenBudget : 1;
  const lines: string[] = [];
  let used = 0;
  for (let index = dropped.length - 1; index >= 0; index -= 1) {
    const message = dropped[index] as AgentMessage;
    const cost = estimateTokens(message);
    if (used + cost > budget && lines.length > 0) {
      return { lines, truncated: true };
    }
    used += cost;
    lines.unshift(messageToText(message));
  }
  return { lines, truncated: false };
};

/** 真摘要器装配入参（models/model＝与主链同源装配产物——createProviderStreamFn 返回面）。 */
export interface RealSummarizerDeps {
  models: MutableModels;
  model: Model<"openai-completions">;
  apiKey: string;
  /** 设置面该模型 context_window（B1 单源值；输出上限与溢出判定共用）。 */
  contextWindowTokens: number | null;
  /** 输入预算（est tokens——沿 compaction 水位 compactionTriggerTokens()）。 */
  inputTokenBudget: number;
  timeoutMs?: number;
  /** 降级通报（零静默——调用方接 system_notice）。 */
  onDegrade?: (reason: string) => void;
  /** 成功通报（验收/审计日志面：dropped 条数＋输入 est tokens＋摘要首 200 字）。 */
  onSummary?: (info: { dropped: number; inputTokens: number; summaryHead: string }) => void;
}

/** 单发完成调用面（可注入桩——单测零网络依赖；缺省 models.completeSimple）。 */
export type CompleteFn = (
  context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
  options: { apiKey: string; signal: AbortSignal; maxRetries: number },
) => Promise<{ stopReason: string; content: Array<{ type: string; text?: string }> }>;

const defaultCompleteOf = (deps: RealSummarizerDeps): CompleteFn => async (context, options) =>
  deps.models.completeSimple(deps.model, context, options) as unknown as { stopReason: string; content: Array<{ type: string; text?: string }> };

/**
 * 真摘要器（summarize 注入面实现）：成功＝模型要点摘要（字符上限截断）；失败/超时/空产出
 * ＝回落 fauxSummarizer＋onDegrade（一次通报）。错误细节不外泄进摘要正文。
 */
export const createRealSummarizer = (deps: RealSummarizerDeps, complete?: CompleteFn) => {
  const completeFn = complete ?? defaultCompleteOf(deps);
  const timeoutMs = deps.timeoutMs ?? SUMMARIZER_TIMEOUT_MS_DEFAULT;
  return async (dropped: readonly AgentMessage[]): Promise<string> => {
    try {
      const bounded = tailBoundDropped(dropped, deps.inputTokenBudget);
      const input = `${bounded.truncated ? "（更早部分因长度限制已截断）\n" : ""}${bounded.lines.join("\n")}`;
      const response = await completeFn(
        { systemPrompt: SUMMARIZER_SYSTEM_PROMPT, messages: [{ role: "user", content: input, timestamp: Date.now() }] },
        { apiKey: deps.apiKey, signal: AbortSignal.timeout(timeoutMs), maxRetries: 1 },
      );
      if (response.stopReason === "error") throw new Error("summarize_stop_error");
      const text = response.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("")
        .trim();
      if (text === "") throw new Error("summarize_empty_output");
      const capChars = resolveSummaryResultCapChars(deps.contextWindowTokens);
      const boundedSummary = text.length > capChars ? `${text.slice(0, capChars)}…` : text;
      deps.onSummary?.({
        dropped: dropped.length,
        inputTokens: bounded.lines.join("\n").length >> 1,
        summaryHead: boundedSummary.slice(0, 200),
      });
      return boundedSummary;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      deps.onDegrade?.(reason.slice(0, 120));
      return fauxSummarizer(dropped);
    }
  };
};
