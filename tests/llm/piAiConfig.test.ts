/**
 * pi-ai 换库批（门 2，2026-09-23）——providerConfig 协议条目＋effort 值域闭集单测（指令 §四.2）。
 *
 * - protocol="pi-ai" 被配置层接受（现役唯一协议——批甲-BUILD T4 起旧自研 codec 协议已下线）；
 * - pi-ai 路径 effort 闭集 none/low/high/max：none 合法（→不传 reasoning，pi-ai 关思考）；
 *   未知值 fail-closed 拒绝（模型级与 env 覆盖两入口都拒）；
 * - 旧协议 openai-chat 配置 → protocol_unknown 拒绝（指路改配 pi-ai——批甲-BUILD T4 锚）。
 * 凭据纪律沿用：api_key_env 解析缺失 → fail-closed（本文件提供测试 env 值）。
 */
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_PROTOCOLS, PROVIDER_ENV_VARS, loadLlmProviderConfig } from "../../src/llm/index.js";

const writeConfig = async (doc: Record<string, unknown>): Promise<{ path: string; env: NodeJS.ProcessEnv }> => {
  const dir = await mkdtemp(join(tmpdir(), "piai-config-"));
  const path = join(dir, "llm.json");
  await writeFile(path, JSON.stringify(doc), { mode: 0o600 });
  await chmod(path, 0o600);
  return {
    path,
    env: {
      [PROVIDER_ENV_VARS.configPath]: path,
      CREDENTIAL_TEST_KEY: "cred-value",
    } as NodeJS.ProcessEnv,
  };
};

const baseProvider = (protocol: string, effort: unknown) => ({
  protocol,
  base_url: "https://api.example.com",
  api_key_env: "CREDENTIAL_TEST_KEY",
  ...(effort !== undefined ? { models: [{ id: "test-model", reasoning: true, reasoning_effort: effort as string, max_tokens: 4096 }] } : { models: [{ id: "test-model", reasoning: true, max_tokens: 4096 }] }),
});

const baseDoc = (protocol: string, effort: unknown): Record<string, unknown> => ({
  schema_version: "HarnessLlmConfig/v3",
  default_provider: "alias",
  providers: { alias: baseProvider(protocol, effort) },
});

describe("providerConfig——pi-ai 协议条目与 effort 闭集", () => {
  it("PROVIDER_PROTOCOLS 收窄单值 pi-ai（批甲-BUILD T4 旧路径删除）", () => {
    expect([...PROVIDER_PROTOCOLS]).toEqual(["pi-ai"]);
  });

  it("pi-ai 协议被接受：解析产物 protocol=pi-ai；none 为合法档位（→不传 reasoning）", async () => {
    const { path, env } = await writeConfig(baseDoc("pi-ai", "none"));
    const loaded = await loadLlmProviderConfig({ ...env, [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.protocol).toBe("pi-ai");
    expect(loaded.value.reasoning_effort).toBe("none");
    expect(loaded.value.api_key).toBe("cred-value");
  });

  it("pi-ai 路径未知档位 fail-closed（模型级入口）", async () => {
    const { path, env } = await writeConfig(baseDoc("pi-ai", "medium"));
    const loaded = await loadLlmProviderConfig({ ...env, [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("闭集");
  });

  it("pi-ai 路径未知档位 fail-closed（env 覆盖入口）", async () => {
    const { path, env } = await writeConfig(baseDoc("pi-ai", "low"));
    const loaded = await loadLlmProviderConfig({
      ...env,
      [PROVIDER_ENV_VARS.configPath]: path,
      [PROVIDER_ENV_VARS.reasoningEffort]: "xhigh",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.message).toContain("xhigh");
  });

  it("旧协议 openai-chat 配置 → protocol_unknown 拒绝＋指路改配 pi-ai（批甲-BUILD T4 锚）", async () => {
    const { path, env } = await writeConfig(baseDoc("openai-chat", "none"));
    const loaded = await loadLlmProviderConfig({ ...env, [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("protocol_unknown");
    expect(loaded.error.message).toContain("旧自研 codec 直连路径已删除");
    expect(loaded.error.message).toContain("pi-ai");
  });

  it("旧协议 anthropic-messages 配置 → protocol_unknown 拒绝（批甲-BUILD T4 锚）", async () => {
    const { path, env } = await writeConfig(baseDoc("anthropic-messages", "none"));
    const loaded = await loadLlmProviderConfig({ ...env, [PROVIDER_ENV_VARS.configPath]: path });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe("protocol_unknown");
  });
});
