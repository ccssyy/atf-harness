import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ATF_UPSTREAM_COMMIT_SHA,
  ATF_UPSTREAM_TAG,
  atfCliPathFromEnv,
  deriveAtfCommand,
  probeAtfHelp,
  readGitHeadSha,
} from "../../src/bridge/atfCommand.js";
import {
  AtfBridgeConnection,
  EXPECTED_SESSION_CONTRACT_VERSION,
  LineFrameDecoder,
  encodeRequestFrame,
  validateKernelFrame,
} from "../../src/bridge/index.js";

/**
 * Contract tests——对固定 commit 的真实 atf CLI（ATF_CLI_PATH）跑契约断言（任务书 §8.3）。
 * 前置：ATF_CLI_PATH 指向 checkout 在 pin 上的 ATF 只读副本；未设置时整组跳过（单元测试
 * 与 mock 会话测试不依赖它，随时可跑）。HEAD 与 pin 不一致 = 直接 fail（禁止自动追新）。
 *
 * re-pin R1（2026-09-14，《ATF-Harness_Owner指令_re-pin专项_R1_20260914.md》）：pin
 * v0.2.0b7 → v0.6.0b0，内核 `serve` 子命令落地 JSONL 会话——原"会话握手等待内核落地"
 * 占位启用为真实会话断言：握手（会话协议版本 = EXPECTED_SESSION_CONTRACT_VERSION = 1）/
 * 帧配对 / 未知方法 method_not_found 且连接保持 / stdout 全字节流逐行合法帧 / 优雅关闭
 * exit 0——即「通道对真实内核成立」验证。工具面/账本面真实对端替换属 R2（另批）。
 * 隔离纪律：子进程 HOME 指向临时夹具（兜底隔离技能自举与用户目录写入）、
 * ATF_SKILLS_AUTO_INSTALL=0（契约 derive_command.env 同步）；不触发任何真实写动作。
 */
const cliPath = atfCliPathFromEnv();
const describeIfPinned = cliPath.ok ? describe : describe.skip;

