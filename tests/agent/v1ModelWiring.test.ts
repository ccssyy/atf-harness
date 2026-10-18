/**
 * 修复批 D9.1 守卫钉（缺陷登记 558e0ac8｜取证 a7f6a212）——v1 装配必须携带真实模型描述符。
 *
 * D9 根因：assembleV1Agent 的 initialState 不传 model → pi-agent-core 以 DEFAULT_MODEL
 * {id/provider:"unknown"} 作 streamFn 首参 → 真 provider 链 "Unknown provider" 空回复；
 * faux/scripted 流显式丢首参（fauxStream.ts `void model`）曾使全套测试无感（测试全绿、
 * 生产必坏）。本钉双断言：
 * ①探针 streamFn 记录首参——id/provider＝目录模型（决不等于 "unknown" 渗漏形态）；
 * ②before_request hook 的 model 字段＝真实 model id（initialState.model 同源生效）。
 * 模型面＝faux 流包装探针（零网络；providerConfig 仅用于装配期目录解析，端点不可达也不触网）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { runV1Headless } from "../../src/agent/cli.js";
import { createFauxStreamFn, fauxFinalAnswer } from "../../src/agent/fauxStream.js";
import type { SpikeBridgeTransport } from "../../src/agent/atfAgentTools.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const spawnMock = async (): Promise<SpikeBridgeTransport> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

describe("修复批 D9.1：v1 装配模型描述符守卫钉", () => {
  it("真 provider 配置在场：agent 循环实传目录模型（非 DEFAULT_MODEL unknown）＋before_request 报真实 id", async () => {
    const bridge = await spawnMock();
    const sessionsRoot = await mkdtemp(join(tmpdir(), "d91-model-wiring-"));
    const requestedModels: Array<{ id?: string; provider?: string; api?: string }> = [];
    const beforeRequests: Array<{ model?: string }> = [];
    const scripted = createFauxStreamFn([fauxFinalAnswer("D9.1 守卫钉：装配模型透传正常。")]);
    const exitCode = await runV1Headless({
      bridge,
      sessionsRoot,
      instruction: "守卫钉：请给出最终答复",
      maxTurns: 4,
      // 真 provider 目录形态（装配期解析目录模型；streamFn 已注入＝零网络，端点地址不可达也不触网）
      providerConfig: { provider_id: "zai-coding-cn", model: "glm-5.3-flash", base_url: "http://127.0.0.1:9", api_key: "dummy" },
      streamFn: (model, context, options) => {
        requestedModels.push(model as { id?: string; provider?: string; api?: string });
        return scripted(model, context, options);
      },
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      registerHooks: (registry) => {
        registry.register("before_request", (payload) => {
          beforeRequests.push(payload as { model?: string });
        });
      },
      out: () => undefined,
      err: () => undefined,
    });
    await rm(sessionsRoot, { recursive: true, force: true });
    // 装配钉①：首参＝目录模型（D9 渗漏形态为 id/provider/api 全 "unknown"）
    expect(requestedModels.length).toBeGreaterThan(0);
    for (const model of requestedModels) {
      expect(model.id).toBe("glm-5.3-flash");
      expect(model.provider).toBe("zai-coding-cn");
      expect(model.api).toBe("openai-completions");
      expect(model.id).not.toBe("unknown");
    }
    // 装配钉②：before_request hook（读 initialState.model）＝真实 model id
    expect(beforeRequests.length).toBeGreaterThan(0);
    for (const payload of beforeRequests) {
      expect(payload.model).toBe("glm-5.3-flash");
    }
    expect(exitCode).toBe(0);
  });
});
