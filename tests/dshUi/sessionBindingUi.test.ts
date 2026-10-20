// B2 绑定 UI 十锚——顶栏 chip 三态／共用选择面板分组／同名跨区前缀／全部组只读不 POST／
// 解除与改名／胶囊禁用弹面板／切会话迟到响应丢弃／runStatusOf 与监控头同源＋未绑定空态零假数据。
// 承载形态沿 atfUiSettings.test.ts 定案：client.js 真 factory 加载（new Function＋
// __ModuleLoader__ 桩）×真 React/ReactDOM（jsdom 全局先于 React 动态 import——react-dom
// isEventSupported 特征检测约束）×fetch 桩（session-binding GET/POST＋snapshot＋settings）。
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { JSDOM } = vendorRequire("jsdom") as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dom: any = new JSDOM("<!doctype html><html><body><div id='atf-h'></div><div id='atf-p'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
{
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.MutationObserver = dom.window.MutationObserver;
  g.requestAnimationFrame = dom.window.requestAnimationFrame;
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame;
  (g as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
const React = (await import("react")).default;
const { act } = (await import("react")) as { act: (fn: () => Promise<void> | void) => Promise<void> };
const { createRoot } = await import("react-dom/client");
const ReactDOM = (await import("react-dom")).default;

const CLIENT_PATH = join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js");

// ── 夹具：monitor.json 两工作区×同名 title（跨区前缀锚）＋绑定 GET 载荷闭集 ──
const WS_A = "af-prodtest-20261017";
/** run-a 的 monitor display.title（⑦ 改名后模拟下一个 5s 同步拍携带新名——可变）。 */
let monitorTitleA = "装箱单 4类";
const seg = (key: string, label: string, status: string): Record<string, unknown> => ({ key, label, status });
const monitorRun = (runId: string, workspace: string | null, title: string, opts: { active?: boolean; pct?: number } = {}): Record<string, unknown> => ({
  run_id: runId,
  workspace,
  workspace_source: workspace !== null ? "bucket" : "registry",
  state: "registered",
  state_reason: null,
  segments: [
    seg("register", "数据登记", "done"),
    seg("label_qc", "标注体检", "done"),
    seg("experiment_config", "实验配置", "done"),
    seg("publish", "契约发布", "pending"),
    seg("split", "数据切分", "pending"),
    seg("admission", "准入检查", "pending"),
    seg("training", "训练执行", opts.active ? "active" : "pending"),
    seg("evaluate", "评估与可视化", "pending"),
  ],
  display: { title },
  training: { active: opts.active === true, points: [], pending_confirm: null },
  progress: opts.active === true && opts.pct !== undefined
    ? { round: 2, total_rounds: 4, percentage: opts.pct, eta_s: 120, updated_at: new Date().toISOString() }
    : null,
  bound_sessions: [],
  viewers: [],
  ckpts: [],
  launch: null,
  metrics: null,
  env: null,
  gpu_binding: null,
  eval_rounds: [],
  eval_progress: null,
  eval_notices: [],
  train_notices: [],
  probe: null,
  trainlog_tail: null,
});

const MONITOR = (): unknown => ({
  schema: "AtfMonitor/v1",
  generated_at: new Date().toISOString(),
  gpu: { offline: false, utilization: "50%", memoryUsed: "100MiB", memoryTotal: "80GiB" },
  gpu_all: [
    { index: "0", utilization: "50%", memoryUsed: "100MiB", memoryTotal: "80GiB" },
    { index: "1", utilization: "0%", memoryUsed: "100MiB", memoryTotal: "80GiB" },
  ],
  runs: [
    monitorRun("run-a", WS_A, monitorTitleA, { active: true, pct: 62 }),
    monitorRun("run-e", "ws-other", "装箱单 4类", {}),
    monitorRun("run-b", null, "冒烟验证", {}),
  ],
});
const ARTIFACTS = { schema: "AtfArtifacts/v1", generated_at: new Date().toISOString(), runs: [] };

const boundPayload = (): Record<string, unknown> => ({
  binding: {
    schema_version: "SessionRunBinding/v1",
    workspace: WS_A, active_run_id: "run-a", source: "user_pick", unbound_reason: null,
    updated_at: "2026-10-20T08:00:00Z",
    history: [{ run_id: "run-b", at: "2026-10-19T09:00:00Z", source: "auto_tool" }],
  },
  active: { run_id: "run-a", workspace: WS_A, title: "装箱单 4类" },
  unbound_reason: null,
  recent: [
    { run_id: "run-b", workspace: null, title: "冒烟验证", mtime: "2026-10-19T09:00:00.000Z" },
    { run_id: "run-c", workspace: "ws-c", title: "4类联合", mtime: "2026-10-18T09:00:00.000Z" },
    { run_id: "run-d", workspace: null, title: "回归大单", mtime: "2026-10-17T09:00:00.000Z" },
  ],
  candidates: [
    { run_id: "run-f", workspace: WS_A, title: "同区候选一", mtime: "2026-10-16T09:00:00.000Z" },
    { run_id: "run-g", workspace: WS_A, title: "同区候选二", mtime: "2026-10-15T09:00:00.000Z" },
  ],
});
const unboundPayload = (reason: string): Record<string, unknown> => ({
  binding: {
    schema_version: "SessionRunBinding/v1",
    workspace: null, active_run_id: null, source: null, unbound_reason: reason,
    updated_at: "2026-10-20T08:00:00Z",
    history: [{ run_id: "run-a", at: "2026-10-19T09:00:00Z", source: "user_pick" }],
  },
  active: null,
  unbound_reason: reason,
  recent: boundPayload().recent,
  candidates: [],
});

interface FetchCall { url: string; method?: string; body?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Registration = { options: any; content?: (injected?: any) => any };

describe("B2 绑定 UI（client.js 真加载·jsdom）", () => {
  let headerEl: HTMLElement;
  let paneEl: HTMLElement;
  let hroot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let proot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let captured: Record<string, Registration[]>;
  const fetchCalls: FetchCall[] = [];
  let bindingPayload: Record<string, unknown>;
  let postResponse: () => { status: number; body: unknown };
  /** 迟到丢弃锚：列出的 sessionId 的 GET 挂起（手动 resolve）。 */
  let deferredSessions: string[];
  let deferredQueue: Array<{ sessionId: string; resolve: (r: Response) => void }>;

  function boot(): void {
    headerEl = dom.window.document.getElementById("atf-h");
    paneEl = dom.window.document.getElementById("atf-p");
    headerEl.innerHTML = "";
    paneEl.innerHTML = "";
    fetchCalls.length = 0; // 逐用例清零（跨用例累积会污染 POST 计数锚）
    bindingPayload = boundPayload();
    postResponse = () => ({ status: 200, body: { saved: true } });
    deferredSessions = [];
    deferredQueue = [];
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: { method?: string; body?: string }) => {
      const call: FetchCall = { url: String(url), method: init?.method, body: init?.body };
      fetchCalls.push(call);
      const u = String(url);
      if (init?.method === "POST") {
        const out = postResponse();
        return Promise.resolve(new Response(JSON.stringify(out.body), { status: out.status }));
      }
      if (u.indexOf("/atf-ui/session-binding?sessionId=") >= 0) {
        const sid = decodeURIComponent(u.split("sessionId=")[1] ?? "");
        if (deferredSessions.indexOf(sid) >= 0) {
          return new Promise((resolve) => {
            deferredQueue.push({ sessionId: sid, resolve: (r) => resolve(r) });
          });
        }
        return Promise.resolve(new Response(JSON.stringify(bindingPayload), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/snapshot") >= 0 || u.indexOf("/atf-ui/events") >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ monitor: MONITOR(), artifacts: ARTIFACTS }), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/settings") >= 0) return Promise.resolve(new Response(JSON.stringify({ effort_defaults: {} }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    };
    let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    dom.window.__ModuleLoader__ = { load: (def: never) => { moduleDef = def as never; } };
    // eslint-disable-next-line no-new-func -- client.js 本体真加载
    new Function("window", readFileSync(CLIENT_PATH, "utf8"))(dom.window);
    captured = {};
    const slots = {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (options: unknown, content?: unknown) => {
        const name = (options as { name: string }).name;
        (captured[name] ||= []).push({ options, content } as Registration);
        return () => undefined;
      },
    };
    const ctx = {
      slots,
      remote: {},
      sidebarRight: undefined,
      sidebarRightTabs: { register: () => undefined },
      inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) => fn({ slots, modelDirectories: {}, sessions: {}, remote: {} }),
      effect: (fn: () => void, _name: string) => { fn(); },
    };
    const requireMap: Record<string, unknown> = { react: React, "react-dom": ReactDOM };
    moduleDef!.factory((name: string) => requireMap[name]).apply(ctx);
  }

  async function renderHeader(sessionId: string): Promise<void> {
    const regs = captured["conversation.session.header.utilities"];
    const injected = regs![0]!.options.inject(sessionId);
    if (hroot === null) hroot = createRoot(headerEl);
    await act(async () => { hroot!.render(regs![0]!.content!(injected)); });
    await flush();
  }
  async function renderPane(): Promise<void> {
    const regs = captured["sidebar.right.pane.tab"];
    if (proot === null) proot = createRoot(paneEl);
    await act(async () => { proot!.render(regs![0]!.content!()); });
    await flush();
  }
  async function renderDock(): Promise<void> {
    const regs = captured["conversation.composer.dock"];
    if (proot === null) proot = createRoot(paneEl);
    await act(async () => { proot!.render(regs![0]!.content!()); });
    await flush();
  }
  /** 微任务双轮排空（fetch→json→setState 链落地）。 */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  /** 监控右栏先经顶栏「监控」钮开启（store.monitorOpen——pane 渲染才有面板内容）。 */
  async function openMonitor(): Promise<void> {
    await act(async () => { buttonByText(headerEl, "监控").click(); });
    await flush();
  }
  function chipButton(): HTMLButtonElement {
    const btn = Array.from(headerEl.querySelectorAll("button")).find((b) => b.className.indexOf("atf-bchip") >= 0);
    if (btn === null || btn === undefined) throw new Error("chip button not found");
    return btn as HTMLButtonElement;
  }
  function panelEl(): Element {
    const el = document.querySelector(".atf-bp");
    if (el === null) throw new Error("binding panel not open");
    return el;
  }
  function buttonByText(scope: Element | HTMLElement, text: string): HTMLButtonElement {
    const btn = Array.from(scope.querySelectorAll("button")).find((b) => (b.textContent ?? "").indexOf(text) >= 0);
    if (btn === undefined || btn === null) throw new Error("button not found: " + text);
    return btn as HTMLButtonElement;
  }
  function posts(): FetchCall[] {
    return fetchCalls.filter((c) => c.method === "POST");
  }

  beforeEach(() => { boot(); });
  afterEach(async () => {
    if (hroot !== null) await act(async () => { hroot!.unmount(); });
    if (proot !== null) await act(async () => { proot!.unmount(); });
    hroot = null;
    proot = null;
  });

  it("①已绑定 chip：title＋状态（runStatusOf 同源）＋工作区徽标（短名/全名 title）", async () => {
    await renderHeader("sess-1");
    const chip = chipButton();
    expect(chip.textContent).toContain("装箱单 4类");
    expect(chip.textContent).toContain("训练中 62%"); // runStatusOf.label＝training.active＋percentage 62
    const ws = headerEl.querySelector(".atf-bchip-ws") as HTMLElement;
    expect(ws).not.toBeNull();
    expect(ws.textContent).toBe("prodtest"); // af- 前缀剥除短名
    expect(ws.getAttribute("title")).toBe(WS_A); // title 属性给全名
  });

  it("②未绑定 chip：选择实验 ▾；点击展开面板含「继续上次」＋最近 3＋新建/查看全部", async () => {
    bindingPayload = unboundPayload("new");
    await renderHeader("sess-1");
    expect(chipButton().textContent).toContain("选择实验");
    await act(async () => { chipButton().click(); });
    await flush();
    const panel = panelEl();
    expect(panel.textContent).toContain("继续上次");
    expect(panel.textContent).toContain("装箱单 4类"); // history[0] run-a 的 display.title
    expect(panel.textContent).toContain("最近实验");
    expect(panel.textContent).toContain("新建实验");
    expect(panel.textContent).toContain("查看全部实验（只读）");
  });

  it("③分组顺序：已绑定＝本会话/最近实验/本工作区其他/全部（只读）；未绑定＝继续上次在最近之前", async () => {
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    const names = Array.from(panelEl().querySelectorAll(".atf-bp-gh")).map((g) => g.textContent);
    expect(names).toEqual(["本会话", "最近实验", "本工作区其他", "全部实例（只读）"]);
    await act(async () => { buttonByText(panelEl(), "×").click(); });
    await flush();
    bindingPayload = unboundPayload("new");
    await renderHeader("sess-2"); // 切会话重拉——未绑定态
    await act(async () => { chipButton().click(); });
    await flush();
    const names2 = Array.from(panelEl().querySelectorAll(".atf-bp-gh")).map((g) => g.textContent);
    expect(names2).toEqual(["继续上次", "最近实验", "全部实例（只读）"]);
  });

  it("④同名跨工作区：全部组主行加 [workspace] 前缀", async () => {
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    // run-e（ws-other）与 run-a（WS_A）同名「装箱单 4类」→ 全部组 run-e 行带 [ws-other]
    expect(panelEl().textContent).toContain("[ws-other] 装箱单 4类");
  });

  it("⑤「全部」组行点击＝零 POST 只预览（监控横幅＋换 run）；「设为当前」才 POST", async () => {
    await renderHeader("sess-1");
    await renderPane();
    await act(async () => { chipButton().click(); });
    await flush();
    // 全部组里 run-b 行（冒烟验证）点击——只预览
    const allGroup = Array.from(panelEl().querySelectorAll(".atf-bp-group")).at(-1) as HTMLElement;
    const rowBtn = Array.from(allGroup.querySelectorAll("[data-bp-row]")).find((b) => (b.textContent ?? "").indexOf("冒烟验证") >= 0) as HTMLButtonElement;
    await act(async () => { rowBtn.click(); });
    await flush();
    expect(posts().length).toBe(0); // 红线：浏览不得 POST
    // 预览生效：监控 showAll＋runId=run-b——横幅＋预览 run 标题
    expect(paneEl.textContent).toContain("全部实例（只读视图）");
    expect(paneEl.textContent).toContain("冒烟验证");
    // 横幅「设为当前」→ POST {sessionId, runId:'run-b'}
    await act(async () => { buttonByText(paneEl, "设为当前").click(); });
    await flush();
    expect(posts().length).toBe(1);
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ sessionId: "sess-1", runId: "run-b" });
  });

  it("⑥解除绑定：POST {runId:null}；chip 回「选择实验」；cleared 空态出现（含撤销解除）", async () => {
    await renderHeader("sess-1");
    await openMonitor();
    await renderPane();
    await act(async () => { chipButton().click(); });
    await flush();
    // POST 成功后 store 自动重拉——重拉载荷先切 cleared（模拟服务端解除后的 GET 结果）
    bindingPayload = unboundPayload("cleared");
    await act(async () => { buttonByText(panelEl(), "解除绑定").click(); });
    await flush();
    expect(posts().length).toBe(1);
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ sessionId: "sess-1", runId: null });
    expect(chipButton().textContent).toContain("选择实验"); // 重拉 cleared → chip 回未绑定
    await renderPane();
    expect(paneEl.textContent).toContain("已解除绑定");
    expect(paneEl.textContent).toContain("撤销解除"); // cleared 给撤销入口（history 上一条）
  });

  it("⑦改名：铅笔→输入→POST rename；chip/监控 title 同步更新", async () => {
    await renderHeader("sess-1");
    await openMonitor();
    await renderPane();
    await act(async () => { chipButton().click(); });
    await flush();
    await act(async () => { buttonByText(panelEl(), "✎").click(); });
    await flush();
    const input = panelEl().querySelector(".atf-bp-rename-in") as HTMLInputElement;
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "我的新名字");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    // POST 成功后 store 重拉——重拉载荷带新 title（模拟服务端落 display.json 后的 GET）
    bindingPayload = { ...boundPayload(), active: { run_id: "run-a", workspace: WS_A, title: "我的新名字" } };
    await act(async () => { buttonByText(panelEl(), "确定").click(); });
    await flush();
    expect(posts().length).toBe(1);
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ sessionId: "sess-1", rename: { runId: "run-a", title: "我的新名字" } });
    expect(chipButton().textContent).toContain("我的新名字"); // chip 同步
    // 监控头 title 同步：monitor.json 下一拍携带新 display.title 后 pane 重开（useMonitor
    // 数据在挂载拍拉取——重挂＝重取，等价 5s 轮询/SSE 到达后的同一份渲染路径）
    monitorTitleA = "我的新名字";
    await act(async () => { proot!.unmount(); });
    proot = null;
    await renderPane();
    expect(paneEl.textContent).toContain("我的新名字");
    monitorTitleA = "装箱单 4类"; // 复位（其他夹具消费者）
  });

  it("⑧胶囊：未绑定 run 相关 aria-disabled＋点击弹面板零 POST；已绑定「继续训练：title」可用", async () => {
    bindingPayload = unboundPayload("new");
    await renderHeader("sess-1");
    await renderDock();
    const pills = Array.from(paneEl.querySelectorAll("[data-run-related]")) as HTMLButtonElement[];
    expect(pills.length).toBe(3); // 查状态/继续上次/对比两轮
    for (const p of pills) {
      expect(p.getAttribute("aria-disabled")).toBe("true");
      expect(p.getAttribute("title")).toBe("先选择实验");
    }
    expect(buttonByText(paneEl, "新建训练").getAttribute("aria-disabled")).toBeNull();
    await act(async () => { (pills.find((p) => (p.textContent ?? "") === "查状态") as HTMLButtonElement).click(); });
    await flush();
    expect(posts().length).toBe(0); // 不发起工具调用（弹面板是唯一动作）
    expect(panelEl().textContent).toContain("选择实验");
    // 已绑定：继续上次→「继续训练：装箱单 4类」且可用（切新会话触发重拉）
    bindingPayload = boundPayload();
    await renderHeader("sess-2");
    await renderDock();
    const cont = buttonByText(paneEl, "继续训练：装箱单 4类") as HTMLButtonElement;
    expect(cont.getAttribute("aria-disabled")).toBeNull();
  });

  it("⑨切会话：旧会话 GET 晚到不覆盖新会话（按 sessionId＋序号丢弃）", async () => {
    deferredSessions = ["sess-1"];
    await renderHeader("sess-1"); // GET sess-1 挂起（loading）
    expect(chipButton().textContent).toContain("░"); // 骨架不显旧值
    // 切到 sess-2——立即返回（绑定 run-b）
    bindingPayload = { ...boundPayload(), active: { run_id: "run-b", workspace: null, title: "冒烟验证" } };
    await renderHeader("sess-2");
    expect(chipButton().textContent).toContain("冒烟验证");
    // sess-1 的迟到响应此刻才 resolve（active run-a）——必须被丢弃
    const pending = deferredQueue.find((p) => p.sessionId === "sess-1");
    expect(pending).toBeDefined();
    await act(async () => { pending!.resolve(new Response(JSON.stringify(boundPayload()), { status: 200 })); });
    await flush();
    expect(chipButton().textContent).toContain("冒烟验证"); // 仍是新会话的绑定
    expect(chipButton().textContent).not.toContain("装箱单 4类");
  });

  it("⑩runStatusOf 与监控头同源（训练中 62% 双面一致）；未绑定空态零假数据（无 KPI/GPU 细卡/Loss 图）", async () => {
    await renderHeader("sess-1");
    await openMonitor();
    await renderPane();
    expect(chipButton().textContent).toContain("训练中 62%");
    expect(paneEl.textContent).toContain("训练中"); // 监控头
    expect(paneEl.textContent).toContain("62%");
    expect(paneEl.querySelector(".atf-m-kpis")).not.toBeNull();
    // 切未绑定（new）——空态：无 KPI/Loss 图/GPU 细卡；只空态＋最近 3＋机器 GPU 一行
    bindingPayload = unboundPayload("new");
    await renderHeader("sess-3");
    await renderPane();
    expect(paneEl.textContent).toContain("未选择实验");
    expect(paneEl.textContent).toContain("机器 GPU：2 卡 · 忙 1（只读，机器级）");
    expect(paneEl.querySelector(".atf-m-kpis")).toBeNull(); // 不渲染假 KPI
    expect(paneEl.querySelector(".atf-loss-chart")).toBeNull(); // 不画假曲线
    expect(paneEl.querySelector(".atf-gpu-grid")).toBeNull(); // 不渲染 GPU 细卡
    expect(paneEl.querySelectorAll(".atf-m-empty-row").length).toBe(3); // 最近 3 条
  });

  // ── 批B2a：选择面板跨组去重（只改展示——active/last/recent 进 shown，最近与本工作区
  // 其他互斥，全部组保持全量，空组不渲染标题）─────────────────────────────────────
  function groupRows(text: string): Element[] {
    const group = Array.from(panelEl().querySelectorAll(".atf-bp-group")).find(
      (g) => (g.querySelector(".atf-bp-gh")?.textContent ?? "") === text,
    );
    return group === undefined ? [] : Array.from(group.querySelectorAll("button.atf-bp-main"));
  }
  function groupNames(): Array<string | null> {
    return Array.from(panelEl().querySelectorAll(".atf-bp-gh")).map((g) => g.textContent);
  }

  it("B2a①active 同时出现在 recent → 最近实验组不重复当前绑定", async () => {
    bindingPayload = {
      ...boundPayload(),
      recent: [
        { run_id: "run-a", workspace: WS_A, title: "装箱单 4类", mtime: "m3" },
        { run_id: "run-b", workspace: null, title: "冒烟验证", mtime: "m2" },
        { run_id: "run-c", workspace: "ws-c", title: "4类联合", mtime: "m1" },
      ],
    };
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    const rows = groupRows("最近实验");
    expect(rows.length).toBe(2); // run-a 已在「本会话」组——跳过
    expect(rows.map((r) => r.textContent).join("")).not.toContain("run-a");
  });

  it("B2a②recent 与 candidates 重叠 → 本工作区其他不重复（互斥）", async () => {
    bindingPayload = {
      ...boundPayload(),
      candidates: [
        { run_id: "run-b", workspace: WS_A, title: "冒烟验证", mtime: "m2" }, // 已在 recent
        { run_id: "run-f", workspace: WS_A, title: "同区候选一", mtime: "m1" },
      ],
    };
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    const rows = groupRows("本工作区其他");
    expect(rows.length).toBe(1); // run-b 已在最近实验——跳过
    expect(rows[0]!.textContent).toContain("run-f");
    expect(rows.map((r) => r.textContent).join("")).not.toContain("run-b");
  });

  it("B2a③去重后组为空 → 不渲染组标题", async () => {
    bindingPayload = {
      ...boundPayload(),
      recent: [{ run_id: "run-a", workspace: WS_A, title: "装箱单 4类", mtime: "m1" }], // 唯一条＝active
      candidates: [{ run_id: "run-f", workspace: WS_A, title: "同区候选一", mtime: "m0" }],
    };
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    const names = groupNames();
    expect(names).not.toContain("最近实验"); // 全被 shown 去重 → 组整组缺席
    expect(names).toEqual(["本会话", "本工作区其他", "全部实例（只读）"]);
  });

  it("B2a④「全部」组保持全量（含 active/去重组内 run）", async () => {
    bindingPayload = {
      ...boundPayload(),
      recent: [{ run_id: "run-a", workspace: WS_A, title: "装箱单 4类", mtime: "m1" }],
    };
    await renderHeader("sess-1");
    await act(async () => { chipButton().click(); });
    await flush();
    const allRows = groupRows("全部实例（只读）");
    const allText = allRows.map((r) => r.textContent).join("");
    expect(allText).toContain("run-a"); // 目录不去重——active 仍在列
    expect(allText).toContain("run-e");
    expect(allText).toContain("run-b");
  });
});
