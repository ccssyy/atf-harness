/**
 * D88-A——GPU 探针三态化测试锚（8 条验收对应）。
 *
 * 动机实锚：A800-5005 本机 `nvidia-smi -L` 中位 3.26s／峰值 3.47s、`--query-gpu` 峰值
 * 6.25s——旧实现把超时折成 false 再报「不可达（GPU 不可见或驱动异常）」，操作者白查
 * 驱动/挂载。本文件守三件结构性事实：
 *   ① 探针层有独立 timeout 态（永不折成 failed/unavailable）；
 *   ② 启动闸 timeout → `env_probe_timeout`（不是 `nvidia_smi_unreachable`），且豁免不覆盖；
 *   ③ 缓存只在启动闸真探路径生效（两次调用第二次不 spawn；注入态不写不读）。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GPU_PROBE_BOOT_DEFAULT_BUDGET_MS,
  GPU_PROBE_DISPLAY_DEFAULT_BUDGET_MS,
  GPU_PROBE_TIMEOUT_ENV,
  captureGpuProbeAsync,
  formatProbeEvidence,
  gpuOfflineLabel,
  gpuProbeCacheKey,
  normalizeProbeOutcome,
  probeCacheSize,
  probeGpuAsync,
  probeGpuSync,
  resetProbeCache,
  resolveGpuProbeBudgetMs,
  type ProbeResult,
  type RawProbeOutcome,
  type RawProbeRunner,
} from "../../../src/core/workspace/gpuProbe.js";import {
  BOOT_PREFLIGHT_ALLOW_PROBE_TIMEOUT_ENV,
  formatPreflightFatal,
  runBootPreflight,
  type PreflightProbes,
} from "../../../src/core/workspace/bootPreflight.js";
import { gpuOfflinePayload, queryNvidiaSmi, queryNvidiaSmiProbed } from "../../../src/webui/readOnlyTools.js";

/** 未走 GPU 探针的其余预检项一律静音（只留被测的那一面）。 */
const quietProbes: PreflightProbes = {
  fileExists: () => true,
  dirExists: () => true,
  listJsonFiles: () => [],
  readText: () => null,
};

const quietEnv = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ATF_DSH_KERNEL_DIR: "/kernel",
  PATH: "/usr/bin:/bin",
  ...extra,
});

const raw = (patch: Partial<RawProbeOutcome> = {}): RawProbeOutcome => ({
  timedOut: false,
  code: 0,
  signal: null,
  spawnError: null,
  stderr: "",
  stdout: "",
  ...patch,
});

/** 造一个只含假 nvidia-smi 的 PATH（脚本内容由调用方给）。 */
const fakePathDir = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "d88a-gpu-"));
  const file = join(dir, "nvidia-smi");
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
  return dir;
};

const cleanupDirs: string[] = [];
const trackDir = (dir: string): string => {
  cleanupDirs.push(dir);
  return dir;
};

beforeEach(() => {
  resetProbeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetProbeCache();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────── 1 探针归一面

describe("D88-A ①探针归一：四态互不折叠（timeout 判定前置）", () => {
  it("rc=0 → ok；非零 → failed（带 code＋stderr）；起不来 → unavailable；超时 → timeout", () => {
    expect(normalizeProbeOutcome(raw(), 12, 30_000)).toEqual({ status: "ok", elapsedMs: 12 });
    const failed = normalizeProbeOutcome(raw({ code: 9, stderr: "NVIDIA-SMI has failed" }), 40, 30_000);
    expect(failed).toEqual({ status: "failed", code: "exit_9", stderr: "NVIDIA-SMI has failed", elapsedMs: 40 });
    const gone = normalizeProbeOutcome(raw({ code: null, spawnError: "ENOENT" }), 3, 30_000);
    expect(gone).toEqual({ status: "unavailable", code: "ENOENT", stderr: "" });
    // 关键红线：timedOut 即使 code=null/signal=SIGKILL（kill 后同形），也必须是 timeout
    const killed = normalizeProbeOutcome(raw({ timedOut: true, code: null, signal: "SIGKILL" }), 30_000, 30_000);
    expect(killed).toEqual({ status: "timeout", elapsedMs: 30_000, budgetMs: 30_000 });
    expect(killed.status).not.toBe("failed");
    expect(killed.status).not.toBe("unavailable");
  });

  it("timeout 证据必带 elapsed_ms／budget_ms（4 条证据面）", () => {
    expect(formatProbeEvidence({ status: "timeout", elapsedMs: 29_980, budgetMs: 30_000 })).toBe("elapsed_ms=29980 budget_ms=30000");
    expect(formatProbeEvidence({ status: "failed", code: "exit_9", stderr: "boom", elapsedMs: 8 })).toContain("stderr=boom");
  });

  it("stderr 不再丢弃（旧 stdio:ignore 的证据缺口）+ 超长截断", () => {
    const long = "x".repeat(2000);
    const failed = normalizeProbeOutcome(raw({ code: 2, stderr: long }), 5, 30_000);
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.stderr).toContain("截断");
      expect(failed.stderr.length).toBeLessThan(700);
    }
  });
});

