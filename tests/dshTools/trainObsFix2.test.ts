import { stubEvalRound } from "./evalRoundStub.js";
/**
 * 批㊶-TRAIN-OBS-FIX2 测试锚——WebUI 链 run 域工具成功路径补 atf.bind_run（T1）。
 *
 * 根因实锚（指令 8e56c543 §一）：WebUI 宿主链零 atf.bind_run 调用 → 内核侧会话绑定缺席、
 * binding.json 恒缺 → scoped 卡面池恒空。本文件锚三组语义：
 *  ① BridgeManager.bindRun——runner.ts:391-395 既有调用形态（request("atf.bind_run",{run_id})）
 *     ＋fail-open 沿 appendBinding 既有语义（error response/spawn 失败留痕不抛）；
 *  ② atf_run_training start 成功路径绑定（产生 run）；失败路径/缺省装配不绑；
 *  ③ atf_evaluate start 成功路径绑定（评估接管一并覆盖）；机器事实 fail-closed 不绑。
 * tmux 操作全走 tests/fixtures/tmuxTestSocket.ts 全局 fixture（默认 socket 零触碰）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// D112 训练互斥守卫（语义见 tests/fixtures/trainingLock.ts 头注）
import { guardTrainingLock } from "../fixtures/trainingLock.js";
import { buildEvalTools, buildRunTrainingTool } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { BridgeManager } from "../../packages/extensions/atf-tools/src/bridgeFace.js";
import { evalOrchSessionBase, resolveLaunchSessionName, trainingSessionBase } from "../../src/core/workspace/tmuxLiveness.js";
import { tmuxTestOk } from "../fixtures/tmuxTestSocket.js";

process.env["ATF_GPU_POLL_MS"] = "0";
process.env["ATF_TRAIN_STARTUP_PROBE_MS"] = "3000";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "train-obs-fix2-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const noApproval = { get: () => undefined };
const approvalCtx = (outcome: string) => ({ get: (s: string) => (s === "approval" ? { request: async () => outcome } : undefined) });
const fakeExec = { callId: "t" };
type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const launchName = (runId = "r1"): string => resolveLaunchSessionName(trainingSessionBase(runId));

/** 长驻 mock train.sh（探活 feed_ok 夹具——与 trainingFace.test.ts 同型；对账基线缺席＝skip 形态）。 */
const writeLongRunningTrainSh = (root: string, masterPort = 39_041): string => {
  const path = join(root, "train.sh");
  writeFileSync(path, `#!/bin/bash\nexport MASTER_PORT=\${MASTER_PORT:-${masterPort}}\necho 'SHA=pass entries=1'\necho 'ADMISSION=pass keys=1'\nTRAIN_CMD=( '--learning_rate' '1e-4' '--num_train_epochs' '3' )\nif [ "\${DRY_RUN:-0}" = "1" ]; then exit 0; fi\nsleep 20\n`);
  writeFileSync(join(root, "prelaunch-report.md"), "# 训练前报告\n");
  const modelDir = join(root, "models", "fake-model");
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "config.json"), "{}\n");
  mkdirSync(join(root, "r1", "prep"), { recursive: true });
  writeFileSync(join(root, "r1", "prep", "iteration-config.json"), `${JSON.stringify({ base_model: { path: modelDir } }, null, 1)}\n`);
  return path;
};

/** 绑定闭包 spy（cfg.bindRun 注入形态）。 */
const bindSpy = (): { bindRun: (runId: string) => Promise<void>; calls: string[] } => {
  const calls: string[] = [];
  return { bindRun: async (runId: string) => { calls.push(runId); }, calls };
};

describe("批㊶-TRAIN-OBS-FIX2 T1：BridgeManager.bindRun（runner.ts 形态＋fail-open）", () => {
  const managerWith = (request: (method: string, params: unknown) => Promise<unknown>): BridgeManager => {
    const manager = new BridgeManager(["true"], "/tmp");
    vi.spyOn(manager, "transport").mockResolvedValue({ request } as never);
    return manager;
  };

  it("bind：ok response → request('atf.bind_run',{run_id}) 一跳、不抛", async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const manager = managerWith(async (method, params) => {
      seen.push({ method, params });
      return { ok: true, value: { ok: true, run_id: (params as { run_id: string }).run_id, scope_ref: "s" } };
    });
    await expect(manager.bindRun("run-a")).resolves.toBeUndefined();
    expect(seen).toEqual([{ method: "atf.bind_run", params: { run_id: "run-a" } }]);
  });

  it("fail-open：error response／transport 抛错／空 run_id——留痕不抛、空 id 零 request", async () => {
    const errManager = managerWith(async () => ({ ok: false, error: { code: "unknown_run", message: "run 不存在" } }));
    await expect(errManager.bindRun("ghost")).resolves.toBeUndefined();
    const boomManager = new BridgeManager(["true"], "/tmp");
    vi.spyOn(boomManager, "transport").mockRejectedValue(new Error("atf 桥 spawn 失败（EOF）"));
    await expect(boomManager.bindRun("run-a")).resolves.toBeUndefined();
    const idleManager = managerWith(async () => {
      throw new Error("不应到达——空 run_id 须短路");
    });
    await expect(idleManager.bindRun("")).resolves.toBeUndefined();
  });
});

