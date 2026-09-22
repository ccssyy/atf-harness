/**
 * L1a 门 2——配置式 HTTP provider（《ATF独立Harness_L1a门2任务书_20260914.md》§1.1/§1.2、
 * 设计 §1.1/§1.2；R2a：Node 内置 fetch ＋ 自研薄适配层，不引 SDK）。
 *
 * 职责：decide(context) = adapter 投影（切片 2）→ codec 请求构造 → HTTP POST →
 * codec 响应解析 → expandModelResponse（切片 2）→ 决策缓冲（A3：一次响应 N 个顺序决策，
 * 每次调用弹出一个，逐个过守卫与审批——在 runner/codec 之外）。decide 永不抛出，失败走 Result err。
 *
 * 红线与护栏：
 * - api_key 只在出站请求头出现（codec.authHeaders）；本类私有持有，严禁进事件/载荷/报告；
 * - 脱敏漏斗：一切错误信息/detail 经 redact()——key 串出现处一律替换为 "[REDACTED]"；
 *   detail 只记 host（别名/主机名粒度，ADR-09 红线），不记完整 URL 与请求头；
 * - 成本护栏（D5）：单 run 调用次数上限 max_calls_per_run（默认 50，可配），每次 HTTP 尝试
 *   （含重试）计数；命中 → err(call_budget_exhausted)（结构化可区分），调用方终局收敛；
 * - 重试仅网络/超时/5xx 类决策请求，上限 max_retries（默认 1）；每次重试后的决策重新过
 *   守卫与审批（决策尚未产生即重试，无授权可复用——ADR-07 语义不变）；
 * - 零外连（门 2 / D3）：出站 URL 恒为 config.base_url + codec.requestPath；fetchImpl 可注入
 *   （测试断言全部请求命中回环假端点；缺省 globalThis.fetch）。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { adaptProjectionToMessages, expandModelResponse } from "./adapter.js";
import { getCodec } from "./codec.js";
import { type ProtocolCodec } from "./codecWire.js";
import { llmError, llmErrorOf, type LlmDecision, type LlmError, type LlmErrorCode, type LlmProvider } from "./provider.js";
import { type ResolvedLlmProviderConfig } from "./providerConfig.js";
import { resolveSummaryResultCapChars } from "../core/session/constantsBudget.js";
import { type ModelVisibleTool } from "../core/tools/index.js";
import { type LlmContextEvent } from "../core/session/index.js";

/**
 * 系统提示（harness 静态文本；只描述模型面约定，不含预算/治理内部字段——
 * 模型不可见约束延续；审批语义与 approval 消息同属模型可见面）。
 * 第 4 条（L1c 提前批 B 描述层，2026-09-22）：状态面信息直接使用、无需向用户复述、
 * 勿误称"工具"——五跑模型把 material_roots 枚举向用户复述并误称"列举工具"。
 */
export const HARNESS_SYSTEM_PROMPT = [
  "你是 ATF 训练流水线上的运行代理，由本 harness 托管。本轮任务见首条用户消息。",
  "可用工具以 tools 列表为准。约定：",
  "1. 了解现场先用只读工具查询（工作区状态 / 事实索引 / 闸门查询），不要臆测；",
  "2. 写动作（如数据准入）直接发起工具调用；是否放行由人工审批决定，审批往返以消息形式",
  "   出现在对话中——被拒绝或收到修改意见时，依据意见调整后重试或改走其他路径；",
  "3. 任务完成后以纯文本回复作最终答复（不再调用工具），概述做了什么、看到了什么、建议下一步。",
  "4. 查询类工具返回的状态信息（已登记数据、素材目录等）供你直接使用与决策——无需向用户",
  "   复述其枚举内容，也不要把状态面说成\"工具\"；向用户报告时只讲结论与下一步。",
].join("\n");

/** C 项（L1c 提前批）：provider 侧配额/限流/欠费归类标记——status 429 命中，body 标记兜底。 */
const QUOTA_BODY_MARKERS: readonly string[] = ["insufficient_quota", "quota", "rate limit", "usage limit", "arrearage"];

const isQuotaFailure = (status: number, bodyExcerpt: string): boolean => {
  if (status === 429) return true;
  const head = bodyExcerpt.slice(0, 2000).toLowerCase();
  return QUOTA_BODY_MARKERS.some((marker) => head.includes(marker));
};

export interface HttpLlmProviderOptions {
  config: ResolvedLlmProviderConfig;
  /** 模型可见工具面（白名单投影；来自 ToolRegistry.modelVisible()） */
  tools: readonly ModelVisibleTool[];
  /** fetch 注入面（测试/零外连断言；缺省 globalThis.fetch） */
  fetchImpl?: typeof fetch;
  /** 批 3 §二：技能清单常驻后缀（Pi lazy skills——每技能一行）追加在系统提示之后；
   *  缺省不追加＝既有行为逐位不变。清单源＝pin skills（SkillCatalog），harness 不复制。 */
  systemSuffix?: string;
}

