/**
 * D83 测试锚——递归删除硬 deny 收口（workspace/runs 根直接拒绝＋换 run-id 指引）。
 *
 * 依据《ATF_指令_D83_删除循环收口_20261023》§一.1/§一.2（harness 侧）＋任务卡测试要求：
 *   - 三类根删除硬 deny（workspace 根／workspace 三桶根／全局 runs 根＋其下工作区目录）
 *     ——无审批通道 fail-closed，回流带替代路径指引；
 *   - run 内部产物删除仍走既有审批（REQUIRES_CONFIRMATION，非硬 deny；理由面含路径
 *     全文＋「不可逆」）；
 *   - D52 操作符切分零回归（操作符右段不误判）；workspace 边界附近不误伤。
 * 全部用 temp fixture 造真目录（红线：不删任何真实数据）。
 */
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFileGuardTools,
  DESTRUCTIVE_COMMAND_HARD_DENY,
  DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION,
  destructiveCommandScan,
  destructiveHardDenyGuard,
  hardDenyKindFor,
  type HardDenyFacts,
} from "../../packages/extensions/atf-tools/src/fileGuardFace.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d83-hard-deny-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** env 注入（保存恢复——vitest 同进程共享 process.env，沿 D21 withDshHome 模式）。 */
const withEnv = async (env: Record<string, string>, run: () => Promise<void>): Promise<void> => {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** temp fixture 工作区（真实 fs 事实——.atf/workspace.json 身份文件＋三桶＋实验 runs 内路径）。 */
interface D83Fixture {
  root: string;
  ws: string;
  runsRoot: string;
  bucketWs: string; // 全局 runs 根下工作区桶
  runDir: string; // 分桶 run 目录（含 binding.json）
  flatRun: string; // 平铺 run 目录（含 binding.json）
  dshHome: string; // 空 DSH 家（登记面隔离）
}

const makeFixture = (): D83Fixture => {
  const root = tempRoot();
  const ws = join(root, "ws");
  for (const bucket of ["runs", "datasets", "splits"]) mkdirSync(join(ws, bucket), { recursive: true });
  mkdirSync(join(ws, ".atf"), { recursive: true });
  writeFileSync(join(ws, ".atf", "workspace.json"), JSON.stringify({ id: "d83-ws-id", name: "ws", experiments: [], createdAt: "2026-10-23T00:00:00Z" }, null, 2) + "\n");
  mkdirSync(join(ws, "experiments", "e1", "runs", "r1"), { recursive: true });
  writeFileSync(join(ws, "experiments", "e1", "runs", "r1", "ckpt.bin"), "fixture");
  const runsRoot = join(root, "runs-root");
  const runDir = join(runsRoot, "wsA", "run-1");
  mkdirSync(join(runDir, "webui"), { recursive: true });
  mkdirSync(join(runDir, "training"), { recursive: true });
  writeFileSync(join(runDir, "webui", "binding.json"), `${JSON.stringify([{ session_id: "sess-d83", bound_at: "2026-10-23T10:00:00Z" }], null, 1)}\n`);
  writeFileSync(join(runDir, "training", "trainer_log.jsonl"), "");
  const flatRun = join(runsRoot, "run-flat");
  mkdirSync(join(flatRun, "webui"), { recursive: true });
  writeFileSync(join(flatRun, "webui", "binding.json"), `${JSON.stringify([{ session_id: "sess-flat", bound_at: "2026-10-23T10:00:00Z" }], null, 1)}\n`);
  const dshHome = join(root, "dsh-home");
  mkdirSync(join(dshHome, "storages"), { recursive: true });
  return { root, ws, runsRoot, bucketWs: join(runsRoot, "wsA"), runDir, flatRun, dshHome };
};

/** A7 四件装配（roots＝fixture 根；审批 ctx 可选注入）。 */
const buildTools = (fixture: D83Fixture, approvalCtx?: { get(service: string): unknown }) => {
  const tools = buildFileGuardTools({ roots: [fixture.root], env: {} }, { runsRoot: fixture.runsRoot, ...(approvalCtx !== undefined ? { approvalCtx } : {}) }) as Array<{
    name: string;
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
  }>;
  return tools.find((tool) => tool.name === "atf_bash")!;
};

/** 审批假服务（记录卡面理由；沿 fileGuard.test.ts D23 模式）。 */
const approvalCtxOf = (outcome: string, captured?: { reason?: string }): { get: (service: string) => unknown } => ({
  get: (service: string) =>
    service === "approval"
      ? { request: async (req: { reason: string }) => { if (captured !== undefined) captured.reason = req.reason; return outcome; } }
      : undefined,
});

describe("D83 硬 deny——三类根删除直接拒绝（无审批通道 fail-closed）", () => {
  it("rm -rf <workspace 根> → 硬 deny＋换 run-id/--rerun 指引；审批服务在场也不弹卡；目标零执行", async () => {
    const fx = makeFixture();
    // ws 目标不在 runs 根内——经 ATF_WORKSPACE_ALLOWLIST 并入围栏可读集（读域声明，
    // 使命令触达硬 deny 判定；fence 拒绝面本身不由本批改动）。
    await withEnv({ DSH_HOME: fx.dshHome, ATF_WORKSPACE_ALLOWLIST: fx.ws }, async () => {
      const bash = buildTools(fx, { get: () => { throw new Error("硬 deny 不应弹审批卡"); } });
      const denied = await bash.execute({ command: `rm -rf ${fx.ws}` }, { callId: "t", agent: undefined });
      expect(denied["ok"]).toBe(false);
      expect(denied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(denied["kind"]).toBe("workspace_root");
      const message = String(denied["message"]);
      expect(message).toContain(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(message).toContain("--run-id <new>");
      expect(message).toContain("--rerun");
      // 零执行：身份文件与三桶仍在盘
      expect(existsSync(join(fx.ws, ".atf", "workspace.json"))).toBe(true);
      expect(existsSync(join(fx.ws, "runs"))).toBe(true);
    });
  });

  it("rm -rf <workspace 三桶根>（runs/datasets/splits）→ 硬 deny（workspace_bucket_root）", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_WORKSPACE_ALLOWLIST: fx.ws }, async () => {
      const bash = buildTools(fx);
      for (const bucket of ["runs", "datasets", "splits"]) {
        const denied = await bash.execute({ command: `rm -rf ${join(fx.ws, bucket)}` }, { callId: "t", agent: undefined });
        expect(denied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
        expect(denied["kind"]).toBe("workspace_bucket_root");
        expect(existsSync(join(fx.ws, bucket))).toBe(true);
      }
    });
  });

  it("rm -rf <全局 runs 根> 及其下工作区目录 → 硬 deny（ATF_DSH_RUNS_ROOT 指向 temp）", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_DSH_RUNS_ROOT: fx.runsRoot }, async () => {
      const bash = buildTools(fx);
      const rootDenied = await bash.execute({ command: `rm -rf ${fx.runsRoot}` }, { callId: "t", agent: undefined });
      expect(rootDenied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(rootDenied["kind"]).toBe("global_runs_root");
      const wsDenied = await bash.execute({ command: `rm -rf ${fx.bucketWs}` }, { callId: "t", agent: undefined });
      expect(wsDenied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(wsDenied["kind"]).toBe("runs_workspace_dir");
      expect(existsSync(fx.bucketWs)).toBe(true);
      expect(existsSync(fx.runsRoot)).toBe(true);
    });
  });

  it("登记面补充事实：注册工作区即使身份文件缺席也硬 deny（DSH 注册表 path 命中）", async () => {
    const fx = makeFixture();
    const bareWs = join(fx.root, "bare-ws");
    mkdirSync(bareWs, { recursive: true }); // 无 .atf/workspace.json
    writeFileSync(
      join(fx.dshHome, "storages", "workspace.json"),
      JSON.stringify(
        {
          unit: { name: "workspace", version: 2 },
          global: { initialized: true, workspaceIds: ["w1"], archivedSessionIds: [], pinnedSessionIds: [] },
          tables: { workspaces: { w1: { path: bareWs, title: "注册工作区", sessionIds: [], createdAt: "", updatedAt: "" } } },
        },
        null,
        2,
      ) + "\n",
    );
    await withEnv({ DSH_HOME: fx.dshHome }, async () => {
      const bash = buildTools(fx);
      const denied = await bash.execute({ command: `rm -rf ${bareWs}` }, { callId: "t", agent: undefined });
      expect(denied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(denied["kind"]).toBe("workspace_root");
      expect(existsSync(bareWs)).toBe(true);
    });
  });
});

describe("D83 审批面保留——run 内部产物删除仍走既有审批（非硬 deny）", () => {
  it("rm -rf <runs>/<ws>/<id>/内部路径 → REQUIRES_CONFIRMATION；审批理由面含路径全文＋不可逆", async () => {
    const fx = makeFixture();
    const innerTarget = join(fx.runDir, "training");
    await withEnv({ DSH_HOME: fx.dshHome, ATF_DSH_RUNS_ROOT: fx.runsRoot }, async () => {
      // 审批 ctx 缺席 → 既有 unavailable 拒绝面（证明未走硬 deny、也未静默放行）
      const bashNoApproval = buildTools(fx);
      const refused = await bashNoApproval.execute({ command: `rm -rf ${innerTarget}` }, { callId: "t", agent: undefined });
      expect(refused["ok"]).toBe(false);
      expect(refused["error"]).toBe(DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION);
      expect(refused["outcome"]).toBe("unavailable");
      expect(existsSync(innerTarget)).toBe(true);
      // owner 放行 → 真执行；卡面理由含被删路径全文＋「不可逆」字样
      const captured: { reason?: string } = {};
      const bashAllowed = buildTools(fx, approvalCtxOf("allowed-once", captured));
      const released = await bashAllowed.execute({ command: `rm -rf ${innerTarget}` }, { callId: "t", agent: undefined });
      expect(released["ok"]).toBe(true);
      expect(existsSync(innerTarget)).toBe(false);
      expect(String(captured.reason)).toContain(innerTarget);
      expect(String(captured.reason)).toContain("不可逆");
    });
  });

  it("平铺 run 目录整删（webui/binding.json 在场）→ 既有审批形态而非硬 deny", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_DSH_RUNS_ROOT: fx.runsRoot }, async () => {
      const bash = buildTools(fx);
      const refused = await bash.execute({ command: `rm -rf ${fx.flatRun}` }, { callId: "t", agent: undefined });
      expect(refused["error"]).toBe(DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION);
      expect(refused["outcome"]).toBe("unavailable");
      expect(existsSync(fx.flatRun)).toBe(true);
    });
  });
});

