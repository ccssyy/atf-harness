/**
 * E2（微批·预检双缺陷 20261024）测试锚——落点三级单源＋退出码语义修正。
 *
 * 缺陷 A（run 解析双源）：预检旧解析只查实例 runsRoot＋会话桶，段工具
 * atf_pipeline_stage 落点 <workspace_path>/runs/<run_id> 的工作区树 run 永远
 * 找不到（产品内 agent 被迫自建软链自救——红线形态）。本批三级单源：
 * workspace_path 显式 > 会话工作区事实（<cwd>/runs 与 <cwd>/workspace/runs）>
 * 实例 runsRoot 兜底；显式给定不静默回退；最终落点软链即拒（不进脚本调用）。
 * 缺陷 B（退出码语义误判）：内核脚本对「有缺项」run 报 exit 1＋stdout 完整合法
 * 报告（UAT 实测）——旧实现当执行失败丢清单；本批 exit≠0 先解析 stdout，报告
 * 可用即 degraded 返回；解析失败才是真 preflight_failed（note 含 stdout/stderr
 * 摘要——禁空 note）。
 *
 * 选新文件而非追加 batchF1.test.ts：E2 是独立微批，验收锚自成体系（对两级缺陷
 * 各自收口），独立文件保持批次与授权件对应边界清晰（仓内按批建文件惯例）；
 * batchF1.test.ts 仅做存量用例对齐（fail-closed 落点探测要求 run 目录在场）。
 * mock 对端：mock_preflight_exit1.mjs（exit 1＋合法报告——UAT 形态）与
 * mock_preflight_fail.mjs（exit 1＋垃圾 stdout——真失败形态）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLaunchKpi } from "../../src/core/workspace/trainingPreflight.js";
import { buildPreflightTool, type PreflightDeps } from "../../packages/extensions/atf-tools/src/preflightFace.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const mockPreflightCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight.mjs")}`;
const mockPreflightExit1Command = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight_exit1.mjs")}`;
const mockPreflightFailCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight_fail.mjs")}`;

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const findTool = (tools: unknown[], name: string): DshToolLike => {
  const tool = tools.find((entry) => (entry as DshToolLike).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}`);
  return tool as DshToolLike;
};

/** 无工作区头会话（旧形态——b 级跳过，只剩 c 级兜底）。 */
const plainExec = { agent: { session: { id: "sess-e2-plain" } }, callId: "e2-call-1", signal: undefined };
/** 带工作区 cwd 的会话（b 级候选来源——与 sessionWorkspaceSlug 同源取法）。 */
const cwdExec = (cwd: string): object => ({ agent: { session: { id: "sess-e2-cwd", header: { cwd } } }, callId: "e2-call-2", signal: undefined });

/** 精简 ctx 桩：userQuestions（空应答——needs_confirm 不阻塞）＋approval（本批不用）。 */
const quietCtx = () => ({
  get: (service: string) => {
    if (service === "userQuestions") {
      return { ask: async (req: { questions: ReadonlyArray<{ id: string }> }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }> => ({ answers: [{ id: req.questions[0]?.id ?? "", selected: [] }] }) };
    }
    if (service === "approval") return { request: async () => "allowed-once" };
    return undefined;
  },
});

const preflightDepsOf = (ctx: unknown, command = mockPreflightCommand, runsRoot = tempRoot("e2-runs-")): PreflightDeps =>
  ({ command, timeoutMs: 15_000, runsRoot, ctx: ctx as PreflightDeps["ctx"] });

const runTool = async (deps: PreflightDeps, args: Record<string, unknown>, exec: unknown): Promise<Record<string, unknown>> => {
  const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
  return (await tool.execute(args, exec)) as Record<string, unknown>;
};

// ── E2-A：run 落点三级单源解析（缺陷 A）──

