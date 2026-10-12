/**
 * 批㊶Q增补三 段3——run 单根多桶布局面（owner 裁定甲「切换工作目录」）。
 *
 * 布局：runsRoot 两级——
 *   - 平铺（存量形态，原地保留不迁移）：runs/<run_id>，workspace=null；
 *   - 分桶（新 run 形态）：runs/<工作区目录名>/<run_id>，workspace=<桶名>。
 * 桶名＝发起会话 DSH 工作区目录名（exec.agent.session.header.cwd 的 basename——
 * vendor tool-bash 同源锚，见 packages/shell/tool-bash sessionCwd 解析）；无工作区
 * 归属（取不到 cwd／系统级 run 如 default）留根目录平铺，不入桶。
 * 解析序（resolveRunDir）：平铺在场＞桶内在场＞新建（有归属→入桶，无→平铺）——
 * 存量平铺 run 全链路（工具写面／监控扫描／viewer 路由）向后兼容，零迁移。
 * 均 runsRoot 本地文件面操作，不进 bridge 契约面；列目录失败如实降级（fail-open）。
 */
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { hasSegmentFact } from "./segmentFacts.js";

/** 桶名/run_id 合法形态（字母数字开头，仅 字母数字._-；`..` 与分隔符天然被拒）。 */
export const RUN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 系统级 run（无工作区归属——留根目录平铺，不入桶）。 */
export const SYSTEM_RUN_IDS: readonly string[] = ["default"];

/** 工作区目录名 → 桶名（basename＋sanitize：非法字符折 '_'；空得 null＝不归属）。 */
export const slugForWorkspaceCwd = (cwd: string | undefined): string | null => {
  if (typeof cwd !== "string" || cwd.trim() === "") return null;
  const base = basename(cwd.replace(/[\\/]+$/, ""));
  if (base === "" || base === "." || base === "..") return null;
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return RUN_NAME_RE.test(slug) ? slug : null;
};

/** 工具执行上下文 → 发起会话工作区桶名（exec.agent.session.header.cwd——vendor 锚；
 *  取不到＝null 如实不归属，调用方回落平铺）。 */
export const sessionWorkspaceSlug = (exec: unknown): string | null => {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } })
    ?.agent?.session?.header?.cwd;
  return slugForWorkspaceCwd(typeof cwd === "string" ? cwd : undefined);
};

export const isValidRunId = (runId: string): boolean => RUN_NAME_RE.test(runId) && !runId.includes("..");

/** 桶内在场搜索（优先指定桶；逐桶一级扫描——runsRoot 规模小，stat 面可忽略）。 */
const findBucketed = (runsRoot: string, runId: string, prefer?: string | null): string | null => {
  if (prefer !== undefined && prefer !== null && prefer !== "") {
    const candidate = join(runsRoot, prefer, runId);
    if (existsSync(candidate)) return candidate;
  }
  let entries: string[];
  try {
    entries = readdirSync(runsRoot).sort();
  } catch {
    return null;
  }
  for (const bucket of entries) {
    if (bucket === prefer) continue;
    const candidate = join(runsRoot, bucket, runId);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 不可探测＝跳过
    }
  }
  return null;
};

/**
 * run_id → 实际 run 目录（双形态兼容单源）：
 *   ① 平铺在场（存量，含全部既有 run）→ 平铺；
 *   ② 桶内在场（新形态，指定桶优先）→ 桶；
 *   ③ 两缺（新建）：有工作区归属且非系统级 → runs/<桶>/<run_id>；否则平铺。
 * 非法 runId 原样平铺拼接（行为兼容——不扫描、不助穿越：调用方既有校验面不变）。
 */
export const resolveRunDir = (runsRoot: string, runId: string, opts?: { workspace?: string | null }): string => {
  if (!isValidRunId(runId)) return join(runsRoot, runId);
  const flat = join(runsRoot, runId);
  if (existsSync(flat)) return flat;
  const bucketed = findBucketed(runsRoot, runId, opts?.workspace ?? null);
  if (bucketed !== null) return bucketed;
  const workspace = opts?.workspace ?? null;
  if (workspace !== null && workspace !== "" && !SYSTEM_RUN_IDS.includes(runId)) {
    return join(runsRoot, workspace, runId);
  }
  return flat;
};

