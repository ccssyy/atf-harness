/**
 * C1（1113 真机派发装接）测试锚——@atf/dsh-atf-subagent 会话级 plugin。
 *
 * B 批教训锁（1112-2/1113）：验收判据必须锚真机路径——本文件三面：
 * ①挂载面：atf-training preset patch plugins 清单含本包（vendor preset plugin 体系，
 *   非 harness WebUiSessionManager eval 入口——后者已被门禁定性为「真机不可达」）；
 * ②工厂面：apply 可实例化并注册 dispatch 三件套（桥接 manager mock；LLM 配置缺席走
 *   faux 降级=测试进程零真模型调用）；
 * ③降级面：前置依赖缺席（bridge manager/sessionsRoot）可观测降级不注册（fail-closed
 *   不静默）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// 静态 import（动态模板路径会绕过 vite alias——dsh-tools 解析失败的教训）。
import { apply as applyPluginRaw } from "../../packages/extensions/atf-subagent/src/index.js";

const REPO = join(import.meta.url.replace("file://", ""), "..", "..", "..");
const PRESET_PATCH = join(REPO, "packages", "extensions", "atf-ui", "presets", "atf-training.patch.yml");

const registeredNames = (ctxOverrides: Record<string, unknown> = {}): { names: string[]; ctx: Record<string, unknown> } => {
  const names: string[] = [];
  const ctx: Record<string, unknown> = {
    tools: { register: (tool: { name: string }) => names.push(tool.name) },
    get: () => undefined,
    ...ctxOverrides,
  };
  return { names, ctx };
};

const applyPlugin = async (ctx: Record<string, unknown>): Promise<void> => {
  process.env.ATF_WEBUI_SESSIONS_ROOT = process.env.ATF_WEBUI_SESSIONS_ROOT ?? "/tmp/atf-subagent-test-sessions";
  delete process.env.ATF_LLM_CONFIG;
  await applyPluginRaw(ctx, {});
};

describe("C1——atf-subagent 会话级 plugin", () => {
  it("挂载面：atf-training preset patch plugins 清单含 @atf/dsh-atf-subagent（真机路径锚）", () => {
    const patch = readFileSync(PRESET_PATCH, "utf-8");
    expect(patch).toContain("id: atf-subagent");
    expect(patch).toContain("'@atf/dsh-atf-subagent'");
    // B 批教训锁注记：eval 专用入口（WebUiSessionManager→assembleV1Agent deps）保留为
    // eval 线，不再是真机装接依据——真机装接的唯一判据=本 patch 挂载行（vendor preset
    // plugin 体系），验收在真机会话工具面在场断言（部署后探针）。
  });

  it("工厂面：apply 注册 dispatch 三件套（含并行件——D276 条款工具面）", async () => {
    const fakeManager = { transport: async () => ({ request: async () => ({ ok: true as const, value: {} }) }) };
    const { names, ctx } = registeredNames({ atfBridgeManager: fakeManager });
    await applyPlugin(ctx);
    expect(names).toContain("dispatch_training_subtask");
    expect(names).toContain("dispatch_parallel_training_subtask");
    expect(names.length).toBeGreaterThanOrEqual(3);
  });

  it("降级面：bridge manager 缺席→不注册＋warn 留痕（不静默）", async () => {
    const { names, ctx } = registeredNames();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await applyPlugin(ctx);
    expect(names).toHaveLength(0);
    expect(warn.mock.calls.some((line) => String(line[0]).includes("atfBridgeManager 缺席"))).toBe(true);
    warn.mockRestore();
  });
});
