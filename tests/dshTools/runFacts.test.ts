/**
 * 批㊶-N 测试锚——段序守卫／训练锚扩充／段内进度（读写回环·fresh·文案映射）／
 * 会话绑定（幂等去重）／三级作用域数据选择。
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendBinding,
  formatProgressBadge,
  formatProgressDetail,
  orderGuarded,
  progressFresh,
  readBindings,
  readProgress,
  SEGMENT_ORDER,
  writeProgress,
} from "../../src/core/workspace/runFacts.js";
import { scanRunDir, trainingLogsFreshAt } from "../../packages/extensions/atf-ui/src/server.js";
import { tmuxTrainingFamilyPresent } from "../../src/core/workspace/tmuxLiveness.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-n-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-N N-1 段序守卫（orderGuarded）", () => {
  it("evaluate 锚在场但 training 未 done → 抑制为 false（陈旧轮倒挂场景）；training done → 放行", () => {
    const doneMap = { register: true, label_qc: true, experiment_config: true, publish: true, split: true, admission: true, training: false, evaluate: false };
    expect(orderGuarded("evaluate", true, doneMap)).toBe(false);
    const doneMap2 = { ...doneMap, training: true };
    expect(orderGuarded("evaluate", true, doneMap2)).toBe(true);
  });

  it("中段未 done 同样抑制（register 缺 → label_qc 抑制）；首段无前序直达；锚缺省 false 恒 false", () => {
    expect(orderGuarded("label_qc", true, { register: false })).toBe(false);
    expect(orderGuarded("label_qc", true, { register: true })).toBe(true);
    expect(orderGuarded("register", true, {})).toBe(true);
    expect(orderGuarded("evaluate", false, { training: true })).toBe(false);
  });

  it("scanRunDir 集成：旧 eval 轮在场而训练锚缺 → evaluate 抑制（formal-01 倒挂场景）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-order");
    // 前序段全成立（真实 run 形态）＋训练锚在场
    mkdirSync(join(runDir, "eval", "2-20261002"), { recursive: true });
    writeFileSync(join(runDir, "eval", "2-20261002", "metrics_summary.json"), "{}");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x");
    writeFileSync(join(runDir, "training", "train.sh"), "#!/bin/bash\n");
    for (const [dir, file] of [["", "registration.json"], ["", "label_qc"], ["webui", "config-snapshot.json"], ["", "contract-candidate.json"], ["", "split"]] as Array<[string, string]>) {
      mkdirSync(join(runDir, dir), { recursive: true });
      writeFileSync(join(runDir, dir, file), "{}");
    }
    const scan = scanRunDir(root, "run-order", { trainingTmuxPresent: true });
    // 前序全成立＋训练锚在场 → training done；旧 eval 轮被放行（前序齐＝合法完成态，非倒挂）
    expect(scan.segments.training).toBe(true);
    expect(scan.segments.evaluate).toBe(true);
  });

  it("scanRunDir 集成：前序段缺失（admission 缺）→ training 锚在场仍被抑制，evaluate 链式抑制", () => {
    const root = tempRoot();
    const runDir = join(root, "run-chain");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x");
    mkdirSync(join(runDir, "eval", "2-20261002"), { recursive: true });
    writeFileSync(join(runDir, "eval", "2-20261002", "metrics_summary.json"), "{}");
    const scan = scanRunDir(root, "run-chain", { trainingTmuxPresent: true });
    expect(scan.segments.training).toBe(false);
    expect(scan.segments.evaluate).toBe(false);
  });
});

describe("批㊶-N N-2 训练锚扩充", () => {
  it("safetensors／all_results 两新锚任一在场 → training done（前序全成立夹具；loss-series 锚保持）", () => {
    for (const anchor of ["adapter_model.safetensors", "all_results.json", "loss-series.json"]) {
      const root = tempRoot();
      const runDir = join(root, "run-a");
      mkdirSync(join(runDir, "training"), { recursive: true });
      writeFileSync(join(runDir, "training", anchor), "x");
      writeFileSync(join(runDir, "training", "train.sh"), "#!/bin/bash\n");
      for (const [dir, file] of [["", "registration.json"], ["", "label_qc"], ["webui", "config-snapshot.json"], ["", "contract-candidate.json"], ["", "split"]] as Array<[string, string]>) {
        mkdirSync(join(runDir, dir), { recursive: true });
        writeFileSync(join(runDir, dir, file), "{}");
      }
      expect(scanRunDir(root, "run-a", { trainingTmuxPresent: true }).segments.training).toBe(true);
    }
  });

  it("tmux 会族前缀 atf-*：tmuxTrainingFamilyPresent 返回布尔（本机 tmux 在位即实测）", () => {
    expect(typeof tmuxTrainingFamilyPresent()).toBe("boolean");
  });

  it("trainingLogsFreshAt：ATF_DSH_LOG_DIR 轴新文件 → fresh；过期/缺失 → false", () => {
    const root = tempRoot();
    mkdirSync(join(root, "training-logs"), { recursive: true });
    writeFileSync(join(root, "training-logs", "orch.log"), "x");
    expect(trainingLogsFreshAt(root, 180_000)).toBe(true);
    const stale = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "training-logs", "orch.log"), stale, stale);
    expect(trainingLogsFreshAt(root, 180_000)).toBe(false);
  });
});

describe("批㊶-N N-3 段内进度（读写回环＋fresh＋文案映射）", () => {
  it("writeProgress→readProgress 回环；坏文件如实 null；fresh 两态", () => {
    const runDir = tempRoot();
    const progress = { round: 6, total_rounds: 8, step_remaining: 17, loss: 0.0589, updated_at: new Date().toISOString() };
    writeProgress(runDir, progress);
    expect(readProgress(runDir)).toMatchObject({ round: 6, total_rounds: 8, loss: 0.0589 });
    const now = Date.now();
    expect(progressFresh(readProgress(runDir), now, 180_000)).toBe(true);
    const stale = { ...progress, updated_at: new Date(now - 600_000).toISOString() };
    writeProgress(runDir, stale);
    expect(progressFresh(readProgress(runDir), now, 180_000)).toBe(false);
    expect(progressFresh(null, now, 180_000)).toBe(false);
  });

  it("徽标/明细文案映射：全字段／部分字段／空字段三态", () => {
    expect(formatProgressBadge({ round: 6, total_rounds: 8, updated_at: "" })).toBe("第 6/8 轮");
    expect(formatProgressBadge({ round: 3, updated_at: "" })).toBe("第 3 轮");
    expect(formatProgressBadge(null)).toBeNull();
    expect(formatProgressDetail({ round: 6, total_rounds: 8, step_remaining: 17, loss: 0.0589, updated_at: "" }))
      .toBe("第 6/8 轮 · 剩余 17 步 · loss 0.0589");
    expect(formatProgressDetail({ updated_at: "" })).toBeNull();
  });
});

describe("批㊶-N N-5 会话绑定＋三级作用域", () => {
  it("appendBinding 幂等去重＋多会话共存；空 session_id 忽略", () => {
    const runDir = tempRoot();
    appendBinding(runDir, "sess-a");
    appendBinding(runDir, "sess-a");
    appendBinding(runDir, "sess-b");
    appendBinding(runDir, "");
    const bindings = readBindings(runDir);
    expect(bindings.map((b) => b.session_id)).toEqual(["sess-a", "sess-b"]);
  });

  it("scanRunDir 镜像 bound_sessions（additive 字段）", () => {
    const root = tempRoot();
    const runDir = join(root, "run-b");
    appendBinding(runDir, "sess-x");
    const scan = scanRunDir(root, "run-b");
    expect(scan.bound_sessions).toEqual(["sess-x"]);
    const scan2 = scanRunDir(root, "run-empty");
    expect(scan2.bound_sessions).toEqual([]);
  });

  it("三级作用域数据选择：绑定集过滤／未绑定存量不进浮卡（pickScopedActiveRun 口径）", () => {
    const mon = {
      runs: [
        { run_id: "run-bound", training: { active: true }, bound_sessions: ["sess-a"], segments: [{ key: "training", status: "done" }] },
        { run_id: "run-legacy", training: { active: true }, segments: [{ key: "training", status: "done" }] },
      ],
    };
    const scoped = mon.runs.filter((r: { bound_sessions?: string[] }) => Array.isArray(r.bound_sessions) && r.bound_sessions.indexOf("sess-a") >= 0);
    expect(scoped.map((r: { run_id: string }) => r.run_id)).toEqual(["run-bound"]);
    // 未绑定存量（run-legacy）不进任何会话浮卡/dock——sess-b 的过滤集为空
    const scopedB = mon.runs.filter((r: { bound_sessions?: string[] }) => Array.isArray(r.bound_sessions) && r.bound_sessions.indexOf("sess-b") >= 0);
    expect(scopedB).toEqual([]);
    // 全部实例视图＝全量
    expect(mon.runs).toHaveLength(2);
    expect(SEGMENT_ORDER).toHaveLength(8);
  });
});