// ─────────────────────────────────────────────────── 5 预算可配

describe("D88-A ⑤预算：同一变量、两个消费方各自缺省 30s／10s", () => {
  it("env 缺省 → 各消费方自己的缺省（启动闸 30s／展示面 10s）", async () => {
    expect(resolveGpuProbeBudgetMs({}, GPU_PROBE_BOOT_DEFAULT_BUDGET_MS)).toBe(30_000);
    expect(resolveGpuProbeBudgetMs({}, GPU_PROBE_DISPLAY_DEFAULT_BUDGET_MS)).toBe(10_000);
    // 探针层两条入口各自落实缺省（不是靠调用方记得传）
    let syncBudget = 0;
    let asyncBudget = 0;
    const runner: RawProbeRunner = (_c, _a, budget) => {
      syncBudget = budget;
      return raw();
    };
    probeGpuSync({ runSync: runner });
    await probeGpuAsync({
      runAsync: async (_c, _a, budget) => {
        asyncBudget = budget;
        return raw();
      },
    });
    expect(syncBudget).toBe(30_000);
    expect(asyncBudget).toBe(10_000);
  });

  it("ATF_GPU_PROBE_TIMEOUT_MS 覆盖两边（同一变量）；非法值回落缺省（不把 NaN 当 0ms）", () => {
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: "60000" }, 10_000)).toBe(60_000);
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: " 4500 " }, 10_000)).toBe(4_500);
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: "abc" }, 10_000)).toBe(10_000);
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: "0" }, 10_000)).toBe(10_000);
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: "-5" }, 10_000)).toBe(10_000);
    expect(resolveGpuProbeBudgetMs({ [GPU_PROBE_TIMEOUT_ENV]: "   " }, 10_000)).toBe(10_000);
  });

  it("启动闸把解析后的预算交给探针（30s 缺省／env 覆盖后的值）", () => {
    const seen: number[] = [];
    const probes: PreflightProbes = {
      ...quietProbes,
      gpuProbe: (budgetMs): ProbeResult => {
        seen.push(budgetMs);
        return { status: "ok", elapsedMs: 1 };
      },
    };
    runBootPreflight(quietEnv(), probes);
    runBootPreflight(quietEnv({ [GPU_PROBE_TIMEOUT_ENV]: "45000" }), probes);
    expect(seen).toEqual([30_000, 45_000]);
  });
});

// ─────────────────────────────────────────────────── 2 启动闸

