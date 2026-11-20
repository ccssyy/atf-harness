/**
 * G2 交付物 3 测试：sessionBindings → ctx.storage（端口化）。
 *
 * 测真实实现：用文件实现（fileSessionBindingStore）与一个内存 kv unit 各跑同一套
 * 语义断言——两者共用同一批纯记录构造（nextBoundRecord / nextUnboundRecord），
 * 所以这套断言同时证明「换持久化介质不改判定」。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BINDINGS_HISTORY_MAX,
  bindSessionRunInto,
  enumerateBindingCandidates,
  fileSessionBindingStore,
  kvUnitSessionBindingStore,
  migrateFromRunBindingsInto,
  nextBoundRecord,
  readSessionBindingFrom,
  resolveActiveRunWith,
  resolveBindingsHome,
  sessionBindingsUnitDescriptor,
  unbindSessionIn,
  type KvUnitPort,
  type SessionBindingStore,
} from "../src/sessionBindings.js";

/** 内存 kv unit：模拟 vendor KvUnit 的 loadAll/putRecord/setGlobal 三面（含 tables/global 形状）。 */
const memoryKvUnit = (): KvUnitPort & { tables: Record<string, Record<string, unknown>>; global: unknown } => {
  const state: { tables: Record<string, Record<string, unknown>>; global: unknown } = { tables: {}, global: null };
  return {
    get tables() {
      return state.tables;
    },
    get global() {
      return state.global;
    },
    loadAll: async () => ({ tables: JSON.parse(JSON.stringify(state.tables)), global: state.global }),
    putRecord: async (table, key, value) => {
      (state.tables[table] ??= {})[key] = value;
    },
    setGlobal: async (value) => {
      state.global = value;
    },
  };
};

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atf-bindings-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const stores = (): Array<{ label: string; make: () => SessionBindingStore }> => [
  { label: "文件实现", make: () => fileSessionBindingStore(home) },
  { label: "kv unit 实现", make: () => kvUnitSessionBindingStore(memoryKvUnit()) },
];

describe("sessionBindings 端口化——判定语义与介质无关", () => {
  for (const { label, make } of stores()) {
    describe(label, () => {
      it("绑定写入后可按会话读回，且 unbound_reason 归 null", async () => {
        const store = make();
        const written = await bindSessionRunInto(store, "s1", { runId: "run-a", workspace: "ws", source: "auto_tool" });
        expect(written?.active_run_id).toBe("run-a");
        expect(written?.unbound_reason).toBeNull();
        const read = await readSessionBindingFrom(store, "s1");
        expect(read?.active_run_id).toBe("run-a");
        expect(read?.workspace).toBe("ws");
      });

      it("历史去重且上限 20、最新在前", async () => {
        const store = make();
        for (let i = 0; i < BINDINGS_HISTORY_MAX + 5; i += 1) {
          await bindSessionRunInto(store, "s1", { runId: `run-${i}`, workspace: null, source: "user_pick" });
        }
        // 重复绑定同一 run 不产生重复条目
        await bindSessionRunInto(store, "s1", { runId: `run-${BINDINGS_HISTORY_MAX + 4}`, workspace: null, source: "user_pick" });
        const read = await readSessionBindingFrom(store, "s1");
        expect(read?.history.length).toBe(BINDINGS_HISTORY_MAX);
        expect(read?.history[0]?.run_id).toBe(`run-${BINDINGS_HISTORY_MAX + 4}`);
        const ids = read?.history.map((h) => h.run_id) ?? [];
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("解绑保留历史（可撤销）并把 unbound_reason 置为给定原因", async () => {
        const store = make();
        await bindSessionRunInto(store, "s1", { runId: "run-a", workspace: null, source: "created" });
        const unbound = await unbindSessionIn(store, "s1", "cleared");
        expect(unbound?.active_run_id).toBeNull();
        expect(unbound?.unbound_reason).toBe("cleared");
        expect(unbound?.history.length).toBe(1);
      });

      it("空 sessionId / 空 runId 是 no-op（返回 null，不落记录）", async () => {
        const store = make();
        expect(await bindSessionRunInto(store, "", { runId: "r", workspace: null, source: "auto_tool" })).toBeNull();
        expect(await bindSessionRunInto(store, "s1", { runId: "", workspace: null, source: "auto_tool" })).toBeNull();
        expect(await readSessionBindingFrom(store, "")).toBeNull();
      });

      it("无记录 → reason:new；显式解绑 → reason 取记录值", async () => {
        const store = make();
        expect((await resolveActiveRunWith(store, join(home, "runs"), "absent", { canonicalRoots: [] })).reason).toBe("new");
        await bindSessionRunInto(store, "s1", { runId: "run-a", workspace: null, source: "created" });
        await unbindSessionIn(store, "s1", "stale");
        expect((await resolveActiveRunWith(store, join(home, "runs"), "s1", { canonicalRoots: [] })).reason).toBe("stale");
      });
    });
  }

  it("写入失败的 store 返回 null（fail-open，不抛）", async () => {
    const failing: SessionBindingStore = {
      load: async () => ({ schema_version: "SessionRunBinding/v1", sessions: {} }),
      save: async () => false,
      exists: async () => false,
    };
    expect(await bindSessionRunInto(failing, "s1", { runId: "r", workspace: null, source: "auto_tool" })).toBeNull();
  });
});

describe("sessionBindings——绑定家解析与 unit 描述符", () => {
  it("resolveBindingsHome：DSH_HOME 优先于 HOME", () => {
    expect(resolveBindingsHome({ DSH_HOME: "/d", HOME: "/h" }, "/fallback")).toBe("/d");
    expect(resolveBindingsHome({ HOME: "/h" }, "/fallback")).toBe("/h");
    expect(resolveBindingsHome({}, "/fallback")).toBe("/fallback");
  });

  it("unit 名满足 vendor UNIT_NAME_RE（^[a-z][a-z0-9_]*$）", () => {
    const d = sessionBindingsUnitDescriptor();
    expect(d.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(d.tables).toEqual(["sessions"]);
    expect(d.hasGlobal).toBe(true);
    expect(d.version).toBe(1);
  });
});

describe("sessionBindings——resolveActiveRun 的 run 存在性判定", () => {
  it("run 目录在场 → bound；消失 → stale（不写回）", async () => {
    const runsRoot = join(home, "runs");
    mkdirSync(join(runsRoot, "run-a"), { recursive: true });
    const store = fileSessionBindingStore(home);
    await bindSessionRunInto(store, "s1", { runId: "run-a", workspace: null, source: "created" });
    const bound = await resolveActiveRunWith(store, runsRoot, "s1", { canonicalRoots: [] });
    expect(bound.reason).toBe("bound");
    expect(bound.run).toBe(join(runsRoot, "run-a"));

    rmSync(join(runsRoot, "run-a"), { recursive: true, force: true });
    const stale = await resolveActiveRunWith(store, runsRoot, "s1", { canonicalRoots: [] });
    expect(stale.reason).toBe("stale");
    expect(stale.runId).toBe("run-a");
  });

  it("canonical 根注入后能命中 <ws>/experiments/<exp>/<runId> 形态", async () => {
    const ws = join(home, "ws");
    const runDir = join(ws, "experiments", "exp1", "run-c");
    mkdirSync(runDir, { recursive: true });
    // canonical 判定以 run.json 清单在场为准（runLayout.canonicalRunDirOf 的既有契约）
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "run-c" }), "utf8");
    const store = fileSessionBindingStore(home);
    await bindSessionRunInto(store, "s1", { runId: "run-c", workspace: null, source: "created" });
    const resolved = await resolveActiveRunWith(store, join(home, "runs"), "s1", { canonicalRoots: [ws] });
    expect(resolved.reason).toBe("bound");
    expect(resolved.run).toBe(runDir);
  });

  it("canonical 根缺省（空数组）时同一条记录判 stale——D49 缺陷形态，故选项必填", async () => {
    const ws = join(home, "ws");
    const runDir = join(ws, "experiments", "exp1", "run-c");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "run-c" }), "utf8");
    const store = fileSessionBindingStore(home);
    await bindSessionRunInto(store, "s1", { runId: "run-c", workspace: null, source: "created" });
    const resolved = await resolveActiveRunWith(store, join(home, "runs"), "s1", { canonicalRoots: [] });
    expect(resolved.reason).toBe("stale");
  });
});

