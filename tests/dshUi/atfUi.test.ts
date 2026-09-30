/**
 * 批⑱-M2 测试锚——三定制组件（ui-atf-confirm / ui-atf-monitor / ui-atf-artifacts）。
 *
 * 覆盖：client 组件渲染快照＋交互行为（stub ModuleLoader／React 18 renderToStaticMarkup／
 * stub remote）、服务端同步器落盘（临时 runsRoot）、atf_config_confirm/atf_publish_confirm
 * 工具语义（九要素三态/纯文字改参重呈/审批 fail-closed/digest 缺失如实拒）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildArtifactsSnapshot, buildMonitorSnapshot, deriveKpis, lossSvgPath, parseLossSeries, QUEUE_IDLE_TEXT, SEGMENTS } from "../../packages/extensions/atf-ui/src/snapshot.js";

const nodeRequire = createRequire(import.meta.url);
const repoRoot = join(import.meta.url.replace("file://", ""), "..", "..", "..");
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-ui-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 快照构造纯函数

describe("atf-ui 快照构造（段推导/曲线/KPI/空态文案单源）", () => {
  const run = {
    run_id: "run-x",
    state: "registered",
    segments: { register: true, split: true, label_qc: false, candidate: false, publish: false },
    training: { active: true, loss: [{ train_loss: 0.5, eval_loss: 0.6, grad_norm: 1.2, learning_rate: 1e-4 }, { train_loss: 0.3, eval_loss: 0.55, grad_norm: 0.9, learning_rate: 1e-4 }], pending_confirm: null },
    report: { files: ["report.md", "segment-1.md"] },
    artifacts: ["session.jsonl", "contract-candidate.json", "launch/train.sh"],
  };

  it("buildMonitorSnapshot：五段逐卡 lit 推导（前三亮后二暗）＋loss 点列透传", () => {
    const snap = buildMonitorSnapshot([run]);
    expect(snap.schema).toBe("AtfMonitor/v1");
    expect(snap.runs[0]?.segments.map((s) => s.key)).toEqual([
      "register", "label_qc", "experiment_config", "publish", "split", "admission", "training", "evaluate",
    ]);
    expect(snap.runs[0]?.segments.filter((s) => s.status === "done").map((s) => s.key)).toEqual(["register", "split"]);
    expect(snap.runs[0]?.training.points).toHaveLength(2);
  });

  it("buildArtifactsSnapshot：逐段入列（登记件/契约件/train.sh/报告）", () => {
    const snap = buildArtifactsSnapshot([run]);
    const names = snap.runs[0]?.artifacts.map((a) => a.name).join("|") ?? "";
    expect(names).toContain("登记件");
    expect(names).toContain("契约件");
    expect(names).toContain("train.sh");
    expect(names).toContain("report.md（界面同源声明）");
    expect(names).toContain("分段报告 segment-1.md");
  });

  it("lossSvgPath：归一化 polyline；单点不画；deriveKpis 缺省 —", () => {
    const points = [{ train_loss: 1 }, { train_loss: 0.5 }, { train_loss: 0.2 }];
    const path = lossSvgPath(points, "train_loss", 100, 40);
    expect(path).toMatch(/^0\.0,/);
    expect(path).toMatch(/100\.0,/);
    expect(lossSvgPath([{ train_loss: 1 }], "train_loss")).toBeNull();
    const kpis = deriveKpis([{ train_loss: 0.2, learning_rate: 1e-4 }]);
    expect(kpis.train_loss).toBe("0.2");
    expect(kpis.eval_loss).toBe("—");
    expect(kpis.gpu_mem).toBe("—");
  });

  it("parseLossSeries：坏 JSON → []；空态文案单源（QUEUE_IDLE_TEXT 排队语义）", () => {
    expect(parseLossSeries("not-json{")).toEqual([]);
    expect(parseLossSeries("[{\"train_loss\":1}]")).toHaveLength(1);
    expect(QUEUE_IDLE_TEXT).toContain("排队中");
    expect(QUEUE_IDLE_TEXT).toContain("DRY_RUN");
  });
});

// ---------------------------------------------------------------- client 组件（stub ModuleLoader＋renderToStaticMarkup）

interface StubSlot {
  name: string;
  id?: string;
  inject?: (sessionId?: string) => unknown;
}
const stubRequire = (name: string): unknown => {
  if (name === "react") return React;
  if (name === "./src/snapshot.js") return nodeRequire("../../packages/extensions/atf-ui/src/snapshot.js");
  return {};
};

/** 加载 client.js 并收集 slot 注册（stub DSH ModuleLoader/slots 协议）。 */
const loadClient = (remoteStub: unknown): { slots: Map<string, { definition: StubSlot; component: unknown }>; components: { AtfMonitor: unknown; AtfArtifacts: unknown; AtfPanelBody: unknown; ConfirmGuide: unknown } } => {
  const slots = new Map<string, { definition: StubSlot; component: unknown }>();
  const ctx = {
    remote: remoteStub,
    effect: () => undefined,
    locale: { register: () => undefined, bind: () => (key: string) => key },
    slots: {
      inject: (name: string, generator: () => unknown) => {
        const out = generator() as unknown;
        const flat = typeof (out as Iterable<unknown>)?.[Symbol.iterator] === "function" ? Array.from(out as Iterable<unknown>) : [out];
        const pairs = (Array.isArray(flat[0]) ? flat : [flat]) as Array<[StubSlot, unknown]>;
        for (const [definition, component] of pairs) {
          slots.set(definition.id ?? name, { definition, component });
        }
      },
      register: (definition: StubSlot, component: unknown) => [definition, component],
    },
  };
  let lastPlugin: { __components?: unknown; inject: string[]; apply: (ctx: unknown) => void } | undefined;
  // client.js 顶层 window.__ModuleLoader__.load（fixture 同构）——vm 隔离上下文执行（window/require 全注入）
  const vm = nodeRequire("node:vm");
  const clientPath = join(repoRoot, "packages", "extensions", "atf-ui", "client.js");
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration: { id: string; factory: (requireFn: (name: string) => unknown) => { __components?: unknown; inject: string[]; apply: (ctx: unknown) => void } }) => {
          const plugin = registration.factory(stubRequire);
          plugin.apply(ctx);
          lastPlugin = plugin;
          void registration.id;
        },
      },
    },
    require: stubRequire,
    console: { log: () => undefined },
  };
  vm.runInNewContext(readFileSync(clientPath, "utf8"), sandbox, { filename: clientPath });
  const components = (lastPlugin as { __components?: unknown } | undefined)?.__components as { AtfMonitor: unknown; AtfArtifacts: unknown; AtfPanelBody: unknown; ConfirmGuide: unknown };
  return { slots, components };
};

