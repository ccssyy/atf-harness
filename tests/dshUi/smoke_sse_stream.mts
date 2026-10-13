/** 批㊶-SSE 真机冒烟（非注入路径）：本地 harness 实例（apply 生产装配＋http 调度）＋curl -N。
 *  验证：快照首帧→增量→心跳→Last-Event-ID 回放→鉴权拒绝（requestRejection 401）。
 *  运行：vendor tsx tests/dshUi/smoke_sse_stream.mts；心跳/滚动阈值经 env 注入加速。 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { apply, tickOnce } from "/data/sam/ATF-Harness/packages/extensions/atf-ui/src/server.js";

const root = mkdtempSync(join(tmpdir(), "atf-sse-smoke-"));
const runsRoot = join(root, "runs");
const runDir = join(runsRoot, "smoke-run");
mkdirSync(join(runDir, "webui"), { recursive: true });
mkdirSync(join(runDir, "training"), { recursive: true });
writeFileSync(join(runDir, "registration.json"), "{}\n");
// env 注入：心跳 400ms（冒烟加速——生产缺省 20s 在 15-30s 带内）
process.env["ATF_SSE_HEARTBEAT_MS"] = "400";
process.env["ATF_SSE_MAX_CONNECTIONS"] = "8";

// 本地实例：apply 生产装配（webServer.register 捕获路由＋connection 鉴权钩子）
const routes = new Map<string, (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void>();
const effects: Array<() => void> = [];
apply(
  {
    effect: (run: () => () => void) => { effects.push(run()); },
    webServer: {
      tapIndex: () => () => {},
      register: (route: { kind: "exact" | "prefix"; path: string; handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void> }) => {
        routes.set(route.path, route.handler as never);
        return () => {};
      },
    },
    connection: {
      // 鉴权钩子：x-smoke-role: guest → 401（模拟未过壳鉴权）；其余放行
      requestRejection: (req: import("node:http").IncomingMessage) => req.headers["x-smoke-role"] === "guest" ? 401 : undefined,
    },
  },
  { runsRoot, intervalMs: 3_600_000 },
);
const server = createServer((req, res) => {
  const handler = [...routes.entries()].find(([path]) => req.url?.startsWith(path))?.[1];
  if (handler === undefined) { res.writeHead(404); res.end(); return; }
  void handler(req, res);
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const base = `http://127.0.0.1:${port}`;
let failures = 0;
const assert = (cond: boolean, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

// 基线 tick（首帧基线入缓存——快照由连接握手承载）
await tickOnce({ runsRoot, intervalMs: 3_600_000 });

// SSE 流永不结束——curl 超时退出（码 28）即正常收流完成。异步 spawn＋文件捕获
// （spawnSync 会阻塞事件循环——本进程内 server 无法 accept，curl 必空手而归）。
let curlSeq = 0;
const curlCapture = async (args: string[], maxTimeMs: number): Promise<{ headers: string; body: string }> => {
  const seq = ++curlSeq;
  const hdr = join(root, `curl-hdr-${seq}.txt`);
  const body = join(root, `curl-body-${seq}.txt`);
  await new Promise<void>((resolve) => {
    const proc = spawn("curl", ["-sN", "--max-time", String(maxTimeMs / 1000), "-D", hdr, "-o", body, ...args], { stdio: "ignore" });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
  return {
    headers: existsSync(hdr) ? readFileSync(hdr, "utf8") : "",
    body: existsSync(body) ? readFileSync(body, "utf8") : "",
  };
};
const curlN = async (args: string[], maxTimeMs: number): Promise<string> => (await curlCapture(args, maxTimeMs)).body;
const curlHeaders = async (args: string[], maxTimeMs: number): Promise<string> => (await curlCapture(args, maxTimeMs)).headers;

// ① 快照首帧＋头三件套（curl -N 无 Last-Event-ID）
const snapHeaders = await curlHeaders([`${base}/atf-ui/events`], 1000);
assert(snapHeaders.includes("content-type: text/event-stream"), "头三件① content-type: text/event-stream");
assert(snapHeaders.includes("no-cache, no-transform"), "头三件② cache-control: no-cache, no-transform");
assert(snapHeaders.toLowerCase().includes("connection: keep-alive"), "头三件③ connection: keep-alive");
const snap = await curlN([`${base}/atf-ui/events`], 900);
assert(snap.startsWith("retry: 5000\n"), "首帧 retry: 5000（四要素·retry）");
assert(snap.includes("event: snapshot\n"), "快照首帧 event: snapshot（全键合集）");

// ② 增量：后台 curl 收流期间 run 状态变化（training 锚落盘→runs 键 diff→事件帧到达）
const incFile = join(root, "inc.txt");
const incProc = spawn("curl", ["-sN", "--max-time", "3", "-o", incFile, `${base}/atf-ui/events`], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 400));
writeFileSync(join(runDir, "training", "all_results.json"), "{}\n");
await tickOnce({ runsRoot, intervalMs: 3_600_000 });
await new Promise((r) => setTimeout(r, 800));
incProc.kill();
try { const incText = readFileSync(incFile, "utf8"); assert(incText.includes("event: runs\n"), "增量 event: runs（tick diff 后到达）"); } catch { assert(false, "增量 event: runs（tick diff 后到达）——增量文件缺失"); }

// ②b 越界 Last-Event-ID → snapshot 回退（fail-closed 如实）
const inc = await curlN([`${base}/atf-ui/events`, "-H", "Last-Event-ID: 999"], 900);
assert(inc.includes("event: snapshot\n"), "越界 Last-Event-ID 回退快照（fail-closed 如实）");

// ③ 心跳（env 400ms 加速——生产缺省 20s）
const hb = await curlN([`${base}/atf-ui/events`], 1200);
assert(hb.includes(": ping\n\n"), "心跳注释帧 : ping（四要素·心跳）");

// ④ Last-Event-ID 回放：日志事件定位补发（不重发 snapshot）
//    先制造两轮事件（变化→事件1；再变化→事件2）
writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x\n");
await tickOnce({ runsRoot, intervalMs: 3_600_000 });
await tickOnce({ runsRoot, intervalMs: 3_600_000 });
const logPath = join(runsRoot, "atf-ui", "eventlog", "events.jsonl");
const logLines = readFileSync(logPath, "utf8").trim().split("\n");
assert(logLines.length >= 2, `事件日志落盘（${logLines.length} 行）`);
const firstId = (JSON.parse(logLines[0] ?? "{}") as { id?: number }).id ?? 0;
const replay = await curlN([`${base}/atf-ui/events`, "-H", `Last-Event-ID: ${firstId}`], 900);
assert(!replay.includes("event: snapshot"), "回放不重发 snapshot（定位补发）");
assert(replay.includes(`id: ${firstId + 1}`), `Last-Event-ID=${firstId} 后续事件按序补发`);

// ⑤ 鉴权拒绝：requestRejection 401（未过壳鉴权 fail-closed）
const denied = await curlHeaders(["-H", "x-smoke-role: guest", `${base}/atf-ui/events`], 1000);
assert(denied.startsWith("HTTP/1.1 401"), "鉴权拒绝 401（requestRejection fail-closed）");

// 事件日志滚动阈值明示（报告引用）
console.log(`[smoke] 事件日志目录: ${join(runsRoot, "atf-ui", "eventlog")}（滚动阈值：单文件 ${2000} 行·保留现役+1 代）`);
console.log(`[smoke] 连接上限缺省 8（ATF_SSE_MAX_CONNECTIONS 可配）·心跳缺省 20s（ATF_SSE_HEARTBEAT_MS 可配）`);

for (const d of effects) d();
server.close();
rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "[smoke] ALL PASS" : `[smoke] FAILURES: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
