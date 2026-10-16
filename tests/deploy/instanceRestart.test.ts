/**
 * 批㊶-ISO-2 S3 测试锚——实例净室重启脚本净化锚。
 *
 * 脚本＝deploy/instances/{instance-restart.sh,uat-deploy.sh}（实例层运维资产——批㊶-OPSREPO
 * T0 入仓转正 tracked；env 真值文件仍 gitignored，token/密钥真值零入仓）。本机在位即实跑，
 * 缺席如实跳过。净化锚走 --env-dump/--env-cmd 模式（净室命令打印——不启动、不触 dev tmux、
 * 不触远端 atf-uat 现行进程）；密钥 env 经 ATF_INSTANCE_KEY_ENV 注入 fixture（真实密钥零
 * 读取零外泄）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..");
const script = join(repoRoot, "deploy", "instances", "instance-restart.sh");
const scriptReady = existsSync(script);

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 跑净室环境自检：污染 env 注入 → 脚本 --env-dump 打印净室命令 → bash 内 eval 执行 → env 输出。 */
const dumpNetRoomEnv = (instance: "dev" | "uat", keyEnv: string): { status: number; envText: string; cmdOut: string } => {
  const run = spawnSync("bash", ["-lc", `"${script}" --env-dump ${instance}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ATF_INSTANCE_KEY_ENV: keyEnv,
      // 污染注入（门1件 §一.S3 实锚形态：tmux 会话遗留 export）
      ATF_DSH_RUNS_ROOT: "/polluted/legacy-runs",
      ATF_FOO: "polluted-value",
      DSH_HOME: "/polluted/dsh-home",
    },
  });
  const cmd = (run.stdout ?? "").trim();
  if (run.status !== 0 || cmd === "") {
    return { status: run.status ?? -1, envText: "", cmdOut: (run.stderr ?? "") + cmd };
  }
  const inner = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 30_000 });
  return { status: inner.status ?? -1, envText: inner.stdout ?? "", cmdOut: cmd };
};

describe.skipIf(!scriptReady)("批㊶-ISO-2 S3——净室重启脚本净化锚", () => {
  const keyEnv = join(tmpdir(), `iso2-keys-${Date.now()}.env`);
  writeFileSync(keyEnv, "export ISO2_KEY_MARKER=from-key-env\n");
  tempRoots.push(keyEnv);

  it("净化锚（dev）：env -i 净室后 ATF_*/DSH_* 遗留值零穿透；source 链两环在位；PATH 保留", () => {
    const { status, envText } = dumpNetRoomEnv("dev", keyEnv);
    expect(status).toBe(0);
    // 污染值零穿透（净室语义——白名单外全裸）
    expect(envText).not.toContain("/polluted/legacy-runs");
    expect(envText).not.toContain("polluted-value");
    expect(envText).not.toContain("/polluted/dsh-home");
    expect(envText).not.toMatch(/^ATF_FOO=/m);
    // source 链第一环（密钥 env fixture 值随净室在位）
    expect(envText).toContain("ISO2_KEY_MARKER=from-key-env");
    // source 链第二环（实例 env 值在位——dev.env 的账本单源轴）
    expect(envText).toContain("ATF_APPROVAL_LEDGER=");
    // 白名单（PATH 保留——node/python3 可用面）
    expect(envText).toMatch(/^PATH=\S+/m);
  });

  it("--env-cmd：dev 净室命令形态自检（env -i 开头＋实例 env＋端口＋vendor canonical 命令）", () => {
    const dev = spawnSync("bash", ["-lc", `"${script}" --env-cmd dev`], { encoding: "utf8", env: { ...process.env, ATF_INSTANCE_KEY_ENV: keyEnv } });
    expect(dev.status).toBe(0);
    const devCmd = (dev.stdout ?? "").trim();
    expect(devCmd.startsWith("env -i ")).toBe(true);
    expect(devCmd).toContain("deploy/instances/dev.env");
    expect(devCmd).toContain("--port 3080");
    expect(devCmd).toContain("corepack pnpm dsh web --no-open");
  });

  it("--env-cmd uat（批㊶-OPSREPO T1）：SSH 通道命令形态（atf-uat 容器·非交互 env·nohup＋pid 文件）", () => {
    const uat = spawnSync("bash", ["-lc", `"${script}" --env-cmd uat`], { encoding: "utf8", env: { ...process.env, ATF_INSTANCE_KEY_ENV: keyEnv } });
    expect(uat.status).toBe(0);
    const uatCmd = (uat.stdout ?? "").trim();
    expect(uatCmd.startsWith("ssh ")).toBe(true);
    expect(uatCmd).toContain("root@172.18.0.20");
    expect(uatCmd).toContain("id_ed25519_a800_uat");
    expect(uatCmd).toContain("deploy/instances/uat.env");
    expect(uatCmd).toContain("--port 3081");
    expect(uatCmd).toContain("CI=true npm_config_verify_deps_before_run=false corepack pnpm dsh web");
    expect(uatCmd).toContain("setsid nohup");
    expect(uatCmd).toContain("--trusted-host 124.220.53.207");
  });

  it("fail-closed：密钥 env 缺席 → 非零退出（net-room source 链第一环不可缺）", () => {
    const run = spawnSync("bash", ["-lc", `"${script}" --env-cmd dev`], {
      encoding: "utf8",
      env: { ...process.env, ATF_INSTANCE_KEY_ENV: "/nonexistent/iso2-keys.env" },
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr ?? "").toContain("密钥 env 不存在");
  });
});

describe.skipIf(scriptReady)("批㊶-ISO-2 S3——脚本缺席（非本机实例层）如实跳过", () => {
  it("instance-restart.sh 不在位——净化锚需要实例层脚本，本机跳过", () => {
    expect(existsSync(script)).toBe(false);
  });
});

// 批㊶-OPSREPO（2026-10-16）——两运维脚本入仓转正＋发版目标改指 atf-uat 容器。
// 本组锚定脚本行为面（bash -n＋源面结构）；真实发版只在 owner 书面授权序列内执行。
const uatDeployScript = join(repoRoot, "deploy", "instances", "uat-deploy.sh");

describe.skipIf(!existsSync(uatDeployScript))("批㊶-OPSREPO——uat-deploy.sh atf-uat 容器形态锚", () => {
  it("bash -n 语法过（两运维脚本）", () => {
    for (const s of [uatDeployScript, script]) {
      const run = spawnSync("bash", ["-n", s], { encoding: "utf8" });
      expect(run.status).toBe(0);
    }
  });

  it("T1 执行位置锚：SSH 专用 key＋容器目标＋容器内密钥 env；dev 容器 3080/3081 零触碰（红线）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain('SSH_KEY="/root/.ssh/id_ed25519_a800_uat"');
    expect(src).toContain('SSH_TARGET="root@172.18.0.20"');
    expect(src).toContain('UAT_REMOTE_KEY_ENV="/root/.atf-harness/.env"');
    expect(src).toContain('UAT_REPO="/data/sam/ATF-Harness-uat"');
    expect(src.match(/--port\s+3080/)).toBeNull();
    expect(src.match(/tmux has-session/)).toBeNull();
    expect(src.match(/tmux new-session/)).toBeNull();
    expect(src.match(/tmux send-keys/)).toBeNull();
  });

  it("T1.2 依赖引导段（容器内）：CI frozen-lockfile install→bin 链/dist 校验→缺失补 build（引导不计入 60s boot 窗口）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("CI=true corepack pnpm install --frozen-lockfile");
    expect(src).toContain("apps/web/dist/index.html");
    expect(src).toContain("corepack pnpm build");
  });

  it("boot 形态锚：setsid nohup env 非交互 canonical 串＋pid 文件回写；canonical boot 单源（回滚复用同函数）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("setsid nohup env CI=true npm_config_verify_deps_before_run=false corepack pnpm dsh web --no-open --port ${UAT_PORT} --trusted-host ${UAT_PUBLIC_HOST}");
    expect(src).toContain("echo \\$! > '${UAT_PID}'");
    expect(src.match(/setsid nohup env CI=true/g)?.length).toBe(1);
  });

  it("T2.2 真 token 探针：日志提取 token→/?token= 303/200 硬门（401/404/000 不算通）＋裸 /＝401 auth 门", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("token=[A-Za-z0-9_-]*");
    expect(src).toContain("/?token=${TOK}");
    expect(src).toContain('[[ "$V4_TOKPROBE" == "303" || "$V4_TOKPROBE" == "200" ]]');
    expect(src).toContain("401/404/000 不算通");
    expect(src).toContain('[[ "$V4_BARE" == "401" ]]');
  });

  it("T2.1 轮换口径锚：无固定 token 绑定点登记（DSH_WEB_LAUNCH_TOKEN 作废）＋boot 完成打印完整公网 URL", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("DSH_WEB_LAUNCH_TOKEN");
    expect(src).toContain("每次 boot 轮换");
    expect(src).toContain("/?token=${NEW_TOKEN}");
    expect(src).toContain("30 天签名 cookie");
  });

  it("失败自动回滚锚：PREV_SHA 回滚＋回滚重启＋ROLLED BACK 留痕", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("PREV_SHA");
    expect(src).toContain("ROLLED BACK");
  });

  it("T2 已知地雷登记（依赖树跳变/pnpm 交互检查＋submodule worktreeConfig 冲突根因/tmux 形态已废）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("已知地雷");
    expect(src).toContain("extensions.worktreeConfig");
    expect(src).toContain("install-lefthook.mjs");
    expect(src).toContain("tmux 会话形态已废");
  });
});

describe.skipIf(!scriptReady)("批㊶-OPSREPO——instance-restart.sh uat 分支远端化锚", () => {
  it("uat 分支：SSH 通道＋pid 组杀停旧＋setsid nohup boot＋公网 URL 打印；TRUSTED_ARG 保持", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toContain('UAT_SSH_TARGET="root@172.18.0.20"');
    expect(src).toContain('UAT_SSH_KEY="/root/.ssh/id_ed25519_a800_uat"');
    expect(src).toContain("pid 组杀");
    expect(src).toContain("setsid nohup env ${BOOT_ENV_PREFIX}corepack pnpm dsh web");
    expect(src).toContain('TRUSTED_ARG="--trusted-host 124.220.53.207"');
    expect(src).toContain("13081");
  });

  it("dev 分支行为零变更（红线）：tmux fail-closed 与净室重放原样保留", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toContain('echo "[instance-restart] FAIL: tmux 会话不在: $TMUX_SESSION" >&2');
    expect(src).toContain('TMUX_SESSION="atf-dsh"');
    expect(src).toContain("exec ${BOOT_ENV_PREFIX}corepack pnpm dsh web");
    expect(src).toContain('if [[ "$INSTANCE" == "uat" ]]; then');
    expect(src).toContain("npm_config_verify_deps_before_run=false");
  });

  it("批㊶-UATD-b T1 复锚：dev --env-cmd 输出不含 CI=true/npm_config_verify_deps_before_run（行为零变更红线）；uat 输出含两者", () => {
    const envCmd = (instance: "dev" | "uat"): string => {
      const run = spawnSync("bash", ["-lc", `"${script}" --env-cmd ${instance}`], { encoding: "utf8" });
      expect(run.status).toBe(0);
      return run.stdout ?? "";
    };
    const devOut = envCmd("dev");
    expect(devOut).not.toContain("CI=true");
    expect(devOut).not.toContain("npm_config_verify_deps_before_run");
    expect(devOut).toContain("corepack pnpm dsh web");
    const uatOut = envCmd("uat");
    expect(uatOut).toContain("CI=true npm_config_verify_deps_before_run=false corepack pnpm dsh web");
  });
});
