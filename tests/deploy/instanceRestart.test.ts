/**
 * 批㊶-ISO-2 S3 测试锚——实例净室重启脚本净化锚。
 *
 * 脚本＝deploy/instances/instance-restart.sh（实例层资产——deploy/instances/ 整目录
 * gitignored 沿 dev.env/uat.env/uat-deploy.sh 同纪律；本机在位即实跑，缺席如实跳过）。
 * 净化锚走 --env-dump 模式（净室 source 链后打印 env——不启动、不触 tmux、不触 dev/uat
 * 现行进程）；密钥 env 经 ATF_INSTANCE_KEY_ENV 注入 fixture（真实密钥零读取零外泄）。
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

  it("--env-cmd：净室命令形态自检（env -i 开头＋实例 env＋端口＋vendor canonical 命令）", () => {
    const dev = spawnSync("bash", ["-lc", `"${script}" --env-cmd dev`], { encoding: "utf8", env: { ...process.env, ATF_INSTANCE_KEY_ENV: keyEnv } });
    expect(dev.status).toBe(0);
    const devCmd = (dev.stdout ?? "").trim();
    expect(devCmd.startsWith("env -i ")).toBe(true);
    expect(devCmd).toContain("deploy/instances/dev.env");
    expect(devCmd).toContain("--port 3080");
    expect(devCmd).toContain("corepack pnpm dsh web --no-open");
    const uat = spawnSync("bash", ["-lc", `"${script}" --env-cmd uat`], { encoding: "utf8", env: { ...process.env, ATF_INSTANCE_KEY_ENV: keyEnv } });
    expect(uat.status).toBe(0);
    const uatCmd = (uat.stdout ?? "").trim();
    expect(uatCmd).toContain("deploy/instances/uat.env");
    expect(uatCmd).toContain("--port 3081");
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

// 批㊶-UATD（2026-10-16，微批 b0e24bd5）——冷启动修复锚：脚本本体＝实例层资产
// （deploy/instances/ 整目录 gitignored 纪律），本件锚定其行为面（bash -n＋源面结构）。
const uatDeployScript = join(repoRoot, "deploy", "instances", "uat-deploy.sh");

describe.skipIf(!existsSync(uatDeployScript))("批㊶-UATD——uat-deploy.sh 冷启动修复锚", () => {
  it("bash -n 语法过（两运维脚本）", () => {
    for (const s of [uatDeployScript, script]) {
      const run = spawnSync("bash", ["-n", s], { encoding: "utf8" });
      expect(run.status).toBe(0);
    }
  });

  it("T1.1 会话自建：send-keys 前检测 has-session·消亡时 new-session -c UAT_REPO（canonical 启动命令不变）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain('tmux has-session -t "$UAT_TMUX" 2>/dev/null; then');
    expect(src).toContain('tmux new-session -d -s "$UAT_TMUX" -c "$UAT_REPO"');
    expect(src).toContain("批㊶-UATD T1.1：会话自建");
  });

  it("T1.2 依赖引导段：CI frozen-lockfile install→bin 链/dist 校验→缺失补 build（引导不计入 60s boot 窗口）", () => {
    const src = readFileSync(uatDeployScript, "utf8");
    expect(src).toContain("CI=true corepack pnpm install --frozen-lockfile");
    expect(src).toContain("apps/web/dist/index.html");
    expect(src).toContain("corepack pnpm build");
  });
});

describe.skipIf(!scriptReady)("批㊶-UATD-b——boot 命令非交互加固（微批 50b1fed7）", () => {
  it("T1：BOOT_ENV_PREFIX 仅 uat 注入（CI=true npm_config_verify_deps_before_run=false）——dev INNER 字节不变（红线）", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toContain("npm_config_verify_deps_before_run=false");
    expect(src).toContain('if [[ "$INSTANCE" == "uat" ]]; then');
    expect(src).toContain("exec ${BOOT_ENV_PREFIX}corepack pnpm dsh web");
    // --env-cmd 实跑双锚：dev 输出不含 CI=true/npm_config_verify_deps_before_run（行为零
    // 变更红线）；uat 输出含两者（T1 非交互 env 注入）。净室命令形态＝打印整串启动命令。
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
    const src2 = readFileSync(join(repoRoot, "deploy", "instances", "uat-deploy.sh"), "utf8");
    expect(src2.match(/CI=true npm_config_verify_deps_before_run=false corepack pnpm dsh web/g)?.length).toBe(2);
  });

  it("T2：已知地雷三条登记（会话消亡/依赖树跳变/pnpm 交互检查＋submodule worktreeConfig 冲突根因）", () => {
    const src = readFileSync(join(repoRoot, "deploy", "instances", "uat-deploy.sh"), "utf8");
    expect(src).toContain("已知地雷（批㊶-UATD/UATD-b 登记防后人踩）");
    expect(src).toContain("extensions.worktreeConfig");
    expect(src).toContain("install-lefthook.mjs");
  });
});

describe.skipIf(!scriptReady)("批㊶-UATD T2——instance-restart.sh uat 分支会话自建", () => {
  it("uat 条件自建在场；dev 分支行为零变更（缺会话仍 fail-closed）", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toContain("批㊶-UATD T2：uat 分支会话自建");
    expect(src).toContain('[[ "$INSTANCE" == "uat" ]]');
    expect(src).toContain('echo "[instance-restart] FAIL: tmux 会话不在: $TMUX_SESSION" >&2');
  });
});
