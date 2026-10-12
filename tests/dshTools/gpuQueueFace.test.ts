/**
 * 批㊶-K 测试锚——GPU 排队编排（批㊶-W F6 四合一语义重写：整组判定＋compute-apps
 * 归属＋快速二次确认）／训练进料共享面／档位可见性只读工具（含审批面实值）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  awaitGpuWindow,
  buildCardOccupancyTable,
  classifyCard,
  formatCardTable,
  formatWaited,
  gpuGroupWindow,
  gpuQueuePollMsFromEnv,
  GPU_QUEUE_POLL_MS_DEFAULT,
  GPU_RECHECK_DELAY_MS,
  queueHitText,
  queueStatusText,
} from "../../packages/extensions/atf-tools/src/gpuQueueFace.js";
import { resetResidentBaselineForTest } from "../../packages/extensions/atf-tools/src/gpuQueueFace.js";
import { parseTrainerLine, startLossIngest } from "../../src/core/workspace/lossIngest.js";
import { apply as applyAtfTools } from "../../packages/extensions/atf-tools/src/index.js";

// 批㊶-W：本文件 applyAtfTools 装配面预检（kernelDir=tempRoot 空）——env 显式声明走
// 「env 已配置」路径（preflight ①⑥ 跳过派生与文件核查）。
process.env["ATF_DSH_PIPELINE_COMMAND"] = "node x";

const card = (index: string, utilization: string, memoryUsed: string) => ({ index, utilization: `${utilization}%`, memoryUsed: `${memoryUsed}MiB`, memoryTotal: "81920MiB" });
const app = (pid: string, processName: string, gpuIndex: string) => ({ pid, processName, usedMemory: "1000", gpuIndex });

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-k-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  resetResidentBaselineForTest();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶-W F6 GPU 探活四合一（整组判定＋归属＋快速二次确认）", () => {
  it("④ 归属分类：无进程=空闲；训练特征进程=training；基线/新占用=resident；判定与显存数值无关（10GB 阈值退役）", () => {
    expect(classifyCard([])).toBe("idle");
    expect(classifyCard([app("10", "/usr/local/bin/python3.10", "0")])).toBe("resident");
    expect(classifyCard([app("10", "torchrun", "0")])).toBe("training");
    expect(classifyCard([app("10", "llamafactory-cli", "0")])).toBe("training");
    expect(classifyCard([app("10", "vllm serve", "0"), app("11", "deepspeed", "0")])).toBe("training");
    // 高显存占用但无 compute-apps 进程＝空闲（10GB 固定阈值退役——判定不看显存）
    expect(classifyCard([])).toBe("idle");
  });

  it("④ 常驻基线快照：首探记录 pid 集合，后续同 pid=resident；训练特征优先于基线", () => {
    const first = [app("100", "vllm", "0"), app("200", "python3", "1")];
    buildCardOccupancyTable([card("0", "0", "2000"), card("1", "0", "2000")], first);
    // 首探之后（基线已建），同 pid 仍 resident；新 pid 也是 resident；训练特征一律 training
    const table = buildCardOccupancyTable([card("0", "0", "2000"), card("1", "0", "2000"), card("2", "0", "2000")], [
      app("100", "vllm", "0"), app("300", "python3", "1"), app("400", "torchrun", "2"),
    ]);
    expect(table.find((row) => row.index === "0")?.occupancy).toBe("resident");
    expect(table.find((row) => row.index === "1")?.occupancy).toBe("resident");
    expect(table.find((row) => row.index === "2")?.occupancy).toBe("training");
  });

  it("③ 整组判定：requiredCards 张全部空闲才命中；任一占用即不命中；apps 不可得保守不命中", () => {
    const cards = [card("0", "0", "0"), card("1", "0", "0"), card("2", "95", "60000")];
    const apps = [app("9", "python3", "2")];
    expect(gpuGroupWindow(cards, apps, 2).hit).toBe(true);
    expect(gpuGroupWindow(cards, apps, 3).hit).toBe(false); // 只 2 卡空闲，需 3——不命中
    expect(gpuGroupWindow(cards, [app("9", "python3", "0"), app("8", "python3", "1")], 2).hit).toBe(false); // 占两卡剩 1——不命中
    expect(gpuGroupWindow(cards, null, 1).hit).toBe(false); // compute-apps 不可得＝保守不命中（fail-closed）
    const hit = gpuGroupWindow(cards, apps, 2);
    expect(hit.gpuIndexes).toEqual([0, 1]);
  });

  it("⑤ 全卡状态表：逐卡三态＋利用率/显存/进程摘要；amber 卡文案含全卡表", () => {
    const table = buildCardOccupancyTable(
      [card("0", "0", "500"), card("1", "99", "60000"), card("2", "3", "1000")],
      [app("9", "python3", "0"), app("8", "torchrun", "1")],
    );
    expect(table).toHaveLength(3);
    expect(table.find((row) => row.index === "0")).toMatchObject({ occupancy: "resident", process: "9 python3" });
    expect(table.find((row) => row.index === "1")?.occupancy).toBe("training");
    expect(table.find((row) => row.index === "2")).toMatchObject({ occupancy: "idle", process: "" });
    const text = formatCardTable(table);
    expect(text).toContain("GPU0 常驻");
    expect(text).toContain("GPU1 训练");
    expect(text).toContain("GPU2 空闲");
    const hitText = queueHitText([0, 2], table);
    expect(hitText).toContain("GPU 0、2 已空闲");
    expect(hitText).toContain("GPU1 训练");
    expect(queueStatusText("1 分", 4)).toContain("整组 4 卡");
  });

  it("① 快速二次确认：首探命中→复探仍命中即放行（不再要求连续 2 个轮询周期）；复探丢窗回轮询", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
    const idleCards = [card("0", "2", "500"), card("1", "1", "400")];
    const busyCards = [card("0", "2", "500"), card("1", "99", "60000")];
    let firstCall = 0;
    const hit = await awaitGpuWindow({
      pollMs: 10,
      requiredCards: 2,
      query: async () => (firstCall++ === 0 ? idleCards : idleCards),
      queryApps: async () => [],
      sleep,
      onWaitTick: () => undefined,
    });
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") expect(hit.snapshot.gpuIndexes).toEqual([0, 1]);
    expect(sleeps).toContain(GPU_RECHECK_DELAY_MS); // 首探命中→7s 复探
    // 复探丢窗（1 号卡被 compute-apps 占用——F6 判定不看利用率）→ 回轮询，下一周期恢复命中
    resetResidentBaselineForTest();
    const seq = [
      { cards: idleCards, apps: [] as Array<ReturnType<typeof app>> },
      { cards: busyCards, apps: [app("7", "python3", "1")] },
      { cards: idleCards, apps: [] as Array<ReturnType<typeof app>> },
    ];
    let call = 0;
    const hit2 = await awaitGpuWindow({
      pollMs: 10,
      requiredCards: 2,
      query: async () => seq[Math.min(call, 2)]!.cards,
      queryApps: async () => {
        const idx = Math.min(call, 2);
        call += 1;
        return seq[idx]!.apps;
      },
      sleep,
      onWaitTick: () => undefined,
    });
    expect(hit2.kind).toBe("hit");
    expect(call).toBe(4); // 首探＋复探(丢窗)＋次周期首探＋次复探＝4 轮探测——轮询恢复语义
  });

  it("② 轮询缺省 30s（300s 退役）；0＝不启用；等待时长人读格式", async () => {
    expect(GPU_QUEUE_POLL_MS_DEFAULT).toBe(30_000);
    expect(gpuQueuePollMsFromEnv({})).toBe(30_000);
    expect(gpuQueuePollMsFromEnv({ ATF_GPU_POLL_MS: "0" })).toBeNull();
    expect(gpuQueuePollMsFromEnv({ ATF_GPU_POLL_MS: "5000" })).toBe(5_000);
    expect(formatWaited(5_000)).toBe("5 秒");
    expect(formatWaited(125_000)).toBe("2 分 5 秒");
  });

  it("awaitGpuWindow：零卡满足等待至 abort；命中带全卡状态表", async () => {
    const controller = new AbortController();
    const waiting = awaitGpuWindow({
      pollMs: 10,
      requiredCards: 1,
      query: async () => [card("0", "99", "60000")],
      queryApps: async () => [app("9", "python3", "0")],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 80);
    expect(await waiting).toEqual({ kind: "aborted" });
    const hit = await awaitGpuWindow({
      pollMs: 10,
      requiredCards: 1,
      query: async () => [card("4", "2", "1000")],
      queryApps: async () => [],
      sleep: async () => undefined,
      onWaitTick: () => undefined,
    });
    expect(hit.kind).toBe("hit");
    if (hit.kind === "hit") {
      expect(hit.snapshot.gpuIndexes).toEqual([4]);
      expect(hit.snapshot.table.find((row) => row.index === "4")?.occupancy).toBe("idle");
    }
  });

  it("排队即时反馈：onQueueStatus 首探即报（需 N 空闲 M）＋空闲数变化再报（不刷屏）——owner 批㊶-W 反馈增补", async () => {
    const reports: Array<{ required: number; idle: number }> = [];
    const seqs = [
      { cards: [card("0", "99", "60000"), card("1", "98", "50000")], apps: [app("9", "python3", "0"), app("8", "python3", "1")] },
      { cards: [card("0", "99", "60000"), card("1", "98", "50000")], apps: [app("9", "python3", "0"), app("8", "python3", "1")] },
      { cards: [card("0", "2", "500"), card("1", "98", "50000")], apps: [app("9", "python3", "1")] },
      { cards: [card("0", "2", "500"), card("1", "2", "400")], apps: [] },
    ];
    let call = 0;
    const hit = await awaitGpuWindow({
      pollMs: 5,
      requiredCards: 2,
      query: async () => seqs[Math.min(call, 3)]!.cards,
      queryApps: async () => {
        const s = seqs[Math.min(call, 3)]!;
        call += 1;
        return s.apps;
      },
      sleep: async () => undefined,
      onWaitTick: () => undefined,
      onQueueStatus: (status) => reports.push({ required: status.required, idle: status.idle }),
    });
    expect(hit.kind).toBe("hit");
    // 首探报（0 空闲）→ 变化报（1）→ 变化报（2，命中）——同值轮不重复报
    expect(reports).toEqual([{ required: 2, idle: 0 }, { required: 2, idle: 1 }, { required: 2, idle: 2 }]);
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
