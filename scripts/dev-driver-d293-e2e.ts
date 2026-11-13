/**
 * D293 端到端实测驱动（真机同配置——owner「修完不实测又等用户撞」批评的落地）。
 * 直接驱动 plugin apply+dispatch workorders 真实链路：真 provider 子任务+真工单文件+真页图。
 * 用法（A800，harness 仓根）：
 *   npx tsx scripts/dev-driver-d293-e2e.ts <workorders_path> <source_root> <workspace_root>
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply as applyPlugin } from "../packages/extensions/atf-subagent/src/index.js";
import { bridgeManagerSlot } from "../packages/extensions/atf-tools/src/index.js";

const [workordersPath, sourceRoot, workspaceRoot] = process.argv.slice(2);
if (!workordersPath || !sourceRoot || !workspaceRoot) {
  console.error("用法: tsx dev-driver-d293-e2e.ts <workorders_path> <source_root> <workspace_root>");
  process.exit(2);
}

// 桥接 stub（子任务看图答题不依赖内核调用；工具调用会被记录便于诊断）
const bridgeCalls: string[] = [];
const fakeManager = {
  transport: async () => ({
    request: async (method: string, params?: unknown) => {
      bridgeCalls.push(method);
      return { ok: true as const, value: { ok: true, run_id: "e2e-d293", admitted_count: 0, scope_ref: { project_id: "atf", scope_type: "workspace", scope_id: "e2e", scope_mode: "workspace" } } };
    },
  }),
  transportForWorkspace: async (p: string) => {
    console.log("[driver] transportForWorkspace:", p);
    return fakeManager.transport();
  },
};

const tools: Array<{ name: string; execute: (params: unknown, exec?: unknown) => Promise<unknown> }> = [];
const ctx = {
  tools: { register: (tool: { name: string; execute: (params: unknown, exec?: unknown) => Promise<unknown> }) => tools.push(tool) },
  get: () => undefined,
  atfBridgeManager: fakeManager,
};

const sessionsRoot = mkdtempSync(join(tmpdir(), "d293-e2e-sessions-"));
mkdirSync(sessionsRoot, { recursive: true });
process.env.ATF_WEBUI_SESSIONS_ROOT = sessionsRoot;

console.log("[driver] ATF_LLM_CONFIG =", process.env.ATF_LLM_CONFIG);
console.log("[driver] GLM key 在场 =", (process.env.ATF_LLM_KEY_GLM ?? "").slice(0, 6) + "…");
bridgeManagerSlot.current = fakeManager;
await applyPlugin(ctx, {});
bridgeManagerSlot.current = null;

const parallel = tools.find((t) => t.name === "dispatch_parallel_training_subtask");
if (!parallel) {
  console.error("[driver] FAIL: dispatch_parallel_training_subtask 未注册——tools:", tools.map((t) => t.name));
  process.exit(1);
}
console.log("[driver] 派发:", { workorders_path: workordersPath, source_root: sourceRoot });
const exec = { agent: { session: { header: { cwd: workspaceRoot } } } };
const t0 = Date.now();
const outcome = (await parallel.execute({ workorders_path: workordersPath, source_root: sourceRoot }, exec)) as Record<string, unknown>;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[driver] 耗时 ${secs}s | 桥接调用: ${bridgeCalls.join(",") || "无"}`);
console.log("[driver] 聚合结果:", JSON.stringify(outcome, null, 1).slice(0, 3000));
process.exit(0);