describe("D83 边界不误伤＋D52 切分零回归", () => {
  it("workspace 内实验 runs 的 run 内路径与非三桶子目录不硬 deny（走既有审批形态）", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_WORKSPACE_ALLOWLIST: fx.ws }, async () => {
      const bash = buildTools(fx);
      for (const target of [join(fx.ws, "experiments"), join(fx.ws, "experiments", "e1", "runs", "r1")]) {
        const refused = await bash.execute({ command: `rm -rf ${target}` }, { callId: "t", agent: undefined });
        expect(refused["error"]).toBe(DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION);
        expect(existsSync(target)).toBe(true);
      }
    });
  });

  it("通配目标不在硬 deny 判定面（静态不可展开——交既有审批卡把关）", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_WORKSPACE_ALLOWLIST: fx.ws }, async () => {
      const bash = buildTools(fx);
      const refused = await bash.execute({ command: `rm -rf ${fx.ws}/*` }, { callId: "t", agent: undefined });
      expect(refused["error"]).toBe(DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION);
      expect(existsSync(join(fx.ws, "runs"))).toBe(true);
    });
  });

  it("D52 切分零回归：操作符右段不误判入目标（rm -rf A && ls B 目标仅 A）", () => {
    expect(destructiveCommandScan("rm -rf /a/ws && ls /b/runs-root")).toEqual({ destructive: true, paths: ["/a/ws"] });
    expect(destructiveCommandScan("ls /b || rm -rf /a/runs-root/wsA/run-1/training")).toEqual({
      destructive: true,
      paths: ["/a/runs-root/wsA/run-1/training"],
    });
  });

  it("端到端 D52：复合命令命中硬 deny 仅因左段根目标；右段 run 内目标走既有审批", async () => {
    const fx = makeFixture();
    await withEnv({ DSH_HOME: fx.dshHome, ATF_DSH_RUNS_ROOT: fx.runsRoot, ATF_WORKSPACE_ALLOWLIST: fx.ws }, async () => {
      const bash = buildTools(fx);
      const denied = await bash.execute({ command: `rm -rf ${fx.ws} && ls ${fx.runsRoot}` }, { callId: "t", agent: undefined });
      expect(denied["error"]).toBe(DESTRUCTIVE_COMMAND_HARD_DENY);
      expect(denied["kind"]).toBe("workspace_root");
      const inner = join(fx.runDir, "training");
      const refused = await bash.execute({ command: `ls ${fx.ws} || rm -rf ${inner}` }, { callId: "t", agent: undefined });
      expect(refused["error"]).toBe(DESTRUCTIVE_COMMAND_REQUIRES_CONFIRMATION);
      expect(existsSync(fx.ws)).toBe(true);
      expect(existsSync(inner)).toBe(true);
    });
  });
});