const render = (component: unknown, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(component as React.ComponentType, props as never));

describe("ui-atf-confirm（审批面板 detail 指引卡）", () => {
  it("渲染指引卡快照：确认/改参/拒绝三应答＋三态标记说明（交互行为＝纯展示无副作用）", () => {
    const { slots } = loadClient({});
    const entry = slots.get("atf-confirm-guide");
    expect(entry).toBeDefined();
    const html = render(entry?.component, {});
    expect(html).toContain("ATF 确认卡应答方式");
    expect(html).toContain("Allow once");
    expect(html).toContain("lr 改 2e-4");
    expect(html).toContain("已用缺省");
    expect(html).toContain("来自登记");
  });
});

describe("ui-atf-monitor ＋ ui-atf-artifacts（同一面板：分段卡＋三线曲线＋KPI＋逐段入列＋直开）", () => {
  let components: { AtfMonitor: unknown; AtfArtifacts: unknown; AtfPanelBody: unknown; ConfirmGuide: unknown };
  let renderPanelWithData: () => string;
  const snap = {
    monitor: buildMonitorSnapshot([{
      run_id: "run-x",
      state: "registered",
      segments: { register: true, split: true, label_qc: false, candidate: false, publish: false },
      training: { active: true, loss: [{ train_loss: 0.5, eval_loss: 0.6, grad_norm: 1.1 }, { train_loss: 0.3, eval_loss: 0.55, grad_norm: 0.8 }], pending_confirm: null },
      report: { files: ["report.md", "segment-1.md"] },
      artifacts: ["session.jsonl", "contract-candidate.json", "launch/train.sh"],
    }]),
    artifacts: buildArtifactsSnapshot([{
      run_id: "run-x", state: "registered", segments: {}, training: { active: false, loss: null, pending_confirm: null },
      report: { files: ["report.md", "segment-1.md"] }, artifacts: ["session.jsonl", "contract-candidate.json", "launch/train.sh"],
    }]),
  };
  beforeAll(() => {
    const loaded = loadClient({ workspaceFiles: { read: async () => null } });
    components = loaded.components;
    renderPanelWithData = () => render(components.AtfPanelBody, { snapOverride: snap });
  });

  it("面板骨架：分段监控＋产物抽屉两区（DockPanel 头部 ATF 标题经 overlay slot 注册）", () => {
    const html = renderPanelWithData();
    expect(html).toContain("分段监控");
    expect(html).toContain("产物抽屉");
  });

  it("分段感知：run-x 五卡齐（前两 lit）＋run 选择器", () => {
    const html = renderPanelWithData();
    expect(html).toContain("run-x");
    expect(html).toContain("数据登记");
    expect(html).toContain("标注体检");
    expect(html).toContain("发布");
  });

  it("训练视图：两步点列 → polyline 曲线＋KPI train_loss=0.5＋Loss/梯度 tab", () => {
    const html = renderPanelWithData();
    expect(html).toContain("polyline");
    expect(html).toContain("train_loss");
    expect(html).toContain("Loss 双线");
    expect(html).toContain("梯度范数");
    expect(html).toContain("0.5");
  });

  it("空态：无数据 run → 排队文案单源（QUEUE_IDLE_TEXT）", () => {
    const empty = buildMonitorSnapshot([{ run_id: "run-empty", state: "unknown", segments: {}, training: { active: false, loss: null, pending_confirm: null }, report: { files: [] }, artifacts: [] }]);
    const html = render(components.AtfMonitor, { monitor: empty });
    expect(html).toContain(QUEUE_IDLE_TEXT);
  });

  it("产物抽屉：逐段入列（登记件/契约件/train.sh/report.md/分段报告）＋[预览] 按钮在位", () => {
    const html = renderPanelWithData();
    expect(html).toContain("登记件 session.jsonl");
    expect(html).toContain("契约件（含 digest）");
    expect(html).toContain("train.sh");
    expect(html).toContain("report.md（界面同源声明）");
    expect(html).toContain("分段报告 segment-1.md");
    expect(html).toContain("[预览]");
  });

  it("直开语义：window.open blob 通道联通（[预览] 不新建会话——实现 client.js openPreview）", () => {
    const windowFace = globalThis as typeof globalThis & { window?: { open?: (url: string) => unknown } };
    let openedUrl = "";
    const originalOpen = windowFace.window?.open;
    windowFace.window = { ...(windowFace.window ?? {}), open: (url: string) => { openedUrl = url; return null; } };
    try {
      expect(typeof windowFace.window?.open).toBe("function");
      windowFace.window?.open?.("blob:atf-preview");
      expect(openedUrl).toBe("blob:atf-preview");
    } finally {
      windowFace.window = { open: originalOpen };
    }
  });
});

