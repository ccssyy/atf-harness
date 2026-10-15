/** 批⑳ 测试锚——atf-ui 服务端同步器纯函数（snapshot.js 八段四态推导）。
 *  client.js 浏览器组件的渲染验证走 DSH 真跑（浏览器环境），不在 vitest 覆盖范围。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildMonitorSnapshot, buildArtifactsSnapshot, formatGpuAll, formatGpuBinding, formatTaskCard, QUEUE_IDLE_TEXT, SEGMENTS, buildTrainLaunchMessage } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { PANEL_HTML } from "../../packages/extensions/atf-ui/src/panel.js";
import { buildIterationSummary, buildEnvSurface, buildLaunchSurface, bridgeBadgeSurface, discoverViewerDirs, gpuBindingOf, injectMonitorGlobal, latestEvalMetrics, parseEvalMetrics, resolveTrainActiveWindowMs, resolveViewerRequest, scanEvalRounds, scanRunDir, scanRuns, looksLikeRun, RUN_MARKER_RELS, trainerHistoryLoss, VIEWER_ROUTE_PREFIX, viewerRouteHandler } from "../../packages/extensions/atf-ui/src/server.js";
import { tmuxHasSession, trainingSessionBase } from "../../src/core/workspace/tmuxLiveness.js";
import { progressFresh } from "../../src/core/workspace/runFacts.js";
import { appendSegmentFact } from "../../src/core/workspace/segmentFacts.js";

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
  it("批㊶Q增补二2 progress 投影键位：training.progress 回退兼容（scanRunDir 实挂 training 子键——浮卡 N-3 数据源断点修正）", () => {
    const withTrainingProgress = buildMonitorSnapshot([
      { ...sampleRun, training: { ...sampleRun.training, progress: { round: 5, total_rounds: 6, step_remaining: 44, loss: 0.0623, percentage: 76.34, updated_at: "2026-10-11T01:46:21Z" } } },
    ]);
    expect(withTrainingProgress.runs[0]?.progress).toMatchObject({ round: 5, total_rounds: 6, percentage: 76.34 });
    // 顶层键形态（历史兼容面）依旧直通
    const withTopProgress = buildMonitorSnapshot([{ ...sampleRun, progress: { round: 1, updated_at: "n" } } as typeof sampleRun]);
    expect(withTopProgress.runs[0]?.progress).toMatchObject({ round: 1 });
    // 双缺＝null
    expect(buildMonitorSnapshot([sampleRun]).runs[0]?.progress).toBeNull();
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

describe("批㊶Q增补二1 progress 持续写链（tickOnce 同步器——trainer_log 步进刷新 progress.json）", () => {
  it("active run＋trainer_log 在场 → progress.json 落盘（epoch 语义＋percentage）；无 trainer_log 不写", async () => {
    const root = tempRoot();
    const mk = (runId: string, withTrainerLog: boolean): void => {
      const runDir = join(root, runId);
      mkdirSync(join(runDir, "training"), { recursive: true });
      writeFileSync(join(runDir, "registration.json"), "{}");
      writeFileSync(join(runDir, "session.jsonl"), "{}\n");
      writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
      if (withTrainerLog) {
        writeFileSync(join(runDir, "training", "trainer_log.jsonl"), JSON.stringify({ current_steps: 140, total_steps: 186, loss: 0.0646, epoch: 4.52, percentage: 75.27 }) + "\n");
        mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
        writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), JSON.stringify({ training: { num_train_epochs: 6 } }));
      }
    };
    mk("run-with-log", true);
    mk("run-no-log", false);
    const { tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const withLog = JSON.parse(readFileSync(join(root, "run-with-log", "webui", "progress.json"), "utf8")) as Record<string, unknown>;
    expect(withLog).toMatchObject({ round: 5, total_rounds: 6, step_remaining: 46, loss: 0.0646, percentage: 75.27 });
    expect(typeof withLog.updated_at).toBe("string");
    expect(existsSync(join(root, "run-no-log", "webui", "progress.json"))).toBe(false);
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

describe("批㊶-E 项 2.3 桥类型徽标注入面（__ATF_UI_CONFIG__.bridge 扩键——白名单两键＋投影用例）", () => {
  it("注入两态：real 带 version／mock 无 version——键面白名单（mode/version，不含路径命令面）", () => {
    const realHtml = injectMonitorGlobal("<html></html>", "/p/m.json", { mode: "real", version: "v0.7.11b0" });
    expect(realHtml).toContain('"bridge":{"mode":"real","version":"v0.7.11b0"}');
    const mockHtml = injectMonitorGlobal("<html></html>", "/p/m.json", { mode: "mock", version: null });
    expect(mockHtml).toContain('"bridge":{"mode":"mock","version":null}');
    // 旧装配面（不传 bridge）＝批㉘形态零变化——client 回退不渲染徽标
    expect(injectMonitorGlobal("<html></html>", "/p/m.json")).not.toContain("bridge");
  });

  it("bridgeBadgeSurface：mock 缺省（无 env）——mode mock 且 version null（不触 git）", () => {
    const saved = process.env["ATF_DSH_BRIDGE_COMMAND"];
    delete process.env["ATF_DSH_BRIDGE_COMMAND"];
    try {
      const surface = bridgeBadgeSurface({}, "/data/sam/ATF-Harness");
      expect(surface).toEqual({ mode: "mock", version: null });
    } finally {
      if (saved !== undefined) process.env["ATF_DSH_BRIDGE_COMMAND"] = saved;
    }
  });

  it("bridgeBadgeSurface：env 指真内核（probe 桩确认包在位）＝real，版本自 kernelRoot git describe", () => {
    const savedBridge = process.env["ATF_DSH_BRIDGE_COMMAND"];
    const savedKernel = process.env["ATF_DSH_KERNEL_DIR"];
    process.env["ATF_DSH_KERNEL_DIR"] = "/data/sam/ATF-Harness";
    try {
      const surface = bridgeBadgeSurface(
        { ATF_DSH_BRIDGE_COMMAND: "python3 -m agentic_training_flow serve", ATF_DSH_KERNEL_DIR: "/data/sam/ATF-Harness" },
        "/data/sam/ATF-Harness",
        (p) => p === join("/data/sam/ATF-Harness", "src", "agentic_training_flow"),
      );
      expect(surface.mode).toBe("real");
      expect(surface.version).toMatch(/^v?\S+/);
    } finally {
      if (savedBridge !== undefined) process.env["ATF_DSH_BRIDGE_COMMAND"] = savedBridge; else delete process.env["ATF_DSH_BRIDGE_COMMAND"];
      if (savedKernel !== undefined) process.env["ATF_DSH_KERNEL_DIR"] = savedKernel; else delete process.env["ATF_DSH_KERNEL_DIR"];
    }
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
    // 批㊶-M2 段 2：run 特征过滤——夹具补 launch_manifest.json（特征锚之一）
    writeFileSync(join(runDir, "launch", "launch_manifest.json"), "{}");
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
    // 批㊶-M M-5＋批㊶-N N-4：GPU 组徽章撤销（GPU 摘要移监控面板头部详情行）——钉子随语义更新
    for (const phrase of ["formatGpuAllLocal", "formatGpuBindingLocal", "train.sh CUDA_VISIBLE_DEVICES", "deploy_effective.visible_devices", "无训练进行中"]) {
      expect(clientSource).toContain(phrase);
    }
    // 渲染面两处都在：GPU 状态条（dock）＋监控面板环境卡 GPU 行
    expect(clientSource).toContain("gpu_binding");
    expect(clientSource).toContain("'GPU：' + gpuRow");
  });
});

describe("批㉞H 两轮评估对比（badcases 计数＋轮面扫描组装＋快照下发）", () => {
  /** 双轮夹具：3-20261003（无口径键＋含 finish=length 截断行）／4-20261004（口径 12800＋全 stop）；1-20260999 无 orch/eval 不入列。 */
  const seedCompareRounds = (runDir: string): void => {
    const mk = (round: string, summary: Record<string, unknown>, badcases: string | null) => {
      const dir = join(runDir, "eval", round, "orch", "eval");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "metrics_summary.json"), JSON.stringify(summary));
      if (badcases !== null) writeFileSync(join(dir, "badcases.jsonl"), badcases);
    };
    mk("3-20261003",
      { model: "m-ckpt100", pages: 10, page_exact_rate: 0.0, micro: { precision: 0.5525, recall: 0.4015, f1: 0.465 }, fields: { container_no: { f1: 0.2941 }, goods_carton: { f1: 0.4643 } } },
      [
        JSON.stringify({ page_id: "p1", field: "container_no", finish_reason: "stop", fp: 0, fn: 2 }),
        JSON.stringify({ page_id: "p2", field: "goods_carton", finish_reason: "length", fp: 1, fn: 0 }),
        JSON.stringify({ page_id: "p3", field: "container_no", finish_reason: "stop", fp: 0, fn: 1 }),
        "{bad json line",
        JSON.stringify({ page_id: "p4", field: "goods_carton", finish_reason: "stop", fp: 3, fn: 0 }),
      ].join("\n") + "\n");
    mk("4-20261004",
      { model: "m-ckpt141", pages: 10, page_exact_rate: 0.0, request_max_completion_tokens: 12800, micro: { precision: 0.5436, recall: 0.3842, f1: 0.4502 }, fields: { container_no: { f1: 0.2941 } } },
      [
        JSON.stringify({ page_id: "p1", field: "container_no", finish_reason: "stop" }),
        JSON.stringify({ page_id: "p2", field: "seal_no", finish_reason: "stop" }),
      ].join("\n") + "\n");
    mkdirSync(join(runDir, "eval", "1-20260999", "ckpt-plan"), { recursive: true });
  };

  it("parseEvalBadcases 轮A（3-20261003）：finish=length 截断行计数＋by_field 计数；坏行跳过", async () => {
    const { parseEvalBadcases } = await import("../../packages/extensions/atf-ui/src/server.js");
    const root = tempRoot();
    const runDir = join(root, "run-cmp");
    seedCompareRounds(runDir);
    const text = readFileSync(join(runDir, "eval", "3-20261003", "orch", "eval", "badcases.jsonl"), "utf8");
    expect(parseEvalBadcases(text)).toEqual({
      total: 4,
      finish_reason: { stop: 3, length: 1 },
      by_field: { container_no: 2, goods_carton: 2 },
    });
  });
  it("parseEvalBadcases 轮B（4-20261004）：全 stop 计数；空文本零计数不抛", async () => {
    const { parseEvalBadcases } = await import("../../packages/extensions/atf-ui/src/server.js");
    const root = tempRoot();
    const runDir = join(root, "run-cmp");
    seedCompareRounds(runDir);
    const text = readFileSync(join(runDir, "eval", "4-20261004", "orch", "eval", "badcases.jsonl"), "utf8");
    expect(parseEvalBadcases(text)).toEqual({ total: 2, finish_reason: { stop: 2 }, by_field: { container_no: 1, seal_no: 1 } });
    expect(parseEvalBadcases("")).toEqual({ total: 0, finish_reason: {}, by_field: {} });
  });
  it("scanEvalRounds 对比组装：两轮按 N 升序（口径键轮A null／轮B 12800；fields_f1 轮B 缺键如实短面；无 orch/eval 轮不入列；badcases 缺席轮 null）", async () => {
    const { scanEvalRounds } = await import("../../packages/extensions/atf-ui/src/server.js");
    const root = tempRoot();
    const runDir = join(root, "run-cmp");
    seedCompareRounds(runDir);
    // 再造一轮有 metrics 无 badcases（缺席面如实 null）
    mkdirSync(join(runDir, "eval", "5-20261005", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "eval", "5-20261005", "orch", "eval", "metrics_summary.json"), JSON.stringify({ model: "m5", micro: { f1: 0.5 }, fields: {} }));
    const rounds = scanEvalRounds(runDir);
    expect(rounds.map((r) => r.round)).toEqual(["3-20261003", "4-20261004", "5-20261005"]);
    expect(rounds[0]?.metrics).toMatchObject({ f1: 0.465, max_completion_tokens: null });
    expect(rounds[1]?.metrics).toMatchObject({ f1: 0.4502, max_completion_tokens: 12800 });
    expect(rounds[0]?.fields_f1).toEqual({ container_no: 0.2941, goods_carton: 0.4643 });
    expect(rounds[1]?.fields_f1).toEqual({ container_no: 0.2941 });
    expect(rounds[0]?.badcases).toMatchObject({ total: 4, finish_reason: { length: 1 } });
    expect(rounds[2]?.badcases).toBeNull();
    expect(rounds[2]?.fields_f1).toBeNull();
    expect(scanEvalRounds(join(root, "run-missing"))).toEqual([]);
  });
  it("对比组装下发：scanRunDir→monitor eval_rounds 透传（缺省空数组）＋client 对比面钉子（占位文案不造数据）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-cmp");
    seedCompareRounds(runDir);
    const scan = scanRunDir(root, "run-cmp");
    expect(scan.eval_rounds).toHaveLength(2);
    const snap = buildMonitorSnapshot([scan]);
    expect(snap.runs[0]?.eval_rounds).toHaveLength(2);
    expect(buildMonitorSnapshot([{ ...scan, eval_rounds: undefined }]).runs[0]?.eval_rounds).toEqual([]);
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    for (const phrase of ["评估对比", "atf-cmp-grid", "finish=length 行数", "max_completion_tokens", "字段级数据需分析链产出", "不足两轮"]) {
      expect(clientSource).toContain(phrase);
    }
  });
});

