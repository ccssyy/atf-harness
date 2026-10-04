/** 批⑳ 测试锚——atf-ui 服务端同步器纯函数（snapshot.js 八段四态推导）。
 *  client.js 浏览器组件的渲染验证走 DSH 真跑（浏览器环境），不在 vitest 覆盖范围。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildMonitorSnapshot, buildArtifactsSnapshot, formatTaskCard, QUEUE_IDLE_TEXT, SEGMENTS } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { discoverViewerDirs, injectMonitorGlobal, resolveViewerRequest, VIEWER_ROUTE_PREFIX, viewerRouteHandler } from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-ui-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const sampleRun = {
  run_id: "run-x",
  state: "registered",
  segments: { register: true, split: true, label_qc: false, candidate: false, publish: false },
  training: { active: true, loss: [{ train_loss: 0.5, eval_loss: 0.6, grad_norm: 1.2, learning_rate: 1e-4 }, { train_loss: 0.3, eval_loss: 0.55, grad_norm: 0.9, learning_rate: 1e-4 }], pending_confirm: null },
  report: { files: ["report.md", "segment-1.md"] },
  artifacts: ["session.jsonl", "contract-candidate.json", "launch/train.sh"],
  viewers: ["analysis-b29", "analysis"],
};

/** 造一个 run 的 viewer 产物树（两形态兼容测试夹具）：analysis/ ＋ analysis-b29/ ＋ .bak 排除面。 */
function seedViewerTree(runDir: string, analysisName: string, files: Record<string, string>): string {
  const viewerDir = join(runDir, analysisName, "viewer");
  mkdirSync(viewerDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(viewerDir, name), body);
  return viewerDir;
}

describe("快照构造纯函数（八段四态推导＋loss 曲线＋KPI＋空态文案单源）", () => {
  it("buildMonitorSnapshot：八段逐卡 status 推导", () => {
    const snap = buildMonitorSnapshot([sampleRun]);
    expect(snap.runs[0]?.segments.map((s) => s.key)).toEqual(SEGMENTS.map((s) => s.key));
    expect(snap.runs[0]?.segments.filter((s) => s.status === "done").map((s) => s.key)).toEqual(["register", "split"]);
  });
  it("批㉛段1 viewers 字段：monitor 透传（缺省空数组不炸），artifacts 入列 viewer 行", () => {
    const snap = buildMonitorSnapshot([sampleRun]);
    expect(snap.runs[0]?.viewers).toEqual(["analysis-b29", "analysis"]);
    expect(buildMonitorSnapshot([{ ...sampleRun, viewers: undefined }]).runs[0]?.viewers).toEqual([]);
    const arts = buildArtifactsSnapshot([sampleRun]).runs[0]?.artifacts;
    const viewerRow = arts?.find((a) => a.kind === "html");
    expect(viewerRow?.path).toBe("run-x/analysis-b29/viewer/viewer.html");
    expect(viewerRow?.name).toContain("analysis-b29");
  });
  it("批㉛段1 discoverViewerDirs：两形态兼容（analysis/＋analysis-b29/），.bak 排除，mtime 新者在前", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-v");
    const older = seedViewerTree(runDir, "analysis", { "viewer.html": "<html>a</html>" });
    seedViewerTree(runDir, "analysis-b29", { "viewer.html": "<html>b29</html>" });
    seedViewerTree(runDir, "analysis.bak-b24", { "viewer.html": "<html>bak</html>" });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(older, "viewer.html"), old, old);
    expect(discoverViewerDirs(runDir)).toEqual(["analysis-b29", "analysis"]);
  });
  it("批㉛段1 discoverViewerDirs：无 viewer 目录 → 空数组；run 目录缺失不抛", () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-empty"), { recursive: true });
    expect(discoverViewerDirs(join(root, "run-empty"))).toEqual([]);
    expect(discoverViewerDirs(join(root, "run-missing"))).toEqual([]);
  });
  it("buildArtifactsSnapshot：逐段入列产物行", () => {
    const snap = buildArtifactsSnapshot([sampleRun]);
    const names = snap.runs[0]?.artifacts.map((a) => a.name).join("|") ?? "";
    expect(names).toContain("登记件");
    expect(names).toContain("契约件");
    expect(names).toContain("train.sh");
    expect(names).toContain("report.md");
  });
  it("空态文案单源（QUEUE_IDLE_TEXT 排队语义）", () => {
    expect(QUEUE_IDLE_TEXT).toContain("排队中");
    expect(QUEUE_IDLE_TEXT).toContain("DRY_RUN");
  });
  it("gpu 字段：缺省 offline（不猜测）；实测面透传（批㉑三段 GPU 状态卡数据面）", () => {
    const offline = buildMonitorSnapshot([sampleRun]);
    expect(offline.gpu).toEqual({ offline: true });
    const live = buildMonitorSnapshot([sampleRun], { offline: false, utilization: "12%", memoryUsed: "3497 MiB", memoryTotal: "81920 MiB" });
    expect(live.gpu).toMatchObject({ offline: false, utilization: "12%" });
  });
  it("formatTaskCard：八段 checklist 四态标记＋进度行（chat 任务卡单源）", () => {
    const snap = buildMonitorSnapshot([sampleRun]);
    const card = formatTaskCard(snap.runs[0]!);
    expect(card).toContain("✓ 数据登记");
    expect(card).toContain("✓ 数据切分");
    expect(card).toContain("● 训练执行");
    expect(card).toContain("○ 标注体检");
    expect(card).toContain("进度 2/8");
  });
});

