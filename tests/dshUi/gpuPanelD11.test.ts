// D11-2 运行监控面板——数据面（采集扩展/进程 top1/GPU 历史追加与读取/两新路由）＋面板结构（jsdom）。
// 复用钉：进程解析唯一面＝readOnlyTools.parseComputeAppsWithIndex（本文件只测其归约 gpuProcTopByIndex）。
// 面板结构用例以 client.js 真 factory 加载承载（同 atfUiSettings.test.ts 形态——jsdom＋真 React）。
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLIENT_PATH = join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js");
const CLIENT_SRC = () => readFileSync(CLIENT_PATH, "utf8");
const SERVER_SRC = () => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/src/server.ts"), "utf8");

describe("D11-2 数据面——进程 top1 归约（复用钉：解析只在 readOnlyTools 一处）", () => {
  it("gpuProcTopByIndex：多进程取 usedMemory 最大；空/无归属/非数值 → 不归属（不猜）", async () => {
    const { gpuProcTopByIndex, parseComputeAppsWithIndex } = await import("../../src/webui/readOnlyTools.js");
    // 真解析链端到端：compute-apps 输出 × index,uuid 对表 → top1 归约
    const apps = parseComputeAppsWithIndex(
      "111, python, 42188, UUID-A\n222, python, 28416, UUID-A\n333, python, 9000, UUID-B\n",
      "0, UUID-A\n1, UUID-B\n",
    );
    expect(apps).not.toBeNull();
    const top = gpuProcTopByIndex(apps!);
    expect(top.get("0")).toEqual({ pid: "111", name: "python", memMiB: 42188 }); // 42188 > 28416
    expect(top.get("1")).toEqual({ pid: "333", name: "python", memMiB: 9000 });
    // uuid 对不上 → gpuIndex null → 不归属
    const orphan = parseComputeAppsWithIndex("444, python, 500, UUID-X\n", "0, UUID-A\n");
    expect(orphan![0]!.gpuIndex).toBeNull();
    expect(gpuProcTopByIndex(orphan!).size).toBe(0);
    // 非数值显存行跳过；空列表 → 空 Map
    const bad = parseComputeAppsWithIndex("555, python, [N/A], UUID-A\n", "0, UUID-A\n");
    expect(gpuProcTopByIndex(bad!).size).toBe(0);
    expect(gpuProcTopByIndex([]).size).toBe(0);
    // 全仓 nvidia-smi 查询串闭集（§一.5 复用钉——无第二套查询串）
    const tools = readFileSync(join(import.meta.dirname, "../../src/webui/readOnlyTools.ts"), "utf8");
    const queries = tools.match(/--query-[a-z-]+=[a-z._,]+/g) ?? [];
    expect(queries).toContain("--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw");
    // 三条 query-gpu＝All 面（D11-2 扩展）＋单卡面（atf_gpu_status 工具）＋uuid 对表面（进程归属）
    expect(queries.filter((q) => q.startsWith("--query-gpu="))).toHaveLength(3);
    expect(queries.filter((q) => q.startsWith("--query-compute-apps="))).toHaveLength(2); // 归属面＋单卡 top 面（既有）
  });
});

