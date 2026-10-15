/**
 * 批⑲ 测试锚——WebUI 启动竞态热修（真实 env 路径补盲）：
 * 1) stub provider config 经 env 启动→listen 完成后立即 POST 消息→无"模型宿主未配置"伪错
 *    （批甲-BUILD T4 迁移：本地 pi-ai SSE 假端点承载真实 env 加载路径——FakeLlmEndpoint 随旧编码部删除）
 * 2) config 缺失启动→/api/health 显式 failed＋POST /api/sessions 503（fail-closed）
 * 批甲-BUILD T2 锚（D3=A 桥 mock 缺省移除）：
 * 3) provider 就绪但无显式桥配置 → 503＋桥指路（不缺省 mock）
 * 4) env ATF_WEBUI_BRIDGE_MOCK=1 显式 mock 标志 → 通道可达（过闸＋桥真装配）
 * 5) 注入 streamFn（宿主等价物）→ 会话创建过闸（既有 e2e 路径零破坏）
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LLM_CONFIG_SCHEMA_VERSION } from "../../src/llm/providerConfig.js";
import { startWebUiServer } from "../../src/webui/server.js";

const FAKE_KEY = "fake-m12prime-key-DO-NOT-USE";
const FAKE_KEY_ENV = "FAKE_M12PRIME_KEY";
const FAKE_PROVIDER = "deepseek";
const FAKE_MODEL = "deepseek-flash";

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
  delete process.env["ATF_WEBUI_BRIDGE_MOCK"];
  delete process.env["ATF_DSH_BRIDGE_COMMAND"];
});

// ---- 本地 pi-ai SSE 假端点（openai-completions wire——piAiProvider.test 同款 chunk 形态） ----

const sseChunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-startuprace",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: FAKE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

/** 纯文本答复一轮（finish stop）→ 聚合为 final 文本。 */
const textReplySse = (text: string): string =>
  [sseChunk({ role: "assistant", content: text }), sseChunk({}, "stop"), "data: [DONE]\n\n"].join("");

