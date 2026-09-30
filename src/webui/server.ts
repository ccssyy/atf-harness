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
import { openSettingsStore, redactProviders, envProfilePath, writeEnvProfile, SCENARIO_PROFILES, APPROVAL_POLICIES, type ApprovalPolicy, type ScenarioProfileId } from "./settings.js";
import { listRuns, queryNvidiaSmi } from "./readOnlyTools.js";
import { ingestTrainerLogLines, readLossSeries, lossSeriesPath } from "./logParser.js";
import { renderChatEvent } from "./chatModel.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// public/ 走源树单源（前端零构建——dist/webui/public 不存在；展示层即 src 侧文件）
const publicDir = existsSync(join(dirname(fileURLToPath(import.meta.url)), "public"))
  ? join(dirname(fileURLToPath(import.meta.url)), "public")
  : join(repoRoot, "src", "webui", "public");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const env = process.env;

const readLossSeriesLen = (runsRoot: string, sessionId: string): number => {
  const path = lossSeriesPath(join(runsRoot, sessionId));
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]).length : 0;
};

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
  settings: ReturnType<typeof openSettingsStore>;
}

export interface WebUiServerOverrides {
  runsRoot?: string;
  sessionsRoot?: string;
  streamFn?: (model: never, context: never, options?: never) => unknown;
  providerConfig?: { provider_id: string; model: string; base_url: string; api_key: string };
  port?: number;
  /** 批⑭：设置存储注入（e2e 用 tmp 路径；缺省 webui/providers.json）。 */
  settingsStore?: ReturnType<typeof openSettingsStore>;
}