describe("D83 纯函数直测（fs 事实注入——vitest 不触真实 fs）", () => {
  const factsOf = (over: Partial<HardDenyFacts> = {}): HardDenyFacts => ({
    isWorkspaceRoot: (dir) => dir === "/fx/ws",
    isDirectory: () => true,
    hasRunBinding: (dir) => dir === "/fx/runs-root/run-flat",
    ...over,
  });

  it("hardDenyKindFor 各归类：runs 根／runs 桶／平铺 run 例外／workspace 根／三桶", () => {
    const facts = factsOf();
    const roots = { runsRoot: "/fx/runs-root", registryWorkspaces: [] };
    expect(hardDenyKindFor("/fx/runs-root", facts, roots)).toBe("global_runs_root");
    expect(hardDenyKindFor("/fx/runs-root/wsA", facts, roots)).toBe("runs_workspace_dir");
    expect(hardDenyKindFor("/fx/runs-root/run-flat", facts, roots)).toBe(null); // 平铺 run → 走审批
    expect(hardDenyKindFor("/fx/ws", facts, roots)).toBe("workspace_root");
    expect(hardDenyKindFor("/fx/ws/runs", facts, roots)).toBe("workspace_bucket_root");
    expect(hardDenyKindFor("/fx/ws/datasets", facts, roots)).toBe("workspace_bucket_root");
    expect(hardDenyKindFor("/fx/ws/splits", facts, roots)).toBe("workspace_bucket_root");
    expect(hardDenyKindFor("/fx/ws/experiments", facts, roots)).toBe(null);
    expect(hardDenyKindFor("/fx/ws/experiments/e1/runs/r1", facts, roots)).toBe(null); // 桶内路径不 deny
    expect(hardDenyKindFor("/fx/elsewhere", facts, roots)).toBe(null);
    // runs 根下散文件非「工作区目录」（isDirectory=false）
    expect(hardDenyKindFor("/fx/runs-root/notes.txt", factsOf({ isDirectory: (p) => p === "/fx/ws" }), roots)).toBe(null);
  });

  it("destructiveHardDenyGuard：相对目标按 cwd 解析命中；通配跳过；env 缺席（runsRoot=null）不误判", () => {
    const facts = factsOf();
    const hit = destructiveHardDenyGuard(["runs"], { runsRoot: null, registryWorkspaces: [], cwd: "/fx/ws" }, facts);
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe("workspace_bucket_root");
    expect(hit?.target).toBe("/fx/ws/runs");
    expect(hit?.message).toContain("--run-id <new>");
    expect(destructiveHardDenyGuard(["/fx/ws/*"], { runsRoot: null, registryWorkspaces: [], cwd: "/fx/ws" }, facts)).toBeNull();
    expect(
      destructiveHardDenyGuard(["/fx/ws/experiments/e1/runs/r1/ckpt.bin"], { runsRoot: null, registryWorkspaces: [], cwd: "/fx/ws" }, facts),
    ).toBeNull();
  });
});
