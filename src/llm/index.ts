/**
 * S5 LLM 层公开出口。冒烟 runner（src/run/）只从这里 import。
 */
export { FauxProvider } from "./fauxProvider.js";
export { FauxVariantProvider } from "./fauxVariantProvider.js";
export { llmError, type LlmDecision, type LlmError, type LlmErrorCode, type LlmProvider } from "./provider.js";
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