describe("批㊶-L L-1 训练活跃终结判定（tmux 注入＋mtime 新鲜窗口）", () => {
  const seedRun = (root: string, runId: string, freshMs: number | null): string => {
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), "[]");
    if (freshMs !== null) {
      const t = new Date(Date.now() - freshMs);
      utimesSync(join(runDir, "training", "loss-series.json"), t, t);
    }
    return runDir;
  };

  it("批㊶-O O-1：泛匹配 tmux 在场不再恒 active（须绑 run 取证或 mtime 新鲜）；env 窗口解析三态", () => {
    const root = tempRoot();
    seedRun(root, "run-l1", 3_600_000);
    // 泛匹配布尔 trainingTmuxPresent=true 但无本 run 取证、mtime 过期 → 抑制（假阳性根除）
    const scan = scanRunDir(root, "run-l1", { trainingTmuxPresent: true, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scan.training.active).toBe(false);
    // 本 run 取证命中 → active（mtime 过期不灭）
    const scanEvidence = scanRunDir(root, "run-l1", { trainingTmuxPresent: true, trainingEvidence: { "run-l1": true }, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scanEvidence.training.active).toBe(true);
    expect(resolveTrainActiveWindowMs({})).toBe(180_000);
    expect(resolveTrainActiveWindowMs({ ATF_TRAIN_ACTIVE_WINDOW_MS: "5000" })).toBe(5_000);
    expect(resolveTrainActiveWindowMs({ ATF_TRAIN_ACTIVE_WINDOW_MS: "0" })).toBe(180_000);
    expect(resolveTrainActiveWindowMs({ ATF_TRAIN_ACTIVE_WINDOW_MS: "abc" })).toBe(180_000);
    expect(resolveTrainActiveWindowMs({ ATF_TRAIN_ACTIVE_WINDOW_MS: "-1" })).toBe(180_000);
  });

  it("tmux 不在场：mtime 新鲜窗口内 active；过期终结（false）", () => {
    const root = tempRoot();
    seedRun(root, "run-fresh", 10_000);
    expect(scanRunDir(root, "run-fresh", { trainingTmuxPresent: false, nowMs: Date.now(), freshWindowMs: 180_000 }).training.active).toBe(true);
    seedRun(root, "run-stale", 3_600_000);
    expect(scanRunDir(root, "run-stale", { trainingTmuxPresent: false, nowMs: Date.now(), freshWindowMs: 180_000 }).training.active).toBe(false);
    // 注入缺席（旧调用方）＝tmux 视为不在场 → 仅 mtime 判据
    seedRun(root, "run-default", 10_000);
    expect(scanRunDir(root, "run-default").training.active).toBe(true);
  });

  it("liveness 共享单源：作用域基名与探测函数（批㊶-P1 S1——probeSession 必传作用域基名；tmux 缺席环境如实 false）", () => {
    expect(trainingSessionBase("run-l1")).toBe("atf-training-run-run-l1");
    expect(typeof tmuxHasSession(trainingSessionBase("run-l1"))).toBe("boolean");
  });
});

