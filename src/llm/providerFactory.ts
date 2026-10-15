/**
 * pi-ai 换库批（门 2，2026-09-23）——provider 装配工厂：config.protocol 的分发单点。
 *
 * 批甲-BUILD T4（旧路径删除）起：自研 codec 直连路径（openai-chat / anthropic-messages →
 * HttpLlmProvider）整体下线，配置层协议闭集同步收窄为 ["pi-ai"]——本工厂成为唯一装配形态
 * （PiAiLlmProvider，库底座）；闭集外的 protocol 到达此处＝防御性 fail-closed throw（配置层
 * 已先行 protocol_unknown 拒绝，此处只为手拼 ResolvedLlmProviderConfig 的越面值兜底）。
 *
 * 红线：本工厂是"protocol → 实现"的唯一裁决点——新装配点一律经本工厂，不直接 new 具体 provider。
 */
import { PiAiLlmProvider } from "./piAiProvider.js";
import { type LlmProvider } from "./provider.js";

/** 装配入参（PiAiLlmProvider 的协议无关子集形态）。 */
export interface CreateLlmProviderOptions {
  config: import("./providerConfig.js").ResolvedLlmProviderConfig;
  tools: import("../core/tools/index.js").ModelVisibleTool[];
  fetchImpl?: typeof fetch;
  systemSuffix?: string;
}

export const createLlmProviderFromConfig = (options: CreateLlmProviderOptions): LlmProvider => {
  if (options.config.protocol !== "pi-ai") {
    // 批甲-BUILD T4：旧自研 codec 路径（openai-chat/anthropic-messages）已删除——fail-closed 不猜
    throw new Error(`protocol=${JSON.stringify(options.config.protocol)} 已随旧自研 codec 路径下线（唯一支持值 "pi-ai"）——请改配 llm 配置 protocol 字段`);
  }
  return new PiAiLlmProvider({
    config: options.config,
    tools: options.tools,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.systemSuffix !== undefined ? { systemSuffix: options.systemSuffix } : {}),
  });
};
