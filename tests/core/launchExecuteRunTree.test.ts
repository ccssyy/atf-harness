/**
 * D115——launch_execute 接受 run 树启动件＋launch_ready 台账按 run 刷新（handler 直调级；
 * 指令《ATF_指令_可用性U1_训练评估全链_20261024》H-3）。
 *
 * B7 §5.4「三面断裂」实锚：atf_launch_execute 只认 exec-home scratch 相对路径，run 树内
 * 生成的启动件（<runDir>/launch/launch.sh——walkthrough/生成器正道落点）不被感知，须手工
 * 字节级镜像才能发起。本批收口：三形态解析（绝对＝runDir 树内守卫；相对＝run 树优先→
 * scratch 回落——禁滞留旧条目）＋scratch_exec 就绪检测 run 树优先（source=run_tree）。
 * 存量 scratch 形态零回归（既有批 3 §三 runner 级用例承载，此处不重复）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/index.js";

// 桩内核：--record-training-release stub（写 $HOME 账本，stdout JSON——与批 3 测试同形态）
const makeStubKernel = (): string => {
  const kernelDir = mkdtempSync(join(tmpdir(), "d115-kernel-"));
  const scripts = join(kernelDir, "skills", "atf-prepare-training", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "generate_train_launch.py"), [
    "#!/usr/bin/env python3",
    "import json, os, sys, hashlib",
    "args = sys.argv[1:]",
    "cfg = args[args.index('--config') + 1]",
    "sha = hashlib.sha256(open(cfg, 'rb').read()).hexdigest()",
    "ledger = os.path.join(os.environ.get('HOME', '/tmp'), '.atf-d115-release.jsonl')",
    "os.makedirs(os.path.dirname(ledger), exist_ok=True)",
    "with open(ledger, 'a') as fh:",
    "    fh.write(json.dumps({'subject_sha256': sha, 'decision': 'approved'}) + '\\n')",
    "print(json.dumps({'result': 'recorded', 'subject_sha256': sha}))",
    "",
  ].join("\n"));
  return kernelDir;
};

interface Env {
  runsRoot: string;
  kernelDir: string;
  home: string;
  runDir: string;
  host: LocalToolHost;
}

const tempRoots: string[] = [];
const makeEnv = (withRunDir: boolean): Env => {
  const runsRoot = mkdtempSync(join(tmpdir(), "d115-runs-"));
  tempRoots.push(runsRoot, );
  const kernelDir = makeStubKernel();
  tempRoots.push(kernelDir);
  const home = mkdtempSync(join(tmpdir(), "d115-home-"));
  tempRoots.push(home);
  const runDir = join(runsRoot, "r1");
  const scratchDir = join(runDir, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  const host: LocalToolHost = {
    scratchDir,
    ...(withRunDir ? { runDir } : {}),
    kernelDir,
    home,
    baseEnv: { ATF_SKILLS_AUTO_INSTALL: "0" },
  };
  return { runsRoot, kernelDir, home, runDir, host };
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** run 树 walkthrough 布局夹具：<runDir>/launch/{launch.sh,launch_manifest.json}＋prep config。
 *  launch.sh 写 state.json 收据＋marker 文件（区分执行的是哪个件）。 */
const seedRunTreeLaunch = (env: Env, marker: string): void => {
  const launchDir = join(env.runDir, "launch");
  mkdirSync(launchDir, { recursive: true });
  mkdirSync(join(env.runDir, "prep"), { recursive: true });
  const configAbs = join(env.runDir, "prep", "iteration-config.json");
  writeFileSync(configAbs, JSON.stringify({ schema_version: "IterationConfig/v1", run_id: "r1" }));
  const configSha = createHash("sha256").update(readFileSync(configAbs)).digest("hex");
  writeFileSync(join(launchDir, "launch_manifest.json"), JSON.stringify({ run_id: "r1", iteration_config_sha256: configSha, global_batch: 16, nnodes: 1 }));
  writeFileSync(join(launchDir, "launch.sh"), [
    "#!/usr/bin/env bash",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'mkdir -p "$SCRIPT_DIR/launch"',
    `echo "${marker}" > "$SCRIPT_DIR/executed-marker"`,
    'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
    '{"state": "started", "run_token": "stub", "pid": 4300, "log": "stub.log", "launcher_count": 1, "effect_started": true}',
    "EOF",
    'echo "started pid=4300"',
    "",
  ].join("\n"));
};

type HandlerOutcome = { kind: string; result?: Record<string, unknown>; reason?: string; message?: string };

const runLaunchExecute = async (params: Record<string, unknown>, host: LocalToolHost): Promise<HandlerOutcome> =>
  WORKSPACE_TOOL_HANDLERS["atf_launch_execute"]?.(params, host) as Promise<HandlerOutcome>;