/** 平铺层 run 目录名清单（一级，含非 run 目录——looksLikeRun 过滤归调用方）。 */
export const flatRunDirNames = (runsRoot: string): string[] => {
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export interface BucketedRunEntry {
  workspace: string;
  runId: string;
  dir: string;
}

/** run 目录特征集（单源——atf-ui looksLikeRun 同码 re-export；readOnlyTools 列表共用）。 */
export const RUN_MARKER_RELS: readonly string[] = [
  join("launch", "launch_manifest.json"),
  "launch_manifest.json",
  "prep",
  "training",
  "webui",
  "eval",
];

/** run 目录特征判定（任一特征在位＝是 run）。 */
export const hasRunMarkers = (dir: string): boolean => RUN_MARKER_RELS.some((rel) => existsSync(join(dir, rel)));

export interface BucketedRunEntryOptions {
  /** 批㊶-S2：跳过「本身是 run」的一级目录再降层（其内部子目录是 run 结构不是桶——
   *  幻影防护单源化；缺省 false＝调用方自行裁决，true＝按 RUN_MARKER_RELS 判定跳过）。 */
  skipRunMarkerDirs?: boolean;
}

/** 分桶层 run 条目（二级扫描：平铺层每个目录视作候选桶，列其子目录——
 *  是否为 run 由调用方裁决（或 skipRunMarkerDirs 委托本模块）；点前缀目录跳过）。 */
export const bucketedRunEntries = (runsRoot: string, opts?: BucketedRunEntryOptions): BucketedRunEntry[] => {
  const entries: BucketedRunEntry[] = [];
  for (const workspace of flatRunDirNames(runsRoot)) {
    if (opts?.skipRunMarkerDirs === true && hasRunMarkers(join(runsRoot, workspace))) continue;
    let children: string[] = [];
    try {
      children = readdirSync(join(runsRoot, workspace), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const runId of children) {
      entries.push({ workspace, runId, dir: join(runsRoot, workspace, runId) });
    }
  }
  return entries;
};

/**
 * 段4.2——pending-confirm 存量清理扫描（确认/放行完成即删，含存量；备份改名 .answered.<毫秒>）。
 * 判据（完成证据在场才清，等待中的卡不动）：
 *   - kind=config_confirm 且 webui/config-snapshot.json 在场（saveConfigSnapshot＝确认完成产物）；
 *   - kind=publish_confirm 且 publish 段事实在场（appendSegmentFact＝放行完成产物）。
 * 返回清理的 pending 文件清单（原路径）；IO 异常逐 run fail-open 跳过。
 */
export const sweepAnsweredPendings = (runsRoot: string): string[] => {
  const swept: string[] = [];
  const consider = (dir: string): void => {
    const pendingPath = join(dir, "webui", "pending-confirm.json");
    if (!existsSync(pendingPath)) return;
    let kind = "";
    try {
      const parsed = JSON.parse(readFileSync(pendingPath, "utf8")) as { kind?: unknown };
      kind = typeof parsed?.kind === "string" ? parsed.kind : "";
    } catch {
      return; // 坏行不动（诚实优先）
    }
    const done =
      (kind === "config_confirm" && existsSync(join(dir, "webui", "config-snapshot.json"))) ||
      (kind === "publish_confirm" && hasSegmentFact(dir, "publish"));
    if (!done) return;
    try {
      renameSync(pendingPath, `${pendingPath}.answered.${Date.now()}.json`);
      swept.push(pendingPath);
    } catch {
      // fail-open：下周期再试
    }
  };
  for (const name of flatRunDirNames(runsRoot)) consider(join(runsRoot, name));
  for (const entry of bucketedRunEntries(runsRoot)) consider(entry.dir);
  return swept;
};
