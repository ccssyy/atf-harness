/**
 * 受控假内核树（存量红 #4/#8 环境耦合隔离的共享 fixture）。
 *
 * 沿革：原为「假内核 pin 树」——为绕开 apply 启动闸 preflight 的 pin 一致性检查
 * （pin_version_consistency 在 main 前进未发版窗口 fatal）而构造 describe 与 __version__
 * 同指的受控树，并经 env ATF_INSTANCE_PIN_ROOT 注入。G7／D9 pin 退役后该检查已删，
 * 本 fixture 只剩「一个内容完整、可被 kernelDir 消费的内核目录」职责：版本串在、
 * 管线脚本在、可当 git 检出用。注入键改为 ATF_DSH_KERNEL_DIR。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const buildFakeKernelTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fake-kernel-tree-"));
  const git = (args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "ignore" });
  };
  mkdirSync(join(root, "src", "agentic_training_flow"), { recursive: true });
  writeFileSync(join(root, "src", "agentic_training_flow", "__init__.py"), '__version__ = "0.7.27b46"\n');
  // resolveBridgeDeployment：kernelDir 在场即取真内核 argv——管线脚本在场性是其部署检查项
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools", "walkthrough_pipeline.py"), "# fixture stub\n");
  git(["init"]);
  git(["add", "-A"]);
  git(["commit", "-m", "fake kernel tree for test"]);
  git(["tag", "v0.7.27b46"]);
  return root;
};

/** @deprecated 旧名（pin 语境）——新代码用 buildFakeKernelTree。 */
export const buildFakeKernelPin = buildFakeKernelTree;
