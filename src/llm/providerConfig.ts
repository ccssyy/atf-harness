/**
 * L1a 门 2 修订 v2——provider 配置层（《ATF独立Harness_L1a门2修订任务书v2_provider配置对齐PiDSH_20260914.md》
 * §1 七条规则；形态对齐 Pi `models.json` / DSH `settings.yaml` 实测形态）。
 *
 * 唯一规范形态（两层清单，规则 1；v1 单 provider 扁平读取路径已移除——本仓无外部消费者）：
 * {
 *   "schema_version": "HarnessLlmConfig/v3",
 *   "default_provider": "deepseek",            // 必填（规则 2）
 *   "default_model": "deepseek-flash",         // 可选；省略取选中 provider 的 models[0]（顺序即默认）
 *   "timeout_ms" / "max_retries" / "max_calls_per_run",  // 可选顶层旋钮（env 可覆盖，规则 7）
 *   "providers": {
 *     "<provider 别名>": {
 *       "protocol": "openai-chat" | "anthropic-messages",
 *       "base_url": "https://…",
 *       "api_key_env": "ENV_VAR_NAME",          // 首选（规则 3）；与 api_key 并存 → 拒绝
 *       "api_key": "<字面值>",                  // 仅过渡用（不推荐，文档标注）
 *       "compat": { "supports_developer_role": false, "supports_reasoning_effort": false },  // 可选（规则 4）
 *       "models": [ { "id": "...", "reasoning": true, "reasoning_effort": "max",
 *                     "max_tokens": 4096, "context_window": 131072 } ]   // 模型级元数据（规则 5）
 *     } } }
 *
 * 选择：ATF_LLM_PROVIDER / ATF_LLM_MODEL 覆盖默认；未知 id → fail-closed（规则 2）。
 * 凭据：api_key_env 指向的环境变量缺失/为空 → fail-closed；配置文件内零明文凭据（规则 3）。
 * env 覆盖保留（规则 7，作用于选中 provider/model）：ATF_LLM_TIMEOUT_MS / ATF_LLM_MAX_RETRIES /
 * ATF_LLM_MAX_CALLS_PER_RUN / ATF_LLM_REASONING_EFFORT / ATF_LLM_MAX_TOKENS。
 *
 * fail-closed 纪律：未知顶层/provider/模型键、缺 protocol/base_url/models、空 models、
 * 重复 id、base_url 内嵌 userinfo、reasoning_effort="none"（GPT-5.4 chat 面限制）→ 结构化拒绝。
 * 产物含解析后的 api_key 值——只能交给 HttpLlmProvider 私有持有，严禁序列化进事件/载荷/报告。
 */
import { readFile, stat } from "node:fs/promises";
import { err, ok, type Result } from "../bridge/index.js";

/** 协议面 v1（门 2 D6 不变）：两个 codec；openai-responses 只预留位。 */
export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ["openai-chat", "anthropic-messages"];

/** 配置 schema 版本（唯一规范形态；其他值一律拒绝）。 */
export const LLM_CONFIG_SCHEMA_VERSION = "HarnessLlmConfig/v3";

/** 顶层键闭集（规则 6）。 */
export const LLM_CONFIG_TOP_KEYS: readonly string[] = [
  "schema_version",
  "default_provider",
  "default_model",
  "timeout_ms",
  "max_retries",
  "max_calls_per_run",
  "turn_token_budget",
  "providers",
];

/** provider 键闭集（规则 6）。 */
export const LLM_PROVIDER_KEYS: readonly string[] = ["protocol", "base_url", "api_key_env", "api_key", "compat", "models"];

/** compat 键闭集（规则 4）。 */
export const LLM_COMPAT_KEYS: readonly string[] = ["supports_developer_role", "supports_reasoning_effort"];

/** 模型键闭集（规则 5/6）。 */
export const LLM_MODEL_KEYS: readonly string[] = ["id", "reasoning", "reasoning_effort", "max_tokens", "context_window"];