describe("D11-2 数据面——GPU 历史追加/轮转/读取（真 fs tmpdir）", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atf-gpuhist-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("buildGpuHistoryRow：键闭集一行一拍；temp/power 直通/空集 → null（不写空拍）", async () => {
    const { buildGpuHistoryRow } = await import("../../packages/extensions/atf-ui/src/server.js");
    const now = new Date("2026-10-19T12:03:11.000Z");
    const row = buildGpuHistoryRow(
      now,
      [{ index: "0", utilization: "82%", memoryUsed: "48128MiB", memoryTotal: "81920MiB", temperature: 71, powerDraw: 310 }],
      new Map([["0", { pid: "12345", name: "python", memMiB: 42188 }]]),
    );
    expect(row).toEqual({
      ts: "2026-10-19T12:03:11.000Z",
      gpus: [{ index: 0, util: 82, memUsed: 48128, memTotal: 81920, temp: 71, power: 310, procTop: { pid: "12345", name: "python", memMiB: 42188 } }],
    });
    expect(buildGpuHistoryRow(now, [], new Map())).toBeNull();
    // 不可得温度 → null（不填 0）
    const row2 = buildGpuHistoryRow(now, [{ index: "1", utilization: "0%", memoryUsed: "0MiB", memoryTotal: "81920MiB", temperature: null, powerDraw: null }], new Map());
    expect(row2!.gpus[0]).toMatchObject({ index: 1, temp: null, power: null, procTop: null });
  });

  it("appendGpuHistory：一行一周期追加；写失败（atf-ui 为普通文件）不抛不阻断；7 天前文件清理", async () => {
    const mod = await import("../../packages/extensions/atf-ui/src/server.js");
    // D65：appendGpuHistory 按真实运行日取文件名（产品语义），fixture 日期随之按运行日生成
    // （此前写死 2026-10-19——仅 10-19 当天可过，任意日期复跑必挂；改测试不改产品）。
    // 基准取当天 12:00（非 now）：now 近午夜时 dayIso(+5s) 会跨天、追加行落进次日文件。
    const dayTs = new Date();
    dayTs.setHours(12, 0, 0, 0);
    const dayIso = (deltaS: number) => new Date(dayTs.getTime() + deltaS * 1000).toISOString();
    // 追加两拍 → 两行
    mod.appendGpuHistory(root, { ts: dayIso(0), gpus: [{ index: 0, util: 1, memUsed: 2, memTotal: 3, temp: null, power: null, procTop: null }] });
    mod.appendGpuHistory(root, { ts: dayIso(5), gpus: [{ index: 0, util: 5, memUsed: 6, memTotal: 7, temp: null, power: null, procTop: null }] });
    const day = mod.gpuHistoryFileName(dayTs);
    const lines = readFileSync(join(root, "atf-ui", day), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).gpus[0].util).toBe(5);
    // 写失败不抛：atf-ui 位被普通文件占据 → mkdir/append 全失败 → 静默（stderr 节流）
    const blocked = mkdtempSync(join(tmpdir(), "atf-gpublock-"));
    writeFileSync(join(blocked, "atf-ui"), "not a dir\n");
    expect(() =>
      mod.appendGpuHistory(blocked, { ts: "2026-10-19T12:00:00.000Z", gpus: [{ index: 0, util: 1, memUsed: 2, memTotal: 3, temp: null, power: null, procTop: null }] }),
    ).not.toThrow();
    rmSync(blocked, { recursive: true, force: true });
    // 7 天前文件清理（今天文件保留）
    mkdirSync(join(root, "atf-ui"), { recursive: true });
    writeFileSync(join(root, "atf-ui", "gpu-history-20261001.jsonl"), "{}\n");
    writeFileSync(join(root, "atf-ui", "gpu-history-20261012.jsonl"), "{}\n");
    const removed = mod.cleanupOldGpuHistory(root, new Date("2026-10-19T12:00:00.000Z"));
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(() => readFileSync(join(root, "atf-ui", "gpu-history-20261001.jsonl"))).toThrow();
  });

  it("历史读取：跨天两文件合并→窗口过滤→降采样 ≤maxPoints 且首末点在内；坏行跳过；缺失 → 空", async () => {
    const mod = await import("../../packages/extensions/atf-ui/src/server.js");
    const row = (iso: string, util: number) => ({ ts: iso, gpus: [{ index: 0, util, memUsed: 1, memTotal: 2, temp: null, power: null, procTop: null }] });
    mkdirSync(join(root, "atf-ui"), { recursive: true });
    // 昨天 23:58（窗口外两行＋窗口内两行）＋今天 00:01/00:03；一行坏 JSON
    writeFileSync(
      join(root, "atf-ui", "gpu-history-20261018.jsonl"),
      [row("2026-10-18T23:50:00.000Z", 1), row("2026-10-18T23:58:00.000Z", 2), "{broken", row("2026-10-18T23:59:30.000Z", 3)].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    );
    writeFileSync(
      join(root, "atf-ui", "gpu-history-20261019.jsonl"),
      [row("2026-10-19T00:01:00.000Z", 4), row("2026-10-19T00:03:00.000Z", 5)].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    const now = new Date("2026-10-19T00:03:30.000Z");
    // 窗口 5 分钟（cutoff＝23:58:30）→ 3 行在窗（坏行剔除；23:58:00 恰在窗外如实不取）
    const win = mod.readGpuHistoryWindow(root, now, 5, 60);
    expect(win.map((r: { ts: string }) => r.ts)).toEqual(["2026-10-18T23:59:30.000Z", "2026-10-19T00:01:00.000Z", "2026-10-19T00:03:00.000Z"]);
    // 降采样 maxPoints=3 → 首末点在内
    const down = mod.downsamplePoints(win as unknown[], 3);
    expect(down).toHaveLength(3);
    expect(down[0]).toBe(win[0]);
    expect(down[2]).toBe(win[2]);
    // 全窗不过限：窗口拉满 60 分钟（cutoff 23:03:30）→ 5 行全取（跨天合并；坏行不入列）
    expect(mod.readGpuHistoryWindow(root, now, 60, 60)).toHaveLength(5);
    // 文件缺失 → 空数组（不 500 面）
    expect(mod.readGpuHistoryWindow(mkdtempSync(join(tmpdir(), "atf-empty-")), now, 5, 60)).toEqual([]);
  });

  it("parseGpuHistoryQuery：minutes 缺省 5；0/61/abc → null；maxPoints 越界 → null", async () => {
    const { parseGpuHistoryQuery } = await import("../../packages/extensions/atf-ui/src/server.js");
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history")).toEqual({ minutes: 5, maxPoints: 60 });
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=5&maxPoints=60")).toEqual({ minutes: 5, maxPoints: 60 });
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=0")).toBeNull();
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=61")).toBeNull();
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=abc")).toBeNull();
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=5&maxPoints=0")).toBeNull();
    expect(parseGpuHistoryQuery("/atf-ui/gpu-history?minutes=5&maxPoints=2001")).toBeNull();
  });
});

