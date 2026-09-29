/**
 * 批⑯prime 测试锚（2026-09-30，指令 35126639）：流式事件序列 mock 渲染时序断言／
 * 选择器常显／无 thinking 降级／刷新重放（events 按 seq 重放走同一渲染路径）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderChatEvent, renderChatHtml, type ChatEvent } from "../../src/webui/chatModel.js";
import { WebUiSessionManager } from "../../src/webui/sessionManager.js";
import { startWebUiServer } from "../../src/webui/server.js";
import { createFauxStreamFn, fauxAssistantMessage, fauxFinalAnswer } from "../../src/agent/fauxStream.js";
import type { ToolCall } from "@earendil-works/pi-ai";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "b16p-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 渲染时序（流式序列 mock）

const streamingScript: ChatEvent[] = [
  { seq: 1, kind: "user", text: "分析这个数据集", at: "t" },
  { seq: 2, kind: "thinking_delta", text: "用户要求分析…", at: "t" },
  { seq: 3, kind: "thinking_delta", text: "需要先看工作区状态", at: "t" },
  { seq: 4, kind: "thinking_done", chars: 17, at: "t" },
  { seq: 5, kind: "tool_start", tool: "atf_workspace_status", params: {}, at: "t" },
  { seq: 6, kind: "tool_end", tool: "atf_workspace_status", resultSummary: "完成", isError: false, at: "t" },
  { seq: 7, kind: "text_delta", text: "工作区正常。", at: "t" },
  { seq: 8, kind: "text_delta", text: "开始规划训练。", at: "t" },
];

describe("批⑯prime：流式事件序列渲染时序", () => {
  it("四事件渲染形态：思考灰字/live 工具卡/正文增量；时序按 seq 保序", () => {
    const html = streamingScript.map((event) => renderChatEvent(event));
    expect(html[1]).toContain('class="msg thinking_delta streaming"');
    expect(html[1]).toContain("思考中…");
    expect(html[3]).toContain("已思考 17 字 ▸");
    expect(html[4]).toContain('class="msg tool_card live"');
    expect(html[4]).toContain("运行中");
    expect(html[5]).toContain("badge done-badge");
    expect(html[6]).toContain('class="msg text_delta streaming"');
    // 时序：thinking → tool → text 按 seq 顺序（renderChatHtml 保序拼接）
    const all = renderChatHtml(streamingScript);
    expect(all.indexOf("思考中…")).toBeLessThan(all.indexOf("tool: atf_workspace_status"));
    expect(all.indexOf("tool: atf_workspace_status")).toBeLessThan(all.indexOf("工作区正常。"));
  });

  it("降级路径：无 thinking 事件（provider 不吐思考）→ 渲染流无思考区（不伪造空区）", () => {
    const noThinking: ChatEvent[] = [
      { seq: 1, kind: "user", text: "问", at: "t" },
      { seq: 2, kind: "text_delta", text: "直接正文回答。", at: "t" },
    ];
    const all = renderChatHtml(noThinking);
    expect(all).toContain("直接正文回答。");
    expect(all).not.toContain("thinking_delta");
    expect(all).not.toContain("思考中…");
    expect(all).not.toContain("已思考");
  });
});

// ---------------------------------------------------------------- 端到端（manager 逐事件转发＋重放）

describe("批⑯prime：manager 逐事件转发与重放", () => {
  it("流式 mock：turn 内依次产出 thinking_delta/tool_start/tool_end/text_delta（逐事件非打包）", async () => {
    const toolCallBlock: ToolCall = { type: "toolCall", id: "c1", name: "atf_workspace_status", arguments: {} };
    const manager = new WebUiSessionManager({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_atf.mjs")] },
      streamFn: createFauxStreamFn([
        fauxAssistantMessage([toolCallBlock], "toolUse"),
        fauxFinalAnswer("工作区正常，规划完成。"),
      ]),
    });
    const id = manager.createSession();
    await manager.postUserMessage(id, "分析这个数据集");
    const kinds = (manager.getSession(id)?.events ?? []).map((event) => event.kind);
    // 流式断言：tool_start/tool_end 两段式在场（非一次性 tool_card）；assistant 收口文本在场
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_end");
    expect(kinds).not.toContain("tool_card");
    expect(kinds.indexOf("tool_start")).toBeLessThan(kinds.indexOf("tool_end"));
    // 无 thinking provider（faux 不吐思考）→ 降级：无 thinking_delta/thinking_done（不伪造）
    expect(kinds).not.toContain("thinking_delta");
    expect(kinds).not.toContain("thinking_done");
  });

  it("重放：eventsSince(0) 全量按 seq 重放（刷新恢复——流事件已按 seq 入列）", async () => {
    const manager = new WebUiSessionManager({
      runsRoot: tempRoot(),
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", join(import.meta.url.replace("file://", ""), "..", "..", "..", "tests", "fixtures", "mock_atf.mjs")] },
      streamFn: createFauxStreamFn([
        fauxAssistantMessage([{ type: "toolCall", id: "c2", name: "atf_workspace_status", arguments: {} } as ToolCall], "toolUse"),
        fauxFinalAnswer("完成。"),
      ]),
    });
    const id = manager.createSession();
    await manager.postUserMessage(id, "重放测试");
    const first = manager.eventsSince(id, 0).map((event) => event.seq);
    const second = manager.eventsSince(id, 0).map((event) => event.seq);
    expect(second).toEqual(first); // 同一 seq 序列＝刷新重放一致
    expect(first.length).toBeGreaterThan(3);
    // since 游标增量语义
    expect(manager.eventsSince(id, first[first.length - 1] ?? 0).length).toBe(0);
  });
});

// ---------------------------------------------------------------- HTTP 面：选择器常显的数据面（providers 一直可得）

describe("批⑯prime A：选择器常显（数据面）", () => {
  it("空会话下 providers/settings API 即可用（前端选择器渲染数据源不依赖 cursor）", async () => {
    const handle = startWebUiServer({ runsRoot: tempRoot(), sessionsRoot: tempRoot(), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const providers = (await (await fetch(`${base}/api/settings/providers`)).json()) as { providers: unknown[] };
    expect(providers.providers.length).toBeGreaterThan(0);
    const created = (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    // 空会话（零事件）context API 即可用（选择器剩余量显示的数据面）
    const usage = (await (await fetch(`${base}/api/sessions/${created.id}/context`)).json()) as { used_tokens: number };
    expect(usage.used_tokens).toBe(0);
    handle.server.close();
  }, 20_000);
});
