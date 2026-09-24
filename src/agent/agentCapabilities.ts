/**
 * 丙 v1 批 P 增补 §二 B3/B5——compaction（branch-summarization 语义）＋skills/templates
 * 加载（pi skills.js 语义，ATF 技能目录对接）。
 *
 * B3：transformContext 阶段折叠（库 estimateTokens 计量＋turn 起点对齐防切配对；
 * summarizer 注入面——faux 缺省，真实摘要=provider 单点换装）；before_compaction hook 闸。
 * B5：loadSkills（ExecutionEnv 承载，ATF pin 副本 skills 目录）→
 * formatSkillsForSystemPrompt 系统提示 sections；loadPromptTemplates 同源（目录缺失=
 * 空集降级，不阻塞）。
 */
import { EventEmitter } from "node:events";
import {
  BACKGROUND_CONTEXT,
  estimateTokens,
  formatSkillsForSystemPrompt,
  loadPromptTemplates,
  loadSkills,
  type AgentMessage,
  type Context,
  type PromptTemplate,
  type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { V1HookRegistry } from "./hooks.js";

const context: Context = BACKGROUND_CONTEXT;

// ---------------------------------------------------------------- B3 compaction

export interface V1CompactionOptions {
  /** 触发阈值（est tokens；转录总量超过即折叠）。 */
  contextTokenLimit: number;
  /** 折叠后尾部保留目标（est tokens）。 */
  keepRecentTokens: number;
  /** 摘要器注入面（faux 缺省；真实摘要=provider 换装单点——门 2）。 */
  summarize?: (dropped: readonly AgentMessage[]) => Promise<string>;
  /** before_compaction hook 闸（B4 注册面）。 */
  registry?: V1HookRegistry;
}

/** faux 摘要器（B 档 faux 即可——指令 §三.1；不调用任何模型）。 */
export const fauxSummarizer = async (dropped: readonly AgentMessage[]): Promise<string> =>
  `[compaction 折叠摘要（faux）] 已折叠较早的 ${String(dropped.length)} 条消息：本段含早期指令与工具轮，关键结论以最新转录为准。`;

/** cut 点对齐：保留段头部不得是 toolResult（孤儿半边——转录非法），向前吞并至 user/assistant。 */
const alignCut = (messages: readonly AgentMessage[], cut: number): number => {
  let index = Math.max(0, Math.min(cut, messages.length));
  while (index < messages.length && (messages[index] as { role?: string }).role === "toolResult") {
    index += 1;
  }
  return index;
};

export const createCompactionTransform = (opts: V1CompactionOptions) => {
  const summarize = opts.summarize ?? fauxSummarizer;
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const total = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    if (total <= opts.contextTokenLimit) return messages;
    // 尾部保留：从尾累计 tokens 至 keepRecentTokens，cut 对齐 turn 起点（不切 toolResult 半边）
    let kept = 0;
    let cut = messages.length;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      kept += estimateTokens(messages[index] as never);
      cut = index;
      if (kept >= opts.keepRecentTokens) break;
    }
    const alignedCut = alignCut(messages, cut);
    if (alignedCut >= messages.length) return messages; // 全保留（尾部已超预算——不折叠空段）
    const dropped = messages.slice(0, alignedCut);
    await opts.registry?.invoke("before_compaction", { tokens_before: total, dropped: dropped.length });
    const summary = await summarize(dropped);
    const head: AgentMessage = { role: "system", content: summary, timestamp: Date.now() } as AgentMessage;
    return [head, ...messages.slice(alignedCut)];
  };
};

// ---------------------------------------------------------------- B5 skills/templates

const asEnv = (cwd: string): EventEmitter => new NodeExecutionEnv({ cwd }) as unknown as EventEmitter;

/** ATF 技能目录 → 系统提示 suffix（pi skills.js 语义；目录缺失/空 = undefined 装配降级）。 */
export const buildSkillsSystemSuffix = async (skillsRoot: string): Promise<string | undefined> => {
  try {
    const loaded = await loadSkills(asEnv(skillsRoot) as never, skillsRoot, context);
    if (loaded.skills.length === 0) return undefined;
    return formatSkillsForSystemPrompt(loaded.skills as Skill[]);
  } catch {
    return undefined; // 失败降级：无技能常驻（不阻塞 run）
  }
};

/** prompt templates 加载（目录缺失/失败 = 空集降级）。 */
export const loadTemplatesSafe = async (paths: string | string[]): Promise<PromptTemplate[]> => {
  try {
    const list = Array.isArray(paths) ? paths : [paths];
    const loaded = await loadPromptTemplates(asEnv(list[0] ?? ".") as never, list, context);
    return loaded.promptTemplates;
  } catch {
    return [];
  }
};