describe("D33 GPU 排队横幅生命周期清零（scanRunDir probe 呈现面——alerts.json 落盘零动）", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atf-gpuqueue-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("排队中（训练未启动）＝gpu_queue 通知照常透传；训练有启动证据＝呈现清零（不残留旧计时）", async () => {
    const { scanRunDir } = await import("../../packages/extensions/atf-ui/src/server.js");
    const runDir = join(root, "run-q");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    const queueAlert = { level: "warn", kind: "gpu_queue", reason: "GPU 排队：需 8 卡、现空闲 0（已等待 32 秒）——空闲不足", since: "2026-10-21T00:00:12.000Z" };
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([queueAlert]));
    // 排队进行中（训练未启动——无任何启动证据）：横幅正常显示
    expect(scanRunDir(root, "run-q").probe).toMatchObject({ kind: "gpu_queue" });
    // 训练有启动证据（A3 闭集任一——此处 trainer_state.json）：排队事实被取代，probe 呈现清零
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_state.json"), "{}\n");
    expect(scanRunDir(root, "run-q").probe).toBeNull();
    // alerts.json 落盘零动（历史账保留——清零只在 monitor 呈现面）
    expect(JSON.parse(readFileSync(join(runDir, "webui", "alerts.json"), "utf8"))).toEqual([queueAlert]);
  });

  it("清零只作用于 gpu_queue：config_auto/oom_fallback 通报不受训练启动影响；非末条 gpu_queue 不连坐", async () => {
    const { scanRunDir } = await import("../../packages/extensions/atf-ui/src/server.js");
    const runDir = join(root, "run-q");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_state.json"), "{}\n");
    // 末条 config_auto（训练已启动）＝照常透传
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([
      { level: "info", kind: "config_auto", reason: "全自动训练档·配置自动确认", since: "2026-10-21T00:00:00.000Z" },
    ]));
    expect(scanRunDir(root, "run-q").probe).toMatchObject({ kind: "config_auto" });
    // 末条 probe 告警（训练已启动）＝照常透传
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([
      { level: "warn", kind: "gpu_queue", reason: "GPU 排队：需 8 卡（已等待 12 秒）", since: "2026-10-21T00:00:00.000Z" },
      { level: "error", kind: "probe", reason: "训练疑似停滞", since: "2026-10-21T00:05:00.000Z" },
    ]));
    expect(scanRunDir(root, "run-q").probe).toMatchObject({ kind: "probe", level: "error" });
  });
});

