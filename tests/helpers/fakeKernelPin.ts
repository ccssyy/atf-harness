/**
 * 受控假内核 pin 树（存量红 #4/#8 环境耦合隔离的共享 fixture）。
 *
 * apply 启动闸 preflight 的 pin 一致性检查（bootPreflight pin_version_consistency）
 * 在真 .atf-pinned 窗口态（main 前进未发版，describe 带 -NN-g<sha> 后缀）下 fatal，
 * 会先于测试目标逻辑触发。本 helper 构造 describe 与 __version__ 同指的受控树
 * （git tag v<版本串>），测试经 env ATF_INSTANCE_PIN_ROOT 显式注入——
 * 测试不再受部署面 pin 状态摆布（任务书存量红批第 8 类指定修法形态）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const buildFakeKernelPin = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fake-kernel-pin-"));
  const git = (args: string[]): void => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, stdio: "ignore" });
  };
  mkdirSync(join(root, "src", "agentic_training_flow"), { recursive: true });
  writeFileSync(join(root, "src", "agentic_training_flow", "__init__.py"), '__version__ = "0.7.27b46"\n');
  writeFileSync(join(root, ".atf-pin-commit"), "0".repeat(40));
  // resolveBridgeDeployment：kernelDir 在场即取真内核 argv——管线脚本在场性是其部署检查项
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools", "walkthrough_pipeline.py"), "# fixture stub\n");
  git(["init"]);
  git(["add", "-A"]);
  git(["commit", "-m", "fake pin tree for test"]);
  git(["tag", "v0.7.27b46"]);
  return root;
};
