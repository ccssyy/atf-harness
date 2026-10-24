/**
 * 批B1 测试锚——会话↔Run 绑定账本（SessionRunBinding/v1）＋run 显示名（RunDisplay/v1）＋
 * /atf-ui/session-binding 端点（GET/POST）＋工具接入（run_id 缺省解析/run_binding_required/
 * rebound_from/created 绑定）＋monitor display 投影。
 * 增补 §5.1：三条工具 run_id description 关键词断言（可选/本会话绑定/run_binding_required）。
 * 账本家隔离：工具链读 process.env（resolveBindingsHome）——用例内 DSH_HOME 指临时家，
 * 用毕摘除；端点/纯函数面 home 直注入零 env 依赖。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// D112 训练互斥守卫（语义见 tests/fixtures/trainingLock.ts 头注）
import { guardTrainingLock } from "../fixtures/trainingLock.js";
import {
  BINDINGS_HISTORY_MAX,
  bindSessionRun,
  migrateFromRunBindings,
  readSessionBinding,
  resolveActiveRun,
  sessionBindingsPathOf,
  unbindSession,
} from "../../src/core/workspace/sessionBindings.js";
import { appendBinding } from "../../src/core/workspace/runFacts.js";
import { autoTitle, displayOf, readDisplay, shortModelName, writeDisplay } from "../../src/core/workspace/runDisplay.js";
import {
  sessionBindingPayloadOf,
  sessionBindingRouteHandler,
  scanRunDirAt,
} from "../../packages/extensions/atf-ui/src/server.js";
import { buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";
import {
  bindToolRunSuccess,
  buildEvalTools,
  buildPublishModelTool,
  buildRunTrainingTool,
  RUN_BINDING_REQUIRED_MESSAGE,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { evalOrchSessionBase, resolveLaunchSessionName } from "../../src/core/workspace/tmuxLiveness.js";
import { tmuxTestOk } from "../fixtures/tmuxTestSocket.js";

const repoRoot = "/data/sam/ATF-Harness";
// 批㊶-K 同款：GPU 排队编排直启旁路（测试不等待真实 GPU 窗口）
process.env["ATF_GPU_POLL_MS"] = "0";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "b1-binding-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  delete process.env["DSH_HOME"]; // 工具链账本家隔离（逐用例设，用毕摘除）
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Tool = {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>>;
  parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
};
const fakeExec = { callId: "t" };
/** 带会话身份的 exec（vendor ToolExecutionInput.agent.session.id 链路形态）。 */
const execWithSession = (sessionId: string): Record<string, unknown> => ({ callId: "t", agent: { session: { id: sessionId } } });
const approvalCtx = (outcome: string) => ({ get: (s: string) => (s === "approval" ? { request: async () => outcome } : undefined) });

/** run 夹具：webui/config-snapshot.json（hasRunMarkers 命中）＋可选 field-config（document_zh/
 *  document_type）＋可选 iteration-config（base_model.path，目录形态）。mtimeMs 可注入排序面。 */
