/**
 * 批B1——会话↔Run 绑定账本（SessionRunBinding/v1，harness 自有）。
 *
 * 设计要点（ATF_门1设计要点_会话与Run绑定_20261020 §三.1/§五.3、指令 B1 §一）：
 * - 「会话→当前 run」正向指针的单源；run 侧 webui/binding.json 反向索引保留双写
 *   （runFacts），本账本可自其重建（migrateFromRunBindings，仅账本缺失时执行，幂等）。
 * - active_run_id=null 是合法状态；unbound_reason ∈ new|cleared|stale 供空态文案；
 * - 写失败 fail-open（stderr 一条，不阻塞调用方主流程——绑定不得静默丢，但也不得拖垮工具）。
 *
 * ── G2 迁移改造（施工卡交付物 3）─────────────────────────────────────────────
 * 改的是**持久化接口**，判定语义逐字未动：
 * - 旧形态：路径写死 `<home>/atf-state/session-bindings.json`，函数第一个参数是 home。
 * - 新形态：持久化收敛到一个 `SessionBindingStore` 端口（load / save / exists 三方法），
 *   生产路径由调用方注入 `kvUnitSessionBindingStore(unit)`——unit 即 vendor
 *   `ctx.storage.backend.get(name).open(descriptor)` 的产物（@deepseek-ai/dsh-storage
 *   backend.ts::KvUnit 的结构子集，本文件不 import vendor 包，避免把包解析耦合带进来）。
 * - 文件实现 `fileSessionBindingStore(home)` 保留：迁移期双副本与测试都用它，行为与原
 *   实现逐位一致（原子写 tmp+rename、解析失败改名 .bak-<ts>、写失败 fail-open）。
 * - home 版同步导出（readSessionBinding / bindSessionRun / ...）原样保留，内部走文件实现
 *   ——G3 改造前 atf-ui/atf-tools 仍按旧签名消费，不能在同一批里断链。
 *
 * 依赖改造（候裁说明）：canonical 根原取自 B 类 `workspaceRegistry.registeredWorkspaceRoots`，
 * 方案 §3.2 判其删除。本批不替 owner 做决定，故双轨处理：
 * - 端口版 `resolveActiveRunWith` 由调用方注入 `canonicalRoots`（必填——传空数组会让
 *   canonical run 被判 stale，即 D49 缺陷形态，故不做缺省）；
 * - 兼容版 `resolveActiveRun` 保持原签名原行为（仍从 src 的 workspaceRegistry 取根），
 *   以免 G3 改造前 atf-ui/atf-tools 的行为在同一批里漂移。该引用指向 src 原文件（不复制），
 *   G5 收口时随 B 类一起改道 ctx.workspaceRegistry。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { registeredWorkspaceRoots } from "../../../../src/core/workspace/workspaceRegistry.js";
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

export interface SessionBindingsFile {
  schema_version: "SessionRunBinding/v1";
  sessions: Record<string, SessionRunBindingRecord>;
}

export const BINDINGS_SCHEMA_VERSION = "SessionRunBinding/v1";
export const BINDINGS_HISTORY_MAX = 20;

// ── 存储端口（G2 新增）────────────────────────────────────────────────────

/**
 * 绑定账本的持久化端口。三方法都不得抛：损坏介质一律降级为空账本并在 load 内留痕，
 * 写失败返回 false 由调用方 fail-open（与旧实现的 fail-open 语义一致）。
 */
export interface SessionBindingStore {
  /** 读全量账本：缺席＝空账本；解析失败＝备份后空账本（idempotent）。 */
  load(): Promise<SessionBindingsFile>;
  /** 写全量账本：成功 true；失败 false（不抛）。 */
  save(ledger: SessionBindingsFile): Promise<boolean>;
  /** 账本是否已存在（迁移判定用：已在＝不覆盖现役账本）。 */
  exists(): Promise<boolean>;
}

/**
 * vendor `KvUnit` 的结构子集（@deepseek-ai/dsh-storage `src/backend.ts`）。
 * 只声明本账本用到的三个成员：镜像 vendor 的最小面，不做完整契约复刻。
 */
export interface KvUnitPort {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>;
  putRecord(table: string, key: string, value: unknown): Promise<void>;
  setGlobal(value: unknown): Promise<void>;
}

