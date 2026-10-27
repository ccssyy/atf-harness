/**
 * 批B1——会话↔Run 绑定账本（SessionRunBinding/v1，harness 自有，原子写）。
 *
 * 设计要点（ATF_门1设计要点_会话与Run绑定_20261020 §三.1/§五.3、指令 B1 §一）：
 * - 存储 <DSH_HOME>/atf-state/session-bindings.json（DSH_HOME ?? HOME；目录不存在则建）——
 *   「会话→当前 run」正向指针的单源；run 侧 webui/binding.json 反向索引保留双写（runFacts），
 *   本账本可自其重建（migrateFromRunBindings，仅账本缺失时执行，幂等）。
 * - active_run_id=null 是合法状态；unbound_reason ∈ new|cleared|stale 供空态文案；
 * - 全部 API home 可注入（测试隔离）；写失败 fail-open（stderr 一条，不阻塞调用方主流程——
 *   绑定不得静默丢，但也不得拖垮工具）。
 * - 解析失败 → 原文件改名 .bak-<ts> 后以空账本继续（不崩）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { registeredWorkspaceRoots } from "./workspaceRegistry.js";
import { readBindings } from "./runFacts.js";
import { bucketedRunEntries, flatRunDirNames, resolveRunDir } from "./runLayout.js";
import { runSubdirCandidates } from "./runSubdirs.js";

/** 绑定来源闭集：auto_tool＝工具对既有 run 成功动作；user_pick＝用户显式选择；
 *  carried＝会话继承；created＝本会话新建实验后自动绑定；migrated＝自 run 侧账本聚合。 */
export type SessionBindingSource = "auto_tool" | "user_pick" | "carried" | "created" | "migrated";

/** 未绑定指因：new＝新会话（无记录）；cleared＝用户解除；stale＝run 消失。 */
export type UnboundReason = "new" | "cleared" | "stale";

export interface SessionBindingHistoryEntry {
  run_id: string;
  at: string;
  source: string;
}

export interface SessionRunBindingRecord {
  /** run 归属工作区（分桶桶名；平铺/系统级＝null——跨区判定与候选优先的数据源）。 */
  workspace: string | null;
  active_run_id: string | null;
  source: SessionBindingSource | null;
  unbound_reason: UnboundReason | null;
  updated_at: string;
  /** 最新在前，≤20，按 run_id 去重。 */
  history: SessionBindingHistoryEntry[];
}

interface SessionBindingsFile {
  schema_version: "SessionRunBinding/v1";
  sessions: Record<string, SessionRunBindingRecord>;
}

export const BINDINGS_SCHEMA_VERSION = "SessionRunBinding/v1";
export const BINDINGS_HISTORY_MAX = 20;

/** 绑定家解析：DSH_HOME ?? HOME env ?? 系统家（指令 B1 §一——目录不随 .dsh 别名分叉）。 */
export const resolveBindingsHome = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env["DSH_HOME"] !== undefined && env["DSH_HOME"] !== ""
    ? env["DSH_HOME"]
    : (env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : home);

/** 账本文件路径单源（<home>/atf-state/session-bindings.json）。 */
export const sessionBindingsPathOf = (home: string): string => join(home, "atf-state", "session-bindings.json");

const emptyLedger = (): SessionBindingsFile => ({ schema_version: BINDINGS_SCHEMA_VERSION, sessions: {} });

let lastStderrAt = 0;
const warnOnce = (message: string): void => {
  // stderr 一条（60s 节流——fail-open 留痕不刷屏）
  const at = Date.now();
  if (at - lastStderrAt < 60_000) return;
  lastStderrAt = at;
  console.error(`[atf-session-bindings] ${message}`);
};

/** 账本读取：缺席/空会话表 → 空账本；解析失败 → 原文件改名 .bak-<ts> 后以空账本继续（不崩）。 */
const readLedgerFile = (home: string): SessionBindingsFile => {
  const path = sessionBindingsPathOf(home);
  if (!existsSync(path)) return emptyLedger();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || typeof (parsed as SessionBindingsFile).sessions !== "object" || (parsed as SessionBindingsFile).sessions === null) {
      throw new Error("schema 形态不符（sessions 非对象）");
    }
    return parsed as SessionBindingsFile;
  } catch (cause) {
    const backup = `${path}.bak-${Date.now()}`;
    try {
      renameSync(path, backup);
      warnOnce(`账本解析失败，已备份至 ${backup} 后以空账本继续：${cause instanceof Error ? cause.message : String(cause)}`);
    } catch (backupCause) {
      warnOnce(`账本解析失败且备份失败（以空账本继续）：${backupCause instanceof Error ? backupCause.message : String(backupCause)}`);
    }
    return emptyLedger();
  }
};