const seedRun = (
  root: string,
  runId: string,
  opts: { workspace?: string; documentZh?: string; documentType?: string; modelPath?: string; mtimeMs?: number } = {},
): string => {
  const dir = opts.workspace !== undefined ? join(root, opts.workspace, runId) : join(root, runId);
  mkdirSync(join(dir, "webui"), { recursive: true });
  writeFileSync(join(dir, "webui", "config-snapshot.json"), "{}\n");
  if (opts.documentZh !== undefined || opts.documentType !== undefined) {
    mkdirSync(join(dir, "experiment-setup"), { recursive: true });
    writeFileSync(join(dir, "experiment-setup", "field-config.json"), `${JSON.stringify({
      document_zh: opts.documentZh, document_type: opts.documentType,
    })}\n`);
  }
  if (opts.modelPath !== undefined) {
    mkdirSync(join(dir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(dir, "prep", "iteration-config", "iteration-config.json"), `${JSON.stringify({
      base_model: { path: opts.modelPath },
    })}\n`);
  }
  // D91：lane 任务事实在位（恰一 lane——evaluate/analyze 链不传 lane 走 task_fact 判定）
  mkdirSync(join(dir, "l1"), { recursive: true });
  writeFileSync(join(dir, "l1", "training-data-manifest.json"), `${JSON.stringify({ schema_version: "TrainingDataArtifact/v1", lanes: { goods: {} } })}\n`);
  if (opts.mtimeMs !== undefined) utimesSync(dir, new Date(opts.mtimeMs), new Date(opts.mtimeMs));
  return dir;
};

// ── ① 账本 ──────────────────────────────────────────────────────────────────

describe("SessionRunBinding/v1 账本", () => {
  it("读写＋去重＋≤20 上限＋快速连写终态一致（原子写）", () => {
    const home = tempRoot();
    const first = bindSessionRun(home, "s1", { runId: "r1", workspace: "ws", source: "user_pick" });
    expect(first?.active_run_id).toBe("r1");
    expect(first?.workspace).toBe("ws");
    expect(first?.unbound_reason).toBeNull();
    expect(first?.history).toHaveLength(1);
    const second = bindSessionRun(home, "s1", { runId: "r2", workspace: "ws", source: "auto_tool" });
    expect(second?.history.map((h) => h.run_id)).toEqual(["r2", "r1"]); // 最新在前
    const back = bindSessionRun(home, "s1", { runId: "r1", workspace: "ws", source: "user_pick" });
    expect(back?.history.filter((h) => h.run_id === "r1")).toHaveLength(1); // 去重
    expect(back?.history).toHaveLength(2);
    // ≤20：连绑 25 个 → 恰 20 条，最新在前
    let last = null as ReturnType<typeof bindSessionRun>;
    for (let i = 0; i < 25; i += 1) {
      last = bindSessionRun(home, "s2", { runId: `run-${String(i).padStart(2, "0")}`, workspace: null, source: "auto_tool" });
    }
    expect(last?.history).toHaveLength(BINDINGS_HISTORY_MAX);
    expect(last?.history[0]?.run_id).toBe("run-24");
    expect(last?.history[BINDINGS_HISTORY_MAX - 1]?.run_id).toBe("run-05");
    // 快速连写（读-改-写高频）终态完整可解析——原子写不半截
    for (let i = 0; i < 5; i += 1) bindSessionRun(home, "s3", { runId: `z${i}`, workspace: null, source: "created" });
    const final = readSessionBinding(home, "s3");
    expect(final?.history.map((h) => h.run_id)).toEqual(["z4", "z3", "z2", "z1", "z0"]);
  });

  it("损坏账本：改名 .bak-<ts> 备份后空账本继续（不崩、可写）", () => {
    const home = tempRoot();
    mkdirSync(join(home, "atf-state"), { recursive: true });
    writeFileSync(sessionBindingsPathOf(home), "{这不是 JSON");
    expect(readSessionBinding(home, "s1")).toBeNull(); // 空账本语义
    const backups = readdirSync(join(home, "atf-state")).filter((f) => f.startsWith("session-bindings.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, "atf-state", backups[0] as string), "utf8")).toBe("{这不是 JSON");
    expect(bindSessionRun(home, "s1", { runId: "r1", workspace: null, source: "user_pick" })?.active_run_id).toBe("r1");
  });

  it("迁移：2 run × 2 session binding.json → active=最新 bound_at、source=migrated；幂等不覆盖", () => {
    const root = tempRoot();
    const home = tempRoot();
    const runA = seedRun(root, "run-a");
    const runB = seedRun(root, "run-b");
    appendBinding(runA, "s1", "2026-10-01T08:00:00Z");
    appendBinding(runA, "s2", "2026-10-01T09:00:00Z");
    appendBinding(runB, "s1", "2026-10-02T10:00:00Z"); // s1 最新 → active=run-b
    expect(migrateFromRunBindings(home, root)).toBe(2);
    const s1 = readSessionBinding(home, "s1");
    expect(s1?.active_run_id).toBe("run-b");
    expect(s1?.source).toBe("migrated");
    expect(s1?.history.map((h) => h.run_id)).toEqual(["run-b", "run-a"]); // bound_at 倒序
    expect(readSessionBinding(home, "s2")?.active_run_id).toBe("run-a");
    // 幂等：账本已在 → -1（不覆盖现役账本）
    bindSessionRun(home, "s1", { runId: "run-a", workspace: null, source: "user_pick" });
    expect(migrateFromRunBindings(home, root)).toBe(-1);
    expect(readSessionBinding(home, "s1")?.source).toBe("user_pick");
    // 分桶形态 run 亦被迁移
    const root2 = tempRoot();
    const home2 = tempRoot();
    const bucketed = seedRun(root2, "run-c", { workspace: "ws-x" });
    appendBinding(bucketed, "s3", "2026-10-03T08:00:00Z");
    expect(migrateFromRunBindings(home2, root2)).toBe(1);
    expect(readSessionBinding(home2, "s3")?.active_run_id).toBe("run-c");
  });

  it("stale：绑定后删 run 目录 → {run:null, reason:stale} 且不改账本；显式解除落 cleared", () => {
    const root = tempRoot();
    const home = tempRoot();
    const dir = seedRun(root, "run-x");
    bindSessionRun(home, "s9", { runId: "run-x", workspace: "ws", source: "user_pick" });
    rmSync(dir, { recursive: true, force: true });
    const res = resolveActiveRun(home, root, "s9");
    expect(res.run).toBeNull();
    expect(res.reason).toBe("stale");
    expect(res.runId).toBe("run-x");
    // 账本未改（持久化留给用户下一次操作或显式解除）
    const rec = readSessionBinding(home, "s9");
    expect(rec?.active_run_id).toBe("run-x");
    expect(rec?.unbound_reason).toBeNull();
    // 无记录＝new；显式解除＝cleared
    expect(resolveActiveRun(home, root, "no-such-session").reason).toBe("new");
    expect(unbindSession(home, "s9", "stale")?.unbound_reason).toBe("stale");
    expect(resolveActiveRun(home, root, "s9").reason).toBe("stale");
  });
});

// ── ② 显示名 ────────────────────────────────────────────────────────────────

describe("RunDisplay 显示名", () => {
  it("autoTitle：三件齐拼接＋-Instruct/-AWQ 剥离＋document_type 回退", () => {
    expect(shortModelName("/models/Qwen3-VL-32B-Instruct-AWQ")).toBe("Qwen3-VL-32B");
    expect(shortModelName("/models/Qwen3-VL-32B-Instruct")).toBe("Qwen3-VL-32B");
    const root = tempRoot();
    const at = new Date(2026, 9, 17, 14, 13).getTime();
    const dir = seedRun(root, "goods4doc-iter1", { documentZh: "装箱单", modelPath: "/models/Qwen3-VL-32B-Instruct" });
    utimesSync(join(dir, "prep", "iteration-config", "iteration-config.json"), new Date(at), new Date(at));
    expect(autoTitle(dir)).toBe("装箱单 · Qwen3-VL-32B · 10-17 14:13"); // 时间取 iteration-config mtime
    const dirType = seedRun(root, "run-type", { documentType: "发票", modelPath: "/m/Qwen3-VL-32B-Instruct-AWQ" });
    expect(autoTitle(dirType)).toContain("发票 · Qwen3-VL-32B ·");
  });

  it("autoTitle 降级：缺两项以上 → <workspace> · <MM-DD>；仍缺 → 实验 <末6位>（不编造）", () => {
    const root = tempRoot();
    const at = new Date(2026, 9, 17, 14, 13).getTime();
    const bare = seedRun(root, "run-bare");
    utimesSync(bare, new Date(at), new Date(at));
    expect(autoTitle(bare, "af-prodtest-20261017")).toBe("af-prodtest-20261017 · 10-17");
    // workspace 与时刻双缺 → 实验 <run_id 末6位>
    expect(autoTitle(join(root, "no-such-run"), null)).toBe("实验 ch-run");
    expect(autoTitle(join(root, "abc123"), null, "abc123")).toBe("实验 abc123");
  });

  it("用户改名优先于 auto；display.json 形态 RunDisplay/v1＋source=user", () => {
    const root = tempRoot();
    const dir = seedRun(root, "run-renamed", { documentZh: "装箱单", modelPath: "/m/Qwen3-VL-32B-Instruct" });
    const before = displayOf(dir, "run-renamed");
    expect(before).not.toBe("手工命名");
    expect(writeDisplay(dir, "手工命名")).toBe(true);
    const doc = readDisplay(dir);
    expect(doc?.schema_version).toBe("RunDisplay/v1");
    expect(doc?.source).toBe("user");
    expect(displayOf(dir, "run-renamed")).toBe("手工命名");
  });

  it("monitor 投影：scanRunDirAt 纯增 display.title＋buildMonitorSnapshot 白名单透传", () => {
    const root = tempRoot();
    const dir = seedRun(root, "run-title", { documentZh: "装箱单", modelPath: "/m/Qwen3-VL-32B-Instruct" });
    writeDisplay(dir, "手工命名");
    const scan = scanRunDirAt(dir, "run-title");
    expect(scan.display).toEqual({ title: "手工命名" }); // 用户名优先
    const snapshot = buildMonitorSnapshot([scan]);
    expect(snapshot.runs[0]?.display).toEqual({ title: "手工命名" });
    // 缺 display 的旧装配面＝null（client 回退 run_id——additive 兼容）
    expect(buildMonitorSnapshot([{ run_id: "r", state: "registered", segments: {} }] as never).runs[0]?.display).toBeNull();
  });
});

// ── ③ 端点 ──────────────────────────────────────────────────────────────────

describe("GET/POST /atf-ui/session-binding", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> =>
    new Promise((resolve) => {
      const srv = createServer(handler);
      servers.push(srv);
      srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
    });
  const call = (base: string, path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(`${base}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
      }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => { text += String(c); });
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 非 JSON 面 */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  it("纯函数面：GET 载荷（new/cleared/stale/bound 四态＋recent≤3＋candidates≤5 工作区优先）", () => {
    const root = tempRoot();
    const home = tempRoot();
    // 空会话＝new
    expect(sessionBindingPayloadOf(home, root, "s-new")).toMatchObject({ binding: null, active: null, unbound_reason: "new" });
    // 造 5 run（3 个 ws-a 桶＋2 平铺）＋mtime 排序面
    const old = new Date(2026, 9, 1, 8, 0).getTime();
    const mid = new Date(2026, 9, 2, 8, 0).getTime();
    const fresh = new Date(2026, 9, 3, 8, 0).getTime();
    seedRun(root, "flat-old", { mtimeMs: old });
    seedRun(root, "flat-mid", { mtimeMs: mid });
    seedRun(root, "a-1", { workspace: "ws-a", mtimeMs: old + 1 });
    seedRun(root, "a-2", { workspace: "ws-a", mtimeMs: fresh });
    seedRun(root, "b-1", { workspace: "ws-b", mtimeMs: fresh + 1 });
    // 绑定 ws-a 桶 run → active 带 workspace＋title；candidates 本工作区优先
    const boundDir = join(root, "ws-a", "a-1");
    bindSessionRun(home, "s-b", { runId: "a-1", workspace: "ws-a", source: "user_pick" });
    const payload = sessionBindingPayloadOf(home, root, "s-b");
    expect(payload.active).toMatchObject({ run_id: "a-1", workspace: "ws-a" });
    expect((payload.active as { title: string }).title.length).toBeGreaterThan(0);
    expect(payload.unbound_reason).toBeNull();
    expect(payload.candidates.length).toBeLessThanOrEqual(5);
    expect(payload.candidates[0]?.workspace).toBe("ws-a"); // 本工作区优先
    expect(payload.candidates.map((c) => c.run_id)).toContain("a-2");
    expect(payload.recent.length).toBeLessThanOrEqual(3);
    expect(payload.recent[0]?.run_id).toBe("b-1"); // recent 全局 mtime 倒序（不带偏好）
    // stale：删目录后 active:null＋reason:stale，账本未动
    rmSync(boundDir, { recursive: true, force: true });
    const stale = sessionBindingPayloadOf(home, root, "s-b");
    expect(stale.active).toBeNull();
    expect(stale.unbound_reason).toBe("stale");
    expect(readSessionBinding(home, "s-b")?.active_run_id).toBe("a-1");
    // cleared
    unbindSession(home, "s-b", "cleared");
    expect(sessionBindingPayloadOf(home, root, "s-b").unbound_reason).toBe("cleared");
  });

  it("HTTP 面：401 鉴权／200 缺 sessionId 草稿载荷（B2c）／400 非法 title／404 run 不存在／200 bind·unbind·rename", async () => {
    const root = tempRoot();
    const home = tempRoot();
    seedRun(root, "run-http", { workspace: "ws-h" });
    const handler = sessionBindingRouteHandler({
      home,
      runsRoot: root,
      reject: (req) => (req.headers["cookie"] === undefined ? 401 : undefined), // 壳语义模拟
    });
    const base = await startServer(handler);
    // 未鉴权 → 401
    expect((await call(base, "/atf-ui/session-binding?sessionId=s1", "GET")).status).toBe(401);
    const auth = { cookie: "dsh=1" };
    const callAuth = (path: string, method: "GET" | "POST", body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(`${base}${path}`, {
          method,
          headers: { cookie: auth.cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        }, (res) => {
          let text = "";
          res.on("data", (c: Buffer) => { text += String(c); });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text || "{}") as Record<string, unknown> }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      });
    // GET 缺 sessionId → 200 草稿态载荷（B2c——机器级最近实验，只读；draft:true＋零账本读写）
    const draft = await callAuth("/atf-ui/session-binding", "GET");
    expect(draft.status).toBe(200);
    expect(draft.json.draft).toBe(true);
    expect(draft.json.active).toBeNull();
    expect(Array.isArray(draft.json.recent)).toBe(true);
    expect((draft.json.recent as Array<Record<string, unknown>>).some((r) => r.run_id === "run-http")).toBe(true);
    expect(draft.json.candidates).toEqual([]);
    // GET 200：cache-control no-store（JSON 面）
    const got = await callAuth("/atf-ui/session-binding?sessionId=s1", "GET");
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ binding: null, unbound_reason: "new" });
    // POST 缺 sessionId → 400
    expect((await callAuth("/atf-ui/session-binding", "POST", { runId: "run-http" })).status).toBe(400);
    // POST run 不存在 → 404
    expect((await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", runId: "nope" })).status).toBe(404);
    // POST rename 非法 title → 400（空／超 80 字）
    expect((await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", rename: { runId: "run-http", title: "  " } })).status).toBe(400);
    expect((await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", rename: { runId: "run-http", title: "字".repeat(81) } })).status).toBe(400);
    // POST bind → 200＋账本落盘（user_pick＋桶 workspace）
    const bound = await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", runId: "run-http" });
    expect(bound.status).toBe(200);
    expect(bound.json.saved).toBe(true);
    expect((bound.json.binding as Record<string, unknown>).source).toBe("user_pick");
    expect((bound.json.active as Record<string, unknown>).workspace).toBe("ws-h");
    // POST runId:null → unbind cleared
    const cleared = await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", runId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.json.unbound_reason).toBe("cleared");
    // POST rename → display.json 落盘＋GET title 用户名优先
    expect((await callAuth("/atf-ui/session-binding", "POST", { sessionId: "s1", rename: { runId: "run-http", title: "我的实验" } })).status).toBe(200);
    expect(readFileSync(join(root, "ws-h", "run-http", "webui", "display.json"), "utf8")).toContain("我的实验");
    const renamed = await callAuth("/atf-ui/session-binding?sessionId=s1", "GET");
    expect((renamed.json.candidates as Array<Record<string, unknown>>).find((c) => c.run_id === "run-http")?.title).toBe("我的实验");
  });
});

// ── ⑤ 工具接入 ──────────────────────────────────────────────────────────────

describe("工具 run_id 缺省解析与绑定", () => {
  beforeEach((ctx) => guardTrainingLock(ctx));
  it("增补 §5.1：三条工具 run_id description＝可选＋本会话绑定语义；run_training 必填＋created 语义", () => {
    const ctx = { get: () => undefined };
    const tools = [
      ...(buildEvalTools(ctx, { runsRoot: "/tmp/x", logDir: "/tmp/x", kernelDir: "/tmp/x" }) as Tool[]),
      buildPublishModelTool(ctx, { runsRoot: "/tmp/x" }) as Tool,
      buildRunTrainingTool(ctx, { runsRoot: "/tmp/x", logDir: "/tmp/x", ctx }) as Tool,
    ];
    const byName = (name: string): Tool => tools.find((t) => t.name === name) as Tool;
    for (const name of ["atf_evaluate", "atf_analyze_badcases", "atf_publish_model"]) {
      const params = byName(name).parameters;
      const spec = params?.properties?.["run_id"];
      expect(params?.required ?? []).not.toContain("run_id"); // 改可选（编译后 required 表）
      const desc = spec?.description ?? "";
      expect(desc).toContain("可选");
      expect(desc).toContain("本会话");
      expect(desc).toContain("绑定");
      expect(desc).toContain("run_binding_required");
      expect(desc).toContain("不要自行猜");
    }
    const trainParams = byName("atf_run_training").parameters;
    expect(trainParams?.required ?? []).toContain("run_id"); // 保持必填
    const trainDesc = trainParams?.properties?.["run_id"]?.description ?? "";
    expect(trainDesc).toContain("新实验标识");
    expect(trainDesc).toContain("自动绑定本会话");
  });

  it("bindToolRunSuccess：缺省解析自绑定＝零写（保 user_pick 溯源）；显式不同 run＝rebound_from", () => {
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    const root = tempRoot();
    seedRun(root, "run-a");
    seedRun(root, "run-b");
    bindSessionRun(home, "s1", { runId: "run-a", workspace: null, source: "user_pick" });
    // 缺省解析（无显式 run_id）→ 不写账本，source 保持 user_pick
    expect(bindToolRunSuccess(execWithSession("s1"), "run-a", null, "auto_tool")).toEqual({});
    expect(readSessionBinding(home, "s1")?.source).toBe("user_pick");
    // 显式同 run → 写 auto_tool（动作留痕）无 rebound_from（未换 run）
    expect(bindToolRunSuccess(execWithSession("s1"), "run-a", null, "auto_tool", "run-a")).toEqual({});
    expect(readSessionBinding(home, "s1")?.source).toBe("auto_tool");
    // 显式不同 run → rebound_from＝旧值
    expect(bindToolRunSuccess(execWithSession("s1"), "run-b", "ws", "auto_tool", "run-b")).toEqual({ rebound_from: "run-a" });
    expect(readSessionBinding(home, "s1")?.active_run_id).toBe("run-b");
    // 无旧绑定显式绑定 → rebound_from:null（如实）
    expect(bindToolRunSuccess(execWithSession("s2"), "run-a", null, "auto_tool", "run-a")).toEqual({ rebound_from: null });
  });

  it("未绑定（无会话身份）→ run_binding_required＋业务话术＋候选 ≤5（带 title/workspace），零落盘", async () => {
    const root = tempRoot();
    seedRun(root, "c1", { workspace: "ws", mtimeMs: Date.now() + 60_000 }); // 最新 → 候选首位（非偏好序）
    seedRun(root, "c2", { workspace: "ws" });
    seedRun(root, "c3");
    seedRun(root, "c4");
    seedRun(root, "c5");
    seedRun(root, "c6");
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    const tools = buildEvalTools({ get: () => undefined }, { runsRoot: root, logDir: root, kernelDir: root }) as Tool[];
    const evaluate = tools.find((t) => t.name === "atf_evaluate") as Tool;
    // 无 mock pin／无资产——run_binding_required 先于一切检查（红线：无绑定必报候选）
    const result = await evaluate.execute({ action: "start", adapter_path: "x", eval_assets_dir: "x", service_config: "x", env_profile: "x" }, fakeExec);
    expect(result.error).toBe("run_binding_required");
    expect(result.message).toBe(RUN_BINDING_REQUIRED_MESSAGE);
    expect(result.message).toContain("还没有选择实验");
    const candidates = result.candidates as Array<{ run_id: string; workspace: string | null; title: string }>;
    expect(candidates.length).toBeLessThanOrEqual(5);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    for (const c of candidates) {
      expect(typeof c.run_id).toBe("string");
      expect(typeof c.title).toBe("string");
      expect(c.title).not.toMatch(/^run-/); // title 是显示名（降级也不裸用 run_id 拼串）
    }
    expect(candidates.map((c) => c.run_id)).toContain("c1");
    // 零落盘零绑定
    expect(existsSync(sessionBindingsPathOf(home))).toBe(false);
    // status 查询同样不绑定（必填参数照传——run_id 省略走绑定解析，无绑定即拒）
    await evaluate.execute({ action: "status", adapter_path: "x", eval_assets_dir: "x", service_config: "x", env_profile: "x" }, fakeExec);
    expect(existsSync(sessionBindingsPathOf(home))).toBe(false);
  });

  it("atf_publish_model：省略 run_id＋已绑定 → 用绑定值发布成功并绑定（created 语义对照 run_training）", async () => {
    const root = tempRoot();
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    // 四件套齐的 run（publish 前置）＋checkpoint
    const runDir = seedRun(root, "run-pub");
    const ckpt = join(runDir, "training", "checkpoint-7");
    mkdirSync(ckpt, { recursive: true });
    writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
    const round = join(runDir, "eval", "1-20261020", "orch", "eval");
    mkdirSync(round, { recursive: true });
    for (const f of ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]) writeFileSync(join(round, f), "{}\n");
    const publishRoot = tempRoot();
    bindSessionRun(home, "s-pub", { runId: "run-pub", workspace: null, source: "user_pick" });
    const publish = buildPublishModelTool({ get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) }, { runsRoot: root }) as Tool;
    const result = await publish.execute({ checkpoint: "checkpoint-7", publish_root: publishRoot }, execWithSession("s-pub"));
    expect(result.ok).toBe(true);
    expect(result.run_id).toBe("run-pub"); // 用绑定值
    expect(result.rebound_from).toBeUndefined(); // 缺省解析＝零写保溯源
    const rec = readSessionBinding(home, "s-pub");
    expect(rec?.active_run_id).toBe("run-pub");
    expect(rec?.source).toBe("user_pick");
  });

  it("atf_analyze_badcases：显式 run_id 与绑定不同 → 成功后覆盖绑定＋rebound_from", async () => {
    const root = tempRoot();
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    // 两 run 各带评估产物＋L1 资产；mock pin 两脚本
    const writeEvalFixtures = (runId: string): string => {
      const dir = seedRun(root, runId);
      mkdirSync(join(dir, "eval"), { recursive: true });
      writeFileSync(join(dir, "eval", "badcases.jsonl"), "{}\n");
      writeFileSync(join(dir, "eval", "raw_predictions.jsonl"), "{}\n");
      const assets = join(dir, "l1", "eval");
      mkdirSync(join(dir, "l1", "images"), { recursive: true });
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(dir, "l1", "images", "p1.png"), "png");
      writeFileSync(join(assets, "eval_labels.jsonl"), `${JSON.stringify({ page_id: "p1", image: "images/p1.png" })}\n`);
      return assets;
    };
    writeEvalFixtures("run-a");
    const assetsB = writeEvalFixtures("run-b");    const pin = tempRoot();
    for (const [skill, script] of [
      ["atf-evaluate-checkpoints", "build_raw_badcase_input.py"],
      ["atf-analyze-badcases", "run_analysis_chain.py"],
    ] as const) {
      const dir = join(pin, "skills", skill, "scripts");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, script), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if "--out-dir" in args:
    out_dir = args[args.index("--out-dir") + 1]
    os.makedirs(out_dir, exist_ok=True)
    open(os.path.join(out_dir, "raw-badcase-analysis.v1.json"), "w").write("{}")
if "--output-dir" in args:
    out_dir = args[args.index("--output-dir") + 1]
    os.makedirs(os.path.join(out_dir, "viewer"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "report"), exist_ok=True)
    open(os.path.join(out_dir, "viewer", "viewer.html"), "w").write("<html></html>")
    open(os.path.join(out_dir, "report", "report.md"), "w").write("# report")
print(json.dumps({"ok": True}))`);
    }
    bindSessionRun(home, "s-ana", { runId: "run-a", workspace: null, source: "user_pick" });
    const analyze = (buildEvalTools({ get: () => undefined }, { runsRoot: root, logDir: root, kernelDir: pin }) as Tool[]).find((t) => t.name === "atf_analyze_badcases") as Tool;
    const result = await analyze.execute({ run_id: "run-b", eval_assets_dir: assetsB }, execWithSession("s-ana"));
    expect(result.ok).toBe(true);
    expect(result.run_id).toBe("run-b");
    expect(result.rebound_from).toBe("run-a");
    const rec = readSessionBinding(home, "s-ana");
    expect(rec?.active_run_id).toBe("run-b");
    expect(rec?.source).toBe("auto_tool");
    expect(rec?.history.map((h) => h.run_id)).toEqual(["run-b", "run-a"]);
  });

  it("atf_evaluate：省略 run_id＋已绑定 → 用绑定值走完编排链（started:true；账本溯源不动）", async () => {
    const root = tempRoot();
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    const RUN_ID = "run-eval-bound";
    // D14 同款 run 夹具：field-config＋指纹＋资产＋service config＋ckpt
    const { createHash } = await import("node:crypto");
    const runDir = seedRun(root, RUN_ID, { documentZh: "装箱单" });
    const fcText = `${JSON.stringify({ schema_version: "PromptFieldConfig/v1", document_zh: "装箱单", fields: [{ field_id: "f01" }] })}\n`;
    writeFileSync(join(runDir, "experiment-setup", "field-config.json"), fcText);
    const sha = createHash("sha256").update(Buffer.from(fcText, "utf8")).digest("hex");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), `${JSON.stringify({
      base_model: { path: "/m/Qwen3-VL-32B-Instruct" },
      dataset: { digest_provenance: { field_config_sha256: sha } },
    })}\n`);
    const assets = join(root, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "eval_labels.jsonl"), `${JSON.stringify({ page_id: "p1", labels: { f01: [{ value: "v" }] } })}\n`);
    writeFileSync(join(assets, "test_images.json"), "{}");
    const serviceConfig = join(root, "EvalServiceConfig.v1.json");
    writeFileSync(serviceConfig, JSON.stringify({ schema_version: "EvalServiceConfig/v1", port: 5032, tensor_parallel_size: 1 }));
    const ckpt = join(runDir, "training", "checkpoint-3");
    mkdirSync(ckpt, { recursive: true });
    writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
    // mock pin（五脚本最小形态——编排脚本 "$@" 落盘后即退）
    const pin = tempRoot();
    const scriptsDir = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
    const rendererDir = join(pin, "skills", "atf-admit-training-data", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, "render_prompt.py"), "# renderer\n");
    writeFileSync(join(scriptsDir, "run_formal_eval.py"), "# runner mock\n");
    writeFileSync(join(scriptsDir, "generate_eval_service.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if "--record-eval-release" in args:
    print(json.dumps({"recorded": True})); sys.exit(0)
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({
  "expected_model_names": ["base", "${RUN_ID}_ckpt3"], "argv": ["vllm", "serve", "--tensor-parallel-size", "1"],
  "request_defaults": {"port": 5032}}))
print(json.dumps({"out": out}))`);
    writeFileSync(join(scriptsDir, "build_service_prelaunch_report.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
open(out, "w").write("# 推理服务接入确认报告\\n\\n| 参数 | 值 |\\n|---|---|\\n| 端口/TP/gpu_mem_util | 5032 / 1 / 0.8 | argv |\\n")
print("{}")`);
    writeFileSync(join(scriptsDir, "generate_checkpoint_plan.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "ckpt_plan.json"), "w").write("{}")
print("{}")`);
    writeFileSync(join(scriptsDir, "generate_eval_orchestration.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "eval_orchestration.sh"), "w").write("#!/bin/bash\\nexit 0\\n")
print("{}")`);
    bindSessionRun(home, "s-eval", { runId: RUN_ID, workspace: null, source: "user_pick" });
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const evaluate = (buildEvalTools(ctx, { runsRoot: root, logDir: root, kernelDir: pin }) as Tool[]).find((t) => t.name === "atf_evaluate") as Tool;
    const orchName = resolveLaunchSessionName(evalOrchSessionBase(RUN_ID));
    try {
      const result = await evaluate.execute({
        action: "start", adapter_path: ckpt, eval_assets_dir: assets, service_config: serviceConfig,
        env_profile: "b1-local", assets_external_confirm: true,
      }, execWithSession("s-eval"));
      expect(result.started).toBe(true);
      expect(result.run_id).toBe(RUN_ID); // 用绑定值（未显式传 run_id）
      expect(result.rebound_from).toBeUndefined();
      // 账本溯源不动（user_pick 保持；无 rebound 覆盖）
      const rec = readSessionBinding(home, "s-eval");
      expect(rec?.active_run_id).toBe(RUN_ID);
      expect(rec?.source).toBe("user_pick");
      expect(rec?.history).toHaveLength(1);
    } finally {
      tmuxTestOk(`kill-session -t ${orchName} 2>/dev/null`);
    }
  });

  it("atf_run_training：start 成功 → created 绑定＋run 侧 binding.json 双写；status 不写账本", async () => {
    const root = tempRoot();
    const home = tempRoot();
    process.env["DSH_HOME"] = home;
    const RUN_ID = "r-created";
    // 长驻 mock train.sh（feed_ok 路径——trainingFace 夹具同款）
    const modelDir = join(root, "models", "fake-model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "config.json"), "{}\n");
    mkdirSync(join(root, RUN_ID, "prep"), { recursive: true });
    writeFileSync(join(root, RUN_ID, "prep", "iteration-config.json"), `${JSON.stringify({
      base_model: { path: modelDir }, training: { learning_rate: "1e-4", num_train_epochs: 3 },
    })}\n`);
    const trainSh = join(root, "train.sh");
    writeFileSync(trainSh, `#!/bin/bash
export MASTER_PORT=\${MASTER_PORT:-39011}
echo 'SHA=pass entries=1'
echo 'ADMISSION=pass keys=1'
TRAIN_CMD=( '--learning_rate' '1e-4' '--num_train_epochs' '3' )
if [ "\${DRY_RUN:-0}" = "1" ]; then exit 0; fi
sleep 20
`);
    writeFileSync(join(root, "prelaunch-report.md"), "# 训练前报告\n");
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const tool = buildRunTrainingTool(ctx, { runsRoot: root, logDir: root, ctx }) as unknown as Tool;
    const { trainingSessionBase } = await import("../../src/core/workspace/tmuxLiveness.js");
    const launchName = resolveLaunchSessionName(trainingSessionBase(RUN_ID));
    try {
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: RUN_ID }, execWithSession("s-train"));
      expect(result.started).toBe(true);
      const rec = readSessionBinding(home, "s-train");
      expect(rec?.active_run_id).toBe(RUN_ID);
      expect(rec?.source).toBe("created"); // 新建实验即绑定
      // run 侧 binding.json 双写仍在（反向索引保留）
      expect(readFileSync(join(root, RUN_ID, "webui", "binding.json"), "utf8")).toContain("s-train");
      // status 查询不写账本（记录零变化）
      const before = readFileSync(sessionBindingsPathOf(home), "utf8");
      await tool.execute({ action: "status", train_sh: trainSh, run_id: RUN_ID }, execWithSession("s-other"));
      expect(readFileSync(sessionBindingsPathOf(home), "utf8")).toBe(before);
    } finally {
      tmuxTestOk(`kill-session -t ${launchName}`);
    }
  });
});
