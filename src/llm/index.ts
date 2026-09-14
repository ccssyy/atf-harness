/**
 * S5 LLM 层公开出口。冒烟 runner（src/run/）只从这里 import。
 */
export {
  adaptProjectionToMessages,
  adapterError,
  expandModelResponse,
  type AdapterError,
  type AdapterMessage,
  type ModelResponse,
} from "./adapter.js";
export { FauxProvider, type ScriptedStepSource } from "./fauxProvider.js";
export { FauxVariantProvider } from "./fauxVariantProvider.js";
export {
  assertModelDecision,
  llmError,
  llmErrorOf,
  LLM_DECISION_TYPES,
  MODEL_DECISION_FORBIDDEN,
  type LlmDecision,
  type LlmError,
  type LlmErrorCode,
  type LlmProvider,
} from "./provider.js";
export {
  PROVIDER_CONFIG_DEFAULTS,
  PROVIDER_CONFIG_KEYS,
  PROVIDER_ENV_VARS,
  PROVIDER_PROTOCOLS,
  loadLlmProviderConfig,
  normalizeBaseUrl,
  type ProviderConfigError,
  type ProviderConfigErrorCode,
  type ProviderProtocol,
  type ResolvedLlmProviderConfig,
} from "./providerConfig.js";
export {
  codecError,
  PROTOCOL_REQUEST_PATHS,
  type CodecError,
  type CodecRequestInput,
  type ProtocolCodec,
} from "./codecWire.js";
export { getCodec } from "./codec.js";
export { anthropicMessagesCodec, ANTHROPIC_VERSION } from "./anthropicMessagesCodec.js";
export { openaiChatCodec } from "./openaiChatCodec.js";
export { HARNESS_SYSTEM_PROMPT, HttpLlmProvider, type HttpLlmProviderOptions } from "./httpProvider.js";
export {
  FakeLlmEndpoint,
  type FakeEndpointRequestRecord,
  type FakeEndpointScriptItem,
  type FakeLlmEndpointOptions,
} from "./fakeEndpoint.js";
export { ProviderRegistry, createDefaultProviderRegistry, type ProviderFactory } from "./providerRegistry.js";
export {
  SCENARIO_STEP_TYPES,
  SCENARIO_VERSION,
  parseScenario,
  scenarioError,
  type LedgerPreRecord,
  type ProviderSegment,
  type Scenario,
  type ScenarioBranch,
  type ScenarioError,
  type ScenarioErrorCode,
  type ScenarioExpect,
  type ScenarioStep,
  type ScenarioStepType,
} from "./scenario.js";