/** 环境变量名（规则 2/7；文件路径 = ATF_LLM_CONFIG）。 */
export const PROVIDER_ENV_VARS = {
  configPath: "ATF_LLM_CONFIG",
  provider: "ATF_LLM_PROVIDER",
  model: "ATF_LLM_MODEL",
  timeoutMs: "ATF_LLM_TIMEOUT_MS",
  maxRetries: "ATF_LLM_MAX_RETRIES",
  maxCallsPerRun: "ATF_LLM_MAX_CALLS_PER_RUN",
  reasoningEffort: "ATF_LLM_REASONING_EFFORT",
  maxTokens: "ATF_LLM_MAX_TOKENS",
  turnTokenBudget: "ATF_LLM_TURN_TOKEN_BUDGET",
} as const;

/** 默认值（收在常量层，模型不可见）。 */
export const PROVIDER_CONFIG_DEFAULTS = {
  timeoutMs: 60_000,
  maxRetries: 1,
  /** 门 2 D5：单 run 调用次数上限默认 50；与轮次预算（32/8）是两件事。 */
  maxCallsPerRun: 50,
  reasoningEffort: "low",
  maxTokens: 4096,
} as const;

export type ProviderConfigErrorCode =
  | "config_unreadable"
  | "config_invalid"
  | "config_permission"
  | "protocol_unknown";

export interface ProviderConfigError {
  code: ProviderConfigErrorCode;
  message: string;
  detail?: unknown;
}

const configError = (code: ProviderConfigErrorCode, message: string, detail?: unknown): ProviderConfigError => {
  const error: ProviderConfigError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** provider 级兼容声明（规则 4；缺省按协议标准行为）。 */
export interface ProviderCompat {
  supports_developer_role?: boolean;
  supports_reasoning_effort?: boolean;
}

/** 模型级元数据（规则 5；id 外全部可选）。 */
export interface ModelEntry {
  id: string;
  reasoning?: boolean;
  reasoning_effort?: string;
  max_tokens?: number;
  context_window?: number;
}

/** 选中 provider+model 的解析产物（HttpLlmProvider 装配唯一入参；api_key 解析值严禁外泄）。 */
export interface ResolvedLlmProviderConfig {
  /** provider 别名（provider/switch 与 turn 归属的登记粒度；ADR-09 别名/主机名红线） */
  provider_id: string;
  protocol: ProviderProtocol;
  base_url: string;
  /** 解析后的凭据值（来自 api_key_env 指向的环境变量或过渡字面值；只进出站请求头） */
  api_key: string;
  /** 选中模型 id */
  model: string;
  /** 模型级元数据（描述性；reasoning=true ⇒ 对端可能返回思考块，codec 须剥离，规则 5） */
  reasoning: boolean;
  /** 生效 reasoning_effort（env > 模型级 > 默认；compat 抑制时不发送——见 supports_reasoning_effort） */
  reasoning_effort: string;
  /** 生效 max_tokens（env > 模型级 > 默认） */
  max_tokens: number;
  context_window: number | null;
  /** 生效 compat（缺省 = 协议标准行为，规则 4） */
  compat: { supports_developer_role: boolean; supports_reasoning_effort: boolean };
  timeout_ms: number;
  max_retries: number;
  max_calls_per_run: number;
  /** 批 2.5：turn 级 token 预算（est tokens；null＝未配置——runner 侧数据驱动缺省 floor(水位/4)）。 */
  turn_token_budget: number | null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

const nonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** 规格化 base_url：去尾斜杠；http(s) 必需；拒绝内嵌 userinfo 凭据（ADR-09 红线）。 */
export const normalizeBaseUrl = (raw: string): Result<string, ProviderConfigError> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(configError("config_invalid", `base_url 非法（不可解析为 URL）: ${JSON.stringify(raw.slice(0, 64))}`));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return err(configError("config_invalid", `base_url 协议面非法（仅 http/https）: ${url.protocol}`));
  }
  if (url.username !== "" || url.password !== "") {
    return err(configError("config_invalid", "base_url 不得内嵌凭据（userinfo）——凭据只允许经 api_key_env/api_key 注入出站请求头"));
  }
  return ok(`${url.origin}${url.pathname.replace(/\/+$/, "")}`);
};

/** 未声明键检查（键闭集，规则 6）。 */
const rejectUnknownKeys = (payload: Record<string, unknown>, declared: readonly string[], path: string): ProviderConfigError | null => {
  for (const key of Object.keys(payload)) {
    if (!declared.includes(key)) {
      return configError("config_invalid", `${path} 含未知键 "${key}"（fail-closed；允许键：${declared.join(", ")}）`);
    }
  }
  return null;
};