describeIfPinned("契约测试（真实 atf CLI @ pin）", () => {
  const path = cliPath.ok ? cliPath.value : "";
  const openConnections: AtfBridgeConnection[] = [];
  const tempHomes: string[] = [];

  afterEach(async () => {
    while (openConnections.length > 0) {
      const connection = openConnections.pop();
      if (connection !== undefined) await connection.close({ timeoutMs: 5_000 }).catch(() => undefined);
    }
    for (const home of tempHomes.splice(0)) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  /** 真实会话对端 argv/env：契约 derive_command 派生 + HOME 临时夹具（隔离纪律）。 */
  const sessionSpawn = (home: string) => {
    const invocation = deriveAtfCommand(path, ["serve"]);
    return {
      command: [invocation.command, ...invocation.args] as const,
      cwd: invocation.cwd,
      env: { ...invocation.env, HOME: home },
    };
  };

  const newTempHome = async (): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), "atf-r1-home-"));
    tempHomes.push(home);
    return home;
  };

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

  it("真实会话——握手（会话协议版本 = 1）+ 帧配对无串扰 + 未知方法 method_not_found 且连接保持 + 优雅关闭 exit 0", async () => {
    const home = await newTempHome();
    const target = sessionSpawn(home);
    const spawned = await AtfBridgeConnection.spawn({
      command: [...target.command],
      cwd: target.cwd,
      env: target.env,
    });
    expect(spawned.ok, spawned.ok ? undefined : JSON.stringify(spawned.error)).toBe(true);
    if (!spawned.ok) return;
    openConnections.push(spawned.value);
    const connection = spawned.value;

    // 握手断言（spawn 内已完成 atf.version 并按 EXPECTED_SESSION_CONTRACT_VERSION 校验）
    const version = connection.version;
    expect(version).toBeDefined();
    expect(version?.name).toBe("atf");
    expect(version?.version, "内核版本串须非空").not.toBe("");
    expect(version?.contract_version).toBe(EXPECTED_SESSION_CONTRACT_VERSION);
    expect(version?.contract_version).toBe(1); // 会话协议版本轴（re-pin R1：内核方法面补登不 bump）

    // 帧配对：连续两次 atf.version → 两条响应各自 ok、内容一致（id 经连接层逐条配对，无串扰）
    const [first, second] = await Promise.all([connection.request("atf.version"), connection.request("atf.version")]);
    expect(first.ok, first.ok ? undefined : JSON.stringify(first.error)).toBe(true);
    expect(second.ok, second.ok ? undefined : JSON.stringify(second.error)).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
      expect((first.value as { contract_version: number }).contract_version).toBe(1);
    }

    // 未知方法 → method_not_found（error response），连接保持：后续请求继续可用
    const unknown = await connection.request("atf.no_such_method_r1_probe", {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("request_rejected");
      expect(((unknown.error.detail ?? {}) as { code?: string }).code).toBe("method_not_found");
    }
    const after = await connection.request("atf.version");
    expect(after.ok, after.ok ? undefined : JSON.stringify(after.error)).toBe(true);

    // 优雅关闭：stdin end → 对端 exit 0
    const closed = await connection.close();
    expect(closed.ok, closed.ok ? undefined : JSON.stringify(closed.error)).toBe(true);
    if (closed.ok) {
      expect(closed.value.exitCode).toBe(0);
      expect(closed.value.signal).toBeNull();
    }
  });

  it("真实会话——stdout 洁净：全字节流逐行可解析为合法帧（无欢迎语/无诊断输出），stderr 静默，exit 0", async () => {
    const home = await newTempHome();
    const target = sessionSpawn(home);
    const child = spawn(target.command[0], [...target.command.slice(1)], {
      cwd: target.cwd,
      env: { ...process.env, ...target.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

    // 原始线缆三连发：握手 + 未知方法 + 复用（不经连接层，直验字节流）
    const send = (frame: Parameters<typeof encodeRequestFrame>[0]): void => {
      const encoded = encodeRequestFrame(frame);
      expect(encoded.ok, encoded.ok ? undefined : JSON.stringify(encoded.error)).toBe(true);
      if (encoded.ok) child.stdin.write(encoded.value);
    };
    send({ type: "request", id: 1, method: "atf.version", params: null });
    send({ type: "request", id: 2, method: "atf.no_such_method_r1_probe", params: {} });
    send({ type: "request", id: 3, method: "atf.version", params: null });
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    // 优雅关闭 + stderr 静默（诊断/欢迎语不落 stderr，对端异常时 stderr 才承载尾部摘要）
    expect(exitCode).toBe(0);
    expect(stderrChunks.join(""), "stderr 须静默").toBe("");

    // stdout 洁净：全字节流经严格 LF 分帧零协议违规；首字节即帧（无欢迎语）；逐帧合法
    const stdout = stdoutChunks.join("");
    expect(stdout.startsWith("{"), `stdout 须以帧开头，实得头部: ${stdout.slice(0, 60)}`).toBe(true);
    const items = new LineFrameDecoder().push(stdout);
    const violations = items.filter((item) => item.kind === "protocol_error");
    expect(violations, JSON.stringify(violations.map((item) => item.error.message))).toHaveLength(0);
    const frames = items.filter((item) => item.kind === "frame").map((item) => (item.kind === "frame" ? item.frame : null));
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame).not.toBeNull();
      expect(validateKernelFrame(frame)).toBeNull();
    }
    // id 逐条回显：1/3 = 握手成功（会话协议版本 1），2 = method_not_found
    expect(frames.map((frame) => (frame !== null && frame.type === "response" ? frame.id : null))).toEqual([1, 2, 3]);
    const [rawFirst, rawSecond, rawThird] = frames as [
      { type: "response"; id: number; ok: boolean; result?: unknown; error?: { code: string } } | null,
      { type: "response"; id: number; ok: boolean; result?: unknown; error?: { code: string } } | null,
      { type: "response"; id: number; ok: boolean; result?: unknown; error?: { code: string } } | null,
    ];
    expect(rawFirst?.ok).toBe(true);
    expect((rawFirst?.result as { contract_version: number }).contract_version).toBe(1);
    expect(rawSecond?.ok).toBe(false);
    expect(rawSecond?.error?.code).toBe("method_not_found");
    expect(rawThird?.ok).toBe(true);
  });
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
