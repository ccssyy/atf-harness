/**
 * 批㊶-ISO E1/E2——会话命名域单源行为锚。
 *
 * resolveSessionName（前缀拼装＋fail-closed）／resolveLaunchSessionName（launch 域不受限）／
 * probeSession／枚举域 ——含真 tmux 实测：dev- 与 uat- 两前缀互不命中、launch 带前缀真启停。
 * 全部真 tmux 操作经 tests/fixtures/tmuxTestSocket.ts 独立测试 socket（D2①）——默认 socket 零触碰。
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  EVAL_ORCH_TMUX_SESSION,
  listTrainingSessionCmdlines,
  probeSession,
  resolveLaunchSessionName,
  resolveSessionName,
  tmuxCommand,
  tmuxHasSession,
  tmuxSocketFlag,
  tmuxTrainingEvidenceFor,
  tmuxTrainingFamilyPresent,
  TMUX_SESSION_PREFIX_ENV,
  TMUX_TEST_SOCKET_ENV,
  TRAINING_TMUX_SESSION,
} from "../../../src/core/workspace/tmuxLiveness.js";
import { tmuxTest, tmuxTestOk } from "../../fixtures/tmuxTestSocket.js";

/** env 保存/恢复壳（本文件内互不污染——vitest 逐文件隔离进程 env 已由 fixture 落盘）。 */
const withEnv = <T>(mutate: () => void, fn: () => T): T => {
  const savedPrefix = process.env[TMUX_SESSION_PREFIX_ENV];
  const savedSocket = process.env[TMUX_TEST_SOCKET_ENV];
  try {
    mutate();
    return fn();
  } finally {
    if (savedPrefix === undefined) delete process.env[TMUX_SESSION_PREFIX_ENV];
    else process.env[TMUX_SESSION_PREFIX_ENV] = savedPrefix;
    if (savedSocket === undefined) delete process.env[TMUX_TEST_SOCKET_ENV];
    else process.env[TMUX_TEST_SOCKET_ENV] = savedSocket;
  }
};
const withPrefix = <T>(prefix: string | undefined, fn: () => T): T =>
  withEnv(() => {
    if (prefix === undefined) delete process.env[TMUX_SESSION_PREFIX_ENV];
    else process.env[TMUX_SESSION_PREFIX_ENV] = prefix;
  }, fn);