describe("批㊶-L L-2 segments 补 evaluate 推导", () => {
  it("metrics_summary 在场 → evaluate done；缺席 → pending（false；批㊶-N 段序守卫下前序全成立）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-ev");
    mkdirSync(join(runDir, "eval"), { recursive: true });
    writeFileSync(join(runDir, "eval", "metrics_summary.json"), "{}");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), "[]");
    for (const [dir, file] of [["", "registration.json"], ["", "label_qc"], ["webui", "config-snapshot.json"], ["", "contract-candidate.json"], ["", "split"], ["launch", "train.sh"]] as Array<[string, string]>) {
      mkdirSync(join(runDir, dir), { recursive: true });
      writeFileSync(join(runDir, dir, file), "{}");
    }
    expect(scanRunDir(root, "run-ev", { nowMs: Date.now() + 600_000 }).segments.evaluate).toBe(true); // S-B2：nowMs 过窗（loss-series fresh 窗口期不入前缀）
    const root2 = tempRoot();
    expect(scanRunDir(root2, "run-noev").segments.evaluate).toBe(false);
  });
});

describe("批㊶-M2 段 2 scanRuns 特征过滤（布局规范＋防御）", () => {
  it("有特征收录：webui/ 或 training/ 或 eval/ 或 prep/ 或 launch_manifest.json 任一", () => {
    for (const rel of ["webui/x.json", "training/loss.json", "eval/metrics_summary.json", "prep/iteration-config.json", "launch_manifest.json"]) {
      const root = tempRoot();
      const runDir = join(root, "run-f");
      mkdirSync(join(runDir, rel, ".."), { recursive: true });
      writeFileSync(join(runDir, rel), "{}");
      expect(looksLikeRun(runDir), rel).toBe(true);
    }
    expect(RUN_MARKER_RELS.length).toBe(6); // 批㊶-O 补：launch/launch_manifest.json 路径锚
  });
  it("无特征忽略：atf-ui 输出面（monitor.json/artifacts.json/panel.html）与空目录不收录", () => {
    const root = tempRoot();
    const atfDir = join(root, "atf-ui");
    mkdirSync(atfDir, { recursive: true });
    writeFileSync(join(atfDir, "monitor.json"), "{}");
    expect(looksLikeRun(atfDir)).toBe(false);
    expect(looksLikeRun(join(root, "empty"))).toBe(false);
  });
  it("嵌套遗留形态不误判：runs/runs/<真 run> 外层无特征即忽略", () => {
    const root = tempRoot();
    const nested = join(root, "runs", "run-x");
    mkdirSync(join(nested, "webui"), { recursive: true });
    writeFileSync(join(nested, "webui", "binding.json"), "[]");
    expect(looksLikeRun(join(root, "runs"))).toBe(false);
    expect(looksLikeRun(nested)).toBe(true);
  });
  it("scanRunDir 集成：无特征目录不出现在扫描结果", () => {
    const root = tempRoot();
    const atfDir = join(root, "atf-ui");
    mkdirSync(atfDir, { recursive: true });
    writeFileSync(join(atfDir, "monitor.json"), "{}");
    const runDir = join(root, "run-real");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "binding.json"), "[]");
    const scans = [scanRunDir(root, "atf-ui"), scanRunDir(root, "run-real")];
    expect(scans[0]!.run_id).toBe("atf-ui");
    expect(scans[1]!.run_id).toBe("run-real");
    expect(scanRunDir(root, "atf-ui").segments).toBeDefined();
    void scans;
  });
});

