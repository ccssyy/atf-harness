/**
 * 门 1b（批 P）——TEM 读闸：检索注入 PoC（transform_context hook，关键词匹配，embedding
 * 后置）。
 *
 * 设计依据：《ATF-Harness_门1b设计_TEM到pi存储映射_20260924.md》§三＋《ATF-TEM_接入设计
 * 双消费者_20260914》§3.2/§3.3（阈值＋配额；注入条目带来源引用；structural_preconditions
 * 不折叠；失败 = 无记忆运行）。库语义实证：transformContext 返回值只喂本请求的
 * convertToLlm，不入转录——天然"可压缩注入条目"，免重复注入。
 */
import type { AfterToolCallContext, AfterToolCallResult, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  buildEvidenceEvent,
  mirrorEvidenceEvent,
  scanEvidenceEvents,
  type EvidenceEvent,
} from "./evidence.js";
import { queryMechanisms } from "./store.js";
import type { SessionLike } from "../sessionMirror.js";

/** 注入配额（§3.2：阈值＋配额；阈值 = score ≥ 1，配额 = top N）。 */
export const TEM_INJECTION_QUOTA = 3;

// ---------------------------------------------------------------- after_tool 镜像 hook

export interface TemMirrorDeps {
  session: SessionLike;
  /** run 标识（取时函数——status 面 scope_ref.scope_id 捕获后即得；未捕获 = null——fail-诚实）。 */
  runId: () => string | null;
  model: string;
  /** 镜像失败观察缝（stderr/测试断言；不反压主链）。 */
  onMirrorFailure?: (tool: string) => void;
}

const gateOf = (toolName: string, args: unknown): string | undefined => {
  if (toolName !== "atf_gate") return undefined;
  if (typeof args === "object" && args !== null && typeof (args as { gate?: unknown }).gate === "string") {
    return (args as { gate: string }).gate;
  }
  return undefined;
};

/** after_tool 镜像 hook 工厂（Agent afterToolCall 直用；返回 undefined = 不改写工具结果）。 */
export const createTemAfterToolMirror =
  (deps: TemMirrorDeps) =>
  async (toolContext: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const event = buildEvidenceEvent({
      correlationId: toolContext.toolCall.id,
      runId: deps.runId(),
      tool: toolContext.toolCall.name,
      ok: !toolContext.isError,
      params: toolContext.args,
      result: toolContext.result?.details,
      model: deps.model,
      gate: gateOf(toolContext.toolCall.name, toolContext.args),
    });
    const mirrored = await mirrorEvidenceEvent(deps.session, event);
    if (mirrored === null) deps.onMirrorFailure?.(event.tool);
    return undefined; // 镜像只读旁路——不改写工具结果
  };

// ---------------------------------------------------------------- 查询信号与打分

/** 词元化：小写、按非字母数字切分、去重、滤长短元（≥2 chars）。 */
export const tokenize = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((token) => token.length >= 2),
  ),
];

export interface TemQuerySignals {
  terms: string[];
  gate?: string;
}

/** 查询信号提取：最近 atf_gate 调用的 gate 值＋近期工具名/用户指令词元（gate/phase 锚）。 */
export const extractQuerySignals = (messages: readonly AgentMessage[]): TemQuerySignals => {
  const terms = new Set<string>();
  let gate: string | undefined;
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === "user") {
      const content = (message as { content?: unknown }).content;
      const text = typeof content === "string" ? content : "";
      for (const token of tokenize(text)) terms.add(token);
      continue;
    }
    if (role === "assistant") {
      for (const block of (message as AssistantMessage).content ?? []) {
        if (block.type !== "toolCall") continue;
        terms.add(block.name.toLowerCase());
        if (block.name === "atf_gate") {
          const gateValue = (block.arguments as { gate?: unknown } | undefined)?.gate;
          if (typeof gateValue === "string" && gateValue !== "") {
            gate = gateValue;
            terms.add(gateValue.toLowerCase());
          }
        }
      }
    }
  }
  return { terms: [...terms], ...(gate !== undefined ? { gate } : {}) };
};

export interface ScoredEvidence {
  event: EvidenceEvent;
  score: number;
}

/** EvidenceEvent 关键词打分：查询词元 ∩ {tool, gate, result_summary}；阈值 score ≥ 1。 */
export const scoreEvidence = (event: EvidenceEvent, signals: TemQuerySignals): number => {
  const haystack = [event.tool, event.gate ?? "", event.result_summary, event.fact_ref?.journal_type ?? ""]
    .join(" ")
    .toLowerCase();
  return signals.terms.filter((term) => haystack.includes(term)).length;
};

/** 检索：EvidenceEvent 打分取 top-N ＋ Mechanism 缝（faux）结果合并（引用各带前缀）。 */
export const retrieveTemEntries = async (
  session: SessionLike,
  signals: TemQuerySignals,
): Promise<{ evidence: ScoredEvidence[]; claims: Awaited<ReturnType<typeof queryMechanisms>> }> => {
  const [events, claims] = await Promise.all([
    scanEvidenceEvents(session).then((events) =>
      events
        .map((event) => ({ event, score: scoreEvidence(event, signals) }))
        .filter((scored) => scored.score >= 1)
        .sort((a, b) => b.score - a.score)
        .slice(0, TEM_INJECTION_QUOTA),
    ),
    queryMechanisms(session, { terms: signals.terms, ...(signals.gate !== undefined ? { gate: signals.gate } : {}) }).then((scored) =>
      scored.slice(0, TEM_INJECTION_QUOTA),
    ),
  ]);
  return { evidence: events, claims };
};

// ---------------------------------------------------------------- 注入形态

export const TEM_SECTION_HEADER = "[TEM 经验注入（投影层临时条目，来源可追溯；引用链不折叠）]";

/** 构建注入 section 文本（来源引用 [tem:<id>]；structural_preconditions 打不折叠标）。 */
export const buildTemSection = (retrieved: { evidence: ScoredEvidence[]; claims: Awaited<ReturnType<typeof queryMechanisms>> }): string | null => {
  const lines: string[] = [TEM_SECTION_HEADER];
  for (const { event, score } of retrieved.evidence) {
    lines.push(
      `- [tem:${event.event_id}] 工具 ${event.tool}${event.gate !== undefined ? `（gate=${event.gate}）` : ""}${event.ok ? "成功" : "失败"}（匹配度 ${String(score)}）：${event.result_summary}`,
    );
  }
  for (const { item, score } of retrieved.claims) {
    const preconditions = item.structural_preconditions ?? [];
    lines.push(
      `- [tem:${item.claim_id}] 经验${preconditions.length > 0 ? "（structural_preconditions，不折叠）" : ""}（匹配度 ${String(score)}）：${item.claim}`,
    );
  }
  return lines.length > 1 ? lines.join("\n") : null;
};

/**
 * transform_context hook 工厂（Agent transformContext 直用）：检索→注入 SystemMessage；
 * 检索失败/空 = 原样返回（无记忆运行，不阻塞）。
 */
export const createTemTransformContext =
  (deps: { session: SessionLike }) =>
  async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    try {
      const signals = extractQuerySignals(messages);
      if (signals.terms.length === 0) return messages;
      const retrieved = await retrieveTemEntries(deps.session, signals);
      const section = buildTemSection(retrieved);
      if (section === null) return messages;
      return [...messages, { role: "system", content: section, timestamp: Date.now() } as AgentMessage];
    } catch {
      return messages; // 失败语义：无记忆运行（§3.2——记忆是增强而非依赖）
    }
  };
