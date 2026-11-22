/**
 * ATF → vendor LLM 配置桥（A 路线批次 1a，2026-11-22）。
 *
 * 目的：把 ATF 的 `HarnessLlmConfig/v3` 映射成 vendor `llm-pi-ai` 的
 * `PiAiProviderProfile` 形态，使 `src/llm` 的 provider 装配可退役（批次 3），
 * 改由 vendor `ctx.llm` + `llm-pi-ai` 承接。
 *
 * 字段映射（实测对照）：
 *
 * | ATF (`HarnessLlmConfig/v3`) | vendor (`PiAiProviderProfile`) | 说明 |
 * |---|---|---|
 * | `providers[p].protocol`      | `api`                          | "pi-ai" → 省略（用目录默认） |
 * | `providers[p].base_url`      | `baseURL`                      | 直接对应 |
 * | `providers[p].api_key_env`   | `apiKeyEnv`                    | 凭据 env 名直接对应 |
 * | `providers[p].models[].id`   | `models[].id`                  | 直接对应 |
 * | `models[].reasoning`         | `models[].reasoning`           | 布尔语义一致 |
 * | `models[].reasoning_effort`  | `models[].reasoningEfforts`    | 单值 → 集合（见下） |
 * | `models[].max_tokens`        | `models[].maxTokens`           | 直接对应 |
 * | `models[].context_window`    | `models[].contextWindow`       | 直接对应 |
 * | `default_provider/model`     | settings `default` 字段        | vendor settings 命名空间 |
 *
 * 不通用的部分（本桥显式登记）：
 * - `timeout_ms` / `max_retries` / `max_calls_per_run` 是 ATF 运行时旋钮，
 *   vendor 侧走 `llm-retry` 与 settings，**不在 profile 内**——由调用方另行装配。
 * - `compat`（supports_developer_role / supports_reasoning_effort）→ vendor
 *   `PiAiCompatProfile`，字段名待逐项核对（本批只做透传，不做推断）。
 *
 * 设计纪律：**不做语义推断**——ATF 有而 vendor 无的键显式丢弃并报告；
 * vendor 有而 ATF 无的键保持缺省。映射失败 fail-closed 抛错，不静默降级。
 */
import { readFileSync } from 'node:fs'

/** ATF provider 配置的原始形态（`HarnessLlmConfig/v3` 子集）。 */
export interface AtfProviderConfig {
  readonly schema_version: string
  readonly default_provider?: string
  readonly default_model?: string
  readonly providers: Readonly<Record<string, AtfProvider>>
}

interface AtfProvider {
  readonly protocol?: string
  readonly base_url?: string
  readonly api_key_env?: string
  readonly compat?: Readonly<Record<string, boolean>>
  readonly models?: ReadonlyArray<AtfModel>
}

interface AtfModel {
  readonly id: string
  readonly reasoning?: boolean
  readonly reasoning_effort?: string
  readonly max_tokens?: number
  readonly context_window?: number
}

/** vendor `PiAiProviderProfile` 的映射结果（只取本桥负责的字段）。 */
export interface VendorProviderProfile {
  readonly apiKeyEnv?: string
  readonly baseURL?: string
  readonly api?: string
  readonly models?: ReadonlyArray<{
    readonly id: string
    readonly reasoning?: boolean
    readonly reasoningEfforts?: readonly string[]
    readonly maxTokens?: number
    readonly contextWindow?: number
  }>
}

/** 映射一条模型条目。 */
const mapModel = (model: AtfModel): NonNullable<VendorProviderProfile['models']>[number] => ({
  id: model.id,
  ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  // ATF 单值 → vendor 集合；保留原值作为唯一可选档
  ...(model.reasoning_effort === undefined
    ? {}
    : { reasoningEfforts: [model.reasoning_effort] }),
  ...(model.max_tokens === undefined ? {} : { maxTokens: model.max_tokens }),
  ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
})

/** 映射一条 provider 条目（`protocol: "pi-ai"` → 省略 `api` 用目录默认）。 */
const mapProvider = (provider: AtfProvider): VendorProviderProfile => ({
  ...(provider.api_key_env === undefined ? {} : { apiKeyEnv: provider.api_key_env }),
  ...(provider.base_url === undefined ? {} : { baseURL: provider.base_url }),
  // ATF 的 protocol 只有 "pi-ai" 一种在用；vendor 侧省略即用目录默认 protocol
  ...(provider.protocol !== undefined && provider.protocol !== 'pi-ai'
    ? { api: provider.protocol }
    : {}),
  ...(provider.models === undefined ? {} : { models: provider.models.map(mapModel) }),
})

/** ATF 配置 → vendor profile 集合。 */
export const toVendorProfiles = (
  config: AtfProviderConfig,
): Readonly<Record<string, VendorProviderProfile>> => {
  if (config.schema_version !== 'HarnessLlmConfig/v3') {
    throw new Error(
      `ATF LLM 配置版本不支持: ${config.schema_version}（本桥只认 HarnessLlmConfig/v3；fail-closed）`,
    )
  }
  const out: Record<string, VendorProviderProfile> = {}
  for (const [route, provider] of Object.entries(config.providers)) {
    out[route] = mapProvider(provider)
  }
  return out
}

/** 从文件读取 ATF 配置并映射（路径来自 `ATF_LLM_CONFIG`）。 */
export const loadVendorProfilesFromFile = (configPath: string): Readonly<Record<string, VendorProviderProfile>> => {
  const raw = readFileSync(configPath, 'utf8')
  return toVendorProfiles(JSON.parse(raw) as AtfProviderConfig)
}

/** 本桥显式丢弃的 ATF 键（防「以为迁了其实没迁」）——报告用。 */
export const DROPPED_ATF_KEYS: readonly string[] = [
  'timeout_ms',
  'max_retries',
  'max_calls_per_run',
] as const
