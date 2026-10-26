/**
 * atf_launch_execute run 直调形态（真机回归锚）。
 *
 * 事故形态：启动件由内核落在 `<run>/launch/launch.sh`，而参数面把 `launch_sh` 的语义
 * 锁死在 scratch（`launch_ready.launch_sh`）——浏览器会话里模型拿不到 scratch 路径，
 * 于是判定「没有合法调用方式」，把执行推回 operator。修法＝run 直调（run_id＋
 * workspace_path → 默认 `<run>/launch/launch.sh`）＋缺参错误点名两种合法形态。
 *
 * 本文件只锚 handler 侧（落点解析见 launchRundir.test.ts）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/workspaceTools.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "launch-direct-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 可启动的 launch.sh 桩：写 `<SCRIPT_DIR>/launch/state.json`（handler 读回 state）。 */
const writeStubLaunch = (dirOfLaunchSh: string, trainDir?: string): string => {
  const path = join(dirOfLaunchSh, "launch.sh");
  mkdirSync(dirOfLaunchSh, { recursive: true });
  writeFileSync(path, [
    "#!/usr/bin/env bash",
    ...(trainDir !== undefined ? [`TRAIN_DIR='${trainDir}'`] : []),
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'mkdir -p "$SCRIPT_DIR/launch"',
    'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
    '{"state": "started", "run_token": "stub", "pid": 4321, "log": "stub.log", "launcher_count": 1, "effect_started": true}',
    "EOF",
    "",
  ].join("\n"));
  return path;
};

/** 放行记录桩（handler 以 kernelDir 为根调 skills/atf-prepare-training/scripts/...）。 */
const writeRecordStub = (kernelDir: string): void => {
  const dir = join(kernelDir, "skills", "atf-prepare-training", "scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "generate_train_launch.py"), 'print("recorded: stub")\n');
};

const hostOf = (runDir: string | undefined, kernelDir: string): LocalToolHost => ({
  scratchDir: join(runDir ?? kernelDir, "scratch"),
  ...(runDir !== undefined ? { runDir } : {}),
  kernelDir,
  home: kernelDir,
  baseEnv: {},
});

const launchHandler = WORKSPACE_TOOL_HANDLERS["atf_launch_execute"];
if (launchHandler === undefined) throw new Error("atf_launch_execute handler 未注册");

type Executed = { kind: "executed"; result: Record<string, unknown> };
type Rejected = { kind: "rejected"; reason: string; detail?: Record<string, unknown> };

describe("atf_launch_execute run 直调（launch_sh 省略）", () => {
  it("launch_sh 缺席 → 默认取 <run>/launch/launch.sh（run_default 形态如实回传）", async () => {
    const root = tempRoot();
    const runDir = join(root, "runs", "do-swb-joint-01");
    writeStubLaunch(join(runDir, "launch"));
    mkdirSync(join(runDir, "scratch"), { recursive: true });

    const result = (await launchHandler({ run_id: "do-swb-joint-01", note: "stub" }, hostOf(runDir, root))) as Executed;
    expect(result.kind).toBe("executed");
    expect(result.result["launch_sh"]).toBe("launch/launch.sh");
    expect(result.result["launch_target_form"]).toBe("run_default");
    expect(result.result["state"]).toBe("started");
    // 无 config 即不登记放行——但必须如实标注，不静默当成功
    expect(result.result["release_recorded"]).toBe(false);
    expect(result.result["release_result"]).toBe("skipped_no_config");
    expect(result.result["release_config"]).toBeNull();
  });

  it("config 省略 → 按 run 树 canonical 优先自动探测并登记放行（不靠模型猜 prep 布局）", async () => {
    const root = tempRoot();
    const runDir = join(root, "runs", "direct-cfg");
    writeStubLaunch(join(runDir, "launch"));
    const canonical = join(runDir, "prep", "iteration-config", "iteration-config.json");
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    writeFileSync(canonical, '{"schema":"IterationConfig/v1"}\n');
    // 平铺副本同时在场（陈旧形态）——canonical 必须优先
    writeFileSync(join(runDir, "prep", "iteration-config.json"), '{"schema":"stale"}\n');
    writeRecordStub(root);

    const result = (await launchHandler({ run_id: "direct-cfg" }, hostOf(runDir, root))) as Executed;
    expect(result.kind).toBe("executed");
    expect(result.result["release_recorded"]).toBe(true);
    expect(result.result["release_result"]).toBe("recorded");
    expect(result.result["release_config"]).toBe(canonical);
  });

  it("无 run 目录可回退 → launch_target_unresolved 且点名两种合法形态", async () => {
    const root = tempRoot();
    const result = (await launchHandler({}, hostOf(undefined, root))) as Rejected;
    expect(result.kind).toBe("rejected");
    expect(result.reason).toBe("launch_target_unresolved");
    const message = String((result.detail as Record<string, unknown>)["message"]);
    expect(message).toContain("run 直调");
    expect(message).toContain("launch_ready.launch_sh");
  });

  it("有 run 目录但启动件未产出 → 不静默改道，指路先跑训练准备段", async () => {
    const root = tempRoot();
    const runDir = join(root, "runs", "no-launch");
    mkdirSync(join(runDir, "scratch"), { recursive: true });
    const result = (await launchHandler({ run_id: "no-launch" }, hostOf(runDir, root))) as Rejected;
    expect(result.kind).toBe("rejected");
    expect(result.reason).toBe("launch_target_unresolved");
    const detail = result.detail as Record<string, unknown>;
    expect(String(detail["message"])).toContain("训练准备段");
    expect(detail["run_dir"]).toBe(runDir);
  });

  it("launch_manifest 声明 approval_ledger → 写账显式带该值（三处同源，不各自解析 HOME）", async () => {
    const root = tempRoot();
    const runDir = join(root, "runs", "ledger-src");
    writeStubLaunch(join(runDir, "launch"), runDir);
    mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
    const config = join(runDir, "prep", "iteration-config", "iteration-config.json");
    writeFileSync(config, '{"schema":"IterationConfig/v1"}\n');
    const ledger = join(root, "instance", ".atf", "approval-ledger", "training-release.jsonl");
    writeFileSync(join(runDir, "launch_manifest.json"), JSON.stringify({ approval_ledger: ledger }));
    // 桩脚本回显收到的 argv，供断言
    const argvDump = join(root, "record-argv.json");
    const stubDir = join(root, "skills", "atf-prepare-training", "scripts");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, "generate_train_launch.py"),
      `import json, sys\nopen(${JSON.stringify(argvDump)}, "w").write(json.dumps(sys.argv[1:]))\nprint("recorded: stub")\n`,
    );

    const result = (await launchHandler({ run_id: "ledger-src" }, hostOf(runDir, root))) as Executed;
    expect(result.kind).toBe("executed");
    expect(result.result["release_ledger"]).toBe(ledger);
    const argv = JSON.parse(readFileSync(argvDump, "utf-8")) as string[];
    expect(argv).toContain("--approval-ledger");
    expect(argv[argv.indexOf("--approval-ledger") + 1]).toBe(ledger);
  });
});
