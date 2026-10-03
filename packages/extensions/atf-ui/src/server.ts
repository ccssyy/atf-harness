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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  };
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
 *  client 半据此轮询 per-instance 快照（批㉘；无 webServer 的裸挂载面——如 vitest 直调——跳过注入）。 */
export const inject = ["webServer"];

export function apply(
  ctx: {
    effect(run: () => () => void, label: string): void;
    webServer?: { tapIndex(transform: (html: string) => string): () => void };
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
  }
  void tickOnce(resolved);
  const timer: NodeJS.Timeout = setInterval(() => void tickOnce(resolved), resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
