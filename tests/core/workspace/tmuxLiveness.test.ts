/**
 * 批㊶-ISO E1/E2——会话命名域单源行为锚；批㊶-P1 S1——会话基名作用域化锚。
 *
 * resolveSessionName（前缀拼装＋fail-closed）／resolveLaunchSessionName（launch 域不受限）／
 * probeSession／枚举域——含真 tmux 实测：dev- 与 uat- 两前缀互不命中、launch 带前缀真启停、
 * 同实例两 run_id 并发两会话并存互不踩（P1 主体实锚）。全部真 tmux 操作经
 * tests/fixtures/tmuxTestSocket.ts 独立测试 socket（D2①）——默认 socket 零触碰。
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  evalOrchSessionBase,
  listTrainingSessionCmdlines,
  probeSession,
  resolveLaunchSessionName,
  resolveSessionName,
  runScopeSlug,
  sessionDomainRefusal,
  sessionIsScopedFor,
  tmuxCommand,
  tmuxHasSession,
  tmuxSocketFlag,
  tmuxTrainingEvidenceFor,
  tmuxTrainingFamilyPresent,
  TRAINING_BASE_PREFIX,
  EVAL_BASE_PREFIX,
  TMUX_SESSION_PREFIX_ENV,
  TMUX_TEST_SOCKET_ENV,
  trainingSessionBase,
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

describe("批㊶-P1 S1——会话基名作用域化（trainingSessionBase／evalOrchSessionBase／归属判定）", () => {
  it("基名模板锚：两类基名＝模板＋run_id（grep 实锚 `atf-training-run-`／`atf-eval-`）", () => {
    expect(trainingSessionBase("awb_r1")).toBe(`atf-training-run-awb_r1`);
    expect(evalOrchSessionBase("awb_r1")).toBe(`atf-eval-awb_r1`);
    expect(TRAINING_BASE_PREFIX).toBe("atf-training-run-");
    expect(EVAL_BASE_PREFIX).toBe("atf-eval-");
  });

  it("slug 折算锚：tmux 非法字符（./: 等）折 `_`；空串折 default；合法 run_id 原样", () => {
    expect(runScopeSlug("r1")).toBe("r1");
    expect(runScopeSlug("awb_r1")).toBe("awb_r1");
    expect(runScopeSlug("run.7")).toBe("run_7");
    expect(runScopeSlug("a:b")).toBe("a_b");
    expect(runScopeSlug("  r 2 ")).toBe("r_2");
    expect(runScopeSlug("")).toBe("default");
    expect(runScopeSlug("   ")).toBe("default");
    // 折算后基名仍走模板（作用域名不含非法字符——tmux 会话名约束）
    expect(trainingSessionBase("run.7")).toBe("atf-training-run-run_7");
  });

  it("归属判定锚：尾段精确对模板＋slug——`r1` 不误命中 `cr_r1` 的会话；他域会话不命中", () => {
    expect(sessionIsScopedFor("dev-atf-training-run-r1", "r1")).toBe(true);
    expect(sessionIsScopedFor("dev-atf-eval-r1", "r1")).toBe(true);
    expect(sessionIsScopedFor("uat-atf-training-run-r1", "r1")).toBe(true);
    // 子串假阳性抑制（存量 cmdline includes 判据的已知弱点——会话名判据精确化）
    expect(sessionIsScopedFor("dev-atf-training-run-cr_r1", "r1")).toBe(false);
    expect(sessionIsScopedFor("dev-atf-training-run-r11", "r1")).toBe(false);
    // 非作用域会话（旧常量形态/无关会话）一律不命中
    expect(sessionIsScopedFor("dev-atf-training-run", "r1")).toBe(false);
    expect(sessionIsScopedFor("dev-notatf", "r1")).toBe(false);
  });

  it("并发双会话拼装锚：同前缀两 run_id 解析名互异（resolveSessionName 组合逻辑不变）", () => {
    withPrefix("dev-", () => {
      const r1 = resolveSessionName(trainingSessionBase("r1"));
      const r2 = resolveSessionName(trainingSessionBase("r2"));
      expect(r1).toEqual({ ok: true, session: "dev-atf-training-run-r1" });
      expect(r2).toEqual({ ok: true, session: "dev-atf-training-run-r2" });
      // 评估族同法
      expect(resolveSessionName(evalOrchSessionBase("r1"))).toEqual({ ok: true, session: "dev-atf-eval-r1" });
      // 互异（并发互踩根除的名字面前提）
      if (r1.ok && r2.ok) expect(r1.session).not.toBe(r2.session);
    });
  });

  it("命名域拒绝探测锚：sessionDomainRefusal 与 resolveSessionName 同源（前缀未设 refused；前缀在 null）", () => {
    withPrefix(undefined, () => {
      const refused = sessionDomainRefusal();
      expect(refused).not.toBeNull();
      expect(refused?.reason).toContain(TMUX_SESSION_PREFIX_ENV);
      expect(refused?.guidance).toContain("禁止触碰默认 socket 会话");
    });
    withPrefix("dev-", () => {
      expect(sessionDomainRefusal()).toBeNull();
    });
  });
});

describe("批㊶-ISO E1——会话命名域单源（resolveSessionName／resolveLaunchSessionName）", () => {
  it("拼装锚：会话名＝前缀＋作用域基名（dev-/uat- 两前缀各自拼装；fixture 前缀同链路）", () => {
    withPrefix("dev-", () => {
      expect(resolveSessionName(trainingSessionBase("r1"))).toEqual({ ok: true, session: "dev-atf-training-run-r1" });
      expect(resolveSessionName(evalOrchSessionBase("r1"))).toEqual({ ok: true, session: "dev-atf-eval-r1" });
    });
    withPrefix("uat-", () => {
      expect(resolveSessionName(trainingSessionBase("r1"))).toEqual({ ok: true, session: "uat-atf-training-run-r1" });
    });
    // fixture 注入的测试前缀同链路（生产 env 单源——测试即真环境形态）
    const fixturePrefix = process.env[TMUX_SESSION_PREFIX_ENV] ?? "";
    expect(fixturePrefix).toMatch(/^atf-test-.+-$/);
    expect(resolveSessionName(trainingSessionBase("r1"))).toEqual({
      ok: true,
      session: `${fixturePrefix}${trainingSessionBase("r1")}`,
    });
  });

  it("launch 域锚：前缀在则带前缀；未设回退裸 base（启动不受 fail-closed 限制——作用域名同链路）", () => {
    withPrefix("dev-", () => {
      expect(resolveLaunchSessionName(trainingSessionBase("r1"))).toBe("dev-atf-training-run-r1");
    });
    withPrefix(undefined, () => {
      expect(resolveLaunchSessionName(trainingSessionBase("r1"))).toBe(trainingSessionBase("r1"));
      expect(resolveLaunchSessionName(evalOrchSessionBase("r1"))).toBe(evalOrchSessionBase("r1"));
    });
  });

  it("fail-closed 锚：前缀未设 → 解析拒绝（ok:false＋reason＋guidance），kill/枚举/探测全收口", () => {
    withPrefix(undefined, () => {
      const refused = resolveSessionName(trainingSessionBase("r1"));
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.reason).toContain(TMUX_SESSION_PREFIX_ENV);
      expect(refused.guidance).toContain(TMUX_SESSION_PREFIX_ENV);
      expect(refused.guidance).toContain("禁止触碰默认 socket 会话");
      // 探测域：refused 随返回值可见（调用方回流 status 面——guidance 不丢失）
      const probe = probeSession(trainingSessionBase("r1"));
      expect(probe.present).toBe(false);
      expect(probe.refused).not.toBeNull();
      expect(probe.refused?.ok).toBe(false);
      if (probe.refused !== null && !probe.refused.ok) expect(probe.refused.guidance).toContain("禁止触碰默认 socket 会话");
      expect(tmuxHasSession(trainingSessionBase("r1"))).toBe(false);
      // 枚举域：全空（family/枚举/绑 run 取证）
      expect(tmuxTrainingFamilyPresent()).toBe(false);
      expect(listTrainingSessionCmdlines()).toEqual([]);
      expect(tmuxTrainingEvidenceFor("run-iso-e1")).toBe(false);
    });
  });

  it("互斥锚：dev- 与 uat- 两前缀会话互不可见（真 tmux——独立测试 socket）", () => {
    const devSession = `dev-${trainingSessionBase("r1")}`;
    try {
      tmuxTest(`new-session -d -s ${devSession} "sleep 15"`);
      // dev 域：探测命中＋枚举可见（会族判据＝前缀＋atf-，非本域会话不入列）
      tmuxTest(`new-session -d -s dev-notatf "sleep 15"`);
      withPrefix("dev-", () => {
        expect(tmuxHasSession(trainingSessionBase("r1"))).toBe(true);
        expect(probeSession(trainingSessionBase("r1"))).toMatchObject({ present: true, refused: null });
        expect(listTrainingSessionCmdlines().map((e) => e.session)).toContain(devSession);
        expect(listTrainingSessionCmdlines().map((e) => e.session)).not.toContain("dev-notatf");
        expect(tmuxTrainingFamilyPresent()).toBe(true);
        // 批㊶-P1 S1 取证新判据：cmdline（sleep 15）不含 run_id，作用域会话名尾段命中
        expect(tmuxTrainingEvidenceFor("r1")).toBe(true);
      });
      // uat 域：dev 会话完全不可见（探测缺席、枚举为空、family 不命中——kill 失去跨域目标）
      withPrefix("uat-", () => {
        expect(tmuxHasSession(trainingSessionBase("r1"))).toBe(false);
        const probe = probeSession(trainingSessionBase("r1"));
        expect(probe.present).toBe(false);
        expect(probe.refused).toBeNull(); // 前缀已设——非拒绝，是本域确无此会话
        expect(listTrainingSessionCmdlines()).toEqual([]);
        expect(tmuxTrainingFamilyPresent()).toBe(false);
        expect(tmuxTrainingEvidenceFor("r1")).toBe(false);
      });
    } finally {
      tmuxTestOk(`kill-session -t ${devSession}`);
      tmuxTestOk(`kill-session -t dev-notatf`);
    }
  });

  it("launch 带前缀锚：解析名经 tmuxCommand 真启停于测试 socket，探活命中", () => {
    withPrefix("uat-", () => {
      const name = resolveLaunchSessionName(trainingSessionBase("r1"));
      expect(name).toBe(`uat-${trainingSessionBase("r1")}`);
      try {
        execSync(tmuxCommand(`new-session -d -s ${name} "sleep 15"`), { stdio: "ignore" });
        expect(probeSession(trainingSessionBase("r1")).present).toBe(true);
      } finally {
        execSync(tmuxCommand(`kill-session -t ${name} 2>/dev/null`));
      }
      expect(probeSession(trainingSessionBase("r1")).present).toBe(false);
    });
  });
});

describe("批㊶-P1 S1——并发双会话最小链（真 tmux 实锚：两 run_id 并发并存互不踩）", () => {
  it("同实例两 run_id 并发起停：作用域名互异、探测各自命中、kill 其一另一个仍在、绑 run 取证各归各", () => {
    withPrefix("uat-", () => {
      const nameA = resolveLaunchSessionName(trainingSessionBase("p1-runa"));
      const nameB = resolveLaunchSessionName(trainingSessionBase("p1-runb"));
      // 名字面互异（并发前提）
      expect(nameA).not.toBe(nameB);
      try {
        execSync(tmuxCommand(`new-session -d -s ${nameA} "sleep 15"`), { stdio: "ignore" });
        execSync(tmuxCommand(`new-session -d -s ${nameB} "sleep 15"`), { stdio: "ignore" });
        // 并存：两会话各自探测命中（互不踩的 liveness 面）
        expect(probeSession(trainingSessionBase("p1-runa")).present).toBe(true);
        expect(probeSession(trainingSessionBase("p1-runb")).present).toBe(true);
        // 绑 run 取证：会话名判据各归各（cmdline 无 run_id 也命中——作用域名即证据）
        expect(tmuxTrainingEvidenceFor("p1-runa")).toBe(true);
        expect(tmuxTrainingEvidenceFor("p1-runb")).toBe(true);
        expect(tmuxTrainingEvidenceFor("p1-runc")).toBe(false);
        // kill 其一：另一会话原样在场（互不踩的 kill 面——本批事故形态的正面锚）
        execSync(tmuxCommand(`kill-session -t ${nameA} 2>/dev/null`));
        expect(probeSession(trainingSessionBase("p1-runa")).present).toBe(false);
        expect(probeSession(trainingSessionBase("p1-runb")).present).toBe(true);
      } finally {
        try { execSync(tmuxCommand(`kill-session -t ${nameA} 2>/dev/null`)); } catch { /* 用例内已收（幂等收尾） */ }
        try { execSync(tmuxCommand(`kill-session -t ${nameB} 2>/dev/null`)); } catch { /* 已不在 */ }
      }
      expect(probeSession(trainingSessionBase("p1-runa")).present).toBe(false);
      expect(probeSession(trainingSessionBase("p1-runb")).present).toBe(false);
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
