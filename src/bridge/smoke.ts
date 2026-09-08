/**
 * S1 手工冒烟命令（任务书：每个 slice 一条手工冒烟命令）。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:s1 -- --mock                 # 对契约 mock 对端做 握手→请求→优雅关闭 全流程
 *   npm run smoke:s1 -- --mock --chunk=7       # 追加分帧压力（对端按 7 字节分片输出）
 *   npm run smoke:s1 -- --atf                  # 真实 CLI：pin 校验 + derive_command 冒烟（--help）
 *
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATF_UPSTREAM_COMMIT_SHA, ATF_UPSTREAM_TAG, AtfBridgeConnection, atfCliPathFromEnv, probeAtfHelp, readGitHeadSha } from "./index.js";
import { bridgeError, type BridgeError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
// dist/bridge/smoke.js → 仓库根为 dist 的上两级
const repoRoot = join(scriptDir, "..", "..");

const smokeMock = async (extraFlags: readonly string[]): Promise<Result<undefined, BridgeError>> => {
  const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
  if (!existsSync(mockPath)) {
    return err(bridgeError({ code: "config_error", message: `未找到 mock 对端: ${mockPath}（请在仓库根目录运行）` }));
  }
  console.log(`[1/3] spawn mock 对端: node ${mockPath} ${extraFlags.join(" ")}`.trimEnd());
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockPath, ...extraFlags] });
  if (!spawned.ok) {
    console.error("spawn/握手失败:", JSON.stringify(spawned.error, null, 2));
    return err(spawned.error);
  }
  const connection = spawned.value;
  console.log(`[2/3] 握手成功: ${JSON.stringify(connection.version)}`);

  const roundTrip = await connection.request("atf.version");
  if (!roundTrip.ok) {
    console.error("请求失败:", JSON.stringify(roundTrip.error, null, 2));
    await connection.close();
    return err(roundTrip.error);
  }
  console.log(`[3/3] 请求回环 OK: ${JSON.stringify(roundTrip.value)}`);

  const closed = await connection.close();
  if (!closed.ok) {
    console.error("优雅关闭失败:", JSON.stringify(closed.error, null, 2));
    return err(closed.error);
  }
  console.log(`优雅关闭 OK: exit=${String(closed.value.exitCode)}`);
  return ok(undefined);
};

const smokeAtf = async (): Promise<Result<undefined, BridgeError>> => {
  const cliPath = atfCliPathFromEnv();
  if (!cliPath.ok) {
    console.error(JSON.stringify(cliPath.error, null, 2));
    return err(cliPath.error);
  }
  console.log(`[1/2] pin 校验: ATF_CLI_PATH=${cliPath.value}\n      期望 ${ATF_UPSTREAM_TAG} = ${ATF_UPSTREAM_COMMIT_SHA}`);
  const head = await readGitHeadSha(cliPath.value);
  if (!head.ok) {
    console.error("读取 HEAD 失败:", JSON.stringify(head.error, null, 2));
    return err(head.error);
  }
  if (head.value !== ATF_UPSTREAM_COMMIT_SHA) {
    const error = bridgeError({
      code: "config_error",
      message: `pin 不一致: HEAD=${head.value}（re-pin 三步见 AGENTS.md §4；禁止自动追新）`,
      detail: { expected: ATF_UPSTREAM_COMMIT_SHA, got: head.value },
    });
    console.error(error.message);
    return err(error);
  }
  console.log("[1/2] pin 一致 ✓");

  console.log("[2/2] derive_command 冒烟: python3 -m agentic_training_flow --help");
  const probe = await probeAtfHelp(cliPath.value);
  if (!probe.ok) {
    console.error("CLI 冒烟失败:", JSON.stringify(probe.error, null, 2));
    return err(probe.error);
  }
  if (probe.value.exitCode !== 0) {
    const error = bridgeError({
      code: "spawn_failed",
      message: `--help 退出码非 0: ${String(probe.value.exitCode)}`,
      detail: { stderr: probe.value.stderrHead },
    });
    console.error(error.message, probe.value.stderrHead);
    return err(error);
  }
  console.log(`[2/2] CLI 冒烟 ✓（${probe.value.stdoutHead.split("\n")[0]?.trim() ?? ""}）`);
  console.log("已知缺口（见 bridge.contract.yaml atf_cli.known_gaps）: 内核暂无 --version 与 JSONL 会话模式，S1 会话协议由 mock 对端承载。");
  return ok(undefined);
};

const modeAtf = process.argv.includes("--atf");
const extraFlags = process.argv.slice(2).filter((arg) => arg !== "--mock" && arg !== "--atf");
const result = await (modeAtf ? smokeAtf() : smokeMock(extraFlags));
if (!result.ok) process.exitCode = 1;
else console.log("S1 冒烟通过 ✓");