// 批㊶-Q 通报面（段1/2/3 additive）：probe 面随 alerts 末条流转（info·kind 通报条目原样透传）
describe("批㊶-Q probe 通报面（info·kind additive——alerts 末条透传）", () => {
  it("scanRunDir probe 面：alerts 末条（info·config_auto）原样透传 level/kind/reason；无 alerts → null", () => {
    const root = tempRoot();
    const runDir = join(root, "run-q");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([
      { level: "error", kind: "probe", reason: "训练疑似停滞", since: "2026-10-10T08:00:00.000Z" },
      { level: "info", kind: "config_auto", reason: "全自动训练档·配置自动确认（免审批，run run-q）——learning_rate=2e-4[default:agent-recommend:x]", since: "2026-10-10T09:00:00.000Z" },
    ]));
    const scan = scanRunDir(root, "run-q");
    expect(scan.probe).toMatchObject({ level: "info", kind: "config_auto" });
    expect(String(scan.probe?.reason)).toContain("全自动训练档·配置自动确认");
    // 通报类 OOM 条目（kind=oom_fallback）同样透传（client 据 kind 渲染 OOM 降档重发 chip）
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([
      { level: "info", kind: "oom_fallback", reason: "OOM 自动降档重发（run run-q）：bs 2→1", since: "2026-10-10T09:30:00.000Z" },
    ]));
    expect(scanRunDir(root, "run-q").probe).toMatchObject({ level: "info", kind: "oom_fallback" });
  });
  it("client.js 通报面钉子：全自动训练 chip／OOM 降档重发 chip／info 品牌色／通报类无重发按钮（裸服务不打包——源面锚）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    for (const phrase of ["全自动训练", "OOM 降档重发", "config_auto", "oom_fallback", "dsw-alias-brand-primary"]) {
      expect(clientSource).toContain(phrase);
    }
    // 通报类（isAutoNotice）不渲染"重新发起"按钮——探针类保留
    expect(clientSource).toContain("!isAutoNotice && React.createElement('button'");
  });
});

