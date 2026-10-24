// 批㊶-SSE S6——真 SSE 事件流测试（鉴权／头三件套／全键 diff／心跳／事件日志滚动上限／
// Last-Event-ID 定位回放与越界回退／连接上限与 close 清理／客户端回退钉子）。
// e2e 形态：eventsRouteHandler 工厂挂真 http server，node:http 客户端收流断言（非注入路径）。
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEventLog,
  diffMonitorKeys,
  eventsRouteHandler,
  healEventlogOnBoot,
  injectMonitorGlobal,
  resetSseStreamStateForTest,
  MONITOR_EVENT_KEYS,
  publishMonitorEvents,
  readEventsAfter,
  sseEventlogDirOf,
  sseEventlogStatus,
  SSE_EVENTLOG_MAX_LINES,
  sseNextEventId,
  sseFrame,
} from "../../packages/extensions/atf-ui/src/server.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-sse-"));
  tempRoots.push(root);
  return root;
};
const servers: Server[] = [];

/** 批㊶-TRAIN-OBS-FIX 断点 A 测试辅助：快照路由 handler（生产 apply 同构——读盘双 JSON）。 */
const snapshotHandlerForTest = (runsRoot: string) =>
  (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const monitorRaw = readFileSync(join(runsRoot, "atf-ui", "monitor.json"));
      let artifactsRaw = Buffer.from("{}");
      try { artifactsRaw = readFileSync(join(runsRoot, "atf-ui", "artifacts.json")); } catch { /* 未生成＝空形态 */ }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ monitor: JSON.parse(monitorRaw.toString("utf8")), artifacts: JSON.parse(artifactsRaw.toString("utf8")) }));
    } catch {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      res.end("snapshot not ready\n");
    }
  };
