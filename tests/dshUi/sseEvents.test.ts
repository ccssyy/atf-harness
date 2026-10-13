// 批㊶-SSE S6——真 SSE 事件流测试（鉴权／头三件套／全键 diff／心跳／事件日志滚动上限／
// Last-Event-ID 定位回放与越界回退／连接上限与 close 清理／客户端回退钉子）。
// e2e 形态：eventsRouteHandler 工厂挂真 http server，node:http 客户端收流断言（非注入路径）。
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEventLog,
  diffMonitorKeys,
  eventsRouteHandler,
  MONITOR_EVENT_KEYS,
  publishMonitorEvents,
  readEventsAfter,
  resetSseStreamStateForTest,
  sseEventlogDirOf,
  SSE_EVENTLOG_MAX_LINES,
  sseFrame,
} from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-sse-"));
  tempRoots.push(root);
  return root;
};
const servers: Server[] = [];

beforeEach(() => {
  process.env["ATF_SSE_HEARTBEAT_MS"] = "80";
  process.env["ATF_SSE_MAX_CONNECTIONS"] = "8";
});
afterEach(() => {
  delete process.env["ATF_SSE_HEARTBEAT_MS"];
  delete process.env["ATF_SSE_MAX_CONNECTIONS"];
  resetSseStreamStateForTest();
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});

const baseMonitor = (gpu: number, runs: number): Record<string, unknown> => ({
  schema: "AtfMonitor/v1",
  generated_at: new Date().toISOString(),
  gpu: { offline: false, utilization: `${gpu}%` },
  gpu_all: [{ index: 0, utilization: "1%", memoryUsed: "100MiB", memoryTotal: "80GiB" }],
  runs: runs > 0 ? [{ run_id: `r${runs}`, state: "registered", segments: [] }] : [],
});

