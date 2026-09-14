/**
 * L1a 门 2——provider 配置层（《ATF独立Harness_L1a门2任务书_20260914.md》§1.1 / D2 / D5 / D6）。
 *
 * 配置键（七键 + 两个协议面必要可选键，扩充登记见条款级完成清单「惯例与登记项」）：
 *   protocol / base_url / api_key / model / timeout_ms / max_retries / max_calls_per_run
 *   ＋ reasoning_effort（openai-chat 显式携带，任务书 §1.2；显式 "none" 拒绝——GPT-5.4 起
 *     chat 面 reasoning:none 下工具调用不受支持，本 loop 依赖工具调用）
 *   ＋ max_tokens（anthropic-messages 线缆协议必填字段，默认 4096）
 *
 * 读取顺序：环境变量覆盖配置文件（D2：环境变量便于临时试用、不落盘）。
 * 配置文件：路径由 owner 经 ATF_LLM_CONFIG 指定（不入仓）；权限必须 0600（D2 硬约束，
 * group/other 任一位存在即拒绝）。
 *
 * fail-closed 纪律：
 *   - 未知 protocol / 未知配置键 / 缺 model / 缺 api_key / base_url 非法 → 结构化拒绝，不猜测回退；
 *   - openai-responses 只预留 codec 位（设计 §1.1 治理边界：对端 agentic loop 绕开守卫与
 *     逐工具审批 + 服务端存储，两条硬前提未满足前不得接入）；
 *   - base_url 内嵌凭据（userinfo）→ 拒绝（ADR-09 红线：凭据只在出站请求头出现）；
 *   - 本模块产物含 api_key，**只能**交给 HttpLlmProvider 私有持有——严禁序列化进事件/载荷/报告。
 */
import { readFile, stat } from "node:fs/promises";
import { err, ok, type Result } from "../bridge/index.js";

/** 协议面 v1（D6）：两个 codec；openai-responses 只预留位。 */
export type ProviderProtocol = "openai-chat" | "anthropic-messages";

export const PROVIDER_PROTOCOLS: readonly ProviderProtocol[] = ["openai-chat", "anthropic-messages"];

/** 配置键闭集（未知键 fail-closed——与全仓 schema 同哲学）。 */
export const PROVIDER_CONFIG_KEYS: readonly string[] = [
  "protocol",
  "base_url",
  "api_key",
  "model",
  "timeout_ms",
  "max_retries",
  "max_calls_per_run",
  "reasoning_effort",
  "max_tokens",
];

/** 环境变量名（覆盖配置文件同名键；文件路径本身由 ATF_LLM_CONFIG 指定）。 */
export const PROVIDER_ENV_VARS = {
  configPath: "ATF_LLM_CONFIG",
  protocol: "ATF_LLM_PROTOCOL",
  baseUrl: "ATF_LLM_BASE_URL",
  apiKey: "ATF_LLM_API_KEY",
  model: "ATF_LLM_MODEL",
  timeoutMs: "ATF_LLM_TIMEOUT_MS",
  maxRetries: "ATF_LLM_MAX_RETRIES",
  maxCallsPerRun: "ATF_LLM_MAX_CALLS_PER_RUN",
  reasoningEffort: "ATF_LLM_REASONING_EFFORT",
  maxTokens: "ATF_LLM_MAX_TOKENS",
} as const;

/** 默认值（收在常量层，模型不可见；理由登记于设计文档增补）。 */
export const PROVIDER_CONFIG_DEFAULTS = {
  protocol: "openai-chat" as ProviderProtocol,
  timeoutMs: 60_000,
  maxRetries: 1,
  /** D5：单 run 调用次数上限默认 50；与轮次预算（32/8）是两件事。 */
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

const configError = (code: ProviderConfigErrorCode, message: string, detail?: unknown): { code: ProviderConfigErrorCode; message: string; detail?: unknown } => {
  const error: ProviderConfigError = { code, message };
  if (detail !== undefined) error.detail = detail;
  return error;
};

/** 已解析配置（含 api_key——私有面，禁止序列化进事件/载荷/报告）。 */
export interface ResolvedLlmProviderConfig {
  protocol: ProviderProtocol;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
  max_retries: number;
  max_calls_per_run: number;
  reasoning_effort: string;
  max_tokens: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/** 正整数（>0）。 */
const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** 非负整数（≥0，max_retries 允许 0 = 不重试）。 */
const nonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

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
    return err(configError("config_invalid", "base_url 不得内嵌凭据（userinfo）——api_key 只允许经配置键注入出站请求头"));
  }
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return ok(normalized);
};

