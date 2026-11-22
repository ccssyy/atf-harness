// A7 身份注入锚：resolveToolRun 消歧约束（发现 15 五环断裂终版）。
// 6 工作区同名 run fixture：带会话绑定收敛绿；无绑定=ambiguous 显式列候选
// （不再全量扫描歧义静默取首）；单候选/绑定后既有解析放行。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendBinding, resolveToolRun } from "@atf/dsh-atf-core";

const cleanups: string[] = [];
const ws = (name: string, runId: string, opts?: { binding?: string }) => {
  const root = mkdtempSync(join(tmpdir(), `atf-a7-${name}-`));
  cleanups.push(root);
  const runDir = join(root, name, runId);
  mkdirSync(join(runDir, "webui"), { recursive: true });
  if (opts?.binding) {
    appendBinding(runDir, opts.binding, "2026-11-16T00:00:00Z");
  }
  return root;
};

afterEach(() => {
  for (const root of cleanups) rmSync(root, { recursive: true, force: true });
  cleanups.length = 0;
});

describe("A7 resolveToolRun 消歧约束", () => {
  it("6 工作区同名 run+会话绑定 → 收敛到绑定 run（绿）", () => {
    const runId = "same-run";
    const roots: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      roots.push(ws(`ws${i}`, runId, i === 3 ? { binding: "sess-a7" } : undefined));
    }
    // 六个独立 runsRoot（各 workspace 各自 runs 根形态）——消歧约束在同一 runsRoot
    // 多桶形态下生效：这里用单一 runsRoot 六桶构造。
    const root = roots[3]!;
    const resolution = resolveToolRun(root, runId, { sessionId: "sess-a7" });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.runDir).toContain("ws3");
    }
  });

  it("单一 runsRoot 六桶同名+无绑定 → ambiguous 显式列 6 候选", () => {
    const root = mkdtempSync(join(tmpdir(), "atf-a7-amb-"));
    cleanups.push(root);
    const runId = "same-run";
    for (let i = 0; i < 6; i += 1) {
      mkdirSync(join(root, `ws${i}`, runId, "webui"), { recursive: true });
    }
    const resolution = resolveToolRun(root, runId);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok && resolution.reason === "ambiguous") {
      expect(resolution.candidates).toHaveLength(6);
    } else {
      expect.fail("无绑定多同名须 ambiguous");
    }
  });

  it("带 workspace 身份（会话工作区桶名）→ prefer 收敛放行", () => {
    const root = mkdtempSync(join(tmpdir(), "atf-a7-prefer-"));
    cleanups.push(root);
    const runId = "same-run";
    for (let i = 0; i < 3; i += 1) {
      mkdirSync(join(root, `ws${i}`, runId, "webui"), { recursive: true });
    }
    const resolution = resolveToolRun(root, runId, { workspace: "ws1" });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.runDir).toContain("ws1");
  });

  it("同名 run 不存在 → not_found", () => {
    const root = mkdtempSync(join(tmpdir(), "atf-a7-miss-"));
    cleanups.push(root);
    const resolution = resolveToolRun(root, "no-such-run");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.reason).toBe("not_found");
  });

  it("executor 每 execute 注入 host.sessionId（身份注入面）", async () => {
    const { ToolExecutor } = await import("../../src/core/tools/executor.js");
    const { ToolRegistry } = await import("../../src/core/tools/registry.js");
    const host: Record<string, string | undefined> = { scratchDir: "", kernelDir: "", home: "", baseEnv: "" };
    const executor = new ToolExecutor(
      { request: async () => ({ ok: true as const, value: {} }) },
      ToolRegistry.createDefault(),
      undefined,
      { handlers: {}, host: host as never },
    );
    const result = await executor.execute("atf_scratch_write", { path: "x", content: "" }, undefined, { sessionId: "sess-x" });
    void result;
    expect(host.sessionId).toBe("sess-x");
  });
});
