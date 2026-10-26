import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { bridgeError, stringifyCause, type BridgeError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/**
 * atf CLI 对接面——与 bridge.contract.yaml 的 atf_cli 段一一对应。
 * ATF 路径一律经 ATF_CLI_PATH 环境变量注入，仓内不得出现内部绝对路径。
 */

// 当前 pin（re-pin 契约轴 2026-10-26 窗口：v0.7.25b16 → v0.7.25b24，唯一真相源 = bridge.contract.yaml
// atf_upstream，本文件常量为运行时镜像；变更走 re-pin 三步显式 PR）。
// 本轮 pin 取值＝tag v0.7.25b24（构造参数可信度批）：targeted 组合「2-6 字段三档」
// 由「randint 下界恰好为 1」的**巧合实现**改为显式收口——新增 `TARGETED_COMBO_FIELD_BAND`
// 单源常量，读侧按 `randint(min-1, max-1)` 取陪衬且区间越界/倒置 fail-closed；写侧
// construction.targeted_rules 不再整体写 null 而是落生效值＋来源标注（此前报告印
// 「组合规则未声明」而实际按 2/6 跑，双盲）；分析侧改以 variants_report 的生效值为权威
// 并附实测字段数分布。缺省路径随机序列与产物逐字节不变（真机四件 sha256 对拍通过）。
// CLI 声明面零变化：surface 与上一 pin 逐字相同（SURFACE_IDENTICAL）。
// ——详见 bridge.contract.yaml atf_upstream.baseline；tag commit f4ab0e7，方法面零增（session/ 零 diff），
// 会话协议轴 1／桥接契约轴 3 零 diff）。
export const ATF_UPSTREAM_TAG = "v0.7.25b24";
export const ATF_UPSTREAM_COMMIT_SHA = "f4ab0e75909b53db3ffabf084df04ccc0f525c33";

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

/** 读取 ATF_CLI_PATH；未设置 = err(config_error)（契约测试据此跳过并给出提示）。
 *  批⑤规范化（2026-09-27，指令 de34f3a8）：读入值经 path.resolve() 升绝对路径——相对注入
 *  一律解析为绝对（cwd=cliPath 语义下杜绝 git -C 等子进程按各自 cwd 二次解析失败类问题）；
 *  错误分支（未设置/空串）行为不变。 */
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
  return ok(resolve(value));
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
