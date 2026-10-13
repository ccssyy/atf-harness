/**
 * 批㊶-ISO-2 S3 测试锚——实例净室重启脚本净化锚。
 *
 * 脚本＝deploy/instances/instance-restart.sh（实例层资产——deploy/instances/ 整目录
 * gitignored 沿 dev.env/uat.env/uat-deploy.sh 同纪律；本机在位即实跑，缺席如实跳过）。
 * 净化锚走 --env-dump 模式（净室 source 链后打印 env——不启动、不触 tmux、不触 dev/uat
 * 现行进程）；密钥 env 经 ATF_INSTANCE_KEY_ENV 注入 fixture（真实密钥零读取零外泄）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
