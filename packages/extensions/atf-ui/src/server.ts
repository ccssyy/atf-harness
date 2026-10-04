/**
 * 批⑱-M2——atf-ui：三定制组件的**服务端半**（数据同步器）。
 *
 * 分工：把 runsRoot 快照（段状态/产物清单/loss-series）周期写入
 * `<runsRoot>/atf-ui/monitor.json` 与 `artifacts.json`——client 半（浏览器）经 DSH 原生
 * workspaceFiles.read（外路径读为其文档明示能力）轮询这两个文件渲染。
 * 落盘即重建源（刷新不依赖浏览器会话——指令通用要求）。
 * 目录枚举是 workspace-scoped（DSH 文档口径），故枚举在服务端做、client 只读成品文件。
 * 纯函数（buildMonitorSnapshot/buildArtifactsSnapshot）在 ./snapshot.js，本仓 vitest 直测。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildArtifactsSnapshot, buildMonitorSnapshot } from "./snapshot.js";
import { PANEL_HTML } from "./panel.js";
import { queryNvidiaSmi } from "../../../../src/webui/readOnlyTools.js";

/** Cordis 插件名。 */
export const name = "atf-ui";

/** 仓根（packages/extensions/atf-ui/src → 上四级）——缺省落点以本文件位置锚定，
 *  不随 DSH 进程 cwd 漂移（cwd 默认在 vendor 树内，相对缺省即成 vendor 写入面）。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface AtfUiConfig {
  runsRoot: string;
  intervalMs: number;
}

/** 缺省解析（runsRoot 缺省 env 或仓根 tmp/webui-runs——批㉑三段起不再用 cwd 相对值；
 *  批㉘ 补 ATF_WEBUI_RUNS_ROOT 兜底位（指令覆盖轴，排在 ATF_DSH_RUNS_ROOT 之后——dsh 原生轴优先；
 *  两实例现役均只设 ATF_DSH_RUNS_ROOT，缺省行为零变化）。 */
const resolveConfig = (raw: unknown): AtfUiConfig => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    runsRoot:
      typeof value["runsRoot"] === "string"
        ? (value["runsRoot"] as string)
        : (process.env["ATF_DSH_RUNS_ROOT"] ?? process.env["ATF_WEBUI_RUNS_ROOT"] ?? join(repoRoot, "tmp", "webui-runs")),
    intervalMs: typeof value["intervalMs"] === "number" ? (value["intervalMs"] as number) : 5_000,
  };
};

const OUT_DIR = "atf-ui";

/** monitor 快照路径单源（同步器写盘位＝client 半轮询位——批㉘注入面共用了同一推导）。 */
export const monitorPathOf = (runsRoot: string): string => join(runsRoot, OUT_DIR, "monitor.json");

/** index HTML 注入（纯函数）：`</head>` 前插 per-instance monitor 路径全局；
 *  无 head 锚则整体前置。值经 JSON.stringify 转义，路径含特殊字符也安全。 */
export const injectMonitorGlobal = (html: string, monitorPath: string): string => {
  const snippet = `<script>window.__ATF_UI_CONFIG__=Object.assign({},window.__ATF_UI_CONFIG__,{monitorPath:${JSON.stringify(monitorPath)}});</script>`;
  const at = html.toLowerCase().indexOf("</head>");
  return at === -1 ? snippet + html : html.slice(0, at) + snippet + html.slice(at);
};

export interface RunScan {
  run_id: string;
  state: string;
  artifacts: string[];
  segments: Record<string, boolean | string>;
  training: { active: boolean; loss: unknown; pending_confirm: unknown };
  report: { files: string[] };
  viewers: string[];
}

