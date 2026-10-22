// B2c 草稿态「回到上次实验」卡五锚——草稿卡渲染（title＋workspace）／点击→pending 且零 POST／
// sessionId 出现→恰一次 POST 正确 runId（消费即清不复燃）／已绑定·有会话态不出卡／
// 消费失败 toast 业务文案不静默丢。
// 承载形态沿 sessionBindingUi.test.ts 定案：client.js 真 factory 加载（new Function＋
// __ModuleLoader__ 桩）×真 React/ReactDOM（jsdom 全局先于 React 动态 import）×fetch 桩
// （session-binding GET 无 sessionId＝草稿载荷·带 sessionId＝绑定载荷·POST 可控成败）。
// 渲染挂点＝shell.overlay（root 域 list 槽——conversation 域 list 槽全为 session 域不渲染
// 草稿态，hero/composer session-maybe 槽全为 single 替换槽；选型取证见实现注）。
// D64 修订：草稿判据＝store.heroMounted（conversation.hero.brand.mark 槽组件
// HeroBrandMarkSignal 挂载/卸载双向维护——store.sessionId 无清零写点会残留旧 id 毒化，
// 门R0 FAIL「组件绿、页面不可见」根因）；草稿场景须先挂 hero 信号组件（renderHero）。
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { JSDOM } = vendorRequire("jsdom") as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dom: any = new JSDOM("<!doctype html><html><body><div id='atf-h'></div><div id='atf-o'></div></body></html>", {
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

// ── 夹具：草稿载荷（GET 无 sessionId——机器级最近实验）＋绑定载荷（GET 带 sessionId）──
const DRAFT_PAYLOAD = (): Record<string, unknown> => ({
  draft: true,
  active: null,
  unbound_reason: null,
  recent: [
    { run_id: "run-a", workspace: "af-prodtest-20261017", title: "装箱单 4类", mtime: "2026-10-19T09:00:00.000Z" },
    { run_id: "run-b", workspace: null, title: "冒烟验证", mtime: "2026-10-18T09:00:00.000Z" },
  ],
  candidates: [],
});
const BOUND_PAYLOAD = (): Record<string, unknown> => ({
  binding: {
    schema_version: "SessionRunBinding/v1",
    workspace: "af-prodtest-20261017", active_run_id: "run-a", source: "user_pick", unbound_reason: null,
    updated_at: "2026-10-20T08:00:00Z",
    history: [],
  },
  active: { run_id: "run-a", workspace: "af-prodtest-20261017", title: "装箱单 4类" },
  unbound_reason: null,
  recent: DRAFT_PAYLOAD().recent,
  candidates: [],
});

interface FetchCall { url: string; method?: string; body?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Registration = { options: any; content?: (injected?: any) => any };

describe("B2c 草稿态回到上次实验卡（client.js 真加载·jsdom）", () => {
  let overlayEl: HTMLElement;
  let heroEl: HTMLElement;
  let oroot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let hroot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let captured: Record<string, Registration[]>;
  const fetchCalls: FetchCall[] = [];
  let postStatus = 200;
  let headerInject: ((sessionId: string | undefined) => unknown) | null = null;

  function boot(): void {
    overlayEl = dom.window.document.getElementById("atf-o");
    overlayEl.innerHTML = "";
    fetchCalls.length = 0;
    postStatus = 200;
    headerInject = null;
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: { method?: string; body?: string }) => {
      const call: FetchCall = { url: String(url), method: init?.method, body: init?.body };
      fetchCalls.push(call);
      const u = String(url);
      if (init?.method === "POST") {
        const body = postStatus === 200 ? { saved: true } : { error: "internal", message: "绑定服务暂不可用" };
        return Promise.resolve(new Response(JSON.stringify(body), { status: postStatus }));
      }
      if (u.indexOf("/atf-ui/session-binding") === 0 && u.indexOf("sessionId=") < 0) {
        // 草稿态载荷（GET 无 sessionId——server 侧 B2c 扩展同形）
        return Promise.resolve(new Response(JSON.stringify(DRAFT_PAYLOAD()), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/session-binding?sessionId=") >= 0) {
        return Promise.resolve(new Response(JSON.stringify(BOUND_PAYLOAD()), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/snapshot") >= 0 || u.indexOf("/atf-ui/events") >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ monitor: { runs: [] }, artifacts: { runs: [] } }), { status: 200 }));
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
      inject: (_name: string, factory: (injected?: unknown) => unknown) => factory(),
      register: (options: unknown, content?: unknown) => {
        const name = (options as { name: string }).name;
        (captured[name] ||= []).push({ options, content } as Registration);
        return () => undefined;
      },
    };
    const ctx = {
      slots,
      remote: {},
      sidebarRightTabs: { register: () => undefined },
      inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) => fn({ slots, modelDirectories: {}, sessions: {}, remote: {} }),
      effect: (fn: () => void, _name: string) => { fn(); },
    };
    const requireMap: Record<string, unknown> = { react: React, "react-dom": ReactDOM };
    moduleDef!.factory((name: string) => requireMap[name]).apply(ctx);
    // header.utilities 的 inject 工厂（sessionId 捕获点——pending 消费触发面）
    const headerRegs = captured["conversation.session.header.utilities"];
    headerInject = (sessionId: string | undefined) => headerRegs![0]!.options.inject(sessionId);
  }

  /** 草稿态信号：挂 hero.brand.mark 槽组件（HeroBrandMarkSignal effect → store.setHero(true)）。 */
  async function renderHero(): Promise<void> {
    const regs = captured["conversation.hero.brand.mark"];
    heroEl.innerHTML = "";
    hroot = createRoot(heroEl);
    await act(async () => { hroot!.render(React.createElement(regs![0]!.content as never)); });
    await flush();
  }

  async function renderOverlay(): Promise<void> {
    const regs = captured["shell.overlay"];
    if (oroot === null) oroot = createRoot(overlayEl);
    await act(async () => { oroot!.render(regs![0]!.content!()); });
    await flush();
  }
  /** 微任务双轮排空（fetch→json→setState 链落地）。 */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  function draftCard(): HTMLElement {
    const el = document.querySelector("[data-draft-resume]");
    if (el === null) throw new Error("draft resume card not found");
    return el as HTMLElement;
  }
  function goButton(): HTMLButtonElement {
    const btn = document.querySelector("[data-draft-resume-go]") as HTMLButtonElement | null;
    if (btn === null) throw new Error("draft resume go button not found");
    return btn;
  }
  function posts(): FetchCall[] {
    return fetchCalls.filter((c) => c.method === "POST");
  }

  beforeEach(() => {
    boot();
    heroEl = dom.window.document.getElementById("atf-h");
  });
  afterEach(async () => {
    if (oroot !== null) await act(async () => { oroot!.unmount(); });
    oroot = null;
    if (hroot !== null) await act(async () => { hroot!.unmount(); });
    hroot = null;
  });

  it("①草稿卡渲染：title＋workspace 在卡上（回到上次实验：装箱单 4类）", async () => {
    await renderHero();
    await renderOverlay();
    const card = draftCard();
    expect(card.textContent).toContain("回到上次实验：装箱单 4类");
    expect(card.textContent).toContain("af-prodtest-20261017");
    expect(card.textContent).toContain("自动绑定");
  });

  it("②点击→存 pending 且零 POST（草稿态无 sessionId 可绑）；重复点击不重复入队", async () => {
    await renderHero();
    await renderOverlay();
    await act(async () => { goButton().click(); });
    await flush();
    expect(posts().length).toBe(0); // 红线：草稿态零 POST
    // 待绑定可见反馈
    expect(draftCard().textContent).toContain("已选中——发送首条消息后自动绑定「装箱单 4类」");
    expect((goButton().textContent ?? "")).toContain("已选");
    // 重复点击＝同 run 不重复入队（pending 单份）＋仍零 POST
    await act(async () => { goButton().click(); });
    await flush();
    expect(posts().length).toBe(0);
    expect(draftCard().textContent).toContain("装箱单 4类");
  });

  it("③sessionId 出现→恰一次 POST 正确 runId（落账本走 B1 端点）；pending 消费后不复燃", async () => {
    await renderHero();
    await renderOverlay();
    await act(async () => { goButton().click(); });
    await flush();
    expect(posts().length).toBe(0);
    // 首条消息发出、sessionId 出现（header.utilities inject 工厂捕获点）
    await act(async () => { headerInject!("sess-1"); });
    await flush();
    expect(posts().length).toBe(1); // 恰一次
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ sessionId: "sess-1", runId: "run-a" });
    // 不复燃：同会话再 inject（重渲/切回）＝零新增 POST
    await act(async () => { headerInject!("sess-1"); });
    await flush();
    expect(posts().length).toBe(1);
    // 切另一会话同样零新增（意图已消费——不是跟随会话的持久态）
    await act(async () => { headerInject!("sess-2"); });
    await flush();
    expect(posts().length).toBe(1);
  });

  it("④有会话态不出卡（草稿卡自守卫）；草稿拉取只在草稿态发生；hero 卸载即收卡（D64 毒化根因锚）", async () => {
    await act(async () => { headerInject!("sess-1"); });
    await renderOverlay();
    expect(document.querySelector("[data-draft-resume]")).toBeNull();
    // 有会话态零草稿 GET（loadDraft 仅草稿态触发）
    const draftGets = fetchCalls.filter((c) => c.method === undefined && c.url.indexOf("/atf-ui/session-binding") === 0 && c.url.indexOf("sessionId=") < 0);
    expect(draftGets.length).toBe(0);
    // D64：会话→New session 切草稿——sessionId 残留旧值（无清零写点），卡仍须出现；
    // 再离开草稿（hero 卸载）→ 收卡。heroMounted 双向信号免疫 sessionId 毒化。
    await renderHero();
    await flush();
    expect(document.querySelector("[data-draft-resume]")).not.toBeNull();
    await act(async () => { hroot!.unmount(); });
    hroot = null;
    await flush();
    expect(document.querySelector("[data-draft-resume]")).toBeNull();
  });

  it("⑤消费失败：清 pending＋toast 业务文案（不静默丢、不自动重试）", async () => {
    await renderHero();
    await renderOverlay();
    await act(async () => { goButton().click(); });
    await flush();
    postStatus = 500;
    await act(async () => { headerInject!("sess-1"); });
    await flush();
    expect(posts().length).toBe(1); // 恰一次——失败不自动重试
    const toast = document.querySelector(".atf-draft-toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain("自动绑定上次实验失败");
    expect(toast!.textContent).toContain("绑定服务暂不可用");
    expect(toast!.textContent).toContain("手动绑定"); // 给下一步指引
  });
});
