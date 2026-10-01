/** 批⑳ 测试锚——atf-ui 服务端同步器纯函数（snapshot.js 八段四态推导）。
 *  client.js 浏览器组件的渲染验证走 DSH 真跑（浏览器环境），不在 vitest 覆盖范围。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMonitorSnapshot, buildArtifactsSnapshot, QUEUE_IDLE_TEXT, SEGMENTS } from "../../packages/extensions/atf-ui/src/snapshot.js";

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
};

describe("快照构造纯函数（八段四态推导＋loss 曲线＋KPI＋空态文案单源）", () => {
  it("buildMonitorSnapshot：八段逐卡 status 推导", () => {
    const snap = buildMonitorSnapshot([sampleRun]);
    expect(snap.runs[0]?.segments.map((s) => s.key)).toEqual(SEGMENTS.map((s) => s.key));
    expect(snap.runs[0]?.segments.filter((s) => s.status === "done").map((s) => s.key)).toEqual(["register", "split"]);
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
});

describe("atf-ui 同步器落盘（scan→monitor/artifacts/panel）", () => {
  it("scan+写盘：临时 runsRoot 造 run 结构 → 三 JSON 落盘且段状态正确", async () => {
    const root = tempRoot();
    const runDir = join(root, "run-sync");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    writeFileSync(join(runDir, "session.jsonl"), "{}\n");
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
    const panelHtml = readFileSync(join(root, "atf-ui", "panel.html"), "utf8");
    expect(panelHtml).toContain("AtfMonitor/v1");
    expect(panelHtml).toContain("排队中");
    for (const d of effects) d();
  });
});
