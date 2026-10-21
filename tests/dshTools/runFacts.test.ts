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
import { probeTrainingEvidence, tmuxTrainingFamilyPresent, TMUX_SESSION_PREFIX_ENV } from "../../src/core/workspace/tmuxLiveness.js";

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

  it("scanRunDir 集成（批㊶-S3 S-B2 语义改版）：收尾段完成产物锚豁免守卫——training/evaluate 无前序也如实 done；启发式段仍受辖", () => {
    // 旧断言（training/evaluate 被链式抑制）锚的是级联抑制缺陷本身——真机 dev/uat 全 run
    // done=0/8 的根因；批㊶-S3 将完成产物锚（adapter/all_results/metrics 轮）定为「出现即事实」
    // 豁免守卫（历史 run 重评形态是真实形态非倒挂错误），守卫只辖启发式锚段。
    const root = tempRoot();
    const runDir = join(root, "run-chain");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x");
    mkdirSync(join(runDir, "eval", "2-20261002"), { recursive: true });
    writeFileSync(join(runDir, "eval", "2-20261002", "metrics_summary.json"), "{}");
    const scan = scanRunDir(root, "run-chain", { trainingTmuxPresent: true });
    expect(scan.segments.training).toBe(true);
    expect(scan.segments.evaluate).toBe(true);
    // owner 裁定（段显示态保序）：done 恒为前缀——收尾段证据反蕴含前段发生（登记必然已发生），
    // register/admission 随前缀点亮，不再出现 ✓○✓○ 间隔态
    expect(scan.segments.register).toBe(true);
    expect(scan.segments.admission).toBe(true);
    // 无 metrics 产物：evaluate 如实 pending（frontier），训练锚已 done
    const scanNoEval = scanRunDir(root, "run-chain", { trainingTmuxPresent: true });
    void scanNoEval;
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
      // 批㊶-S3 S-B2：loss-series fresh＝窗口期内（● 训练中）——done 断言以 nowMs 过窗
      expect(scanRunDir(root, "run-a", { trainingTmuxPresent: true, nowMs: Date.now() + 600_000 }).segments.training).toBe(true);
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

describe("批㊶-O O-1 绑 run 取证（trainingEvidence 映射）", () => {
  const seedFull = (root: string, runId: string): string => {
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), "[]");
    for (const [dir, file] of [["", "registration.json"], ["", "label_qc"], ["webui", "config-snapshot.json"], ["", "contract-candidate.json"], ["", "split"], ["launch", "train.sh"]] as Array<[string, string]>) {
      mkdirSync(join(runDir, dir), { recursive: true });
      writeFileSync(join(runDir, dir, file), "{}");
    }
    return runDir;
  };

  it("①取证匹配本 run → active true", () => {
    const root = tempRoot();
    seedFull(root, "run-mine");
    const scan = scanRunDir(root, "run-mine", { trainingEvidence: { "run-mine": true }, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scan.training.active).toBe(true);
  });

  it("②取证匹配他 run（本 run 无映射）→ active false——泛匹配假阳性根除", () => {
    const root = tempRoot();
    const runDir = seedFull(root, "run-mine");
    // 历史形态：loss-series mtime 陈旧（真实回归场景）
    const staleAt = new Date(Date.now() - 600_000);
    utimesSync(join(runDir, "training", "loss-series.json"), staleAt, staleAt);
    const scan = scanRunDir(root, "run-mine", { trainingEvidence: { "run-other": true }, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scan.training.active).toBe(false);
  });

  it("③无匹配回落 mtime 新鲜窗口单判据：新鲜→true；过期→false", () => {
    const root = tempRoot();
    const runDir = seedFull(root, "run-m3");
    utimesSync(join(runDir, "training", "loss-series.json"), new Date(), new Date());
    const scanFresh = scanRunDir(root, "run-m3", { trainingEvidence: {}, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scanFresh.training.active).toBe(true);
    const staleAt = new Date(Date.now() - 600_000);
    utimesSync(join(runDir, "training", "loss-series.json"), staleAt, staleAt);
    const scanStale = scanRunDir(root, "run-m3", { trainingEvidence: {}, nowMs: Date.now(), freshWindowMs: 180_000 });
    expect(scanStale.training.active).toBe(false);
  });

  it("回归锚：现存 atf-* 会话族在场（取证无本 run 映射）时历史 run active 全 false（批㊶-O 假阳性场景）", () => {
    const root = tempRoot();
    const staleAt = new Date(Date.now() - 600_000);
    for (const runId of ["run-regress-formal-01", "run-regress-formal-02", "run-regress-large-pl"]) {
      const runDir = seedFull(root, runId);
      utimesSync(join(runDir, "training", "loss-series.json"), staleAt, staleAt);
    }
    const liveness = { trainingEvidence: {}, nowMs: Date.now(), freshWindowMs: 180_000 };
    for (const runId of ["run-regress-formal-01", "run-regress-formal-02", "run-regress-large-pl"]) {
      expect(scanRunDir(root, runId, liveness).training.active).toBe(false);
    }
  });
});

describe("D28——training.active 不吃过期 liveness 缓存（definitive 负证据立即翻面）", () => {
  /** 完整锚夹具＋trainer_log/progress 任意 mtime 置位。 */
  const seedAnchored = (root: string, runId: string): string => {
    const runDir = join(root, runId);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "loss-series.json"), "[]");
    for (const [dir, file] of [["", "registration.json"], ["webui", "config-snapshot.json"], ["launch", "train.sh"]] as Array<[string, string]>) {
      mkdirSync(join(runDir, dir), { recursive: true });
      writeFileSync(join(runDir, dir, file), "{}");
    }
    return runDir;
  };
  const touch = (path: string, at: Date): void => utimesSync(path, at, at);

  it("tmux 退出（探测可用＋取证无本 run）→ 立即 false——新鲜的 loss-series/progress/trainer_log 缓存不得兜底", () => {
    const root = tempRoot();
    const runDir = seedAnchored(root, "run-d28-end");
    // 结束瞬间形态：全部在盘活性面仍是新鲜的（写历史缓存）
    const now = new Date();
    touch(join(runDir, "training", "loss-series.json"), now);
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "progress.json"), JSON.stringify({ percentage: 64, updated_at: now.toISOString() }));
    const ended = scanRunDir(root, "run-d28-end", {
      trainingEvidence: {}, tmuxProbeUsable: true, nowMs: Date.now(), freshWindowMs: 180_000,
    });
    expect(ended.training.active).toBe(false);
  });

  it("活跃训练不误杀：tmux 正证据优先于 trainer_log 超窗（checkpoint 长停顿场景 active 保持 true）", () => {
    const root = tempRoot();
    const runDir = seedAnchored(root, "run-d28-live");
    touch(join(runDir, "training", "loss-series.json"), new Date(Date.now() - 600_000));
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_log.jsonl"), '{"loss":1.2}\n');
    touch(join(runDir, "training", "trainer_log.jsonl"), new Date(Date.now() - 600_000));
    const live = scanRunDir(root, "run-d28-live", {
      trainingEvidence: { "run-d28-live": true }, tmuxProbeUsable: true, nowMs: Date.now(), freshWindowMs: 180_000,
    });
    expect(live.training.active).toBe(true);
  });

  it("trainer_log 超窗（源停更）→ 立即 false——探测面缺席时新鲜 loss-series 缓存同样不得兜底", () => {
    const root = tempRoot();
    const runDir = seedAnchored(root, "run-d28-stale");
    touch(join(runDir, "training", "loss-series.json"), new Date());
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_log.jsonl"), '{"loss":1.2}\n');
    touch(join(runDir, "training", "trainer_log.jsonl"), new Date(Date.now() - 600_000));
    const stale = scanRunDir(root, "run-d28-stale", {
      trainingEvidence: {}, tmuxProbeUsable: false, nowMs: Date.now(), freshWindowMs: 180_000,
    });
    expect(stale.training.active).toBe(false);
  });

  it("面缺席回落（既有 fail-closed 回归）：探测不可用＋无 trainer_log＋新鲜 loss-series → true", () => {
    const root = tempRoot();
    const runDir = seedAnchored(root, "run-d28-fallback");
    touch(join(runDir, "training", "loss-series.json"), new Date());
    const fallback = scanRunDir(root, "run-d28-fallback", {
      trainingEvidence: {}, tmuxProbeUsable: false, nowMs: Date.now(), freshWindowMs: 180_000,
    });
    expect(fallback.training.active).toBe(true);
  });

  it("probeTrainingEvidence：命名域未设＝usable:false（面缺席——与零会话可区分）", () => {
    const prior = process.env[TMUX_SESSION_PREFIX_ENV];
    delete process.env[TMUX_SESSION_PREFIX_ENV];
    try {
      const probe = probeTrainingEvidence(["run-x"]);
      expect(probe.usable).toBe(false);
      expect(probe.evidence).toEqual({});
    } finally {
      if (prior !== undefined) process.env[TMUX_SESSION_PREFIX_ENV] = prior;
    }
  });
});

