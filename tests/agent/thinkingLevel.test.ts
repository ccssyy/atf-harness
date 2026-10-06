/**
 * 批㊵ 测试——推理档位（D-LLM-1 R3 WebUI 面）丙线透传链。
 * 对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用）。
 * 锚：①档位透传两态（无档位＝options.reasoning 不携带；initialThinkingLevel＝首轮即携带）
 * ／②运行时可切（thinkingLevelSource 变值 → 下一请求档位跟随，历史请求不回改）／
 * ③webui effort 词表映射（none→off；闭集外→undefined 不干预）＋setModelOverride 闭集外拒绝。
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { assembleV1Agent } from "../../src/agent/cli.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";
import { createFauxStreamFn, fauxFinalAnswer } from "../../src/agent/fauxStream.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";
import { effortToThinkingLevel, EFFORT_THINKING_LEVELS, WebUiSessionManager } from "../../src/webui/sessionManager.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const makeSession = async (tag = "effort-"): Promise<SessionLike> => {
  const root = await mkdtemp(join(tmpdir(), tag));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

/** 捕获型 streamFn：包一层记录每请求 options.reasoning（档位透传的观测点），faux 载体零触网。 */
const captureStreamFn = (script: ReturnType<typeof fauxFinalAnswer>[], capture: Array<{ reasoning?: string }>) => {
  const base = createFauxStreamFn(script);
  return (model: never, context: import("@earendil-works/pi-ai").TranscriptContext, options?: unknown) => {
    capture.push({ reasoning: (options as { reasoning?: string } | undefined)?.reasoning });
    return base(model, context, options as never);
  };
};

describe("批㊵ · 推理档位丙线透传链（D-LLM-1 R3）", () => {
  it("① 透传两态：无档位＝options.reasoning 不携带；initialThinkingLevel=high＝首轮即携带（装配→loop→streamFn 全链）", async () => {
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    openConnections.push(spawned.value);
    const bridge = spawned.value;

    const captureNone: Array<{ reasoning?: string }> = [];
    const plain = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 4,
      modelTag: "faux-effort",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: captureStreamFn([fauxFinalAnswer("无档位收口")], captureNone),
    });
    await plain.agent.prompt("直答");
    expect(captureNone).toHaveLength(1);
    expect(captureNone[0]?.reasoning).toBeUndefined(); // 无档位＝不干预（库默认 off 折算 undefined）

    const captureHigh: Array<{ reasoning?: string }> = [];
    const withLevel = assembleV1Agent({
      bridge,
      session: await makeSession(),
      maxTurns: 4,
      modelTag: "faux-effort",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      initialThinkingLevel: "high",
      streamFn: captureStreamFn([fauxFinalAnswer("高档收口")], captureHigh),
    });
    await withLevel.agent.prompt("直答");
    expect(captureHigh).toHaveLength(1);
    expect(captureHigh[0]?.reasoning).toBe("high"); // initialState → config.reasoning → streamFn options
  });

  it("② 运行时可切：thinkingLevelSource 变值 → 下一请求档位跟随；off＝不携带（历史请求观测值不回改）", async () => {
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    openConnections.push(spawned.value);
    const capture: Array<{ reasoning?: string }> = [];
    let current: "low" | "max" | "off" | undefined = undefined;
    const s = assembleV1Agent({
      bridge: spawned.value,
      session: await makeSession(),
      maxTurns: 4,
      modelTag: "faux-effort",
      approval: { kind: "headless" },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      thinkingLevelSource: () => current,
      streamFn: captureStreamFn([fauxFinalAnswer("轮一"), fauxFinalAnswer("轮二"), fauxFinalAnswer("轮三")], capture),
    });
    await s.agent.prompt("轮一"); // source=undefined → 不干预
    current = "max";
    await s.agent.prompt("轮二"); // 切 max → 本轮起携带
    current = "off";
    await s.agent.prompt("轮三"); // 切 off → 不携带（loop 折算 undefined）
    expect(capture.map((entry) => entry.reasoning)).toEqual([undefined, "max", undefined]);
  });

  it("③ webui effort 词表映射：none→off、闭集内直映、闭集外/缺省→undefined；setModelOverride 闭集外拒绝（warn＋原档不变）", async () => {
    expect(effortToThinkingLevel("none")).toBe("off"); // D-LLM-1 用户契约词（none=思考关闭）
    expect(effortToThinkingLevel("low")).toBe("low");
    expect(effortToThinkingLevel("max")).toBe("max");
    expect(effortToThinkingLevel(undefined)).toBeUndefined();
    expect(effortToThinkingLevel("")).toBeUndefined();
    expect(effortToThinkingLevel("turbo")).toBeUndefined(); // 闭集外 fail-closed 不猜
    expect(EFFORT_THINKING_LEVELS).toContain("none");

    const runsRoot = await mkdtemp(join(tmpdir(), "effort-runs-"));
    const sessionsRoot = await mkdtemp(join(tmpdir(), "effort-sess-"));
    const manager = new WebUiSessionManager({
      runsRoot,
      sessionsRoot,
      bridgeCommand: { argv: ["node", mockAtf] },
    });
    const id = manager.createSession("档位会话");
    // 闭集外：拒绝（warn 留痕，override 不落）
    expect(manager.setModelOverride(id, { provider_id: "glm-atf", model: "glm-5.3", effort: "turbo" })).toBe(false);
    const warned = manager.eventsSince(id, 0).find((event) => event.kind === "system_notice");
    expect(JSON.stringify(warned)).toContain("不在闭集");
    // 闭集内：接纳（none＝用户契约词）
    expect(manager.setModelOverride(id, { provider_id: "glm-atf", model: "glm-5.3", effort: "none" })).toBe(true);
    expect(manager.getSession(id)?.providerOverride?.effort).toBe("none");
    await mkdir(runsRoot, { recursive: true }); // 无害占位（manager 构造已 mkdir sessionsRoot）
  });
});
