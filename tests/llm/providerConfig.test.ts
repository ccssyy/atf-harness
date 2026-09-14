/**
 * L1a 门 2 VERIFY 1——配置层（《ATF独立Harness_L1a门2任务书_20260914.md》§3.1）。
 * 环境变量覆盖文件 / 未知 protocol 拒绝 / 缺 model 拒绝 / 权限与形状 fail-closed。
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { PROVIDER_ENV_VARS, loadLlmProviderConfig } from "../../src/llm/index.js";

/** 显式标注 fake 的假 key（仅测试运行期存在于临时目录；不入仓）。 */
const FAKE_KEY = "fake-config-test-key-DO-NOT-USE";

let workDir: string;

beforeEach(async () => {
  workDir = join(tmpdir(), `atf-l1a-cfg-${randomUUID()}`);
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

const FILE_BODY = {
  protocol: "openai-chat",
  base_url: "http://127.0.0.1:9",
  api_key: FAKE_KEY,
  model: "fake-model-config",
};

describe("配置层——文件加载与默认值", () => {
  it("合法配置加载成功；默认值补齐（timeout/retries/max_calls/reasoning/max_tokens）", async () => {
    const path = await writeConfig(FILE_BODY);
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.protocol).toBe("openai-chat");
    expect(loaded.value.model).toBe("fake-model-config");
    expect(loaded.value.base_url).toBe("http://127.0.0.1:9");
    expect(loaded.value.timeout_ms).toBe(60_000);
    expect(loaded.value.max_retries).toBe(1);
    expect(loaded.value.max_calls_per_run).toBe(50);
    expect(loaded.value.reasoning_effort).toBe("low");
    expect(loaded.value.max_tokens).toBe(4096);
  });

  it("base_url 尾斜杠规格化", async () => {
    const path = await writeConfig({ ...FILE_BODY, base_url: "http://127.0.0.1:9/" });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.base_url).toBe("http://127.0.0.1:9");
  });

  it("无文件且无 env → fail-closed（缺 base_url/api_key/model）", async () => {
    const loaded = await loadLlmProviderConfig({});
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("config_invalid");
  });
});

describe("配置层——环境变量覆盖（D2）", () => {
  it("env 覆盖文件同名键（model 与 base_url）", async () => {
    const path = await writeConfig(FILE_BODY);
    const loaded = await loadLlmProviderConfig({
      [PROVIDER_ENV_VARS.configPath]: path,
      [PROVIDER_ENV_VARS.model]: "env-model-override",
      [PROVIDER_ENV_VARS.baseUrl]: "http://127.0.0.1:10",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.model).toBe("env-model-override");
    expect(loaded.value.base_url).toBe("http://127.0.0.1:10");
  });

  it("env 可独立供全键（无配置文件）", async () => {
    const loaded = await loadLlmProviderConfig({
      [PROVIDER_ENV_VARS.protocol]: "anthropic-messages",
      [PROVIDER_ENV_VARS.baseUrl]: "http://127.0.0.1:11",
      [PROVIDER_ENV_VARS.apiKey]: FAKE_KEY,
      [PROVIDER_ENV_VARS.model]: "env-only-model",
      [PROVIDER_ENV_VARS.maxCallsPerRun]: "7",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.protocol).toBe("anthropic-messages");
    expect(loaded.value.max_calls_per_run).toBe(7);
  });

  it("env 数值键非法 → fail-closed", async () => {
    const path = await writeConfig(FILE_BODY);
    const loaded = await loadLlmProviderConfig({
      [PROVIDER_ENV_VARS.configPath]: path,
      [PROVIDER_ENV_VARS.maxCallsPerRun]: "abc",
    });
    expect(loaded.ok).toBe(false);
  });
});

describe("配置层——fail-closed 反例（任务书 §3.1）", () => {
  it("未知 protocol 拒绝（不猜测回退）", async () => {
    const path = await writeConfig({ ...FILE_BODY, protocol: "some-unknown" });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("protocol_unknown");
  });

  it("openai-responses 明确拒绝并携带预留位语义（D6）", async () => {
    const path = await writeConfig({ ...FILE_BODY, protocol: "openai-responses" });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("protocol_unknown");
    expect(loaded.error.message).toContain("openai-responses");
  });

  it("缺 model 拒绝", async () => {
    const body = { ...FILE_BODY } as Record<string, unknown>;
    delete body["model"];
    const path = await writeConfig(body);
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("model");
  });

  it("缺 api_key 拒绝", async () => {
    const body = { ...FILE_BODY } as Record<string, unknown>;
    delete body["api_key"];
    const path = await writeConfig(body);
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("api_key");
  });

  it("未知配置键拒绝（键闭集）", async () => {
    const path = await writeConfig({ ...FILE_BODY, mystery_key: 1 });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("mystery_key");
  });

  it("权限非 0600 拒绝（D2 硬约束）", async () => {
    const path = await writeConfig(FILE_BODY, 0o644);
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("config_permission");
  });

  it("base_url 内嵌 userinfo 凭据拒绝（ADR-09 红线）", async () => {
    const path = await writeConfig({ ...FILE_BODY, base_url: "http://user:pass@127.0.0.1:9" });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("userinfo");
  });

  it('reasoning_effort="none" 拒绝（GPT-5.4 chat 面工具调用限制，任务书 §1.2）', async () => {
    const path = await writeConfig({ ...FILE_BODY, reasoning_effort: "none" });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("reasoning");
  });

  it("非 JSON 配置文件拒绝", async () => {
    const path = join(workDir, "bad.json");
    await writeFile(path, "这不是JSON", { mode: 0o600 });
    const loaded = await loadLlmProviderConfig({ [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("config_invalid");
  });
});
