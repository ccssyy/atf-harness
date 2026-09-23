/**
 * pi-ai 换库批（门 2，2026-09-23）——`@earendil-works/pi-ai@0.87.1` 底座 provider。
 *
 * 授权链：《ATF-Harness_指令_门2启动_pi-ai换库批_20260923.md》`6aa4303a` ＋
 * 《ATF-Harness_门1设计稿_pi-ai换库可行性核验与迁移设计_20260923.md》`3c21059c` §四迁移蓝图 ＋
 * 《ATF-Harness_门1裁定_pi-ai换库批通过_20260923.md》`1f378cd2`。
 *
 * 收敛边界（设计稿 §4.1，模型面契约零改）：B1 投影（adapter.ts）与决策守卫（provider.ts）
 * 之上、投影之后的一段被本件替换——
 *   LlmContextEvent[] ─B1投影(不动)→ AdapterMessage[] ─序列walk(本件，词汇换 pi-ai Message)
 *     → Models.completeSimple(model, ctx, {reasoning, maxTokens}) ─AssistantMessage
 *     → ModelResponse 形 → expandModelResponse(不动) → LlmDecision 缓冲（A3 同 HttpLlmProvider）。
 *
 * 等价性关键语义（fixture 五组锚定，tests/llm/piAiProvider.test.ts）：
 * - 悬空工具调用末尾合成 "[未执行：等待人工审批]" 结果；审批摘要在配对 tool_result 之后
 *   作 user 附言回填——walk 语义与 codecWire 逐条对应（复用同源常量，不复制文案）；
 * - DeepSeek wire 规则（工具轮回合 reasoning_content 回传）由 pi-ai 内建 compat 承接
 *   （requiresReasoningContentOnAssistantMessages，历史无思考时回填空串——门 1 实证语义等价，
 *   DSH 口径"内容不作校验"）；本仓 thinkingEcho 手搓注入在本路径不再使用；
 * - effort 值域闭集（none/low/high/max，providerConfig 单源）：none → 不传 reasoning
 *   （pi-ai deepseek 分支自动 thinking:disabled）；low/high/max → 直传；未知值 fail-closed 拒绝；
 * - maxTokens/model/base_url 显式取用户配置（R4 配置保真——pi-ai 目录 maxTokens=384000 为
 *   十进制保守近似，不取目录缺省）；
 * - 纯文本（无工具调用）→ final_answer；文本＋工具调用 → message＋tool_calls（A3 展开序）；
 *   空响应（仅思考块，finish=stop）→ ok(null)（runner 判收束，现语义）——与旧 codec
 *   parseResponse 逐条对应。
 *
 * length 结构化分型（R1/R2 前置）：finish_reason=length 不再像旧 codec 那样折成
 * wire_shape_invalid→provider_failure，而是经 consumeLengthSignal() 上抛结构化信号
 * （{kind:"length_truncated", contentEmpty}），由 runner 领域层做有界恢复（恰重试 1 次）。
 * LlmErrorCode 闭集零改（信号不走 err 通道）。
 *
 * 红线沿用：api_key 只进出站请求头（经 pi-ai options.apiKey——OpenAI SDK Bearer 头），
 * 私有持有，严禁进事件/载荷/报告；一切错误信息经脱敏漏斗；detail 只记 host（ADR-09）。
 * 凭据仍由配置层 api_key_env 解析注入，本件不读凭据环境变量（与旧路径同构）。
 *
 * 已知差异（相对旧自研路径，如实登记）：
 * - base_url 语义 = OpenAI SDK baseURL（SDK 追加 /chat/completions）；DeepSeek 官方
 *   https://api.deepseek.com 直接可用；旧路径曾按 base_url + /v1/chat/completions 拼 URL——
 *   切换 provider.type=pi-ai 的配置须按 SDK 约定给 base_url（不做自动补 /v1 猜测）；
 * - 出站请求体经 options.onPayload 观察缝暴露（测试/trial 断言用；observe-only 不改写）；
 * - usage（含 reasoning tokens 与目录峰值价 cost）经 onUsage 注入缝与 lastUsage 暴露——
 *   成本审计落点（事件面接线）不在本批（零 payload 变更纪律）；
 * - 历史空文本 assistant 消息被 pi-ai 编码器丢弃（旧路径原样发出空串）——线缆域更保守，
 *   canonical 面零差异。
 */