describe("D115：atf_launch_execute 接受 run 树启动件（三形态解析）", () => {
  it("相对形态：launch/launch.sh 解析到 run 树件 → 放行登记＋执行＋state 回填＋run 树收据", { timeout: 30_000 }, async () => {
    const env = makeEnv(true);
    seedRunTreeLaunch(env, "run-tree-marker");
    const outcome = await runLaunchExecute({ launch_sh: "launch/launch.sh", config: "prep/iteration-config.json" }, env.host);
    expect(outcome.kind).toBe("executed");
    expect(outcome.result?.["ok"]).toBe(true);
    expect(outcome.result?.["release_recorded"]).toBe(true);
    expect(outcome.result?.["state"]).toBe("started");
    // 执行的确实是 run 树件（marker＋收据落 run 树 launch/ 内）
    expect(readFileSync(join(env.runDir, "launch", "executed-marker"), "utf8")).toContain("run-tree-marker");
    expect(existsSync(join(env.runDir, "launch", "launch", "state.json"))).toBe(true);
  });

  it("绝对形态：runDir 树内绝对路径放行；执行面产物同相对形态", { timeout: 30_000 }, async () => {
    const env = makeEnv(true);
    seedRunTreeLaunch(env, "abs-form-marker");
    const outcome = await runLaunchExecute(
      { launch_sh: join(env.runDir, "launch", "launch.sh"), config: join(env.runDir, "prep", "iteration-config.json") },
      env.host,
    );
    expect(outcome.kind).toBe("executed");
    expect(outcome.result?.["ok"]).toBe(true);
    expect(readFileSync(join(env.runDir, "launch", "executed-marker"), "utf8")).toContain("abs-form-marker");
  });

  it("越界绝对路径 fail-closed（runDir 外一律拒——执行点守卫不因新形态放宽）", async () => {
    const env = makeEnv(true);
    const evil = mkdtempSync(join(tmpdir(), "d115-evil-"));
    tempRoots.push(evil);
    writeFileSync(join(evil, "launch.sh"), "#!/bin/bash\nexit 0\n");
    const outcome = await runLaunchExecute({ launch_sh: join(evil, "launch.sh") }, env.host);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.reason).toBe("run_tree_escape");
  });

  it("runDir 装配缺席时绝对路径如实拒绝（run_tree_form_disabled——TUI/resume 存量装配语义）", async () => {
    const env = makeEnv(false);
    const outcome = await runLaunchExecute({ launch_sh: join(env.runDir, "launch", "launch.sh") }, env.host);
    expect(outcome.kind).toBe("rejected");
    expect(outcome.reason).toBe("run_tree_form_disabled");
  });

  it("禁滞留：同相对路径 scratch 旧件与 run 树新件并存 → 执行 run 树新件（旧条目不遮蔽）", { timeout: 30_000 }, async () => {
    const env = makeEnv(true);
    seedRunTreeLaunch(env, "new-run-tree");
    // 旧 scratch 条目：同相对路径 launch/launch.sh（B7 滞留形态——旧会话 exec-home scratch 残留）
    const staleDir = join(env.host.scratchDir, "launch");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "launch.sh"), [
      "#!/usr/bin/env bash",
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'mkdir -p "$SCRIPT_DIR/launch"',
      'echo "stale-scratch" > "$SCRIPT_DIR/executed-marker"',
      'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
      '{"state": "started", "run_token": "stale", "pid": 1, "log": "s.log", "launcher_count": 1, "effect_started": true}',
      "EOF",
      "",
    ].join("\n"));
    const outcome = await runLaunchExecute({ launch_sh: "launch/launch.sh" }, env.host);
    expect(outcome.kind).toBe("executed");
    // run 树新件被执行；旧 scratch 件未被触碰
    expect(readFileSync(join(env.runDir, "launch", "executed-marker"), "utf8")).toContain("new-run-tree");
    expect(existsSync(join(staleDir, "executed-marker"))).toBe(false);
  });
});

describe("D115：launch_ready 台账按 run 刷新（scratch_exec 检测 run 树优先）", () => {
  it("run 树件在场 → launch_ready.source=run_tree、launch_sh=launch/launch.sh、config 对拍命中", async () => {
    const env = makeEnv(true);
    seedRunTreeLaunch(env, "detect");
    const outcome = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]?.(
      { argv: ["python3", "-c", "print('ok')"] },
      env.host,
    ) as HandlerOutcome;
    expect(outcome.kind).toBe("executed");
    const ready = outcome.result?.["launch_ready"] as Record<string, unknown> | undefined;
    expect(ready).toBeDefined();
    expect(ready?.["source"]).toBe("run_tree");
    expect(ready?.["launch_sh"]).toBe("launch/launch.sh");
    expect(ready?.["config"]).toBe("prep/iteration-config.json");
    expect(ready?.["run_id"]).toBe("r1");
  });

  it("run 树无件＋scratch 有件 → source=scratch（存量语义零回归）", async () => {
    const env = makeEnv(true);
    // 只在 scratch 放件（既有 exec-home 形态）
    mkdirSync(join(env.host.scratchDir, "out"), { recursive: true });
    writeFileSync(join(env.host.scratchDir, "out", "launch.sh"), "#!/bin/bash\nexit 0\n");
    const outcome = await WORKSPACE_TOOL_HANDLERS["atf_scratch_exec"]?.(
      { argv: ["python3", "-c", "print('ok')"] },
      env.host,
    ) as HandlerOutcome;
    expect(outcome.kind).toBe("executed");
    const ready = outcome.result?.["launch_ready"] as Record<string, unknown> | undefined;
    expect(ready?.["source"]).toBe("scratch");
    expect(ready?.["launch_sh"]).toBe("out/launch.sh");
  });
});