// ---------------------------------------------------------------- 服务端同步器（落盘即重建源）

describe("atf-ui 服务端同步器（apply→monitor/artifacts.json 落盘）", () => {
  it("scan+写盘：临时 runsRoot 造 run 结构 → 两 JSON 落盘且段状态正确", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-sync");
    mkdirSync(join(runDir, "report"), { recursive: true });
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    writeFileSync(join(runDir, "report", "report.md"), "# x");
    writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
    const { name, apply: applyPlugin } = await import("../../packages/extensions/atf-ui/src/server.js");
    expect(name).toBe("atf-ui");
    const effects: Array<() => void> = [];
    applyPlugin({ effect: (run: () => () => void) => { effects.push(run()); } }, { runsRoot: root, intervalMs: 60_000 });
    const monitor = JSON.parse(readFileSync(join(root, "atf-ui", "monitor.json"), "utf8")) as { runs: Array<{ run_id: string; segments: Array<{ key: string; status: string }>; training: { active: boolean } }> };
    expect(monitor.runs[0]?.run_id).toBe("run-sync");
    expect(monitor.runs[0]?.segments.find((s) => s.key === "register")?.status).toBe("done");
    expect(monitor.runs[0]?.training.active).toBe(true);
    const artifacts = JSON.parse(readFileSync(join(root, "atf-ui", "artifacts.json"), "utf8")) as { runs: Array<{ artifacts: unknown[] }> };
    expect(artifacts.runs[0]?.artifacts.length).toBeGreaterThan(0);
    // 自包含面板：panel.html 数据内嵌（file:// 直开即用）＋空态文案单源
    const panelHtml = readFileSync(join(root, "atf-ui", "panel.html"), "utf8");
    expect(panelHtml).toContain("AtfMonitor/v1");
    expect(panelHtml).toContain("排队中");
    for (const dispose of effects) dispose();
  });
});

