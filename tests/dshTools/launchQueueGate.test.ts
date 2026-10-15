/**
 * 批㊶-S4b 测试锚——GPU 排队补挂编排主路径（T1/T3）。
 *
 * 挂点语义：launchExecuteHandler 放行记录登记后、launch.sh 执行前经 host.gpuQueueFace
 * 挂门（排队面结构契约归 core，实现＝扩展层 createLaunchGpuQueueFace 注入——gpuQueueFace
 * 既有面同型挂法：ATF_GPU_POLL_MS 同源 0＝直启旁路／整组判定／gpu_queue 通报／命中琥珀卡；
 * 装配缺席＝直启回退现状）。卡数不可判（launch.sh/manifest 均未声明 nproc）＝fail-closed
 * 不排队但发通报，不阻塞主线（owner 裁定固化）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_HANDLERS, type LaunchGpuQueueFace, type LocalToolHost } from "../../src/core/tools/workspaceTools.js";
import { createLaunchGpuQueueFace } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { resetResidentBaselineForTest } from "../../packages/extensions/atf-tools/src/gpuQueueFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "s4b-launch-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetResidentBaselineForTest();
  delete process.env["ATF_GPU_POLL_MS"];
});

/** 可启动的 launch.sh 桩（写 launch/state.json——handler 读回 state 断言）。 */
const makeEnv = (launchShLines?: string[]): { root: string; scratchDir: string; runDir: string } => {
  const root = tempRoot();
  const runDir = join(root, "run");
  const scratchDir = join(runDir, "scratch");
  mkdirSync(join(scratchDir, "out"), { recursive: true });
  writeFileSync(join(scratchDir, "out", "launch.sh"), (launchShLines ?? []).concat([
    "#!/usr/bin/env bash",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'mkdir -p "$SCRIPT_DIR/launch"',
    "sleep 0.1",
    'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
    '{"state": "started", "run_token": "stub", "pid": 4321, "log": "stub.log", "launcher_count": 1, "effect_started": true}',
    "EOF",
    "",
  ]).join("\n"));
  return { root, scratchDir, runDir };
};

const hostOf = (env: { root: string; scratchDir: string }, over?: Partial<LocalToolHost>): LocalToolHost => ({
  scratchDir: env.scratchDir,
  kernelDir: env.root,
  home: env.root,
  baseEnv: {},
  ...over,
});

type GateVerdict = Awaited<ReturnType<LaunchGpuQueueFace["gateLaunch"]>>;

const recordingFace = (verdict?: GateVerdict, seen?: Array<{ requiredCards: number | null; launchShRel: string }>): LaunchGpuQueueFace => ({
  gateLaunch: async (input) => {
    seen?.push({ requiredCards: input.requiredCards, launchShRel: input.launchShRel });
    return (verdict ?? { verdict: "proceed", queued: true, waited_text: "1m03s", amber: "approved" }) as GateVerdict;
  },
});

const launchHandler = WORKSPACE_TOOL_HANDLERS["atf_launch_execute"];
if (launchHandler === undefined) throw new Error("atf_launch_execute handler 未注册");

