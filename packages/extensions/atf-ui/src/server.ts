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
import { join } from "node:path";
import { buildArtifactsSnapshot, buildMonitorSnapshot } from "./snapshot.js";
import { PANEL_HTML } from "./panel.js";

/** Cordis 插件名。 */
export const name = "atf-ui";

export interface AtfUiConfig {
  runsRoot: string;
  intervalMs: number;
}

/** 缺省解析（runsRoot 缺省 env 或相对 cwd——DSH 进程 cwd=vendor/dsh/deepseek-harness，故验收经 env 显式注入）。 */
const resolveConfig = (raw: unknown): AtfUiConfig => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    runsRoot:
      typeof value["runsRoot"] === "string"
        ? (value["runsRoot"] as string)
        : (process.env["ATF_DSH_RUNS_ROOT"] ?? join(process.cwd(), "tmp", "webui-runs")),
    intervalMs: typeof value["intervalMs"] === "number" ? (value["intervalMs"] as number) : 5_000,
  };
};

const OUT_DIR = "atf-ui";

interface RunScan {
  run_id: string;
  state: string;
  artifacts: string[];
  segments: Record<string, boolean>;
  training: { active: boolean; loss: unknown; pending_confirm: unknown };
  report: { files: string[] };
}

function scanRuns(runsRoot: string): RunScan[] {
  const root = join(runsRoot);
  if (!existsSync(root)) return [];
  const runs: RunScan[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === OUT_DIR) continue;
    const dir = join(root, entry.name);
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
    runs.push({
      run_id: entry.name,
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
        candidate: has("contract-candidate.json"),
        publish: has("report") && reportFiles.some((f) => f.startsWith("segment-")),
      },
      training: {
        active: has("training/loss-series.json"),
        loss: has("training/loss-series.json") ? readJson(join("training", "loss-series.json")) : null,
        pending_confirm: readJson(join("webui", "pending-confirm.json")),
      },
      report: { files: reportFiles },
    });
  }
  return runs;
}

export function apply(ctx: { effect(run: () => () => void, label: string): void }, config: unknown): void {
  const resolved = resolveConfig(config);
  console.log(`[atf-ui] 同步器启动（runsRoot=${resolved.runsRoot}，interval=${String(resolved.intervalMs)}ms）`);
  const outDir = join(resolved.runsRoot, OUT_DIR);
  const tick = (): void => {
    try {
      if (!existsSync(resolved.runsRoot)) return;
      mkdirSync(outDir, { recursive: true });
      const runs = scanRuns(resolved.runsRoot);
      const monitor = buildMonitorSnapshot(runs);
      const artifacts = buildArtifactsSnapshot(runs);
      writeFileSync(join(outDir, "monitor.json"), `${JSON.stringify(monitor, null, 1)}\n`, "utf8");
      writeFileSync(join(outDir, "artifacts.json"), `${JSON.stringify(artifacts, null, 1)}\n`, "utf8");
      // 自包含面板（数据内嵌——file:// 直开即用；owner 侧刷新页面即取最新快照）
      writeFileSync(join(outDir, "panel.html"), PANEL_HTML.replace("__ATF_DATA_JSON__", JSON.stringify({ monitor, artifacts }).replace(/</g, "\\u003c")), "utf8");
    } catch (cause) {
      console.error("[atf-ui] 同步失败（下周期重试）:", cause instanceof Error ? cause.message : String(cause));
    }
  };
  tick();
  const timer: NodeJS.Timeout = setInterval(tick, resolved.intervalMs);
  ctx.effect(() => () => clearInterval(timer), "atf-ui: runs 同步器");
}