describe("D88-A ②启动闸：timeout 独立成码，永不折成 unreachable", () => {
  const timeoutProbe = (budgetMs: number): ProbeResult => ({ status: "timeout", elapsedMs: budgetMs - 20, budgetMs });

  it("timeout → fatal code=env_probe_timeout（不是 nvidia_smi_unreachable）＋ notes 标 env_unverified", () => {
    const report = runBootPreflight(quietEnv(), { ...quietProbes, gpuProbe: timeoutProbe });
    expect(report.fatal).toHaveLength(1);
    const item = report.fatal[0]!;
    expect(item.code).toBe("env_probe_timeout");
    expect(item.check).toBe("gpu_probe");
    expect(item.missing).toContain("elapsed_ms=");
    expect(item.missing).toContain("budget_ms=30000");
    expect(report.fatal.some((f) => f.code === "nvidia_smi_unreachable")).toBe(false);
    expect(report.notes.some((n) => n.includes("env_unverified"))).toBe(true);
    // 人读面同样可区分（ops 复制的那一行就带着码）
    const text = formatPreflightFatal(report.fatal);
    expect(text).toContain("env_probe_timeout");
    expect(text).not.toContain("nvidia_smi_unreachable");
    expect(text).toContain("补法");
  });

  it("failed／unavailable（确定态）→ nvidia_smi_unreachable", () => {
    const failedReport = runBootPreflight(quietEnv(), {
      ...quietProbes,
      gpuProbe: () => ({ status: "failed", code: "exit_255", stderr: "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver", elapsedMs: 12 }),
    });
    expect(failedReport.fatal.map((f) => f.code)).toEqual(["nvidia_smi_unreachable"]);
    expect(failedReport.fatal[0]!.missing).toContain("stderr=NVIDIA-SMI has failed");

    const goneReport = runBootPreflight(quietEnv(), { ...quietProbes, gpuProbe: () => ({ status: "unavailable", code: "ENOENT", stderr: "" }) });
    expect(goneReport.fatal.map((f) => f.code)).toEqual(["nvidia_smi_unreachable"]);
  });

  it("ok → 零 fatal（命令回得来即放行）", () => {
    const report = runBootPreflight(quietEnv(), { ...quietProbes, gpuProbe: () => ({ status: "ok", elapsedMs: 3260 }) });
    expect(report.fatal).toHaveLength(0);
    expect(report.notes.some((n) => n.includes("env_unverified"))).toBe(false);
  });

  it("--allow-probe-timeout 等价 env：放行但仍留 env_unverified（不静默）", () => {
    const report = runBootPreflight(quietEnv({ [BOOT_PREFLIGHT_ALLOW_PROBE_TIMEOUT_ENV]: "1" }), {
      ...quietProbes,
      gpuProbe: timeoutProbe,
    });
    expect(report.fatal).toHaveLength(0);
    expect(report.notes.some((n) => n.includes("env_unverified"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────── 6 豁免

describe("D88-A ⑥豁免：ATF_GPU_REQUIRED=0 只豁免确定态，不兜 timeout", () => {
  it("failed → 豁免（纯 CPU 部署合法）", () => {
    const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "0" }), {
      ...quietProbes,
      gpuProbe: () => ({ status: "failed", code: "exit_1", stderr: "", elapsedMs: 4 }),
    });
    expect(report.fatal).toHaveLength(0);
  });

  it("unavailable → 豁免", () => {
    const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "0" }), {
      ...quietProbes,
      gpuProbe: () => ({ status: "unavailable", code: "ENOENT", stderr: "" }),
    });
    expect(report.fatal).toHaveLength(0);
  });

  it("timeout → **不豁免**（豁免分支结构上读不到 gpuRequired）", () => {
    const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "0" }), {
      ...quietProbes,
      gpuProbe: (budgetMs) => ({ status: "timeout", elapsedMs: budgetMs - 1, budgetMs }),
    });
    expect(report.fatal.map((f) => f.code)).toEqual(["env_probe_timeout"]);
    expect(report.notes.some((n) => n.includes("env_unverified"))).toBe(true);
  });

  it("豁免态**仍然探活**（「不探」等于「兜 timeout」——豁免不许把未证实态变成通过）", () => {
    let probed = 0;
    const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "0" }), {
      ...quietProbes,
      gpuProbe: () => {
        probed += 1;
        return { status: "unavailable", code: "ENOENT", stderr: "" };
      },
    });
    expect(probed).toBe(1);
    expect(report.fatal).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────── 7 缓存