/** 单 run 目录标记推导（任务卡 chat 卡面与同步器同源——trainingFace status 复用本出口）。 */
export function scanRunDir(root: string, runId: string): RunScan {
  const dir = join(root, runId);
  const has = (rel: string): boolean => existsSync(join(dir, rel));
  const readJson = (rel: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(dir, rel), "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const reportDir = join(dir, "report");
  const reportFiles = existsSync(reportDir) ? readdirSync(reportDir).filter((f) => f.endsWith(".md") || f.endsWith(".json")) : [];
  return {
    run_id: runId,
    state: has("webui/config-snapshot.json")
      ? "config_confirmed"
      : has("launch/train.sh")
        ? "launch_ready"
        : has("contract-candidate.json")
          ? "candidate_built"
          : has("registration.json") || has("dataset")
            ? "registered"
            : "unknown",
    artifacts: ["session.jsonl", "contract-candidate.json", "launch/train.sh", "webui/config-snapshot.json"].filter(has),
    segments: {
      register: has("registration.json") || has("dataset"),
      split: has("split") || has("dataset/split"),
      label_qc: has("label_qc") || has("qc"),
      // 实验配置段：config-snapshot 已确认=done；pending-confirm 在场=active（等待四卡应答）
      experiment_config: has("webui/config-snapshot.json") ? true : has("webui/pending-confirm.json") ? "active" : false,
      candidate: has("contract-candidate.json"),
      publish: has("report") && reportFiles.some((f) => f.startsWith("segment-")),
      // admission 沿 train.sh 存在（生成即过 DRY_RUN 准入自检面）
      admission: has("launch/train.sh") || has("admission.json"),
      training: has("training/loss-series.json"),
    },
    training: {
      active: has("training/loss-series.json"),
      loss: has("training/loss-series.json") ? readJson(join("training", "loss-series.json")) : null,
      pending_confirm: readJson(join("webui", "pending-confirm.json")),
    },
    report: { files: reportFiles },
    viewers: discoverViewerDirs(dir),
  };
}

/**
 * badcase viewer 产物发现（批㉛段1）：run 下以 `analysis` 开头的目录里的
 * `viewer/viewer.html`，两形态兼容（批㉕B 两步链 `analysis/` ＋ 批㉙ 命名变体
 * `analysis-b29/`）。`.bak` 备份目录不入列（历史备份不是现役产物，也不得经 URL
 * 服务）；`analysis-input` 无 viewer 子目录自然落选。
 * 排序＝viewer.html mtime 新者在前（A 重评后重建的 viewer 即首选），mtime 同值按名升序。
 */
export function discoverViewerDirs(runDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(runDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("analysis") && !e.name.includes(".bak"))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const stamp = (name: string): number => {
    try {
      return statSync(join(runDir, name, "viewer", "viewer.html")).mtimeMs;
    } catch {
      return -1;
    }
  };
  return entries
    .filter((name) => stamp(name) >= 0)
    .sort((a, b) => (stamp(b) - stamp(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

function scanRuns(runsRoot: string): RunScan[] {
  const root = join(runsRoot);
  if (!existsSync(root)) return [];
  const runs: RunScan[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === OUT_DIR) continue;
    runs.push(scanRunDir(root, entry.name));
  }
  return runs;
}

/**
 * viewer 静态路由 handler 工厂：壳鉴权（connection.requestRejection——401/403 沿壳语义）
 * → GET/HEAD 门 → 逐 run 现役 viewer 清单解析（resolveViewerRequest fail-closed）→ 读盘回包。
 * html/json no-store（刷新即新），图片类 max-age=3600（sha 文件名内容寻址）。
 * @param deps - runsRoot 与每 run viewer 清单的即时发现（每次请求现查，不缓存）。
 */
export const viewerRouteHandler = (deps: {
  runsRoot: string;
  viewersOf: (runId: string) => string[];
  reject?: (req: IncomingMessage) => 401 | 403 | undefined;
}) =>
(req: IncomingMessage, res: ServerResponse): void => {
  const rejection = deps.reject?.(req);
  if (rejection !== undefined) {
    res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
    res.end("dsh web authentication required\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  let pathname: string;
  try {
    const url = new URL(req.url ?? "/", "http://x");
    pathname = url.pathname
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .join("/");
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  // 目录式收尾：无尾斜杠的裸 runId 需 302 补斜杠，viewer 相对资源才能落在正确前缀下。
  const parts = pathname.slice(VIEWER_ROUTE_PREFIX.length).split("/").filter((p) => p !== "");
  if (parts.length === 1 && !req.url!.endsWith("/")) {
    res.writeHead(302, { location: pathname + "/" });
    res.end();
    return;
  }
  const resolved = resolveViewerRequest(deps.runsRoot, pathname, deps.viewersOf(parts[0]!));
  if (resolved === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  const body = readFileSync(resolved.abs);
  res.writeHead(200, {
    "content-type": resolved.type,
    "cache-control": resolved.type.startsWith("image/") ? "public, max-age=3600" : "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : body);
};

export async function tickOnce(resolved: AtfUiConfig): Promise<void> {
  try {
    if (!existsSync(resolved.runsRoot)) return;
    const outDir = join(resolved.runsRoot, OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    const runs = scanRuns(resolved.runsRoot);
    // GPU 状态（nvidia-smi 包装——不可用如实 offline，不猜测；快照单源随 monitor.json 下发）
    const gpu = await queryNvidiaSmi();
    const monitor = buildMonitorSnapshot(runs, gpu === null ? { offline: true } : { offline: false, ...gpu });
    const artifacts = buildArtifactsSnapshot(runs);
    writeFileSync(join(outDir, "monitor.json"), `${JSON.stringify(monitor, null, 1)}\n`, "utf8");
    writeFileSync(join(outDir, "artifacts.json"), `${JSON.stringify(artifacts, null, 1)}\n`, "utf8");
    // 自包含面板（数据内嵌——file:// 直开即用；owner 侧刷新页面即取最新快照）
    writeFileSync(join(outDir, "panel.html"), PANEL_HTML.replace("__ATF_DATA_JSON__", JSON.stringify({ monitor, artifacts }).replace(/</g, "\\u003c")), "utf8");
  } catch (cause) {
    console.error("[atf-ui] 同步失败（下周期重试）:", cause instanceof Error ? cause.message : String(cause));
  }
}

/** 前置服务（cordis 注入声明）：webServer 在场时经 tapIndex 把 monitor 路径注入 index——
 *  client 半据此轮询 per-instance 快照（批㉘；无 webServer 的裸挂载面——如 vitest 直调——跳过注入）。
 *  批㉛段1 增 connection：viewer 静态路由沿用壳既有信任面（requestRejection → 401/403），
 *  不在壳鉴权之外开裸口。 */
export const inject = ["webServer", "connection"];

/** viewer 静态服务路由前缀（prefix 注册：本前缀与其下任意子路径都进本 handler）。 */
export const VIEWER_ROUTE_PREFIX = "/atf-ui/viewer";

/** 路径段合法形态：字母数字开头，仅 字母数字._-；`..` 与分隔符天然被拒。 */
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const VIEWER_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * viewer 路由请求解析（纯函数，vitest 直测——安全面单源）。
 *
 * URL 形态（pathname 均为 decodeURIComponent 后逐段校验）：
 *   `/atf-ui/viewer/<runId>`                    → 首选 viewer 的 viewer.html（调用方需先重定向补尾斜杠，
 *                                                 相对资源才能落在 runId 目录下）
 *   `/atf-ui/viewer/<runId>/`                   → 首选 viewer 的 viewer.html
 *   `/atf-ui/viewer/<runId>/<analysis>/…`       → 指定 analysis 变体（必须在已发现清单内）
 *   `/atf-ui/viewer/<runId>/images/<sha>.png`   → 首选 viewer 的相对资源
 *
 * fail-closed：runId 段不合法 / analysis 不在发现清单 / 子路径段非法或越出 viewer 根 /
 * 扩展名不在 MIME 表 → null（调用方回 404）。
 * @returns 绝对文件路径与 content-type；不可服务即 null。
 */
export const resolveViewerRequest = (
  runsRoot: string,
  pathname: string,
  viewers: string[],
): { abs: string; type: string } | null => {
  const rest = pathname.slice(VIEWER_ROUTE_PREFIX.length);
  const parts = rest.split("/").filter((p) => p !== "");
  if (parts.length === 0 || !SEG_RE.test(parts[0]!)) return null;
  const runId = parts[0]!;
  if (viewers.length === 0) return null;
  let analysis: string;
  let sub: string[];
  if (parts.length >= 2 && viewers.includes(parts[1]!)) {
    analysis = parts[1]!;
    sub = parts.slice(2);
  } else {
    analysis = viewers[0]!;
    sub = parts.slice(1);
  }
  if (sub.length === 0) sub = ["viewer.html"];
  for (const seg of sub) {
    if (!SEG_RE.test(seg)) return null;
  }
  const viewerRoot = resolve(join(runsRoot, runId, analysis, "viewer"));
  const abs = resolve(join(viewerRoot, ...sub));
  if (abs !== viewerRoot && !abs.startsWith(viewerRoot + sep)) return null;
  const last = sub[sub.length - 1]!;
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return null;
  const mime = VIEWER_MIME[last.slice(dot).toLowerCase()];
  if (mime === undefined) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return { abs, type: mime };
};

export function apply(
  ctx: {
    effect(run: () => () => void, label: string): void;
    webServer?: {
      tapIndex(transform: (html: string) => string): () => void;
      register?(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void;
    };
    connection?: { requestRejection(req: IncomingMessage): 401 | 403 | undefined };
  },
  config: unknown,
): void {
  const resolved = resolveConfig(config);
  console.log(`[atf-ui] 同步器启动（runsRoot=${resolved.runsRoot}，interval=${String(resolved.intervalMs)}ms）`);
  const webServer = ctx.webServer;
  if (webServer !== undefined) {
    const monitorPath = monitorPathOf(resolved.runsRoot);
    const dispose = webServer.tapIndex((html) => injectMonitorGlobal(html, monitorPath));
    ctx.effect(() => dispose, "atf-ui: monitor 路径 index 注入");
    console.log(`[atf-ui] monitor 路径已注入 index（monitorPath=${monitorPath}）`);
    // 批㉛段1：badcase viewer 静态路由（鉴权沿壳 connection 信任面；connection/register 缺席的
    // 裸挂载面跳过不开口——tapIndex-only 消费方零变化）
    const connection = ctx.connection;
    if (connection !== undefined && webServer.register !== undefined) {
      const disposeRoute = webServer.register({
        kind: "prefix",
        path: VIEWER_ROUTE_PREFIX,
        handler: viewerRouteHandler({
          runsRoot: resolved.runsRoot,
          viewersOf: (runId) => discoverViewerDirs(join(resolved.runsRoot, runId)),
          reject: (req) => connection.requestRejection(req),
        }),
      });
      ctx.effect(() => disposeRoute, "atf-ui: viewer 静态路由");
      console.log(`[atf-ui] viewer 静态路由已注册（${VIEWER_ROUTE_PREFIX}/<runId>/）`);
    }
  }
  void tickOnce(resolved);
  const timer: NodeJS.Timeout = setInterval(() => void tickOnce(resolved), resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