const truncate = (text: string, limit = 200): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** 从 openai-chat 原始响应捕获 reasoning_content（thinking 回传；形状不符 = null，不猜）。 */
const extractReasoningEcho = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const choices = (body as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return null;
  const message = (choice as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const reasoning = (message as Record<string, unknown>)["reasoning_content"];
  return typeof reasoning === "string" && reasoning !== "" ? reasoning : null;
};

export class HttpLlmProvider implements LlmProvider {
  /** 注册名 = provider 别名（修订 v2 两层形态的 provider_id；ADR-09 红线：不记凭据化 URL） */
  public readonly providerId: string;

  private readonly config: ResolvedLlmProviderConfig;
  private readonly tools: readonly ModelVisibleTool[];
  private readonly fetchImpl: typeof fetch;
  private readonly codec: ProtocolCodec;
  private readonly systemText: string;
  /** 已消耗的 HTTP 调用次数（含重试尝试） */
  private callsMade = 0;
  /** 当前缓冲的顺序决策（A3：一次响应 N 个决策逐个弹出） */
  private buffer: LlmDecision[] = [];
  /** thinking 模式回传缓冲：上一响应的 reasoning_content（线缆域；不进 canonical 上下文） */
  private reasoningEcho: string | null = null;

  public constructor(options: HttpLlmProviderOptions) {
    const codec = getCodec(options.config.protocol);
    if (!codec.ok) {
      // 构造期 fail-closed：未知 protocol 在配置层已拦；此处防御（不应可达）
      throw new Error(`HttpLlmProvider 配置非法: ${codec.error.message}`);
    }
    this.config = options.config;
    this.tools = options.tools;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.codec = codec.codec;
    this.providerId = options.config.provider_id;
    this.systemText = options.systemSuffix !== undefined && options.systemSuffix !== ""
      ? `${HARNESS_SYSTEM_PROMPT}\n${options.systemSuffix}`
      : HARNESS_SYSTEM_PROMPT;
  }

  /** 已消耗调用次数（诊断/测试）。 */
  public get calls(): number {
    return this.callsMade;
  }

  public async decide(context: readonly LlmContextEvent[]): Promise<Result<LlmDecision | null, LlmError>> {
    if (this.buffer.length > 0) {
      const next = this.buffer[0] as LlmDecision;
      this.buffer = this.buffer.slice(1);
      return ok(next);
    }

    // 成本护栏（D5）：命中即结构化收敛，不静默继续
    if (this.callsMade >= this.config.max_calls_per_run) {
      return err(llmErrorOf("call_budget_exhausted", `单 run 调用次数上限已耗尽（max_calls_per_run=${String(this.config.max_calls_per_run)}）`, {
        reason: "call_budget_exhausted",
        limit: this.config.max_calls_per_run,
        calls_made: this.callsMade,
      }));
    }

    // A1（L1c 提前批）：成功体摘要上限数据驱动——min(窗口×12.5%, 25K tokens)×2 字符，
    // 未配置回退 6_000 字符（constantsBudget 解析；口径换算注明处）。
    const messages = adaptProjectionToMessages(context, {
      toolResultSummaryCapChars: resolveSummaryResultCapChars(this.config.context_window),
    });
    if (!messages.ok) {
      return err(llmError("模型上下文投影失败（fail-closed）", this.redactDetail(messages.error)));
    }

    const body = this.codec.encodeRequestBody({
      model: this.config.model,
      system: this.systemText,
      messages: messages.value,
      tools: this.tools,
      // compat.supports_reasoning_effort=false → null → 请求体整体省略该字段（修订 v2 规则 4）
      reasoningEffort: this.config.compat.supports_reasoning_effort ? this.config.reasoning_effort : null,
      developerRole: this.config.compat.supports_developer_role,
      // thinking 全量回填（复跑适配）：模型元数据 reasoning=true 时启用；null = 历史未留存（占位）
      thinkingEcho: this.config.reasoning ? (this.reasoningEcho ?? null) : undefined,
      maxTokens: this.config.max_tokens,
    });
    this.reasoningEcho = null; // 一次性回传

    const fetched = await this.postJson(body);
    if (!fetched.ok) return fetched;

    // thinking 模式回传捕获（线缆域）：对端要求上一轮 reasoning_content 随 assistant 消息回传——
    // 原样捕获，不进 canonical ModelResponse（剥离语义不变），下次请求构造时经 reasoningEcho 回注
    this.reasoningEcho = extractReasoningEcho(fetched.value);

    const parsed = this.codec.parseResponse(fetched.value);
    if (!parsed.ok) {
      return err(llmError(`模型响应形状非法（fail-closed）: ${parsed.error.message}`, this.redactDetail({
        protocol: this.config.protocol,
        status: parsed.error.status,
        body_excerpt: parsed.error.body_excerpt,
      })));
    }
    const expanded = expandModelResponse(parsed.value);
    if (!expanded.ok) {
      return err(llmError(`模型响应展开失败（fail-closed）: ${expanded.error.message}`));
    }
    this.buffer = [...expanded.value];
    const first = this.buffer[0] as LlmDecision;
    this.buffer = this.buffer.slice(1);
    return ok(first);
  }

  // ---------------------------------------------------------------- 内部

  /** 脱敏漏斗：key 串出现处一律替换（错误信息/detail 的唯一出口）。 */
  private redact(text: string): string {
    if (this.config.api_key === "") return text;
    return text.split(this.config.api_key).join("[REDACTED]");
  }

  /** detail 深度脱敏（字符串值逐个过漏斗）。 */
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

  private httpFailure(message: string, extra?: { status?: number; body_excerpt?: string; request_body?: string }, code: LlmErrorCode = "provider_failure"): LlmError {
    // detail 只记 host（ADR-09 红线：provider 记录只到别名/主机名粒度，不记完整 URL）
    return llmErrorOf(code, this.redact(message), this.redactDetail({
      host: this.host(),
      ...(extra?.status !== undefined ? { status: extra.status } : {}),
      ...(extra?.body_excerpt !== undefined ? { body_excerpt: truncate(extra.body_excerpt) } : {}),
      ...(extra?.request_body !== undefined ? { request_body: extra.request_body } : {}),
      calls_made: this.callsMade,
    }));
  }

  private host(): string {
    try {
      return new URL(this.config.base_url).host;
    } catch {
      return "<unparsed>";
    }
  }

  /** 单次 POST（含重试循环；每次尝试计入调用预算；网络/超时/5xx 可重试，4xx 与解析错不重试）。 */
  private async postJson(body: unknown): Promise<Result<unknown, LlmError>> {
    const url = `${this.config.base_url}${this.codec.requestPath}`;
    const attemptsAllowed = 1 + this.config.max_retries;
    let lastFailure: LlmError | null = null;
    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      if (this.callsMade >= this.config.max_calls_per_run) {
        return err(llmErrorOf("call_budget_exhausted", `单 run 调用次数上限已耗尽（重试计入预算）: max_calls_per_run=${String(this.config.max_calls_per_run)}`, {
          reason: "call_budget_exhausted",
          limit: this.config.max_calls_per_run,
          calls_made: this.callsMade,
        }));
      }
      this.callsMade += 1;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.codec.authHeaders(this.config.api_key) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeout_ms),
        });
      } catch (cause) {
        // 网络故障 / 超时（AbortError）——可重试类
        lastFailure = this.httpFailure(`决策请求失败（网络/超时，第 ${String(attempt)}/${String(attemptsAllowed)} 次）: ${truncate(String((cause as Error).message))}`);
        continue;
      }
      if (response.status >= 500) {
        const excerpt = await response.text().catch(() => "");
        lastFailure = this.httpFailure(`决策请求服务端故障（HTTP ${String(response.status)}，第 ${String(attempt)}/${String(attemptsAllowed)} 次）`, {
          status: response.status,
          body_excerpt: excerpt,
        });
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        // 4xx 等：非瞬时故障，不重试（fail-closed）
        const excerpt = await response.text().catch(() => "");
        // C 项（L1c 提前批）：provider 配额/限流/欠费归类——人读提示＋结构化码，不重试
        // （无退避机制，重试计入预算只白烧；runner provider_failure 收口径自然携带人读行）。
        if (isQuotaFailure(response.status, excerpt)) {
          return err(this.httpFailure(
            "模型服务用量已达上限（provider 侧配额/限流）：请核对账户额度或稍后重试；输入新指令即可继续本会话",
            { status: response.status, body_excerpt: excerpt },
            "provider_quota_or_rate_limited",
          ));
        }
        // 诊断转储（ATF_LLM_DEBUG_DUMP=1 时启用；仅请求体，不含任何头/凭据——key 不在 body）
        const dump = process.env["ATF_LLM_DEBUG_DUMP"] === "1" ? JSON.stringify(body) : undefined;
        return err(this.httpFailure(`决策请求被拒绝（HTTP ${String(response.status)}，不重试）`, {
          status: response.status,
          body_excerpt: excerpt,
          ...(dump !== undefined ? { request_body: truncate(dump, 6000) } : {}),
        }));
      }
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch (cause) {
        return err(this.httpFailure(`响应体不是合法 JSON（fail-closed）: ${truncate(String((cause as Error).message))}`, { status: response.status }));
      }
      return ok(parsedBody);
    }
    return err(lastFailure ?? this.httpFailure("决策请求失败（原因未归类）"));
  }
}