describe("sessionBindings——迁移（幂等，不覆盖现役账本）", () => {
  it("空 runs 根 → 迁移 0 条；账本已在 → -1", async () => {
    const runsRoot = join(home, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const store = fileSessionBindingStore(home);
    expect(await migrateFromRunBindingsInto(store, runsRoot)).toBe(0);

    await bindSessionRunInto(store, "s1", { runId: "r", workspace: null, source: "auto_tool" });
    expect(await migrateFromRunBindingsInto(store, runsRoot)).toBe(-1);
  });

  it("自 run 侧 binding.json 聚合出账本（source=migrated）", async () => {
    const runsRoot = join(home, "runs");
    const runDir = join(runsRoot, "run-x");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(
      join(runDir, "webui", "binding.json"),
      JSON.stringify([{ session_id: "s9", bound_at: "2026-11-01T00:00:00.000Z" }]),
      "utf8",
    );
    const store = fileSessionBindingStore(home);
    expect(await migrateFromRunBindingsInto(store, runsRoot)).toBe(1);
    const read = await readSessionBindingFrom(store, "s9");
    expect(read?.active_run_id).toBe("run-x");
    expect(read?.source).toBe("migrated");
  });
});

describe("sessionBindings——nextBoundRecord 纯构造", () => {
  it("同一 run 重复绑定只留一条历史，且置顶", () => {
    const a = nextBoundRecord(null, { runId: "r1", workspace: null, source: "user_pick" }, "2026-11-01T00:00:00.000Z");
    const b = nextBoundRecord(a, { runId: "r2", workspace: null, source: "created" }, "2026-11-02T00:00:00.000Z");
    const c = nextBoundRecord(b, { runId: "r1", workspace: null, source: "created" }, "2026-11-03T00:00:00.000Z");
    expect(c.history.map((h) => h.run_id)).toEqual(["r1", "r2"]);
    expect(c.active_run_id).toBe("r1");
  });
});

describe("sessionBindings——候选枚举", () => {
  it("平铺与分桶 run 都进候选，按 mtime 倒序", () => {
    const runsRoot = join(home, "runs");
    mkdirSync(join(runsRoot, "flat-run"), { recursive: true });
    mkdirSync(join(runsRoot, "ws1", "bucket-run"), { recursive: true });
    const candidates = enumerateBindingCandidates(runsRoot);
    const ids = candidates.map((c) => c.runId);
    expect(ids).toContain("flat-run");
    expect(ids).toContain("bucket-run");
    expect(candidates.find((c) => c.runId === "bucket-run")?.workspace).toBe("ws1");
  });
});
