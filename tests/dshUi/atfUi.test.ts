/** 批⑳ 测试锚——atf-ui 服务端同步器纯函数（snapshot.js 八段四态推导）。
 *  client.js 浏览器组件的渲染验证走 DSH 真跑（浏览器环境），不在 vitest 覆盖范围。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildMonitorSnapshot, buildArtifactsSnapshot, formatGpuAll, formatGpuBinding, formatTaskCard, QUEUE_IDLE_TEXT, SEGMENTS, buildTrainLaunchMessage } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { buildIterationSummary, buildEnvSurface, buildLaunchSurface, discoverViewerDirs, gpuBindingOf, injectMonitorGlobal, latestEvalMetrics, parseEvalMetrics, resolveViewerRequest, scanRunDir, trainerHistoryLoss, VIEWER_ROUTE_PREFIX, viewerRouteHandler } from "../../packages/extensions/atf-ui/src/server.js";

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

describe("批㉛段2 发起训练面（IterationConfig 四件套摘要＋launch 扫描＋消息模板）", () => {
  it("buildIterationSummary：值源优先级 iteration_config＞snapshot＞缺省，来源标注如实", () => {
    const rows = buildIterationSummary(
      { learning_rate: "1e-4", num_train_epochs: 3, lora_rank: 32 },
      { learning_rate: "5e-5", lora_alpha: "16", max_total_tokens: "8192" },
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey["learning_rate"]).toMatchObject({ value: "1e-4", source: "iteration_config" });
    expect(byKey["num_train_epochs"]).toMatchObject({ value: "3", source: "iteration_config" });
    expect(byKey["lora_alpha"]).toMatchObject({ value: "16", source: "config_snapshot" });
    expect(byKey["cutoff_len"]).toMatchObject({ source: "default" });
    expect(byKey["max_total_tokens"]).toMatchObject({ value: "8192", source: "config_snapshot" });
    expect(byKey["image_min_pixels"]?.source).toBe("default");
    expect(byKey["learning_rate"]?.meaning).toContain("来自 IterationConfig");
    expect(byKey["image_min_pixels"]?.meaning).toContain("未校准");
    // 四件套＝含义＋值＋来源标注＋可改（meaning 承载含义与来源；label 沿批㉚ 卡面）
    expect(rows.every((r) => r.key && r.label && r.value !== undefined && r.meaning.length > 0)).toBe(true);
  });
  it("token_gate 语义修正（批㉛段2）：max_total_tokens＝构造准入闸门，不引用「评估截断根因」错误归因", () => {
    const rows = buildIterationSummary(null, null);
    const tokenRow = rows.find((r) => r.key === "max_total_tokens");
    expect(tokenRow?.meaning).toContain("构造准入闸门");
    expect(tokenRow?.meaning).toContain("不作用于评估推理长度");
    expect(tokenRow?.meaning).not.toContain("截断根因");
    expect(tokenRow?.meaning).not.toContain("评估推理截断由 token_gate");
  });
  it("buildLaunchSurface：train.sh/快照/IterationConfig/prelaunch 四件扫描＋training 子对象值映射", () => {
    const root = tempRoot();
    const runDir = join(root, "run-t");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    mkdirSync(join(runDir, "webui"), { recursive: true });
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "launch", "train.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(join(runDir, "launch", "prelaunch-report.md"), "# prelaunch\n");
    writeFileSync(join(runDir, "webui", "config-snapshot.json"), JSON.stringify({ confirmed: { learning_rate: "2e-4" } }));
    writeFileSync(
      join(runDir, "prep", "iteration-config", "iteration-config.json"),
      JSON.stringify({ schema_version: "IterationConfig/v1", training: { learning_rate: "1e-4", cutoff_len: 9000 } }),
    );
    const surface = buildLaunchSurface(runDir);
    expect(surface.train_sh).toBe(true);
    expect(surface.config_snapshot).toBe(true);
    expect(surface.iteration_config).toBe("prep/iteration-config/iteration-config.json");
    expect(surface.prelaunch_report).toContain("prelaunch-report.md");
    expect(surface.summary.find((r) => r.key === "learning_rate")).toMatchObject({ value: "1e-4", source: "iteration_config" });
    expect(surface.summary.find((r) => r.key === "cutoff_len")).toMatchObject({ value: "9000", source: "iteration_config" });
    expect(surface.summary.find((r) => r.key === "lora_rank")?.source).toBe("default");
  });
  it("scanRunDir→monitor：launch 面随快照下发（缺席 run 全 false/null 不炸）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-m");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), JSON.stringify({ training: { learning_rate: "3e-4" } }));
    const scan = scanRunDir(root, "run-m");
    expect(scan.launch.train_sh).toBe(false);
    expect(scan.launch.summary.find((r) => r.key === "learning_rate")).toMatchObject({ value: "3e-4", source: "iteration_config" });
    const snap = buildMonitorSnapshot([scan]);
    expect(snap.runs[0]?.launch).not.toBeNull();
    const empty = buildMonitorSnapshot([{ ...scan, launch: undefined }]);
    expect(empty.runs[0]?.launch).toBeNull();
  });
  it("buildTrainLaunchMessage：DRY_RUN 止步条款＋真训形态 atf_launch_execute，账本核验在列", () => {
    const dry = buildTrainLaunchMessage({ run_id: "run-x", mode: "dry_run", summary: [{ key: "lr", value: "1e-4", source: "iteration_config" }] });
    expect(dry).toContain("atf_config_confirm present（run_id=run-x）");
    expect(dry).toContain("ADMISSION=pass");
    expect(dry).toContain("--record-training-release");
    expect(dry).toContain("already_recorded");
    expect(dry).toContain("到此止");
    expect(dry).toContain("真实训练候我单独书面点头");
    expect(dry).not.toContain("放行执行：atf_launch_execute");
    const real = buildTrainLaunchMessage({ run_id: "run-x", mode: "real" });
    expect(real).toContain("atf_launch_execute");
    expect(real).toContain("manifest sha 对拍 fail-closed");
    expect(real).not.toContain("到此止");
  });
  it("client.js 模板双份同语义钉子：DRY_RUN 止步与真训 owner 点头句两处都在（裸服务不打包——改动同步）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    for (const phrase of ["ADMISSION=pass", "already_recorded", "到此止", "真实训练候我单独书面点头", "atf_launch_execute"]) {
      expect(clientSource).toContain(phrase);
    }
  });
});

describe("批㉛段3.1 右栏监控面（Loss 历史回退＋评估 KPI＋环境卡）", () => {
  it("trainerHistoryLoss：最新 checkpoint trainer_state.log_history → 点列；无 checkpoint → 空数组", () => {
    const root = tempRoot();
    const runDir = join(root, "run-h");
    mkdirSync(join(runDir, "training", "checkpoint-96"), { recursive: true });
    mkdirSync(join(runDir, "training", "checkpoint-141"), { recursive: true });
    writeFileSync(
      join(runDir, "training", "checkpoint-96", "trainer_state.json"),
      JSON.stringify({ log_history: [{ step: 2, loss: 0.9, epoch: 0.1 }] }),
    );
    writeFileSync(
      join(runDir, "training", "checkpoint-141", "trainer_state.json"),
      JSON.stringify({ log_history: [{ step: 2, loss: 0.6885, learning_rate: 7.1e-6, epoch: 0.04 }, { step: 4, loss: 0.726, learning_rate: 2.1e-5, epoch: 0.09 }] }),
    );
    const points = trainerHistoryLoss(runDir);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ step: 2, train_loss: 0.6885 });
    // 无训练产物 → 空数组不抛
    expect(trainerHistoryLoss(join(root, "run-missing"))).toEqual([]);
  });
  it("parseEvalMetrics：FormalEvalSummary/v1 → KPI 面（f1/precision/recall/exact）；坏形态 null", () => {
    const parsed = parseEvalMetrics(
      { model: "Qwen3-VL-32B-Instruct-lora", pages: 10, page_exact_rate: 0.0, micro: { precision: 0.5143, recall: 0.1773, f1: 0.2637 } },
      "4-20261004",
    );
    expect(parsed).toMatchObject({ round: "4-20261004", model: "Qwen3-VL-32B-Instruct-lora", pages: 10, f1: 0.2637, precision: 0.5143, recall: 0.1773, exact: 0.0 });
    expect(parseEvalMetrics(null, "x")).toBeNull();
    expect(parseEvalMetrics("junk", "x")).toBeNull();
  });
  it("latestEvalMetrics：轮目录取 N 最大者（orch/eval/metrics_summary.json），无轮回退 eval 根", () => {
    const root = tempRoot();
    const runDir = join(root, "run-e");
    mkdirSync(join(runDir, "eval", "3-20261003", "orch", "eval"), { recursive: true });
    mkdirSync(join(runDir, "eval", "4-20261004", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "eval", "3-20261003", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "old", micro: { f1: 0.1 } }));
    writeFileSync(join(runDir, "eval", "4-20261004", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "new", pages: 10, micro: { f1: 0.26 } }));
    expect(latestEvalMetrics(runDir)).toMatchObject({ round: "4-20261004", f1: 0.26 });
    // 无轮目录：eval 根 metrics_summary 兜底（round=latest）
    rmSync(join(runDir, "eval", "3-20261003"), { recursive: true });
    rmSync(join(runDir, "eval", "4-20261004"), { recursive: true });
    writeFileSync(join(runDir, "eval", "metrics_summary.json"), JSON.stringify({ model: "root-fallback", micro: { f1: 0.2 } }));
    expect(latestEvalMetrics(runDir)).toMatchObject({ round: "latest", model: "root-fallback" });
  });
  it("buildEnvSurface：IterationConfig 同源（基模型取尾段/数据集键逗连/deepspeed/lane）；缺席如实 —", () => {
    const env = buildEnvSurface(
      { base_model: { path: "/data/LLM_model/Qwen3-VL-32B-Instruct" }, dataset: { dataset_keys: ["pl_goods"] }, training: { deepspeed: "ds_z3_fp8_config.json" }, lane: "pl_goods" },
      "run-x",
    );
    expect(env).toEqual({ base_model: "Qwen3-VL-32B-Instruct", dataset_keys: "pl_goods", deepspeed: "ds_z3_fp8_config.json", lane: "pl_goods" });
    expect(buildEnvSurface(null, "run-x")).toEqual({ base_model: "—", dataset_keys: "—", deepspeed: "—", lane: "—" });
  });
  it("scanRunDir→monitor：metrics/env 随快照下发；live loss-series 优先于 trainer 历史回退", () => {
    const root = tempRoot();
    const runDir = join(root, "run-m31");
    mkdirSync(join(runDir, "training", "checkpoint-10"), { recursive: true });
    mkdirSync(join(runDir, "eval", "4-20261004", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "training", "checkpoint-10", "trainer_state.json"), JSON.stringify({ log_history: [{ step: 1, loss: 1.2 }] }));
    writeFileSync(join(runDir, "eval", "4-20261004", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "m", micro: { f1: 0.3, precision: 0.4, recall: 0.5 }, page_exact_rate: 0.1, pages: 9 }));
    const scan = scanRunDir(root, "run-m31");
    expect(scan.metrics).toMatchObject({ round: "4-20261004", f1: 0.3, exact: 0.1 });
    expect(scan.env).toMatchObject({ base_model: "—", deepspeed: "—" });
    expect(scan.training.active).toBe(false);
    expect(scan.training.loss).toHaveLength(1);
    // live loss-series 在场 → 覆盖历史回退，active=true
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.5, eval_loss: 0.6 }]));
    const scan2 = scanRunDir(root, "run-m31");
    expect(scan2.training.active).toBe(true);
    expect(scan2.training.loss).toEqual([{ train_loss: 0.5, eval_loss: 0.6 }]);
    const snap = buildMonitorSnapshot([scan2]);
    expect(snap.runs[0]?.metrics).toMatchObject({ f1: 0.3 });
    expect(snap.runs[0]?.env).not.toBeNull();
  });
  it("批㉛段3.3 产物抽屉：launch manifest＋eval 轮四件套按轮索引入列（不重复罗列）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-art");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    mkdirSync(join(runDir, "eval", "4-20261004", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "launch", "launch_manifest.json"), "{}");
    writeFileSync(join(runDir, "eval", "4-20261004", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "m", micro: {} }));
    for (const f of ["badcases.jsonl", "raw_predictions.jsonl", "indexes.csv"]) writeFileSync(join(runDir, "eval", f), "x");
    const scan = scanRunDir(root, "run-art");
    const rows = buildArtifactsSnapshot([scan]).runs[0]?.artifacts ?? [];
    const names = rows.map((r) => r.name);
    expect(names).toContain("launch manifest（sha 索引）");
    expect(names).toContain("eval metrics_summary（4-20261004）");
    expect(names).toContain("eval badcases.jsonl");
    expect(names).toContain("eval raw_predictions.jsonl");
    expect(names).toContain("eval indexes.csv");
    // 无轮目录（metrics.round=latest）→ eval 根兜底行（不带轮名）——根 metrics_summary 在场才入列
    const snap2 = buildArtifactsSnapshot([{ ...scan, metrics: { round: "latest" } }]);
    expect((snap2.runs[0]?.artifacts ?? []).map((r) => r.name)).not.toContain("eval metrics_summary");
    writeFileSync(join(runDir, "eval", "metrics_summary.json"), JSON.stringify({ model: "root", micro: {} }));
    const scanLate = scanRunDir(root, "run-art");
    const snap3 = buildArtifactsSnapshot([{ ...scanLate, metrics: { round: "latest" } }]);
    expect((snap3.runs[0]?.artifacts ?? []).map((r) => r.name)).toContain("eval metrics_summary");
  });
});

describe("批㉝H GPU 多卡聚合（gpu_all 采集解析＋绑卡声明两态＋快照下发）", () => {
  it("parseNvidiaSmiAll：逐行 index,util,used,total → 逐卡列表；空/坏输出 → null（不猜测）", async () => {
    const { parseNvidiaSmiAll } = await import("../../src/webui/readOnlyTools.js");
    const cards = parseNvidiaSmiAll("0, 0, 0, 81920\n1, 12, 8429, 81920\n");
    expect(cards).toEqual([
      { index: "0", utilization: "0%", memoryUsed: "0MiB", memoryTotal: "81920MiB" },
      { index: "1", utilization: "12%", memoryUsed: "8429MiB", memoryTotal: "81920MiB" },
    ]);
    expect(parseNvidiaSmiAll("")).toBeNull();
    expect(parseNvidiaSmiAll("not,enough,cells")).toBeNull();
  });
  it("formatGpuAll：全卡聚合显示串（GPU0 0%/0MiB · GPU1 12%/8429MiB）；空列表 → null（client 回退单卡面）", () => {
    expect(formatGpuAll([{ index: "0", utilization: "0%", memoryUsed: "0MiB", memoryTotal: "81920MiB" }, { index: "1", utilization: "12%", memoryUsed: "8429MiB", memoryTotal: "81920MiB" }]))
      .toBe("GPU0 0%/0MiB · GPU1 12%/8429MiB");
    expect(formatGpuAll([])).toBeNull();
    expect(formatGpuAll(undefined)).toBeNull();
  });
  it("formatGpuBinding 两态：train.sh 声明／deploy_effective 声明；缺席/空 → null（仅显示全卡聚合）", () => {
    expect(formatGpuBinding({ devices: "0", source: "train_sh" })).toBe("绑卡：0（train.sh CUDA_VISIBLE_DEVICES）");
    expect(formatGpuBinding({ devices: "2", source: "deploy_effective" })).toBe("绑卡：2（deploy_effective.visible_devices）");
    expect(formatGpuBinding(null)).toBeNull();
    expect(formatGpuBinding({ devices: "", source: "train_sh" })).toBeNull();
  });
  it("gpuBindingOf：train.sh CUDA_VISIBLE_DEVICES 优先＞manifest deploy_effective 回退＞两处缺席 null", () => {
    const root = tempRoot();
    const runDir = join(root, "run-bind");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    // 两处在场且不一致 → train.sh（实际执行面）优先
    writeFileSync(join(runDir, "launch", "train.sh"), "set -e\nexport CUDA_VISIBLE_DEVICES=2\n");
    writeFileSync(join(runDir, "launch", "launch_manifest.json"), JSON.stringify({ deploy_effective: { visible_devices: "0" } }));
    expect(gpuBindingOf(runDir)).toEqual({ devices: "2", source: "train_sh" });
    // train.sh 无 CUDA 行（或缺席）→ manifest 声明面回退
    writeFileSync(join(runDir, "launch", "train.sh"), "set -e\n");
    expect(gpuBindingOf(runDir)).toEqual({ devices: "0", source: "deploy_effective" });
    // 两处都缺席 → null（client 不显示绑卡，仅全卡聚合）
    rmSync(join(runDir, "launch"), { recursive: true });
    expect(gpuBindingOf(runDir)).toBeNull();
    expect(gpuBindingOf(join(root, "run-missing"))).toBeNull();
  });
  it("buildMonitorSnapshot：gpu_all 透传（缺省空数组）＋gpu_binding 逐 run 下发（缺省 null）——旧调用两参不炸", () => {
    const offline = buildMonitorSnapshot([sampleRun]);
    expect(offline.gpu_all).toEqual([]);
    expect(offline.runs[0]?.gpu_binding).toBeNull();
    const live = buildMonitorSnapshot(
      [{ ...sampleRun, gpu_binding: { devices: "0,1", source: "deploy_effective" } }],
      { offline: false, utilization: "12%", memoryUsed: "3497 MiB", memoryTotal: "81920 MiB" },
      [{ index: "0", utilization: "12%", memoryUsed: "3497MiB", memoryTotal: "81920MiB" }],
    );
    expect(live.gpu_all).toHaveLength(1);
    expect(live.runs[0]?.gpu_binding).toEqual({ devices: "0,1", source: "deploy_effective" });
    // 首 fetch 前 gpu 首行单卡面保留（旧 client 回退面零变化）
    expect(live.gpu).toMatchObject({ offline: false, utilization: "12%" });
  });
  it("tickOnce→monitor.json：gpu_all 数组落盘（真机逐卡/无 GPU 空数组——形态如实）＋scanRunDir gpu_binding 随快照", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-h");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    writeFileSync(join(runDir, "launch", "train.sh"), "export CUDA_VISIBLE_DEVICES=3\n");
    const { tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const monitor = JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as {
      gpu_all: Array<{ index: string; utilization: string; memoryUsed: string; memoryTotal: string }>;
      runs: Array<{ run_id: string; gpu_binding: { devices: string; source: string } | null }>;
    };
    expect(Array.isArray(monitor.gpu_all)).toBe(true);
    for (const c of monitor.gpu_all) {
      expect(c).toMatchObject({ index: expect.any(String), utilization: expect.stringMatching(/%$/), memoryUsed: expect.stringMatching(/MiB$/) });
    }
    expect(monitor.runs.find((r) => r.run_id === "run-h")?.gpu_binding).toEqual({ devices: "3", source: "train_sh" });
  });
  it("client.js 双份同语义钉子：聚合/绑卡副本两处都在（裸服务不打包——改动同步）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    for (const phrase of ["formatGpuAllLocal", "formatGpuBindingLocal", "train.sh CUDA_VISIBLE_DEVICES", "deploy_effective.visible_devices", "当前 run "]) {
      expect(clientSource).toContain(phrase);
    }
    // 渲染面两处都在：GPU 状态条（dock）＋监控面板环境卡 GPU 行
    expect(clientSource).toContain("gpu_binding");
    expect(clientSource).toContain("'GPU：' + gpuRow");
  });
});
