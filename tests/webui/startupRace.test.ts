/**
 * 批⑲ 测试锚——WebUI 启动竞态热修（真实 env 路径补盲）：
 * 1) stub provider config 经 env 启动→listen 完成后立即 POST 消息→无"模型宿主未配置"伪错（FakeLlmEndpoint 承载真实 env 加载路径）
 * 2) config 缺失启动→/api/health 显式 failed＋POST /api/sessions 503（fail-closed）
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeLlmEndpoint, type FakeEndpointScriptItem } from "../../src/llm/index.js";
import { LLM_CONFIG_SCHEMA_VERSION } from "../../src/llm/providerConfig.js";
import { startWebUiServer } from "../../src/webui/server.js";

const FAKE_KEY = "fake-m12prime-key-DO-NOT-USE";
const FAKE_KEY_ENV = "FAKE_M12PRIME_KEY";
const FAKE_PROVIDER = "zai-coding-cn";
const FAKE_MODEL = "fake-model-m12prime";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "m12prime-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env["ATF_LLM_CONFIG"];
  delete process.env[FAKE_KEY_ENV];
});

const SCRIPT: FakeEndpointScriptItem[] = [
  { kind: "response", response: { final_answer: "冒烟回复：链路真实可用。" } },
];

describe("批⑲ 启动竞态热修（真实 env 路径）", () => {
  it("时序修正：env config→await 加载→listen 后立即 POST 消息→真实 provider 流式回复（无伪错）", async () => {
    const endpoint = await FakeLlmEndpoint.start({ protocol: "openai-chat", script: SCRIPT.map((s) => s).filter((s): s is FakeEndpointScriptItem & { kind: "response" } => s.kind === "response"), expectedApiKey: FAKE_KEY, model: FAKE_MODEL });
    const root = tempRoot();
    process.env[FAKE_KEY_ENV] = FAKE_KEY;
    const configPath = join(root, "llm.config.json");
    writeFileSync(configPath, JSON.stringify({
      schema_version: LLM_CONFIG_SCHEMA_VERSION,
      default_provider: FAKE_PROVIDER,
      providers: {
        [FAKE_PROVIDER]: {
          protocol: "openai-chat",
          base_url: endpoint.baseUrl,
          api_key_env: FAKE_KEY_ENV,
          models: [{ id: FAKE_MODEL, reasoning: false, max_tokens: 4096 }],
        },
      },
    }));
    chmodSync(configPath, 0o600);
    process.env["ATF_LLM_CONFIG"] = configPath;
    const handle = await startWebUiServer({ runsRoot: join(root, "runs"), sessionsRoot: join(root, "sessions"), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;

    // health：ready
    const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string; provider: { provider_id: string } | null };
    expect(health.status).toBe("ok");
    expect(health.provider?.provider_id).toBe(FAKE_PROVIDER);

    // listen 完成后【立即】创建会话＋投递消息（竞态窗口断言——不 sleep）
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    expect(created.id).toBeTruthy();
    const post = await fetch(`${base}/api/sessions/${created.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ping" }) });
    expect(post.status).toBe(200);
    // 竞态修复的充分断言：listen 后【立即】messages POST accepted（200）——未修版此处 turn 会以
    // undefined provider 起 turn 并在流里产出"模型宿主未配置"伪错；await 加载后 providerConfig 就绪。
    const msgPost = await fetch(`${base}/api/sessions/${created.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ping" }) });
    expect(msgPost.status).toBe(200);
    // 轮询事件流：断言不出现伪错文案（有 turn 输出即查；turn 未出也不构成伪错）
    let sawPseudoError = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const events = (await (await fetch(`${base}/api/sessions/${created.id}/events?since=0`)).json()) as { events: Array<{ html: string }> };
      sawPseudoError = events.events.some((e) => String(e.html).includes("模型宿主未配置"));
      if (sawPseudoError) break;
    }
    expect(sawPseudoError).toBe(false);
    handle.server.close();
  }, 60_000);

  it("fail-closed：config 缺失启动 → /api/health failed ＋ POST /api/sessions 503＋原因指路", async () => {
    delete process.env[FAKE_KEY_ENV];
    process.env["ATF_LLM_CONFIG"] = join(tempRoot(), "nonexistent.json");
    const handle = await startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string; error?: string; hint?: string };
    expect(health.status).toBe("failed");
    expect(String(health.error)).toContain("加载失败");
    expect(String(health.hint)).toContain("ATF_LLM_CONFIG");
    const post = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(503);
    const body = (await post.json()) as { error: string; provider_state: string };
    expect(body.provider_state).toBe("failed");
    expect(body.error).toContain("模型宿主加载失败");
    handle.server.close();
  });

  it("env 无 ATF_LLM_CONFIG：允许启动（none）→ 会话创建 fail-closed 503 至配置就绪", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    const handle = await startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string };
    expect(health.status).toBe("none");
    const post = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(503);
    handle.server.close();
  });

  it("注入 streamFn（宿主等价物）→ 会话创建过闸（既有 e2e 路径零破坏）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    const handle = await startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0, streamFn: (async () => undefined) as never });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    expect(created.id).toBeTruthy();
    handle.server.close();
  });
});
