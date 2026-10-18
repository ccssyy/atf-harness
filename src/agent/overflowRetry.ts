/**
 * 批C1-2 B2——上下文溢出兜底（强制压缩一次＋自动重试该轮；可读文案收口）。
 *
 * 溢出判定双路：①pi-ai 权威 isContextOverflow（assistant 消息 stopReason=error 的
 * provider 模式闭集＋静默溢出 usage 判定）；②抛错路径匹配 vendor canonical 码
 * CONTEXT_WINDOW_EXCEEDED（值＝'CONTEXT_WINDOW_EXCEEDED'，vendor llm/src/error.ts 单源——
 * 本仓不引 vendor 包，字面同步并留注释锚）。重试语义：捕获溢出 → forceBox 置位
 * （下一轮 transformContext 强制压缩）→ 同 instruction 重跑一次；重试成功用户无感；
 * 两次都溢出才回调 onFinalFailure（可读文案——原始错误码/红条不得直出）。
 */
import { isContextOverflow } from "@earendil-works/pi-ai";

/** vendor canonical 溢出码（CONTEXT_WINDOW_EXCEEDED_CODE——vendor llm/src/error.ts:25 同值字面同步）。 */
export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";

/** 抛错路径溢出判定：vendor 码＋各 provider 高频模式（与 pi-ai OVERFLOW_PATTERNS 核心子集同型）。 */
const OVERFLOW_THROW_PATTERNS: readonly RegExp[] = [
  /CONTEXT_WINDOW_EXCEEDED/i,
  /prompt (?:is )?too long/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /exceeds the context window/i,
  /maximum context length/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

export const isOverflowErrorMessage = (message: string): boolean =>
  OVERFLOW_THROW_PATTERNS.some((pattern) => pattern.test(message));

/** assistant 消息溢出判定（pi-ai 权威；contextWindow 在场时含静默溢出路径）。 */
export const isOverflowAssistantMessage = (message: unknown, contextWindowTokens: number | null): boolean => {
  if (message === null || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return false;
  try {
    return contextWindowTokens === null
      ? isContextOverflow(message as never)
      : isContextOverflow(message as never, contextWindowTokens);
  } catch {
    return false;
  }
};

/** 溢出兜底可读文案（两次都超限才出——原始码/红条不得直出）。 */
export const OVERFLOW_FINAL_NOTICE_TEXT =
  "本轮上下文过长，已自动压缩后重试仍超限——请新建会话（或缩小本轮输入/附件）后再试。";

/** 重试轮摘要的结构面（Agent 最小面——结构化类型，不引库泛型）。 */
interface PromptAgent {
  prompt: (instruction: string) => Promise<unknown>;
  state: { messages: unknown[] };
}

export interface OverflowRetryOutcome {
  kind: "ok" | "overflow_final" | "error";
  error?: string;
}

const lastAssistantOf = (agent: PromptAgent): unknown => {
  for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.state.messages[index];
    if (message !== null && typeof message === "object" && (message as { role?: string }).role === "assistant") return message;
  }
  return null;
};

const endsWithOverflow = (agent: PromptAgent, contextWindowTokens: number | null): boolean =>
  isOverflowAssistantMessage(lastAssistantOf(agent), contextWindowTokens);

/**
 * 溢出兜底 prompt（一次强制压缩重试）：
 * 首轮溢出（抛错或 error assistant）→ forceBox.current=true → 同 instruction 重跑一次；
 * 重试成功＝kind:"ok"（用户无感）；两轮皆溢出＝kind:"overflow_final"（调用方出可读文案）；
 * 非溢出异常原样上抛（kind:"error" 不吞既有错误面）。
 */
export const promptWithOverflowRetry = async (
  agent: PromptAgent,
  instruction: string,
  opts: {
    forceBox: { current: boolean };
    contextWindowTokens: number | null;
    /** 首轮溢出通报（可选——重试成功则调用方不应发用户可见提示）。 */
    onOverflowRetry?: () => void;
  },
): Promise<OverflowRetryOutcome> => {
  let overflowed = false;
  try {
    await agent.prompt(instruction);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!isOverflowErrorMessage(message)) {
      return { kind: "error", error: message };
    }
    overflowed = true;
  }
  if (!overflowed && !endsWithOverflow(agent, opts.contextWindowTokens)) return { kind: "ok" };
  // 溢出 → 强制压缩一次并自动重试该轮（重试成功用户无感）
  opts.onOverflowRetry?.();
  opts.forceBox.current = true;
  try {
    await agent.prompt(instruction);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!isOverflowErrorMessage(message)) {
      return { kind: "error", error: message };
    }
    return { kind: "overflow_final" };
  }
  return endsWithOverflow(agent, opts.contextWindowTokens) ? { kind: "overflow_final" } : { kind: "ok" };
};
