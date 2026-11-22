/**
 * Faux LLM adapter 自检（A 路线批次 0）。
 *
 * 目的：证明迁移后的 adapter 形态能产出合法 `StreamChunk` 序列，
 * 从而支撑后续用 vendor `ctx.llm` 全链路的 L1 轨迹断言（替代只测自研 loop）。
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { FauxAdapter, fauxText, fauxToolCall } from './fauxAdapter.js'

const collect = async (gen: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('FauxAdapter（vendor LlmAdapter 形态）', () => {
  it('纯文本响应产出 block-start/text-delta/block-end/finish(stop)', async () => {
    const adapter = new FauxAdapter([fauxText('你好')])
    const chunks = await collect(adapter.stream({} as never))
    expect(chunks.map((c) => c.type)).toEqual(['block-start', 'text-delta', 'block-end', 'finish'])
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('stop')
  })

  it('工具调用响应产出 tool-call-delta 且 finish(tool-calls)', async () => {
    const adapter = new FauxAdapter([
      fauxToolCall('查状态', [{ id: 'c1', name: 'atf_workspace_status', arguments: {} }]),
    ])
    const chunks = await collect(adapter.stream({} as never))
    const delta = chunks.find((c) => c.type === 'tool-call-delta')
    expect(delta).toBeDefined()
    expect(delta?.type === 'tool-call-delta' && delta.name).toBe('atf_workspace_status')
    const finish = chunks.at(-1)
    expect(finish?.type === 'finish' && finish.reason.kind).toBe('tool-calls')
  })

  it('脚本按序弹出，issuedCount 与 remaining 可断言（防脚本写漏）', async () => {
    const adapter = new FauxAdapter([fauxText('a'), fauxText('b')])
    expect(adapter.remaining).toBe(2)
    await collect(adapter.stream({} as never))
    await collect(adapter.stream({} as never))
    expect(adapter.issuedCount).toBe(2)
    expect(adapter.remaining).toBe(0)
  })

  it('脚本耗尽 fail-closed 抛错（不编造响应）', async () => {
    const adapter = new FauxAdapter([])
    await expect(collect(adapter.stream({} as never))).rejects.toThrow(/脚本耗尽/)
  })
})