describe("D11-2 数据面——run-file 相对路径校验（纯函数）＋两新路由（handler 直调）", () => {
  let root = "";
  let handlers: Record<string, (req: unknown, res: unknown) => void>;
  const RES_JSON = { writeHead: [], body: "" as string, status: 0, ended: false } as unknown as {
    writeHead: Array<unknown>; body: string; status: number; ended: boolean;
    writeHeadFn(code: number, headers?: Record<string, string>): void; end(data?: string): void;
  };
  const makeRes = () => {
    const out: { code?: number; headers?: Record<string, string>; body?: string; writeHead(c: number, h?: Record<string, string>): void; end(d?: string): void } = {
      writeHead(c, h) { out.code = c; out.headers = h; },
      end(d) { out.body = d; },
    };
    return out;
  };
  const makeReq = (url: string) => ({ url, headers: {} });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "atf-runfile-"));
    mkdirSync(join(root, "run-a", "training", "checkpoint-68"), { recursive: true });
    writeFileSync(join(root, "run-a", "training", "checkpoint-68", "trainer_state.json"), '{"step":68}\n');
    writeFileSync(join(root, "run-a", ".env"), "SECRET=1\n");
    const registered: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const effects: Array<() => void> = [];
    const { apply: applyPlugin } = await import("../../packages/extensions/atf-ui/src/server.js");
    applyPlugin(
      {
        effect: (run: () => () => void) => { effects.push(run()); },
        webServer: {
          tapIndex: () => () => {},
          register: (route) => { registered.push(route as { kind: string; path: string; handler: (req: unknown, res: unknown) => void }); return () => {}; },
        },
        connection: { requestRejection: (req: never) => ((req as { blocked?: boolean }).blocked ? 403 : undefined) },
      },
      { runsRoot: root, intervalMs: 3_600_000 },
    );
    handlers = {};
    for (const r of registered) handlers[String(r.path)] = r.handler;
    expect(handlers["/atf-ui/gpu-history"]).toBeDefined();
    expect(handlers["/atf-ui/run-file"]).toBeDefined();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("run-file：白名单命中 200＋content-type；../绝对路径/.env/无扩展名/坏扩展/runId 非法/不存在 → 404 零绝对路径回显", () => {
    const h = handlers["/atf-ui/run-file"]!;
    // 命中
    const ok = makeRes();
    h(makeReq("/atf-ui/run-file?runId=run-a&rel=training%2Fcheckpoint-68%2Ftrainer_state.json"), ok);
    expect(ok.code).toBe(200);
    expect(String(ok.headers?.["content-type"])).toContain("application/json");
    expect(String(ok.body)).toContain('"step":68');
    // 越界族：一律 404
    for (const url of [
      "/atf-ui/run-file?runId=run-a&rel=..%2Fsecret.json",
      "/atf-ui/run-file?runId=..&rel=x.json",
      "/atf-ui/run-file?runId=run-a&rel=%2Fetc%2Fpasswd.json",
      "/atf-ui/run-file?runId=run-a&rel=.env",
      "/atf-ui/run-file?runId=run-a&rel=README",
      "/atf-ui/run-file?runId=run-a&rel=train.sh",
      "/atf-ui/run-file?runId=run-a&rel=training%2Fcheckpoint-68%2Fmissing.json",
      "/atf-ui/run-file?runId=run-zzz&rel=x.json",
      "/atf-ui/run-file",
    ]) {
      const res = makeRes();
      h(makeReq(url), res);
      expect(res.code).toBe(404);
      expect(String(res.body)).not.toContain(root); // 绝对路径零回显
    }
    // 鉴权：requestRejection 命中 → 403
    const denied = makeRes();
    h({ url: "/atf-ui/run-file?runId=run-a&rel=x.json", headers: {}, blocked: true }, denied);
    expect(denied.code).toBe(403);
  });

  it("run-file：分桶 run 双形态解析（bucket-x/run-b 命中——真机 a31-ready-run 404 实证回归锚）", () => {
    mkdirSync(join(root, "bucket-x", "run-b", "launch"), { recursive: true });
    writeFileSync(join(root, "bucket-x", "run-b", "launch", "launch_manifest.json"), "{}\n");
    const h = handlers["/atf-ui/run-file"]!;
    const res = makeRes();
    h(makeReq("/atf-ui/run-file?runId=run-b&rel=launch%2Flaunch_manifest.json"), res);
    expect(res.code).toBe(200);
    expect(String(res.body)).toContain("{}");
  });

  it("run-file：符号链接逃逸拒（realpath 出 runsRoot → 404）", () => {
    const outside = mkdtempSync(join(tmpdir(), "atf-outside-"));
    writeFileSync(join(outside, "leak.json"), "{}\n");
    symlinkSync(join(outside, "leak.json"), join(root, "run-a", "leak.json"));
    const h = handlers["/atf-ui/run-file"]!;
    const res = makeRes();
    h(makeReq("/atf-ui/run-file?runId=run-a&rel=leak.json"), res);
    expect(res.code).toBe(404);
    rmSync(outside, { recursive: true, force: true });
  });

  it("gpu-history 路由：正常 200＋points 形态；minutes 非法 400；文件缺失 200 空数组；鉴权 403", async () => {
    const mod = await import("../../packages/extensions/atf-ui/src/server.js");
    mod.appendGpuHistory(root, { ts: new Date().toISOString(), gpus: [{ index: 0, util: 7, memUsed: 1, memTotal: 2, temp: null, power: null, procTop: null }] });
    const h = handlers["/atf-ui/gpu-history"]!;
    // 注：applyPlugin 即拍 tickOnce 在本机（nvidia-smi 在位）已向 tmp 根写入真采集行——
    // 路由级只断言形态（缺失→空数组的语义由 readGpuHistoryWindow 单测覆盖）
    mod.appendGpuHistory(root, { ts: new Date().toISOString(), gpus: [{ index: 99, util: 7, memUsed: 1, memTotal: 2, temp: null, power: null, procTop: null }] });
    const ok = makeRes();
    h(makeReq("/atf-ui/gpu-history?minutes=5&maxPoints=10"), ok);
    expect(ok.code).toBe(200);
    const payload = JSON.parse(ok.body!) as { generated_at: string; window_minutes: number; points: Array<{ ts: string; gpus: unknown[] }> };
    expect(payload.window_minutes).toBe(5);
    expect(Array.isArray(payload.points)).toBe(true);
    expect(payload.points.some((p) => p.gpus.some((g) => (g as { index: number }).index === 99))).toBe(true);
    for (const pt of payload.points) {
      expect(typeof pt.ts).toBe("string");
      expect(Array.isArray(pt.gpus)).toBe(true);
    }
    expect(String(ok.headers?.["cache-control"])).toContain("no-store");
    const bad = makeRes();
    h(makeReq("/atf-ui/gpu-history?minutes=0"), bad);
    expect(bad.code).toBe(400);
    const denied = makeRes();
    h({ url: "/atf-ui/gpu-history?minutes=5", headers: {}, blocked: true }, denied);
    expect(denied.code).toBe(403);
  });
});

