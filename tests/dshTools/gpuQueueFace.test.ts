/**
 * 批㊶-K 测试锚——GPU 排队编排（含增补三全卡扫描两用例）／训练进料共享面／
 * 档位可见性只读工具（含审批面实值）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGpuWindow,
  formatWaited,
  gpuCycleHit,
  gpuQueuePollMsFromEnv,
  GpuQueueWatcher,
  queueHitText,
  queueStatusText,
} from "../../packages/extensions/atf-tools/src/gpuQueueFace.js";
import { parseTrainerLine, startLossIngest } from "../../src/core/workspace/lossIngest.js";
import { apply as applyAtfTools } from "../../packages/extensions/atf-tools/src/index.js";

const card = (index: string, utilization: string, memoryUsed: string) => ({ index, utilization: `${utilization}%`, memoryUsed: `${memoryUsed}MiB`, memoryTotal: "81920MiB" });

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-k-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-K 项 1 GPU 排队编排（含增补三全卡扫描）", () => {
  it("增补三·多卡命中非 0 号卡：0 号忙 3 号空闲 → 命中卡位 3（确认卡明示卡号）", () => {
    const hit = gpuCycleHit([card("0", "95", "60000"), card("3", "5", "2000")]);
    expect(hit).toEqual({ hit: true, gpuIndex: 3 });
    expect(queueHitText(hit.gpuIndex)).toBe("GPU 3 已空闲，确认开跑？");
  });

  it("增补三·零卡满足继续等待：全忙两周期不触发；连续 2 周期稳定判定保持（先中后忙即清零）", () => {
    const busy = [card("0", "99", "60000"), card("1", "90", "55000")];
    expect(gpuCycleHit(busy).hit).toBe(false);
    const fired: number[] = [];
    const watcher = new GpuQueueWatcher((gpuIndex) => fired.push(gpuIndex));
    watcher.cycle(busy, "1 分");
    watcher.cycle(busy, "2 分");
    expect(fired).toEqual([]);
    watcher.cycle([card("2", "3", "500")], "3 分");
    watcher.cycle(busy, "4 分");
    watcher.cycle([card("2", "3", "500")], "5 分");
    watcher.cycle([card("2", "3", "500")], "6 分");
    expect(fired).toEqual([2]);
  });

  it("解析容错：利用率/显存非数即不命中；等待时长人读格式；排队文案口径", () => {
    expect(gpuCycleHit([card("0", "N/A", "60000")]).hit).toBe(false);
    expect(formatWaited(5_000)).toBe("5 秒");
    expect(formatWaited(125_000)).toBe("2 分 5 秒");
    expect(queueStatusText("1 分")).toContain("排队中");
  });

  it("awaitGpuWindow：注入查询多卡命中非 0 号卡；零卡满足等待至 abort；env 解析（0＝不启用）", async () => {
    const hit = await awaitGpuWindow({
      pollMs: 10,
      query: async () => [card("0", "99", "60000"), card("5", "2", "1000")],
      onWaitTick: () => undefined,
    });
    expect(hit).toEqual({ kind: "hit", gpuIndex: 5, waitedText: expect.stringContaining("秒") });
    const controller = new AbortController();
    const waiting = awaitGpuWindow({
      pollMs: 10,
      query: async () => [card("0", "99", "60000")],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    expect(await waiting).toEqual({ kind: "aborted" });
    expect(gpuQueuePollMsFromEnv({})).toBe(300_000);
    expect(gpuQueuePollMsFromEnv({ ATF_GPU_POLL_MS: "0" })).toBeNull();
    expect(gpuQueuePollMsFromEnv({ ATF_GPU_POLL_MS: "5000" })).toBe(5_000);
  });
});

describe("批㊶-K 项 4 训练进料共享面（lossIngest 单源——两执行径同源）", () => {
  it("parseTrainerLine＋startLossIngest：日志新行落 loss-series（共享模块直测）", async () => {
    const root = tempRoot();
    const logPath = join(root, "train-stdout.log");
    const seriesPath = join(root, "training", "loss-series.json");
    writeFileSync(logPath, "{'loss': 0.5, 'grad_norm': 1.0, 'learning_rate': 1e-4, 'epoch': 1.0}\n");
    expect(parseTrainerLine("无关行")).toBeNull();
    const stop = startLossIngest(logPath, seriesPath, 50);
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    const series = JSON.parse(readFileSync(seriesPath, "utf8")) as Array<{ train_loss: number }>;
    expect(series).toHaveLength(1);
    expect(series[0]?.train_loss).toBe(0.5);
  });
});

interface CapturedTool {
  name: string;
  execute: (args: Record<string, unknown>, exec: { agent?: { session?: unknown } }) => Promise<unknown>;
}

describe("批㊶-K 项 3 atf_permission_status（只读档位可见性——零切换路径）", () => {
  it("返回当前档／部署默认档／全档两维度实值（文件沙箱层＋审批面）；服务缺失如实 unavailable", async () => {
    const registered: CapturedTool[] = [];
    const serviceStub = {
      current: () => "workspace-write",
      defaultPreset: "danger-full-access",
      config: {
        presets: {
          "danger-full-access": { sandbox: "danger-full-access", approval: "ask", name: "Full access" },
          "workspace-write": { sandbox: "workspace-write", approval: "ask" },
          "read-only": { sandbox: "read-only", approval: "ask" },
        },
      },
      catalog: () => ({
        options: [
          { value: "danger-full-access", name: "Full access" },
          { value: "workspace-write", name: "Workspace write" },
          { value: "read-only", name: "Read only" },
        ],
        defaultPreset: "danger-full-access",
      }),
    };
    const ctx = {
      tools: { register: (tool: CapturedTool) => registered.push(tool) },
      get: (service: string) => (service === "permissionPresets" ? serviceStub : undefined),
      on: () => () => true,
      effect: () => undefined,
    };
    applyAtfTools(ctx as never, {
      runsRoot: tempRoot(),
      kernelDir: tempRoot(),
      execHome: tempRoot(),
      logDir: tempRoot(),
      bridgeCommand: "",
      pipelineCommand: `node x`,
      pipelineTimeoutMs: 1000,
    });
    const tool = registered.find((entry) => entry.name === "atf_permission_status");
    expect(tool).toBeDefined();
    const result = (await tool!.execute({}, { agent: { session: { id: "s" } } })) as Record<string, unknown>;
    expect(result["current_preset"]).toBe("workspace-write");
    expect(result["deployment_default"]).toBe("danger-full-access");
    const presets = result["presets"] as Array<Record<string, unknown>>;
    const full = presets.find((preset) => preset.value === "danger-full-access");
    expect(full).toMatchObject({ file_sandbox: "danger-full-access", approval: "ask" });
    expect(JSON.stringify(result)).not.toContain("switch");
    const missing = (await tool!.execute({}, {})) as Record<string, unknown>;
    expect(missing["current_preset"]).toBe("danger-full-access");
    // 服务缺失面
    const registered2: CapturedTool[] = [];
    applyAtfTools(
      { tools: { register: (tool: CapturedTool) => registered2.push(tool) }, get: () => undefined, on: () => () => true, effect: () => undefined } as never,
      { runsRoot: tempRoot(), kernelDir: tempRoot(), execHome: tempRoot(), logDir: tempRoot(), bridgeCommand: "", pipelineCommand: "node x", pipelineTimeoutMs: 1000 },
    );
    const tool2 = registered2.find((entry) => entry.name === "atf_permission_status");
    const unavailable = (await tool2!.execute({}, {})) as Record<string, unknown>;
    expect(unavailable["error"]).toBe("unavailable");
  });
});
