import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootPreflight, type PreflightProbes } from "../../../src/core/workspace/bootPreflight.js";

/**
 * D249a 合码未发版窗口指纹旁路——**已随 pin 退役（G7／D9）**。
 *
 * 沿革：原用例验证「describe tag≠版本串时，pinned/.atf-pin-commit 对齐内核仓 HEAD 即放行」。
 * pin 树不再是加载源后，`pin_version_consistency` 门本身消失，旁路无对象可放行——原五条
 * 用例的断言语义已不存在（不是失效，是机制被删）。
 *
 * 本文件重定位为**退役守卫**：证明该门确实不再产生 fatal，且旧调用方按原签名传入 pin
 * 参数（禁改面 packages/extensions/atf-tools 尚在传）也不会复活任何 pin 校验。
 * 这才是「退役干净」的证据——留一个描述当批意图的机检落点，而非删文件丢证据。
 */

const VERSION = "0.7.27b40";

/** 临时夹具：一个想当 pin 的树（版本串在、指纹在）＋内核目录。 */
function fixture(opts: { pinCommit?: string; withFingerprint?: boolean } = {}): {
  pinRoot: string;
  kernelDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "d249a-retired-"));
  const pinRoot = join(root, "pinned");
  const kernelDir = join(root, "kernel");
  mkdirSync(join(pinRoot, "src", "agentic_training_flow"), { recursive: true });
  writeFileSync(join(pinRoot, "src", "agentic_training_flow", "__init__.py"), `__version__ = "${VERSION}"\n`);
  if (opts.withFingerprint !== false) {
    writeFileSync(join(pinRoot, ".atf-pin-commit"), (opts.pinCommit ?? "") + "\n");
  }
  mkdirSync(kernelDir, { recursive: true });
  return { pinRoot, kernelDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** ①②（pipeline/bridge 派生）以 env 显式命令跳过——本组只看 pin 面是否仍在检。 */
const quietEnv = { ATF_DSH_PIPELINE_COMMAND: "x", ATF_DSH_BRIDGE_COMMAND: "y" };

const permissiveProbes: PreflightProbes = {
  commandWorks: () => true,
  fileExists: () => true,
  dirExists: () => true,
  listJsonFiles: () => [],
};

describe("D249a 旁路已退役——pin 版本一致性门不再产生 fatal", () => {
  it("旧调用方按原签名传 pin 参数：不再有任何 pin 相关 fatal（无论 tag/指纹状态）", () => {
    const fx = fixture({ pinCommit: "deadbeef00000000" });
    try {
      // 原用例里这种形态必 fatal pin_version_consistency；现已无检
      const report = runBootPreflight(quietEnv, permissiveProbes, fx.kernelDir, { root: fx.pinRoot, explicit: true });
      expect(report.fatal).toHaveLength(0);
      expect(report.fatal.some((f) => f.check.startsWith("pin_"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("指纹缺席 + describe 不可解析：原双红形态，现零 pin fatal", () => {
    const fx = fixture({ withFingerprint: false });
    try {
      const report = runBootPreflight(quietEnv, permissiveProbes, fx.kernelDir, { root: fx.pinRoot, explicit: false });
      expect(report.fatal.some((f) => f.check === "pin_version_consistency")).toBe(false);
      expect(report.fatal.some((f) => f.check === "pin_worktree")).toBe(false);
      expect(report.fatal.some((f) => f.check === "pin_version")).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("不再留「回退共享态」痕（pin 未配置不再是需要告知的操作态）", () => {
    const fx = fixture();
    try {
      const report = runBootPreflight(quietEnv, permissiveProbes, fx.kernelDir, { root: fx.pinRoot, explicit: false });
      expect(report.notes.some((n) => n.includes("回退共享态"))).toBe(false);
      expect(report.notes.some((n) => n.includes("pin 树实锚"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("pin 参数缺席（新调用形态）同样零 pin fatal——签名两态都安全", () => {
    const fx = fixture();
    try {
      const report = runBootPreflight(quietEnv, permissiveProbes, fx.kernelDir);
      expect(report.fatal).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});
