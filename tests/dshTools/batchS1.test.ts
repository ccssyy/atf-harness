/**
 * 批㊶-S1 测试锚——段 1/2 闭环推荐层（next_steps 事实核对）／段 3 atf_publish_model
 * （四件套前置/名字校验/归档 manifest SHA256）／§6.2 方案丙围栏与豁免／双源模型清单。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEvalReadiness, checkModelPublishPrereq, buildPublishModelTool, derivePublishRoot } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { workspaceFenceRoots, workspaceFenceGuard, WORKSPACE_PATH_OUTSIDE_ALLOWLIST } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";
import { buildRecordsQueryTool, resolveTaskDir, grantExemption, readExemptions } from "../../packages/extensions/atf-tools/src/recordsFace.js";
import { mergePublishedModels } from "../../src/core/workspace/modelInventory.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "s1-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 造四件套齐的 run（checkpoint＋评估轮四件套）。 */
const seedCompleteRun = (root: string, runId = "run-done"): string => {
  const ckpt = join(root, runId, "training", "checkpoint-30");
  mkdirSync(ckpt, { recursive: true });
  writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
  const orch = join(root, runId, "eval", "1-20261012", "orch", "eval");
  mkdirSync(orch, { recursive: true });
  for (const f of ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]) writeFileSync(join(orch, f), "{}");
  return join(root, runId);
};

describe("批㊶-S1 段 1——闭环推荐层事实核对（next_steps）", () => {
  it("collectEvalReadiness：训练 done＋checkpoint 候选实锚＋评估资产/field_config/split 绑定状态", () => {
    const runDir = seedCompleteRun(tempRoot());
    mkdirSync(join(runDir, "l1", "eval"), { recursive: true });
    writeFileSync(join(runDir, "l1", "eval", "test_images.json"), "{}");
    writeFileSync(join(runDir, "l1", "eval", "eval_labels.jsonl"), "");
    const r = collectEvalReadiness(runDir);
    expect(r.training_done).toBe(true);
    expect(r.checkpoint_candidates).toEqual(["checkpoint-30"]);
    expect(r.latest_checkpoint).toContain("checkpoint-30");
    expect(r.eval_assets_dir).toBe(join(runDir, "l1", "eval"));
    expect(r.four_set_ready).toBe(true);
    expect(r.badcases_ready).toBe(true);
  });
  it("未完成 run：无含 adapter 的 checkpoint → training_done=false（不猜测）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-x", "training", "checkpoint-5"), { recursive: true });
    const r = collectEvalReadiness(join(root, "run-x"));
    expect(r.training_done).toBe(false);
    expect(r.checkpoint_candidates).toEqual([]);
  });
  it("atf_publish_model 前置：四件套缺 → 拒（four_set_missing·不放宽）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "run-p", "training", "checkpoint-3"), { recursive: true });
    const check = checkModelPublishPrereq(join(root, "run-p"));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe("four_set_missing");
    const ok = checkModelPublishPrereq(seedCompleteRun(root, "run-ok"));
    expect(ok.ok).toBe(true);
  });
});

