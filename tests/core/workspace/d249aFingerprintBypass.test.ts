import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootPreflight, type PreflightProbes } from "../../../src/core/workspace/bootPreflight.js";

/**
 * D249a 合码未发版窗口指纹旁路（无机检不立规；事故=1109 双检互斥：指纹机检要
 * pinned==HEAD、扩展预检要 tag==版本串，未发版窗口 pinned 不可能同时满足，为过
 * 预检被迫提前发版）。旁路语义：describe≠版本串时，pinned/.atf-pin-commit 对齐
 * 内核仓 HEAD 即放行留痕；指纹缺席/失配仍 fatal（不静默降级）；tag 一致首选实锚不变。
 */

const VERSION = "0.7.27b40";
const HEAD = "abc123def4567890";

/** 临时夹具树：pinned（版本串+指纹文件）+ 内核仓（HEAD 由 probe mock）。 */
function fixture(opts: { pinCommit?: string; withFingerprint?: boolean }): { pinRoot: string; kernelDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "d249a-"));
  const pinRoot = join(root, "pinned");
  const kernelDir = join(root, "kernel");
  mkdirSync(join(pinRoot, "src", "agentic_training_flow"), { recursive: true });
  writeFileSync(join(pinRoot, "src", "agentic_training_flow", "__init__.py"), `__version__ = "${VERSION}"\n`);
  if (opts.withFingerprint !== false) {
    writeFileSync(join(pinRoot, ".atf-pin-commit"), (opts.pinCommit ?? "") + "\n");
  }
  mkdirSync(kernelDir, { recursive: true });
  return {
    pinRoot,
    kernelDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** ①②（pipeline/bridge 派生）以 env 显式命令跳过——本组只看 ⑦ pin 检查。 */
const quietEnv = { ATF_DSH_PIPELINE_COMMAND: "x", ATF_DSH_BRIDGE_COMMAND: "y" };

function probesFor(opts: { headCommit?: string | null; describe?: string }): PreflightProbes {
  return {
    commandWorks: () => true,
    fileExists: () => true,
    dirExists: () => true,
    listJsonFiles: () => [],
    gitDescribe: () => opts.describe ?? "v0.7.27b39", // 缺省刻意失配：模拟合码未发版窗口
    revParseHead: () => (opts.headCommit === undefined ? HEAD : opts.headCommit),
  };
}

describe("D249a pin 预检合码未发版窗口指纹旁路", () => {
  it("指纹==HEAD：describe 失配仍放行并留痕（fatal 空）", () => {
    const fx = fixture({ pinCommit: HEAD });
    try {
      const report = runBootPreflight(quietEnv, probesFor({}), fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal).toHaveLength(0);
      expect(report.notes.some((n) => n.includes("合码未发版窗口") && n.includes(HEAD.slice(0, 12)))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("指纹缺席：仍 fatal pin_version_consistency（不静默降级）", () => {
    const fx = fixture({ withFingerprint: false });
    try {
      const report = runBootPreflight(quietEnv, probesFor({}), fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal.some((f) => f.check === "pin_version_consistency")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("指纹≠HEAD：仍 fatal pin_version_consistency", () => {
    const fx = fixture({ pinCommit: "deadbeef00000000" });
    try {
      const report = runBootPreflight(quietEnv, probesFor({}), fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal.some((f) => f.check === "pin_version_consistency")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("内核 HEAD 不可解析：仍 fatal（旁路不猜）", () => {
    const fx = fixture({ pinCommit: HEAD });
    try {
      const report = runBootPreflight(quietEnv, probesFor({ headCommit: null }), fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal.some((f) => f.check === "pin_version_consistency")).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("tag==版本串（发版态）：首选实锚不变、不触发旁路分支", () => {
    const fx = fixture({ pinCommit: "irrelevant" });
    try {
      const report = runBootPreflight(quietEnv, probesFor({ describe: `v${VERSION}` }), fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal).toHaveLength(0);
      expect(report.notes.some((n) => n.includes("worktree describe＝版本串一致"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