describe("批㊶Q增补三 段3——工作区桶投影与作用域过滤（单根多桶＋存量平铺兼容）", () => {
  it("scanRunDir workspace 标注：分桶＝桶名，平铺缺省 null；buildMonitorSnapshot 投影 additive", () => {
    const root = tempRoot();
    const bucketDir = join(root, "ci_smoke", "cr_r3");
    mkdirSync(join(bucketDir, "training"), { recursive: true });
    const flatDir = join(root, "cr_flat");
    mkdirSync(flatDir, { recursive: true });
    const bucketed = scanRunDir(root, "cr_r3", undefined, "ci_smoke");
    expect(bucketed.workspace).toBe("ci_smoke");
    expect(bucketed.run_id).toBe("cr_r3");
    const flat = scanRunDir(root, "cr_flat");
    expect(flat.workspace).toBeNull();
    const mon = buildMonitorSnapshot([bucketed, flat]);
    expect((mon.runs[0] as Record<string, unknown>)["workspace"]).toBe("ci_smoke");
    expect((mon.runs[1] as Record<string, unknown>)["workspace"]).toBeNull();
  });
  it("buildArtifactsSnapshot：分桶 run 产物路径带桶前缀（runsRoot 相对如实）；平铺形态不变", () => {
    const bucketedRun = { ...sampleRun, workspace: "ci_smoke", artifacts: ["session.jsonl"] };
    const arts = buildArtifactsSnapshot([bucketedRun]).runs[0] as unknown as Record<string, unknown>;
    expect(arts["path_prefix"]).toBe("ci_smoke/");
    expect((arts["artifacts"] as Array<{ path: string }>).some((a) => a.path === "ci_smoke/run-x/session.jsonl")).toBe(true);
    const flatArts = buildArtifactsSnapshot([{ ...sampleRun, artifacts: ["session.jsonl"] }]).runs[0] as unknown as Record<string, unknown>;
    expect(flatArts["path_prefix"]).toBe("");
    expect((flatArts["artifacts"] as Array<{ path: string }>).some((a) => a.path === "run-x/session.jsonl")).toBe(true);
  });
  it("client.js 工作区作用域钉子：scopedRuns＝绑定∪同桶（裸服务不打包——源面锚）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    // 作用域函数在位且语义键齐全（workspace 桶标注＋bound_sessions 并集）
    expect(clientSource).toContain("function scopedRuns(mon, sessionId)");
    expect(clientSource).toContain("r.workspace === myWorkspace");
    // 浮卡/dock 与监控选择器两消费面都走 scopedRuns（「全部实例」显式切换保留）
    expect(clientSource).toContain("const scopeRuns = sessionId ? scopedRuns(mon, sessionId) : null");
    expect(clientSource).toContain("var runs = showAll ? allRuns : scopedRuns(mon, store.sessionId)");
    expect(clientSource).toContain("myWorkspace === null) return bound");
  });
  it("viewer 路由 runDirOf 注入钉子（分桶实例 viewer 发现走双形态解析）", () => {
    const serverSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/src/server.ts"), "utf8");
    expect(serverSource).toContain("runDirOf: (runId) => resolveRunDir(resolved.runsRoot, runId)");
    expect(serverSource).toContain("sweepAnsweredPendings(resolved.runsRoot)");
    expect(serverSource).toContain("ledgerEnvPrefix: ledgerEnvPrefixForShell(process.env)");
  });
});