/** 单键解析（文件值已被 env 覆盖后的合并视图 → 强类型）。 */
const resolveConfig = (merged: Record<string, unknown>): Result<ResolvedLlmProviderConfig, ProviderConfigError> => {
  for (const key of Object.keys(merged)) {
    if (!PROVIDER_CONFIG_KEYS.includes(key)) {
      return err(configError("config_invalid", `未知配置键 "${key}"（fail-closed；允许键：${PROVIDER_CONFIG_KEYS.join(", ")}）`));
    }
  }

  const protocolRaw = merged["protocol"] ?? PROVIDER_CONFIG_DEFAULTS.protocol;
  if (!nonEmptyString(protocolRaw) || !(PROVIDER_PROTOCOLS as readonly string[]).includes(protocolRaw)) {
    // openai-responses 单列提示（预留位语义，设计 §1.1 治理边界）
    const hint = protocolRaw === "openai-responses"
      ? "openai-responses 只预留 codec 位不实现（硬前提：store:false ＋ 禁用对端服务端工具执行，另批评估）"
      : `允许值：${PROVIDER_PROTOCOLS.join(" | ")}`;
    return err(configError("protocol_unknown", `未知 protocol: ${JSON.stringify(String(protocolRaw))}（fail-closed，不猜测回退）。${hint}`));
  }
  const protocol = protocolRaw as ProviderProtocol;

  const baseUrlRaw = merged["base_url"];
  if (!nonEmptyString(baseUrlRaw)) return err(configError("config_invalid", "base_url 缺失或非法（须为非空字符串）"));
  const base = normalizeBaseUrl(baseUrlRaw);
  if (!base.ok) return base;

  if (!nonEmptyString(merged["api_key"])) {
    return err(configError("config_invalid", "api_key 缺失或非法（须为非空字符串；由 owner 写入配置文件或经环境变量注入）"));
  }
  if (!nonEmptyString(merged["model"])) {
    return err(configError("config_invalid", "model 缺失或非法（须为非空字符串）"));
  }

  const timeoutRaw = merged["timeout_ms"] ?? PROVIDER_CONFIG_DEFAULTS.timeoutMs;
  if (!positiveInt(timeoutRaw)) return err(configError("config_invalid", "timeout_ms 非法（须为正整数）"));
  const retriesRaw = merged["max_retries"] ?? PROVIDER_CONFIG_DEFAULTS.maxRetries;
  if (!nonNegativeInt(retriesRaw)) return err(configError("config_invalid", "max_retries 非法（须为非负整数）"));
  const callsRaw = merged["max_calls_per_run"] ?? PROVIDER_CONFIG_DEFAULTS.maxCallsPerRun;
  if (!positiveInt(callsRaw)) return err(configError("config_invalid", "max_calls_per_run 非法（须为正整数）"));

  const reasoningRaw = merged["reasoning_effort"] ?? PROVIDER_CONFIG_DEFAULTS.reasoningEffort;
  if (!nonEmptyString(reasoningRaw)) return err(configError("config_invalid", "reasoning_effort 非法（须为非空字符串）"));
  if (reasoningRaw === "none") {
    return err(configError(
      "config_invalid",
      'reasoning_effort="none" 拒绝：GPT-5.4 起 chat 面 reasoning:none 下工具调用不受支持（任务书 §1.2），本 loop 依赖工具调用',
    ));
  }

  const maxTokensRaw = merged["max_tokens"] ?? PROVIDER_CONFIG_DEFAULTS.maxTokens;
  if (!positiveInt(maxTokensRaw)) return err(configError("config_invalid", "max_tokens 非法（须为正整数）"));

  return ok({
    protocol,
    base_url: base.value,
    api_key: merged["api_key"] as string,
    model: merged["model"] as string,
    timeout_ms: timeoutRaw,
    max_retries: retriesRaw,
    max_calls_per_run: callsRaw,
    reasoning_effort: reasoningRaw,
    max_tokens: maxTokensRaw,
  });
};