describe("E2-A 落点三级单源解析（缺陷 A：run 解析双源）", () => {
  it("会话 cwd 树命中段工具落点形态 <cwd>/runs/<run_id>：source=session_fact，KPI 落同棵树", async () => {
    const ws = tempRoot("e2-ws-");
    const runDir = join(ws, "runs", "e2-sf-1");
    mkdirSync(runDir, { recursive: true });
    // 实例 runsRoot 为另一空根——证明 b 级先于 c 级命中（不靠实例树）
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-sf-1" }, cwdExec(ws));
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("session_fact");
    expect(result["run_dir"]).toBe(runDir);
    expect(String(result["checklist"])).toContain("missing——环境/用户必须提供");
    expect(readLaunchKpi(runDir)?.preflight).toBeDefined();
  });

  it("会话 cwd 树命中 canonical 形态 <cwd>/workspace/runs/<run_id>：source=session_fact（第二候选）", async () => {
    const ws = tempRoot("e2-ws-");
    const runDir = join(ws, "workspace", "runs", "e2-sf-2");
    mkdirSync(runDir, { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-sf-2" }, cwdExec(ws));
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("session_fact");
    expect(result["run_dir"]).toBe(runDir);
    expect(readLaunchKpi(runDir)?.preflight).toBeDefined();
  });

  it("三级全不中：fail-closed run_dir_not_found，note 指路 workspace_path（内部码不进文案）", async () => {
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-none-1" }, plainExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("run_dir_not_found");
    expect(String(result["note"])).toContain("请传 workspace_path");
    expect(String(result["note"])).not.toContain("run_dir_not_found");
    expect("checklist" in result).toBe(false);
  });

  it("带正确 workspace_path：source=workspace_path，run_dir 为实际落点值", async () => {
    const ws = tempRoot("e2-ws-");
    const runDir = join(ws, "runs", "e2-wp-1");
    mkdirSync(runDir, { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-wp-1", workspace_path: ws }, plainExec);
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("workspace_path");
    expect(result["run_dir"]).toBe(runDir);
    expect(String(result["checklist"])).toContain("needs_confirm——业务确认");
    expect(readLaunchKpi(runDir)?.preflight).toBeDefined();
  });

  it("workspace_path 非绝对路径：fail-closed（文案对齐段工具同名错误形态）", async () => {
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-wp-2", workspace_path: "relative/ws" }, plainExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("workspace_path_not_absolute");
    expect(String(result["note"])).toContain("须为绝对路径");
    expect("checklist" in result).toBe(false);
  });

  it("workspace_path 给定但目录不存在：拒之不静默回退（实例 runsRoot 同名 run 在场也拒——显式优先）", async () => {
    const runsRoot = tempRoot("e2-runs-");
    mkdirSync(join(runsRoot, "e2-wp-3"), { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, runsRoot);
    const result = await runTool(deps, { run_id: "e2-wp-3", workspace_path: join(tempRoot("e2-ws-"), "absent") }, plainExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("run_dir_not_found");
    expect(String(result["note"])).toContain("请传 workspace_path");
    // 不静默改道的证据：实例树里的同名 run 未被查（清单不出、KPI 不落）
    expect("checklist" in result).toBe(false);
    expect(readLaunchKpi(join(runsRoot, "e2-wp-3"))).toBeNull();
  });

  it("落点为软链：run_dir_symlink_rejected，不进脚本调用（无清单、真实 run 零 KPI），文案不含内部码", async () => {
    const realWs = tempRoot("e2-real-");
    const realRunDir = join(realWs, "runs", "e2-link-1");
    mkdirSync(realRunDir, { recursive: true });
    const linkWs = tempRoot("e2-link-");
    mkdirSync(join(linkWs, "runs"), { recursive: true });
    symlinkSync(realRunDir, join(linkWs, "runs", "e2-link-1"));
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, tempRoot("e2-runs-"));
    const result = await runTool(deps, { run_id: "e2-link-1", workspace_path: linkWs }, plainExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("run_dir_symlink_rejected");
    expect(String(result["note"])).toContain("不接受镜像/软链");
    // 红线：内部码只进结构化 error 字段，note 文案不出现内部码字样
    expect(String(result["note"])).not.toContain("run_dir_symlink_rejected");
    // 不发生脚本调用：无清单返回；真实 run 目录无 KPI（KPI 只在脚本跑通后落）
    expect("checklist" in result).toBe(false);
    expect(readLaunchKpi(realRunDir)).toBeNull();
  });

  it("存量形态零破坏：run 在实例 runsRoot 平铺（无 cwd 无 workspace_path）→ source=instance_runs_root 兜底命中", async () => {
    const runsRoot = tempRoot("e2-runs-");
    const runDir = join(runsRoot, "e2-flat-1");
    mkdirSync(runDir, { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightCommand, runsRoot);
    const result = await runTool(deps, { run_id: "e2-flat-1" }, plainExec);
    expect(result["ok"]).toBe(true);
    expect(result["run_dir_source"]).toBe("instance_runs_root");
    expect(result["run_dir"]).toBe(runDir);
    expect(readLaunchKpi(runDir)?.preflight).toBeDefined();
  });
});

// ── E2-B：退出码语义修正（缺陷 B）──

describe("E2-B 退出码语义修正（缺陷 B：有缺项 exit 1 被当执行失败）", () => {
  it("exit 1＋stdout 合法报告：ok:true＋degraded:true＋exit_code:1，三态清单完整不丢", async () => {
    const runsRoot = tempRoot("e2-runs-");
    mkdirSync(join(runsRoot, "e2-dg-1"), { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightExit1Command, runsRoot);
    const result = await runTool(deps, { run_id: "e2-dg-1" }, plainExec);
    expect(result["ok"]).toBe(true);
    expect(result["degraded"]).toBe(true);
    expect(result["exit_code"]).toBe(1);
    // 三态清单完整（不丢清单——缺陷 B 的用户/agent 可见面）
    expect(String(result["checklist"])).toContain("missing——环境/用户必须提供");
    expect(String(result["checklist"])).toContain("derivable——可自动执行");
    expect(String(result["checklist"])).toContain("needs_confirm——业务确认");
    expect(result["summary"]).toEqual({ missing: 1, derivable: 2, confirm: 1 });
    // 落点锚随新解析透出（degraded 与 meta 同路径透传）
    expect(result["run_dir_source"]).toBe("instance_runs_root");
  });

  it("exit 1＋stdout 垃圾：真 preflight_failed，note 同时含 stdout 与 stderr 摘要（禁空 note）", async () => {
    const runsRoot = tempRoot("e2-runs-");
    mkdirSync(join(runsRoot, "e2-fail-1"), { recursive: true });
    const deps = preflightDepsOf(quietCtx(), mockPreflightFailCommand, runsRoot);
    const result = await runTool(deps, { run_id: "e2-fail-1" }, plainExec);
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("preflight_failed");
    const note = String(result["note"]);
    expect(note).not.toBe("");
    expect(note).toContain("stdout 摘要");
    expect(note).toContain("Traceback");
    expect(note).toContain("stderr 摘要");
    expect(note).toContain("simulated kernel internal error");
    // 真失败不记 KPI（报告不可用＝预检未成功）
    expect(readLaunchKpi(join(runsRoot, "e2-fail-1"))).toBeNull();
  });
});