describe("批㊶Q增补三 段3——scanRuns 双层扫描（幻影 run 防回潮：真机 24 条污染实证）", () => {
  it("平铺 run 的内部子目录（launch/eval/l1/publish-ws-*）不作桶降层；真桶 run 正常收录", () => {
    const root = tempRoot();
    // 平铺存量 run：内部结构含 launch/（其下还有 webui/——真机幻影形态 cr_r2/launch/webui）
    const flat = join(root, "cr_r2");
    mkdirSync(join(flat, "launch", "webui"), { recursive: true });
    mkdirSync(join(flat, "webui"), { recursive: true });
    writeFileSync(join(flat, "launch", "train.sh"), "#!/bin/bash\n");
    writeFileSync(join(flat, "launch", "webui", "pending-confirm.json"), "{}\n");
    writeFileSync(join(flat, "webui", "config-snapshot.json"), "{}\n");
    // 真桶：ci_smoke 工作区内的分桶 run
    const bucketed = join(root, "ci_smoke", "cr_r3", "launch");
    mkdirSync(bucketed, { recursive: true });
    writeFileSync(join(bucketed, "train.sh"), "#!/bin/bash\n");
    writeFileSync(join(root, "ci_smoke", "cr_r3", "launch", "launch_manifest.json"), "{}\n");
    const runs = scanRuns(root);
    const ids = runs.map((r) => `${r.workspace ?? ""}/${r.run_id}`).sort();
    expect(ids).toEqual(["/cr_r2", "ci_smoke/cr_r3"]); // sort 序："/" < 字母
    expect(runs.find((r) => r.run_id === "cr_r2")?.workspace).toBeNull();
    expect(runs.find((r) => r.run_id === "cr_r3")?.workspace).toBe("ci_smoke");
  });
});

