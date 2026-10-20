/**
 * D11-2a 六锚——Sparkline 共享 0–100 域（恒值序列两线可分）／VRAM 转百分比＋total≤0 丢弃／
 * 未传 domain 源面回归钉／运行环境块四值＋权限档位 hint＋零键名／env 全—整块不渲染／
 * header 注册 id atf-monitor-pill（旧 id 零命中）。
 * 承载形态沿 sessionBindingUi.test.ts 定案（jsdom 全局先于 React 动态 import）。
 */
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

const WS_A = "af-prodtest-20261017";
/** run-a 的 env 面（④④⑤两态切换用）。 */
let envA: Record<string, string> = {
  base_model: "/data/LLM_model/Qwen3-VL-32B-Instruct",
  dataset_keys: "pl_detection",
  deepspeed: "zero2.json",
  lane: "goods",
};
/** GPU 历史序列（①②两态切换用）：util 恒 0、mem=10%（8192/81920）。 */
let gpuHistoryPoints: Array<{ ts: string; gpus: Array<{ index: number; util: number; memUsed: number; memTotal: number; temp: number | null; power: number | null; procTop: null }> }> = [];

const seg = (key: string, label: string, status: string): Record<string, unknown> => ({ key, label, status });
const MONITOR = (): unknown => ({
  schema: "AtfMonitor/v1",
  generated_at: new Date().toISOString(),
  gpu: { offline: false, utilization: "0%", memoryUsed: "8192MiB", memoryTotal: "80GiB" },
  gpu_all: [{ index: "0", utilization: "0%", memoryUsed: "8192MiB", memoryTotal: "81920MiB" }],
  runs: [
    {
      run_id: "run-a", workspace: WS_A, workspace_source: "bucket", state: "registered", state_reason: null,
      segments: [
        seg("register", "数据登记", "done"), seg("label_qc", "标注体检", "pending"),
        seg("experiment_config", "实验配置", "pending"), seg("publish", "契约发布", "pending"),
        seg("split", "数据切分", "pending"), seg("admission", "准入检查", "pending"),
        seg("training", "训练执行", "pending"), seg("evaluate", "评估与可视化", "pending"),
      ],
      display: { title: "装箱单 4类" },
      training: { active: false, points: [], pending_confirm: null },
      progress: null,
      env: envA,
      bound_sessions: ["sess-1"], viewers: [], ckpts: [], launch: null, metrics: null, gpu_binding: null,
      eval_rounds: [], eval_progress: null, eval_notices: [], train_notices: [], probe: null, trainlog_tail: null,
    },
  ],
});