/** reasoning_effort 值校验（来源无关：默认/模型级/env）。 */
const checkReasoningEffort = (value: string, source: string): ProviderConfigError | null =>
  value === "none"
    ? configError("config_invalid", `${source} reasoning_effort="none" 拒绝：GPT-5.4 起 chat 面 reasoning:none 下工具调用不受支持，本 loop 依赖工具调用`)
    : null;

/** 文件 → 结构化清单（两层校验，规则 1/6；不含选择与凭据解析）。 */
interface ParsedCatalog {
  default_provider: string;
  default_model: string | null;
  timeout_ms: number | null;
  max_retries: number | null;
  max_calls_per_run: number | null;
  /** 批 2.5：turn 级 token 预算（est tokens；null＝未配置走数据驱动缺省 floor(水位/4)）。 */
  turn_token_budget: number | null;
  providers: Map<string, { protocol: ProviderProtocol; base_url: string; api_key_env: string | null; api_key: string | null; compat: ProviderCompat; models: ModelEntry[] }>;
}

const parseCatalog = (file: Record<string, unknown>): Result<ParsedCatalog, ProviderConfigError> => {
  const unknownTop = rejectUnknownKeys(file, LLM_CONFIG_TOP_KEYS, "顶层");
  if (unknownTop !== null) return err(unknownTop);

  if (file["schema_version"] !== LLM_CONFIG_SCHEMA_VERSION) {
    return err(configError("config_invalid", `schema_version 必须为 "${LLM_CONFIG_SCHEMA_VERSION}"（实得 ${JSON.stringify(file["schema_version"] ?? null)}）`));
  }
  if (!nonEmptyString(file["default_provider"])) {
    return err(configError("config_invalid", "default_provider 必填（非空字符串，规则 2）"));
  }
  if (file["default_model"] !== undefined && !nonEmptyString(file["default_model"])) {
    return err(configError("config_invalid", "default_model 非法（须为非空字符串）"));
  }
  for (const key of ["timeout_ms", "max_calls_per_run", "turn_token_budget"] as const) {
    if (file[key] !== undefined && !positiveInt(file[key])) {
      return err(configError("config_invalid", `${key} 非法（须为正整数）`));
    }
  }
  // max_retries 允许 0（= 不重试），与既有语义一致
  if (file["max_retries"] !== undefined && !nonNegativeInt(file["max_retries"])) {
    return err(configError("config_invalid", "max_retries 非法（须为非负整数）"));
  }

  const providersRaw = file["providers"];
  if (!isPlainObject(providersRaw) || Object.keys(providersRaw).length === 0) {
    return err(configError("config_invalid", "providers 缺失或为空（两层清单至少一个 provider）"));
  }
  const providers = new Map<string, { protocol: ProviderProtocol; base_url: string; api_key_env: string | null; api_key: string | null; compat: ProviderCompat; models: ModelEntry[] }>();
  for (const [providerId, entryRaw] of Object.entries(providersRaw)) {
    if (!isPlainObject(entryRaw)) {
      return err(configError("config_invalid", `providers.${providerId} 不是 JSON 对象`));
    }
    const unknownProviderKeys = rejectUnknownKeys(entryRaw, LLM_PROVIDER_KEYS, `providers.${providerId}`);
    if (unknownProviderKeys !== null) return err(unknownProviderKeys);

    const protocolRaw = entryRaw["protocol"];
    if (!nonEmptyString(protocolRaw) || !(PROVIDER_PROTOCOLS as readonly string[]).includes(protocolRaw)) {
      const hint = protocolRaw === "openai-responses"
        ? "openai-responses 只预留 codec 位不实现（硬前提：store:false ＋ 禁用对端服务端工具执行，另批评估）"
        : `允许值：${PROVIDER_PROTOCOLS.join(" | ")}`;
      return err(configError("protocol_unknown", `providers.${providerId}.protocol 非法: ${JSON.stringify(String(protocolRaw ?? null))}。${hint}`));
    }
    const baseUrlRaw = entryRaw["base_url"];
    if (!nonEmptyString(baseUrlRaw)) return err(configError("config_invalid", `providers.${providerId}.base_url 缺失或非法`));
    const base = normalizeBaseUrl(baseUrlRaw);
    if (!base.ok) return err(configError(base.error.code, `providers.${providerId}: ${base.error.message}`));

    const apiKeyEnv = entryRaw["api_key_env"];
    const apiKeyLiteral = entryRaw["api_key"];
    if (apiKeyEnv !== undefined && apiKeyLiteral !== undefined) {
      return err(configError("config_invalid", `providers.${providerId}: api_key_env 与 api_key 并存 → 拒绝（规则 3：凭据只留引用，字面值仅过渡）`));
    }
    if (apiKeyEnv === undefined && apiKeyLiteral === undefined) {
      return err(configError("config_invalid", `providers.${providerId}: 缺少凭据引用（api_key_env 首选；api_key 字面值仅过渡）`));
    }
    if (apiKeyEnv !== undefined && !nonEmptyString(apiKeyEnv)) {
      return err(configError("config_invalid", `providers.${providerId}.api_key_env 非法（须为非空环境变量名）`));
    }
    if (apiKeyLiteral !== undefined && !nonEmptyString(apiKeyLiteral)) {
      return err(configError("config_invalid", `providers.${providerId}.api_key 非法（须为非空字符串）`));
    }

    let compat: ProviderCompat = {};
    if (entryRaw["compat"] !== undefined) {
      if (!isPlainObject(entryRaw["compat"])) return err(configError("config_invalid", `providers.${providerId}.compat 须为 JSON 对象`));
      const unknownCompat = rejectUnknownKeys(entryRaw["compat"], LLM_COMPAT_KEYS, `providers.${providerId}.compat`);
      if (unknownCompat !== null) return err(unknownCompat);
      compat = {
        ...(optionalBoolean(entryRaw["compat"]["supports_developer_role"]) !== undefined
          ? { supports_developer_role: optionalBoolean(entryRaw["compat"]["supports_developer_role"]) }
          : {}),
        ...(optionalBoolean(entryRaw["compat"]["supports_reasoning_effort"]) !== undefined
          ? { supports_reasoning_effort: optionalBoolean(entryRaw["compat"]["supports_reasoning_effort"]) }
          : {}),
      };
    }

    const modelsRaw = entryRaw["models"];
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
      return err(configError("config_invalid", `providers.${providerId}.models 缺失或为空（规则 6）`));
    }
    const models: ModelEntry[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < modelsRaw.length; i += 1) {
      const modelRaw = modelsRaw[i];
      if (!isPlainObject(modelRaw)) return err(configError("config_invalid", `providers.${providerId}.models[${String(i)}] 不是 JSON 对象`));
      const unknownModelKeys = rejectUnknownKeys(modelRaw, LLM_MODEL_KEYS, `providers.${providerId}.models[${String(i)}]`);
      if (unknownModelKeys !== null) return err(unknownModelKeys);
      if (!nonEmptyString(modelRaw["id"])) return err(configError("config_invalid", `providers.${providerId}.models[${String(i)}].id 缺失或非法`));
      const id = modelRaw["id"];
      if (seenIds.has(id)) return err(configError("config_invalid", `providers.${providerId}.models 重复 id "${id}"（规则 6）`));
      seenIds.add(id);
      const reasoning = optionalBoolean(modelRaw["reasoning"]);
      if (modelRaw["reasoning"] !== undefined && reasoning === undefined) {
        return err(configError("config_invalid", `providers.${providerId}.models[${id}].reasoning 非法（须为布尔）`));
      }
      if (modelRaw["reasoning_effort"] !== undefined) {
        if (!nonEmptyString(modelRaw["reasoning_effort"])) return err(configError("config_invalid", `providers.${providerId}.models[${id}].reasoning_effort 非法`));
        const violation = checkReasoningEffort(modelRaw["reasoning_effort"], `providers.${providerId}.models[${id}]`);
        if (violation !== null) return err(violation);
      }
      for (const key of ["max_tokens", "context_window"] as const) {
        if (modelRaw[key] !== undefined && !positiveInt(modelRaw[key])) {
          return err(configError("config_invalid", `providers.${providerId}.models[${id}].${key} 非法（须为正整数）`));
        }
      }
      models.push({
        id,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(modelRaw["reasoning_effort"] !== undefined ? { reasoning_effort: modelRaw["reasoning_effort"] as string } : {}),
        ...(modelRaw["max_tokens"] !== undefined ? { max_tokens: modelRaw["max_tokens"] as number } : {}),
        ...(modelRaw["context_window"] !== undefined ? { context_window: modelRaw["context_window"] as number } : {}),
      });
    }

    providers.set(providerId, {
      protocol: protocolRaw as ProviderProtocol,
      base_url: base.value,
      api_key_env: apiKeyEnv !== undefined ? (apiKeyEnv as string) : null,
      api_key: apiKeyLiteral !== undefined ? (apiKeyLiteral as string) : null,
      compat,
      models,
    });
  }
  return ok({
    default_provider: file["default_provider"] as string,
    default_model: nonEmptyString(file["default_model"]) ? (file["default_model"] as string) : null,
    timeout_ms: file["timeout_ms"] !== undefined ? (file["timeout_ms"] as number) : null,
    max_retries: file["max_retries"] !== undefined ? (file["max_retries"] as number) : null,
    max_calls_per_run: file["max_calls_per_run"] !== undefined ? (file["max_calls_per_run"] as number) : null,
    turn_token_budget: file["turn_token_budget"] !== undefined ? (file["turn_token_budget"] as number) : null,
    providers,
  });
};

