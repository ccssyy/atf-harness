/**
 * L1a 门 2 修订 v2——配置层测试（任务书 v2 §3 VERIFY 1/2/3/5/6/7 配置侧）。
 * 两层正例与选择 / 凭据引用 / fail-closed 校验 / env 覆盖。
 * 全部配置文件为测试运行期生成于临时目录（0600）；**仓内 fixture 零明文凭据**——
 * 唯一出现的 "api_key" 字面值场景 = 反例用例，值为显式 fake 标记（非凭据）。
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  LLM_CONFIG_SCHEMA_VERSION,
  PROVIDER_ENV_VARS,
  loadLlmProviderConfig,
} from "../../src/llm/index.js";

/** fake 标记凭据值（仅运行期注入环境变量；显式标注，非真实凭据）。 */
const FAKE_KEY = "fake-v2-config-key-DO-NOT-USE";
const KEY_ENV = "ATF_LLM_TEST_KEY_V2";
/** 并存/过渡反例的字面值（显式 fake 标记，非凭据；仅运行期临时文件）。 */
const FAKE_LITERAL = "fake-transitional-marker-DO-NOT-USE";

let workDir: string;

beforeEach(async () => {
  workDir = join(tmpdir(), `atf-l1a-cfgv2-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const writeConfig = async (body: unknown, mode = 0o600): Promise<string> => {
  const path = join(workDir, "llm.config.json");
  await writeFile(path, JSON.stringify(body), { mode });
  await chmod(path, mode);
  return path;
};

/** 两层正例基底（多 provider × 多 model；凭据全走引用）。 */
const CATALOG = {
  schema_version: LLM_CONFIG_SCHEMA_VERSION,
  default_provider: "deepseek",
  default_model: "deepseek-flash",
  providers: {
    deepseek: {
      protocol: "openai-chat",
      base_url: "http://127.0.0.1:9",
      api_key_env: KEY_ENV,
      models: [
        { id: "deepseek-flash", reasoning: true, max_tokens: 4096 },
        { id: "deepseek-v4-pro", reasoning: true, reasoning_effort: "max", max_tokens: 8192, context_window: 131072 },
      ],
    },
    "deepseek-anthropic": {
      protocol: "anthropic-messages",
      base_url: "http://127.0.0.1:10/anthropic",
      api_key_env: KEY_ENV,
      compat: { supports_reasoning_effort: false },
      models: [{ id: "deepseek-v4-pro", reasoning: true, max_tokens: 8192 }],
    },
  },
};

const ENV = (configPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  [PROVIDER_ENV_VARS.configPath]: configPath,
  [KEY_ENV]: FAKE_KEY,
  ...extra,
});

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(CATALOG)) as Record<string, unknown>;

const providersOf = (body: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  body["providers"] as Record<string, Record<string, unknown>>;
const deepseekOf = (body: Record<string, unknown>): Record<string, unknown> =>
  providersOf(body)["deepseek"] as Record<string, unknown>;
const deepseekModels = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
  (providersOf(body)["deepseek"] as { models: Array<Record<string, unknown>> }).models;

describe("VERIFY 1——两层正例与默认选择", () => {
  it("多 provider × 多 model 加载；default_provider/default_model 生效", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG)));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.provider_id).toBe("deepseek");
    expect(loaded.value.model).toBe("deepseek-flash");
    expect(loaded.value.protocol).toBe("openai-chat");
    expect(loaded.value.base_url).toBe("http://127.0.0.1:9");
    expect(loaded.value.reasoning).toBe(true);
    expect(loaded.value.max_tokens).toBe(4096);
    expect(loaded.value.context_window).toBeNull();
    expect(loaded.value.compat).toEqual({ supports_developer_role: false, supports_reasoning_effort: true });
  });

  it("default_model 省略 → models[0] 兜底（顺序即默认）", async () => {
    const body = clone();
    delete body["default_model"];
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.model).toBe("deepseek-flash");
  });

  it("compat 生效：anthropic provider 声明 supports_reasoning_effort:false", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), {
      [PROVIDER_ENV_VARS.provider]: "deepseek-anthropic",
      // default_model 是"选中 provider 内"的默认——跨 provider 未声明该模型时须经 env 显式选择
      [PROVIDER_ENV_VARS.model]: "deepseek-v4-pro",
    }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.compat.supports_reasoning_effort).toBe(false);
    expect(loaded.value.max_tokens).toBe(8192);
  });
});

describe("VERIFY 2——选择 fail-closed", () => {
  it("ATF_LLM_PROVIDER 指到未知 provider → 拒绝", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), { [PROVIDER_ENV_VARS.provider]: "ghost" }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("provider 不存在");
  });

  it("ATF_LLM_MODEL 指到未知 model → 拒绝", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), { [PROVIDER_ENV_VARS.model]: "ghost-model" }));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("model 不存在");
  });

  it("缺 default_provider → 拒绝", async () => {
    const body = clone();
    delete body["default_provider"];
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("default_provider");
  });

  it("env 选择覆盖默认；模型级元数据按选中模型生效（VERIFY 5 配置侧）", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), { [PROVIDER_ENV_VARS.model]: "deepseek-v4-pro" }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.model).toBe("deepseek-v4-pro");
    expect(loaded.value.reasoning_effort).toBe("max"); // 模型级 reasoning_effort
    expect(loaded.value.max_tokens).toBe(8192);
    expect(loaded.value.context_window).toBe(131072);
  });
});

describe("VERIFY 3——凭据只留引用", () => {
  it("api_key_env 正常解析（值不落配置文件）", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG)));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.api_key).toBe(FAKE_KEY);
  });

  it("引用的环境变量缺失/为空 → 拒绝", async () => {
    const path = await writeConfig(CATALOG);
    const missing = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain(KEY_ENV);
    const empty = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path, [KEY_ENV]: "" });
    expect(empty.ok).toBe(false);
  });

  it("api_key_env 与 api_key 并存 → 拒绝（规则 3）", async () => {
    const body = clone();
    deepseekOf(body)["api_key"] = FAKE_LITERAL;
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("并存");
  });

  it("api_key 字面值（过渡）可单独使用——仅运行期临时文件，不入仓", async () => {
    const body = clone();
    const deepseek = deepseekOf(body);
    delete deepseek["api_key_env"];
    deepseek["api_key"] = FAKE_LITERAL;
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: await writeConfig(body) });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.api_key).toBe(FAKE_LITERAL);
  });
});

describe("VERIFY 6——校验 fail-closed（规则 6）", () => {
  it("未知顶层键拒绝", async () => {
    const body = clone();
    body["mystery"] = 1;
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain("mystery");
  });

  it("未知 provider 键拒绝", async () => {
    const body = clone();
    deepseekOf(body)["mystery"] = 1;
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain("mystery");
  });

  it("未知模型键拒绝", async () => {
    const body = clone();
    (deepseekModels(body)[0] as Record<string, unknown>)["mystery"] = 1;
    expect((await loadLlmProviderConfig(ENV(await writeConfig(body)))).ok).toBe(false);
  });

  it("缺 protocol / 缺 base_url / 缺 models / 空 models 拒绝", async () => {
    for (const mutate of [
      (deepseek: Record<string, unknown>) => { delete deepseek["protocol"]; },
      (deepseek: Record<string, unknown>) => { delete deepseek["base_url"]; },
      (deepseek: Record<string, unknown>) => { delete deepseek["models"]; },
      (deepseek: Record<string, unknown>) => { deepseek["models"] = []; },
    ]) {
      const body = clone();
      mutate(deepseekOf(body));
      const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
      expect(loaded.ok, JSON.stringify(loaded)).toBe(false);
    }
  });

  it("重复模型 id 拒绝", async () => {
    const body = clone();
    deepseekModels(body).push({ id: "deepseek-flash" });
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain("重复");
  });

  it("base_url 内嵌 userinfo 凭据拒绝（ADR-09 红线）", async () => {
    const body = clone();
    deepseekOf(body)["base_url"] = "http://user:pass@127.0.0.1:9";
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(body)));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain("userinfo");
  });

  it("schema_version 缺失/不符拒绝；providers 空拒绝；未知 protocol 拒绝（openai-responses 预留位提示）", async () => {
    expect((await loadLlmProviderConfig(ENV(await writeConfig({ ...CATALOG, schema_version: "HarnessLlmConfig/v2" })))).ok).toBe(false);
    const missing = clone();
    delete missing["schema_version"];
    expect((await loadLlmProviderConfig(ENV(await writeConfig(missing)))).ok).toBe(false);
    expect((await loadLlmProviderConfig(ENV(await writeConfig({ ...CATALOG, providers: {} })))).ok).toBe(false);
    const responses = clone();
    deepseekOf(responses)["protocol"] = "openai-responses";
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(responses)));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("protocol_unknown");
  });

  it("权限非 0600 拒绝（D2 硬约束延续）", async () => {
    const path = await writeConfig(CATALOG, 0o644);
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path, [KEY_ENV]: FAKE_KEY });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("config_permission");
  });

  it("ATF_LLM_CONFIG 未设置 → 拒绝（两层清单只能经文件表达）", async () => {
    const loaded = await loadLlmProviderConfig({ [KEY_ENV]: FAKE_KEY });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("config_unreadable");
  });

  it('reasoning_effort="none" 拒绝（模型级与 env 同拦）', async () => {
    const body = clone();
    (deepseekModels(body)[0] as Record<string, unknown>)["reasoning_effort"] = "none";
    expect((await loadLlmProviderConfig(ENV(await writeConfig(body)))).ok).toBe(false);
    const viaEnv = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), { [PROVIDER_ENV_VARS.reasoningEffort]: "none" }));
    expect(viaEnv.ok).toBe(false);
  });
});

describe("VERIFY 7——env 覆盖（规则 7，作用于选中 provider/model）", () => {
  it("TIMEOUT_MS / MAX_RETRIES / MAX_CALLS_PER_RUN 覆盖文件顶层与默认", async () => {
    const path = await writeConfig({ ...CATALOG, timeout_ms: 1234, max_retries: 0, max_calls_per_run: 7 });
    const loaded = await loadLlmProviderConfig(ENV(path, {
      [PROVIDER_ENV_VARS.timeoutMs]: "9999",
      [PROVIDER_ENV_VARS.maxCallsPerRun]: "11",
    }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.timeout_ms).toBe(9999); // env > 文件
    expect(loaded.value.max_retries).toBe(0); // 文件顶层生效
    expect(loaded.value.max_calls_per_run).toBe(11); // env > 文件
  });

  it("REASONING_EFFORT / MAX_TOKENS 覆盖模型级元数据", async () => {
    const path = await writeConfig(CATALOG);
    const loaded = await loadLlmProviderConfig(ENV(path, {
      [PROVIDER_ENV_VARS.model]: "deepseek-v4-pro",
      [PROVIDER_ENV_VARS.reasoningEffort]: "high",
      [PROVIDER_ENV_VARS.maxTokens]: "2048",
    }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.reasoning_effort).toBe("high");
    expect(loaded.value.max_tokens).toBe(2048);
  });

  it("env 数值非法 → 拒绝", async () => {
    const loaded = await loadLlmProviderConfig(ENV(await writeConfig(CATALOG), { [PROVIDER_ENV_VARS.maxCallsPerRun]: "abc" }));
    expect(loaded.ok).toBe(false);
  });
});