interface FetchCall { url: string; method?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Registration = { options: any; content?: (injected?: any) => any };

describe("D11-2a sparkline 尺度与环境块（client.js 真加载·jsdom）", () => {
  let headerEl: HTMLElement;
  let paneEl: HTMLElement;
  let hroot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let proot: Awaited<ReturnType<typeof createRoot>> | null = null;
  let captured: Record<string, Registration[]>;

  function boot(): void {
    headerEl = dom.window.document.getElementById("atf-h");
    paneEl = dom.window.document.getElementById("atf-p");
    headerEl.innerHTML = "";
    paneEl.innerHTML = "";
    envA = {
      base_model: "/data/LLM_model/Qwen3-VL-32B-Instruct",
      dataset_keys: "pl_detection",
      deepspeed: "zero2.json",
      lane: "goods",
    };
    gpuHistoryPoints = [
      { ts: "2026-10-20T12:00:00.000Z", gpus: [{ index: 0, util: 0, memUsed: 8192, memTotal: 81920, temp: null, power: null, procTop: null }] },
      { ts: "2026-10-20T12:00:05.000Z", gpus: [{ index: 0, util: 0, memUsed: 8192, memTotal: 81920, temp: null, power: null, procTop: null }] },
      { ts: "2026-10-20T12:00:10.000Z", gpus: [{ index: 0, util: 0, memUsed: 8192, memTotal: 81920, temp: null, power: null, procTop: null }] },
    ];
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: { method?: string }) => {
      void init;
      const u = String(url);
      if (u.indexOf("/atf-ui/gpu-history") >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ points: gpuHistoryPoints }), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/snapshot") >= 0 || u.indexOf("/atf-ui/events") >= 0) {
        return Promise.resolve(new Response(JSON.stringify({ monitor: MONITOR(), artifacts: { runs: [] } }), { status: 200 }));
      }
      if (u.indexOf("/atf-ui/settings") >= 0) return Promise.resolve(new Response(JSON.stringify({ effort_defaults: {} }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    };
    let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    // 权限档位 hint 数据源（server 经 index tap 注入的同名全局——环境块右上 hint 消费）
    dom.window.__ATF_UI_CONFIG__ = { monitorPath: "atf-ui/monitor.json", permissionPreset: { key: "standard", label: "标准模式" } };
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
    moduleDef!.factory((name: string) => (name === "react" ? React : name === "react-dom" ? ReactDOM : undefined)).apply(ctx);
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  /** 开会话＋开监控＋展开 GPU 历史曲线（sparkline 渲染路径）。 */
  async function openExpandedPane(): Promise<void> {
    const regs = captured["conversation.session.header.utilities"];
    const injected = regs![0]!.options.inject("sess-1");
    hroot = createRoot(headerEl);
    await act(async () => { hroot!.render(regs![0]!.content!(injected)); });
    await flush();
    await act(async () => {
      Array.from(headerEl.querySelectorAll("button")).find((b) => (b.textContent ?? "") === "监控")!.click();
    });
    await flush();
    proot = createRoot(paneEl);
    await act(async () => { proot!.render(captured["sidebar.right.pane.tab"]![0]!.content!()); });
    await flush();
    const more = Array.from(paneEl.querySelectorAll(".atf-gpu-more button")).find((b) => (b.textContent ?? "").indexOf("展开") >= 0) as HTMLButtonElement;
    await act(async () => { more.click(); });
    await flush();
  }
  function sparkPolylines(): string[] {
    return Array.from(paneEl.querySelectorAll(".atf-gpu-spark polyline")).map((p) => p.getAttribute("points") ?? "");
  }
  /** polyline points 串 → y 值列（viewBox 单位）。 */
  function ysOf(points: string): number[] {
    return points.split(" ").map((pair) => Number(pair.split(",")[1]));
  }

  beforeEach(() => { boot(); });
  afterEach(async () => {
    if (hroot !== null) await act(async () => { hroot!.unmount(); });
    if (proot !== null) await act(async () => { proot!.unmount(); });
    hroot = null;
    proot = null;
  });

  it("①Sparkline 共享 0–100 域：util 恒 0 与 mem 恒 10% 两线 y 差 ≥1.5（viewBox 单位）", async () => {
    await openExpandedPane();
    const lines = sparkPolylines();
    expect(lines.length).toBe(2); // util 线＋VRAM 线
    const utilYs = ysOf(lines[0]!);
    const memYs = ysOf(lines[1]!);
    // 固定域 [0,100]：util 0% → y=20（clamp 上沿）；mem 10% → y=20-0.1*18=18.2——恒值序列不再重合
    for (const y of utilYs) expect(Math.abs(y - 20)).toBeLessThan(0.2);
    for (const y of memYs) expect(Math.abs(y - 18.2)).toBeLessThan(0.2);
    expect(Math.abs(utilYs[0]! - memYs[0]!)).toBeGreaterThanOrEqual(1.5);
  });

  it("②VRAM 转百分比＋total≤0 采样丢弃（50% → y=11；全 total=0 → 单线）", async () => {
    gpuHistoryPoints = [
      { ts: "2026-10-20T12:00:00.000Z", gpus: [{ index: 0, util: 30, memUsed: 40960, memTotal: 81920, temp: null, power: null, procTop: null }] },
      { ts: "2026-10-20T12:00:05.000Z", gpus: [{ index: 0, util: 30, memUsed: 40960, memTotal: 81920, temp: null, power: null, procTop: null }] },
      { ts: "2026-10-20T12:00:10.000Z", gpus: [{ index: 0, util: 30, memUsed: 40960, memTotal: 0, temp: null, power: null, procTop: null }] },
    ];
    await openExpandedPane();
    const lines = sparkPolylines();
    expect(lines.length).toBe(2);
    const memYs = ysOf(lines[1]!);
    expect(memYs.length).toBe(2); // total=0 的第三拍丢弃
    // 40960/81920=50% → y=20-0.5*18=11（固定域换算而非 MiB 绝对值）
    for (const y of memYs) expect(Math.abs(y - 11)).toBeLessThan(0.2);
    const utilYs = ysOf(lines[0]!);
    for (const y of utilYs) expect(Math.abs(y - 14.6)).toBeLessThan(0.2); // 30% → 20-0.3*18
    // 全 total=0 → VRAM 线整条不画（单线）
    gpuHistoryPoints = [
      { ts: "2026-10-20T12:00:00.000Z", gpus: [{ index: 0, util: 10, memUsed: 100, memTotal: 0, temp: null, power: null, procTop: null }] },
      { ts: "2026-10-20T12:00:05.000Z", gpus: [{ index: 0, util: 10, memUsed: 100, memTotal: 0, temp: null, power: null, procTop: null }] },
    ];
    await act(async () => { proot!.unmount(); });
    proot = null;
    await act(async () => { proot = createRoot(paneEl); proot!.render(captured["sidebar.right.pane.tab"]![0]!.content!()); });
    await flush();
    const more = Array.from(paneEl.querySelectorAll(".atf-gpu-more button")).find((b) => (b.textContent ?? "").indexOf("展开") >= 0) as HTMLButtonElement;
    await act(async () => { more.click(); });
    await flush();
    expect(sparkPolylines().length).toBe(1); // 仅 util 线
  });

  it("③未传 domain 回归钉＋域分支源面在位（Sparkline 双形态）", () => {
    const src = readFileSync(CLIENT_PATH, "utf8");
    expect(src).toContain("Array.isArray(props.domain)"); // 固定域分支
    expect(src).toContain("min = Math.min.apply(null, values)"); // 未传 domain＝序列自身 min/max（现状回归面）
    expect(src).toContain("domain: [0, 100]"); // GPU 卡内两处调用均传共享域
    expect(src).toContain("if (y < 2) y = 2"); // y clamp [2,20]
    expect(src).toContain("if (y > 20) y = 20");
  });

  it("④环境块四值渲染：2×2＋权限档位 hint＋业务标签零键名", async () => {
    await openExpandedPane();
    const grid = paneEl.querySelector(".atf-env-grid");
    expect(grid).not.toBeNull();
    const secTitle = Array.from(paneEl.querySelectorAll(".atf-sec-t")).find((t) => t.textContent === "运行环境");
    expect(secTitle).toBeDefined();
    const keys = Array.from(paneEl.querySelectorAll(".atf-env-k")).map((k) => k.textContent);
    expect(keys).toEqual(["基模型", "数据集", "并行", "通道"]);
    const vals = Array.from(paneEl.querySelectorAll(".atf-env-v")).map((v) => v.textContent);
    expect(vals![0]).toContain("Qwen3-VL-32B-Instruct");
    expect(vals![2]).toContain("zero2.json");
    // 零键名（用户可见面）
    const blockText = (grid!.parentElement?.textContent ?? "") + (paneEl.querySelector(".atf-env-grid")?.textContent ?? "");
    expect(blockText).not.toContain("base_model");
    expect(blockText).not.toContain("deepspeed");
    expect(blockText).not.toContain("dataset_keys");
    expect(blockText).not.toContain("lane");
    // 权限档位 hint（server 注入面 label||key——测试窗注入 __ATF_UI_CONFIG__）
    const hint = Array.from(paneEl.querySelectorAll(".atf-sec-hint")).map((h) => h.textContent ?? "").find((t) => t.indexOf("权限档位") >= 0);
    expect(hint).toBeDefined();
    expect(hint).toContain("标准模式");
  });

  it("⑤env 全— → 整块不渲染（无运行环境标题无网格）；部分缺失逐项 —", async () => {
    envA = { base_model: "—", dataset_keys: "—", deepspeed: "—", lane: "—" };
    await openExpandedPane();
    expect(paneEl.querySelector(".atf-env-grid")).toBeNull();
    expect(Array.from(paneEl.querySelectorAll(".atf-sec-t")).some((t) => t.textContent === "运行环境")).toBe(false);
    // 部分缺失：lane 缺 → 该格 —，其余真值
    envA = { base_model: "/m/Qwen3-VL-32B-Instruct", dataset_keys: "pl", deepspeed: "zero2.json", lane: "" };
    await act(async () => { proot!.unmount(); });
    proot = null;
    await act(async () => { proot = createRoot(paneEl); proot!.render(captured["sidebar.right.pane.tab"]![0]!.content!()); });
    await flush();
    const vals = Array.from(paneEl.querySelectorAll(".atf-env-v")).map((v) => v.textContent);
    expect(vals).toEqual(["/m/Qwen3-VL-32B-Instruct", "pl", "zero2.json", "—"]);
  });

  it("⑥header 注册 id＝atf-monitor-pill（旧 id 全仓源面零命中）", () => {
    const src = readFileSync(CLIENT_PATH, "utf8");
    expect(src).toContain("id: 'atf-monitor-pill'");
    expect(src).not.toContain("atf-gpu-toggle");
    // inject 仍捕获 sessionId（B2 绑定链路不受 id 改名影响）
    expect(src).toContain("store.sessionId = sessionId");
  });
});
