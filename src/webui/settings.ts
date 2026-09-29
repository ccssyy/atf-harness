/**
 * 批⑭（2026-09-29，指令 a79b1883）——WebUI 设置存储与模型/effort 运行时热切。
 *
 * 分层口径（owner 已确认）：loop/框架主参考 pi（pi-ai provider 注册表实现运行时切换——
 * provider/effort 换实例即生效，不重启 loop）；设置界面形态对照宿主同行（CC settings.json /
 * Codex config.toml）。**key 红线：配置文件与所有 GET/日志/对话流只存 env 变量名引用
 * （Codex env_key 纪律），GET 面仅附脱敏尾 4 位（取自 env 实值）。**
 *
 * 审批三档（owner"不能静默"的档位化）：逐卡确认（缺省）/危险动作必确认/演示模式（只读
 * 白名单自动放行、管线写仍逐卡——永不全免）。切换即时生效于新 turn；已挂起卡不受影响。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------- 类型

export interface ProviderEntry {
  id: string;
  name: string;
  base_url: string;
  /** env 变量名引用（key 明文永不入配置/GET/日志——Codex env_key 纪律） */
  api_key_env: string;
  models: Array<{ id: string; context_window: number; effort_supported: boolean }>;
  default_model: string;
}

export type ApprovalPolicy = "per_card" | "danger_only" | "demo";
export type ScenarioProfileId = "first_train" | "walkthrough" | "demo";

export interface EnvProfileSettings {
  train_env: string;
  eval_env: string;
  gpu_visible_devices: string;
  master_port: number;
  base_model_dir: string;
}

export interface SettingsDoc {
  schema_version: "WebUiSettings/v1";
  providers: ProviderEntry[];
  default_provider: string;
  approval_policy: ApprovalPolicy;
  env_profile: EnvProfileSettings;
  profile: ScenarioProfileId;
}

/** 上下文窗口 per-model 覆盖（区 1：数字输入，缺省按 provider 预设）——providers.json 内嵌。 */
export type ContextWindowOverrides = Record<string, number>;

/** 审批三档语义表（行为单源：demo 档只读白名单自动放行，管线写仍逐卡——永不全免）。 */
export const APPROVAL_POLICIES: ReadonlyArray<{ id: ApprovalPolicy; label: string; behavior: string }> = [
  { id: "per_card", label: "逐卡确认", behavior: "每个 confirm_card / danger_confirm 都要人应答（缺省）" },
  { id: "danger_only", label: "危险动作必确认", behavior: "配置/发布确认可批量放行（单 run 一次应答）；train.sh 真跑仍必确认" },
  { id: "demo", label: "演示模式", behavior: "只读白名单自动放行；管线写操作仍逐卡（永不全免）" },
];

/** 场景 Profiles（区 4 预设捆绑；切换在会话头显示档位徽标）。 */
export const SCENARIO_PROFILES: ReadonlyArray<{ id: ScenarioProfileId; label: string; approval_policy: ApprovalPolicy; notes: string }> = [
  { id: "first_train", label: "首训档", approval_policy: "per_card", notes: "小批＋逐卡确认＋DRY_RUN" },
  { id: "walkthrough", label: "走查档", approval_policy: "per_card", notes: "严确认＋GLM 线" },
  { id: "demo", label: "演示档", approval_policy: "demo", notes: "审批策略=演示模式（只读白名单自动放行）" },
];

/** pi-ai 语义 provider 预设（缺省注册表；GLM/DeepSeek 两条既有授权线）。 */
export const PROVIDER_PRESETS: ReadonlyArray<{ id: string; name: string; base_url: string; api_key_env: string; models: ProviderEntry["models"] }> = [
  {
    id: "zai-coding-cn",
    name: "GLM（智谱）",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    api_key_env: "ATF_LLM_KEY_GLM",
    models: [
      { id: "glm-5.3-flash", context_window: 200_000, effort_supported: true },
      { id: "glm-5.3", context_window: 200_000, effort_supported: true },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com",
    api_key_env: "ATF_LLM_KEY_DEEPSEEK",
    models: [{ id: "deepseek-flash", context_window: 160_000, effort_supported: false }],
  },
];

const DEFAULT_SETTINGS = (): SettingsDoc => ({
  schema_version: "WebUiSettings/v1",
  providers: PROVIDER_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    base_url: preset.base_url,
    api_key_env: preset.api_key_env,
    models: preset.models.map((model) => ({ ...model })),
    default_model: preset.models[0]?.id ?? "",
  })),
  default_provider: "zai-coding-cn",
  approval_policy: "per_card",
  env_profile: { train_env: "system", eval_env: "", gpu_visible_devices: "auto", master_port: 29517, base_model_dir: "" },
  profile: "first_train",
});