/** 环境变量覆盖（字符串值按目标键类型解析；非法数值 → fail-closed）。 */
const applyEnvOverrides = (fileConfig: Record<string, unknown>, env: NodeJS.ProcessEnv): Result<Record<string, unknown>, ProviderConfigError> => {
  const merged: Record<string, unknown> = { ...fileConfig };
  const overrides: ReadonlyArray<[string, string, (raw: string) => Result<unknown, ProviderConfigError>]> = [
    [PROVIDER_ENV_VARS.protocol, "protocol", (raw) => ok(raw)],
    [PROVIDER_ENV_VARS.baseUrl, "base_url", (raw) => ok(raw)],
    [PROVIDER_ENV_VARS.apiKey, "api_key", (raw) => ok(raw)],
    [PROVIDER_ENV_VARS.model, "model", (raw) => ok(raw)],
    [
      PROVIDER_ENV_VARS.timeoutMs,
      "timeout_ms",
      (raw) => {
        const n = Number(raw);
        return positiveInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${PROVIDER_ENV_VARS.timeoutMs} 非法（须为正整数）: ${JSON.stringify(raw.slice(0, 32))}`));
      },
    ],
    [
      PROVIDER_ENV_VARS.maxRetries,
      "max_retries",
      (raw) => {
        const n = Number(raw);
        return nonNegativeInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${PROVIDER_ENV_VARS.maxRetries} 非法（须为非负整数）`));
      },
    ],
    [
      PROVIDER_ENV_VARS.maxCallsPerRun,
      "max_calls_per_run",
      (raw) => {
        const n = Number(raw);
        return positiveInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${PROVIDER_ENV_VARS.maxCallsPerRun} 非法（须为正整数）`));
      },
    ],
    [PROVIDER_ENV_VARS.reasoningEffort, "reasoning_effort", (raw) => ok(raw)],
    [
      PROVIDER_ENV_VARS.maxTokens,
      "max_tokens",
      (raw) => {
        const n = Number(raw);
        return positiveInt(n) ? ok(n) : err(configError("config_invalid", `环境变量 ${PROVIDER_ENV_VARS.maxTokens} 非法（须为正整数）`));
      },
    ],
  ];
  for (const [envName, configKey, parse] of overrides) {
    const raw = env[envName];
    if (raw === undefined || raw === "") continue;
    const parsed = parse(raw);
    if (!parsed.ok) return parsed;
    merged[configKey] = parsed.value;
  }
  return ok(merged);
};

/** 配置文件权限断言（D2 硬约束：0600——group/other 任一位存在即拒绝）。 */
const assertFilePermission = async (path: string): Promise<Result<{ mode: number }, ProviderConfigError>> => {
  const info = await stat(path).then(
    (value) => ok(value),
    (cause: NodeJS.ErrnoException) =>
      err({
        code: "config_unreadable" as const,
        message: `配置文件不可读: ${(cause as Error).message}`,
        detail: { path, code: cause.code },
      }),
  );
  if (!info.ok) return info;
  const mode = info.value.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return err(configError("config_permission", `配置文件权限必须为 0600（实得 0${mode.toString(8)}）——拒绝加载（D2 硬约束）`, { path }));
  }
  return ok({ mode });
};

/**
 * 载入 provider 配置：ATF_LLM_CONFIG 指向的 JSON 文件（0600）＋ 环境变量覆盖。
 * env 提供全部键时可不设文件（D2：环境变量便于临时试用，不落盘）。
 * 一切失败走 Result err（fail-closed），永不抛出。
 */
export const loadLlmProviderConfig = async (env: NodeJS.ProcessEnv = process.env): Promise<Result<ResolvedLlmProviderConfig, ProviderConfigError>> => {
  let fileConfig: Record<string, unknown> = {};
  const configPath = env[PROVIDER_ENV_VARS.configPath];
  if (configPath !== undefined && configPath !== "") {
    const permission = await assertFilePermission(configPath);
    if (!permission.ok) return permission;
    const text = await readFile(configPath, "utf8").then(
      (value) => ok(value),
      (cause: NodeJS.ErrnoException) =>
        err({
          code: "config_unreadable" as const,
          message: `配置文件读取失败: ${(cause as Error).message}`,
          detail: { path: configPath, code: cause.code },
        }),
    );
    if (!text.ok) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.value);
    } catch (cause) {
      return err(configError("config_invalid", `配置文件不是合法 JSON: ${(cause as Error).message}`, { path: configPath }));
    }
    if (!isPlainObject(parsed)) {
      return err(configError("config_invalid", "配置文件顶层须为 JSON 对象", { path: configPath }));
    }
    fileConfig = parsed;
  }

  const merged = applyEnvOverrides(fileConfig, env);
  if (!merged.ok) return merged;
  return resolveConfig(merged.value);
};
