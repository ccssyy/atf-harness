/**
 * LLM 配置桥自检（A 路线批次 1a）。
 *
 * 用真实 `HarnessLlmConfig/v3` 形态验证映射——不是构造理想输入，
 * 而是照实例上实际配置文件的结构（providers 多路由 + models 多模型 + compat）。
 */
import { describe, expect, it } from 'vitest'
import { toVendorProfiles, DROPPED_ATF_KEYS, type AtfProviderConfig } from '../../packages/extensions/atf-core/src/llmProfileBridge.js'

const REAL_SHAPE: AtfProviderConfig = {
  schema_version: 'HarnessLlmConfig/v3',
  default_provider: 'zai-coding-cn',
  default_model: 'glm-5.3-flash',
  providers: {
    deepseek: {
      protocol: 'pi-ai',
      base_url: 'https://api.deepseek.com',
      api_key_env: 'ATF_LLM_KEY_DEEPSEEK',
      models: [
        {
          id: 'deepseek-flash',
          reasoning: true,
          reasoning_effort: 'max',
          max_tokens: 393216,
          context_window: 1000000,
        },
      ],
    },
    'zai-coding-cn': {
      protocol: 'pi-ai',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      api_key_env: 'ATF_LLM_KEY_GLM',
      models: [{ id: 'glm-5.3', reasoning: true, reasoning_effort: 'max', max_tokens: 131072 }],
    },
  },
}

describe('ATF → vendor LLM profile 映射', () => {
  it('多路由多模型全量映射，凭据与端点逐字对齐', () => {
    const profiles = toVendorProfiles(REAL_SHAPE)
    expect(Object.keys(profiles).sort()).toEqual(['deepseek', 'zai-coding-cn'])
    expect(profiles['deepseek']?.apiKeyEnv).toBe('ATF_LLM_KEY_DEEPSEEK')
    expect(profiles['deepseek']?.baseURL).toBe('https://api.deepseek.com')
    expect(profiles['zai-coding-cn']?.apiKeyEnv).toBe('ATF_LLM_KEY_GLM')
  })

  it('protocol=pi-ai 省略 api（用目录默认），非 pi-ai 保留', () => {
    expect(toVendorProfiles(REAL_SHAPE)['deepseek']?.api).toBeUndefined()
    const custom = toVendorProfiles({
      schema_version: 'HarnessLlmConfig/v3',
      providers: { x: { protocol: 'anthropic', base_url: 'https://x' } },
    })
    expect(custom['x']?.api).toBe('anthropic')
  })

  it('reasoning_effort 单值 → vendor 集合形态', () => {
    const m = toVendorProfiles(REAL_SHAPE)['deepseek']?.models?.[0]
    expect(m?.reasoningEfforts).toEqual(['max'])
    expect(m?.maxTokens).toBe(393216)
    expect(m?.contextWindow).toBe(1000000)
  })

  it('版本不符 fail-closed（不猜旧版本）', () => {
    expect(() =>
      toVendorProfiles({ schema_version: 'HarnessLlmConfig/v2', providers: {} }),
    ).toThrow(/版本不支持/)
  })

  it('显式登记被丢弃的 ATF 键（防「以为迁了其实没迁」）', () => {
    expect(DROPPED_ATF_KEYS).toContain('timeout_ms')
    expect(DROPPED_ATF_KEYS).toContain('max_calls_per_run')
  })
})
