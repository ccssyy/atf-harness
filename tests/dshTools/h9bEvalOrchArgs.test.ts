/**
 * H-E9b H1 锚——评估编排 argv 组装单点（N=1 恒等 / N>1 逐类形态 / 来源歧义拒）。
 *
 * N=1 黄金数组＝改前内联组装的逐字快照（commit a4bbe002 的 trainingFace.ts 原字面量），
 * 用于把"恒等"变成可判定事实，而不是靠人眼比对。
 */
import { describe, expect, it } from "vitest";

import { buildEvalOrchArgs, type EvalOrchArgsInput } from "../../packages/extensions/atf-tools/src/evalOrchArgs.js";

const BASE: EvalOrchArgsInput = {
  orchestration: "/k/gen.py",
  serviceDir: "/svc",
  ckptPlanDir: "/ckpt",
  orchDir: "/round/orch",
  runner: "/k/runner.py",
  promptRenderer: "/k/render.py",
  port: 5002,
  envProfile: "b7-swb-eval-local",
  concurrency: 2,
};

describe("H-E9b 评估编排 argv 组装单点", () => {
  it("N=1：argv 与改前内联字面量逐字恒等（含 --split-manifest 与外部确认）", () => {
    const argv = buildEvalOrchArgs({
      ...BASE,
      assetsDir: "/assets",
      fieldConfig: "/fc.json",
      splitManifest: "/split.json",
      assetsExternalConfirm: true,
    });
    expect(argv).toEqual([
      "/k/gen.py",
      "--service", "/svc",
      "--ckpt", "/ckpt",
      "--out", "/round/orch",
      "--eval-runner", "/k/runner.py",
      "--prompt-renderer", "/k/render.py",
      "--assets", "/assets",
      "--field-config", "/fc.json",
      "--base-url", "http://127.0.0.1:5002/v1",
      "--env-profile", "b7-swb-eval-local",
      "--concurrency", "2",
      "--split-manifest", "/split.json",
      "--assets-external-confirm",
    ]);
  });

  it("N=1 无分区清单/外部确认时，不出现这两个旗标（零回归）", () => {
    const argv = buildEvalOrchArgs({ ...BASE, assetsDir: "/assets", fieldConfig: "/fc.json" });
    expect(argv).not.toContain("--split-manifest");
    expect(argv).not.toContain("--assets-external-confirm");
    // 尾部为 --base-url / --env-profile / --concurrency（并发恒传在最后）
    expect(argv.slice(-4)).toEqual(["--env-profile", "b7-swb-eval-local", "--concurrency", "2"]);
  });

  it("N>1：改传 --run，且单值三参一个都不出现（内核 eval_run_inputs_exclusive 互斥）", () => {
    const argv = buildEvalOrchArgs({ ...BASE, runDir: "/data/atf/dev/runs/do-swb-joint-01" });
    expect(argv).toContain("--run");
    expect(argv[argv.indexOf("--run") + 1]).toBe("/data/atf/dev/runs/do-swb-joint-01");
    for (const flag of ["--assets", "--field-config", "--split-manifest"]) {
      expect(argv).not.toContain(flag);
    }
    // 服务/ckpt/out/runner/renderer/base-url/env-profile/concurrency 两侧同值
    expect(argv).toContain("--service");
    expect(argv).toContain("--concurrency");
  });

  it("N>1 且同时给单值参数 → harness 侧即拒（不把歧义送到内核）", () => {
    expect(() => buildEvalOrchArgs({ ...BASE, runDir: "/r", assetsDir: "/assets" })).toThrow(/eval_orch_args_conflict/);
    expect(() => buildEvalOrchArgs({ ...BASE, runDir: "/r", fieldConfig: "/fc.json" })).toThrow(/eval_orch_args_conflict/);
    expect(() => buildEvalOrchArgs({ ...BASE, runDir: "/r", splitManifest: "/s.json" })).toThrow(/eval_orch_args_conflict/);
  });
});
