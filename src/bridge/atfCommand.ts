import { execFile } from "node:child_process";
import { bridgeError, stringifyCause, type BridgeError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * atf CLI 对接面——与 bridge.contract.yaml 的 atf_cli 段一一对应。
 * ATF 路径一律经 ATF_CLI_PATH 环境变量注入，仓内不得出现内部绝对路径。
 */

// 当前 pin（re-pin 2026-09-24：v0.7.5b0 → v0.7.6b0，唯一真相源 = bridge.contract.yaml atf_upstream，
// 本文件常量为运行时镜像；变更走 re-pin 三步显式 PR）。
// 本轮 pin 取值＝tag v0.7.6b0（B4 技能互引闭环发版：SKILL v1.5 双向跳转——validate↔build-family-split，
// 纯文档无行为语义变更；内核闸门/桥接契约轴一轴二零 diff，不触发强制升级）——HEAD==tag commit 9d5ce4a，无 sha 备注。
export const ATF_UPSTREAM_TAG = "v0.7.6b0";
export const ATF_UPSTREAM_COMMIT_SHA = "9d5ce4a663d2f4454b25c0c3bf2e9a08ad156d1f";

export interface AtfCliInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 由 ATF_CLI_PATH 派生一次性调用（不依赖全局安装、不回写内核仓）。 */
export const deriveAtfCommand = (cliPath: string, args: readonly string[]): AtfCliInvocation => ({
  command: "python3",
  args: ["-m", "agentic_training_flow", ...args],
  cwd: cliPath,
  env: {
    PYTHONPATH: `${cliPath}/src`,
    PYTHONDONTWRITEBYTECODE: "1",
    // re-pin R1（2026-09-14，契约 derive_command.env 同步）：内核 CLI 入口有技能自举
    // （skills_install.ensure_skills_installed()，默认写 ~/.agents/skills），测试期必须关闭。
    ATF_SKILLS_AUTO_INSTALL: "0",
  },
});

/** 读取 ATF_CLI_PATH；未设置 = err(config_error)（契约测试据此跳过并给出提示）。 */
export const atfCliPathFromEnv = (): Result<string, BridgeError> => {
  const value = process.env["ATF_CLI_PATH"];
  if (value === undefined || value.trim() === "") {
    return err(
      bridgeError({
        code: "config_error",
        message: "ATF_CLI_PATH 未设置：契约测试需要指向 checkout 在 pin 上的 ATF 只读副本（目录）",
        detail: { expected_pin: ATF_UPSTREAM_COMMIT_SHA, expected_tag: ATF_UPSTREAM_TAG },
      }),
    );
  }
  return ok(value);
};

const execFileAsResult = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
): Promise<Result<{ exitCode: number | null; stdout: string; stderr: string }, BridgeError>> =>
  new Promise((resolve) => {
    const child = execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error === null) {
        resolve(ok({ exitCode: 0, stdout, stderr }));
        return;
      }
      const errno = (error as NodeJS.ErrnoException).code;
      if (error.killed) {
        resolve(err(bridgeError({ code: "timeout", message: `命令超时被终止: ${command} ${args.join(" ")}` })));
        return;
      }
      if (typeof (error as { exitCode?: number | null }).exitCode === "number" || errno === undefined) {
        // 进程跑起来但以非零退出：这不是桥接失败，把完整信息交调用方断言
        resolve(
          ok({
            exitCode: (error as { exitCode?: number | null }).exitCode ?? null,
            stdout,
            stderr,
          }),
        );
        return;
      }
      resolve(
        err(bridgeError({ code: "spawn_failed", message: `命令启动失败: ${stringifyCause(error)}`, detail: { errno } })),
      );
    });
    child.on("error", () => {
      /* 结果已走回调 error 路径，这里仅吞掉独立 error 事件防止未处理崩溃 */
    });
  });

/** 读取 ATF 副本 HEAD sha（用于 pin 一致性校验）。 */
export const readGitHeadSha = (repoPath: string): Promise<Result<string, BridgeError>> =>
  execFileAsResult("git", ["-C", repoPath, "rev-parse", "HEAD"], {
    cwd: repoPath,
    env: { ...process.env },
    timeout: 15_000,
  }).then((result) => (result.ok ? ok(result.value.stdout.trim()) : result));

/** 对真实 CLI 做 derive_command 冒烟（--help，预期退出码 0）。 */
export const probeAtfHelp = (
  cliPath: string,
): Promise<Result<{ exitCode: number | null; stdoutHead: string; stderrHead: string }, BridgeError>> => {
  const invocation = deriveAtfCommand(cliPath, ["--help"]);
  return execFileAsResult(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    timeout: 60_000,
  }).then((result) =>
    result.ok
      ? ok({
          exitCode: result.value.exitCode,
          stdoutHead: result.value.stdout.slice(0, 400),
          stderrHead: result.value.stderr.slice(0, 400),
        })
      : result,
  );
};