/** 收 SSE 流前 N 帧或超时（原始文本断言——帧格式本身即被测面）。 */
const collectStream = (url: string, headers: Record<string, string>, ms: number): Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let text = "";
      const timer = setTimeout(() => {
        res.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
      }, ms);
      res.on("data", (chunk: Buffer) => { text += String(chunk); });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", reject);
    req.end();
  });

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => handler(req, res));
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`));
  });

describe("批㊶-SSE D1②——全 monitor 增量 diff（顶层键闭集）", () => {
  it("事件键闭集＝monitor 顶层语义键（schema 常量/generated_at 水印不入 diff）", () => {
    expect(MONITOR_EVENT_KEYS).toEqual(["gpu", "gpu_all", "runs"]);
  });
  it("首帧基线：prev null 只入缓存——返回全键（调用方按首帧基线处理不发光）", () => {
    expect(diffMonitorKeys(null, baseMonitor(1, 0))).toEqual(["gpu", "gpu_all", "runs"]);
  });
  it("generated_at 翻新而状态未变 → 零事件（tick 水印不误报）", () => {
    const a = baseMonitor(3, 2);
    const b = { ...a, generated_at: new Date(Date.now() + 5000).toISOString() };
    expect(diffMonitorKeys(a, b)).toEqual([]);
  });
  it("gpu 变化 → [gpu]；runs 变化 → [runs]；同变 → 双键有序", () => {
    const a = baseMonitor(3, 2);
    expect(diffMonitorKeys(a, baseMonitor(9, 2))).toEqual(["gpu"]);
    expect(diffMonitorKeys(a, baseMonitor(3, 5))).toEqual(["runs"]);
    expect(diffMonitorKeys(a, baseMonitor(9, 5))).toEqual(["gpu", "runs"]);
  });
  it("sseFrame 四要素帧形：id/event/data 三行+空行收尾", () => {
    expect(sseFrame({ id: 7, event: "gpu", data: { offline: false } })).toBe(
      'id: 7\nevent: gpu\ndata: {"offline":false}\n\n');
  });
});

describe("批㊶-SSE D2②——事件日志滚动上限与 Last-Event-ID 回放", () => {
  it("append：events.jsonl 逐行落盘（行数计数）", () => {
    const root = tempRoot();
    expect(appendEventLog(root, [
      { id: 1, event: "gpu", data: { offline: false } },
      { id: 2, event: "runs", data: [] },
    ])).toBe(true);
    const file = join(sseEventlogDirOf(root), "events.jsonl");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });
  it("滚动上限：超 2000 行改档归档（现役+1 代，总量硬上限），序号跨滚动单调", () => {
    const root = tempRoot();
    const batch = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, event: "gpu", data: { n: i } }));
    appendEventLog(root, batch);                       // 1500 行
    appendEventLog(root, batch.map((e) => ({ ...e, id: e.id + 1500 }))); // 累计 3000 > 2000 → 滚动
    const dir = sseEventlogDirOf(root);
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);
    const currentLines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(currentLines.length).toBe(1500); // 整档滚动后现役=次批全量（现役永不超 2000——硬约束）
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBe(2); // 现役+1 代归档——硬上限
    // 整档滚动：归档=首代（id 1-1500），现役=次批（id 1501-3000）
    const archiveIds = readFileSync(join(dir, "events.1.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { id: number }).id);
    expect(archiveIds).toEqual(Array.from({ length: 1500 }, (_, i) => i + 1));
    // 序号跨滚动单调：日志尾 id=3000 → 下一事件 3001
    expect(readEventsAfter(root, 3000)).toEqual([]);
    expect(readEventsAfter(root, 2998)?.map((e) => e.id)).toEqual([2999, 3000]);
  });
  it("回放定位：lastId 后按序补发；lastId=0 → 全量事件；尾部 → 空数组", () => {
    const root = tempRoot();
    appendEventLog(root, [
      { id: 1, event: "gpu", data: 1 },
      { id: 2, event: "runs", data: 2 },
      { id: 3, event: "gpu_all", data: 3 },
    ]);
    expect(readEventsAfter(root, 1)?.map((e) => e.id)).toEqual([2, 3]);
    expect(readEventsAfter(root, 0)?.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(readEventsAfter(root, 3)).toEqual([]);
  });
  it("越界 fail-closed：日志缺席/lastId 早于最旧保留行/lastId 超尾 → null（调用方回退 snapshot）", () => {
    const root = tempRoot();
    expect(readEventsAfter(root, 1)).toBeNull(); // 无日志
    appendEventLog(root, [{ id: 10, event: "gpu", data: 1 }]); // 模拟滚动后只余 id≥10
    expect(readEventsAfter(root, 5)).toBeNull(); // 早于最旧——无缝不可保证
    expect(readEventsAfter(root, 99)).toBeNull(); // 超尾（日志重置/失踪）
    expect(readEventsAfter(root, 10)).toEqual([]);
  });
});

describe("批㊶-SSE S1/S3/S4——端点 e2e（真 http server 非注入）", () => {
  const setup = async (reject?: (req: IncomingMessage) => 401 | 403 | undefined): Promise<{ url: string; root: string }> => {
    const root = tempRoot();
    const handler = eventsRouteHandler({
      runsRoot: root,
      reject: reject ?? (() => undefined),
    });
    const url = await listen(handler);
    // 基线入缓存（首 publish 不发光——初态由 snapshot 帧承载）
    publishMonitorEvents(root, baseMonitor(1, 1));
    return { url, root };
  };

  it("鉴权拒绝：requestRejection 401/403 透传（fail-closed，不自造鉴权）", async () => {
    const { url } = await setup(() => 401);
    const res = await collectStream(url, {}, 300);
    expect(res.status).toBe(401);
    const { url: url3 } = await setup(() => 403);
    const res3 = await collectStream(url3, {}, 300);
    expect(res3.status).toBe(403);
  });

  it("头三件套＋retry 首帧＋snapshot 帧（全键合集，形态=monitor 白名单）", async () => {
    const { url, root } = await setup();
    publishMonitorEvents(root, baseMonitor(2, 2)); // 事件 1: gpu / 2: gpu_all / 3: runs
    const res = await collectStream(url, {}, 400);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.text.startsWith("retry: 5000\n")).toBe(true);
    expect(res.text).toContain("event: snapshot\n");
    const snapshotLine = res.text.split("\n").find((l) => l.startsWith("data: "));
    expect(snapshotLine).toBeDefined();
    const snapshot = JSON.parse((snapshotLine ?? "data: {}").slice(6)) as Record<string, unknown>;
    expect(snapshot).toHaveProperty("runs");
    expect(snapshot).toHaveProperty("gpu");
  });

  it("Last-Event-ID 定位回放：补发其后事件（不重发 snapshot）", async () => {
    const { url, root } = await setup();
    publishMonitorEvents(root, baseMonitor(2, 2)); // 事件 1-3
    const res = await collectStream(url, { "last-event-id": "1" }, 400);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("event: snapshot");
    expect(res.text).toContain("id: 2\nevent: gpu_all\n");
    expect(res.text).toContain("id: 3\nevent: runs\n");
  });

  it("越界回退：last-event-id 超尾 → 全量 snapshot 路径（fail-closed 如实）", async () => {
    const { url, root } = await setup();
    publishMonitorEvents(root, baseMonitor(2, 2));
    const res = await collectStream(url, { "last-event-id": "999" }, 400);
    expect(res.text).toContain("event: snapshot\n");
  });

  it("心跳：80ms（env 注入）→ ': ping' 注释帧到达（不携带 event/data）", async () => {
    const { url } = await setup();
    const res = await collectStream(url, {}, 500);
    expect(res.text).toContain(": ping\n\n");
  });

  it("增量推送：连接后 publish 变化键 → 对应事件帧按 id 单调到达", async () => {
    const { url, root } = await setup();
    // 连接建立后（snapshot 已写出）再发布增量——发布不 await 收流（并行时序）
    setTimeout(() => publishMonitorEvents(root, baseMonitor(9, 1)), 200);
    const res = await collectStream(url, {}, 800);
    await new Promise((r) => setTimeout(r, 200));
    expect(res.text).toContain("event: gpu\n");
    expect(res.text).toContain('"utilization":"9%"');
    // id 单调：snapshot id 之后
    const ids = [...res.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]!);
  });

  it("连接上限：env 可配——并发占满后超限 503 fail-closed", async () => {
    process.env["ATF_SSE_MAX_CONNECTIONS"] = "2";
    const { url } = await setup();
    // 两条并发长连接占满名额
    const p1 = collectStream(url, {}, 600);
    await new Promise((r) => setTimeout(r, 120));
    const p2 = collectStream(url, {}, 600);
    await new Promise((r) => setTimeout(r, 120));
    const third = await collectStream(url, {}, 200);
    expect(third.status).toBe(503);
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.status).toBe(200);
    expect(s2.status).toBe(200);
  });

  it("close 清理：客户端断开 → 连接表回收（上限名额释放）", async () => {
    const { url } = await setup();
    process.env["ATF_SSE_MAX_CONNECTIONS"] = "1";
    // 占住唯一名额 400ms 后客户端自行断开（collectStream 超时 destroy → 服务端 close 清理）
    const first = collectStream(url, {}, 400);
    await new Promise((r) => setTimeout(r, 150));
    const blocked = await collectStream(url, {}, 150);
    expect(blocked.status).toBe(503);
    await new Promise((r) => setTimeout(r, 250)); // 首连接 400ms 到期 destroy → close 清理落地
    const again = await collectStream(url, {}, 200); // 名额已随 close 释放
    expect(again.status).toBe(200);
    await first;
  });
});

describe("批㊶-SSE S5——客户端订阅钉子（裸服务源面锚）", () => {
  const clientSource = (): string => readFileSync(join(__dirname, "../../packages/extensions/atf-ui/client.js"), "utf8");
  it("EventSource 单例＋按 event 键分路＋失败静默回退轮询（降级不降功能）", () => {
    const src = clientSource();
    expect(src).toContain("new EventSource('/atf-ui/events')");
    expect(src).toContain("es.addEventListener('snapshot'");
    expect(src).toContain("['gpu', 'gpu_all', 'runs']");
    expect(src).toContain("es.onerror = function() { /* 静默回退");
    expect(src).toContain("subscribeMonitorPatch");
    expect(src).toContain("sseState.failed = true"); // EventSource 缺席/异常 → 回退轮询路
  });
  it("订阅合并语义：snapshot 全量替换、键增量合并进既有 monitor（渲染同一份 data）", () => {
    const src = clientSource();
    expect(src).toContain("if (key === 'snapshot' && value !== null && typeof value === 'object') { setData(value); return }");
    expect(src).toContain("next[key] = value");
  });
});

describe("批㊶-SSE 数据面零改动锚", () => {
  it("事件键与 monitor 白名单同源：payload 直取 buildMonitorSnapshot 产物键（无新增字段面）", () => {
    // diff 只在 monitor 顶层语义键上发生——payload 即 monitor.json 对应键值原形（同源纪律）
    expect(diffMonitorKeys(null, baseMonitor(1, 1)).every((k) => ["gpu", "gpu_all", "runs"].includes(k))).toBe(true);
    void appendFileSync; void writeFileSync; void existsSync;
  });
});
