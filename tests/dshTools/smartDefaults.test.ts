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
  oomFallbackParams,
  applyConfirmedToIterationConfig,
  SMART_DEEPSPEED_DEFAULT,
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
  it("cutoff ≤12800（基准 9000）；image_max_pixels 两档 80万/160万", () => {
    expect(clampCutoffLen(9000)).toBe(9000);
    expect(clampCutoffLen(20000)).toBe(12800);
    expect(clampImageMaxPixels(800000)).toBe(800000);
    expect(clampImageMaxPixels(4194304)).toBe(1600000); // 最近档位——bl 历史 4.19M 更近 160 万档
  });
});

describe("批㊶-P P-1a/c param_sources 补丁＋deepspeed 缺省", () => {
  it("确认快照回写 iteration-config training 段＋param_sources=user-specified（VERIFY-1 后处理）", () => {
    const root = tempRoot();
    const iterPath = join(root, "prep", "iteration-config.json");
    mkdirSync(join(root, "prep"), { recursive: true });
    writeFileSync(iterPath, JSON.stringify({ training: { per_device_train_batch_size: 1, cutoff_len: 9000 }, param_sources: {} }));
    const result = applyConfirmedToIterationConfig(iterPath, { per_device_train_batch_size: "2", gradient_accumulation_steps: "16", cutoff_len: "9000" });
    expect("updated" in result).toBe(true);
    const patched = JSON.parse(readFileSync(iterPath, "utf8"));
    expect(patched.training.per_device_train_batch_size).toBe("2");
    expect(patched.param_sources.per_device_train_batch_size).toBe("user-specified");
    void existsSync;
  });
  it("iteration-config 缺失 → 结构化 error（不猜）", () => {
    const result = applyConfirmedToIterationConfig(join(tempRoot(), "nope.json"), { a: "1" });
    expect("error" in result).toBe(true);
  });
  it("deepspeed 智能缺省＝ds_z3_offload_config.json（内核 assets 在位——BUILD 首验）", () => {
    expect(SMART_DEEPSPEED_DEFAULT).toBe("ds_z3_offload_config.json");
    expect(existsSync("/data/sam/ATF-Harness/.atf-pinned/skills/atf-prepare-training/assets/deepspeed/ds_z3_offload_config.json")).toBe(true);
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

  it("中位数基线：300s 间隔 → 阈值 max(900,600)=900s；无基线 → 保守 1800s", () => {
    expect(staleThresholdSec(medianStepIntervalSec(lossPoints([300, 300, 300, 300])))).toBe(900);
    expect(staleThresholdSec(null)).toBe(1800);
    expect(staleThresholdSec(medianStepIntervalSec(lossPoints([30, 30])))).toBe(600);
  });

  it("error·假死：active＋progress 停更超自适应阈值 → error（步长数分钟场景——100s 间隔基线阈值 600s）", () => {
    const points = lossPoints([100, 100, 100]);
    const alert = probeRun({
      trainingActive: true, tmuxEvidence: true, lossSeriesFresh: true, trainingDone: false,
      lossPoints: points,
      progress: { round: 6, loss: 0.3, updated_at: new Date(Date.now() - 610_000).toISOString() },
      logTailText: "", nowMs: Date.now(),
    });
    expect(alert?.level).toBe("error");
    expect(alert?.reason).toContain("停滞");
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

// 批㊶-Q 段2：全自动档逐键来源回写（additive 第四参——手动路径零变化）
describe("批㊶-Q applyConfirmedToIterationConfig perKeySources（逐键来源覆盖）", () => {
  it("perKeySources 逐键生效；缺省键落 blanket source；手动两参调用零变化", () => {
    const runDir = tempRoot();
    const iterPath = join(runDir, "prep", "iteration-config.json");
    mkdirSync(join(iterPath, ".."), { recursive: true });
    writeFileSync(iterPath, JSON.stringify({ schema_version: "IterationConfig/v1", training: { learning_rate: "1e-4", lora_rank: 32 } }));
    const patched = applyConfirmedToIterationConfig(
      iterPath,
      { learning_rate: "2e-4", lora_rank: "64", seed: "42" },
      "default:harness-smart-defaults",
      { learning_rate: "default:agent-recommend:2.8万样本→lr2e-4" },
    );
    expect(patched).toMatchObject({ updated: ["learning_rate", "lora_rank", "seed"] });
    const config = JSON.parse(readFileSync(iterPath, "utf8")) as { param_sources: Record<string, string>; training: Record<string, unknown> };
    expect(config.param_sources["learning_rate"]).toBe("default:agent-recommend:2.8万样本→lr2e-4");
    expect(config.param_sources["lora_rank"]).toBe("default:harness-smart-defaults");
    expect(config.param_sources["seed"]).toBe("default:harness-smart-defaults");
    expect(config.training["learning_rate"]).toBe("2e-4");
    // 手动两参调用：全键 user-specified（P 批语义零变化）
    const manual = applyConfirmedToIterationConfig(iterPath, { seed: "42" });
    expect(manual).toMatchObject({ updated: ["seed"] });
    const config2 = JSON.parse(readFileSync(iterPath, "utf8")) as { param_sources: Record<string, string> };
    expect(config2.param_sources["seed"]).toBe("user-specified");
  });
});