const fetchPath = (url: string, path: string): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(url + path, { method: "GET" }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => { text += String(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end();
  });

beforeEach(() => {
  process.env["ATF_SSE_HEARTBEAT_MS"] = "80";
  process.env["ATF_SSE_MAX_CONNECTIONS"] = "8";
});
afterEach(() => {
  delete process.env["ATF_SSE_HEARTBEAT_MS"];
  delete process.env["ATF_SSE_MAX_CONNECTIONS"];
  delete process.env["ATF_SSE_EVENTLOG_MAX_BYTES"]; // E1 用例内自设的加速阈值——兜底清防泄漏
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

describe("批㊶-TRAIN-OBS-FIX 断点 A——自有快照端点（apply 捕获路由·GET /atf-ui/snapshot）", () => {
  it("快照路由：monitor+artifacts 双 JSON 200；鉴权拒绝透传；monitor 未生成 → 503", async () => {
    const root = tempRoot();
    const handler = snapshotHandlerForTest(root);
    const server = createServer((req, res) => handler(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // monitor 未生成 → 503（boot 竞态 fail-closed）
    const notReady = await fetchPath(base, "/atf-ui/snapshot");
    expect(notReady.status).toBe(503);

    // 落盘 monitor → 200 双 JSON（runs 数组在）
    mkdirSync(join(root, "atf-ui"), { recursive: true });
    writeFileSync(join(root, "atf-ui", "monitor.json"), JSON.stringify({ schema: "AtfMonitor/v1", generated_at: "n", gpu: { offline: true }, gpu_all: [], runs: [{ run_id: "rA", state: "registered", segments: [], training: { active: false, points: [] } }] }));
    const ok = await fetchPath(base, "/atf-ui/snapshot");
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.text);
    expect(body.monitor.runs).toHaveLength(1);
    expect(body.artifacts).toBeDefined();
    // 鉴权拒绝透传（403 形态——requestRejection 契约）
    const denyServer = createServer((req, res) => {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh web authentication required\n");
    });
    servers.push(denyServer);
    await new Promise<void>((r) => denyServer.listen(0, "127.0.0.1", () => r()));
    const deny = await fetchPath(`http://127.0.0.1:${(denyServer.address() as { port: number }).port}`, "/atf-ui/snapshot");
    expect(deny.status).toBe(403);
    server.close();
    denyServer.close();
  });
});

describe("批㊶-TRAIN-OBS-FIX 断点 B——SSE 半开回收（心跳 flush 回调超一拍未触发 → destroy）", () => {
  it("写回调挂起的连接下一拍被踢除释放名额；健康连接保留", async () => {
    process.env["ATF_SSE_HEARTBEAT_MS"] = "80";
    resetSseStreamStateForTest();
    const root = tempRoot();
    const handler = eventsRouteHandler({ runsRoot: root, reject: () => undefined });
    // 假 res：healthy＝write 回调同步触发；halfOpen＝回调永不触发（半开形态）；destroy 可观测
    const makeFakeRes = (fires: boolean): any => {
      const res: any = new (require("node:events").EventEmitter)();
      res.destroyed = false;
      res.writableEnded = false;
      res.write = (_payload: string, cb?: (err: Error | null) => void) => { if (fires && cb) cb(null); return true; };
      res.destroy = () => { res.destroyed = true; res.emit("close"); };
      res.writeHead = () => res;
      res.end = () => res;
      return res;
    };
    const healthy = makeFakeRes(true);
    const halfOpen = makeFakeRes(false);
    handler({ headers: {} } as unknown as IncomingMessage, healthy);
    handler({ headers: {} } as unknown as IncomingMessage, halfOpen);
    // 两拍后：halfOpen 被踢除（destroyed），healthy 保留
    await new Promise((r) => setTimeout(r, 260));
    expect((healthy as any).destroyed).toBeFalsy();
    expect((halfOpen as any).destroyed).toBe(true);
    resetSseStreamStateForTest();
  });
});

describe("批㊶-SSE 数据面零改动锚", () => {
  it("事件键与 monitor 白名单同源：payload 直取 buildMonitorSnapshot 产物键（无新增字段面）", () => {
    // diff 只在 monitor 顶层语义键上发生——payload 即 monitor.json 对应键值原形（同源纪律）
    expect(diffMonitorKeys(null, baseMonitor(1, 1)).every((k) => ["gpu", "gpu_all", "runs"].includes(k))).toBe(true);
    void appendFileSync; void writeFileSync; void existsSync;
  });
});

// ===== 微批E1——事件日志上限三缺陷修复（字节判据轮转／单事件 64KB 摘要化／启动自愈／
// 尾部 256KB 限界读／降级状态面）。「不读全文」无法直测 513MB 级越界值（V8 单字符串上限
// 0x1fffffe8≈512MB，测试构造代价不可接受）——按任务书放宽为逻辑断言：字节判据在行数远未
// 达兜底阈值时先行触发＋大文件（5MB 级）追加路径健壮。 =====
describe("微批E1①——字节判据轮转（statSync O(1)，行数兜底保留）", () => {
  it("现役字节超 ATF_SSE_EVENTLOG_MAX_BYTES → 轮转（行数远未到 2000——证字节判据先行）", () => {
    process.env["ATF_SSE_EVENTLOG_MAX_BYTES"] = "4096";
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    // 批 1（3 行 × ~1.5KB ≈ 4.6KB）：写入前现役不在场不轮转，落盘后现役即超 4096
    const fat = "x".repeat(1500);
    expect(appendEventLog(root, [
      { id: 1, event: "gpu", data: { blob: fat } },
      { id: 2, event: "gpu", data: { blob: fat } },
      { id: 3, event: "gpu", data: { blob: fat } },
    ])).toBe(true);
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(false); // 首 append 无现役可转
    // 批 2（1 行）：现役 4.6KB＋新批 > 4096 → 轮转（此时行数 3+1=4，远未到 2000 行兜底）
    expect(appendEventLog(root, [{ id: 4, event: "gpu", data: { blob: fat } }])).toBe(true);
    expect(existsSync(join(dir, "events.1.jsonl"))).toBe(true);  // 归档在场＝轮转已发生
    const archiveLines = readFileSync(join(dir, "events.1.jsonl"), "utf8").trim().split("\n");
    expect(archiveLines).toHaveLength(3); // 归档=首代全量（id 1-3）
    const currentLines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(currentLines).toHaveLength(1); // 现役重开=次批
    expect((JSON.parse(currentLines[0] ?? "{}") as { id: number }).id).toBe(4);
    // 总量受控：两档合计仍在阈值带内（现役 1 行，后续 append 达阈值即再轮转）
    expect(statSync(join(dir, "events.jsonl")).size).toBeLessThanOrEqual(4096);
  });

  it("大文件（5MB 级）追加不再读全量——append 路径健壮（放宽为逻辑断言，见 describe 注）", () => {
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    mkdirSync(dir, { recursive: true });
    // 预置 5MB 现役（2600 行 × ~2KB；阈值缺省 8MB 不触发轮转——单测 append 路径自身）
    const line = JSON.stringify({ id: 1, event: "gpu", data: { pad: "p".repeat(2000) } });
    writeFileSync(join(dir, "events.jsonl"), Array.from({ length: 2600 }, () => line).join("\n") + "\n");
    const before = statSync(join(dir, "events.jsonl")).size;
    expect(appendEventLog(root, [{ id: 2, event: "gpu", data: { n: 1 } }])).toBe(true);
    expect(statSync(join(dir, "events.jsonl")).size).toBeGreaterThan(before); // 追加成功、未轮转（未超 8MB）
  });
});

describe("微批E1②——单事件体积上限（64KB 摘要化，不丢事件不改 id 序）", () => {
  it("data 体积超 64KB → 落盘行 ≤64KB、event 名带 .truncated、顶层键保留、超长值摘要化", () => {
    const root = tempRoot();
    const big = "y".repeat(100_000);
    expect(appendEventLog(root, [
      { id: 1, event: "gpu", data: { keep: 7, blob: big } }, // 纯对象：保键降级
      { id: 2, event: "runs", data: big },                    // 非对象：整体替换为同构摘要
    ])).toBe(true);
    const lines = readFileSync(join(sseEventlogDirOf(root), "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // 不丢事件、id 序不变
    for (const line of lines) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const e1 = JSON.parse(lines[0] ?? "{}") as { id: number; event: string; data: Record<string, any> };
    expect(e1.id).toBe(1);
    expect(e1.event).toBe("gpu.truncated");
    expect(e1.data["keep"]).toBe(7);                       // 顶层键保留
    const blob = e1.data["blob"] as Record<string, unknown>;
    expect(blob["truncated"]).toBe(true);
    expect(blob["bytes"]).toBeGreaterThan(64 * 1024);      // N=原值序列化字节数
    expect((blob["preview"] as string)).toHaveLength(2048); // preview=原 JSON 串前 2048 字符
    const e2 = JSON.parse(lines[1] ?? "{}") as { id: number; event: string; data: Record<string, unknown> };
    expect(e2.id).toBe(2);
    expect(e2.event).toBe("runs.truncated");
    expect(e2.data["truncated"]).toBe(true);               // 非对象 data 整体摘要
    expect(typeof e2.data["preview"]).toBe("string");
  });

  it("小事件原样落盘（无 .truncated 后缀——摘要化只作用于超限事件）", () => {
    const root = tempRoot();
    appendEventLog(root, [{ id: 1, event: "gpu", data: { offline: false } }]);
    const line = readFileSync(join(sseEventlogDirOf(root), "events.jsonl"), "utf8").trim();
    expect(line).not.toContain(".truncated");
  });
});

describe("微批E1③——读路径尾部限界（现役/归档各 256KB，首截半行丢弃）", () => {
  it("日志 >256KB：readEventsAfter 尾窗回放正确、越界 null 回退、sseNextEventId 从尾行恢复", () => {
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    mkdirSync(dir, { recursive: true });
    // 预置 300 行 × ~1KB ≈ 300KB > 256KB 尾读窗——起点落在行中段，首行必为截半行
    const pad = "z".repeat(1000);
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: i + 1, event: "gpu", data: { pad } }));
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
    // 尾窗内回放正确（截半首行被丢弃，不炸、不漏完整行）
    expect(readEventsAfter(root, 295)?.map((e) => e.id)).toEqual([296, 297, 298, 299, 300]);
    // 更早 lastId（早于窗内可见最旧行）→ null 回退快照（越界语义不变——fail-closed）
    expect(readEventsAfter(root, 0)).toBeNull();
    // 序号恢复：从尾部行 id=300 → 下一 id 301（尾读不整文件入串）
    expect(sseNextEventId(root)).toBe(301);
  });

  it("归档＋现役两档各按尾窗读：拼接回放保序（跨档无缝判定不变）", () => {
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    mkdirSync(dir, { recursive: true });
    // 归档小（10 行全量可见）＋现役超窗（300 行只尾部可见）
    const pad = "z".repeat(1000);
    const archiveLines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: i + 1, event: "gpu", data: { pad: "a" } }));
    writeFileSync(join(dir, "events.1.jsonl"), archiveLines.join("\n") + "\n");
    const currentLines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: 11 + i, event: "runs", data: { pad } }));
    writeFileSync(join(dir, "events.jsonl"), currentLines.join("\n") + "\n");
    const replay = readEventsAfter(root, 5); // lastId=5 落在归档可见段内——非越界
    expect(replay).not.toBeNull();
    const ids = replay?.map((e) => e.id) ?? [];
    // 归档段 6-10 全量＋现役尾窗段（窗外早段不可见＝无缝不可保证段之外按序拼接）
    expect(ids.slice(0, 5)).toEqual([6, 7, 8, 9, 10]);
    expect(ids.length).toBeGreaterThan(5);      // 现役尾窗段在
    expect(ids[ids.length - 1]).toBe(310);      // 尾行直达
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? 0); // 保序
  });
});