/** unit 名（须匹配 vendor UNIT_NAME_RE `^[a-z][a-z0-9_]*$`——名称即文件名/SQL 标识片段）。 */
export const SESSION_BINDINGS_UNIT = "atf_session_bindings";
/** 唯一表名（一个会话一条记录，键＝sessionId）。 */
export const SESSION_BINDINGS_TABLE = "sessions";
export const SESSION_BINDINGS_UNIT_VERSION = 1;

/** unit 描述符：调用方 `backend.get(name).open(sessionBindingsUnitDescriptor())` 直接可用。 */
export const sessionBindingsUnitDescriptor = (): {
  name: string;
  version: number;
  tables: readonly string[];
  hasGlobal: boolean;
} => ({
  name: SESSION_BINDINGS_UNIT,
  version: SESSION_BINDINGS_UNIT_VERSION,
  tables: [SESSION_BINDINGS_TABLE],
  hasGlobal: true,
});

const emptyLedger = (): SessionBindingsFile => ({ schema_version: BINDINGS_SCHEMA_VERSION, sessions: {} });

let lastStderrAt = 0;
const warnOnce = (message: string): void => {
  // stderr 一条（60s 节流——fail-open 留痕不刷屏）
  const at = Date.now();
  if (at - lastStderrAt < 60_000) return;
  lastStderrAt = at;
  console.error(`[atf-session-bindings] ${message}`);
};

/** 绑定家解析：DSH_HOME ?? HOME env ?? 系统家（指令 B1 §一——目录不随 .dsh 别名分叉）。 */
export const resolveBindingsHome = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env["DSH_HOME"] !== undefined && env["DSH_HOME"] !== ""
    ? env["DSH_HOME"]
    : (env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : home);

/** 账本文件路径单源（<home>/atf-state/session-bindings.json）——文件实现专用。 */
export const sessionBindingsPathOf = (home: string): string => join(home, "atf-state", "session-bindings.json");