describe("批㊶-S4b T1——编排主路径 GPU 排队挂门（launchExecuteHandler）", () => {
  it("排队生效：放行后挂门→命中放行（face 注入，queued_hit＋等待时长＋琥珀回执入结果；卡数派生＝launch.sh NPROC_PER_NODE）", async () => {
    const env = makeEnv(["NPROC_PER_NODE=4", "TRAIN_DIR=/nonexistent", ""]);
    const seen: Array<{ requiredCards: number | null; launchShRel: string }> = [];
    const result = await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env, { gpuQueueFace: recordingFace(undefined, seen) }));
    if (result.kind !== "executed") throw new Error(`handler 应执行成功: ${JSON.stringify(result)}`);
    const payload = result.result as Record<string, unknown>;
    expect(payload["gpu_queue"]).toBe("queued_hit");
    expect(payload["gpu_queue_waited"]).toBe("1m03s");
    expect(payload["gpu_queue_amber"]).toBe("approved");
    expect(payload["state"]).toBe("started");
    // 卡数派生：launch.sh NPROC_PER_NODE 优先（＝4）
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requiredCards).toBe(4);
    expect(seen[0]?.launchShRel).toBe("out/launch.sh");
  });

  it("命中未确认（denied）＝不启动：结构化 rejected，launch.sh 未执行（无 state.json）", async () => {
    const env = makeEnv(["NPROC_PER_NODE=2"]);
    const result = await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env, {
      gpuQueueFace: { gateLaunch: async () => ({ verdict: "denied", outcome: "denied" }) },
    }));
    if (result.kind !== "rejected") throw new Error("denied 应折算 rejected");
    expect(result.reason).toBe("gpu_window_hit_not_confirmed");
    expect(existsSync(join(env.scratchDir, "out", "launch", "state.json"))).toBe(false);
  });

  it("排队中止（aborted）＝不启动：结构化 rejected gpu_queue_aborted", async () => {
    const env = makeEnv();
    const result = await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env, {
      gpuQueueFace: { gateLaunch: async () => ({ verdict: "aborted" }) },
    }));
    if (result.kind !== "rejected") throw new Error("aborted 应折算 rejected");
    expect(result.reason).toBe("gpu_queue_aborted");
    expect(existsSync(join(env.scratchDir, "out", "launch", "state.json"))).toBe(false);
  });

  it("卡数派生回退：launch.sh 无 NPROC → launch_manifest nproc_per_node；两处皆缺 → null（卡数不可判交适配面通报）", async () => {
    const env = makeEnv([]);
    const seen: Array<{ requiredCards: number | null; launchShRel: string }> = [];
    // manifest 派生（TRAIN_DIR 指向真实 manifest 桩）
    const trainDir = join(env.root, "traindir");
    mkdirSync(trainDir, { recursive: true });
    writeFileSync(join(trainDir, "launch_manifest.json"), JSON.stringify({ iteration_config_sha256: "x".repeat(64), nproc_per_node: 8 }));
    writeFileSync(join(env.scratchDir, "out", "launch.sh"), [
      "#!/usr/bin/env bash",
      "TRAIN_DIR='" + trainDir + "'",
      "# NPROC 由 manifest 承载",
    ].join("\n"));
    await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env, { gpuQueueFace: recordingFace({ verdict: "proceed", queued: false }, seen) }));
    expect(seen[0]?.requiredCards).toBe(8);
    // 两处皆缺 → null
    const env2 = makeEnv([]);
    const seen2: Array<{ requiredCards: number | null; launchShRel: string }> = [];
    await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env2, { gpuQueueFace: recordingFace({ verdict: "proceed", queued: false }, seen2) }));
    expect(seen2[0]?.requiredCards).toBeNull();
  });

  it("装配缺席（face 不注入）＝直启回退现状：结果如实标注 gpu_queue:'face_absent'", async () => {
    const env = makeEnv();
    const result = await launchHandler({ launch_sh: "out/launch.sh" }, hostOf(env));
    if (result.kind !== "executed") throw new Error(`handler 应执行成功: ${JSON.stringify(result)}`);
    expect((result.result as Record<string, unknown>)["gpu_queue"]).toBe("face_absent");
  });
});

