/**
 * atf_launch_execute 的 run 落点解析（真机 ws2 事故回归锚）。
 *
 * 事故：验证工作区的 run 在 <ws>/workspace/runs/<id>，不在实例 runs 桶
 * （ATF_DSH_RUNS_ROOT）下；工具只按桶解析 → 落到桶里同名残留目录（读到 10-24 旧
 * 启动件），执行方只好把启动件"布点"进桶。显式 workspace_path 必须按 RunLayout
 * 单源解析。
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localHostFor } from "../../packages/extensions/atf-tools/src/bridgeFace.js";

const roots = () => {
  const base = mkdtempSync(join(tmpdir(), "launch-rundir-"));
  return {
    runsRoot: join(base, "instance-runs"),
    kernelDir: join(base, "kernel"),
    execHome: join(base, "exec-home"),
    base,
  };
};

describe("atf_launch_execute run 落点：显式 workspace_path 优先", () => {
  it("显式工作区 → <ws>/workspace/runs/<run_id>（canonical），不进实例桶", () => {
    const r = roots();
    const ws = join(r.base, "ws2", "workspace");
    const runDir = join(ws, "runs", "do-swb-joint-01");
    mkdirSync(runDir, { recursive: true });
    const host = localHostFor(r, { run_id: "do-swb-joint-01", workspace_path: ws }, {});
    expect(host.runDir).toBe(runDir);
  });

  it("未给工作区 → 回退实例桶布局（既有语义不变）", () => {
    const r = roots();
    const host = localHostFor(r, { run_id: "bucket-run" }, {});
    expect((host.runDir ?? "").startsWith(r.runsRoot)).toBe(true);
  });
});
