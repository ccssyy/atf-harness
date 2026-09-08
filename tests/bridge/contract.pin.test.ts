import { describe, expect, it } from "vitest";
import {
  ATF_UPSTREAM_COMMIT_SHA,
  ATF_UPSTREAM_TAG,
  atfCliPathFromEnv,
  probeAtfHelp,
  readGitHeadSha,
} from "../../src/bridge/atfCommand.js";

/**
 * Contract tests——对固定 commit 的真实 atf CLI（ATF_CLI_PATH）跑契约断言（任务书 §8.3）。
 * 前置：ATF_CLI_PATH 指向 checkout 在 pin 上的 ATF 只读副本；未设置时整组跳过（单元测试
 * 与 mock 会话测试不依赖它，随时可跑）。HEAD 与 pin 不一致 = 直接 fail（禁止自动追新）。
 */
const cliPath = atfCliPathFromEnv();
const describeIfPinned = cliPath.ok ? describe : describe.skip;

describeIfPinned("契约测试（真实 atf CLI @ pin）", () => {
  const path = cliPath.ok ? cliPath.value : "";

  it(`pin 校验：HEAD == ${ATF_UPSTREAM_TAG} (${ATF_UPSTREAM_COMMIT_SHA.slice(0, 7)})`, async () => {
    const head = await readGitHeadSha(path);
    expect(head.ok, head.ok ? undefined : `读取 HEAD 失败: ${JSON.stringify(head.error)}`).toBe(true);
    if (!head.ok) return;
    expect(
      head.value,
      `ATF_CLI_PATH 的 HEAD (${head.value}) 与 pin (${ATF_UPSTREAM_COMMIT_SHA}) 不一致——` +
        "请执行: git -C <ATF仓> worktree add <本仓>/.atf-pinned " +
        `${ATF_UPSTREAM_TAG} 并 export ATF_CLI_PATH=<本仓>/.atf-pinned（re-pin 三步见 AGENTS.md §4）`,
    ).toBe(ATF_UPSTREAM_COMMIT_SHA);
  });

  it("derive_command 冒烟：python3 -m agentic_training_flow --help 退出码 0", async () => {
    const probe = await probeAtfHelp(path);
    expect(probe.ok, probe.ok ? undefined : JSON.stringify(probe.error)).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.exitCode).toBe(0);
    expect(probe.value.stdoutHead).toContain("atf");
  });

  // 已知缺口占位（bridge.contract.yaml atf_cli.known_gaps）：内核 v0.2.0b7 尚无 JSONL 会话模式
  // 与 --version 旗标；待 ATF 侧按 §8.3.3 排队落地后，此处启用真实 CLI 的会话握手断言。
  it.skip("会话握手（真实 CLI JSONL 对端）——等待内核 RPC 模式落地", () => {});
});

describe("契约环境自检", () => {
  it.skip("（占位）未设置 ATF_CLI_PATH 时本文件仅本组跳过并输出提示", () => {});
});

if (!cliPath.ok) {
  // eslint 风格的运行时提示：保持测试输出可解释
  it("ATF_CLI_PATH 未设置 → 契约测试组跳过（仅 mock 会话测试覆盖）", () => {
    expect(cliPath.ok).toBe(false);
    if (!cliPath.ok) expect(cliPath.error.code).toBe("config_error");
  });
}