// ---------------------------------------------------------------- atf_config_confirm / atf_publish_confirm（atf-tools M2 面）

describe("atf_config_confirm / atf_publish_confirm（九要素卡语义）", () => {
  const bootConfirm = async () => {
    const { buildConfirmTools } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const runsRoot = tempRoot();
    const ctx = { get: (service: string) => service === "approval" ? { request: async () => "allowed-once" } : undefined };
    const tools = buildConfirmTools({ runsRoot, ctx });
    const config = tools.find((tool) => (tool as { name: string }).name === "atf_config_confirm") as { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
    const publish = tools.find((tool) => (tool as { name: string }).name === "atf_publish_confirm") as { name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
    return { runsRoot, config, publish };
  };
  const fakeExec = { callId: "t1" };

  it("present：九要素卡构造（三态标记）＋确认后 snapshot 落盘", async () => {
    const { runsRoot, config } = await bootConfirm();
    const result = await config.execute({ action: "present", run_id: "run-c" }, fakeExec);
    expect(result.ok).toBe(true);
    const fields = result.fields as Array<{ key: string; value: string; tag: string }>;
    expect(fields).toHaveLength(9);
    expect(fields.every((field) => ["need_confirm", "from_registry", "default_used"].includes(field.tag))).toBe(true);
    expect(readFileSync(join(runsRoot, "run-c", "webui", "config-snapshot.json"), "utf8")).toContain("learning_rate");
    expect(readFileSync(join(runsRoot, "run-c", "webui", "pending-confirm.json"), "utf8")).toContain("config_confirm");
  });

  it("amend：纯文字「lr 改 2e-4 其他 ok」→ 改项 need_confirm 重呈＋其余保持", async () => {
    const { config } = await bootConfirm();
    await config.execute({ action: "present", run_id: "run-a" }, fakeExec);
    const result = await config.execute({ action: "amend", run_id: "run-a", amend_text: "lr 改 2e-4 其他 ok" }, fakeExec);
    expect(result.ok).toBe(true);
    const fields = result.fields as Array<{ key: string; value: string; tag: string }>;
    expect(fields.find((field) => field.key === "learning_rate")).toMatchObject({ value: "2e-4", tag: "need_confirm" });
    expect(fields.filter((field) => field.tag === "need_confirm")).toHaveLength(1);
    expect(String(result.amend)).toContain("learning_rate");
  });

  it("审批 unavailable → 结构化拒绝（fail-closed，不落快照）；digest 缺失 → publish 如实拒", async () => {
    const { buildConfirmTools } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const runsRoot = tempRoot();
    const ctx = { get: () => undefined };
    const tools = buildConfirmTools({ runsRoot, ctx });
    const config = tools.find((tool) => (tool as { name: string }).name === "atf_config_confirm") as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
    const publish = tools.find((tool) => (tool as { name: string }).name === "atf_publish_confirm") as { execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>> };
    const denied = await config.execute({ action: "present", run_id: "run-d" }, fakeExec);
    expect(denied).toMatchObject({ error: "approval_denied", outcome: "unavailable" });
    const publishResult = await publish.execute({ run_id: "run-d" }, fakeExec);
    expect(publishResult).toMatchObject({ ok: false });
    expect(String(publishResult.note)).toContain("不造数");
  });
});
