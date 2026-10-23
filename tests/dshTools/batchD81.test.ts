/**
 * D81-B 测试锚——run 面读具会话作用域隔离（指令《ATF_指令_D81B_会话作用域隔离_20261023》
 * §三验收锚的白盒开发测试承载）。
 *
 * 覆盖面（开发测试可白盒直调函数与工具 execute；断言用用户可见文案与公共返回结构）：
 * 1. 归属工作区 → atf_run_list 缺省仅返回本区 run；历史 run（run-docops-*）不出现；
 * 2. legacy runs/ 布局兼容；
 * 3. 杂项（bl.zip/bl_source/png_mirror.py）在任何作用域下永不出现；
 * 4. 归属缺失 → fail-closed 空＋「请先在 WebUI 添加工作区」指引，不回落全局扫描；
 * 5. scope=all → 审批两分支（批准→分组返回含「本任务/历史任务」标注；拒绝→零返回）；
 * 6. scope=显式工作区路径透传；
 * 7. report_read / metrics_compare 缺省本区解析＋越界回流带跨任务指引；
 * 8. atf_workspace_status 附加当前会话归属 workspace_id（mock 桥集成）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileTools, type FileToolScopeDeps } from "../../packages/extensions/atf-tools/src/fileFace.js";
import { BridgeManager, buildBridgeTools } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { collectAllRunGroups, resolveSessionWorkspace } from "../../packages/extensions/atf-tools/src/scopeFace.js";

const tempRoots: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "atf-d81b-"));
  tempRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** DSH 工具产物的测试调用面（defineTool 产物形状——execute(args, exec)）。 */
interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
  description?: string;
}
const toolNames = (tools: unknown[]): string[] => tools.map((tool) => (tool as DshToolLike).name);
const findTool = (tools: unknown[], name: string): DshToolLike => {
  const tool = tools.find((entry) => (entry as DshToolLike).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}（实际: ${toolNames(tools).join(", ")}）`);
  return tool as DshToolLike;
};

/** 带会话 cwd 的 exec（vendor 锚：exec.agent.session.header.cwd）。 */
const execWithCwd = (cwd: string): unknown => ({ agent: { session: { header: { cwd } } }, callId: "d81-call", signal: undefined });
const noApprovalCtx = { get: () => undefined };

/** 审批 stub（记录调用并回放指定 outcome——两分支注入）。 */
const approvalCtxOf = (outcome: string) => {
  const calls: Array<{ toolName: string; reason: string }> = [];
  const ctx = {
    get: (service: string) =>
      service === "approval"
        ? { request: async (req: { toolName: string; reason: string }) => { calls.push(req); return outcome; } }
        : undefined,
  };
  return { calls, ctx };
};

// ---------------------------------------------------------------- fixture

/** 共享 fixture：runs 根（历史平铺 run＋杂项＋另一工作区）＋三个会话工作区＋dshHome。 */
const buildFixture = () => {
  const base = tempDir();
  const runsRoot = join(base, "runs-root");
  const wsMine = join(base, "ws-mine"); // canonical 布局（当前会话归属）
  const wsLegacy = join(base, "ws-legacy"); // legacy runs/ 布局
  const wsOther = join(runsRoot, "ws-bl6"); // runs 根下的另一工作区（canonical）
  const wsRegistry = join(base, "ws-registry"); // 无身份文件——注册表通道归属用
  const dshHome = join(base, "dsh-home");

  // 本区工作区（canonical）：两个 run，各带报告/metrics
  mkdirSync(join(wsMine, ".atf"), { recursive: true });
  writeFileSync(join(wsMine, ".atf", "workspace.json"), JSON.stringify({ id: "ws-mine-uuid", name: "ws-mine", experiments: [], createdAt: "2026-10-23T00:00:00Z" }));
  for (const runId of ["bl-r1", "bl-r2"]) {
    mkdirSync(join(wsMine, "workspace", "runs", runId, "report"), { recursive: true });
    writeFileSync(join(wsMine, "workspace", "runs", runId, "run.json"), JSON.stringify({ run_id: runId }));
    writeFileSync(join(wsMine, "workspace", "runs", runId, "report", "metrics_summary.json"), JSON.stringify({ eval_f1: runId === "bl-r1" ? 0.9 : 0.8 }));
  }
  writeFileSync(join(wsMine, "workspace", "runs", "bl-r1", "report", "report.md"), "# 本区报告\n正文");

  // legacy 布局工作区：runs/<run_id>（launch_manifest 特征）
  mkdirSync(join(wsLegacy, ".atf"), { recursive: true });
  writeFileSync(join(wsLegacy, ".atf", "workspace.json"), JSON.stringify({ id: "ws-legacy-uuid", name: "ws-legacy", experiments: [], createdAt: "2026-10-23T00:00:00Z" }));
  mkdirSync(join(wsLegacy, "runs", "legacy-run"), { recursive: true });
  writeFileSync(join(wsLegacy, "runs", "legacy-run", "launch_manifest.json"), JSON.stringify({ run_id: "legacy-run" }));

  // runs 根：历史平铺 run（UAT 缺陷现场同款形态）＋杂项＋另一工作区（canonical）
  mkdirSync(join(runsRoot, "run-docops-old", "report"), { recursive: true });
  writeFileSync(join(runsRoot, "run-docops-old", "launch_manifest.json"), JSON.stringify({ run_id: "run-docops-old" }));
  writeFileSync(join(runsRoot, "run-docops-old", "report", "report.md"), "# 历史任务报告\nrun-docops-bl-20261009");
  writeFileSync(join(runsRoot, "run-docops-old", "report", "metrics_summary.json"), JSON.stringify({ eval_f1: 0.1 }));
  writeFileSync(join(runsRoot, "bl.zip"), "not-a-run");
  mkdirSync(join(runsRoot, "bl_source"), { recursive: true });
  writeFileSync(join(runsRoot, "bl_source", "data.json"), "{}");
  writeFileSync(join(runsRoot, "png_mirror.py"), "print('misc')");
  mkdirSync(join(wsOther, ".atf"), { recursive: true });
  writeFileSync(join(wsOther, ".atf", "workspace.json"), JSON.stringify({ id: "ws-other-uuid", name: "ws-bl6", experiments: [], createdAt: "2026-10-23T00:00:00Z" }));
  mkdirSync(join(wsOther, "workspace", "runs", "bl-r1"), { recursive: true });
  writeFileSync(join(wsOther, "workspace", "runs", "bl-r1", "run.json"), JSON.stringify({ run_id: "bl-r1" }));

  // 注册表通道工作区：目录在场但无身份文件（归属由注册表 path 精确匹配承载）
  mkdirSync(join(wsRegistry, "workspace", "runs", "reg-run"), { recursive: true });
  writeFileSync(join(wsRegistry, "workspace", "runs", "reg-run", "run.json"), JSON.stringify({ run_id: "reg-run" }));
  mkdirSync(join(dshHome, "storages"), { recursive: true });
  writeFileSync(
    join(dshHome, "storages", "workspace.json"),
    JSON.stringify({
      tables: { workspaces: { "reg-record-uuid": { id: "reg-record-uuid", path: wsRegistry, title: "注册表工作区", sessionIds: [] } } },
    }),
  );

  // 无归属目录（裸目录——向上到 base 也无身份文件）
  const bareDir = join(base, "bare");
  mkdirSync(bareDir, { recursive: true });

  return { base, runsRoot, wsMine, wsLegacy, wsOther, wsRegistry, dshHome, bareDir };
};

const buildTools = (runsRoot: string, deps?: FileToolScopeDeps): unknown[] => buildFileTools(runsRoot, deps);

// ---------------------------------------------------------------- 缺省作用域（current）

describe("D81-B 缺省作用域：归属工作区→仅本区 run", () => {
  it("atf_run_list 缺省只返回本区 run；历史 run 与其他工作区 run 不出现", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const result = (await findTool(tools, "atf_run_list").execute({}, execWithCwd(fx.wsMine))) as {
      scope: string;
      workspace: { workspace_id: string; path: string };
      runs: Array<{ run_id: string }>;
      count: number;
    };
    expect(result.scope).toBe("current");
    expect(result.workspace.workspace_id).toBe("ws-mine-uuid");
    expect(result.runs.map((run) => run.run_id)).toEqual(["bl-r1", "bl-r2"]);
    expect(result.count).toBe(2);
    // D81 关闭证据：其他任务历史 run／其他工作区 run 不出现
    expect(JSON.stringify(result)).not.toContain("run-docops");
  });

  it("legacy runs/ 布局兼容：归属工作区内 legacy run 正常列出", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const result = (await findTool(tools, "atf_run_list").execute({}, execWithCwd(fx.wsLegacy))) as {
      runs: Array<{ run_id: string }>;
      workspace: { workspace_id: string };
    };
    expect(result.workspace.workspace_id).toBe("ws-legacy-uuid");
    expect(result.runs.map((run) => run.run_id)).toEqual(["legacy-run"]);
  });

  it("归属缺失 → fail-closed 空＋指引文案，不回落全局扫描", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const result = (await findTool(tools, "atf_run_list").execute({}, execWithCwd(fx.bareDir))) as {
      runs: unknown[];
      count: number;
      note: string;
    };
    expect(result.runs).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.note).toContain("添加工作区");
    expect(JSON.stringify(result)).not.toContain("run-docops");
  });

  it("归属解析通道②：注册表按 canonical cwd 归属（目录无身份文件亦成立）", () => {
    const fx = buildFixture();
    const scope = resolveSessionWorkspace(fx.wsRegistry, { dshHome: fx.dshHome });
    expect(scope).not.toBeNull();
    expect(scope?.workspaceId).toBe("reg-record-uuid");
    expect(scope?.root).toBe(fx.wsRegistry);
  });
});

// ---------------------------------------------------------------- 跨任务显式通道（scope）

describe("D81-B 跨任务显式通道：审批两分支＋显式透传", () => {
  it("scope=all 批准 → 分组返回（本任务/历史任务标注＋审批记录）；杂项永不出现", async () => {
    const fx = buildFixture();
    const approved = approvalCtxOf("allowed-once");
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome, ctx: approved.ctx });
    const result = (await findTool(tools, "atf_run_list").execute({ scope: "all" }, execWithCwd(fx.wsMine))) as {
      scope: string;
      groups: Array<{ group: string; runs: Array<{ run_id: string }> }>;
      runs: Array<{ run_id: string }>;
      count: number;
      approval: string;
      note: string;
    };
    expect(result.scope).toBe("all");
    expect(result.approval).toBe("allowed-once");
    expect(result.note).toContain("本任务");
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]!.group).toBe("本任务");
    expect(result.groups[0]!.runs.map((run) => run.run_id)).toEqual(["bl-r1", "bl-r2"]);
    expect(result.groups[1]!.group).toBe("历史任务");
    const historicalIds = result.groups[1]!.runs.map((run) => run.run_id);
    expect(historicalIds).toContain("run-docops-old");
    expect(historicalIds).toContain("bl-r1"); // runs 根下其他工作区（ws-bl6）的 run 亦入历史组
    expect(result.count).toBe(result.runs.length);
    // 杂项（bl.zip/bl_source/png_mirror.py）在缺省与全量两视图下均不出现
    const currentView = await findTool(tools, "atf_run_list").execute({}, execWithCwd(fx.wsMine));
    for (const view of [currentView, result]) {
      const text = JSON.stringify(view);
      expect(text).not.toContain("bl.zip");
      expect(text).not.toContain("bl_source");
      expect(text).not.toContain("png_mirror.py");
    }
    // 审批留痕：request 被调用且 reason 为审批卡模板（跨任务语义入卡）
    expect(approved.calls).toHaveLength(1);
    expect(approved.calls[0]!.reason).toContain("跨任务");
  });

  it("scope=all 拒绝 → 零返回（结构化审批拒绝，无 runs 数据）", async () => {
    const fx = buildFixture();
    const rejected = approvalCtxOf("rejected");
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome, ctx: rejected.ctx });
    const result = (await findTool(tools, "atf_run_list").execute({ scope: "all" }, execWithCwd(fx.wsMine))) as Record<string, unknown>;
    expect(result["error"]).toBe("approval_denied");
    expect("runs" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain("run-docops");
    expect(rejected.calls).toHaveLength(1);
  });

  it("审批服务缺失 → fail-closed 拒绝（unavailable，不放行不猜测）", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome }); // ctx 未挂 approval
    const result = (await findTool(tools, "atf_run_list").execute({ scope: "all" }, execWithCwd(fx.wsMine))) as Record<string, unknown>;
    expect(result["error"]).toBe("approval_denied");
    expect(result["outcome"]).toBe("unavailable");
  });

  it("scope=显式工作区路径透传：以该工作区为「本任务」视角分组", async () => {
    const fx = buildFixture();
    const approved = approvalCtxOf("allowed-once");
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome, ctx: approved.ctx });
    const result = (await findTool(tools, "atf_run_list").execute({ scope: fx.wsOther }, execWithCwd(fx.wsMine))) as {
      scope: string;
      workspace: { workspace_id: string };
      groups: Array<{ group: string; runs: Array<{ run_id: string }> }>;
    };
    expect(result.scope).toBe(fx.wsOther);
    expect(result.workspace.workspace_id).toBe("ws-other-uuid");
    expect(result.groups[0]!.group).toBe("本任务");
    expect(result.groups[0]!.runs.map((run) => run.run_id)).toEqual(["bl-r1"]);
    expect(approved.calls).toHaveLength(1);
  });

  it("scope=无效显式路径 → 指路回执（不审批不猜测）", async () => {
    const fx = buildFixture();
    const approved = approvalCtxOf("allowed-once");
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome, ctx: approved.ctx });
    const result = (await findTool(tools, "atf_run_list").execute({ scope: join(fx.base, "no-such-ws") }, execWithCwd(fx.wsMine))) as Record<string, unknown>;
    expect(result["error"]).toBe("workspace_not_found");
    expect(approved.calls).toHaveLength(0);
  });

  it("collectAllRunGroups 纯函数：本区不在 runs 根下时零重复、分组闭集", () => {
    const fx = buildFixture();
    const groups = collectAllRunGroups(fx.runsRoot, { root: fx.wsMine, workspaceId: "ws-mine-uuid", via: "identity_file" });
    expect(groups.map((group) => group.group)).toEqual(["本任务", "历史任务"]);
    const currentIds = groups[0]!.runs.map((run) => String(run["run_id"]));
    expect(currentIds).toEqual(["bl-r1", "bl-r2"]);
    // 历史组不含本区条目（本区目录不在 runs 根下——天然隔离）
    expect(JSON.stringify(groups[1])).not.toContain("ws-mine");
  });
});

// ---------------------------------------------------------------- report_read / metrics_compare

describe("D81-B report_read / metrics_compare 缺省本区解析＋越界指引", () => {
  it("report_read 本区命中；越界 run 回流带显式跨任务指引；不存在照原语义", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const hit = (await findTool(tools, "atf_report_read").execute({ run_id: "bl-r1" }, execWithCwd(fx.wsMine))) as { exists: boolean; text: string };
    expect(hit.exists).toBe(true);
    expect(hit.text).toContain("本区报告");
    const out = (await findTool(tools, "atf_report_read").execute({ run_id: "run-docops-old" }, execWithCwd(fx.wsMine))) as { exists: boolean; error: string; note: string };
    expect(out.exists).toBe(false);
    expect(out.error).toBe("scope_out_of_workspace");
    expect(out.note).toContain('scope:"all"');
    const miss = (await findTool(tools, "atf_report_read").execute({ run_id: "no-such-run" }, execWithCwd(fx.wsMine))) as { exists: boolean; note: string };
    expect(miss.exists).toBe(false);
    expect(miss.note).toContain("报告不存在");
  });

  it("report_read scope=all 经审批后可读历史 run；无审批服务则 fail-closed", async () => {
    const fx = buildFixture();
    const approved = approvalCtxOf("allowed-once");
    const approvedTools = buildTools(fx.runsRoot, { dshHome: fx.dshHome, ctx: approved.ctx });
    const ok = (await findTool(approvedTools, "atf_report_read").execute({ run_id: "run-docops-old", scope: "all" }, execWithCwd(fx.wsMine))) as { exists: boolean; scope: string; text: string };
    expect(ok.exists).toBe(true);
    expect(ok.text).toContain("历史任务报告");
    expect(approved.calls).toHaveLength(1);
    const bareTools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const denied = (await findTool(bareTools, "atf_report_read").execute({ run_id: "run-docops-old", scope: "all" }, execWithCwd(fx.wsMine))) as Record<string, unknown>;
    expect(denied["error"]).toBe("approval_denied");
  });

  it("metrics_compare 本区两轮可比；越界回流带指引与 missing；归属缺失 fail-closed", async () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    const hit = (await findTool(tools, "atf_metrics_compare").execute({ run_a: "bl-r1", run_b: "bl-r2" }, execWithCwd(fx.wsMine))) as { comparable: boolean; scope: string; diff: Record<string, { a: number; b: number }> };
    expect(hit.comparable).toBe(true);
    expect(hit.diff["eval_f1"]).toEqual({ a: 0.9, b: 0.8 });
    const out = (await findTool(tools, "atf_metrics_compare").execute({ run_a: "bl-r1", run_b: "run-docops-old" }, execWithCwd(fx.wsMine))) as { comparable: boolean; error: string; missing: string[]; note: string };
    expect(out.comparable).toBe(false);
    expect(out.error).toBe("scope_out_of_workspace");
    expect(out.missing).toEqual(["run-docops-old"]);
    const unresolved = (await findTool(tools, "atf_metrics_compare").execute({ run_a: "bl-r1", run_b: "bl-r2" }, execWithCwd(fx.bareDir))) as { comparable: boolean; error: string; note: string };
    expect(unresolved.comparable).toBe(false);
    expect(unresolved.error).toBe("scope_unresolved");
    expect(unresolved.note).toContain("添加工作区");
  });
});

// ---------------------------------------------------------------- 可发现性与状态面附加

describe("D81-B 可发现性三面＋atf_workspace_status 附加", () => {
  it("工具描述写明缺省作用域与跨任务审批代价", () => {
    const fx = buildFixture();
    const tools = buildTools(fx.runsRoot, { dshHome: fx.dshHome });
    for (const name of ["atf_run_list", "atf_report_read", "atf_metrics_compare"]) {
      const description = findTool(tools, name).description ?? "";
      expect(description).toContain("会话归属工作区");
      expect(description).toContain("审批");
    }
  });

  it("atf_workspace_status 附加当前会话归属 workspace_id；归属缺失给指引（mock 桥集成）", async () => {
    const fx = buildFixture();
    const repoRoot = join(import.meta.url.replace("file://", ""), "..", "..", "..");
    const manager = new BridgeManager(["node", join(repoRoot, "tests", "fixtures", "mock_atf.mjs")], repoRoot);
    try {
      const tools = buildBridgeTools(noApprovalCtx, manager, { runsRoot: fx.runsRoot, kernelDir: fx.base, execHome: fx.base });
      const hit = (await findTool(tools, "atf_workspace_status").execute({}, execWithCwd(fx.wsMine))) as Record<string, unknown>;
      expect(hit["ok"]).toBe(true);
      expect(hit["workspace_id"]).toBe("ws-mine-uuid");
      expect(hit["workspace_path"]).toBe(fx.wsMine);
      const unresolved = (await findTool(tools, "atf_workspace_status").execute({}, execWithCwd(fx.bareDir))) as Record<string, unknown>;
      expect(unresolved["ok"]).toBe(true); // 内核状态面核心事实不被遮蔽
      expect(String(unresolved["workspace_scope_note"])).toContain("添加工作区");
    } finally {
      await manager.close();
    }
  });
});