/** 脚本化本地 SSE 服务（每请求弹一条脚本；耗尽后重复末条——零外连零真实调用）。 */
const startPiAiSseServer = async (replies: string[]): Promise<{ server: Server; baseUrl: string; requests: string[] }> => {
  const requests: string[] = [];
  let call = 0;
  const server = createHttpServer((_req: IncomingMessage, res: ServerResponse) => {
    requests.push("chat/completions");
    const body = replies[Math.min(call, replies.length - 1)] as string;
    call += 1;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, requests };
};

describe("批⑲ 启动竞态热修（真实 env 路径；批甲-BUILD T4 迁移 pi-ai 假端点）", () => {
  it("时序修正：env config→await 加载→listen 后立即 POST 消息→真实 provider 流式回复（无伪错）", async () => {
    const endpoint = await startPiAiSseServer([textReplySse("冒烟回复：链路真实可用。")]);
    const root = tempRoot();
    process.env[FAKE_KEY_ENV] = FAKE_KEY;
    // 批甲-BUILD T2：桥为显式 mock（e2e 语境显式标志——生产缺省已移除）
    process.env["ATF_WEBUI_BRIDGE_MOCK"] = "1";
    const configPath = join(root, "llm.config.json");
    writeFileSync(configPath, JSON.stringify({
      schema_version: LLM_CONFIG_SCHEMA_VERSION,
      default_provider: FAKE_PROVIDER,
      providers: {
        [FAKE_PROVIDER]: {
          protocol: "pi-ai",
          base_url: endpoint.baseUrl,
          api_key_env: FAKE_KEY_ENV,
          models: [{ id: FAKE_MODEL, reasoning: true, max_tokens: 4096 }],
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
    endpoint.server.close();
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

  it("注入 streamFn（宿主等价物）→ 会话创建过闸＋mock 桥真装配（既有 e2e 路径零破坏——T2 测试注入路径不变）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    const handle = await startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0, streamFn: (async () => undefined) as never });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    expect(created.id).toBeTruthy();
    // 消息一投：ensureAgent 真spawn 既有 mock 桥（通道可达的行为级证据——装配失败会以
    // "桥接 spawn/握手失败"/"桥接未配置" 进事件流）
    const post = await fetch(`${base}/api/sessions/${created.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ping" }) });
    expect(post.status).toBe(200);
    let sawBridgeError = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const events = (await (await fetch(`${base}/api/sessions/${created.id}/events?since=0`)).json()) as { events: Array<{ html: string }> };
      sawBridgeError = events.events.some((e) => String(e.html).includes("桥接 spawn/握手失败") || String(e.html).includes("桥接未配置"));
      if (sawBridgeError) break;
    }
    expect(sawBridgeError).toBe(false);
    handle.server.close();
  }, 30_000);
});

describe("批甲-BUILD T2——桥 mock 缺省移除（D3=A）", () => {
  it("provider 就绪但无显式桥配置 → 会话创建 503＋桥指路（不缺省 mock）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    delete process.env["ATF_WEBUI_BRIDGE_MOCK"];
    delete process.env["ATF_DSH_BRIDGE_COMMAND"];
    const handle = await startWebUiServer({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      port: 0,
      providerConfig: { provider_id: "deepseek", model: "deepseek-flash", base_url: "http://127.0.0.1:9", api_key: "unused" },
    });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const health = (await (await fetch(`${base}/api/health`)).json()) as { status: string };
    expect(health.status).toBe("ok"); // provider 腿就绪——503 只因桥未装配
    const post = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(503);
    const body = (await post.json()) as { error: string };
    expect(body.error).toContain("桥接未配置");
    expect(body.error).toContain("ATF_DSH_BRIDGE_COMMAND");
    expect(body.error).toContain("ATF_WEBUI_BRIDGE_MOCK");
    handle.server.close();
  });

  it("env ATF_WEBUI_BRIDGE_MOCK=1 显式 mock 标志 → 通道可达（过闸＋桥真装配无错误）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    process.env["ATF_WEBUI_BRIDGE_MOCK"] = "1";
    const handle = await startWebUiServer({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      port: 0,
      providerConfig: { provider_id: "deepseek", model: "deepseek-flash", base_url: "http://127.0.0.1:9", api_key: "unused" },
    });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    expect(created.id).toBeTruthy();
    const post = await fetch(`${base}/api/sessions/${created.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ping" }) });
    expect(post.status).toBe(200);
    // mock 桥真被装配：事件流无"桥接未配置"/"spawn/握手失败"（装配失败会以 system_notice 在场）
    let sawBridgeError = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const events = (await (await fetch(`${base}/api/sessions/${created.id}/events?since=0`)).json()) as { events: Array<{ html: string }> };
      sawBridgeError = events.events.some((e) => String(e.html).includes("桥接未配置") || String(e.html).includes("桥接 spawn/握手失败"));
      if (sawBridgeError) break;
    }
    expect(sawBridgeError).toBe(false);
    handle.server.close();
  }, 30_000);

  it("overrides.bridgeCommand 宿主注入 → 原样装配过闸（注入即显式指定）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    delete process.env["ATF_WEBUI_BRIDGE_MOCK"];
    const handle = await startWebUiServer({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      port: 0,
      providerConfig: { provider_id: "deepseek", model: "deepseek-flash", base_url: "http://127.0.0.1:9", api_key: "unused" },
      bridgeCommand: { argv: ["node", "-e", "process.exit(0)"] },
    });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    // 注入通道绕过 mock 缺省语义：即使 argv 非 mock 夹具，会话创建照样过闸（不缺省不裁剪）
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    expect(created.id).toBeTruthy();
    handle.server.close();
  });

  it("provider 与桥双缺 → 503 报模型宿主腿（既有指路优先序不变）", async () => {
    delete process.env["ATF_LLM_CONFIG"];
    delete process.env["ATF_WEBUI_BRIDGE_MOCK"];
    const handle = await startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const post = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(503);
    const body = (await post.json()) as { error: string };
    expect(body.error).toContain("模型宿主未配置");
    handle.server.close();
  });
});