describe("atf-ui 同步器落盘（scan→monitor/artifacts/panel）", () => {
  it("scan+写盘：临时 runsRoot 造 run 结构 → 三 JSON 落盘且段状态正确", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-sync");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    writeFileSync(join(runDir, "session.jsonl"), "{}\n");
    writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
    const { name, apply: applyPlugin, tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
    expect(name).toBe("atf-ui");
    const effects: Array<() => void> = [];
    applyPlugin({ effect: (run: () => () => void) => { effects.push(run()); } }, { runsRoot: root, intervalMs: 60_000 });
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const monitor = JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as { runs: Array<{ run_id: string; segments: Array<{ key: string; status: string }>; training: { active: boolean } }>; gpu: { offline: boolean } };
    expect(monitor.runs[0]?.run_id).toBe("run-sync");
    expect(monitor.runs[0]?.segments.find((s) => s.key === "register")?.status).toBe("done");
    expect(monitor.runs[0]?.training.active).toBe(true);
    expect(monitor.gpu).toMatchObject({ offline: expect.any(Boolean) });
    const artifacts = JSON.parse(readFileSync(join(root, "atf-ui", "artifacts.json"), "utf8")) as { runs: Array<{ artifacts: unknown[] }> };
    expect(artifacts.runs[0]?.artifacts.length).toBeGreaterThan(0);
    const panelHtml = readFileSync(join(root, "atf-ui", "panel.html"), "utf8");
    expect(panelHtml).toContain("AtfMonitor/v1");
    expect(panelHtml).toContain("排队中");
    for (const d of effects) d();
  });
});

