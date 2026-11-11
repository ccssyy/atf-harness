// -*- coding: utf-8 -*-
/** D276 装配 eval:webui 会话 subagent 并行面注入断言(子模块 eval——不依赖真机)。
 *
 * 判据:①createSession 装配记录 subagentEnabled=true(DSH 原生 dispatch 两件+deferred
 * 三件注入的装配事实);②faux 链可正常驱动(装配不破既有行为)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFauxStreamFn } from "../../src/agent/fauxStream.js";
import { WebUiSessionManager } from "../../src/webui/sessionManager.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "subagent-assembly-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("webui subagent 装配(D276)", () => {
  it("会话装配记录 subagentEnabled=true(并行工具注入的装配事实)", async () => {
    const manager = new WebUiSessionManager({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      // 桥接 mock(fixture)——缺失时 ensureAgent 在装配前 early return(判据失效)
      bridgeCommand: { argv: ["node", join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_atf.mjs")] },
      streamFn: createFauxStreamFn([]) as never,
    });
    const id = manager.createSession();
    // 装配发生在首轮消息(spawn agent 时),createSession 仅建壳
    await manager.postUserMessage(id, "装配 eval 驱动消息");
    const internal = manager as unknown as {
      sessions: Map<string, { subagentEnabled?: boolean; agent?: unknown }>;
    };
    const session = internal.sessions.get(id);
    expect(session, `会话应在 manager 内注册(id=${id})`).toBeDefined();
    expect(session?.subagentEnabled).toBe(true);
    expect(session?.agent).toBeDefined();
  });
});