/** 账本解析失败备份改名（唯一写路径共用）。 */
const backupCorruptLedger = (path: string, cause: unknown): void => {
  const backup = `${path}.bak-${Date.now()}`;
  try {
    renameSync(path, backup);
    warnOnce(`账本解析失败，已备份至 ${backup} 后以空账本继续：${cause instanceof Error ? cause.message : String(cause)}`);
  } catch (backupCause) {
    warnOnce(`账本解析失败且备份失败（以空账本继续）：${backupCause instanceof Error ? backupCause.message : String(backupCause)}`);
  }
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
    backupCorruptLedger(path, cause);
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

/** 文件实现（迁移期＋测试）。行为与原实现逐位一致。 */
export const fileSessionBindingStore = (home: string): SessionBindingStore => ({
  load: async () => readLedgerFile(home),
  save: async (ledger) => writeLedgerFile(home, ledger),
  exists: async () => existsSync(sessionBindingsPathOf(home)),
});

/** 账本 global 槽（schema_version 单源落点；缺失/形态不符＝旧账本，按当前版本读）。 */
const ledgerOfGlobal = (global: unknown, tables: Record<string, Record<string, unknown>>): SessionBindingsFile => {
  const sessions = (tables[SESSION_BINDINGS_TABLE] ?? {}) as Record<string, SessionRunBindingRecord>;
  if (global !== null && typeof global === "object" && (global as { schema_version?: unknown }).schema_version === BINDINGS_SCHEMA_VERSION) {
    return { schema_version: BINDINGS_SCHEMA_VERSION, sessions };
  }
  return { schema_version: BINDINGS_SCHEMA_VERSION, sessions };
};

/**
 * ctx.storage 的 KV unit 实现（生产路径）。
 * 每会话一条记录（putRecord），schema_version 走 global 槽；删除会话记录不需要
 * ——解绑是记录内状态（active_run_id=null），不是删行。
 */
export const kvUnitSessionBindingStore = (unit: KvUnitPort): SessionBindingStore => {
  let present: boolean | null = null;
  return {
    load: async () => {
      const { tables, global } = await unit.loadAll();
      present = Object.keys(tables[SESSION_BINDINGS_TABLE] ?? {}).length > 0 || global !== null;
      return ledgerOfGlobal(global, tables);
    },
    save: async (ledger) => {
      try {
        for (const [sessionId, record] of Object.entries(ledger.sessions)) {
          await unit.putRecord(SESSION_BINDINGS_TABLE, sessionId, record);
        }
        await unit.setGlobal({ schema_version: ledger.schema_version });
        present = true;
        return true;
      } catch (cause) {
        warnOnce(`账本写入失败（fail-open，不阻塞调用方）：${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
    },
    exists: async () => {
      if (present !== null) return present;
      const { tables, global } = await unit.loadAll();
      present = Object.keys(tables[SESSION_BINDINGS_TABLE] ?? {}).length > 0 || global !== null;
      return present;
    },
  };
};

// ── 记录构造（纯函数：文件实现与 unit 实现共用同一判定）────────────────────

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

/** bind 后的记录（纯：不读不写，只算下一状态）。 */
export const nextBoundRecord = (
  prior: SessionRunBindingRecord | null,
  binding: { runId: string; workspace: string | null; source: SessionBindingSource },
  nowIso: string,
): SessionRunBindingRecord => ({
  workspace: binding.workspace,
  active_run_id: binding.runId,
  source: binding.source,
  unbound_reason: null,
  updated_at: nowIso,
  history: mergeHistory((prior ?? emptyRecord(nowIso)).history, { run_id: binding.runId, at: nowIso, source: binding.source }),
});

/** unbind 后的记录（纯：history 保留——可撤销）。 */
export const nextUnboundRecord = (
  prior: SessionRunBindingRecord | null,
  reason: Extract<UnboundReason, "cleared" | "stale">,
  nowIso: string,
): SessionRunBindingRecord => {
  const base = prior ?? emptyRecord(nowIso);
  return { ...base, active_run_id: null, source: null, unbound_reason: reason, updated_at: nowIso };
};

// ── 兼容层：原 home 同步签名（G3 改造前的现役消费方用）──────────────────────

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
  const next = nextBoundRecord(ledger.sessions[sessionId] ?? null, binding, new Date().toISOString());
  ledger.sessions[sessionId] = next;
  return writeLedgerFile(home, ledger) ? next : null;
};

/** 解除（unbind）：active_run_id=null，unbound_reason ∈ cleared|stale（history 保留——可撤销）。 */
export const unbindSession = (home: string, sessionId: string, reason: Extract<UnboundReason, "cleared" | "stale">): SessionRunBindingRecord | null => {
  if (sessionId === "") return null;
  const ledger = readLedgerFile(home);
  const next = nextUnboundRecord(ledger.sessions[sessionId] ?? null, reason, new Date().toISOString());
  ledger.sessions[sessionId] = next;
  return writeLedgerFile(home, ledger) ? next : null;
};

// ── 端口版公开面（G2 新增：生产走 ctx.storage unit）──────────────────────────

/** 读单会话绑定记录（端口版）。 */
export const readSessionBindingFrom = async (store: SessionBindingStore, sessionId: string): Promise<SessionRunBindingRecord | null> => {
  if (sessionId === "") return null;
  return (await store.load()).sessions[sessionId] ?? null;
};

/** 绑定（端口版）：写失败 fail-open（返回 null，不抛）。 */
export const bindSessionRunInto = async (
  store: SessionBindingStore,
  sessionId: string,
  binding: { runId: string; workspace: string | null; source: SessionBindingSource },
): Promise<SessionRunBindingRecord | null> => {
  if (sessionId === "" || binding.runId === "") return null;
  const ledger = await store.load();
  const next = nextBoundRecord(ledger.sessions[sessionId] ?? null, binding, new Date().toISOString());
  ledger.sessions[sessionId] = next;
  return (await store.save(ledger)) ? next : null;
};

/** 解除（端口版）。 */
export const unbindSessionIn = async (
  store: SessionBindingStore,
  sessionId: string,
  reason: Extract<UnboundReason, "cleared" | "stale">,
): Promise<SessionRunBindingRecord | null> => {
  if (sessionId === "") return null;
  const ledger = await store.load();
  const next = nextUnboundRecord(ledger.sessions[sessionId] ?? null, reason, new Date().toISOString());
  ledger.sessions[sessionId] = next;
  return (await store.save(ledger)) ? next : null;
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

export interface ResolveActiveRunOptions {
  /** canonical 档工作区根（D49 单源缺口：不带＝已绑定 run 被误判 stale）。
   *  来源＝工作区登记的根列表；G2 起由调用方注入（B 类 workspaceRegistry 将退役）。 */
  canonicalRoots: readonly string[];
}

/** 记录→解析结果（纯：不含 IO 以外的判定，home 版与端口版共用）。 */
const resolveActiveRecord = (
  record: SessionRunBindingRecord | null,
  runsRoot: string,
  options: ResolveActiveRunOptions,
): ActiveRunResolution => {
  if (record === null) return { run: null, runId: null, workspace: null, reason: "new" };
  if (record.active_run_id === null || record.active_run_id === "") {
    return { run: null, runId: null, workspace: record.workspace, reason: record.unbound_reason ?? "cleared" };
  }
  const runId = record.active_run_id;
  // canonical 档必须带注册工作区根：v3 canonical run 住 `<ws>/experiments/<exp>/<run_id>`，
  // 不带＝只查平铺/桶＝已绑定 run 被误判 stale（D49 单源缺口）。
  const runDir = resolveRunDir(runsRoot, runId, { canonicalRoots: options.canonicalRoots });
  if (!existsSync(runDir)) return { run: null, runId, workspace: record.workspace, reason: "stale" };
  return { run: runDir, runId, workspace: record.workspace, reason: "bound" };
};

/** 端口版：会话当前活跃 run（canonical 根由调用方注入）。 */
export const resolveActiveRunWith = async (
  store: SessionBindingStore,
  runsRoot: string,
  sessionId: string,
  options: ResolveActiveRunOptions,
): Promise<ActiveRunResolution> => resolveActiveRecord(await readSessionBindingFrom(store, sessionId), runsRoot, options);

/** 兼容版：会话当前活跃 run（原签名；canonical 根仍取自工作区登记——G3 前行为不变）。 */
export const resolveActiveRun = (home: string, runsRoot: string, sessionId: string): ActiveRunResolution =>
  resolveActiveRecord(readSessionBinding(home, sessionId), runsRoot, { canonicalRoots: registeredWorkspaceRoots(home) });

// ── 迁移（仅账本缺失时执行，幂等）────────────────────────────────────────────

/** 扫 runs（平铺＋分桶）逐 run 读 webui/binding.json（runFacts 反向索引），按 session 聚合：
 *  active＝bound_at 最大者，source=migrated，history 全量（≤20，bound_at 倒序）。 */
const aggregateFromRunBindings = (runsRoot: string): SessionBindingsFile => {
  const bySession: Record<string, Array<{ runId: string; at: number; atIso: string }>> = {};
  const visit = (runDir: string): void => {
    for (const binding of readBindings(runDir)) {
      const at = Date.parse(binding.bound_at);
      const list = bySession[binding.session_id] ?? (bySession[binding.session_id] = []);
      list.push({ runId: basename(runDir), at: Number.isFinite(at) ? at : 0, atIso: binding.bound_at });
    }
  };
  const ledger = emptyLedger();
  try {
    if (!existsSync(runsRoot)) return ledger;
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
    return ledger; // 扫描失败＝迁移不出（重建不出＝未绑定——设计要点 §五.3，不造账）
  }
  for (const sessionId of Object.keys(bySession)) {
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
  return ledger;
};

/** 端口版迁移：账本已在 → -1（不覆盖现役账本）；否则聚合写入，返回迁移会话数。 */
export const migrateFromRunBindingsInto = async (store: SessionBindingStore, runsRoot: string): Promise<number> => {
  if (await store.exists()) return -1;
  const ledger = aggregateFromRunBindings(runsRoot);
  if (Object.keys(ledger.sessions).length === 0) return 0;
  return (await store.save(ledger)) ? Object.keys(ledger.sessions).length : 0;
};

/** 文件版迁移（原签名保留）：账本已在 → -1；否则聚合写入，返回迁移会话数。 */
export const migrateFromRunBindings = (home: string, runsRoot: string): number => {
  if (existsSync(sessionBindingsPathOf(home))) return -1;
  const ledger = aggregateFromRunBindings(runsRoot);
  if (Object.keys(ledger.sessions).length === 0) return 0;
  return writeLedgerFile(home, ledger) ? Object.keys(ledger.sessions).length : 0;
};

// ── 候选枚举（无 home 依赖，原样保留）────────────────────────────────────────

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