import {
  createModels,
  hasApi,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type JsonObject,
  type Message as PiMessage,
  type Model as PiModel,
  type Models,
  type MutableModels,
  type ThinkingLevel,
  type Tool as PiTool,
  type ToolResultMessage as PiToolResultMessage,
  type Usage as PiUsage,
  type UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { err, ok, type Result } from "../bridge/index.js";
import { adaptProjectionToMessages, expandModelResponse, type AdapterMessage, type ModelResponse } from "./adapter.js";
import { approvalAnnotationText, approvalSummaryLine, danglingToolResultContent, wireToolCallId } from "./codecWire.js";
import { HARNESS_SYSTEM_PROMPT } from "./httpProvider.js";
import { PIAI_REASONING_EFFORTS, type ResolvedLlmProviderConfig } from "./providerConfig.js";
import { llmError, llmErrorOf, type LlmDecision, type LlmError, type LlmProvider } from "./provider.js";
import { resolveSummaryResultCapChars } from "../core/session/constantsBudget.js";
import { type ModelVisibleTool } from "../core/tools/index.js";
import { type LlmContextEvent } from "../core/session/index.js";

/** R1/R2 的结构化 length 分型信号（decide 返回 ok(null) 时经 consumeLengthSignal 取出）。 */
export interface LengthTruncationSignal {
  kind: "length_truncated";
  /** true = 截断响应无可用内容（仅思考块吞预算）→ runner 有界自动重试恰 1 次；
   *  false = 有部分产出 → 不自动重试（重试性价比低），turn 收口＋续跑引导。 */
  contentEmpty: boolean;
  /** pi-ai 回显的 provider 原生档位（R3 生效验证/审计参考；缺省 null）。 */
  providerThinkingLevel: string | null;
}

/** length 分型能力品牌接口：runner 以 isLengthAwareLlmProvider 收窄后消费（LlmProvider 零改）。 */
export interface LengthAwareLlmProvider extends LlmProvider {
  /** 取出并清除最近一次 decide 的 length 分型信号；null = 最近一次响应非 length 截断。 */
  consumeLengthSignal(): LengthTruncationSignal | null;
}

const isLengthSignalAware = (provider: LlmProvider): provider is LlmProvider & LengthAwareLlmProvider =>
  "consumeLengthSignal" in provider;

/** runner 侧收窄守卫（core 层消费点经此判定，不做裸 in 检查）。 */
export const isLengthAwareLlmProvider = (provider: LlmProvider): provider is LlmProvider & LengthAwareLlmProvider =>
  isLengthSignalAware(provider);

export interface PiAiLlmProviderOptions {
  config: ResolvedLlmProviderConfig;
  /** 模型可见工具面（白名单投影；来自 ToolRegistry.modelVisible()） */
  tools: readonly ModelVisibleTool[];
  /** fetch 注入面（测试/零外连断言；透传 pi-ai → OpenAI SDK；缺省库默认） */
  fetchImpl?: typeof fetch;
  /** 技能清单常驻后缀（与 HttpLlmProvider 同语义：追加在系统提示之后；缺省不追加） */
  systemSuffix?: string;
  /** 出站请求体观察缝（测试/trial 断言；observe-only——返回值被忽略，不改写载荷） */
  onPayload?: (payload: unknown) => void;
  /** usage 计量缝（含 reasoning tokens 与 cost；每次成功响应回调；缺省不接） */
  onUsage?: (usage: PiUsage) => void;
}

/** effort 档位切换的结构化错误（R3 运行时切换；闭集外拒绝）。 */
export interface EffortSwitchError {
  code: "effort_unknown";
  message: string;
}

const truncate = (text: string, limit = 200): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** C 项（L1c 提前批）配额/限流/欠费归类标记——pi-ai 路径从规范化错误文本归类（SDK 已并入 status/body）。 */
const QUOTA_MESSAGE_MARKERS: readonly string[] = ["429", "insufficient_quota", "quota", "rate limit", "usage limit", "arrearage"];

// ---------------------------------------------------------------------------
// AdapterMessage[] → pi-ai Message[] 序列 walk（语义与 codecWire 逐条对应）
// ---------------------------------------------------------------------------

interface WalkState {
  /** 已发出、尚无线缆结果的工具调用（FIFO 配对） */
  pending: Array<{ id: string; tool: string }>;
  /** 缓冲中的审批附言（在配对 tool_result 之后回填） */
  annotations: string[];
}

/** 历史重放 AssistantMessage 的脚手架（pi-ai 编码只读 content 块；其余字段类型必填填充）。 */
interface ReplayScaffold {
  api: string;
  provider: string;
  model: string;
  timestamp: number;
}

const replayAssistant = (content: PiAssistantMessage["content"], scaffold: ReplayScaffold): PiAssistantMessage => ({
  role: "assistant",
  content,
  api: scaffold.api,
  provider: scaffold.provider,
  model: scaffold.model,
  usage: ZERO_USAGE,
  stopReason: "stop",
  timestamp: scaffold.timestamp,
});

const flushAnnotationsPi = (state: WalkState, out: PiMessage[], scaffold: ReplayScaffold): void => {
  if (state.annotations.length === 0) return;
  const lines = state.annotations.splice(0, state.annotations.length);
  const userMessage: PiUserMessage = { role: "user", content: approvalAnnotationText(lines), timestamp: scaffold.timestamp };
  out.push(userMessage);
};

/** 悬空工具调用收尾：合成 toolResult（内容 = danglingToolResultContent，同源文案非放行声明）。 */
const flushDanglingPi = (state: WalkState, out: PiMessage[], scaffold: ReplayScaffold): void => {
  if (state.pending.length === 0) return;
  const calls = state.pending.splice(0, state.pending.length);
  const annotations = state.annotations.splice(0, state.annotations.length);
  for (const call of calls) {
    const synthetic: PiToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.tool,
      content: [{ type: "text", text: danglingToolResultContent(annotations) }],
      isError: true,
      timestamp: scaffold.timestamp,
    };
    out.push(synthetic);
  }
  flushAnnotationsPi(state, out, scaffold);
};