describe("D88-A ⑦缓存：只在启动闸真探路径读写（正负同寿命＝进程）", () => {
  it("resetProbeCache 后两次调用 → 第二次不 spawn", () => {
    let spawns = 0;
    const runner: RawProbeRunner = () => {
      spawns += 1;
      return raw({ stdout: "GPU 0: NVIDIA A800-SXM4-80GB\n" });
    };
    const first = probeGpuSync({ env: { PATH: "/usr/bin" }, useCache: true, runSync: runner });
    const second = probeGpuSync({ env: { PATH: "/usr/bin" }, useCache: true, runSync: runner });
    expect(spawns).toBe(1);
    expect(first).toEqual(second);
    expect(probeCacheSize()).toBe(1);
  });

  it("负缓存同样生命周期：一次 timeout 后第二次不再 spawn（也不改判成 unreachable）", () => {
    let spawns = 0;
    const runner: RawProbeRunner = (_c, _a, budgetMs) => {
      spawns += 1;
      return raw({ timedOut: true, code: null, signal: "SIGKILL" });
    };
    const first = probeGpuSync({ budgetMs: 1_000, env: { PATH: "/usr/bin" }, useCache: true, runSync: runner });
    const second = probeGpuSync({ budgetMs: 1_000, env: { PATH: "/usr/bin" }, useCache: true, runSync: runner });
    expect(spawns).toBe(1);
    expect(first.status).toBe("timeout");
    expect(second.status).toBe("timeout");
    expect(second).toEqual(first);
  });

  it("缓存键显式枚举：噪音 env 不进键（换 ATF_APPROVAL_LEDGER 仍命中）；PATH／ATF_GPU_REQUIRED 进键", () => {
    let spawns = 0;
    const runner: RawProbeRunner = () => {
      spawns += 1;
      return raw();
    };
    probeGpuSync({ env: { PATH: "/usr/bin", ATF_APPROVAL_LEDGER: "/a" }, useCache: true, runSync: runner });
    probeGpuSync({ env: { PATH: "/usr/bin", ATF_APPROVAL_LEDGER: "/b" }, useCache: true, runSync: runner });
    expect(spawns).toBe(1);

    expect(gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/usr/bin", ATF_APPROVAL_LEDGER: "/a" })).toBe(
      gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/usr/bin", ATF_APPROVAL_LEDGER: "/b" }),
    );
    expect(gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/a" })).not.toBe(gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/b" }));
    expect(gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/a", ATF_GPU_REQUIRED: "0" })).not.toBe(
      gpuProbeCacheKey("nvidia-smi", ["-L"], { PATH: "/a" }),
    );

    probeGpuSync({ env: { PATH: "/other" }, useCache: true, runSync: runner });
    expect(spawns).toBe(2);
  });

  it("注入态一律不写不读缓存（probes.gpuProbe／probes.commandWorks）", () => {
    runBootPreflight(quietEnv(), { ...quietProbes, gpuProbe: () => ({ status: "ok", elapsedMs: 3 }) });
    expect(probeCacheSize()).toBe(0);
    runBootPreflight(quietEnv(), { ...quietProbes, commandWorks: () => false });
    expect(probeCacheSize()).toBe(0);
  });

  it("without useCache 每次真探（展示面语义：一次超时不被永久钉住）", () => {
    let spawns = 0;
    const runner: RawProbeRunner = () => {
      spawns += 1;
      return raw();
    };
    probeGpuSync({ env: { PATH: "/usr/bin" }, runSync: runner });
    probeGpuSync({ env: { PATH: "/usr/bin" }, runSync: runner });
    expect(spawns).toBe(2);
    expect(probeCacheSize()).toBe(0);
  });
});

// ─────────────────────────────────────────────────── 3 展示面

describe("D88-A ③展示面：timeout 与不可达文案必须可区分（不参与致命性判定）", () => {
  it("两态文案", () => {
    expect(gpuOfflineLabel({ status: "timeout", elapsedMs: 10_000, budgetMs: 10_000 })).toBe("离线（探测超时）");
    expect(gpuOfflineLabel({ status: "failed", code: "exit_255", stderr: "", elapsedMs: 5 })).toBe("离线（不可达）");
    expect(gpuOfflineLabel({ status: "unavailable", code: "ENOENT", stderr: "" })).toBe("离线（不可达）");
    expect(gpuOfflineLabel({ status: "timeout", elapsedMs: 10_000, budgetMs: 10_000 })).not.toBe(
      gpuOfflineLabel({ status: "unavailable", code: "ENOENT", stderr: "" }),
    );
  });

  it("离线载荷带 reason／label／证据（timeout 附 budget_ms）", () => {
    const timeoutPayload = gpuOfflinePayload({ status: "timeout", elapsedMs: 9_990, budgetMs: 10_000 });
    expect(timeoutPayload["gpu_offline"]).toBe(true);
    expect(timeoutPayload["offline_reason"]).toBe("timeout");
    expect(timeoutPayload["offline_label"]).toBe("离线（探测超时）");
    expect(timeoutPayload["probe_evidence"]).toContain("budget_ms=10000");

    const unreachablePayload = gpuOfflinePayload({ status: "failed", code: "exit_255", stderr: "driver mismatch", elapsedMs: 7 });
    expect(unreachablePayload["offline_reason"]).toBe("unreachable");
    expect(unreachablePayload["offline_label"]).toBe("离线（不可达）");
    expect(unreachablePayload["probe_evidence"]).toContain("stderr=driver mismatch");
  });
});