describe("批㊶-S1 段 3——atf_publish_model（语义 C 归档＋U 双段式）", () => {
  it("名字校验：latest/软链拒；归档复制 manifest SHA256＋发布报告落盘；授权一次（danger）", async () => {
    const root = tempRoot();
    const runDir = seedCompleteRun(root, "run-pub");
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const tool = buildPublishModelTool(ctx, { runsRoot: root, modelRoot: undefined }) as unknown as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const bad = await tool.execute({ run_id: "run-pub", checkpoint: "latest" }, { callId: "t" });
    expect(bad.ok).toBe(false);
    const good = await tool.execute({ run_id: "run-pub", checkpoint: "checkpoint-30", publish_root: join(root, "pub"), note: "演示发布" }, { callId: "t" });
    expect(good.ok).toBe(true);
    const dest = good.dest_dir as string;
    expect(existsSync(join(dest, "adapter_model.safetensors"))).toBe(true);
    expect(existsSync(join(dest, "publish-manifest.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dest, "publish-manifest.json"), "utf8")) as { files: Array<{ file: string; sha256: string }> };
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(existsSync(join(runDir, "publish", "checkpoint-30.md"))).toBe(true);
  });
  it("发布库位派生：ATF_ATF_ROOT＞runsRoot 父目录；皆缺＝null（零字面量）", () => {
    expect(derivePublishRoot({ ATF_ATF_ROOT: "/data/atf" })).toBe("/data/atf/models");
    expect(derivePublishRoot({ ATF_DSH_RUNS_ROOT: "/data/atf/uat/runs" })).toBe("/data/atf/uat/models");
    expect(derivePublishRoot({})).toBeNull();
  });
  it("双源模型清单合并：发布库位新词追加、重名取先（来源标注区分）", async () => {
    const { mergePublishedModels } = await import("../../src/core/workspace/modelInventory.js");
    const merged = mergePublishedModels({ root: "/m", models: ["base-a", "dup"], error: undefined }, ["dup", "pub-1"]);
    expect(merged.models).toEqual(["base-a", "dup", "pub-1"]);
  });
});

describe("批㊶-S1 §6.2——atf_bash 工作区围栏（方案丙）与豁免", () => {
  it("围栏根装配：可写＝run 工作区；可读＝∪runs 根∪登记面∪allowlist env 单源", () => {
    const fence = workspaceFenceRoots({ runWorkspace: "/w/run1", runsRoot: "/data/atf/uat/runs", allowlistEnv: "/data/chris/docops:/data/LLM_model", registryDirs: ["/reg/ds"] });
    expect(fence.writable).toBe("/w/run1");
    expect(fence.readable).toContain("/data/atf/uat/runs");
    expect(fence.readable).toContain("/data/chris/docops");
    expect(fence.readable).toContain("/reg/ds");
  });
  it("越界拒绝结构化指路；只读域写语义拒绝；域内通过", () => {
    const fence = { writable: "/w/run1", readable: ["/w/run1", "/data/atf/uat/runs"] };
    const outside = workspaceFenceGuard("cat /etc/hosts", fence);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe(WORKSPACE_PATH_OUTSIDE_ALLOWLIST);
    const readonlyWrite = workspaceFenceGuard("echo x > /data/atf/uat/runs/other/x", fence);
    expect(readonlyWrite.ok).toBe(false);
    if (!readonlyWrite.ok) expect(readonlyWrite.message).toContain("只读围栏");
    const inside = workspaceFenceGuard("ls /w/run1", fence);
    expect(inside.ok).toBe(true);
  });
  it("豁免登记：幂等去重＋留痕可回看", () => {
    const root = tempRoot();
    grantExemption(root, "run-x", "atf_records_query（对照评估）");
    grantExemption(root, "run-x", "atf_records_query（对照评估）");
    expect(readExemptions(root)).toHaveLength(1);
  });
  it("resolveTaskDir：平铺优先→指定桶→全桶扫描；未命中 null（卡面无路径裸串的基础）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "flat-run"), { recursive: true });
    mkdirSync(join(root, "ci", "bucketed"), { recursive: true });
    expect(resolveTaskDir(root, undefined, "flat-run")).toBe(join(root, "flat-run"));
    expect(resolveTaskDir(root, "ci", "bucketed")).toBe(join(root, "ci", "bucketed"));
    expect(resolveTaskDir(root, undefined, "bucketed")).toBe(join(root, "ci", "bucketed"));
    expect(resolveTaskDir(root, undefined, "nope")).toBeNull();
  });
  it("atf_records_query：跨工作区首读走问题卡（拒绝不读取）；豁免后免打扰", async () => {
    const root = tempRoot();
    const currentWs = join(root, "ws-a");
    mkdirSync(join(root, "other-run", "report"), { recursive: true });
    writeFileSync(join(root, "other-run", "report", "report.md"), "# other\n");
    let approvalCalls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { approvalCalls += 1; return "allowed-once"; } } : undefined) };
    const tool = buildRecordsQueryTool(ctx, { runsRoot: root, currentRunWorkspace: () => currentWs }) as unknown as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const exec = { callId: "q", agent: { session: { id: "sq", header: { cwd: "/w" } } } };
    const r1 = await tool.execute({ task_run: "other-run", note: "对照" }, exec);
    expect(r1.ok).toBe(true);
    expect(approvalCalls).toBe(1);
    expect(readExemptions(currentWs).some((e) => e.task_id === "other-run")).toBe(true);
    const r2 = await tool.execute({ task_run: "other-run" }, exec);
    expect(r2.ok).toBe(true);
    expect(approvalCalls).toBe(1); // 豁免后免打扰
    const r3 = await tool.execute({ task_run: "nope" }, exec);
    expect(r3.ok).toBe(false);
  });
});

describe("批㊶-S1 门2修复——围栏可写根注入链（live 锚）", () => {
  it("live 锚：env 未设时围栏行为确定性（fail-closed 只读降级——可写域空集·写语义全拒）", () => {
    const saved = process.env["ATF_BASH_RUN_WORKSPACE"];
    delete process.env["ATF_BASH_RUN_WORKSPACE"];
    try {
      // 未设 env → 可写根空串＝可写域空集（fail-closed）——runs 根只读保留
      const fenceGuard = workspaceFenceGuard;
      const runsRoot = "/data/atf/uat/runs";
      const failClosed = { writable: "", readable: [runsRoot] };
      const readOk = fenceGuard(`cat ${runsRoot}/cr_r2/eval/report.md`, failClosed);
      expect(readOk.ok).toBe(true); // 只读根保留——读放行
      const writeDenied = fenceGuard("echo x > /w/run1/x", failClosed);
      expect(writeDenied.ok).toBe(false); // 任意写路径（含"曾经的 PWD 假可写根"）一律拒
      if (!writeDenied.ok) expect(writeDenied.code).toBe(WORKSPACE_PATH_OUTSIDE_ALLOWLIST);
      const vendorWrite = fenceGuard("touch /data/sam/ATF-Harness/vendor/dsh/x", failClosed);
      expect(vendorWrite.ok).toBe(false); // vendor 目录不再被误当可写根
    } finally {
      if (saved === undefined) delete process.env["ATF_BASH_RUN_WORKSPACE"]; else process.env["ATF_BASH_RUN_WORKSPACE"] = saved;
    }
  });
  it("注入 helper：env 设值后同命令放行（可写根随 run 切换）", async () => {
    const { injectBashRunWorkspace } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const { workspaceFenceGuard } = await import("../../packages/extensions/atf-tools/src/fileGuardFace.js");
    const saved = process.env["ATF_BASH_RUN_WORKSPACE"];
    injectBashRunWorkspace("/w/run9");
    try {
      const fence = workspaceFenceRoots({ runWorkspace: process.env["ATF_BASH_RUN_WORKSPACE"] as string, runsRoot: "/data/atf/uat/runs", allowlistEnv: "" });
      expect(fence.writable).toBe("/w/run9");
      expect(workspaceFenceGuard("touch /w/run9/out.txt", fence).ok).toBe(true);
      expect(workspaceFenceGuard("touch /w/other/out.txt", fence).ok).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["ATF_BASH_RUN_WORKSPACE"]; else process.env["ATF_BASH_RUN_WORKSPACE"] = saved;
    }
  });
});
