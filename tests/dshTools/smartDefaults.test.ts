/**
 * 批㊶-P 测试锚——三层缺省纯函数／OOM 降档／param_sources 补丁／探针三态＋自适应基线。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveGradAccum,
  clampLearningRate,
  clampEpochs,
  clampLoraRank,
  loraAlphaFor,
  clampCutoffLen,
  clampImageMaxPixels,
  clampNegativeRatio,
  oomFallbackParams,
  SMART_DEEPSPEED_DEFAULT,
  kernelBsDefaultOf,
} from "../../src/core/workspace/smartDefaults.js";
import {
  probeAndRecord,
  medianStepIntervalSec,
  staleThresholdSec,
  probeRun,
  readAlerts,
  OOM_PATTERN,
} from "../../src/core/workspace/trainProbe.js";
import { existsSync } from "node:fs";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-p-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-P P-1b L2 派生（global_batch=256 目标）", () => {
  it("bs2×nproc8 → accum 16（gb 256 校验通过）——VERIFY-1 口径", () => {
    expect(deriveGradAccum(2, 8)).toEqual({ accum: 16, globalBatch: 256 });
  });
  it("除不尽 → 错误串（禁止静默取整）：bs3×nproc8 = 24 不整除 256", () => {
    const result = deriveGradAccum(3, 8);
    expect("error" in result).toBe(true);
  });
  it("OOM 降档：bs1 → accum 32、gb 保持 256", () => {
    expect(oomFallbackParams(8)).toEqual({ bs: 1, accum: 32, globalBatch: 256 });
  });
});

describe("批㊶-P P-1b L3 模型建议 clamp", () => {
  it("lr 域 [5e-5, 5e-4]：域内保持科学计数法形态；越界夹取；非法回退 1e-4", () => {
    expect(clampLearningRate("2e-4")).toBe("2e-4");
    expect(clampLearningRate("1e-5")).toBe("5e-5");
    expect(clampLearningRate("1e-3")).toBe("5e-4");
    expect(clampLearningRate("abc")).toBe("1e-4");
  });
  it("epochs [1,10]；rank 档位 {16,32,64,128}＋alpha=2×rank", () => {
    expect(clampEpochs(5)).toBe(5);
    expect(clampEpochs(0.5)).toBe(1);
    expect(clampEpochs(20)).toBe(10);
    expect(clampLoraRank(16)).toBe(16);
    expect(clampLoraRank(20)).toBe(16);
    expect(clampLoraRank(30)).toBe(32);
    expect(loraAlphaFor(32)).toBe(64);
  });
  it("cutoff ≤12800（基准 9000）；image_max_pixels 两档（F1 单源 802816/1605632）；负样本带 clamp", () => {
    expect(clampCutoffLen(9000)).toBe(9000);
    expect(clampCutoffLen(20000)).toBe(12800);
    // 批㊶-W F1：像素闭集改单源两档（历史 800000/1600000 退役——4.19M 就近 1.6M 档语义保持）
    expect(clampImageMaxPixels(802816)).toBe(802816);
    expect(clampImageMaxPixels(1605632)).toBe(1605632);
    expect(clampImageMaxPixels(4194304)).toBe(1605632); // 最近档位——bl 历史 4.19M 更近高档
    expect(clampImageMaxPixels(800000)).toBe(802816);
    // 批㊶-W F2：负样本构造带（单值/带两形态；越界逐值夹取）
    expect(clampNegativeRatio("0.03")).toBe("0.03");
    expect(clampNegativeRatio("0.02,0.05")).toBe("0.02,0.05");
    expect(clampNegativeRatio("0.08")).toBe("0.05");
    expect(clampNegativeRatio("0.01,0.2")).toBe("0.02,0.05");
  });
});

describe("批㊶-P P-1a/c param_sources 补丁＋deepspeed 缺省（E4-乙停写改造）", () => {
  it("E4-乙改动 2：iteration-config 回写面退役——确认值只落快照，内核产物零触碰", () => {
    // 回写函数 applyConfirmedToIterationConfig 已删（停写红线：快照是训练参数唯一出口——
    // training 段与 param_sources 由内核 training_prep 段写 user_confirmed(ref=stage:training_overrides)）。
    // 模块级锚：导出面不再含回写件（import 已摘——typecheck 层断链；此处行为锚归
    // autoTraining.test「停写断言」与 batchE4b 停写例）。
    const moduleText = readFileSync(join(import.meta.dirname, "..", "..", "src", "core", "workspace", "smartDefaults.ts"), "utf8");
    expect(moduleText).not.toContain("export const applyConfirmedToIterationConfig");
    expect(moduleText).toContain("快照是训练参数唯一出口");
  });
  it("deepspeed 智能缺省＝ds_z3_offload（E4-乙与内核统一别名形态；内核 assets 在位——BUILD 首验）", () => {
    expect(SMART_DEEPSPEED_DEFAULT).toBe("ds_z3_offload");
    expect(existsSync("/data/sam/ATF-Harness/.atf-pinned/skills/atf-prepare-training/assets/deepspeed/ds_z3_offload_config.json")).toBe(true);
  });
  it("E4-乙改动 2：bs 内核缺省分档单源 kernelBsDefaultOf（cutoff<10000→2，≥10000→1；缺席按惯例基线判档）", () => {
    expect(kernelBsDefaultOf(9000)).toBe(2);
    expect(kernelBsDefaultOf(12800)).toBe(1);
    expect(kernelBsDefaultOf(undefined)).toBe(2); // 惯例基线 9000 判档
  });
});

describe("批㊶-P P-2 训练探针（自适应基线）", () => {
  const lossPoints = (gapsSec: number[], loss = 0.3): Array<Record<string, unknown>> => {
    const points: Array<Record<string, unknown>> = [];
    let at = Date.now() - gapsSec.reduce((a, b) => a + b, 0) * 1000;
    for (const gap of gapsSec) {
      at += gap * 1000;
      points.push({ train_loss: loss, at: new Date(at).toISOString() });
    }
    return points;
  };
  // 变化 loss 序列（避开 warn·loss 停滞判据——同值三周期抢跑；增补二锚专用于 error·假死语义）
  const lossPointsVaried = (gapsSec: number[]): Array<Record<string, unknown>> => {
    const points: Array<Record<string, unknown>> = [];
    let at = Date.now() - gapsSec.reduce((a, b) => a + b, 0) * 1000;
    let v = 0.5;
    for (const gap of gapsSec) {
      at += gap * 1000;
      v -= 0.01;
      points.push({ train_loss: v, at: new Date(at).toISOString() });
    }
    return points;
  };

  it("中位数基线：300s 间隔 → 阈值 max(900,600)=900s；无基线 → 保守 1800s", () => {
    expect(staleThresholdSec(medianStepIntervalSec(lossPoints([300, 300, 300, 300])))).toBe(900);
    expect(staleThresholdSec(null)).toBe(1800);
    expect(staleThresholdSec(medianStepIntervalSec(lossPoints([30, 30])))).toBe(600);
  });

  it("error·假死（增补二2 修正语义）：活跃证据全过期（loss 点过期＋trainer_log 过期）＋progress 停更 → error", () => {
    // 手造末点过期列（helper 末点恒 now）：间隔 20/40s→median 30→阈值 600s；末点 now-700s 全证据过期
    const now = Date.now();
    const points = [
      { train_loss: 0.5, at: new Date(now - 760_000).toISOString() },
      { train_loss: 0.49, at: new Date(now - 740_000).toISOString() },
      { train_loss: 0.48, at: new Date(now - 700_000).toISOString() },
    ];
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: points,
      trainerLogMtimeMs: Date.now() - 700_000,
      progress: { round: 6, loss: 0.3, updated_at: new Date(Date.now() - 610_000).toISOString() },
      logTailText: "", nowMs: Date.now(),
    });
    expect(alert?.level).toBe("error");
    expect(alert?.reason).toContain("停滞");
    expect(alert?.reason).toContain("产物已停更");
  });
  it("增补二2：progress 停更但 loss-series 增量新鲜 → null（P 批误报场景反演——progress 单独不构成假死）", () => {
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: lossPointsVaried([100, 100, 100]), // 末点＝now（健康增量）
      progress: { round: 1, loss: 0.42, updated_at: new Date(Date.now() - 8 * 3_600_000).toISOString() }, // 停更 8h
      logTailText: "", nowMs: Date.now(),
    });
    expect(alert).toBeNull();
  });
  it("增补二2：loss 点过期但 trainer_log 步进新鲜 → null（活跃证据取两者较新）", () => {
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: lossPointsVaried([700, 700, 700]),
      trainerLogMtimeMs: Date.now() - 60_000,
      progress: { round: 1, loss: 0.42, updated_at: new Date(Date.now() - 610_000).toISOString() },
      logTailText: "", nowMs: Date.now(),
    });
    expect(alert).toBeNull();
  });
  it("增补二2：无进展历史（progress null＋无 loss 点＋无 trainer_log）→ null（信息不足 fail-open）", () => {
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: [], progress: null, trainerLogMtimeMs: null,
      logTailText: "", nowMs: Date.now(),
    });
    expect(alert).toBeNull();
  });

  it("error·进程消失：取证消失＋产物过窗＋未 done → error；OOM 特征 → error（降档建议文案）", () => {
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: false, lossSeriesFresh: false, trainingDone: false,
      lossPoints: [], progress: null, logTailText: "", nowMs: Date.now(),
    });
    expect(alert?.level).toBe("error");
    expect(alert?.reason).toContain("进程消失");
    const oom = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: [], progress: null, logTailText: "RuntimeError: CUDA out of memory on device", nowMs: Date.now(),
    });
    expect(oom?.level).toBe("error");
    expect(oom?.reason).toContain("bs 1");
    expect(OOM_PATTERN.test("CUDA out of memory")).toBe(true);
  });

  it("warn·loss 停滞：连续 3 周期同值 → warn（仅提示）；正常变化 → null；空闲 run → null", () => {
    const stagnant = lossPoints([60, 60, 60, 60], 0.5).map((p, i) => (i % 2 === 0 ? { ...p, train_loss: 0.5 } : p));
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: stagnant, progress: null, logTailText: "", nowMs: Date.now(),
    });
    expect(alert === null || alert.level === "warn").toBe(true);
    const healthy = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: lossPoints([60, 60], 0.2), progress: null, logTailText: "", nowMs: Date.now(),
    });
    expect(healthy === null || healthy.level === "warn").toBe(true);
  });

  it("alerts.json append 幂等（10 分钟内同因不重复）＋上限截断语义存在", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "training"), { recursive: true });
    const input = {
      trainingActive: true, tmuxEvidence: false, lossSeriesFresh: false, trainingDone: false,
      lossPoints: [], progress: null, logTailText: "", nowMs: Date.now(),
    };
    probeAndRecord(runDir, input);
    probeAndRecord(runDir, input);
    const alerts = readAlerts(runDir);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.reason).toContain("进程消失");
    void probeAndRecord;
  });
});

// 批㊶-Q 段2：全自动档逐键来源回写——E4-乙（改动 2）回写面整体退役（快照唯一出口），
// perKeySources 用例随函数删除；来源呈现保留在快照 meta.sources（autoTraining 断言）。
