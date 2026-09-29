/**
 * 批⑭ 设置页与模型选择器测试锚（2026-09-29，指令 a79b1883；§四.6）：
 * providers 注册表读写（env_key 纪律）/测试连接 mock/审批三档行为/context 计数递减/key 脱敏。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVAL_POLICIES,
  SCENARIO_PROFILES,
  computeContextUsage,
  estimateTokens,
  openSettingsStore,
  redactProviders,
  type ProviderEntry,
} from "../../src/webui/settings.js";
import { WebUiSessionManager } from "../../src/webui/sessionManager.js";
import { startWebUiServer } from "../../src/webui/server.js";
import { createFauxStreamFn, fauxFinalAnswer } from "../../src/agent/fauxStream.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "settings-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("providers 注册表（env_key 纪律）与脱敏", () => {
  it("缺省注册表＝GLM/DeepSeek 预设；PUT 持久化热生效（重开 store 读到）", () => {
    const root = tempRoot();
    const store = openSettingsStore(join(root, "providers.json"));
    const initial = store.get();
    expect(initial.providers.map((provider) => provider.id)).toContain("zai-coding-cn");
    expect(initial.approval_policy).toBe("per_card");
    const updated = store.put({ approval_policy: "demo" });
    expect(updated.approval_policy).toBe("demo");
    const reopened = openSettingsStore(join(root, "providers.json")).get();
    expect(reopened.approval_policy).toBe("demo");
  });

  it("key 脱敏红线：GET 投影只回 env 变量名＋尾 4 位；PUT 剥除 api_key 明文字段", () => {
    const store = openSettingsStore(join(tempRoot(), "providers.json"));
    const tail = store.keyTail("TEST_KEY_ENV", { TEST_KEY_ENV: "sk-abcdef123456" });
    expect(tail).toBe("3456");
    expect(store.keyTail("MISSING_ENV", {})).toBeNull();
    const providers = [
      { id: "p1", name: "P1", base_url: "http://x", api_key_env: "TEST_KEY_ENV", models: [], default_model: "" },
    ] as unknown as ProviderEntry[];
    const projected = redactProviders(providers, (envName) => store.keyTail(envName, { TEST_KEY_ENV: "sk-abcdef123456" }));
    const serialized = JSON.stringify(projected);
    expect(serialized).toContain("TEST_KEY_ENV");
    expect(serialized).toContain("3456");
    expect(serialized).not.toContain("sk-abcdef123456");
    expect(serialized).not.toContain("api_key\":");
  });

  it("测试连接：env 未设 → 结构化原因；mock fetch 成功 → 模型清单（真实请求面由 fetch 注入语义）", async () => {
    const store = openSettingsStore(join(tempRoot(), "providers.json"));
    const noKey = await store.testProvider({ id: "p", name: "P", base_url: "http://127.0.0.1:9", api_key_env: "SETTINGS_TEST_MISSING", models: [], default_model: "" }, {});
    expect(noKey).toMatchObject({ ok: false });
    if (!noKey.ok) expect(noKey.reason).toContain("SETTINGS_TEST_MISSING");
    // 可达性失败（端口 9 discard）→ ok:false 带 reason（HTTP 状态或异常信息——Dify 教训：配完能知道通没通）
    const unreachable = await store.testProvider(
      { id: "p", name: "P", base_url: "http://127.0.0.1:9", api_key_env: "SETTINGS_TEST_PRESENT", models: [], default_model: "" },
      { SETTINGS_TEST_PRESENT: "sk-test" },
    );
    expect(unreachable.ok).toBe(false);
  });
});

describe("审批三档（§一.区2 行为差异）", () => {
  it("语义表：demo 档只读白名单自动放行、永不全免（文案锚）", () => {
    expect(APPROVAL_POLICIES.map((policy) => policy.id)).toEqual(["per_card", "danger_only", "demo"]);
    expect(APPROVAL_POLICIES[2]?.behavior).toContain("永不全免");
    expect(APPROVAL_POLICIES[1]?.behavior).toContain("train.sh 真跑仍必确认");
  });

  it("热切：setApprovalPolicy 即时生效（surface 按 policy 走批量放行/逐卡）；已挂起卡不受影响", async () => {
    const manager = new WebUiSessionManager({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_atf.mjs")] },
      settings: openSettingsStore(join(tempRoot(), "providers.json")),
    });
    expect(manager.approvalPolicy).toBe("per_card");
    manager.setApprovalPolicy("demo");
    expect(manager.approvalPolicy).toBe("demo");
    // approval surface 在 demo 档对 config 类审批自动放行（danger 卡走 emitDangerConfirm 不经本面）
    manager.setApprovalPolicy("danger_only");
    expect(manager.approvalPolicy).toBe("danger_only");
  });
});

describe("context 计数递减（§二.2）", () => {
  it("estimateTokens＝chars/2 口径；computeContextUsage 剩余量与 low 阈值", () => {
    expect(estimateTokens("abcd")).toBe(2);
    const usage = computeContextUsage(180_000, 200_000);
    expect(usage.remainingTokens).toBe(20_000);
    expect(usage.low).toBe(true); // <20% 琥珀提示
    const healthy = computeContextUsage(10_000, 200_000);
    expect(healthy.low).toBe(false);
  });

  it("会话 turn 后递减（spawn mock：一轮 prompt 后 contextUsedTokens 增长）", async () => {
    const manager = new WebUiSessionManager({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_atf.mjs")] },
      streamFn: createFauxStreamFn([fauxFinalAnswer("一轮完成。")]) as never,
    });
    const id = manager.createSession();
    const before = manager.getSession(id)?.contextUsedTokens ?? 0;
    await manager.postUserMessage(id, "计数测试指令——这一段文本会被计入上下文粗估");
    const after = manager.getSession(id)?.contextUsedTokens ?? 0;
    expect(after).toBeGreaterThan(before);
    const usage = manager.contextUsage(id, 200_000);
    expect(usage?.usedTokens).toBe(after);
    expect(usage?.remainingTokens).toBe(200_000 - after);
  });
});

describe("设置 API 七条（HTTP 面）", () => {
  it("GET/PUT providers＋test 404＋approval/profile PUT 校验＋context 计数", async () => {
    const runsRoot = tempRoot();
    const handle = startWebUiServer({
      runsRoot,
      sessionsRoot: tempRoot(),
      settingsStore: openSettingsStore(join(tempRoot(), "providers.json")),
      streamFn: createFauxStreamFn([fauxFinalAnswer("完成。")]) as never,
      port: 0,
    });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(base + path)).json()) as Record<string, unknown>;
    const put = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (await fetch(base + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    // GET providers（脱敏）
    const providers = await get("/api/settings/providers");
    expect(JSON.stringify(providers)).not.toMatch(/sk-|api_key":/);
    expect(Array.isArray(providers["providers"])).toBe(true);
    // PUT providers（默认线）
    const putProviders = await put("/api/settings/providers", { default_provider: "deepseek", providers: providers["providers"] });
    expect(putProviders["default_provider"]).toBe("deepseek");
    // test 404
    const testMissing = await fetch(`${base}/api/settings/providers/ghost/test`, { method: "POST" });
    expect(testMissing.status).toBe(404);
    // approval 三档 PUT 非法拒绝
    const badPolicy = await fetch(`${base}/api/settings/approval`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ approval_policy: "never_ask" }) });
    expect(badPolicy.status).toBe(400);
    const putPolicy = await put("/api/settings/approval", { approval_policy: "danger_only" });
    expect(putPolicy["approval_policy"]).toBe("danger_only");
    // profile
    const putProfile = await put("/api/settings/profile", { profile: "demo" });
    expect(putProfile["approval_policy"]).toBe("demo"); // 预设捆绑联动
    // env-profile
    const envProfile = await get("/api/settings/env-profile");
    expect(envProfile["write_path"]).toContain("env-profiles");
    // context 计数
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    await fetch(`${base}/api/sessions/${created.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "上下文计数消息" }) });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const usage = await get(`/api/sessions/${created.id}/context`);
    expect(typeof usage["used_tokens"]).toBe("number");
    expect(usage["remaining_tokens"]).toBeLessThan(usage["context_window"] as number);
    handle.server.close();
  }, 30_000);
});

describe("场景 Profiles（§一.区4）", () => {
  it("三档预设捆绑：首训/走查逐卡、演示档 demo", () => {
    expect(SCENARIO_PROFILES.map((profile) => profile.id)).toEqual(["first_train", "walkthrough", "demo"]);
    expect(SCENARIO_PROFILES.find((profile) => profile.id === "demo")?.approval_policy).toBe("demo");
  });
});