describe("批㊶-S3 S-B2——八段卡判据链修复（lit 硬伤/级联抑制/percentage 出口/fresh 边界）", () => {
  it("段序守卫豁免：事实轨段（experiment_config/publish）不因 register/label_qc 锚缺席被级联抹除（真机 done=0/8 根因）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-guard");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "config-snapshot.json"), "{}\n");
    // 事实轨：atf_config_confirm/atf_publish_confirm 执行成功记录（真机 awb_r1 同形态）
    appendSegmentFact(runDir, "experiment_config", "atf_config_confirm");
    appendSegmentFact(runDir, "publish", "atf_publish_confirm");
    const scan = scanRunDir(root, "run-guard");
    expect(scan.segments.experiment_config).toBe(true);
    expect(scan.segments.publish).toBe(true);
    // owner 裁定（段显示态保序）：publish 事实反蕴含前段——register/label_qc 随前缀点亮，
    // 不再出现 ✓○✓○ 间隔态；split/admission/training/evaluate 无证据如实 pending（frontier 后）
    expect(scan.segments.register).toBe(true);
    expect(scan.segments.label_qc).toBe(true);
    expect(scan.segments.split).toBe(false);
    expect(scan.segments.training).toBe(false);
  });
  it("收尾段完成锚入前缀：training/evaluate 证据使全段 8/8 保序点亮（间隔完成态消除）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-tail");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x");
    writeFileSync(join(runDir, "training", "all_results.json"), "{}\n");
    mkdirSync(join(runDir, "eval", "1-20261013", "orch", "eval"), { recursive: true });
    writeFileSync(join(runDir, "eval", "1-20261013", "orch", "eval", "metrics_summary.json"), "{}\n");
    const scan = scanRunDir(root, "run-tail");
    expect(scan.segments.training).toBe(true);
    expect(scan.segments.evaluate).toBe(true);
    // 前缀闭包：收尾段证据反蕴含——全段 8/8（后段完成蕴含前段发生，无间隔态）
    expect(scan.segments.register).toBe(true);
    expect(scan.segments.admission).toBe(true);
  });
  it("snapshot segmentStatus：训练进行中（anchor 在场＋active）→ active 优先于 done（训练全程不再假✓）", () => {
    const snap = buildMonitorSnapshot([{
      ...sampleRun,
      segments: { register: true, training: true },
      training: { active: true, loss: [], pending_confirm: null },
    }], { offline: true });
    expect(snap.runs[0]?.segments.find((s) => s.key === "training")?.status).toBe("active");
    const snapDone = buildMonitorSnapshot([{
      ...sampleRun,
      segments: { register: true, training: true },
      training: { active: false, loss: [], pending_confirm: null },
    }], { offline: true });
    expect(snapDone.runs[0]?.segments.find((s) => s.key === "training")?.status).toBe("done");
  });
  it("panel.html 渲染回归：八段卡读四态 status（lit 硬伤退役）＋updated 空引用已删", () => {
    const panel = PANEL_HTML;
    expect(panel).not.toContain("s2.lit");
    expect(panel).toContain("STATE_MARK");
    expect(panel).not.toContain("getElementById('updated')");
    // 四态标记闭集在模板（done✓/active●/failed✗/pending 序号）
    expect(panel).toContain("background:var(--atf-success);color:#fff;font-size:12px;\">✓");
    expect(panel).toContain("background:var(--atf-warning);color:#fff;font-size:12px;\">●");
    expect(panel).toContain("background:var(--atf-danger);color:#fff;font-size:12px;\">✗");
  });
  it("progressFresh 边界：恰在窗口边界（now-at==window）算 fresh（≤语义）；超一毫秒即过期", () => {
    const progress = { round: 1, updated_at: new Date(1_000).toISOString() };
    expect(progressFresh(progress, 1_000 + 180_000, 180_000)).toBe(true);
    expect(progressFresh(progress, 1_000 + 180_001, 180_000)).toBe(false);
  });
});