describe("批㊶-S4b T1——排队面适配实现（createLaunchGpuQueueFace·gpuQueueFace 同型挂法）", () => {
  it("ATF_GPU_POLL_MS=0＝直启旁路：不等待、不通报，proceed queued:false", async () => {
    const face = createLaunchGpuQueueFace({ get: () => undefined }, undefined, {
      env: { ATF_GPU_POLL_MS: "0" },
      awaitWindow: async () => { throw new Error("旁路不应等待"); },
    });
    const out = await face.gateLaunch({ requiredCards: 2, runDir: tempRoot(), launchShRel: "out/launch.sh" });
    expect(out).toEqual({ verdict: "proceed", queued: false });
  });

  it("卡数不可判（null）＝fail-closed 不排队但发通报：gpu_queue warn 通知在场＋proceed 不阻塞主线", async () => {
    const runDir = tempRoot();
    const face = createLaunchGpuQueueFace({ get: () => undefined }, undefined, {
      env: {},
      awaitWindow: async () => { throw new Error("卡数不可判不应等待"); },
    });
    const out = await face.gateLaunch({ requiredCards: null, runDir, launchShRel: "out/launch.sh" });
    if (out.verdict !== "proceed") throw new Error("应放行不阻塞");
    expect(out.queued).toBe(false);
    expect(out.queue_note).toBe("required_cards_unknown_not_queued");
    const alertsPath = join(runDir, "webui", "alerts.json");
    expect(existsSync(alertsPath)).toBe(true);
    const alerts = JSON.parse(readFileSync(alertsPath, "utf8")) as Array<{ kind: string; level: string; reason: string }>;
    const hit = alerts.find((a) => a.kind === "gpu_queue" && a.level === "warn");
    expect(hit?.reason).toContain("卡数不可判、未排队");
  });

  it("排队生效全链（GPU 忙→等待→命中→琥珀卡批准→放行）：注入窗口桩＋批准面桩，通报与放行回执在场", async () => {
    const runDir = tempRoot();
    const ctx = { get: (service: string) => service === "approval"
      ? { request: async () => "allowed-once" }
      : undefined };
    const face = createLaunchGpuQueueFace(ctx, { callId: "c1" }, {
      env: { ATF_GPU_POLL_MS: "30000" },
      awaitWindow: async (opts) => {
        if (opts === undefined || opts === null) throw new Error("opts 缺席");
        opts.onQueueStatus?.({ required: opts.requiredCards ?? 0, idle: 0, waitedText: "0s", table: [] });
        opts.onQueueStatus?.({ required: opts.requiredCards ?? 0, idle: 2, waitedText: "12s", table: [] });
        return { kind: "hit" as const, snapshot: { waitedText: "12s", gpuIndexes: [0, 1], table: [] } };
      },
    });
    const out = await face.gateLaunch({ requiredCards: 2, runDir, launchShRel: "out/launch.sh" });
    if (out.verdict !== "proceed") throw new Error("命中＋批准应放行");
    expect(out.queued).toBe(true);
    expect(out.waited_text).toBe("12s");
    expect(out.amber).toBe("approved");
    const alerts = JSON.parse(readFileSync(join(runDir, "webui", "alerts.json"), "utf8")) as Array<{ kind: string; level: string; reason: string }>;
    expect(alerts.filter((a) => a.kind === "gpu_queue")).toHaveLength(2); // 首探忙（warn）＋空闲满足（info）
    expect(alerts[0]?.level).toBe("warn");
    expect(alerts[1]?.level).toBe("info");
  });

  it("命中琥珀卡被拒（denied）＝如实上抛裁定（handler 侧不启动）", async () => {
    const ctx = { get: (service: string) => service === "approval"
      ? { request: async () => "denied" }
      : undefined };
    const face = createLaunchGpuQueueFace(ctx, undefined, {
      env: { ATF_GPU_POLL_MS: "30000" },
      awaitWindow: async () => ({ kind: "hit", snapshot: { waitedText: "5s", gpuIndexes: [3], table: [] } }),
    });
    const out = await face.gateLaunch({ requiredCards: 1, runDir: tempRoot(), launchShRel: "out/launch.sh" });
    expect(out).toEqual({ verdict: "denied", outcome: "denied" });
  });
});

describe("批㊶-S4b T2——env 样例注释对齐", () => {
  it("uat.env.example：ATF_GPU_POLL_MS 缺省注释与代码缺省 30_000 一致（不再矛盾）", async () => {
    const { readFileSync: rf } = await import("node:fs");
    const text = rf(join(import.meta.dirname, "../../deploy/profiles/web/overlays/uat.env.example"), "utf8");
    expect(text).toContain("缺省 30000");
    expect(text).not.toContain("缺省 300000");
    expect(text).toContain("ATF_GPU_POLL_MS=30000");
    const { GPU_QUEUE_POLL_MS_DEFAULT } = await import("../../packages/extensions/atf-tools/src/gpuQueueFace.js");
    expect(GPU_QUEUE_POLL_MS_DEFAULT).toBe(30_000);
  });
});