/** B1 投影消息 → pi-ai 消息序列（纯函数；配对失败整体拒绝——不产残缺上下文）。 */
export const walkAdapterMessagesToPi = (
  messages: readonly AdapterMessage[],
  scaffold: ReplayScaffold,
): Result<PiMessage[], string> => {
  const out: PiMessage[] = [];
  const state: WalkState = { pending: [], annotations: [] };
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        flushDanglingPi(state, out, scaffold);
        out.push({ role: "user", content: message.text, timestamp: scaffold.timestamp });
        break;
      }
      case "assistant": {
        flushDanglingPi(state, out, scaffold);
        out.push(replayAssistant([{ type: "text", text: message.text }], scaffold));
        break;
      }
      case "assistant_tool_call": {
        flushDanglingPi(state, out, scaffold);
        const id = wireToolCallId(message.source_event_id);
        out.push(
          replayAssistant([{ type: "toolCall", id, name: message.tool, arguments: message.params as unknown as JsonObject }], scaffold),
        );
        state.pending.push({ id, tool: message.tool });
        break;
      }
      case "tool_result": {
        const paired = state.pending[0];
        if (paired === undefined) {
          return err(`tool_result 无配对的 assistant_tool_call（tool=${message.tool}，source_event_id=${String(message.source_event_id)}）`);
        }
        if (paired.tool !== message.tool) {
          return err(`tool_result 与配对工具调用不一致（期望 ${paired.tool}，实得 ${message.tool}）`);
        }
        state.pending.shift();
        out.push({
          role: "toolResult",
          toolCallId: paired.id,
          toolName: message.tool,
          content: [{ type: "text", text: message.summary }],
          isError: !message.ok,
          timestamp: scaffold.timestamp,
        });
        flushAnnotationsPi(state, out, scaffold);
        break;
      }
      case "approval": {
        // 线缆次序要求：tool_call 与 tool_result 之间不得插入 user——缓冲后随结果回填（同 codecWire）
        state.annotations.push(approvalSummaryLine(message));
        break;
      }
    }
  }
  flushDanglingPi(state, out, scaffold);
  flushAnnotationsPi(state, out, scaffold);
  return ok(out);
};

/** 工具面转换单点：ModelVisibleTool（JSON Schema 方言）→ pi-ai Tool（typebox schema 运行时同形）。 */
const toPiTools = (tools: readonly ModelVisibleTool[]): PiTool[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as PiTool["parameters"],
  }));