describe("批㊶-S3 S-B1——通知面投影（monitor.json additive 键三同步）＋client 钉子", () => {
  it("scanRunDir→monitor 投影白名单：eval_progress 五键闭集/eval_notices 元素键闭集（无路径命令面）", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-notice");
    const orchDir = join(runDir, "eval", "1-20261013", "orch");
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(join(orchDir, "progress.jsonl"), [
      JSON.stringify({ ts: "2026-10-13T21:21:48+0800", phase: "launching", detail: "服务启动/等待就绪中,探活未过", elapsed_s: 0 }),
      JSON.stringify({ ts: "2026-10-13T21:22:18+0800", phase: "ready", detail: "health 探测通过", elapsed_s: 30 }),
      "",
    ].join("\n"), "utf8");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x");
    appendSegmentFact(runDir, "training", "atf_run_training", "2026-10-13T12:00:00.000Z");
    const scan = scanRunDir(root, "run-notice");
    expect(Object.keys(scan.eval_progress ?? {}).sort()).toEqual(["detail", "elapsed_s", "phase", "round", "updated_at"]);
    expect(scan.eval_notices.length).toBeGreaterThanOrEqual(3);
    for (const n of scan.eval_notices) {
      expect(Object.keys(n).every((k) => ["id", "round", "phase", "detail", "elapsed_s", "at", "kind"].includes(k))).toBe(true);
    }
    const snap = buildMonitorSnapshot([scan], { offline: true });
    expect(snap.runs[0]?.eval_progress).toMatchObject({ phase: "ready" });
    expect(Array.isArray(snap.runs[0]?.eval_notices)).toBe(true);
    // 无账 run：投影键仍在（null/空数组——schema 形态稳定，client 回退不渲染）
    const bare = scanRunDir(root, "run-bare");
    expect(bare.eval_progress).toBeNull();
    expect(bare.eval_notices).toEqual([]);
  });
  it("progress 持续写链（批㊶-TRAIN-OBS 改版）：30s 节流块退役→5s 观测环（trainObsTick 接线＋12 轮 stale＋capture 接线）", () => {
    const serverSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/src/server.ts"), "utf8");
    expect(serverSource).toContain("trainObsTick(run.run_id, runDir, readNumTrainEpochs(runDir)");
    expect(serverSource).toContain("tmuxSessionRefused");
    expect(serverSource).not.toContain("PROGRESS_SYNC_MIN_MS"); // 30s 节流块已被 5s 环取代
    expect(serverSource).toContain("trainlog_tail: readTrainlogTail(dir)"); // T3 投影接线
  });
  it("client.js 通知卡钉子：EvalNoticeStack＋去重已读集＋四态文案＋trainable 指引（裸服务——源面锚）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    expect(clientSource).toContain("function EvalNoticeStack()");
    expect(clientSource).toContain("atf_seen_notices");
    expect(clientSource).toContain("launching: '评估服务启动中', initializing: '评估服务初始化中', ready: '评估服务就绪', failed: '评估服务失败'");
    expect(clientSource).toContain("训练收尾完成，可发起评估（atf_evaluate）");
    // 已读清理上限（localStorage 容量卫生）与新鲜窗口
    expect(clientSource).toContain("keys.length > 200");
    expect(clientSource).toContain("EVAL_NOTICE_MAX_AGE_MS");
    // 挂载在 dock 行（浮卡展开态之后）
    expect(clientSource).toContain("React.createElement(EvalNoticeStack)");
  });
  it("client.js 步进百分比上卡钉子：segDetail 两副本都带 percentage 位；failed 态判定串修正", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    expect(clientSource.match(/typeof progress\.percentage === 'number'\) bits\.push/g)?.length).toBe(2);
    expect(clientSource).toContain("seg.status === 'failed'");
    expect(clientSource).not.toContain("seg.status === 'fail'");
  });
  it("批㊶-TRAIN-OBS-FIX2 T2 裁定钉子：收起徽标＝进度百分比优先（回退轮比例→段比例；additive）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    expect(clientSource).toContain("收起徽标＝进度百分比优先");
    expect(clientSource).toContain("typeof progress.percentage === 'number'\n                  ? Math.round(progress.percentage) + '%'");
    // 回退链保序：百分比缺席 → 轮比例；轮缺席 → 段比例（原形态零回归）
    expect(clientSource).toContain("typeof progress.round === 'number'\n                    ? (typeof progress.total_rounds === 'number' ? progress.round + '/' + progress.total_rounds : String(progress.round))");
  });
  it("批㊶-TRAIN-OBS-FIX2 钉子：TrainlogTailSection 组件边界（含 useState 须 createElement 挂载——直调条件挂载即 React #310 整槽崩溃）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    // 三调用点（MonitorBody pane＋浮卡自展开＋浮卡 store 展开）全走组件边界
    expect(clientSource.match(/React\.createElement\(TrainlogTailSection, \{ run: run \}\)/g)?.length).toBe(3);
    // 直调形态清零（防回归）
    expect(clientSource).not.toMatch(/[^']TrainlogTailSection\(run\)/);
    expect(clientSource).toContain("function TrainlogTailSection(props)");
  });
});