// ─────────────────────────────────────────────────── 8 实测（真 spawn）

describe("D88-A ⑧实测：真 spawn 两态（超时 vs 非零退出）", () => {
  it(
    "PATH 指向 sleep 脚本 → status=timeout（带 elapsed/budget），展示面「离线（探测超时）」",
    async () => {
      const dir = trackDir(fakePathDir("#!/bin/sh\nsleep 30\n"));
      vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
      vi.stubEnv(GPU_PROBE_TIMEOUT_ENV, "900");

      const started = Date.now();
      const view = await queryNvidiaSmiProbed();
      const elapsed = Date.now() - started;

      expect(view.gpu).toBeNull();
      expect(view.probe.status).toBe("timeout");
      if (view.probe.status === "timeout") {
        expect(view.probe.budgetMs).toBe(900);
        expect(view.probe.elapsedMs).toBeGreaterThanOrEqual(800);
      }
      expect(elapsed).toBeLessThan(15_000);
      const payload = gpuOfflinePayload(view.probe);
      expect(payload["offline_label"]).toBe("离线（探测超时）");
      expect(payload["offline_reason"]).toBe("timeout");
      // 展示面不判定致命性：queryNvidiaSmi 仍只是 null
      expect(await queryNvidiaSmi()).toBeNull();
    },
    90_000,
  );

  it(
    "同一 PATH 造超时 → 启动闸产出 env_probe_timeout（**不是** nvidia_smi_unreachable，全链路真 spawn）",
    () => {
      const dir = trackDir(fakePathDir("#!/bin/sh\nsleep 30\n"));
      vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
      const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "1", [GPU_PROBE_TIMEOUT_ENV]: "900", PATH: `${dir}:${process.env["PATH"] ?? ""}` }), quietProbes);
      const gpuFatals = report.fatal.filter((f) => f.check === "gpu_probe" || f.check === "nvidia_smi");
      expect(gpuFatals.map((f) => f.code)).toEqual(["env_probe_timeout"]);
      expect(report.fatal.some((f) => f.code === "nvidia_smi_unreachable")).toBe(false);
      const item = gpuFatals[0]!;
      expect(item.missing).toContain("elapsed_ms=");
      expect(item.missing).toContain("budget_ms=900");
      expect(report.notes.some((n) => n.includes("env_unverified"))).toBe(true);
    },
    90_000,
  );

  it(
    "PATH 指向「写 stderr 后 exit 3」脚本 → failed 且 stderr 保留（旧 stdio:ignore 丢证据的回潮锚）",
    () => {
      const dir = trackDir(fakePathDir("#!/bin/sh\necho 'NVIDIA-SMI has failed: driver mismatch' >&2\nexit 3\n"));
      vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
      const report = runBootPreflight(quietEnv({ ATF_GPU_REQUIRED: "1", PATH: `${dir}:${process.env["PATH"] ?? ""}` }), quietProbes);
      const item = report.fatal.find((f) => f.check === "nvidia_smi");
      expect(item?.code).toBe("nvidia_smi_unreachable");
      expect(item?.missing).toContain("code=exit_3");
      expect(item?.missing).toContain("driver mismatch");
      expect(report.fatal.some((f) => f.code === "env_probe_timeout")).toBe(false);
    },
    90_000,
  );

  it(
    "异步探针同样保留 stderr 与非零退出（展示面解析层不吃错）",
    async () => {
      const dir = trackDir(fakePathDir("#!/bin/sh\necho 'async boom' >&2\nexit 7\n"));
      vi.stubEnv("PATH", `${dir}:${process.env["PATH"] ?? ""}`);
      const { result } = await captureGpuProbeAsync({ args: ["-L"], budgetMs: 5_000 });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.code).toBe("exit_7");
        expect(result.stderr).toContain("async boom");
      }
    },
    90_000,
  );
});