/** 账本原子写（tmp＋rename；目录不存在则建；失败 fail-open stderr 一条，返回 false 不抛）。 */
const writeLedgerFile = (home: string, ledger: SessionBindingsFile): boolean => {
  const dir = join(home, "atf-state");
  const path = sessionBindingsPathOf(home);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 1)}\n`, "utf8");
    renameSync(tmp, path);
    return true;
  } catch (cause) {
    warnOnce(`账本写入失败（fail-open，不阻塞调用方）：${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
};

/** 历史去重合并（最新在前，≤20）：同 run_id 旧条目移除后 unshift 新条目。 */
const mergeHistory = (history: SessionBindingHistoryEntry[], entry: SessionBindingHistoryEntry): SessionBindingHistoryEntry[] =>
  [entry, ...history.filter((h) => h.run_id !== entry.run_id)].slice(0, BINDINGS_HISTORY_MAX);

const emptyRecord = (nowIso: string, unboundReason: UnboundReason | null = null): SessionRunBindingRecord => ({
  workspace: null,
  active_run_id: null,
  source: null,
  unbound_reason: unboundReason,
  updated_at: nowIso,
  history: [],
});

/** 读单会话绑定记录（无记录＝null——GET 侧视作 unbound_reason:new，不落盘）。 */
export const readSessionBinding = (home: string, sessionId: string): SessionRunBindingRecord | null => {
  if (sessionId === "") return null;
  return readLedgerFile(home).sessions[sessionId] ?? null;
};

/** 绑定（bind）：active_run_id=runId，unbound_reason=null，history 去重后追加（≤20 最新在前）。
 *  记录不存在则新建（workspace 由调用方按 run 归属传入）。写失败 fail-open（返回 null）。 */
export const bindSessionRun = (
  home: string,
  sessionId: string,
  binding: { runId: string; workspace: string | null; source: SessionBindingSource },
): SessionRunBindingRecord | null => {
  if (sessionId === "" || binding.runId === "") return null;
  const ledger = readLedgerFile(home);
  const nowIso = new Date().toISOString();
  const prior = ledger.sessions[sessionId] ?? emptyRecord(nowIso);
  const next: SessionRunBindingRecord = {
    workspace: binding.workspace,
    active_run_id: binding.runId,
    source: binding.source,
    unbound_reason: null,
    updated_at: nowIso,
    history: mergeHistory(prior.history, { run_id: binding.runId, at: nowIso, source: binding.source }),
  };
  ledger.sessions[sessionId] = next;
  return writeLedgerFile(home, ledger) ? next : null;
};

/** 解除（unbind）：active_run_id=null，unbound_reason ∈ cleared|stale（history 保留——可撤销）。 */
export const unbindSession = (home: string, sessionId: string, reason: Extract<UnboundReason, "cleared" | "stale">): SessionRunBindingRecord | null => {
  if (sessionId === "") return null;
  const ledger = readLedgerFile(home);
  const nowIso = new Date().toISOString();
  const prior = ledger.sessions[sessionId] ?? emptyRecord(nowIso);
  const next: SessionRunBindingRecord = { ...prior, active_run_id: null, source: null, unbound_reason: reason, updated_at: nowIso };
  ledger.sessions[sessionId] = next;
  return writeLedgerFile(home, ledger) ? next : null;
};

/** 会话当前绑定的活跃 run 解析：读绑定 → resolveRunDir 校验 run 存在。
 *  run 目录消失 → 不改文件，返回 {run:null, reason:"stale"}（是否落 unbindSession 由调用方定）；
 *  无记录 → {run:null, reason:"new"}；记录显式解绑 → reason 取其 unbound_reason（缺省 cleared）。 */
export interface ActiveRunResolution {
  run: string | null;
  runId: string | null;
  workspace: string | null;
  reason: "bound" | "stale" | "new" | "cleared";
}

