/**
 * Faux LLM adapter（A 路线批次 0，2026-11-22）——vendor `LlmAdapter` 的正规实现。
 *
 * 迁移自 `src/agent/fauxStream.ts`（StreamFn 形态）。两者分工：
 * - **本文件（adapter 形态）**：实现 vendor `LlmAdapter.stream()` 产出 `StreamChunk`，
 *   走真实 `ctx.llm` 链路——能测到 vendor 的路由/重试/token-meter 全链。
 * - `src/agent/fauxStream.ts`（StreamFn 形态）：仍服务于自研 loop 的白盒测试，
 *   随 `src/agent` 在批次 6 删除。
 *
 * 设计依据：vendor `packages/llm/llm/src/types.ts:452` 的 `StreamChunk` 联合类型；
 * `LlmAdapter` 只有 `stream()` 是抽象方法，其余有默认实现（`index.ts:208`）。
 *
 * 零依赖红线：仅依赖 vendor 的类型定义与脚本数据，不引入网络/真实 provider。
 */
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ContentBlock, FinishReason } from '@deepseek-ai/dsh-llm'

/** 一条脚本响应：文本 + 可选工具调用（与 fauxStream 的 AssistantMessage 等价语义）。 */
export interface FauxResponse {
  /** 文本内容（空串＝无文本块）。 */
  readonly text?: string
  /** 工具调用列表（有则 finishReason='toolUse'）。 */
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }>
}

/** 把一条脚本响应摊平成 vendor `StreamChunk` 序列（帧边界由 index 决定）。 */
const chunksOf = (response: FauxResponse): StreamChunk[] => {
  const chunks: StreamChunk[] = []
  let index = 0
  const text = response.text ?? ''
  if (text !== '') {
    chunks.push({ type: 'block-start', index, blockType: 'text' })
    chunks.push({ type: 'text-delta', index, text })
    const block: ContentBlock = { type: 'text', text }
    chunks.push({ type: 'block-end', index, block })
    index += 1
  }
  for (const call of response.toolCalls ?? []) {
    chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
    chunks.push({
      type: 'tool-call-delta',
      index,
      id: call.id as StreamChunk extends { type: 'tool-call-delta'; id: infer I } ? I : never,
      name: call.name,
      argumentsDelta: JSON.stringify(call.arguments),
    })
    const block = {
      type: 'tool-call' as const,
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    } as unknown as ContentBlock
    chunks.push({ type: 'block-end', index, block })
    index += 1
  }
  // vendor FinishReason 是对象形态（FinishReasonMap），非字符串
  const reason: FinishReason = (response.toolCalls ?? []).length > 0
    ? { kind: 'tool-calls' }
    : { kind: 'stop' }
  chunks.push({ type: 'finish', reason })
  return chunks
}

/**
 * 脚本化 faux adapter：每次 `stream()` 按序弹出一条脚本响应。
 *
 * 脚本耗尽＝**fail-closed 抛错**（不编造响应）——与 fauxStream 同口径，
 * 避免测试在脚本写漏时静默通过。
 */
export class FauxAdapter extends (class {} as unknown as typeof LlmAdapter) implements LlmAdapter {
  private readonly queue: FauxResponse[]
  private issued = 0

  public constructor(script: readonly FauxResponse[]) {
    super()
    this.queue = [...script]
  }

  /** 已发起的模型请求数（测试断言「循环实际调了几次模型」）。 */
  public get issuedCount(): number {
    return this.issued
  }

  /** 剩余脚本条数（断言脚本刚好用完，不浪费也不缺）。 */
  public get remaining(): number {
    return this.queue.length
  }

  public async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    this.issued += 1
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error('faux adapter 脚本耗尽（fail-closed，不编造响应）')
    }
    for (const chunk of chunksOf(next)) yield chunk
  }
}

/** 便捷构造：纯文本终止响应。 */
export const fauxText = (text: string): FauxResponse => ({ text })

/** 便捷构造：文本 + 工具调用。 */
export const fauxToolCall = (
  text: string,
  calls: FauxResponse['toolCalls'],
): FauxResponse => ({ text, toolCalls: calls })