describe("批㊶-P P-2 探针经 scanRunDir→monitor 投影链（alerts.json→probe 面）", () => {
  it("alerts.json 末条 → scanRunDir.probe（additive 面）；无 alerts → null", () => {
    const root = tempRoot();
    const runDir = join(root, "run-probe");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "alerts.json"), JSON.stringify([
      { level: "error", reason: "训练疑似停滞 · 进度已停更 449 分钟（阈值 15 分钟，自适应步长基线）", since: "2026-10-10T03:29:22.140Z" },
    ]));
    const scan = scanRunDir(root, "run-probe");
    expect(scan.probe).toMatchObject({ level: "error", reason: expect.stringContaining("停滞") });
    const scanEmpty = scanRunDir(root, "run-noalert");
    expect(scanEmpty.probe).toBeNull();
  });
});

// ── 批㊶Q增补二1：progress 持续写链（trainer_log 步进单源）──

import {
  buildProgressFromTrainerLog,
  parseTrainerLogLine,
  readNumTrainEpochs,
  readTrainerLogTail,
} from "../../src/core/workspace/runFacts.js";

describe("批㊶Q增补二1 progress 持续写链（trainer_log 步进解析＋progress 组装＋epochs 读取）", () => {
  it("parseTrainerLogLine：合法行全键解析；缺键/坏 JSON/空行 → null（不猜测）", () => {
    // 批㊶-TRAIN-OBS：A800 现网真实样本行（run-regress-formal-01 首行——含 remaining_time）
    const real = parseTrainerLogLine('{"current_steps": 2, "total_steps": 141, "loss": 0.6885, "lr": 7.142857142857143e-06, "epoch": 0.0431266846361186, "percentage": 1.42, "elapsed_time": "0:02:16", "remaining_time": "2:37:53"}');
    expect(real).toEqual({ current_steps: 2, total_steps: 141, loss: 0.6885, epoch: 0.0431266846361186, percentage: 1.42, remaining_time: "2:37:53" });
    // 真实终态行（percentage 100 缺 loss/lr）——loss/epoch 降可选后可解析（终态写一次的前提）
    const terminal = parseTrainerLogLine('{"current_steps": 141, "total_steps": 141, "epoch": 3.0, "percentage": 100.0, "elapsed_time": "2:03:34", "remaining_time": "0:00:00"}');
    expect(terminal).toEqual({ current_steps: 141, total_steps: 141, loss: null, epoch: 3, percentage: 100, remaining_time: "0:00:00" });
    const ok = parseTrainerLogLine('{"current_steps": 140, "total_steps": 186, "loss": 0.0646, "lr": 3.66e-5, "epoch": 4.52, "percentage": 75.27}');
    expect(ok).toEqual({ current_steps: 140, total_steps: 186, loss: 0.0646, epoch: 4.52, percentage: 75.27, remaining_time: null });
    expect(parseTrainerLogLine('{"current_steps": 1}')).toBeNull(); // 缺必填（total/percentage）
    expect(parseTrainerLogLine("not-json")).toBeNull();
    expect(parseTrainerLogLine("")).toBeNull();
  });
  it("readTrainerLogTail：真文件取末条非空行；缺席/全空 → null", () => {
    const root = tempRoot();
    const runDir = join(root, "run-p");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "trainer_log.jsonl"), '{"current_steps": 1, "total_steps": 186, "loss": 0.42, "epoch": 0.07, "percentage": 0.5, "remaining_time": "1:00:00"}\n\n{"current_steps": 2, "total_steps": 186, "loss": 0.41, "epoch": 0.14, "percentage": 1.1, "remaining_time": "0:59:00"}\n');
    expect(readTrainerLogTail(runDir)).toEqual({ current_steps: 2, total_steps: 186, loss: 0.41, epoch: 0.14, percentage: 1.1, remaining_time: "0:59:00" });
    expect(readTrainerLogTail(join(root, "run-absent"))).toBeNull();
  });
  it("buildProgressFromTrainerLog：epoch 语义轮次（1-based 封顶）＋percentage＋step_remaining；epochs 缺源不写 total_rounds", () => {
    const p1 = buildProgressFromTrainerLog({ current_steps: 140, total_steps: 186, loss: 0.0646, epoch: 4.52, percentage: 75.27, remaining_time: null }, 6, "2026-10-11T01:00:00Z");
    expect(p1).toMatchObject({ round: 5, total_rounds: 6, step_remaining: 46, loss: 0.0646, percentage: 75.27, updated_at: "2026-10-11T01:00:00Z" });
    expect(p1.eta_s).toBeUndefined(); // remaining_time 缺失＝eta 不写（T2 缺数不占位）
    const p2 = buildProgressFromTrainerLog({ current_steps: 186, total_steps: 186, loss: 0.06, epoch: 6, percentage: 100, remaining_time: null }, 6, "n");
    expect(p2.round).toBe(6); // 完成态封顶不越界
    const p3 = buildProgressFromTrainerLog({ current_steps: 10, total_steps: 186, loss: 0.4, epoch: 0.2, percentage: 5.4, remaining_time: null }, null, "n");
    expect(p3.round).toBe(1);
    expect(p3.total_rounds).toBeUndefined();
    // 批㊶-TRAIN-OBS：eta_s 由 remaining_time 换算（真实样本 2:37:53 → 9473s）
    const p4 = buildProgressFromTrainerLog({ current_steps: 2, total_steps: 141, loss: 0.6885, epoch: 0.04, percentage: 1.42, remaining_time: "2:37:53" }, null, "n");
    expect(p4.eta_s).toBe(9473);
    expect(p4.step_remaining).toBe(139);
  });
  it("readNumTrainEpochs：live 路径优先／legacy 回退／缺席非法 → null", () => {
    const root = tempRoot();
    const live = join(root, "run-live");
    mkdirSync(join(live, "prep"), { recursive: true });
    writeFileSync(join(live, "prep", "iteration-config.json"), JSON.stringify({ training: { num_train_epochs: 6 } }));
    expect(readNumTrainEpochs(live)).toBe(6);
    const legacy = join(root, "run-legacy");
    mkdirSync(join(legacy, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(legacy, "prep", "iteration-config", "iteration-config.json"), JSON.stringify({ training: { num_train_epochs: "3" } }));
    expect(readNumTrainEpochs(legacy)).toBe(3);
    expect(readNumTrainEpochs(join(root, "run-none"))).toBeNull();
  });
});
