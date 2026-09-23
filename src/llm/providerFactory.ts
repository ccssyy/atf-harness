/**
 * pi-ai 换库批（门 2，2026-09-23）——provider 装配工厂：config.protocol 的分发单点。
 *
 * feature flag 语义（指令 §3.5）：llm.json 的 providers.<别名>.protocol = "pi-ai" →
 * PiAiLlmProvider（库底座）；其余（openai-chat / anthropic-messages）→ HttpLlmProvider
 * （自研 codec 直连，既有行为逐位不变）。缺省走旧路径（回归安全）；flag 只影响 LLM 接入段，
 * 模型面契约/会话流/审批账本零感知。
 *
 * 红线：本工厂是"protocol → 实现"的唯一裁决点——codec 注册面（getCodec）对 "pi-ai" 显式
 * 拒绝，防止 HttpLlmProvider 误路由；新装配点一律经本工厂，不直接 new 具体 provider。
 */
import { HttpLlmProvider, type HttpLlmProviderOptions } from "./httpProvider.js";
import { PiAiLlmProvider } from "./piAiProvider.js";
import { type LlmProvider } from "./provider.js";

/** 两类 provider 共有的装配入参（HttpLlmProviderOptions 的协议无关子集）。 */
export interface CreateLlmProviderOptions {
  config: HttpLlmProviderOptions["config"];
  tools: HttpLlmProviderOptions["tools"];
  fetchImpl?: typeof fetch;
  systemSuffix?: string;
}

export const createLlmProviderFromConfig = (options: CreateLlmProviderOptions): LlmProvider => {
  if (options.config.protocol === "pi-ai") {
    return new PiAiLlmProvider({
      config: options.config,
      tools: options.tools,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.systemSuffix !== undefined ? { systemSuffix: options.systemSuffix } : {}),
    });
  }
  return new HttpLlmProvider(options);
};
