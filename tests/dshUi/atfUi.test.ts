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
  it("批C1-1 快照投影：train_notices 透传（缺省空数组）；eval_progress.health 原样直通", () => {
    const notice = { id: "train:training_done:r1:t", kind: "training_done", run_id: "r1", at: "t", text: "训练已结束" };
    // 交叉类型断言（snapshot.js 推断面无 additive 键——与 progress 投影用例同款手法）
    type RunWithNotices = typeof sampleRun & { train_notices: unknown[]; eval_progress: unknown };
    const withNotices = buildMonitorSnapshot([
      { ...sampleRun, train_notices: [notice], eval_progress: { round: "1-20261018", phase: "ready", detail: "", elapsed_s: 3, updated_at: "t", health: { alive: false, port: 8100, checked_at: "t" } } } as RunWithNotices,
    ]);
    expect((withNotices.runs[0] as { train_notices?: unknown[] }).train_notices).toEqual([notice]);
    expect((withNotices.runs[0] as { eval_progress?: { phase?: string; health?: { alive?: boolean; port?: number } } }).eval_progress).toMatchObject({ phase: "ready", health: { alive: false, port: 8100 } });
    // 双缺省：train_notices 空数组（不炸）；eval_progress 缺省 null
    const bare = buildMonitorSnapshot([sampleRun]);
    expect((bare.runs[0] as { train_notices?: unknown[] }).train_notices).toEqual([]);
    expect((bare.runs[0] as { eval_progress?: unknown }).eval_progress).toBeNull();
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
  it("批C2 E9 多形态发现：eval 域直挂＋评估轮深挂（相对路径入列）；无 viewer.html 落选；全形态 mtime 排序", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-e9");
    const shallow = seedViewerTree(runDir, "analysis", { "viewer.html": "<html>浅</html>" });            // 形态①
    const direct = seedViewerTree(join(runDir, "eval_r2"), "analysis", { "viewer.html": "<html>直挂</html>" }); // 形态②
    const deep = seedViewerTree(join(runDir, "eval", "2-20261018"), "analysis", { "viewer.html": "<html>深挂</html>" }); // 形态③
    seedViewerTree(join(runDir, "eval", "2-20261018"), "analysis-noviewer", { "other.txt": "x" });        // 有 analysis 无 viewer.html
    seedViewerTree(join(runDir, "eval", "not-a-round"), "analysis", { "viewer.html": "<html>非轮</html>" }); // 轮名不合规→不入列
    seedViewerTree(runDir, "unrelated", { "viewer.html": "<html>无关</html>" });                          // 非 analysis 前缀
    const out = discoverViewerDirs(runDir);
    expect(out).toContain("analysis");
    expect(out).toContain("eval_r2/analysis");
    expect(out).toContain("eval/2-20261018/analysis");
    expect(out).not.toContain("eval/2-20261018/analysis-noviewer");
    expect(out).not.toContain("eval/not-a-round/analysis");
    expect(out).not.toContain("unrelated");
    expect(out).toHaveLength(3);
    // mtime 排序：最新（deep）在前，最旧（shallow）在后
    const t0 = new Date(Date.now() - 120_000);
    utimesSync(join(shallow, "viewer.html"), t0, t0);
    utimesSync(join(direct, "viewer.html"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    utimesSync(join(deep, "viewer.html"), new Date(), new Date());
    expect(discoverViewerDirs(runDir)).toEqual(["eval/2-20261018/analysis", "eval_r2/analysis", "analysis"]);
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

describe("批C1-1 D5 训练终态跃迁通知（tickOnce 状态机——跨 tick 跃迁产 train_notices）", () => {
  it("活跃→done：二跳出卡一次；三跳不重复；pending→failed 同理；首见即终态不出", async () => {
    const root = tempRoot();
    const mkRun = (runId: string): string => {
      const runDir = join(root, runId);
      mkdirSync(join(runDir, "training"), { recursive: true });
      writeFileSync(join(runDir, "registration.json"), "{}");
      writeFileSync(join(runDir, "session.jsonl"), "{}\n");
      writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
      return runDir;
    };
    const doneRun = mkRun("run-d5-done");
    const failRun = mkRun("run-d5-fail");
    mkRun("run-d5-seen-done");
    // 首见即终态夹具：无活跃历史（撤 loss）＋直接给完成锚
    rmSync(join(root, "run-d5-seen-done", "training", "loss-series.json"));
    writeFileSync(join(root, "run-d5-seen-done", "training", "all_results.json"), "{}");
    const { tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
    const readMonitor = (): Array<{ run_id: string; train_notices: Array<{ id: string; kind: string; text: string }> }> =>
      (JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as { runs: Array<{ run_id: string; train_notices: Array<{ id: string; kind: string; text: string }> }> }).runs;
    // tick1：done-run 活跃（loss 新鲜）；fail-run 活跃；seen-done 首见即终态（不产）
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const t1 = readMonitor();
    expect(t1.find((r) => r.run_id === "run-d5-done")?.train_notices).toEqual([]);
    expect(t1.find((r) => r.run_id === "run-d5-seen-done")?.train_notices).toEqual([]);
    // tick2：done-run 落完成锚＋loss 陈旧化 → done 跃迁；fail-run 撤 loss＋记启动证据 → failed 跃迁
    writeFileSync(join(doneRun, "training", "all_results.json"), "{}");
    const stale = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(join(doneRun, "training", "loss-series.json"), stale, stale);
    rmSync(join(failRun, "training", "loss-series.json"));
    writeFileSync(join(failRun, "training", "trainer_state.json"), "{}");
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const t2 = readMonitor();
    const doneNotice = t2.find((r) => r.run_id === "run-d5-done")?.train_notices ?? [];
    const failNotice = t2.find((r) => r.run_id === "run-d5-fail")?.train_notices ?? [];
    expect(doneNotice).toHaveLength(1);
    expect(doneNotice[0]).toMatchObject({ kind: "training_done", run_id: "run-d5-done", text: "训练已结束" });
    expect(typeof doneNotice[0]?.id).toBe("string");
    expect(failNotice).toHaveLength(1);
    expect(failNotice[0]).toMatchObject({ kind: "training_failed", run_id: "run-d5-fail" });
    expect(failNotice[0]?.text).toContain("训练未完成退出");
    // tick3：无新跃迁——通知账不增（已读集外层去重的服务端幂等面）
    await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    const t3 = readMonitor();
    expect(t3.find((r) => r.run_id === "run-d5-done")?.train_notices).toHaveLength(1);
    // 持久化在位：状态文件与 monitor.json 同目录
    const stateFile = JSON.parse(readFileSync(join(root, "atf-ui", "train-notice-state.json"), "utf8")) as {
      states: Record<string, string>;
      notices: Record<string, Array<{ id: string }>>;
    };
    expect(stateFile.states["run-d5-done"]).toBe("done");
    expect(stateFile.notices["run-d5-done"]).toHaveLength(1);
    expect(stateFile.states["run-d5-seen-done"]).toBe("done");
    expect(stateFile.notices["run-d5-seen-done"]).toBeUndefined();
  });
});

describe("批C1-1 D6 评估服务健康（tickOnce——内核探针只读调用；缺面 null 不造假）", () => {
  it("eval_progress 在场＋服务登记在位 → health 三键回填；无登记 → null", async () => {
    const root = tempRoot();
    const mkEvalRun = (runId: string, withService: boolean): void => {
      const runDir = join(root, runId);
      mkdirSync(join(runDir, "eval", "1-20261018", "orch"), { recursive: true });
      writeFileSync(join(runDir, "registration.json"), "{}");
      writeFileSync(join(runDir, "session.jsonl"), "{}\n");
      writeFileSync(join(runDir, "eval", "1-20261018", "orch", "progress.jsonl"),
        JSON.stringify({ ts: "2026-10-18T02:00:00+0800", phase: "ready", detail: "health 探测通过", elapsed_s: 30 }) + "\n");
      if (withService) {
        writeFileSync(join(runDir, "eval", "services.jsonl"), JSON.stringify({ ts: "t", port: 8100, base_url: "http://127.0.0.1:8100/v1" }) + "\n");
      }
    };
    mkEvalRun("run-health", true);
    mkEvalRun("run-nohealth", false);
    // 假内核目录（探针脚本桩——确定性 alive:true；env 显式注入，单测零真机依赖）
    const kernel = tempRoot();
    const scripts = join(kernel, "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "eval_service_probe.py"), [
      "def utc_now_iso():",
      "    return '2026-10-18T03:00:00+00:00'",
      "def probe_local_vllm_process(port, ps_runner=None):",
      "    return {'found': True, 'pid': 1, 'cmdline_summary': '', 'matched_by': 'port_flag', 'parsed': None, 'candidates': 1}",
      "",
    ].join("\n"), "utf8");
    const prevKernel = process.env["ATF_DSH_KERNEL_DIR"];
    process.env["ATF_DSH_KERNEL_DIR"] = kernel;
    try {
      const { tickOnce } = await import("../../packages/extensions/atf-ui/src/server.js");
      await tickOnce({ runsRoot: root, intervalMs: 60_000 });
    } finally {
      if (prevKernel === undefined) delete process.env["ATF_DSH_KERNEL_DIR"];
      else process.env["ATF_DSH_KERNEL_DIR"] = prevKernel;
    }
    const monitor = JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as {
      runs: Array<{ run_id: string; eval_progress: { round: string; phase: string; health: { alive: boolean; port: number; checked_at: string } | null } | null }>;
    };
    const withHealth = monitor.runs.find((r) => r.run_id === "run-health")?.eval_progress;
    expect(withHealth).toMatchObject({ round: "1-20261018", phase: "ready", health: { alive: true, port: 8100, checked_at: "2026-10-18T03:00:00+00:00" } });
    const noHealth = monitor.runs.find((r) => r.run_id === "run-nohealth")?.eval_progress;
    expect(noHealth?.phase).toBe("ready");
    expect(noHealth?.health).toBeNull();
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
  it("批C2 E9 路由多段形态：eval 域深挂 viewer 相对路径前缀命中（含子资源）；未命中回落首条缺省", () => {
    const root = tempRoot();
    const runDir = join(root, "run-deep");
    seedViewerTree(runDir, "analysis", { "viewer.html": "<html>浅</html>" });
    seedViewerTree(join(runDir, "eval", "3-20261018"), "analysis", { "viewer.html": "<html>深</html>", "data.json": "{}" });
    const viewers = ["analysis", "eval/3-20261018/analysis"];
    expect(resolveViewerRequest(root, `${P}/run-deep/eval/3-20261018/analysis/viewer.html`, viewers)?.abs)
      .toBe(join(runDir, "eval", "3-20261018", "analysis", "viewer", "viewer.html"));
    expect(resolveViewerRequest(root, `${P}/run-deep/eval/3-20261018/analysis/data.json`, viewers)?.type).toContain("application/json");
    // 深挂为唯一条目时：裸 run URL 回落首条缺省
    expect(resolveViewerRequest(root, `${P}/run-deep/`, ["eval/3-20261018/analysis"])?.abs)
      .toBe(join(runDir, "eval", "3-20261018", "analysis", "viewer", "viewer.html"));
    // 越界仍拒：清单外多段路径不可达
    expect(resolveViewerRequest(root, `${P}/run-deep/eval/9-20260101/analysis/viewer.html`, viewers)).toBeNull();
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
    expect(registered).toContainEqual({ kind: "exact", path: "/atf-ui/snapshot" });
    // 目录结构 v1：工作区注册表清单端点（目录丢失呈现数据源——只读）
    expect(registered).toContainEqual({ kind: "exact", path: "/atf-ui/workspaces" });
    for (const d of effects) d();
  });
});

describe("目录结构 v1 呈现增强（client.js 源面锚——浏览器渲染走 DSH 真跑）", () => {
  const clientSource = (): string => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");

  it("任务桶语义钉子：未分组/Ungrouped → 任务/Task 双语闭集精确匹配改写（仅值变化写回防自激）", () => {
    const source = clientSource();
    expect(source).toContain("'未分组': '任务'");
    expect(source).toContain("'Ungrouped': 'Task'");
    // 选择器形态＝dev DOM 实锚（css-modules 哈希类——语义段子串，字面量类永不匹配）：
    // 组行容器 data-row-key 前缀 workspace:（未分组行实测空前缀 workspace: 同前缀命中）
    // ＋label span 语义段 title；搜索结果 meta span 语义段 searchResultWorkspace。
    expect(source).toContain('[data-row-key^="workspace:"] [class*="title"]');
    expect(source).toContain('[class*="searchResultWorkspace"]');
    expect(source).toContain("span.textContent !== replacement");
  });

  it("目录丢失卡钉子：/atf-ui/workspaces 轮询＋exists=false 过滤＋rebind 指路文案＋dock 挂载", () => {
    const source = clientSource();
    expect(source).toContain("'/atf-ui/workspaces'");
    expect(source).toContain("LostWorkspacesBanner");
    expect(source).toContain("record.exists === false");
    expect(source).toContain("可用 atf_rebind_workspace 重新定位");
    expect(source).toContain("React.createElement(LostWorkspacesBanner)");
    expect(source).toContain("WORKSPACES_POLL_MS");
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
  it("parseNvidiaSmiAll：逐行 index,util,used,total → 逐卡列表；空/坏输出 → null（不猜测）；D11-2 温度/功耗纯增（[N/A]/缺席 → null）", async () => {
    const { parseNvidiaSmiAll } = await import("../../src/webui/readOnlyTools.js");
    // 旧四列输出（无温度/功耗列）→ 新键 null 化（向后兼容，不猜）
    const cards = parseNvidiaSmiAll("0, 0, 0, 81920\n1, 12, 8429, 81920\n");
    expect(cards).toEqual([
      { index: "0", utilization: "0%", memoryUsed: "0MiB", memoryTotal: "81920MiB", temperature: null, powerDraw: null },
      { index: "1", utilization: "12%", memoryUsed: "8429MiB", memoryTotal: "81920MiB", temperature: null, powerDraw: null },
    ]);
    expect(parseNvidiaSmiAll("")).toBeNull();
    expect(parseNvidiaSmiAll("not,enough,cells")).toBeNull();
    // D11-2 六列：数值直通；[N/A]/空/非数值 → null（不填 0）；旧四字段零改
    const six = parseNvidiaSmiAll("0, 82, 48128, 81920, 71, 310.5\n1, 0, 8192, 81920, [N/A], [N/A]\n2, 3, 4, 81920, , watts\n");
    expect(six).toEqual([
      { index: "0", utilization: "82%", memoryUsed: "48128MiB", memoryTotal: "81920MiB", temperature: 71, powerDraw: 310.5 },
      { index: "1", utilization: "0%", memoryUsed: "8192MiB", memoryTotal: "81920MiB", temperature: null, powerDraw: null },
      { index: "2", utilization: "3%", memoryUsed: "4MiB", memoryTotal: "81920MiB", temperature: null, powerDraw: null },
    ]);
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
  it("D11-2 去重钉：client 本地 GPU 格式副本退役（聚合/绑卡语义单源 snapshot.js）＋新面板绑卡 raw 面", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    // D11-2 面板重写后 client 不再显示聚合串/绑卡注记——本地副本（formatGpuAllLocal/
    // formatGpuBindingLocal）退役＝单源反转（语义只存 snapshot.js，vitest 直测那份）；
    // dock GPU 一行卡与环境卡 GPU 行随去重删除（「无训练进行中」/「GPU：」渲染面清零）
    for (const gone of ["formatGpuAllLocal", "formatGpuBindingLocal", "无训练进行中", "'GPU：' + gpuRow"]) {
      expect(clientSource).not.toContain(gone);
    }
    // 绑卡 raw 面仍在上（GPU 区头「绑 <卡号>」——gpu_binding.devices 直显）
    expect(clientSource).toContain("gpu_binding");
    expect(clientSource).toContain("绑 ' + bindingDevices");
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
    expect(RUN_MARKER_RELS.length).toBe(7); // 批㊶-O 补：launch/launch_manifest.json 路径锚；D3/D4：stage-register.summary.json 收录锚
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
    // 真桶：ci_smoke 工作区内的分桶 run（rev2 裁决授权夹具充实：补段事实身份锚
    // webui/segments.json——孤立 launch_manifest.json 单标记在收紧判据下不再是
    // 合格 run 子目录证据，ci_smoke 容器会被误分 unregistered_entry）
    const bucketed = join(root, "ci_smoke", "cr_r3", "launch");
    mkdirSync(bucketed, { recursive: true });
    mkdirSync(join(root, "ci_smoke", "cr_r3", "webui"), { recursive: true });
    writeFileSync(join(root, "ci_smoke", "cr_r3", "webui", "segments.json"), "{}\n");
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
  it("批C1-1 client.js 钉子：train_notices 并入同一卡栈同一已读键＋终态文案/配色＋评估段实时行", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    // D5：并入同一卡栈（零新组件零新已读键空间）
    expect(clientSource).toContain("(Array.isArray(run.eval_notices) ? run.eval_notices : []).concat(Array.isArray(run.train_notices) ? run.train_notices : [])");
    expect(clientSource.match(/var NOTICE_SEEN_KEY = 'atf_seen_notices'/g)?.length).toBe(1);
    // D5：终态文案（服务端 text 单源＋缺省兜底）与配色
    expect(clientSource).toContain("n.kind === 'training_done' || n.kind === 'training_failed'");
    expect(clientSource).toContain("'训练已结束'");
    expect(clientSource).toContain("'训练未完成退出，可查看训练日志或报告'");
    expect(clientSource).toContain("training_done: 'var(--dsw-static-green-500)', training_failed: 'var(--dsw-static-red-500)'");
    // D6：评估段实时行（phase＋health；health 缺席不显；回退末轮名）
    expect(clientSource).toContain("function evalSegmentDetail(run)");
    expect(clientSource).toContain("ep.health.alive ? '服务运行中' : '服务未运行'");
    expect(clientSource.match(/if \(seg\.key === 'evaluate'\) return evalSegmentDetail\(run\)/g)?.length).toBe(2);
    // C1-1 live 修复钉子：dock 条目 id/order 显式成对在位（D10.3 按 D10.2 归因更正——id 为
    // cell 键是丢弃变量，order 只影响排序；注册实际值零变）
    expect(clientSource).toContain("{ name: 'conversation.composer.dock', id: 'atf-dock-row', order: 100 }");
  });
  it("批C2 D10.1/D10.3 钉子：list 槽缺 id 守卫（listSlotOptions）＋三处 list 注册全带 id/order", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    // 守卫在位：缺 id 的 list 注册 fail-loud 告警（与 vendor register throw 同向——D10.2 归因：
    // id 为 cell 键，缺 id 共享 undefined cell 被选举静默丢；order 只排序，order 守卫已删）
    expect(clientSource).toContain("function listSlotOptions(opts)");
    expect(clientSource).toContain("list 槽注册缺 id（宿主 register 必拒）");
    expect(clientSource).not.toContain("缺 order");
    // 四处 list 注册全部经守卫包裹（header.utilities／composer.dock／input.right／settings.section
    // ——D11-1 新增第四处：训练配置页 settings.section 注册）
    expect(clientSource.match(/slots\.register\(listSlotOptions\(/g)?.length).toBe(4);
    // 逐处字段完备：id＋order 成对在位（显式注册事实字段——现状仍全带）
    for (const id of ["atf-monitor-pill", "atf-dock-row", "atf-effort-select", "atf-training-config"]) {
      const at = clientSource.indexOf(`id: '${id}'`);
      expect(at).toBeGreaterThan(0);
      const window = clientSource.slice(Math.max(0, at - 200), at + 200);
      expect(window.match(/order: \d+/) !== null, `${id} 注册须带 order`).toBe(true);
    }
  });
  it("批D10.3 反向：缺 id 注册仍触发「缺 id」告警且透传不阻断（守卫存活）", () => {
    const clientSource = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
    const m = clientSource.match(/function listSlotOptions\(opts\) \{[\s\S]*?return opts[\s\S]*?\}/);
    expect(m).not.toBeNull();
    const errors: string[] = [];
    // eslint-disable-next-line no-new-func -- 测试内提取 client.js 守卫函数源码直调（vm 隔离同款）
    const listSlotOptions = new Function("console", `${m![0]}; return listSlotOptions;`)({
      error: (msg: unknown) => errors.push(String(msg)),
    }) as (opts: Record<string, unknown>) => Record<string, unknown>;
    const opts = listSlotOptions({ name: "conversation.composer.dock" });
    expect(errors.some((e) => e.includes("缺 id"))).toBe(true);
    expect(errors.some((e) => e.includes("缺 order"))).toBe(false);
    expect(opts["name"]).toBe("conversation.composer.dock"); // 透传不阻断注册
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
    // 两调用点（浮卡自展开＋浮卡 store 展开）全走组件边界——D11-2 面板重写后监控面板内联
    // 日志区（atf-m-logs）替代该组件第三调用点
    expect(clientSource.match(/React\.createElement\(TrainlogTailSection, \{ run: run \}\)/g)?.length).toBe(2);
    // 直调形态清零（防回归）
    expect(clientSource).not.toMatch(/[^']TrainlogTailSection\(run\)/);
    expect(clientSource).toContain("function TrainlogTailSection(props)");
  });
});

describe("批甲-BUILD T1——思考档位快切（client.js 源面锚——浏览器渲染走 DSH 真跑）", () => {
  const clientSource = () => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");

  it("挂载面：conversation.input.right 槽（输入框右下角·与模型选择并排）＋modelDirectories 共享面＋既有 selectModel RPC（零新桥方法）", () => {
    const src = clientSource();
    expect(src).toContain("ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session']");
    expect(src).toContain("scope.slots.inject('conversation.input.right'");
    expect(src).toContain("id: 'atf-effort-select'");
    // 数据/提交面＝共享 ModelDirectory（与原生模型选择同状态同 RPC——下 turn 生效由宿主承载）
    expect(src).toContain("models.directoryFor(sessionId)");
    expect(src).toContain("directory.select(selection)");
    // inject 工厂 fail-open（空 face＝控件隐藏——契约面要求对象：null 会炸原生 bindInjectSources）
    expect(src).toContain("} catch (e) {\n                  return {}\n                }");
  });

  it("UI 闭集恰四值：Off(关)/Low(低)/High(高)/Max(最高)——用户可见面零开发叙事", () => {
    const src = clientSource();
    const block = /var EFFORT_CLOSED = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
    expect(block).toContain("{ id: 'off', label: 'Off(关)' }");
    expect(block).toContain("{ id: 'low', label: 'Low(低)' }");
    expect(block).toContain("{ id: 'high', label: 'High(高)' }");
    expect(block).toContain("{ id: 'max', label: 'Max(最高)' }");
    // 闭集与目录交集呈现（目录超集档位不进控件；efforts 空＝整体隐藏）
    expect(src).toContain("offered.length === 0) return null");
    expect(src).toContain("reasoning.efforts[li].id === candidate.id");
  });

  it("组件边界＋当前档位常显＋拒绝路径如实显示（错误码＋原因在卡内；不静默不降档）", () => {
    const src = clientSource();
    // 组件边界：slot 渲染 createElement 实例化（#310 教训），直调形态清零
    expect(src).toContain("React.createElement(EffortSelect, injected)");
    expect(src).not.toMatch(/[^.]EffortSelect\(injected\)/);
    // 空 face 安全：hooks 判空后置（store 缺席不炸 useSyncExternalStore）
    expect(src).toContain("directory ? directory.subscribe(fn) : function() {}");
    expect(src).toContain("if (state === null || state === undefined) return null");
    // 常显：触发钮＝「思考」＋当前档位值（批甲-FIX T2.2 去「默认」态——链值常显）
    expect(src).toContain("React.createElement('span', { className: 'atf-effort-k' }, '思考')");
    expect(src).not.toContain("'默认'");
    // 拒绝如实显示：RemoteResult 错误码＋原因原样呈现，菜单不关（错误条持续可见）
    expect(src).toContain("result.ok === false");
    expect(src).toContain("result.error.code");
    expect(src).toContain("result.error.message");
    expect(src).toContain("'切换被拒绝：' + error");
    expect(src).toContain("role: 'alert'");
  });
});

describe("批甲-FIX——思考档位按模型能力修正（client.js 源面锚——浏览器渲染走 DSH 真跑）", () => {
  const clientSource = () => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");

  it("T1 配套（UI 面）：闭集顺位单源 EFFORT_ORDER 与 EFFORT_CLOSED 同序（最近档距离的度量域——不造档位）", () => {
    const src = clientSource();
    expect(src).toContain("var EFFORT_ORDER = ['off', 'low', 'high', 'max']");
  });

  it("T2.2 去「默认」态：三段取值链（会话最近切换 → 用户 per-model 默认档 ∩目录闭集 → 目录声明序首位）", () => {
    const src = clientSource();
    // 链①：会话显式档位优先
    expect(src).toContain("var chainEffort = (reasoning && state.current && state.current.reasoningEffort !== undefined)\n        ? state.current.reasoningEffort\n        : chainFallbackEffort(choice, offered)");
    // 链②：用户默认档（effort_defaults）∩目录闭集——不造档位（交集过滤）
    expect(src).toContain("var ud = userDefaultEffortOf(choice.model)");
    expect(src).toContain("if (offered[i].id === ud) return ud");
    // 链③：目录 efforts 顺位最低档＝声明序首位（GLM-5.3→Off；Flash 系→Low）
    expect(src).toContain("return offered.length > 0 ? offered[0].id : undefined");
    // 链值固化（ensure）：无显式档位时程序化补选——显示值＝真实送出值（「默认」悬空态消除）
    expect(src).toContain("function ensureChainEffort(injected, state, choice, offered, refs)");
    expect(src).toContain("if (state.current !== null && state.current !== undefined && state.current.reasoningEffort !== undefined) return");
    expect(src).toContain("refs.ensured === key");
    expect(src).toContain("reasoningEffort: want");
  });

  it("T2.3 会话内模型切换档位取值：保持/回退（切换落地未带档位）＋越界补偿（提交被拒）＋防环＋sticky 零新机制", () => {
    const src = clientSource();
    // 统一同步器（三分支：①补偿 ②保持/回退 ③ensure）
    expect(src).toContain("function syncEffortSelection(injected, state, choice, offered, refs)");
    // ② 保持/回退：模型切换落地且选择未携带档位（vendor 两条切换路径均不携带旧档位）——
    //    目标支持前档则保持，不支持落闭集顺位最近档（不静默跳 max）
    expect(src).toContain("if (prev !== null && prev.model !== cur.model && cur.reasoningEffort === undefined)");
    expect(src).toContain("var want2 = ids2.indexOf(kept) >= 0 ? kept : nearestEffort(kept, ids2)");
    // ① 补偿：跨模型越界档提交被拒才补选；同模型拒绝＝用户选择本身被拒（如实显示不补偿）
    expect(src).toContain("if (target.provider === cur.provider && target.model === cur.model) return");
    // 最近档＝闭集顺位差最小者（度量域＝EFFORT_ORDER 声明序）
    expect(src).toContain("var d = Math.abs(fromIdx - EFFORT_ORDER.indexOf(ids[i]))");
    expect(src).toContain("if (d < best) { best = d; want = ids[i] }");
    // 防环：同目标（provider/model/档位）只补一次；会话上下文切换（directory 身份）＝prev 作废不跨会话「保持」
    expect(src).toContain("refs.compensated = key");
    expect(src).toContain("if (refs.directory !== injected.directory)");
    // 跨会话 sticky＝宿主既有语义（selectModel→agentDefaultModel.saveSelection）——零新机制
    expect(src).toContain("agentDefaultModel.saveSelection");
  });

  it("T2.1 设置页 per-model 默认档座位：provider-card keyed 槽（key＝llm-pi-ai）＋effort_defaults 单源读写", () => {
    const src = clientSource();
    // 座位：keyed 槽注册（产品层——vendor 零写入；组件 createElement 实例化——#310 钉子）
    expect(src).toContain("scope.slots.inject('settings.models.provider-card'");
    expect(src).toContain("key: 'llm-pi-ai'");
    expect(src).toContain("React.createElement(ProviderModelDefaultsBody, props)");
    // 数据面：/atf-ui/settings effort_defaults 块（GET 读＋POST 写——与 composer 链②同源）
    expect(src).toContain("function loadEffortDefaults(force)");
    expect(src).toContain("typeof d.effort_defaults === 'object'");
    expect(src).toContain("JSON.stringify({ effort_defaults: nextMap })");
    // 下拉选项＝该模型目录 efforts 闭集（交集过滤——不造档位）；非 glm-atf 卡不渲染
    expect(src).toContain("if (entry === null || entry === undefined || entry.provider !== 'glm-atf') return null");
    expect(src).toContain("efforts[li].id === EFFORT_CLOSED[ci].id");
    // 链中段预取（composer 首帧链值就位）
    expect(src).toContain("loadEffortDefaults()\n");
  });
});

describe("批甲-FIX2——档位入口单一化（产品层覆写 vendor 座位 effort 面·vendor 源码零写入）", () => {
  const clientSource = () => readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");

  it("座位 effort span CSS 隐藏（css-modules 语义段子串选择器——构建哈希免疫）＋菜单 drill cell 双语词条闭集", () => {
    const src = clientSource();
    expect(src).toContain('[class*="triggerEffort"]{display:none!important;}');
    // 双语词条闭集（en 'Effort'／zh '推理等级'——vendor ui-model-selection locales 同源）
    expect(src).toContain("var labels = ['Effort', '推理等级']");
    // 仅值变化才写回（防 observer 自激）
    expect(src).toContain("if (title && title.indexOf(' · ') >= 0)");
  });

  it("MutationObserver sweep 在场（React 重渲随附）＋档位唯一入口声明（思考控件）", () => {
    const src = clientSource();
    expect(src).toContain("new MutationObserver(atfFix2Schedule).observe(document.documentElement");
    expect(src).toContain("批甲-FIX2（档位入口单一化）：vendor 座位/菜单 effort 面 JS 覆写（vendor 源码零写入）");
    expect(src).toContain("档位唯一入口＝「思考」控件；FIX 既有交付");
  });
});
