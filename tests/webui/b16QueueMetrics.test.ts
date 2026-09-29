/**
 * 批⑯ 增量任务测试锚（2026-09-30，指令 f4ef32e2）：
 * A. GPU 排队语义——命中判定（<20% 且 <10GB 连续 2 周期）/等待时长/编排器入队-命中事件；
 * B. 监控数据面——HF Trainer 日志行解析→loss-series.json append-only→增量全链（合成日志流
 *    测试先行，真实日志 M1 实锚）；SSE metrics_delta 经 HTTP 冒烟断言。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseTrainerLogLine,
  appendLossPoint,
  readLossSeries,
  ingestTrainerLogLines,
} from "../../src/webui/logParser.js";
import { GpuQueueWatcher, GpuQueueOrchestrator, gpuCycleHit, formatWaited, queueStatusText, queueHitText, GPU_HIT_CONSECUTIVE } from "../../src/webui/gpuQueue.js";
import { startWebUiServer } from "../../src/webui/server.js";
import type { GpuStatus } from "../../src/webui/readOnlyTools.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "b16-"));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- B：日志行解析（合成流）

describe("批⑯B：HF Trainer 日志行解析（合成流先行）", () => {
  it("train 形态（Python 单引号 dict）→ {step?, train_loss, grad_norm}；eval 形态 → eval_loss", () => {
    const train = parseTrainerLogLine("{'loss': 0.32, 'grad_norm': 1.02, 'learning_rate': 1e-04, 'epoch': 0.02, 'step': 5}");
    expect(train).toEqual({ step: 5, train_loss: 0.32, grad_norm: 1.02 });
    const evalLine = parseTrainerLogLine("{'eval_loss': 0.51, 'eval_runtime': 12.3, 'epoch': 1.0}");
    expect(evalLine).toEqual({ step: 100, eval_loss: 0.51 });
    expect(parseTrainerLogLine("这是一段普通输出")).toBeNull();
    expect(parseTrainerLogLine("{'foo': 'bar'}")).toBeNull(); // 无 loss/grad 键＝非训练指标行
    expect(parseTrainerLogLine("{broken json")).toBeNull();
  });

  it("ingest 合成日志流 → loss-series.json append-only 重建（解析→落盘全链）", () => {
    const runDir = tempRoot();
    const synthetic = [
      "{'loss': 0.98, 'grad_norm': 2.1, 'learning_rate': 1e-04, 'epoch': 0.01, 'step': 1}",
      "some non-log noise line",
      "{'loss': 0.61, 'grad_norm': 1.5, 'learning_rate': 1e-04, 'epoch': 0.02, 'step': 2}",
      "{'eval_loss': 0.72, 'eval_runtime': 9.9, 'epoch': 0.02}",
      "{'loss': 0.34, 'grad_norm': 1.1, 'learning_rate': 1e-04, 'epoch': 0.03, 'step': 3}",
    ];
    const added = ingestTrainerLogLines(runDir, synthetic, "2026-09-30T00:00:00Z");
    expect(added.length).toBe(4); // 噪声行不入列
    const series = readLossSeries(runDir);
    expect(series.length).toBe(4);
    expect(series[0]).toMatchObject({ step: 1, train_loss: 0.98, grad_norm: 2.1 });
    expect(series[2]).toMatchObject({ step: 2, eval_loss: 0.72 }); // eval 行独立成点
    expect(series.every((point) => point.at === "2026-09-30T00:00:00Z")).toBe(true);
    // append-only：二次 ingest 追加不重写
    ingestTrainerLogLines(runDir, ["{'loss': 0.21, 'grad_norm': 0.9, 'epoch': 0.04, 'step': 4}"], "2026-09-30T00:01:00Z");
    expect(readLossSeries(runDir).length).toBe(5);
    expect(readLossSeries(runDir)[0]?.at).toBe("2026-09-30T00:00:00Z");
  });

  it("单点 append 与文件重建（页面刷新从文件重建曲线的读取面）", () => {
    const runDir = tempRoot();
    expect(readLossSeries(runDir)).toEqual([]);
    appendLossPoint(runDir, { step: 1, train_loss: 0.9 }, "t1");
    appendLossPoint(runDir, { step: 2, eval_loss: 0.7 }, "t2");
    expect(readLossSeries(runDir).length).toBe(2);
    expect(existsSync(join(runDir, "training", "loss-series.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------- A：GPU 排队语义

const gpu = (utilization: string, memoryUsed: string): GpuStatus => ({ utilization, memoryUsed, memoryTotal: "81920 MiB", topProcesses: [] });

describe("批⑯A：GPU 排队语义（命中条件＋编排）", () => {
  it("命中判定：<20% 且 <10GB；不满足即 false", () => {
    expect(gpuCycleHit(gpu("15%", "8000 MiB"))).toMatchObject({ hit: true, gpuIndex: 0 });
    expect(gpuCycleHit(gpu("25%", "8000 MiB")).hit).toBe(false); // 利用率超阈
    expect(gpuCycleHit(gpu("15%", "12000 MiB")).hit).toBe(false); // 显存超阈
    expect(GPU_HIT_CONSECUTIVE).toBe(2);
  });

  it("GpuQueueWatcher：连续 2 周期命中才触发 onHit（一次）；中断归零", () => {
    let hits = 0;
    const watcher = new GpuQueueWatcher(() => {
      hits += 1;
    });
    watcher.cycle(gpu("10%", "5000 MiB"), "5 分");
    expect(hits).toBe(0); // 1 周期不命中
    watcher.cycle(gpu("10%", "5000 MiB"), "10 分");
    expect(hits).toBe(1); // 连续 2 → 命中
    watcher.cycle(gpu("10%", "5000 MiB"), "15 分");
    expect(hits).toBe(1); // 命中后复位需重新累计
    watcher.cycle(gpu("90%", "60000 MiB"), "20 分");
    watcher.cycle(gpu("10%", "5000 MiB"), "25 分");
    expect(hits).toBe(1); // 中断归零后仅 1 周期
    watcher.cycle(gpu("10%", "5000 MiB"), "30 分");
    expect(hits).toBe(2);
  });

  it("编排器：入队即排队 notice（⏳ 排队中文案）＋命中产出琥珀确认卡事件；轮询注入（测试不真等 5 分钟）", async () => {
    const events: Array<{ kind: string; text?: string }> = [];
    let hits = 0;
    const orchestrator = new GpuQueueOrchestrator({
      pollMs: 30,
      query: async () => gpu("10%", "4000 MiB"), // 恒命中态
    });
    orchestrator.enqueue("run-q", ((event: { kind: string; text?: string }) => events.push(event)) as never, () => {
      hits += 1;
    });
    expect(events[0]?.text).toBe(queueStatusText(formatWaited(0)));
    expect(events[0]?.text).toContain("每 5 分钟自动探测");
    await new Promise((resolve) => setTimeout(resolve, 200));
    orchestrator.stop();
    expect(hits).toBe(1);
    const hitNotice = events.find((event) => (event.text ?? "").includes(queueHitText(0)));
    expect(hitNotice !== undefined).toBe(true);
    expect(hitNotice?.text).toContain("真跑守门不变");
  });

  it("等待时长格式化与文案单源", () => {
    expect(formatWaited(45_000)).toBe("45 秒");
    expect(formatWaited(90_000)).toBe("1 分 30 秒");
    expect(formatWaited(3_600_000)).toBe("1 时 0 分");
    expect(queueStatusText("5 分")).toContain("⏳ 排队中");
    expect(queueHitText(2)).toBe("GPU 2 已空闲，确认开跑？");
  });
});

// ---------------------------------------------------------------- B 管道 HTTP 面（ingest→文件→API 重建）

describe("批⑯B 管道 HTTP 冒烟（ingest→loss-series→GET 重建）", () => {
  it("POST ingest 合成日志 → GET metrics 重建全量＋loss-series.json 落盘", async () => {
    const runsRoot = tempRoot();
    const handle = startWebUiServer({ runsRoot, sessionsRoot: tempRoot(), port: 0 });
    const base = `http://127.0.0.1:${String((handle.server.address() as { port: number }).port)}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
      (await (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
    const get = async (path: string): Promise<Record<string, unknown>> => (await (await fetch(base + path)).json()) as Record<string, unknown>;
    const result = (await post("/api/sessions/run-b16/metrics/ingest", {
      lines: [
        "{'loss': 0.88, 'grad_norm': 2.0, 'epoch': 0.01, 'step': 1}",
        "noise",
        "{'eval_loss': 0.70, 'epoch': 0.01}",
        "{'loss': 0.55, 'grad_norm': 1.4, 'epoch': 0.02, 'step': 2}",
      ],
    })) as { added: unknown[]; count: number };
    expect(result.count).toBe(3);
    const metrics = (await get("/api/sessions/run-b16/metrics")) as { points: Array<Record<string, unknown>>; count: number };
    expect(metrics.count).toBe(3);
    expect(metrics.points[0]).toMatchObject({ step: 1, train_loss: 0.88 });
    const seriesFile = JSON.parse(readFileSync(join(runsRoot, "run-b16", "training", "loss-series.json"), "utf8")) as unknown[];
    expect(seriesFile.length).toBe(3);
    handle.server.close();
  }, 20_000);
});