export const resolveActiveRun = (home: string, runsRoot: string, sessionId: string): ActiveRunResolution => {
  const record = readSessionBinding(home, sessionId);
  if (record === null) return { run: null, runId: null, workspace: null, reason: "new" };
  if (record.active_run_id === null || record.active_run_id === "") {
    return { run: null, runId: null, workspace: record.workspace, reason: record.unbound_reason ?? "cleared" };
  }
  const runId = record.active_run_id;
  // canonical 档必须带注册工作区根：v3 canonical run 住 `<ws>/experiments/<exp>/<run_id>`，
  // 不带＝只查平铺/桶＝已绑定 run 被误判 stale（D49 单源缺口）。
  const runDir = resolveRunDir(runsRoot, runId, { canonicalRoots: registeredWorkspaceRoots(home) });
  if (!existsSync(runDir)) return { run: null, runId, workspace: record.workspace, reason: "stale" };
  return { run: runDir, runId, workspace: record.workspace, reason: "bound" };
};

// ── 迁移（仅账本缺失时执行，幂等）────────────────────────────────────────────

/** 扫 runs（平铺＋分桶）逐 run 读 webui/binding.json（runFacts 反向索引），按 session 聚合：
 *  active＝bound_at 最大者，source=migrated，history 全量（≤20，bound_at 倒序）。
 *  仅在账本文件不存在时执行（返回迁移 session 数）；账本已在 → 返回 -1（不覆盖现役账本）。 */
export const migrateFromRunBindings = (home: string, runsRoot: string): number => {
  if (existsSync(sessionBindingsPathOf(home))) return -1;
  const bySession: Record<string, Array<{ runId: string; at: number; atIso: string }>> = {};
  const visit = (runDir: string): void => {
    for (const binding of readBindings(runDir)) {
      const at = Date.parse(binding.bound_at);
      const list = bySession[binding.session_id] ?? (bySession[binding.session_id] = []);
      list.push({ runId: basename(runDir), at: Number.isFinite(at) ? at : 0, atIso: binding.bound_at });
    }
  };
  try {
    if (!existsSync(runsRoot)) return 0;
    const hasBinding = (runDir: string): boolean =>
      runSubdirCandidates(runDir, "webui").some((dir) => existsSync(join(dir, "binding.json")));
    for (const level1 of flatRunDirNames(runsRoot)) {
      const level1Path = join(runsRoot, level1);
      if (hasBinding(level1Path)) {
        visit(level1Path);
        continue;
      }
      // 工作区分桶形态：runs/<workspace>/<run_id>/webui/binding.json（单层降级扫描）
      let children: string[] = [];
      try {
        children = readdirSync(level1Path, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name);
      } catch {
        continue; // 桶层不可读——跳过
      }
      for (const runId of children) {
        const runDir = join(level1Path, runId);
        if (hasBinding(runDir)) visit(runDir);
      }
    }
  } catch {
    return 0; // 扫描失败＝迁移不出（重建不出＝未绑定——设计要点 §五.3，不造账）
  }
  const sessionIds = Object.keys(bySession);
  if (sessionIds.length === 0) return 0;
  const ledger = emptyLedger();
  for (const sessionId of sessionIds) {
    const hits = (bySession[sessionId] ?? []).sort((a, b) => b.at - a.at).slice(0, BINDINGS_HISTORY_MAX);
    if (hits.length === 0) continue;
    const best = hits[0]!;
    ledger.sessions[sessionId] = {
      workspace: null,
      active_run_id: best.runId,
      source: "migrated",
      unbound_reason: null,
      updated_at: new Date().toISOString(),
      history: hits.map((h) => ({ run_id: h.runId, at: h.atIso, source: "migrated" })),
    };
  }
  return writeLedgerFile(home, ledger) ? Object.keys(ledger.sessions).length : 0;
};

/** run 目录 mtime（stat 失败＝0——排序降权，不猜时刻）。 */
const dirMtimeMs = (dir: string): number => {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
};

export interface BindingCandidateEntry {
  runId: string;
  dir: string;
  workspace: string | null;
  mtimeMs: number;
}

/** 候选 run 枚举（runsRoot 平铺＋分桶；mtime 倒序）。特征过滤归调用方（runDisplay 组装面）。 */
export const enumerateBindingCandidates = (runsRoot: string): BindingCandidateEntry[] => {
  const entries: BindingCandidateEntry[] = [];
  for (const name of flatRunDirNames(runsRoot)) {
    const dir = join(runsRoot, name);
    entries.push({ runId: name, dir, workspace: null, mtimeMs: dirMtimeMs(dir) });
  }
  for (const entry of bucketedRunEntries(runsRoot)) {
    entries.push({ runId: entry.runId, dir: entry.dir, workspace: entry.workspace, mtimeMs: dirMtimeMs(entry.dir) });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
};
