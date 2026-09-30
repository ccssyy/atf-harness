/**
 * 批⑬ v2 WebUI 测试锚（2026-09-29，指令 ed9206c4；§五.7：渲染快照＋只读工具四件＋
 * 确认语义/API 单测＋spawn mock pipeline＋e2e 冒烟覆盖场景 2-6）。
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderChatEvent, renderChatHtml, type ChatEvent } from "../../src/webui/chatModel.js";
import { buildConfigConfirmFields, parseConfigEditText, loadConfigSnapshot, saveConfigSnapshot, hasConfigSnapshot } from "../../src/webui/configConfirm.js";
import { buildReadOnlyAgentTools, listRuns } from "../../src/webui/readOnlyTools.js";
import { WebUiSessionManager, parseBudgetFromEnv, chatBudgetFromEnv } from "../../src/webui/sessionManager.js";
import { startWebUiServer } from "../../src/webui/server.js";
import { AtfBridgeConnection } from "../../src/bridge/index.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createFauxStreamFn, fauxAssistantMessage, fauxFinalAnswer } from "../../src/agent/fauxStream.js";
import type { ToolCall } from "@earendil-works/pi-ai";

const repoRoot = join(import.meta.url.replace("file://", ""), "..", "..", "..");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const openConnections: AtfBridgeConnection[] = [];
const tempRoots: string[] = [];

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "webui-test-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) void connection.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 渲染快照（7 组件闭集）

describe("渲染快照（消息组件闭集 7 种）", () => {
  const base = Date.parse("2026-09-29T00:00:00Z");
  const events: ChatEvent[] = [
    { seq: 1, kind: "user", text: "基于 pl 数据训一个字段抽取模型", at: "t" },
    { seq: 2, kind: "agent_text", text: "收到——先登记数据并体检。", at: "t" },
    {
      seq: 3,
      kind: "plan_card",
      title: "执行计划",
      items: [
        { label: "数据登记", state: "done" },
        { label: "配置确认", state: "running" },
        { label: "训练启动", state: "pending" },
      ],
      at: "t",
    },
    { seq: 4, kind: "tool_card", tool: "atf_workspace_status", running: true, params: {}, at: "t" },
    {
      seq: 5,
      kind: "confirm_card",
      cardType: "config_confirm",
      title: "训练配置确认（九要素）",
      fields: [
        { key: "learning_rate", value: "1e-4", tag: "default_used" },
        { key: "deepspeed", value: "ds_z3_offload_config.json", tag: "from_registry" },
        { key: "dataset_keys", value: "pl_mixed_train", tag: "done" },
        { key: "gpu_window", value: "待放行", tag: "waiting_window" },
      ],
      pending: true,
      at: "t",
    },
    { seq: 6, kind: "danger_confirm", title: "train.sh 真跑", gpuCount: 8, estimate: "4h", command: "bash train.sh", pending: true, at: "t" },
    { seq: 7, kind: "system_notice", level: "warn", text: "gpu_window_pending：训练段未放行", at: "t" },
  ];

  it("七组件逐条渲染（结构断言：右对齐气泡/琥珀卡/红按钮/三态标签/⏸ 徽标）", () => {
    const html = events.map((event) => renderChatEvent(event));
    expect(html[0]).toContain('class="msg user"');
    expect(html[1]).toContain("收到——先登记数据并体检。");
    expect(html[2]).toContain("✅ 数据登记");
    expect(html[2]).toContain("🔄 配置确认");
    expect(html[2]).toContain("⏸ 训练启动");
    expect(html[3]).toContain("⚙ tool: atf_workspace_status");
    expect(html[3]).toContain("运行中");
    expect(html[4]).toContain("confirm_card amber");
    expect(html[4]).toContain("⏸ 需要你确认");
    expect(html[4]).toContain("已用缺省⚠");
    expect(html[4]).toContain("来自登记");
    expect(html[4]).toContain("确认并继续");
    expect(html[4]).toContain("也可直接回复如『lr 改 2e-4』");
    expect(html[5]).toContain("确认真实训练 · GPU 8 卡 · 预计 4h");
    expect(html[6]).toContain("gpu_window_pending");
    // 整页渲染 = 单条顺序拼接（纯函数：同输入同输出）
    expect(renderChatHtml(events)).toBe(html.join("\n"));
    expect(renderChatHtml(events)).toBe(renderChatHtml([...events]));
  });

  it("危险卡应答后按钮消失（代价显性化只到确认点）", () => {
    const answered: ChatEvent = { ...(events[5] as Extract<ChatEvent, { kind: "danger_confirm" }>), pending: false, answered: { verdict: "confirmed", via: "button", at: "t" } };
    expect(renderChatEvent(answered)).not.toContain("确认真实训练");
    expect(renderChatEvent(answered)).toContain("已应答：confirmed");
  });
});

// ---------------------------------------------------------------- config_confirm（九要素＋纯文字应答）

describe("config_confirm：九要素卡与纯文字应答", () => {
  it("缺省标已用缺省⚠；登记面值标来自登记；显式值标需确认", () => {
    const fields = buildConfigConfirmFields({ learning_rate: "2e-4" }, { fromRegistry: { deepspeed: "ds_z3_offload_config.json" } });
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
    expect(byKey["learning_rate"]).toEqual({ key: "learning_rate", value: "2e-4", tag: "need_confirm" });
    expect(byKey["deepspeed"]).toEqual({ key: "deepspeed", value: "ds_z3_offload_config.json", tag: "from_registry" });
    expect(byKey["cutoff_len"]).toEqual({ key: "cutoff_len", value: "9000", tag: "default_used" });
    expect(fields.length).toBe(9);
  });

  it("纯文字解析：lr 改 2e-4 其他 ok → {learning_rate:2e-4}；不可解析 → null", () => {
    expect(parseConfigEditText("lr 改 2e-4 其他 ok")).toEqual({ edits: { learning_rate: "2e-4" }, explicitOnly: true });
    expect(parseConfigEditText("epochs 改 5")).toEqual({ edits: { num_train_epochs: "5" }, explicitOnly: true });
    expect(parseConfigEditText("完全无关的一句话")).toBeNull();
    expect(parseConfigEditText("其他 ok")).toEqual({ edits: {}, explicitOnly: false });
  });

  it("config-snapshot：落盘/读取/在位判断（续跑不重问的存储面）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-a");
    expect(hasConfigSnapshot(runDir)).toBe(false);
    saveConfigSnapshot(runDir, { learning_rate: "2e-4" });
    expect(hasConfigSnapshot(runDir)).toBe(true);
    expect(loadConfigSnapshot(runDir)).toEqual({ learning_rate: "2e-4" });
  });
});

// ---------------------------------------------------------------- 只读工具四件

describe("只读工具四件（atf_run_list/report_read/metrics_compare/gpu_status）", () => {
  it("atf_run_list：状态推导＋产物清单；空目录如实空", async () => {
    const root = tempRoot();
    expect((await listRuns(root)).length).toBe(0);
    mkdirSync(join(root, "run-a", "report"), { recursive: true });
    mkdirSync(join(root, "run-b", "launch"), { recursive: true });
    mkdirSync(join(root, "run-a", "webui"), { recursive: true });
    writeFileSync(join(root, "run-a", "webui", "config-snapshot.json"), "{}");
    writeFileSync(join(root, "run-b", "launch", "train.sh"), "#!/bin/bash\ntrue");
    const runs = await listRuns(root);
    expect(runs.length).toBe(2);
    const byId = Object.fromEntries(runs.map((run) => [run.run_id, run]));
    expect(byId["run-a"]?.state).toBe("config_confirmed");
    expect(byId["run-b"]?.state).toBe("launch_ready");
  });

  it("atf_report_read：存在读全文／缺失如实报", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-a", "report"), { recursive: true });
    writeFileSync(join(root, "run-a", "report", "report.md"), "# 总结");
    const tools = buildReadOnlyAgentTools({ runsRoot: root });
    const found = await tools[1]?.execute("t", { run_id: "run-a" });
    expect(found?.details).toMatchObject({ exists: true, text: "# 总结" });
    const missing = await tools[1]?.execute("t", { run_id: "run-x" });
    expect(missing?.details).toMatchObject({ exists: false });
  });

  it("atf_metrics_compare：无可比轮次如实报；可比则逐键 diff", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-a", "report"), { recursive: true });
    writeFileSync(join(root, "run-a", "report", "metrics_summary.json"), '{"f1":0.87}');
    const tools = buildReadOnlyAgentTools({ runsRoot: root });
    const noCompare = await tools[2]?.execute("t", { run_a: "run-a", run_b: "run-ghost" });
    expect(noCompare?.details).toMatchObject({ comparable: false, note: "无可比轮次" });
    mkdirSync(join(root, "run-b", "report"), { recursive: true });
    writeFileSync(join(root, "run-b", "report", "metrics_summary.json"), '{"f1":0.91}');
    const compared = await tools[2]?.execute("t", { run_a: "run-a", run_b: "run-b" });
    expect(compared?.details).toMatchObject({ comparable: true, diff: { f1: { a: 0.87, b: 0.91 } } });
  });

  it("atf_gpu_status：nvidia-smi 可用与否均如实（不猜测）", async () => {
    const root = tempRoot();
    const tools = buildReadOnlyAgentTools({ runsRoot: root });
    const result = await tools[3]?.execute("t", {});
    const details = result?.details as Record<string, unknown>;
    expect(typeof details["gpu_offline"]).toBe("boolean");
  });
});

// ---------------------------------------------------------------- 会话语义（绑定互斥/确认流转/护栏）

const spawnMockBridge = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockPath] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

const assistant = (blocks: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content: blocks,
  api: "openai-completions",
  provider: "webui-test",
  model: "webui-test-model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
});

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000, dump?: () => string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时；现场：${dump?.() ?? "(无转储)"}`);
};

describe("会话语义（spawn mock pipeline）", () => {
  it("绑定互斥：第二会话绑同一 run 显式拒绝并提示活跃会话（§三.3）", () => {
    const root = tempRoot();
    const manager = new WebUiSessionManager({ runsRoot: root, sessionsRoot: tempRoot(), bridgeCommand: { argv: ["node", mockPath] } });
    const first = manager.createSession();
    const second = manager.createSession();
    expect(manager.bindRun(first, "run-x").ok).toBe(true);
    const refused = manager.bindRun(second, "run-x");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("run_busy");
    const secondSession = manager.getSession(second);
    expect(secondSession?.events.some((event) => event.kind === "system_notice" && event.text.includes("另一会话"))).toBe(true);
  });

  it("config_confirm 全流转：卡出→纯文字改参重呈→确认落 snapshot→agent 收到确认凭据（spawn mock）", { timeout: 45_000 }, async () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-a"), { recursive: true });
    const toolCallBlock: ToolCall = { type: "toolCall", id: "c1", name: "atf_config_confirm", arguments: { config: { learning_rate: "1e-4", cutoff_len: "9000" } } };
    const streamFn = createFauxStreamFn([
      fauxAssistantMessage([toolCallBlock], "toolUse"),
      fauxFinalAnswer("配置已确认——迭代配置生效，进入发布准备。"),
    ]);
    const manager = new WebUiSessionManager({
      runsRoot: root,
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", mockPath] },
      streamFn: streamFn as never,
    });
    const sessionId = manager.createSession();
    manager.bindRun(sessionId, "run-a");
    void manager.postUserMessage(sessionId, "基于 pl 数据训一个字段抽取模型");
    await waitFor(
      () => manager.getSession(sessionId)?.pending?.cardType === "config_confirm",
      15_000,
      () => {
        const s = manager.getSession(sessionId);
        const agent = s?.agent as unknown as { state?: { messages?: Array<{ role: string; content: unknown }>; errorMessage?: string } } | undefined;
        return JSON.stringify(
          {
            events: (s?.events ?? []).map((event) => [event.kind, "text" in event ? event.text?.slice(0, 60) : ""]),
            hasAgent: agent !== undefined,
            messages: (agent?.state?.messages ?? []).map((message) => [message.role, JSON.stringify(message.content).slice(0, 80)]),
            errorMessage: agent?.state?.errorMessage ?? null,
          },
          null,
          1,
        );
      },
    );
    // 卡面：缺省标已用缺省⚠、九要素齐全
    const cardEvent = manager.getSession(sessionId)?.events.find((event) => event.kind === "confirm_card");
    expect(cardEvent !== undefined && cardEvent.kind === "confirm_card" && cardEvent.fields.length === 9).toBe(true);
    // 纯文字改参 → 重呈卡（lr 更新）
    await manager.postUserMessage(sessionId, "lr 改 2e-4 其他 ok");
    await waitFor(() => {
      const cards = (manager.getSession(sessionId)?.events ?? []).filter((event) => event.kind === "confirm_card" && event.pending);
      const last = cards[cards.length - 1];
      return last !== undefined && last.kind === "confirm_card" && last.fields.some((field) => field.key === "learning_rate" && field.value === "2e-4");
    });
    // 点卡确认（按钮）→ snapshot 落盘 + agent 收到确认凭据
    await manager.answerConfirm(sessionId, { action: "confirm", via: "button" });
    await waitFor(
      () => hasConfigSnapshot(join(root, "run-a")),
      10_000,
      () => {
        const agent = manager.getSession(sessionId)?.agent as unknown as { state?: { messages?: unknown[] } } | undefined;
        return JSON.stringify({
          snapshot: hasConfigSnapshot(join(root, "run-a")),
          messages: ((agent?.state?.messages ?? []) as Array<{ role: string; content: unknown }>).map((m) => [m.role, JSON.stringify(m.content).slice(0, 120)]),
        });
      },
    );
    expect(loadConfigSnapshot(join(root, "run-a"))).toMatchObject({ learning_rate: "2e-4" });
    await waitFor(() => manager.getSession(sessionId)?.state === "completed");
    const agentMessages = manager.getSession(sessionId)?.agent?.state.messages ?? [];
    const toolResults = agentMessages.filter((message: { role?: string }) => message.role === "toolResult");
    const confirmResult = JSON.stringify(toolResults[toolResults.length - 1] ?? {});
    expect(confirmResult).toContain('"confirmed":true');
    expect(confirmResult).toContain("user_confirmation");
  });

  it("解析护栏（运维面）：连续不可用响应 → 放弃解析、向用户索取信息（优雅降级，无技术字样）", async () => {
    const root = tempRoot();
    let calls = 0;
    const streamFn = (): unknown => {
      calls += 1;
      return createFauxStreamFn([fauxFinalAnswer("")])("m" as never, { messages: [] } as never);
    };
    const manager = new WebUiSessionManager({
      runsRoot: root,
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", mockPath] },
      streamFn: streamFn as never,
      parseBudget: 1,
    });
    const sessionId = manager.createSession();
    await manager.postUserMessage(sessionId, "随便说点什么");
    await waitFor(
      () => (manager.getSession(sessionId)?.events ?? []).some((event) => event.kind === "agent_text" && event.text.includes("请直接用文字告诉我")),
      15_000,
      () => JSON.stringify((manager.getSession(sessionId)?.events ?? []).map((event) => event.kind)),
    );
    expect(calls).toBe(1);
    expect((manager.getSession(sessionId)?.events ?? []).some((event) => event.kind === "system_notice" && event.text.includes("解析连续失败"))).toBe(true);
  });

  it("对话护栏（运维面，缺省 0＝不设限；超限人话呈现、无技术字样）", async () => {
    expect(chatBudgetFromEnv({})).toBe(0);
    expect(chatBudgetFromEnv({ ATF_WEBUI_CHAT_BUDGET: "2" })).toBe(2);
    expect(parseBudgetFromEnv({})).toBe(5);
    expect(parseBudgetFromEnv({ ATF_WEBUI_PARSE_BUDGET: "abc" })).toBe(5);
    const root = tempRoot();
    let serial = 0;
    const streamFn = (): unknown =>
      createFauxStreamFn([fauxAssistantMessage([{ type: "toolCall", id: "c" + String(serial++), name: "atf_workspace_status", arguments: {} }], "toolUse")])("m" as never, { messages: [] } as never);
    const manager = new WebUiSessionManager({
      runsRoot: root,
      sessionsRoot: tempRoot(),
      bridgeCommand: { argv: ["node", mockPath] },
      streamFn: streamFn as never,
      chatBudget: 2,
    });
    const sessionId = manager.createSession();
    await manager.postUserMessage(sessionId, "持续干活");
    await waitFor(
      () => (manager.getSession(sessionId)?.events ?? []).some((event) => event.kind === "system_notice" && event.text.includes("任务已终止并记录原因")),
      15_000,
      () => JSON.stringify((manager.getSession(sessionId)?.events ?? []).map((event) => event.kind)),
    );
    expect((manager.getSession(sessionId)?.events ?? []).some((event) => event.kind === "system_notice" && /budget_exhausted|max_turns|token/.test(event.text))).toBe(false);
  });
});

// ---------------------------------------------------------------- e2e 冒烟（HTTP 面，覆盖场景 2-6）

describe("e2e 冒烟（HTTP 面；场景 2-6 对应）", () => {
  it("场景 2-6：确认卡流转／第二会话只读总结／绑同一 run 拒绝", async () => {
    const runsRoot = tempRoot();
    mkdirSync(join(runsRoot, "run-e2e", "report"), { recursive: true });
    writeFileSync(join(runsRoot, "run-e2e", "report", "metrics_summary.json"), '{"f1":0.9}');
    writeFileSync(join(runsRoot, "run-e2e", "report", "segment-1.md"), "# 段 1：登记完成\n");
    const toolCallBlock: ToolCall = { type: "toolCall", id: "e1", name: "atf_config_confirm", arguments: { config: {} } };
    const streamFn = createFauxStreamFn([
      fauxAssistantMessage([toolCallBlock], "toolUse"),
      fauxFinalAnswer("配置确认完成。"),
      fauxAssistantMessage([{ type: "toolCall", id: "e2", name: "atf_run_list", arguments: {} }], "toolUse"),
      fauxFinalAnswer("run-e2e：登记/切分/体检/发布四段已完成，配置已确认，训练待放行（gpu_window_pending）。"),
    ]);
    const handle = startWebUiServer({ runsRoot, sessionsRoot: tempRoot(), streamFn: streamFn as never, port: 0 });
    const manager = handle.manager;
    const address = handle.server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : handle.port;
    const base = `http://127.0.0.1:${String(actualPort)}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(base + path)).json()) as Record<string, unknown>;

    // 静态三栏 + GPU 卡真实（在线/离线均如实）
    const page = await (await fetch(base + "/")).text();
    expect(page).toContain('id="session-list"');
    expect(page).toContain('id="status-card"');
    const gpu = await get("/api/gpu");
    expect(gpu["gpu"] !== undefined).toBe(true);

    // 场景 2：新建会话 → 绑 run → atf_config_confirm 卡 pending（九要素、缺省高亮）
    const created = (await post("/api/sessions", {})) as { id: string };
    const sessionId = created.id;
    manager.bindRun(sessionId, "run-e2e");
    await post(`/api/sessions/${sessionId}/messages`, { text: "基于 pl 数据训一个字段抽取模型" });
    await waitFor(() => manager.getSession(sessionId)?.pending?.cardType === "config_confirm");
    const events = (await get(`/api/sessions/${sessionId}/events?since=0`)) as { events: Array<{ html: string; seq: number }> };
    const confirmHtml = events.events.map((event) => event.html).join("");
    expect(confirmHtml).toContain("训练配置确认（九要素）");
    expect(confirmHtml).toContain("已用缺省⚠");

    // 场景 3：文字改参重呈 → 点卡确认 → snapshot 落盘
    await post(`/api/sessions/${sessionId}/messages`, { text: "lr 改 2e-4 其他 ok" });
    await waitFor(() => {
      const list = manager.getSession(sessionId)?.events ?? [];
      const pendingCards = list.filter((event) => event.kind === "confirm_card" && event.pending);
      const last = pendingCards[pendingCards.length - 1];
      return last !== undefined && last.kind === "confirm_card" && last.fields.some((field) => field.key === "learning_rate" && field.value === "2e-4");
    });
    await post(`/api/sessions/${sessionId}/confirm`, { action: "confirm" });
    await waitFor(() => hasConfigSnapshot(join(runsRoot, "run-e2e")));

    // 场景 4：第二会话只读总结（不触管线——只读工具真实读 runs）
    const second = (await post("/api/sessions", { instruction: "总结一下刚才那个 run（run-e2e）" })) as { id: string };
    await waitFor(
      () => manager.getSession(second.id)?.state === "completed",
      15_000,
      () => JSON.stringify((manager.getSession(second.id)?.events ?? []).map((event) => event.kind)),
    );
    const secondEvents = manager.getSession(second.id)?.events ?? [];
    expect(JSON.stringify(secondEvents.map((event) => [event.kind, event.kind === "tool_card" || event.kind === "tool_start" ? event.tool : ""]))).toContain("atf_run_list");

    // 场景 6：第三会话绑同一 run → 拒绝并提示活跃会话
    const third = (await post("/api/sessions", {})) as { id: string };
    manager.bindRun(second.id, "run-e2e");
    const refused = manager.bindRun(third.id, "run-e2e");
    expect(refused.ok).toBe(false);
    const thirdEvents = manager.getSession(third.id)?.events ?? [];
    expect(thirdEvents.some((event) => event.kind === "system_notice" && event.text.includes("另一会话"))).toBe(true);

    handle.server.close();
  }, 30_000);
});

// ---------------------------------------------------------------- 批⑰ Bug1：report.md 静态直开路由

describe("批⑰ Bug1：report.md 静态直开（/static/run/:id/report/report.md；只读＋防穿越）", () => {
  it("存在→200 text/plain 内联；缺失→404；非法 runId→400；segment md 同样可达", async () => {
    const runsRoot = tempRoot();
    mkdirSync(join(runsRoot, "run-s17", "report"), { recursive: true });
    writeFileSync(join(runsRoot, "run-s17", "report", "report.md"), "# run-s17 报告\n界面同源声明正文。");
    writeFileSync(join(runsRoot, "run-s17", "report", "segment-1.md"), "# 段 1\n");
    const handle = startWebUiServer({ runsRoot, sessionsRoot: tempRoot(), port: 0 });
    const address = handle.server.address();
    const base = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : handle.port)}`;

    const hit = await fetch(`${base}/static/run/run-s17/report/report.md`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toContain("text/plain");
    expect(await hit.text()).toContain("# run-s17 报告");

    const segment = await fetch(`${base}/static/run/run-s17/report/segment-1.md`);
    expect(segment.status).toBe(200);
    expect(await segment.text()).toContain("# 段 1");

    const miss = await fetch(`${base}/static/run/run-empty/report/report.md`);
    expect(miss.status).toBe(404);

    const evil = await fetch(`${base}/static/run/${encodeURIComponent("../sneak")}/report/report.md`);
    expect(evil.status).toBe(400);

    // 前端静态面：report-link 不再指向 "#"（由 JS 按 run 绑定接线）；设置页保存按钮在位
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain('id="report-link"');
    expect(page).toContain('id="providers-save"');
    expect(page).toContain('id="policy-save"');
    expect(page).toContain('id="env-save"');

    handle.server.close();
  });
});