const envPositiveInt = (raw: string | undefined, envName: string): Result<number | null, ProviderConfigError> => {
  if (raw === undefined || raw === "") return ok(null);
  const n = Number(raw);
  return positiveInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${envName} 非法（须为正整数）: ${JSON.stringify(raw.slice(0, 32))}`));
};

const envNonNegativeInt = (raw: string | undefined, envName: string): Result<number | null, ProviderConfigError> => {
  if (raw === undefined || raw === "") return ok(null);
  const n = Number(raw);
  return nonNegativeInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${envName} 非法（须为非负整数）`));
};

/**
 * 载入并解析 provider 配置（两层清单 → 选中 provider+model）。
 * 顺序：文件（0600 校验）→ 两层校验 → 选择（env 覆盖默认）→ 旋钮 env 覆盖 → 凭据解析。
 * 一切失败走 Result err（fail-closed），永不抛出。
 */
export const loadLlmProviderConfig = async (env: NodeJS.ProcessEnv = process.env): Promise<Result<ResolvedLlmProviderConfig, ProviderConfigError>> => {
  const configPath = env[PROVIDER_ENV_VARS.configPath];
  if (configPath === undefined || configPath === "") {
    return err(configError("config_unreadable", `${PROVIDER_ENV_VARS.configPath} 未设置——两层清单只能经配置文件表达（唯一规范形态），环境变量仅作选择与旋钮覆盖`));
  }
  const permission = await stat(configPath).then(
    (value) => ok(value),
    (cause: NodeJS.ErrnoException) =>
      err(configError("config_unreadable", `配置文件不可读: ${(cause as Error).message}`, { path: configPath, code: cause.code })),
  );
  if (!permission.ok) return permission;
  const mode = permission.value.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return err(configError("config_permission", `配置文件权限必须为 0600（实得 0${mode.toString(8)}）——拒绝加载（D2 硬约束）`, { path: configPath }));
  }
  const text = await readFile(configPath, "utf8").then(
    (value) => ok(value),
    (cause: NodeJS.ErrnoException) =>
      err(configError("config_unreadable", `配置文件读取失败: ${(cause as Error).message}`, { path: configPath, code: cause.code })),
  );
  if (!text.ok) return text;
  let file: unknown;
  try {
    file = JSON.parse(text.value);
  } catch (cause) {
    return err(configError("config_invalid", `配置文件不是合法 JSON: ${(cause as Error).message}`, { path: configPath }));
  }
  if (!isPlainObject(file)) return err(configError("config_invalid", "配置文件顶层须为 JSON 对象", { path: configPath }));

  const catalog = parseCatalog(file);
  if (!catalog.ok) return catalog;

  // ── 选择（规则 2）：env 覆盖默认；未知 id fail-closed ──
  const providerId = env[PROVIDER_ENV_VARS.provider] !== undefined && env[PROVIDER_ENV_VARS.provider] !== ""
    ? (env[PROVIDER_ENV_VARS.provider] as string)
    : catalog.value.default_provider;
  const provider = catalog.value.providers.get(providerId);
  if (provider === undefined) {
    return err(configError("config_invalid", `选中的 provider 不存在: ${JSON.stringify(providerId)}（fail-closed；可用：${[...catalog.value.providers.keys()].join(", ")}）`));
  }
  const modelId = env[PROVIDER_ENV_VARS.model] !== undefined && env[PROVIDER_ENV_VARS.model] !== ""
    ? (env[PROVIDER_ENV_VARS.model] as string)
    : (catalog.value.default_model ?? provider.models[0]?.id);
  const model = provider.models.find((entry) => entry.id === modelId);
  if (modelId === undefined || model === undefined) {
    return err(configError("config_invalid", `选中的 model 不存在: ${JSON.stringify(String(modelId))}（provider=${providerId}；fail-closed；可用：${provider.models.map((entry) => entry.id).join(", ")}）`));
  }

  // ── 旋钮（规则 7）：env > 文件顶层 > 默认；reasoning_effort/max_tokens：env > 模型级 > 默认 ──
  const timeout = await envPositiveInt(env[PROVIDER_ENV_VARS.timeoutMs], PROVIDER_ENV_VARS.timeoutMs);
  if (!timeout.ok) return timeout;
  const retries = envNonNegativeInt(env[PROVIDER_ENV_VARS.maxRetries], PROVIDER_ENV_VARS.maxRetries);
  if (!retries.ok) return retries;
  const calls = envPositiveInt(env[PROVIDER_ENV_VARS.maxCallsPerRun], PROVIDER_ENV_VARS.maxCallsPerRun);
  if (!calls.ok) return calls;
  const effortSource = env[PROVIDER_ENV_VARS.reasoningEffort] !== undefined && env[PROVIDER_ENV_VARS.reasoningEffort] !== ""
    ? (env[PROVIDER_ENV_VARS.reasoningEffort] as string)
    : (model.reasoning_effort ?? PROVIDER_CONFIG_DEFAULTS.reasoningEffort);
  const effortViolation = checkReasoningEffort(effortSource, PROVIDER_ENV_VARS.reasoningEffort);
  if (effortViolation !== null) return err(effortViolation);
  const maxTokens = await envPositiveInt(env[PROVIDER_ENV_VARS.maxTokens], PROVIDER_ENV_VARS.maxTokens);
  const turnBudget = await envPositiveInt(env[PROVIDER_ENV_VARS.turnTokenBudget], PROVIDER_ENV_VARS.turnTokenBudget);
  if (!turnBudget.ok) return turnBudget;

  // ── 凭据解析（规则 3）：引用 env 缺失/为空 → fail-closed ──
  let apiKey: string;
  if (provider.api_key_env !== null) {
    const resolved = env[provider.api_key_env];
    if (resolved === undefined || resolved === "") {
      return err(configError("config_invalid", `凭据引用解析失败：环境变量 ${provider.api_key_env} 缺失或为空（provider=${providerId}，fail-closed）`));
    }
    apiKey = resolved;
  } else {
    apiKey = provider.api_key as string; // 过渡字面值（文档标注不推荐；仓内配置与 fixture 禁用）
  }

  return ok({
    provider_id: providerId,
    protocol: provider.protocol,
    base_url: provider.base_url,
    api_key: apiKey,
    model: model.id,
    reasoning: model.reasoning ?? false,
    reasoning_effort: effortSource,
    max_tokens: maxTokens.ok && maxTokens.value !== null ? maxTokens.value : (model.max_tokens ?? PROVIDER_CONFIG_DEFAULTS.maxTokens),
    context_window: model.context_window ?? null,
    compat: {
      supports_developer_role: provider.compat.supports_developer_role ?? false,
      supports_reasoning_effort: provider.compat.supports_reasoning_effort ?? true,
    },
    timeout_ms: timeout.value ?? catalog.value.timeout_ms ?? PROVIDER_CONFIG_DEFAULTS.timeoutMs,
    max_retries: retries.value ?? catalog.value.max_retries ?? PROVIDER_CONFIG_DEFAULTS.maxRetries,
    max_calls_per_run: calls.value ?? catalog.value.max_calls_per_run ?? PROVIDER_CONFIG_DEFAULTS.maxCallsPerRun,
    turn_token_budget: turnBudget.value ?? catalog.value.turn_token_budget ?? null,
  });
};