describe("批㊶-ISO E1——会话命名域单源（resolveSessionName／resolveLaunchSessionName）", () => {
  it("拼装锚：会话名＝前缀＋base（训练/评估编排两基名；dev-/uat- 两前缀各自拼装）", () => {
    withPrefix("dev-", () => {
      expect(resolveSessionName(TRAINING_TMUX_SESSION)).toEqual({ ok: true, session: "dev-atf-training-run" });
      expect(resolveSessionName(EVAL_ORCH_TMUX_SESSION)).toEqual({ ok: true, session: "dev-atf-eval-orch" });
    });
    withPrefix("uat-", () => {
      expect(resolveSessionName(TRAINING_TMUX_SESSION)).toEqual({ ok: true, session: "uat-atf-training-run" });
    });
    // fixture 注入的测试前缀同链路（生产 env 单源——测试即真环境形态）
    const fixturePrefix = process.env[TMUX_SESSION_PREFIX_ENV] ?? "";
    expect(fixturePrefix).toMatch(/^atf-test-.+-$/);
    expect(resolveSessionName(TRAINING_TMUX_SESSION)).toEqual({
      ok: true,
      session: `${fixturePrefix}${TRAINING_TMUX_SESSION}`,
    });
  });

  it("launch 域锚：前缀在则带前缀；未设回退裸 base（启动不受 fail-closed 限制）", () => {
    withPrefix("dev-", () => {
      expect(resolveLaunchSessionName(TRAINING_TMUX_SESSION)).toBe("dev-atf-training-run");
    });
    withPrefix(undefined, () => {
      expect(resolveLaunchSessionName(TRAINING_TMUX_SESSION)).toBe(TRAINING_TMUX_SESSION);
      expect(resolveLaunchSessionName(EVAL_ORCH_TMUX_SESSION)).toBe(EVAL_ORCH_TMUX_SESSION);
    });
  });

  it("fail-closed 锚：前缀未设 → 解析拒绝（ok:false＋reason＋guidance），kill/枚举/探测全收口", () => {
    withPrefix(undefined, () => {
      const refused = resolveSessionName(TRAINING_TMUX_SESSION);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain(TMUX_SESSION_PREFIX_ENV);
      expect(refused.guidance).toContain(TMUX_SESSION_PREFIX_ENV);
      expect(refused.guidance).toContain("禁止触碰默认 socket 会话");
      // 探测域：refused 随返回值可见（调用方回流 status 面——guidance 不丢失）
      const probe = probeSession(TRAINING_TMUX_SESSION);
      expect(probe.present).toBe(false);
      expect(probe.refused).not.toBeNull();
      expect(probe.refused?.ok).toBe(false);
      if (probe.refused !== null && !probe.refused.ok) expect(probe.refused.guidance).toContain("禁止触碰默认 socket 会话");
      expect(tmuxHasSession(TRAINING_TMUX_SESSION)).toBe(false);
      // 枚举域：全空（family/枚举/绑 run 取证）
      expect(tmuxTrainingFamilyPresent()).toBe(false);
      expect(listTrainingSessionCmdlines()).toEqual([]);
      expect(tmuxTrainingEvidenceFor("run-iso-e1")).toBe(false);
    });
  });

  it("互斥锚：dev- 与 uat- 两前缀会话互不可见（真 tmux——独立测试 socket）", () => {
    const devSession = `dev-${TRAINING_TMUX_SESSION}`;
    try {
      tmuxTest(`new-session -d -s ${devSession} "sleep 15"`);
      // dev 域：探测命中＋枚举可见（会族判据＝前缀＋atf-，非本域会话不入列）
      tmuxTest(`new-session -d -s dev-notatf "sleep 15"`);
      withPrefix("dev-", () => {
        expect(tmuxHasSession(TRAINING_TMUX_SESSION)).toBe(true);
        expect(probeSession(TRAINING_TMUX_SESSION)).toMatchObject({ present: true, refused: null });
        expect(listTrainingSessionCmdlines().map((e) => e.session)).toContain(devSession);
        expect(listTrainingSessionCmdlines().map((e) => e.session)).not.toContain("dev-notatf");
        expect(tmuxTrainingFamilyPresent()).toBe(true);
      });
      // uat 域：dev 会话完全不可见（探测缺席、枚举为空、family 不命中——kill 失去跨域目标）
      withPrefix("uat-", () => {
        expect(tmuxHasSession(TRAINING_TMUX_SESSION)).toBe(false);
        const probe = probeSession(TRAINING_TMUX_SESSION);
        expect(probe.present).toBe(false);
        expect(probe.refused).toBeNull(); // 前缀已设——非拒绝，是本域确无此会话
        expect(listTrainingSessionCmdlines()).toEqual([]);
        expect(tmuxTrainingFamilyPresent()).toBe(false);
        expect(tmuxTrainingEvidenceFor("run-iso-e1")).toBe(false);
      });
    } finally {
      tmuxTestOk(`kill-session -t ${devSession}`);
      tmuxTestOk(`kill-session -t dev-notatf`);
    }
  });

  it("launch 带前缀锚：解析名经 tmuxCommand 真启停于测试 socket，探活命中", () => {
    withPrefix("uat-", () => {
      const name = resolveLaunchSessionName(TRAINING_TMUX_SESSION);
      expect(name).toBe(`uat-${TRAINING_TMUX_SESSION}`);
      try {
        execSync(tmuxCommand(`new-session -d -s ${name} "sleep 15"`), { stdio: "ignore" });
        expect(probeSession(TRAINING_TMUX_SESSION).present).toBe(true);
      } finally {
        execSync(tmuxCommand(`kill-session -t ${name} 2>/dev/null`));
      }
      expect(probeSession(TRAINING_TMUX_SESSION).present).toBe(false);
    });
  });
});

describe("批㊶-ISO D2①——测试 socket 注入面（tmuxSocketFlag／tmuxCommand）", () => {
  it("env 缺席 → 默认 socket 形态（无 -L）；atf-test-* 值 → -L 注入", () => {
    withEnv(() => { delete process.env[TMUX_TEST_SOCKET_ENV]; }, () => {
      expect(tmuxSocketFlag()).toBe("");
      const cmd = tmuxCommand("has-session -t x");
      expect(cmd.startsWith("tmux ")).toBe(true);
      expect(cmd.includes("-L")).toBe(false); // 默认 socket 形态——结构锚禁的正是缺 -L 的命令
      expect(cmd.endsWith("has-session -t x")).toBe(true);
    });
    withEnv(() => { process.env[TMUX_TEST_SOCKET_ENV] = "atf-test-foo"; }, () => {
      expect(tmuxSocketFlag()).toBe("-L atf-test-foo ");
      const cmd = tmuxCommand("has-session -t x");
      expect(cmd).toContain("-L atf-test-foo ");
      expect(cmd.endsWith("has-session -t x")).toBe(true);
    });
  });
  it("env 非 atf-test-* 值一律忽略（生产路径不可被指到业务 socket）", () => {
    for (const evil of ["prod-socket", "../../evil", "atf-test", "atf-test2-ok", ""]) {
      withEnv(() => { process.env[TMUX_TEST_SOCKET_ENV] = evil; }, () => {
        expect(tmuxSocketFlag()).toBe("");
      });
    }
  });
});