describe("批㉘ monitor 路径注入（tapIndex → window.__ATF_UI_CONFIG__.monitorPath）", () => {
  const DEFAULT_TAIL = join("tmp", "webui-runs", "atf-ui", "monitor.json");
  /** 带 webServer 假身的 ctx：捕获 tapIndex 变换并收集 effect disposer。 */
  const ctxWithWebServer = () => {
    const taps: Array<(html: string) => string> = [];
    const effects: Array<() => void> = [];
    const ctx = {
      effect: (run: () => () => void) => { effects.push(run()); },
      webServer: {
        tapIndex: (transform: (html: string) => string) => {
          taps.push(transform);
          return () => { const at = taps.indexOf(transform); if (at !== -1) taps.splice(at, 1); };
        },
      },
    };
    return { ctx, taps, effects };
  };
  const appliedHtml = async (config: unknown): Promise<string> => {
    const { apply: applyPlugin } = await import("../../packages/extensions/atf-ui/src/server.js");
    const { ctx, taps, effects } = ctxWithWebServer();
    applyPlugin(ctx, config);
    const html = taps[0]!("<!DOCTYPE html><html><head><title>t</title></head><body></body></html>");
    for (const d of effects) d();
    return html;
  };

  it("缺省：无 env → 注入原缺省路径（owner runsRoot 语义，向后兼容＝3080 零变化）", async () => {
    const savedDsh = process.env["ATF_DSH_RUNS_ROOT"];
    const savedWebui = process.env["ATF_WEBUI_RUNS_ROOT"];
    delete process.env["ATF_DSH_RUNS_ROOT"];
    delete process.env["ATF_WEBUI_RUNS_ROOT"];
    try {
      const html = await appliedHtml({});
      expect(html).toContain("__ATF_UI_CONFIG__");
      expect(html).toContain(DEFAULT_TAIL);
      expect(html).toContain("</head>");
    } finally {
      if (savedDsh !== undefined) process.env["ATF_DSH_RUNS_ROOT"] = savedDsh;
      if (savedWebui !== undefined) process.env["ATF_WEBUI_RUNS_ROOT"] = savedWebui;
    }
  });
  it("覆盖：ATF_WEBUI_RUNS_ROOT 在场 → 注入 <RUNS_ROOT>/atf-ui/monitor.json", async () => {
    const savedDsh = process.env["ATF_DSH_RUNS_ROOT"];
    delete process.env["ATF_DSH_RUNS_ROOT"];
    process.env["ATF_WEBUI_RUNS_ROOT"] = "/tmp/b28-runs-override";
    try {
      const html = await appliedHtml({});
      expect(html).toContain(join("/tmp/b28-runs-override", "atf-ui", "monitor.json"));
      expect(html).not.toContain(DEFAULT_TAIL);
    } finally {
      delete process.env["ATF_WEBUI_RUNS_ROOT"];
      if (savedDsh !== undefined) process.env["ATF_DSH_RUNS_ROOT"] = savedDsh;
    }
  });
  it("优先级：ATF_DSH_RUNS_ROOT 压过 ATF_WEBUI_RUNS_ROOT（dsh 原生轴优先，双设不漂移）", async () => {
    process.env["ATF_DSH_RUNS_ROOT"] = "/tmp/b28-runs-dsh";
    process.env["ATF_WEBUI_RUNS_ROOT"] = "/tmp/b28-runs-webui";
    try {
      const html = await appliedHtml({});
      expect(html).toContain(join("/tmp/b28-runs-dsh", "atf-ui", "monitor.json"));
      expect(html).not.toContain("/tmp/b28-runs-webui");
    } finally {
      delete process.env["ATF_DSH_RUNS_ROOT"];
      delete process.env["ATF_WEBUI_RUNS_ROOT"];
    }
  });
  it("显式 config.runsRoot 最高优先（同步器写盘位＝注入位同一单源）＋无 head 锚前置不抛", async () => {
    const html = await appliedHtml({ runsRoot: "/tmp/b28-runs-config" });
    expect(html).toContain(join("/tmp/b28-runs-config", "atf-ui", "monitor.json"));
    expect(injectMonitorGlobal("<html><body>x</body></html>", "/p/m.json")).toContain("/p/m.json");
  });
});