describe("D11-2 面板结构＋去重钉（client.js 源面锚＋jsdom 渲染）", () => {
  it("去重钉：header 渲染面零「GPU」按钮（inject 工厂 sessionId 捕获保留）；dock 零 GPU 一行卡；store open 三件清零", () => {
    const src = CLIENT_SRC();
    expect(src).not.toContain("'GPU 状态卡显隐'");
    expect(src).not.toContain("React.createElement(GpuCard)");
    expect(src).not.toContain("store.setOpen");
    expect(src).not.toContain("getOpen");
    // sessionId 捕获唯一点保留（作用域过滤数据源）
    expect(src).toContain("store.sessionId = sessionId");
    // 顶栏只留「监控」
    expect(src).toContain("React.createElement(MonitorTogglePill)");
    // 面板区块类名在位（结构锚：4 列↔2 列类切换、Loss 刻度、产物区、日志区）
    expect(src).toContain("atf-gpu-grid");
    expect(src).toContain("atf-gpu-grid-expanded");
    expect(src).toContain("atf-chart-tick");
    expect(src).toContain("atf-art2-row");
    expect(src).toContain("atf-m-logs");
    // 用户可见面零内部文件名/键名（React 文本节点不上屏；路径常量/注释不在此列）
    for (const banned of ["monitor\.json", "gpu_all", "progress\.json"]) {
      expect(src).not.toMatch(new RegExp("createElement\\([^)]*'" + banned));
    }
  });
});

// ── 面板结构（jsdom——jsdom 全局先于 React 动态 import，装配顺序硬约束同 atfUiSettings.test.ts）──
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
const { act } = (await import("react")) as { act: (fn: () => Promise<void> | void) => Promise<unknown> };
const { createRoot } = await import("react-dom/client");
const ReactDOM = (await import("react-dom")).default;

/** D11-2 面板载荷（monitor.json 快照最小闭集——server settingsPayload/monitor 同形键名）。 */
function panelPayload(stale = false) {
  return {
    monitor: {
      schema: "AtfMonitor/v1",
      generated_at: new Date(Date.now() - (stale ? 45_000 : 2_000)).toISOString(),
      gpu: { offline: false, utilization: "82%", memoryUsed: "48128MiB", memoryTotal: "81920MiB" },
      gpu_all: [
        { index: "0", utilization: "82%", memoryUsed: "48128MiB", memoryTotal: "81920MiB", temperature: 71, powerDraw: 310 },
        { index: "1", utilization: "0%", memoryUsed: "8192MiB", memoryTotal: "81920MiB", temperature: 41, powerDraw: 36 },
      ],
      runs: [
        {
          run_id: "run-d11",
          state: "registered",
          workspace: null,
          workspace_source: "bucket",
          segments: [
            { key: "register", label: "数据登记", status: "done" },
            { key: "label_qc", label: "标注体检", status: "done" },
            { key: "experiment_config", label: "实验配置", status: "active" },
            { key: "publish", label: "契约发布", status: "pending" },
            { key: "split", label: "数据切分", status: "pending" },
            { key: "admission", label: "准入检查", status: "pending" },
            { key: "training", label: "训练执行", status: "pending" },
            { key: "evaluate", label: "评估与可视化", status: "pending" },
          ],
          viewers: [],
          ckpts: ["checkpoint-68"],
          launch: null,
          metrics: { round: 3, f1: 0.736 },
          env: null,
          gpu_binding: { devices: "0,1", source: "train_sh" },
          eval_rounds: [],
          progress: null,
          bound_sessions: ["sess-1"],
          trainlog_tail: { captured_at: new Date().toISOString(), lines: ["step 64/107 loss 0.101", "step 65/107 loss 0.099"] },
          eval_progress: null,
          eval_notices: [],
          train_notices: [],
          probe: null,
          training: {
            active: true,
            points: [
              { step: 10, train_loss: 0.3, eval_loss: 0.32 },
              { step: 20, train_loss: 0.2 },
              { step: 30, train_loss: 0.11, eval_loss: 0.15 },
              { step: 40, train_loss: 0.098 },
            ],
            pending_confirm: null,
          },
        },
      ],
    },
    artifacts: {
      schema: "AtfArtifacts/v1",
      generated_at: new Date().toISOString(),
      runs: [{ run_id: "run-d11", path_prefix: "", artifacts: [{ name: "launch manifest（sha 索引）", path: "run-d11/launch/launch_manifest.json", kind: "json" }] }],
    },
  };
}