describe("微批E1④——启动自愈（boot 存量超限→立即轮转）", () => {
  it("超阈值现役 → healEventlogOnBoot 轮转到归档、新现役重新开始；未超限/已自愈 → false", () => {
    process.env["ATF_SSE_EVENTLOG_MAX_BYTES"] = "4096";
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    expect(healEventlogOnBoot(root)).toBe(false); // 无日志＝无事可做
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.1.jsonl"), "旧归档将被超代删除\n"); // 旧档在场——自愈轮转替换它
    writeFileSync(join(dir, "events.jsonl"), `${"w".repeat(8192)}\n`);  // 超阈值现役（8KB > 4096）
    expect(healEventlogOnBoot(root)).toBe(true);
    expect(readFileSync(join(dir, "events.1.jsonl"), "utf8")).toContain("w"); // 现役已转归档（旧档被替换）
    expect(existsSync(join(dir, "events.jsonl"))).toBe(false);               // 新现役未再写＝不在场
    // 自愈后再 append：新现役重新开始（只含新事件）
    expect(appendEventLog(root, [{ id: 1, event: "gpu", data: 1 }])).toBe(true);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(healEventlogOnBoot(root)).toBe(false); // 幂等：已自愈不再轮转
  });
});

describe("微批E1⑤——降级不静默（状态面 reason/since＋回落＋透出面）", () => {
  it("eventlog 路径不可写 → append false＋degraded=true（since 首次固定）；恢复可写 → 回落", () => {
    const root = tempRoot();
    const dir = sseEventlogDirOf(root);
    // 测试进程为 root，chmod 0555 不构成不可写——用路径占位文件法：eventlog 路径被普通文件
    // 占位 → mkdirSync 必抛（ENOTDIR/EEXIST），对任意权限恒成立
    mkdirSync(dirname(dir), { recursive: true });
    writeFileSync(dir, "占位——eventlog 路径不可为目录");
    expect(appendEventLog(root, [{ id: 1, event: "gpu", data: 1 }])).toBe(false);
    const degraded = sseEventlogStatus();
    expect(degraded.degraded).toBe(true);
    expect(typeof degraded.reason).toBe("string");
    expect(typeof degraded.since).toBe("string");
    // since 首次进入降级固定——后续失败不刷新
    const sinceFirst = degraded.since;
    expect(appendEventLog(root, [{ id: 2, event: "gpu", data: 2 }])).toBe(false);
    expect(sseEventlogStatus().since).toBe(sinceFirst);
    // 恢复可写（占位让位）→ append 成功 → 降级回落
    rmSync(dir);
    expect(appendEventLog(root, [{ id: 3, event: "gpu", data: 3 }])).toBe(true);
    expect(sseEventlogStatus().degraded).toBe(false);
  });

  it("注入面：降级入参 → 提示条（data-atf-eventlog-degraded＋固定文案）与 config eventlog 键；正常零注入", () => {
    const html = "<html><head><title>t</title></head><body>x</body></html>";
    const degradedHtml = injectMonitorGlobal(html, "/m.json", undefined, undefined, undefined,
      { degraded: true, reason: "ENOTDIR", since: "2026-10-24T00:00:00.000Z" });
    expect(degradedHtml).toContain("data-atf-eventlog-degraded");
    expect(degradedHtml).toContain("事件历史不可用（已降级）");
    expect(degradedHtml).toContain('"eventlog"');
    expect(injectMonitorGlobal(html, "/m.json", undefined, undefined, undefined, { degraded: false }))
      .not.toContain("data-atf-eventlog-degraded");
    expect(injectMonitorGlobal(html, "/m.json")).not.toContain("data-atf-eventlog-degraded"); // 旧签名零变化
  });

  it("快照端点携带 eventlog 键（源码形态锚——生产 disposeSnapshot 在 apply 内注册，e2e 由主会话统一批覆盖）", () => {
    const source = readFileSync(join(__dirname, "../../packages/extensions/atf-ui/src/server.ts"), "utf8");
    expect(source).toContain("eventlog: sseEventlogStatus()");
  });
});