// ---------------------------------------------------------------- 读写（热生效）

const loadDoc = (settingsPath: string): SettingsDoc => {
  if (!existsSync(settingsPath)) return DEFAULT_SETTINGS();
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<SettingsDoc>;
    const fallback = DEFAULT_SETTINGS();
    return {
      schema_version: "WebUiSettings/v1",
      providers: Array.isArray(parsed.providers) && parsed.providers.length > 0 ? (parsed.providers as ProviderEntry[]) : fallback.providers,
      default_provider: typeof parsed.default_provider === "string" ? parsed.default_provider : fallback.default_provider,
      approval_policy: parsed.approval_policy ?? fallback.approval_policy,
      env_profile: { ...fallback.env_profile, ...(typeof parsed.env_profile === "object" && parsed.env_profile !== null ? parsed.env_profile : {}) },
      profile: parsed.profile ?? fallback.profile,
    };
  } catch {
    return DEFAULT_SETTINGS();
  }
};

export interface SettingsStore {
  readonly path: string;
  get(): SettingsDoc;
  put(patch: Partial<SettingsDoc>): SettingsDoc;
  /** env 变量名 → 实值尾 4 位（GET 面脱敏展示；env 未设 → null）。 */
  keyTail(apiKeyEnv: string, env?: NodeJS.ProcessEnv): string | null;
  /** 测试连接：真实列模型请求（GET base_url/models 或 chat/completions 探针）；返回模型清单或 HTTP 状态＋原因。 */
  testProvider(provider: ProviderEntry, env?: NodeJS.ProcessEnv): Promise<{ ok: true; models: string[] } | { ok: false; status?: number; reason: string }>;
}

export const openSettingsStore = (settingsPath: string): SettingsStore => ({
  path: settingsPath,
  get: () => loadDoc(settingsPath),
  put: (patch: Partial<SettingsDoc>): SettingsDoc => {
    const next = { ...loadDoc(settingsPath), ...patch, schema_version: "WebUiSettings/v1" as const };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(next, null, 1)}\n`, "utf8");
    return next;
  },
  keyTail: (apiKeyEnv: string, env: NodeJS.ProcessEnv = process.env): string | null => {
    const value = env[apiKeyEnv]?.trim();
    return value !== undefined && value.length >= 4 ? value.slice(-4) : null;
  },
  testProvider: async (provider: ProviderEntry, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; models: string[] } | { ok: false; status?: number; reason: string }> => {
    const apiKey = env[provider.api_key_env]?.trim() ?? "";
    if (apiKey === "") return { ok: false, reason: `env ${provider.api_key_env} 未设置——凭据 env-only，不入配置文件` };
    try {
      const response = await fetch(`${provider.base_url.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, status: response.status, reason: `HTTP ${String(response.status)}` };
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? []).map((entry) => String(entry.id ?? "")).filter((id) => id !== "");
      return models.length > 0 ? { ok: true, models } : { ok: false, status: response.status, reason: "响应无模型清单" };
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  },
});

/** GET 脱敏投影（红线：任何 GET 不得返回 key 明文——只回 env 变量名＋脱敏尾 4 位）。 */
export const redactProviders = (providers: ProviderEntry[], keyTail: (envName: string) => string | null): Array<ProviderEntry & { key_tail: string | null }> =>
  providers.map((provider) => ({ ...provider, key_tail: keyTail(provider.api_key_env) }));

/** 上下文计量（§二.2）：粗估＝字符数/2（与 compaction 同一除数口径）。 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 2);

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  remainingTokens: number;
  remainingRatio: number;
  /** 剩余 <20% → 琥珀提示（只提示不强制） */
  low: boolean;
}

export const computeContextUsage = (usedTokens: number, contextWindow: number): ContextUsage => {
  const safeWindow = contextWindow > 0 ? contextWindow : 1;
  const remaining = Math.max(0, safeWindow - usedTokens);
  return { usedTokens, contextWindow: safeWindow, remainingTokens: remaining, remainingRatio: remaining / safeWindow, low: remaining / safeWindow < 0.2 };
};

/** env-profile 回写路径（内核既有档案机制 `~/.atf/env-profiles/webui-default.json`——不新造存储）。 */
export const envProfilePath = (home: string): string => join(home, ".atf", "env-profiles", "webui-default.json");

export const writeEnvProfile = (home: string, profile: EnvProfileSettings): string => {
  const path = envProfilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema_version: "EnvProfile/webui-default/v1", ...profile }, null, 1)}\n`, "utf8");
  return path;
};