describe("批㊶-TRAIN-OBS-FIX2 T1：atf_run_training 成功路径绑定", () => {
  beforeEach((ctx) => guardTrainingLock(ctx));
  it("start 成功（探活 feed_ok）→ bindRun 恰一次且 run_id 实参", async () => {
    const root = tempRoot();
    const trainSh = writeLongRunningTrainSh(root);
    const bind = bindSpy();
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once"), bindRun: bind.bindRun }) as unknown as Tool;
    try {
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
      expect(result.started).toBe(true);
      expect(bind.calls).toEqual(["r1"]);
    } finally {
      tmuxTestOk(`kill-session -t ${launchName()}`);
    }
  });

  it("fail-open：bindRun 拒绝 → started:true 不受扰（容错沿 appendBinding 语义，不阻塞主流程）", async () => {
    const root = tempRoot();
    const trainSh = writeLongRunningTrainSh(root, 39_042);
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once"), bindRun: async () => { throw new Error("账本盘满"); } }) as unknown as Tool;
    try {
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
      expect(result.started).toBe(true);
    } finally {
      tmuxTestOk(`kill-session -t ${launchName()}`);
    }
  });

  it("缺省装配（bindRun 缺席）→ 启动成功零绑定调用（测试/无桥形态零回归）", async () => {
    const root = tempRoot();
    const trainSh = writeLongRunningTrainSh(root, 39_043);
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once") }) as unknown as Tool;
    try {
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
      expect(result.started).toBe(true);
    } finally {
      tmuxTestOk(`kill-session -t ${launchName()}`);
    }
  });

  it("启动失败（秒退探活 dead）→ 不绑（绑定只落产生 run 的成功路径）", async () => {
    const root = tempRoot();
    const trainSh = join(root, "train.sh");
    writeFileSync(trainSh, "#!/bin/bash\necho 'SHA=pass entries=1'\necho 'ADMISSION=pass keys=1'\nTRAIN_CMD=( '--learning_rate' '1e-4' '--num_train_epochs' '3' )\nexit 0\n");
    writeFileSync(join(root, "prelaunch-report.md"), "# 训练前报告\n");
    const modelDir = join(root, "models", "fake-model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "config.json"), "{}\n");
    mkdirSync(join(root, "r1", "prep"), { recursive: true });
    writeFileSync(join(root, "r1", "prep", "iteration-config.json"), `${JSON.stringify({ base_model: { path: modelDir } }, null, 1)}\n`);
    const bind = bindSpy();
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once"), bindRun: bind.bindRun }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result.started).toBe(false);
    expect(bind.calls).toEqual([]);
  });

  it("status 查询 → 不触发内核侧绑定（bridge bind 只在 start 产生路径；N-5 harness 侧绑定原样）", async () => {
    const root = tempRoot();
    const bind = bindSpy();
    const tool = buildRunTrainingTool(noApproval, { runsRoot: root, logDir: root, ctx: noApproval, bindRun: bind.bindRun }) as unknown as Tool;
    const result = await tool.execute({ action: "status", train_sh: join(root, "train.sh"), run_id: "r1" }, fakeExec);
    expect(result.action).toBe("status");
    expect(bind.calls).toEqual([]);
  });
});

describe("批㊶-TRAIN-OBS-FIX2 T1：atf_evaluate 成功路径绑定（评估类一并覆盖）", () => {
  beforeEach((ctx) => guardTrainingLock(ctx));
  type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };
  const evalOf = (runsRoot: string, kernelDir: string, ctx: { get: (s: string) => unknown }, bindRun?: (runId: string) => Promise<void>): Tool =>
    (buildEvalTools(ctx, { resolveEvalRound: stubEvalRound, runsRoot, logDir: runsRoot, kernelDir, bindRun }).find((t) => (t as Tool).name === "atf_evaluate") as Tool);

  /** mock pin（与 trainingFace.test.ts 同型瘦身后——全链成功形态）。 */
  const writeMockPin = (pin: string): void => {
    const dir = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(pin, "skills", "atf-admit-training-data", "scripts"), { recursive: true });
    writeFileSync(join(pin, "skills", "atf-admit-training-data", "scripts", "render_prompt.py"), "# renderer\n");
    writeFileSync(join(dir, "generate_eval_service.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if "--record-eval-release" in args:
    print(json.dumps({"recorded": True})); sys.exit(0)
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({"expected_model_names": ["test-awq-base", "run-fix2_ckpt141"], "config_sha256": "a" * 64, "request_defaults": {"port": 5041, "temperature": 0}}))
print(json.dumps({"out": out}))`);
    writeFileSync(join(dir, "run_formal_eval.py"), "# runner mock\n");
    writeFileSync(join(dir, "build_service_prelaunch_report.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
open(args[args.index("--out") + 1], "w").write("# 九必报项\\n")
print("{}")`);
    writeFileSync(join(dir, "generate_checkpoint_plan.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "ckpt_plan.json"), "w").write("{}")
open(os.path.join(out, "stage_checkpoints.sh"), "w").write("#!/bin/bash\\nexit 0\\n")
print("{}")`);
    writeFileSync(join(dir, "generate_eval_orchestration.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "eval_orchestration.sh"), "w").write("#!/bin/bash\\nexit 0\\n")
print("{}")`);
  };
  const writeFixtureInputs = (root: string): { assets: string; serviceConfig: string; ckpt: string } => {
    const assets = join(root, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "eval_labels.jsonl"), "{}\n");
    writeFileSync(join(assets, "test_images.json"), "{}");
    const serviceConfig = join(root, "EvalServiceConfig.v1.json");
    writeFileSync(serviceConfig, JSON.stringify({ schema_version: "EvalServiceConfig/v1", run_id: "run-fix2", port: 5041 }));
    // B1：run 目录须真实在位（显式 run_id 存在性前置——ckpt 入 run 目录即真实布局种子）
    const ckpt = join(root, "run-fix2", "training", "checkpoint-141");
    mkdirSync(ckpt, { recursive: true });
    writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
    // D91：lane 任务事实在位（恰一 lane——evaluate start 链不传 lane 走 task_fact 判定）
    mkdirSync(join(root, "run-fix2", "l1"), { recursive: true });
    writeFileSync(join(root, "run-fix2", "l1", "training-data-manifest.json"), `${JSON.stringify({ schema_version: "TrainingDataArtifact/v1", lanes: { goods: {} } })}\n`);
    // D14：field_config 显式传入路径须真实存在（解析 fail-closed 后缺失即拒）
    writeFileSync(join(root, "field-config.json"), JSON.stringify({
      schema_version: "PromptFieldConfig/v1", document_type: "pl", document_zh: "装箱单",
      fields: [{ field_id: "doc_identifier", group: "doc_identifier", zh: "单据标识", definition: "d", locators: [] }],
      training_excluded_fields: [],
    }));
    return { assets, serviceConfig, ckpt };
  };
  const startArgs = (root: string, f: { assets: string; serviceConfig: string; ckpt: string }) => ({
    action: "start", run_id: "run-fix2", adapter_path: f.ckpt,
    eval_assets_dir: f.assets, field_config: join(root, "field-config.json"),
    service_config: f.serviceConfig, env_profile: "a800-local", deploy: join(root, "deploy.local.yaml"),
    // 批C2 E6：资产绑定通道在位（夹具资产＝run 外路径——owner 级确认走外部显式通道）
    assets_external_confirm: true,
  });

  it("start 全链成功 → bindRun 恰一次且 run_id 实参", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = writeFixtureInputs(root);
    const bind = bindSpy();
    const ctx = approvalCtx("allowed-once");
    const result = await evalOf(root, pin, ctx, bind.bindRun).execute(startArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    expect(bind.calls).toEqual(["run-fix2"]);
    tmuxTestOk(`kill-session -t ${resolveLaunchSessionName(evalOrchSessionBase("run-fix2"))}`);
  });

  it("机器事实 fail-closed（exit 2）→ 不绑（不进确认卡不启动）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    const dir = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(pin, "skills", "atf-admit-training-data", "scripts"), { recursive: true });
    writeFileSync(join(pin, "skills", "atf-admit-training-data", "scripts", "render_prompt.py"), "# renderer\n");
    writeFileSync(join(dir, "generate_eval_service.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "machine-facts-block.json"), "w").write(json.dumps({"schema_version": "MissingFactsBlock/v1", "block": "machine_facts_missing", "missing": ["paths.awq_base"], "how_to_provide": {}, "rule": "机器事实不设默认值"}))
sys.stderr.write("machine_fact_missing:paths.awq_base\\n"); sys.exit(2)`);
    writeFileSync(join(dir, "run_formal_eval.py"), "# runner mock\n");
    for (const script of ["build_service_prelaunch_report.py", "generate_checkpoint_plan.py", "generate_eval_orchestration.py"]) {
      writeFileSync(join(dir, script), "#!/usr/bin/env python3\nprint('{}')\n");
    }
    const f = writeFixtureInputs(root);
    const bind = bindSpy();
    const result = await evalOf(root, pin, approvalCtx("allowed-once"), bind.bindRun).execute(startArgs(root, f), fakeExec);
    expect(result.started).toBe(false);
    expect(bind.calls).toEqual([]);
  });
});
