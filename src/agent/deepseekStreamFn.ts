/**
 * 门 1a spike（批 P）——DeepSeek streamFn 单点装配（一期 wire 经验复用载体）。
 *
 * 与 src/llm/piAiProvider.ts（一期换库批产物）同源同参的装配面：createModels ＋
 * deepseekProvider compat（DeepSeek wire 规则——工具轮回合 reasoning_content 回传、
 * none 档自动 thinking:disabled——由 pi-ai 内建承接）＋用户配置 baseUrl 覆盖目录缺省
 * （R4 配置保真）。差异仅一处：形状从 completeSimple 换成 streamSimple——pi-agent-core
 * StreamFn 契约（返回 AssistantMessageEventStream）。
 *
 * 红线：本模块只做装配，**从不自行发起网络调用**；只有当 Agent 循环以本 streamFn 运行
 * （且配置携带 api_key）才会触网。门 1a spike 全部路径注入 faux streamFn（零真实调用，
 * 批 P 红线「真实 Provider 调用按需另批」）；切真实调用 = 装配单点换装，门 2 另批。
 *
 * 与 piAiProvider 的模型装配对齐为手工镜像（4 行）：门 2 收口时考虑抽共享单点，
 * 本 spike 不反向改动一期文件（runner 线零接触纪律）。
 */
import { createModels, hasApi, type Model, type MutableModels, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** spike 期 DeepSeek 配置（env-only 凭据；缺省即 faux 期占位，不触网）。 */
export interface DeepSeekStreamFnConfig {
  model: string;
  base_url: string;
  /** 出站 Bearer；env 注入（凭据 env-only 红线），spike 缺省空串＝装配可测、调用必败。 */
  api_key: string;
}

/** 模型描述符装配（与 piAiProvider 构造期同型：目录命中校验 fail-closed ＋ baseUrl 覆盖）。 */
export const assembleDeepSeekModel = (config: DeepSeekStreamFnConfig): { models: MutableModels; model: Model<"openai-completions"> } => {
  const models: MutableModels = createModels();
  models.setProvider(deepseekProvider());
  const catalogModel = models.getModel("deepseek", config.model);
  if (catalogModel === undefined || !hasApi(catalogModel, "openai-completions")) {
    throw new Error(`DeepSeek streamFn 装配失败: pi-ai 目录无 openai-completions 模型 ${JSON.stringify(config.model)}（provider=deepseek；fail-closed）`);
  }
  return { models, model: { ...catalogModel, baseUrl: config.base_url } };
};

/** DeepSeek streamFn（StreamFn 契约＝Models.streamSimple 形）。 */
export const createDeepSeekStreamFn = (config: DeepSeekStreamFnConfig): { streamFn: StreamFn; model: Model<"openai-completions"> } => {
  const { models, model } = assembleDeepSeekModel(config);
  const streamFn: StreamFn = (requestedModel, context, options?: SimpleStreamOptions) =>
    models.streamSimple(requestedModel ?? model, context, {
      ...(config.api_key !== "" ? { apiKey: config.api_key } : {}),
      ...options,
    });
  return { streamFn, model };
};
