/**
 * 丙 v1（批 P 增补 §一，指令 56170242）——pi-ai streamFn 装配单点（一期 wire 经验复用
 * 载体，provider 目录参数化）。
 *
 * 与 runner 线 PiAiLlmProvider 同源同参的装配面：createModels ＋ piaiProviderFactory
 * （按 provider_id 查目录——zai-coding-cn/deepseek/后续 provider 同一路径，未知 id
 * fail-closed；_compat 地板在 resolveReasoningArg 侧生效，见 piAiProviders）＋用户配置
 * baseUrl 覆盖目录缺省（R4 配置保真）。差异仅一处：形状从 completeSimple 换成
 * streamSimple——pi-agent-core StreamFn 契约（返回 AssistantMessageEventStream）。
 *
 * 红线：本模块只做装配，**从不自行发起网络调用**；只有当 Agent 循环以本 streamFn 运行
 * （且配置携带 api_key）才会触网。真实调用须 owner 另批授权（CLI 侧双门控承载）。
 */
import {
  createModels,
  hasApi,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { piaiProviderFactory } from "../llm/piaiProviders.js";

/** 丙线真实调用配置（env-only 凭据；provider_id 参数化——GLM/DeepSeek 同路径）。 */
export interface ProviderStreamFnConfig {
  provider_id: string;
  model: string;
  base_url: string;
  /** 出站 Bearer；env 注入（凭据 env-only 红线）。 */
  api_key: string;
}

/** 模型描述符装配（与 PiAiLlmProvider 构造期同型：目录命中校验 fail-closed ＋ baseUrl 覆盖）。 */
export const assembleProviderModel = (
  config: ProviderStreamFnConfig,
): { models: MutableModels; model: Model<"openai-completions"> } => {
  const models: MutableModels = createModels();
  models.setProvider(piaiProviderFactory(config.provider_id));
  const catalogModel = models.getModel(config.provider_id, config.model);
  if (catalogModel === undefined || !hasApi(catalogModel, "openai-completions")) {
    throw new Error(
      `pi-ai streamFn 装配失败: pi-ai 目录无 openai-completions 模型 ${JSON.stringify(config.model)}（provider=${JSON.stringify(config.provider_id)}；fail-closed）`,
    );
  }
  return { models, model: { ...catalogModel, baseUrl: config.base_url } };
};

/** provider 参数化 streamFn（StreamFn 契约＝Models.streamSimple 形）。 */
export const createProviderStreamFn = (config: ProviderStreamFnConfig): { streamFn: StreamFn; model: Model<"openai-completions"> } => {
  const { models, model } = assembleProviderModel(config);
  const streamFn: StreamFn = (requestedModel, context, options?: SimpleStreamOptions) =>
    models.streamSimple(requestedModel ?? model, context, {
      ...(config.api_key !== "" ? { apiKey: config.api_key } : {}),
      ...options,
    });
  return { streamFn, model };
};

// ---- 兼容别名（门 1a 深化路径遗留名；import 面已切 providerStreamFn）----
export const createDeepSeekStreamFn = (config: Omit<ProviderStreamFnConfig, "provider_id">): { streamFn: StreamFn; model: Model<"openai-completions"> } =>
  createProviderStreamFn({ ...config, provider_id: "deepseek" });
