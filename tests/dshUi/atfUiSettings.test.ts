// D11-1 训练配置页六锚——settings.section 原生迁移（自搓设置浮层退役）。
// 承载形态：client.js 真 factory 加载（new Function＋__ModuleLoader__ 桩）×真 React/ReactDOM
// 渲染（jsdom DOM——vendor 根 devDep 29.1.1 经 createRequire 运行时引入，repo devDependencies
// 零新增；vendor lockfile 锁版本，缺席＝显式 import 失败非静默）×fetch 桩读写闭环。
// 装配顺序硬约束：jsdom 全局（window/document）必须先于 React 动态 import——react-dom 载入
// 时做 canUseDOM＋isEventSupported('input') 特征检测，静态 import（ESM 提升先于全局装配）
// 会让 input/change 事件委托落入 IE polyfill 路径，合成事件永不触发 onChange（实验定案）。
// 厂商语义锚：settings.section＝list 槽（id 为 cell 键），注册项 {id, order, label}——
// D10.3 纪律（id 为丢弃变量）经 listSlotOptions 守卫，既有 atfUi.test.ts 计数锚 3→4 同步。
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const vendorRequire = createRequire(join(import.meta.dirname, "../../vendor/dsh/deepseek-harness/package.json"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsdom 无类型依赖面（运行时测试工具）
const { JSDOM } = vendorRequire("jsdom") as any;

// ── 模块级 jsdom（先于 React 装配；React 运行时只在载入期读一次全局特征）──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dom: any = new JSDOM("<!doctype html><html><body><div id='atf-test-root'></div></body></html>", {
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
// 全局就位后才可加载 React（动态 import——模块缓存保证与 client.js factory 拿到同一实例）
const React = (await import("react")).default;
const { act } = (await import("react")) as { act: (fn: () => Promise<void> | void) => Promise<unknown> };
const { createRoot } = await import("react-dom/client");
const ReactDOM = (await import("react-dom")).default;

const CLIENT_PATH = join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js");

// GET 载荷最小闭集（server.ts settingsPayload 同形——只含 client 消费键；字段名逐字）
const SETTINGS_PAYLOAD = {
  storage: {
    set: {},
    effective: {
      atf_root: "/data/atf-root",
      model_root: "/data/models",
      train_env: "/opt/venv-train",
      eval_env: "/opt/venv-eval",
      train_gpu_baseline: "2",
    },
  },
  effort_defaults: {},
  gpu_detected: 2,
  gpu_baseline_effective: "2",
  readonly: { kernel_version: "v0.7.21b0", approval_ledger: "~/.atf/approvals.jsonl", key_status: "已配置", instance_id: "dev" },
  hints: {},
};

interface FetchCall { url: string; method?: string; body?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Registration = { options: any; content?: (injected?: any) => any };

describe("D11-1 训练配置页迁原生 settings.section（client.js 真加载六锚）", () => {
  let container: HTMLElement;
  let root: Awaited<ReturnType<typeof createRoot>> | null = null;
  let captured: Record<string, Registration[]>;
  const fetchCalls: FetchCall[] = [];
  let confirmCalls: string[];
  let confirmResult: boolean;
  let postResponse: () => { status: number; body: unknown };

  // client.js 单次加载＝模块单例（store/effort 缓存闭包内）——逐 it 重评源码＋清容器防串状态
  function boot(): void {
    container = dom.window.document.getElementById("atf-test-root");
    container.innerHTML = "";
    confirmCalls = [];
    confirmResult = true;
    postResponse = () => ({ status: 200, body: { saved: true, created_subdirs: [], warning: "", effort_defaults: {} } });
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: { method?: string; body?: string }) => {
      const call: FetchCall = { url: String(url), method: init?.method, body: init?.body };
      fetchCalls.push(call);
      if (init?.method === "POST") {
        const out = postResponse();
        return Promise.resolve(new Response(JSON.stringify(out.body), { status: out.status }));
      }
      return Promise.resolve(new Response(JSON.stringify(SETTINGS_PAYLOAD), { status: 200 }));
    };
    dom.window.confirm = (msg: string) => { confirmCalls.push(msg); return confirmResult; };

    let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    dom.window.__ModuleLoader__ = { load: (def: never) => { moduleDef = def as never; } };
    // eslint-disable-next-line no-new-func -- 测试内加载 client.js 本体（源面真加载，非片段提取）
    new Function("window", readFileSync(CLIENT_PATH, "utf8"))(dom.window);
    expect(moduleDef).not.toBeNull();
    captured = {};
    const slots = {
      // 声明感知 inject：测试内声明恒在位＝工厂立即执行（vendor 语义：缺席时延迟执行）
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
      inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) =>
        fn({ slots, modelDirectories: {}, sessions: {}, remote: {} }),
      effect: (fn: () => void, _name: string) => { fn(); },
    };
    const requireMap: Record<string, unknown> = { react: React, "react-dom": ReactDOM };
    moduleDef!.factory((name: string) => requireMap[name]).apply(ctx);
  }

  async function renderEl(el: React.ReactElement): Promise<void> {
    root = createRoot(container);
    await act(async () => { root!.render(el); });
  }
  /** 微任务/定时器双轮排空（fetch→json→setState 链全部落地） */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  async function renderSection(): Promise<void> {
    const regs = captured["settings.section"];
    await renderEl(regs![0]!.content!());
    await flush();
  }
  function inputs(): HTMLInputElement[] {
    return Array.from(container.querySelectorAll("input"));
  }
  function button(text: string): HTMLButtonElement {
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text);
    if (btn === undefined || btn === null) throw new Error("button not found: " + text);
    return btn;
  }
  /** React 受控输入：原生 value setter＋input 事件（jsdom 下触发 onChange）。
   *  act 包裹＝setState 同步提交（并发 root 下裸派发延迟到 scheduler tick，click 会读到旧闭包） */
  async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  async function clickSave(): Promise<void> {
    await act(async () => { button("保存").click(); });
    await flush();
  }
  function posts(): FetchCall[] {
    return fetchCalls.filter((c) => c.method === "POST");
  }

  beforeEach(() => {
    fetchCalls.length = 0;
    boot();
  });
  afterEach(async () => {
    if (root !== null) await act(async () => { root!.unmount(); });
    root = null;
  });

  it("①注册断言：settings.section 有 atf-training-config（order 900·label 训练配置）且内容为 createElement 组件边界", () => {
    const regs = captured["settings.section"];
    expect(regs?.length).toBe(1);
    expect(regs![0]!.options).toMatchObject({ name: "settings.section", id: "atf-training-config", order: 900, label: "训练配置" });
    // 组件边界：内容＝createElement 实例化（#310 教训——直调含 useState 函数整槽崩溃）
    const el = regs![0]!.content!();
    expect(React.isValidElement(el)).toBe(true);
  });

  it("②header 无「设置」按钮（DOM 断言）：GPU／监控仍在，设置入口零残留", async () => {
    const regs = captured["conversation.session.header.utilities"];
    expect(regs?.length).toBe(1);
    const injected = regs![0]!.options.inject("sess-1");
    await renderEl(regs![0]!.content!(injected));
    const texts = Array.from(container.querySelectorAll("button")).map((b) => b.textContent);
    expect(texts).toContain("GPU");
    expect(texts.some((t) => (t ?? "").indexOf("监控") >= 0)).toBe(true);
    expect(texts).not.toContain("设置");
    expect(container.textContent).not.toContain("设置（根目录");
  });

  it("③读写闭环（mock fetch）：读渲染四组字段→改训练环境→保存 POST {storage:{…}} 体逐字", async () => {
    await renderSection();
    // 四分组标题（指令 §二 闭集）
    for (const t of ["数据与存储", "运行环境", "训练基线", "只读信息"]) {
      expect(container.textContent).toContain(t);
    }
    // 用户可见文案零键名（业务表述）
    for (const t of ["数据根目录", "模型库位置", "训练环境（venv 绝对路径）", "评估环境（venv 绝对路径）", "训练卡数基线"]) {
      expect(container.textContent).toContain(t);
    }
    expect(container.textContent).not.toContain("atf_root");
    const fields = inputs();
    expect(fields.length).toBe(5);
    expect(fields[0]!.value).toBe("/data/atf-root");
    expect(fields[4]!.value).toBe("2"); // train_gpu_baseline 缺省＝探测拉满（gpu_baseline_effective）
    // 修改→保存：POST 请求体逐字（键闭集＝五字段，storage 分区；无 effort_defaults 混入）
    await typeInto(fields[2]!, "/opt/venv-train-new");
    await clickSave();
    expect(posts().length).toBe(1);
    expect(posts()[0]!.url).toBe("/atf-ui/settings");
    expect(JSON.parse(posts()[0]!.body!)).toEqual({
      storage: {
        atf_root: "/data/atf-root",
        model_root: "/data/models",
        train_env: "/opt/venv-train-new",
        eval_env: "/opt/venv-eval",
        train_gpu_baseline: "2",
      },
    });
    expect(container.textContent).toContain("已保存");
  });

  it("④数据根目录变更触发确认卡：拒绝零 POST；确认后放行且携带新根", async () => {
    await renderSection();
    expect(posts().length).toBe(0);
    await typeInto(inputs()[0]!, "/data/other-root");
    confirmResult = false;
    await clickSave();
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0]).toContain("根目录已改动");
    expect(posts().length).toBe(0); // 拒绝＝零 POST
    confirmResult = true;
    await clickSave();
    expect(posts().length).toBe(1);
    expect((JSON.parse(posts()[0]!.body!) as { storage: { atf_root: string } }).storage.atf_root).toBe("/data/other-root");
  });

  it("⑤400 错误映射：字段标红（红边）＋原因文案＋整卡提示；未涉字段不连坐", async () => {
    await renderSection();
    postResponse = () => ({ status: 400, body: { saved: false, errors: { train_env: "venv 路径不存在" } } });
    await typeInto(inputs()[2]!, "/bad/venv");
    await clickSave();
    expect(container.textContent).toContain("保存被拒绝——请修正标红项");
    expect(container.textContent).toContain("venv 路径不存在");
    expect(inputs()[2]!.getAttribute("style")).toContain("--dsw-static-red-500");
    expect(inputs()[0]!.getAttribute("style")).not.toContain("--dsw-static-red-500");
    // 恢复保存：错误面清除（errors 复位——再保存 200 后提示成功）
    postResponse = () => ({ status: 200, body: { saved: true, created_subdirs: [], warning: "", effort_defaults: {} } });
    await clickSave();
    await flush();
    expect(container.textContent).toContain("已保存");
    expect(container.textContent).not.toContain("venv 路径不存在");
  });

  it("⑥只读块渲染＋旧浮层不可达（无 atf-viewer-overlay 设置实例；SettingsPanel/setSettings 源面清零）", async () => {
    await renderSection();
    expect(container.textContent).toContain("内核版本：v0.7.21b0");
    expect(container.textContent).toContain("审批记录位置：~/.atf/approvals.jsonl");
    expect(container.textContent).toContain("模型凭据：已配置");
    expect(container.textContent).toContain("实例：dev");
    // 只读信息灰底块（次要呈现）＋训练配置页非浮层（原生 section 内联内容）
    expect(container.querySelector(".atf-viewer-overlay")).toBeNull();
    const src = readFileSync(CLIENT_PATH, "utf8");
    expect(src).not.toContain("function SettingsPanel");
    expect(src).not.toContain("setSettings"); // 开合态入口清零（store.settings 不可达）
  });
});