describe("D11-2 面板结构（client.js 真加载·jsdom 渲染）", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: Record<string, Array<{ options: any; content?: (injected?: any) => any }>>;
  const fetchCalls: Array<{ url: string; method?: string }> = [];
  let gpuHistoryPayload: { points: unknown[] } = { points: [] };
  let stale = false;
  let emptyLoss = false;
  const openCalls: string[] = [];

  function boot(): void {
    fetchCalls.length = 0;
    stale = false;
    emptyLoss = false;
    gpuHistoryPayload = { points: [] };
    const payload = () => {
      const full = panelPayload(stale);
      if (emptyLoss) full.monitor.runs[0]!.training.points = [];
      return { monitor: full.monitor, artifacts: full.artifacts };
    };
    (globalThis as Record<string, unknown>).fetch = (url: string, init?: { method?: string }) => {
      fetchCalls.push({ url: String(url), method: init?.method });
      const u = String(url);
      if (u.indexOf("/atf-ui/gpu-history") >= 0) return Promise.resolve(new Response(JSON.stringify(gpuHistoryPayload), { status: 200 }));
      if (u.indexOf("/atf-ui/settings") >= 0) return Promise.resolve(new Response(JSON.stringify({ effort_defaults: {} }), { status: 200 }));
      if (u.indexOf("/atf-ui/snapshot") >= 0 || u.indexOf("/atf-ui/events") >= 0) return Promise.resolve(new Response(JSON.stringify(payload()), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    };
    dom.window.open = (url: string) => { openCalls.push(String(url)); return null; };
    let moduleDef: { factory: (req: (name: string) => unknown) => { apply: (ctx: unknown) => void } } | null = null;
    dom.window.__ModuleLoader__ = { load: (def: never) => { moduleDef = def as never; } };
    // eslint-disable-next-line no-new-func -- client.js 本体真加载
    new Function("window", readFileSync(CLIENT_PATH, "utf8"))(dom.window);
    captured = {};
    const slots = {
      inject: (_name: string, factory: () => unknown) => factory(),
      register: (options: unknown, content?: unknown) => {
        const name = (options as { name: string }).name;
        (captured[name] ||= []).push({ options, content } as never);
        return () => undefined;
      },
    };
    const ctx = {
      slots,
      remote: {},
      sidebarRight: undefined, // openResource 面缺席 → 产物打开走 window.open 回退（断言可观测）
      sidebarRightTabs: { register: () => undefined },
      inject: (_services: string[], fn: (scope: Record<string, unknown>) => void) => fn({ slots, modelDirectories: {}, sessions: {}, remote: {} }),
      effect: (fn: () => void, _name: string) => { fn(); },
    };
    moduleDef!.factory((name: string) => (name === "react" ? React : name === "react-dom" ? ReactDOM : undefined)).apply(ctx);
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  beforeEach(() => boot());
  afterEach(async () => {
    await act(async () => {
      dom.window.document.getElementById("atf-h")!.innerHTML = "";
      dom.window.document.getElementById("atf-p")!.innerHTML = "";
    });
  });

  it("顶栏去重（DOM）：GPU／设置按钮零残留，只留监控；监控点击开右栏面板", async () => {
    const regs = captured["conversation.session.header.utilities"];
    const container = dom.window.document.getElementById("atf-h")!;
    const root = createRoot(container);
    const injected = regs![0]!.options.inject("sess-1");
    await act(async () => { root.render(regs![0]!.content!(injected)); });
    const texts = Array.from(container.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).map((b) => b.textContent);
    expect(texts).toContain("监控");
    expect(texts).not.toContain("GPU");
    expect(texts).not.toContain("设置");
    // 点击「监控」→ store.monitorOpen 翻真（store 在模块闭包内——经 pane 渲染面间接观测）
    const pill = Array.from(container.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).find((b) => b.textContent === "监控")!;
    await act(async () => { pill.click(); });
    const preg = captured["sidebar.right.pane.tab"];
    const pcontainer = dom.window.document.getElementById("atf-p")!;
    const proot = createRoot(pcontainer);
    await act(async () => { proot.render(preg![0]!.content!()); });
    await flush();
    expect(pcontainer.textContent).not.toContain("监控已关闭");
    expect(pcontainer.querySelector(".atf-monitor-panel")).not.toBeNull();
    await act(async () => { proot.unmount(); });
    await act(async () => { root.unmount(); });
  });

  it("面板逐区块：顶部条/八段/KPI×4/Loss 刻度与开关/GPU 4 列/产物/日志；展开→2 列＋sparkline＋进程；数据陈旧角标", async () => {
    // 先经头栏开监控（store 态），再渲染 pane 内容
    const hregs = captured["conversation.session.header.utilities"];
    const hcontainer = dom.window.document.getElementById("atf-h")!;
    const hroot = createRoot(hcontainer);
    await act(async () => { hroot.render(hregs![0]!.content!(hregs![0]!.options.inject("sess-1"))); });
    const pill = Array.from(hcontainer.querySelectorAll("button") as NodeListOf<HTMLButtonElement> as NodeListOf<HTMLButtonElement>).find((b) => b.textContent === "监控")!;
    await act(async () => { pill.click(); });

    const preg = captured["sidebar.right.pane.tab"];
    const container = dom.window.document.getElementById("atf-p")!;
    const root = createRoot(container);
    await act(async () => { root.render(preg![0]!.content!()); });
    await flush();
    await flush();

    // ① 顶部条
    expect(container.textContent).toContain("运行监控");
    expect(container.textContent).toContain("训练中");
    // ② 八段 stepper（8 节点、禁 unknown、pending 指因 tooltip）
    const segs = container.querySelectorAll(".atf-m-seg");
    expect(segs.length).toBe(8);
    expect(container.querySelectorAll(".atf-m-seg.done").length).toBe(2);
    expect(container.querySelectorAll(".atf-m-seg.active").length).toBe(1);
    const pendingSeg = container.querySelector(".atf-m-seg:not(.done):not(.active)")!;
    // 级联命中 run（state=registered）→ pending＝「等待完成」；无证据 run（state_reason=
    // no_on_disk_evidence）→「暂无在盘完成证据」——两态都非 unknown（面板源面另一钉）
    expect(pendingSeg.getAttribute("title")).toContain("等待完成");
    expect(container.textContent).not.toContain("unknown");
    // ③ KPI×4（键面闭集）
    const kpis = Array.from(container.querySelectorAll(".atf-m-k") as NodeListOf<Element>).map((e) => e.textContent);
    const kpiKeys = Array.from(container.querySelectorAll(".atf-m-k") as NodeListOf<Element>).map((e) => e.textContent);
    expect(kpiKeys).toEqual(["步进", "Loss", "指标 F1", "显存"]);
    expect(kpis.length).toBe(4);
    expect(container.textContent).toContain("0.736"); // 指标 F1
    expect(container.textContent).toContain("55G/160G"); // 显存 Σ(48128+8192)MiB→55G / Σ 2×81920→160G
    expect(container.textContent).toContain("47G/80G"); // 卡 0 逐卡 VRAM
    // ④ Loss：等距刻度＋网格＋图例＋原始/平滑开关；空态另测
    expect(container.querySelector("svg.atf-loss-chart")).not.toBeNull();
    expect(container.querySelectorAll(".atf-chart-tick").length).toBeGreaterThanOrEqual(8); // Y4＋X4+
    const toggleBtns = Array.from(container.querySelectorAll(".atf-loss-toggle button") as NodeListOf<HTMLButtonElement>).map((b) => b.textContent);
    expect(toggleBtns).toEqual(["原始", "平滑"]);
    expect(container.querySelector(".atf-lg-train")).not.toBeNull();
    // ⑤ GPU：默认 4 列（data-expanded=0）；温度/功耗在场
    const grid = container.querySelector(".atf-gpu-grid")!;
    expect(grid.getAttribute("data-expanded")).toBe("0");
    expect(container.querySelectorAll(".atf-gpu-tile").length).toBe(2);
    expect(container.querySelector(".atf-m-sec-h .atf-sec-hint")!.textContent).toContain("忙 1/2");
    expect(container.textContent).toContain("71°");
    expect(container.textContent).toContain("310W");
    // 区头绑卡
    expect(container.textContent).toContain("绑 0,1");
    // 展开 → 2 列类切换＋历史空「暂无历史」不画平线
    gpuHistoryPayload = { points: [] };
    const moreBtn = Array.from(container.querySelectorAll(".atf-gpu-more button") as NodeListOf<HTMLButtonElement>).find((b) => (b.textContent ?? "").indexOf("展开") >= 0)!;
    await act(async () => { moreBtn.click(); });
    await flush();
    const grid2 = container.querySelector(".atf-gpu-grid")!;
    expect(grid2.getAttribute("data-expanded")).toBe("1");
    expect(grid2.className).toContain("atf-gpu-grid-expanded");
    expect(container.textContent).toContain("暂无历史");
    expect(container.querySelector(".atf-spark-svg")).toBeNull();
    // 收起 → 设历史载荷 → 再展开（useGpuHistory 挂载拍即时读——不等 5s 轮询）→ 双 sparkline＋进程 top1
    const moreBtnMid = Array.from(container.querySelectorAll(".atf-gpu-more button") as NodeListOf<HTMLButtonElement>).find((b) => (b.textContent ?? "").indexOf("收起") >= 0)!;
    await act(async () => { moreBtnMid.click(); });
    gpuHistoryPayload = {
      points: [
        { ts: "2026-10-19T12:00:00.000Z", gpus: [{ index: 0, util: 50, memUsed: 40000, memTotal: 81920, temp: 70, power: 300, procTop: { pid: "111", name: "python", memMiB: 42188 } }, { index: 1, util: 0, memUsed: 8000, memTotal: 81920, temp: 40, power: 35, procTop: null }] },
        { ts: "2026-10-19T12:00:05.000Z", gpus: [{ index: 0, util: 90, memUsed: 48000, memTotal: 81920, temp: 72, power: 320, procTop: { pid: "111", name: "python", memMiB: 42188 } }, { index: 1, util: 2, memUsed: 8100, memTotal: 81920, temp: 41, power: 36, procTop: null }] },
      ],
    };
    const moreBtnRe = Array.from(container.querySelectorAll(".atf-gpu-more button") as NodeListOf<HTMLButtonElement>).find((b) => (b.textContent ?? "").indexOf("展开") >= 0)!;
    await act(async () => { moreBtnRe.click(); });
    await flush();
    await flush();
    expect(container.querySelector(".atf-gpu-grid")!.getAttribute("data-expanded")).toBe("1");
    expect(container.querySelectorAll(".atf-spark-svg").length).toBeGreaterThanOrEqual(3); // 卡0 双线＋卡1 util
    expect(container.textContent).toContain("python · 41G · pid 111"); // 42188MiB→41GiB
    expect(container.textContent).toContain("进程：—"); // 卡1 无归属
    // 收起
    const moreBtn2 = Array.from(container.querySelectorAll(".atf-gpu-more button") as NodeListOf<HTMLButtonElement>).find((b) => (b.textContent ?? "").indexOf("收起") >= 0)!;
    await act(async () => { moreBtn2.click(); });
    expect(container.querySelector(".atf-gpu-grid")!.getAttribute("data-expanded")).toBe("0");
    // ⑥ 训练产物：checkpoint 行＋评估报告行（artifacts.json 源）＋点击开 run-file（openResource 缺席 → 新标签回退）
    expect(container.textContent).toContain("checkpoint-68");
    expect(container.textContent).toContain("评估报告（上一轮）");
    const artRow = container.querySelector(".atf-art2-row") as HTMLDivElement;
    await act(async () => { artRow.click(); });
    expect(openCalls.some((u) => u.indexOf("/atf-ui/run-file?runId=run-d11&rel=training%2Fcheckpoint-68%2Ftrainer_state.json") >= 0)).toBe(true);
    // ⑦ 训练日志
    expect(container.querySelector(".atf-m-logs")!.textContent).toContain("step 64/107 loss 0.101");
    await act(async () => { root.unmount(); });
    await act(async () => { hroot.unmount(); });
  });

  it("Loss 空态骨架（等待首个 loss 点不画假线）＋数据陈旧角标（>30s 出现，保留快照不清屏）", async () => {
    stale = true;
    emptyLoss = true;
    // 重开监控（boot 后 store 复位）
    const hregs = captured["conversation.session.header.utilities"];
    const hcontainer = dom.window.document.getElementById("atf-h")!;
    const hroot = createRoot(hcontainer);
    await act(async () => { hroot.render(hregs![0]!.content!(hregs![0]!.options.inject("sess-1"))); });
    const pill = Array.from(hcontainer.querySelectorAll("button") as NodeListOf<HTMLButtonElement> as NodeListOf<HTMLButtonElement>).find((b) => b.textContent === "监控")!;
    await act(async () => { pill.click(); });
    const preg = captured["sidebar.right.pane.tab"];
    const container = dom.window.document.getElementById("atf-p")!;
    const root = createRoot(container);
    await act(async () => { root.render(preg![0]!.content!()); });
    await flush();
    // 无 loss 点 run → 骨架空态（本载荷 points 在场——改走空点 run：清空训练点）
    // 陈旧角标：generated_at-45s → 秒级心跳后出现
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    expect(container.textContent).toContain("数据陈旧");
    expect(container.querySelector(".atf-loss-skeleton")).not.toBeNull();
    expect(container.textContent).toContain("等待首个 loss 点");
    expect(container.querySelector(".atf-loss-chart")).toBeNull();
    await act(async () => { root.unmount(); });
    await act(async () => { hroot.unmount(); });
  });
});