/** AssistantMessage → ModelResponse 形（旧 parseResponse 语义逐条对应）；
 *  null = 决策序列为空（无文本无工具调用；仅思考块同此——由调用方按 stopReason 分派）。 */
const messageToModelResponse = (message: PiAssistantMessage): ModelResponse | null => {
  const toolCalls = message.content.filter((block): block is Extract<PiAssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall");
  const text = message.content
    .filter((block): block is Extract<PiAssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .filter((entry) => entry.trim() !== "")
    .join("");
  if (toolCalls.length > 0) {
    const response: ModelResponse = {
      tool_calls: toolCalls.map((call) => ({ tool: call.name, params: call.arguments as unknown as Record<string, unknown> })),
    };
    if (text !== "") response.message = text;
    return response;
  }
  if (text !== "") return { final_answer: text };
  return null;
};

/** 截断响应是否有可用内容（思考块不计——"思考吞预算"判定；部分文本/工具调用 = 非空）。 */
const hasUsableContent = (message: PiAssistantMessage): boolean =>
  message.content.some((block) => (block.type === "text" && block.text.trim() !== "") || block.type === "toolCall");

// ---------------------------------------------------------------------------

export class PiAiLlmProvider implements LengthAwareLlmProvider {
  /** 注册名 = provider 别名（provider/switch 与 turn 归属的登记粒度；ADR-09 红线同旧路径） */
  public readonly providerId: string;

  private readonly config: ResolvedLlmProviderConfig;
  private readonly tools: readonly ModelVisibleTool[];
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly systemText: string;
  private readonly models: MutableModels;
  private readonly model: PiModel<"openai-completions">;
  private readonly onPayloadObserver: ((payload: unknown) => void) | undefined;
  private readonly onUsageCallback: ((usage: PiUsage) => void) | undefined;
  /** 已消耗的模型调用次数（每次 completeSimple 计 1；length 重试同计入 max_calls_per_run） */
  private callsMade = 0;
  /** 当前缓冲的顺序决策（A3：一次响应 N 个决策逐个弹出） */
  private buffer: LlmDecision[] = [];
  /** R3：当前生效档位（构造期闭集校验；切换经 setReasoningEffort，新请求即时生效） */
  private currentEffortValue: string;
  /** length 分型信号（一次性：下次 decide 前清空） */
  private lengthSignal: LengthTruncationSignal | null = null;
  /** 最近一次成功响应的 usage（成本审计面；经 onUsage 缝同步外送） */
  private lastUsageValue: PiUsage | null = null;
  /** 最近一次响应的 provider 原生档位回显（R3 生效验证） */
  private lastProviderThinkingLevelValue: string | null = null;

  public constructor(options: PiAiLlmProviderOptions) {
    const effort = options.config.reasoning_effort;
    if (!(PIAI_REASONING_EFFORTS as readonly string[]).includes(effort)) {
      // 配置层已按协议校验；此处防御手拼 ResolvedLlmProviderConfig 的越闭集值（fail-closed 不猜）
      throw new Error(`PiAiLlmProvider 配置非法: reasoning_effort=${JSON.stringify(effort)} 不在闭集（${PIAI_REASONING_EFFORTS.join("/")}）`);
    }
    this.config = options.config;
    this.tools = options.tools;
    this.fetchImpl = options.fetchImpl;
    this.onPayloadObserver = options.onPayload;
    this.onUsageCallback = options.onUsage;
    this.providerId = options.config.provider_id;
    this.currentEffortValue = effort;
    this.systemText = options.systemSuffix !== undefined && options.systemSuffix !== ""
      ? `${HARNESS_SYSTEM_PROMPT}\n${options.systemSuffix}`
      : HARNESS_SYSTEM_PROMPT;
    this.models = createModels();
    this.models.setProvider(deepseekProvider());
    const catalogModel = this.models.getModel("deepseek", this.config.model);
    if (catalogModel === undefined || !hasApi(catalogModel, "openai-completions")) {
      throw new Error(`PiAiLlmProvider 配置非法: pi-ai 目录无 openai-completions 模型 ${JSON.stringify(this.config.model)}（provider=deepseek；fail-closed）`);
    }
    // R4 配置保真：base_url/model 以用户配置为准（目录 baseUrl 被覆盖；compat 因 provider="deepseek"
    // 仍走 deepseek 规则——detectCompat 以 provider id 优先判定，不依赖 URL 嗅探）。
    this.model = { ...catalogModel, baseUrl: this.config.base_url };
  }

  /** 已消耗调用次数（诊断/测试；每次 completeSimple 计 1，length 重试计入）。 */
  public get calls(): number {
    return this.callsMade;
  }

  /** 当前生效档位（R3；运行时切换后新请求即时生效）。 */
  public get reasoningEffort(): string {
    return this.currentEffortValue;
  }

  /** 最近一次响应 usage（含 reasoning tokens 与 cost；无成功响应 = null）。 */
  public get lastUsage(): PiUsage | null {
    return this.lastUsageValue;
  }

  /** 最近一次响应的 provider 原生档位回显（R3 生效断言用；无响应 = null）。 */
  public get lastProviderThinkingLevel(): string | null {
    return this.lastProviderThinkingLevelValue;
  }

  /** R3：档位运行时切换——闭集外拒绝（不生效）；新请求即时生效，无需重建实例。 */
  public setReasoningEffort(effort: string): Result<{ from_effort: string; to_effort: string }, EffortSwitchError> {
    if (!(PIAI_REASONING_EFFORTS as readonly string[]).includes(effort)) {
      return err({
        code: "effort_unknown",
        message: `reasoning_effort=${JSON.stringify(effort)} 不在闭集（${PIAI_REASONING_EFFORTS.join("/")}），切换拒绝（fail-closed）`,
      });
    }
    const from = this.currentEffortValue;
    this.currentEffortValue = effort;
    return ok({ from_effort: from, to_effort: effort });
  }

  public consumeLengthSignal(): LengthTruncationSignal | null {
    const signal = this.lengthSignal;
    this.lengthSignal = null;
    return signal;
  }

  public async decide(context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>> {
    if (this.buffer.length > 0) {
      const next = this.buffer[0] as LlmDecision;
      this.buffer = this.buffer.slice(1);
      return ok(next);
    }

    // 成本护栏（D5）：与旧路径同语义——命中即结构化收敛；length 重试亦计入（每次 decide 计 1）
    if (this.callsMade >= this.config.max_calls_per_run) {
      return err(llmErrorOf("call_budget_exhausted", `单 run 调用次数上限已耗尽（max_calls_per_run=${String(this.config.max_calls_per_run)}）`, {
        reason: "call_budget_exhausted",
        limit: this.config.max_calls_per_run,
        calls_made: this.callsMade,
      }));
    }

    // A1（L1c 提前批）：成功体摘要上限数据驱动（与旧路径同源同参）
    const messages = adaptProjectionToMessages(context, {
      toolResultSummaryCapChars: resolveSummaryResultCapChars(this.config.context_window),
    });
    if (!messages.ok) {
      return err(llmError("模型上下文投影失败（fail-closed）", this.redactDetail(messages.error)));
    }
    const scaffold: ReplayScaffold = {
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      timestamp: Date.now(),
    };
    const walked = walkAdapterMessagesToPi(messages.value, scaffold);
    if (!walked.ok) {
      return err(llmError("模型消息序列转换失败（fail-closed，未发起网络请求）", this.redactDetail({ code: "sequence_shape_invalid", message: walked.error })));
    }
    const piContext: PiContext = {
      systemPrompt: this.systemText,
      messages: walked.value,
      tools: toPiTools(this.tools),
    };

    this.lengthSignal = null; // 一次性信号
    // effort → pi-ai reasoning：compat 抑制或 none → 不传（pi-ai deepseek 分支自动 thinking:disabled）
    const reasoning = this.resolveReasoningArg();

    this.callsMade += 1;
    let response: PiAssistantMessage;
    try {
      response = await this.models.completeSimple(this.model, piContext, {
        apiKey: this.config.api_key,
        ...(reasoning !== undefined ? { reasoning } : {}),
        // R4：显式传用户配置 max_tokens（不取目录缺省 384000——十进制保守近似）
        maxTokens: this.config.max_tokens,
        signal: AbortSignal.timeout(this.config.timeout_ms),
        timeoutMs: this.config.timeout_ms,
        maxRetries: this.config.max_retries,
        ...(this.fetchImpl !== undefined ? { fetch: this.fetchImpl } : {}),
        onPayload: (payload: unknown) => {
          this.onPayloadObserver?.(payload);
          return undefined; // observe-only：不改写出站载荷
        },
      });
    } catch (cause) {
      // 防御径：pi-ai 的 setup/传输错误经 lazyStream 归一为 stopReason="error" 的消息；
      // 裸抛仅剩不可归类异常（fail-closed 收口，不外泄）
      return err(this.failure(`模型调用异常（fail-closed）: ${truncate(String((cause as Error).message))}`));
    }

    this.lastUsageValue = response.usage;
    this.onUsageCallback?.(response.usage);
    this.lastProviderThinkingLevelValue = response.providerThinkingLevel ?? null;

    if (response.stopReason === "length") {
      // R1/R2 前置：结构化分型上抛（不入 provider_failure；不携残缺决策）。
      this.lengthSignal = {
        kind: "length_truncated",
        contentEmpty: !hasUsableContent(response),
        providerThinkingLevel: response.providerThinkingLevel ?? null,
      };
      return ok(null);
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const raw = response.errorMessage ?? "provider 返回错误停止原因";
      if (QUOTA_MESSAGE_MARKERS.some((marker) => raw.toLowerCase().includes(marker))) {
        return err(llmErrorOf(
          "provider_quota_or_rate_limited",
          "模型服务用量已达上限（provider 侧配额/限流）：请核对账户额度或稍后重试；输入新指令即可继续本会话",
          this.failureDetail(raw),
        ));
      }
      return err(this.failure(`provider 决策请求失败: ${truncate(raw)}`, raw));
    }
    if (response.stopReason !== "stop" && response.stopReason !== "toolUse") {
      // pending 不应出现在完结消息；deferred 未启用（不请求 deferred 句柄）——fail-closed
      return err(this.failure(`provider 返回不可处置的停止原因: ${String(response.stopReason)}（fail-closed）`));
    }

    const modelResponse = messageToModelResponse(response);
    if (modelResponse === null) {
      if (response.stopReason === "toolUse") {
        return err(this.failure("provider 停止原因为 toolUse 但无工具调用内容（fail-closed）"));
      }
      // 决策序列为空且 stopReason=stop → ok(null)（runner 判收束，现语义；仅思考块同此）
      return ok(null);
    }
    const expanded = expandModelResponse(modelResponse);
    if (!expanded.ok) {
      return err(llmError(`模型响应展开失败（fail-closed）: ${expanded.error.message}`));
    }
    this.buffer = [...expanded.value];
    const first = this.buffer[0] as LlmDecision;
    this.buffer = this.buffer.slice(1);
    return ok(first);
  }

  // ---------------------------------------------------------------- 内部

  /** effort → pi-ai reasoning 参数（compat 抑制或 none → undefined=不传；闭集值直传）。 */
  private resolveReasoningArg(): ThinkingLevel | undefined {
    if (!this.config.compat.supports_reasoning_effort) return undefined;
    if (this.currentEffortValue === "none") return undefined;
    return this.currentEffortValue as ThinkingLevel;
  }

  /** 脱敏漏斗：key 串出现处一律替换（错误信息/detail 的唯一出口；同 HttpLlmProvider）。 */
  private redact(text: string): string {
    if (this.config.api_key === "") return text;
    return text.split(this.config.api_key).join("[REDACTED]");
  }

  private redactDetail(detail: unknown): unknown {
    if (typeof detail === "string") return this.redact(detail);
    if (Array.isArray(detail)) return detail.map((item) => this.redactDetail(item));
    if (typeof detail === "object" && detail !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
        out[key] = this.redactDetail(value);
      }
      return out;
    }
    return detail;
  }

  /** detail 只记 host（ADR-09 红线：不记完整 URL 与请求头）。 */
  private failureDetail(errorMessage: string | null): Record<string, unknown> {
    return this.redactDetail({
      host: this.host(),
      provider: "pi-ai",
      model: this.config.model,
      calls_made: this.callsMade,
      ...(errorMessage !== null ? { error_message: truncate(errorMessage, 500) } : {}),
    }) as Record<string, unknown>;
  }

  private failure(message: string, errorMessage?: string): LlmError {
    return llmError(this.redact(message), this.failureDetail(errorMessage ?? null));
  }

  private host(): string {
    try {
      return new URL(this.config.base_url).host;
    } catch {
      return "<unparsed>";
    }
  }
}