/** 服务装配工厂（e2e 注入 overrides：streamFn/runsRoot/port 等；生产入口走底部直跑守卫）。 */
export const startWebUiServer = (overrides: WebUiServerOverrides = {}): WebUiServerHandle => {
  const runsRoot = overrides.runsRoot ?? env["ATF_WEBUI_RUNS_ROOT"] ?? join(repoRoot, "tmp", "webui-runs");
  const sessionsRoot = overrides.sessionsRoot ?? env["ATF_WEBUI_SESSIONS_ROOT"] ?? join(repoRoot, "tmp", "webui-sessions");
  const listenPort = overrides.port ?? Number(env["ATF_WEBUI_PORT"] ?? 8629);
  // 批⑭：设置存储（webui/providers.json 运行时配置，重载热生效——§一.区1；e2e 注入 tmp）
  const settings = overrides.settingsStore ?? openSettingsStore(env["ATF_WEBUI_SETTINGS"] ?? join(repoRoot, "webui", "providers.json"));
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
    settings,
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
        let lossCursor = readLossSeriesLen(runsRoot, id);
        const timer = setInterval(() => {
          for (const event of manager.eventsSince(id, cursor)) {
            cursor = event.seq;
            res.write(`data: ${JSON.stringify({ seq: event.seq, html: renderChatEvent(event) })}\n\n`);
          }
          // 批⑯ 增量 B：metrics_delta——页面刷新从文件重建（GET /api/metrics），SSE 只推增量
          const total = readLossSeriesLen(runsRoot, String(eventsMatch[1] ?? ""));
          if (total > lossCursor) {
            const points = readLossSeries(join(runsRoot, String(eventsMatch[1] ?? ""))).slice(lossCursor);
            lossCursor = total;
            res.write(`data: ${JSON.stringify({ type: "metrics_delta", points })}\n\n`);
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
      const modelCommand = text.match(/^\/model\s+(\S+)(?:\s+effort\s+(\S+))?/);
      if (modelCommand !== null) {
        // 批⑭：选择器切换（§二.1）——新 turn 生效不重启 loop（pi-ai 换实例语义）＋system_notice 留痕
        const provider = settings.get().providers.find((entry) => entry.models.some((model) => model.id === modelCommand[1]));
        manager.setModelOverride(messageMatch[1] ?? "", {
          provider_id: provider?.id ?? settings.get().default_provider,
          model: modelCommand[1] ?? "",
          ...(modelCommand[2] !== undefined ? { effort: modelCommand[2] } : {}),
        });
        json(res, 200, { accepted: true, model_switch: true });
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
    // 批⑰ Bug1：report.md 直开静态面（/static/run/<id>/report/report.md；只读＋runId 白名单防穿越）
    const staticRunMatch = path.match(/^\/static\/run\/([^/]+)\/report\/(report\.md|segment-[A-Za-z0-9_-]+\.md)$/);
    if (staticRunMatch !== null && req.method === "GET") {
      const runId = staticRunMatch[1] ?? "";
      const file = staticRunMatch[2] ?? "report.md";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId) || runId.includes("..")) {
        json(res, 400, { error: "非法 run id" });
        return;
      }
      const artifactPath = join(runsRoot, runId, "report", file);
      if (!existsSync(artifactPath)) {
        json(res, 404, { error: "报告不存在" });
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(readFileSync(artifactPath, "utf8"));
      return;
    }
    // ---- 批⑭ 设置 API（七条）----
    if (path === "/api/settings/providers" && req.method === "GET") {
      // 红线：key 只回 env 变量名＋脱敏尾 4 位（永不明文）
      const doc = settings.get();
      json(res, 200, {
        providers: redactProviders(doc.providers, (envName) => settings.keyTail(envName)),
        default_provider: doc.default_provider,
        policies: APPROVAL_POLICIES,
        profiles: SCENARIO_PROFILES,
      });
      return;
    }
    if (path === "/api/settings/providers" && req.method === "PUT") {
      const body = await readBody(req);
      const doc = settings.get();
      // PUT 收 env 变量名（api_key_env）；任何请求体里的 api_key 字段直接剥除（不落盘）
      const incoming = Array.isArray(body["providers"]) ? (body["providers"] as Array<Record<string, unknown>>) : doc.providers;
      const providers = incoming
        .map((provider) => {
          const { api_key: _stripped, ...rest } = provider as Record<string, unknown> & { api_key?: unknown };
          return rest as unknown as (typeof doc.providers)[number];
        })
        .filter((provider) => typeof provider.id === "string" && provider.id !== "");
      const next = settings.put({
        providers,
        ...(typeof body["default_provider"] === "string" ? { default_provider: body["default_provider"] } : {}),
      });
      json(res, 200, { providers: redactProviders(next.providers, (envName) => settings.keyTail(envName)), default_provider: next.default_provider });
      return;
    }
    const testMatch = path.match(/^\/api\/settings\/providers\/([^/]+)\/test$/);
    if (testMatch !== null && req.method === "POST") {
      const provider = settings.get().providers.find((entry) => entry.id === testMatch[1]);
      if (provider === undefined) {
        json(res, 404, { error: "provider 不存在" });
        return;
      }
      json(res, 200, { result: await settings.testProvider(provider) });
      return;
    }
    if (path === "/api/settings/approval" && req.method === "GET") {
      const doc = settings.get();
      json(res, 200, { approval_policy: doc.approval_policy, policies: APPROVAL_POLICIES });
      return;
    }
    if (path === "/api/settings/approval" && req.method === "PUT") {
      const body = await readBody(req);
      const policy = body["approval_policy"] as ApprovalPolicy | undefined;
      if (policy === undefined || !APPROVAL_POLICIES.some((entry) => entry.id === policy)) {
        json(res, 400, { error: "approval_policy 非法（per_card | danger_only | demo）" });
        return;
      }
      settings.put({ approval_policy: policy });
      manager.setApprovalPolicy(policy);
      json(res, 200, { approval_policy: policy });
      return;
    }
    if (path === "/api/settings/env-profile" && req.method === "GET") {
      json(res, 200, { env_profile: settings.get().env_profile, write_path: envProfilePath(env["HOME"] ?? "") });
      return;
    }
    if (path === "/api/settings/env-profile" && req.method === "PUT") {
      const body = await readBody(req);
      const current = settings.get().env_profile;
      const next = {
        train_env: typeof body["train_env"] === "string" ? body["train_env"] : current.train_env,
        eval_env: typeof body["eval_env"] === "string" ? body["eval_env"] : current.eval_env,
        gpu_visible_devices: typeof body["gpu_visible_devices"] === "string" ? body["gpu_visible_devices"] : current.gpu_visible_devices,
        master_port: typeof body["master_port"] === "number" ? body["master_port"] : current.master_port,
        base_model_dir: typeof body["base_model_dir"] === "string" ? body["base_model_dir"] : current.base_model_dir,
      };
      settings.put({ env_profile: next });
      const written = env["ATF_WEBUI_WRITE_ENV_PROFILE"] === "1" ? writeEnvProfile(env["HOME"] ?? "", next) : null;
      json(res, 200, { env_profile: next, written_path: written });
      return;
    }
    if (path === "/api/settings/profile" && req.method === "GET") {
      json(res, 200, { profile: settings.get().profile, profiles: SCENARIO_PROFILES });
      return;
    }
    if (path === "/api/settings/profile" && req.method === "PUT") {
      const body = await readBody(req);
      const profile = body["profile"] as ScenarioProfileId | undefined;
      if (profile === undefined || !SCENARIO_PROFILES.some((entry) => entry.id === profile)) {
        json(res, 400, { error: "profile 非法（first_train | walkthrough | demo）" });
        return;
      }
      const preset = SCENARIO_PROFILES.find((entry) => entry.id === profile);
      settings.put({ profile, ...(preset !== undefined ? { approval_policy: preset.approval_policy } : {}) });
      manager.setApprovalPolicy(preset?.approval_policy ?? manager.approvalPolicy);
      json(res, 200, { profile, approval_policy: manager.approvalPolicy });
      return;
    }
    const contextMatch = path.match(/^\/api\/sessions\/([^/]+)\/context$/);
    if (contextMatch !== null && req.method === "GET") {
      const doc = settings.get();
      const provider = doc.providers.find((entry) => entry.id === doc.default_provider);
      const model = provider?.models.find((entry) => entry.id === provider.default_model) ?? provider?.models[0];
      const usage = manager.contextUsage(contextMatch[1] ?? "", model?.context_window ?? 200_000);
      if (usage === null) {
        json(res, 404, { error: "会话不存在" });
        return;
      }
      json(res, 200, { used_tokens: usage.usedTokens, remaining_tokens: usage.remainingTokens, context_window: usage.contextWindow, remaining_ratio: usage.remainingRatio, low: usage.low });
      return;
    }
    // ---- 批⑯ 增量 B：监控数据面 ----
    const metricsMatch = path.match(/^\/api\/sessions\/([^/]+)\/metrics$/);
    if (metricsMatch !== null && req.method === "GET") {
      // 页面刷新从文件重建曲线（全量）
      const sessionId = metricsMatch[1] ?? "";
      json(res, 200, { points: readLossSeries(join(runsRoot, sessionId)), count: readLossSeries(join(runsRoot, sessionId)).length });
      return;
    }
    const ingestMatch = path.match(/^\/api\/sessions\/([^/]+)\/metrics\/ingest$/);
    if (ingestMatch !== null && req.method === "POST") {
      // 日志行进料（合成测试/M1 真实 tail 共用）：解析→落盘→返回新增点（SSE metrics_delta 增量推）
      const body = await readBody(req);
      const lines = Array.isArray(body["lines"]) ? (body["lines"] as unknown[]).map((line) => String(line)) : [];
      const added = ingestTrainerLogLines(join(runsRoot, ingestMatch[1] ?? ""), lines, new Date().toISOString());
      json(res, 200, { added, count: added.length });
      return;
    }
    const lossFileMatch = path.match(/^\/api\/sessions\/([^/]+)\/loss-series\.json$/);
    if (lossFileMatch !== null && req.method === "GET") {
      const artifactPath = lossSeriesPath(join(runsRoot, lossFileMatch[1] ?? ""));
      if (!existsSync(artifactPath)) {
        json(res, 404, { error: "loss-series 不存在" });
        return;
      }
      json(res, 200, { points: readLossSeries(join(runsRoot, lossFileMatch[1] ?? "")) });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(listenPort);
  return { server, manager, runsRoot, port: listenPort, settings };
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
