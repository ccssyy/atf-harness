/**
 * 批⑬ v2（2026-09-29）——WebUI 服务面（第四宿主入口；node:http 零新增依赖）。
 *
 * 路由：静态三栏前端（/）＋JSON API（sessions/messages/confirm/gpu/runs/report）＋
 * SSE 事件流（/api/sessions/:id/events，轮询 30s 兜底亦可）。
 * 运维面 env：ATF_WEBUI_RUNS_ROOT／ATF_WEBUI_SESSIONS_ROOT／ATF_WEBUI_PORT／
 * ATF_WEBUI_PARSE_BUDGET／ATF_WEBUI_CHAT_BUDGET／ATF_LLM_CONFIG（GLM 宿主凭据 env-only）。
 * e2e 注入：startWebUiServer({streamFn/runsRoot/port...})——脚本化 agent 冒烟（场景 2-6）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { loadLlmProviderConfig } from "../llm/providerConfig.js";
import { WebUiSessionManager, chatBudgetFromEnv, parseBudgetFromEnv, type SessionManagerDeps } from "./sessionManager.js";
import { listRuns, queryNvidiaSmi } from "./readOnlyTools.js";
import { renderChatEvent } from "./chatModel.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const env = process.env;

const json = (res: ServerResponse, code: number, payload: unknown): void => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> =>
  await new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk: Buffer) => {
      text += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });

export interface WebUiServerHandle {
  server: ReturnType<typeof createServer>;
  manager: WebUiSessionManager;
  runsRoot: string;
  port: number;
}

/** 服务装配工厂（e2e 注入 overrides：streamFn/runsRoot/port 等；生产入口走底部直跑守卫）。 */
export const startWebUiServer = (overrides: {
  runsRoot?: string;
  sessionsRoot?: string;
  streamFn?: (model: never, context: never, options?: never) => unknown;
  providerConfig?: { provider_id: string; model: string; base_url: string; api_key: string };
  port?: number;
} = {}): WebUiServerHandle => {
  const runsRoot = overrides.runsRoot ?? env["ATF_WEBUI_RUNS_ROOT"] ?? join(repoRoot, "tmp", "webui-runs");
  const sessionsRoot = overrides.sessionsRoot ?? env["ATF_WEBUI_SESSIONS_ROOT"] ?? join(repoRoot, "tmp", "webui-sessions");
  const listenPort = overrides.port ?? Number(env["ATF_WEBUI_PORT"] ?? 8629);
  let providerConfig: SessionManagerDeps["providerConfig"];
  if (overrides.providerConfig !== undefined) providerConfig = overrides.providerConfig;
  else if (env["ATF_LLM_CONFIG"] !== undefined && env["ATF_LLM_CONFIG"] !== "") {
    void loadLlmProviderConfig(env).then((resolved) => {
      if (resolved.ok) providerConfig = { provider_id: resolved.value.provider_id, model: resolved.value.model, base_url: resolved.value.base_url, api_key: resolved.value.api_key };
    });
  }
  const manager = new WebUiSessionManager({
    runsRoot,
    sessionsRoot,
    bridgeCommand: { argv: ["node", mockPath], cwd: repoRoot },
    ...(providerConfig !== undefined ? { providerConfig } : {}),
    ...(overrides.streamFn !== undefined ? { streamFn: overrides.streamFn } : {}),
    parseBudget: parseBudgetFromEnv(env),
    chatBudget: chatBudgetFromEnv(env),
  });

  let gpuCache: { at: number; payload: unknown } = { at: 0, payload: null };
  const gpuCached = async (): Promise<unknown> => {
    if (Date.now() - gpuCache.at > 30_000) gpuCache = { at: Date.now(), payload: await queryNvidiaSmi() };
    return gpuCache.payload;
  };

  const staticFiles: Record<string, { body: string; type: string }> = {
    "/": { body: readFileSync(join(publicDir, "index.html"), "utf8"), type: "text/html; charset=utf-8" },
    "/app.js": { body: readFileSync(join(publicDir, "app.js"), "utf8"), type: "text/javascript; charset=utf-8" },
    "/styles.css": { body: readFileSync(join(publicDir, "styles.css"), "utf8"), type: "text/css; charset=utf-8" },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "GET" && staticFiles[path] !== undefined) {
      res.writeHead(200, { "content-type": staticFiles[path]?.type });
      res.end(staticFiles[path]?.body);
      return;
    }
    if (path === "/api/sessions" && req.method === "GET") {
      json(res, 200, { sessions: manager.listSessions() });
      return;
    }
    if (path === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      const instruction = typeof body["instruction"] === "string" ? body["instruction"] : undefined;
      json(res, 200, { id: manager.createSession(instruction) });
      return;
    }
    const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (eventsMatch !== null && req.method === "GET") {
      const id = eventsMatch[1] ?? "";
      const since = Number(url.searchParams.get("since") ?? "0");
      if ((req.headers.accept ?? "").includes("text/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let cursor = since;
        const timer = setInterval(() => {
          for (const event of manager.eventsSince(id, cursor)) {
            cursor = event.seq;
            res.write(`data: ${JSON.stringify({ seq: event.seq, html: renderChatEvent(event) })}\n\n`);
          }
          res.write(": ping\n\n");
        }, 1_000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      json(res, 200, { events: manager.eventsSince(id, since).map((event) => ({ seq: event.seq, html: renderChatEvent(event) })) });
      return;
    }
    const messageMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (messageMatch !== null && req.method === "POST") {
      const body = await readBody(req);
      const text = typeof body["text"] === "string" ? body["text"] : "";
      if (text === "") {
        json(res, 400, { error: "text 必填" });
        return;
      }
      void manager.postUserMessage(messageMatch[1] ?? "", text);
      json(res, 200, { accepted: true });
      return;
    }
    const confirmMatch = path.match(/^\/api\/sessions\/([^/]+)\/confirm$/);
    if (confirmMatch !== null && req.method === "POST") {
      const body = await readBody(req);
      const action = body["action"] === "deny" ? "deny" : body["action"] === "edit" ? "edit" : "confirm";
      const edits = typeof body["edits"] === "object" && body["edits"] !== null ? (body["edits"] as Record<string, string>) : {};
      await manager.answerConfirm(confirmMatch[1] ?? "", { action, edits, via: "button" });
      json(res, 200, { accepted: true });
      return;
    }
    if (path === "/api/gpu" && req.method === "GET") {
      json(res, 200, { gpu: await gpuCached() });
      return;
    }
    if (path === "/api/runs" && req.method === "GET") {
      json(res, 200, { runs: await listRuns(runsRoot) });
      return;
    }
    const reportMatch = path.match(/^\/api\/report\/([^/]+)$/);
    if (reportMatch !== null && req.method === "GET") {
      const runId = reportMatch[1] ?? "";
      const segment = url.searchParams.get("segment");
      const rel = segment === null ? "report/report.md" : `report/segment-${segment}.md`;
      const artifactPath = join(runsRoot, runId, rel);
      if (!existsSync(artifactPath)) {
        json(res, 404, { error: "报告不存在" });
        return;
      }
      json(res, 200, { run_id: runId, path: rel, text: readFileSync(artifactPath, "utf8") });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(listenPort);
  return { server, manager, runsRoot, port: listenPort };
};

const executedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("webui/server.mjs") ||
    process.argv[1].endsWith("webui" + sep + "server.mjs") ||
    (() => {
      try {
        return import.meta.url === pathToFileURL(process.argv[1] as string).href;
      } catch {
        return false;
      }
    })());
if (executedDirectly) {
  startWebUiServer();
}