describe("批㉛段1 viewer 静态路由（resolveViewerRequest fail-closed＋handler 壳鉴权/回包）", () => {
  const P = VIEWER_ROUTE_PREFIX;
  const seed = (): { root: string; runDir: string; viewers: string[] } => {
    const root = tempRoot();
    const runDir = join(root, "run-v");
    seedViewerTree(runDir, "analysis", {
      "viewer.html": "<html>latest</html>",
      "viewer_data.json": "{}",
      "not-servable.exe": "x",
    });
    mkdirSync(join(runDir, "analysis", "viewer", "images"), { recursive: true });
    writeFileSync(join(runDir, "analysis", "viewer", "images", "abc.png"), "PNG");
    seedViewerTree(runDir, "analysis-b29", { "viewer.html": "<html>b29</html>" });
    // mtime：analysis 更新（首选），analysis-b29 更旧
    const now = new Date();
    utimesSync(join(runDir, "analysis-b29", "viewer", "viewer.html"), now, now);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(runDir, "analysis", "viewer", "viewer.html"), later, later);
    const viewers = discoverViewerDirs(runDir);
    expect(viewers).toEqual(["analysis", "analysis-b29"]);
    return { root, runDir, viewers };
  };

  it("resolveViewerRequest：默认 viewer.html／显式 analysis 变体／相对资源三形态", () => {
    const { root, viewers } = seed();
    expect(resolveViewerRequest(root, `${P}/run-v/`, viewers)?.abs).toBe(join(root, "run-v", "analysis", "viewer", "viewer.html"));
    expect(resolveViewerRequest(root, `${P}/run-x/viewer.html`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/run-v/analysis-b29/viewer.html`, viewers)?.abs).toBe(join(root, "run-v", "analysis-b29", "viewer", "viewer.html"));
    expect(resolveViewerRequest(root, `${P}/run-v/images/abc.png`, viewers)?.type).toBe("image/png");
  });
  it("resolveViewerRequest：fail-closed（未知 run／analysis 不在清单／.. 越界／不可服务扩展名）", () => {
    const { root, viewers } = seed();
    expect(resolveViewerRequest(root, `${P}/run-missing/`, viewers)).toBeNull();
    // analysis.bak-b24 物理存在但不在发现清单 → URL 不可达
    expect(resolveViewerRequest(root, `${P}/run-v/analysis.bak-b24/viewer.html`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/run-v/../run-v/viewer.html`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/run-v/images/../viewer.html`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/run-v/not-servable.exe`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/../etc/passwd`, viewers)).toBeNull();
    expect(resolveViewerRequest(root, `${P}/`, viewers)).toBeNull();
  });
  it("handler：壳鉴权 401／目录式 302 补尾斜杠／200 回包带 content-type／404／405", () => {
    const { root, viewers } = seed();
    const viewersOf = (runId: string) => (runId === "run-v" ? viewers : []);
    type FakeReq = { url: string; method: string };
    type FakeRes = {
      statusCode: number;
      headers: Record<string, unknown>;
      body: unknown;
      ended: boolean;
      writeHead(c: number, h?: Record<string, unknown>): void;
      end(b?: unknown): void;
    };
    const fakeReq = (url: string, method = "GET"): FakeReq => ({ url, method });
    const fakeRes = (): FakeRes => {
      const res: FakeRes = {
        statusCode: 0,
        headers: {},
        body: undefined,
        ended: false,
        writeHead(c, h) { res.statusCode = c; Object.assign(res.headers, h ?? {}); },
        end(b) { res.ended = true; if (b !== undefined) res.body = b; },
      };
      return res;
    };
    const call = (handler: (req: IncomingMessage, res: ServerResponse) => void, req: FakeReq, res: FakeRes): void => {
      (handler as unknown as (r: FakeReq, s: FakeRes) => void)(req, res);
    };
    // 401：connection 拒绝
    const rejecting = viewerRouteHandler({ runsRoot: root, viewersOf, reject: () => 401 });
    const r401 = fakeRes();
    call(rejecting, fakeReq(`${P}/run-v/`), r401);
    expect(r401.statusCode).toBe(401);
    // 302：裸 runId 补尾斜杠（相对资源前缀守恒）
    const serving = viewerRouteHandler({ runsRoot: root, viewersOf });
    const r302 = fakeRes();
    call(serving, fakeReq(`${P}/run-v`), r302);
    expect(r302.statusCode).toBe(302);
    expect(r302.headers["location"]).toBe(`${P}/run-v/`);
    // 200：viewer.html＋images（图片带 max-age）
    const r200 = fakeRes();
    call(serving, fakeReq(`${P}/run-v/`), r200);
    expect(r200.statusCode).toBe(200);
    expect(r200.headers["content-type"]).toContain("text/html");
    expect(String(r200.body)).toContain("latest");
    const rImg = fakeRes();
    call(serving, fakeReq(`${P}/run-v/images/abc.png`), rImg);
    expect(rImg.headers["content-type"]).toBe("image/png");
    expect(rImg.headers["cache-control"]).toContain("max-age=3600");
    // 404：未知 run 与越权扩展名同形
    const r404 = fakeRes();
    call(serving, fakeReq(`${P}/run-other/`), r404);
    expect(r404.statusCode).toBe(404);
    const rExe = fakeRes();
    call(serving, fakeReq(`${P}/run-v/not-servable.exe`), rExe);
    expect(rExe.statusCode).toBe(404);
    // 405：写方法不开
    const r405 = fakeRes();
    call(serving, fakeReq(`${P}/run-v/`, "POST"), r405);
    expect(r405.statusCode).toBe(405);
  });
  it("apply：webServer＋connection 在场 → prefix 路由注册（含 VIEWER_ROUTE_PREFIX）", async () => {
    const root = tempRoot();
    const registered: Array<{ kind: string; path: string }> = [];
    const effects: Array<() => void> = [];
    const { apply: applyPlugin } = await import("../../packages/extensions/atf-ui/src/server.js");
    applyPlugin(
      {
        effect: (run: () => () => void) => { effects.push(run()); },
        webServer: {
          tapIndex: () => () => {},
          register: (route) => { registered.push({ kind: route.kind, path: route.path }); return () => {}; },
        },
        connection: { requestRejection: () => undefined },
      },
      { runsRoot: root, intervalMs: 60_000 },
    );
    expect(registered).toContainEqual({ kind: "prefix", path: VIEWER_ROUTE_PREFIX });
    for (const d of effects) d();
  });
});
