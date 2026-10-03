/**
 * 批⑱M2.75 测试锚——训练执行段三工具投影（atf_run_training/atf_evaluate/atf_analyze_badcases）：
 * 协议适配＋danger_confirm 联动＋mock 执行（DRY_RUN mock train.sh／status 枚举）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunTrainingTool,
  buildEvalTools,
  deriveDeclaredModelName,
  findPrelaunchReport,
  validateFixedCheckpoint,
  extractMasterPort,
  formatPortConflictNote,
  modelLabelLooksDefault,
  parseTrainerLine,
  probePortOccupant,
  renderTaskCardText,
  startLossIngest,
  terminateOccupant,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";

const repoRoot = "/data/sam/ATF-Harness";
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "m2dot75-test-"));
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

/** mock train.sh：DRY_RUN 打印 ADMISSION=pass 后正常退出（校验面 mock）；masterPort>0 时声明端口。 */
const writeMockTrainSh = (root: string, admissionPass = true, masterPort = 39_001): string => {
  const path = join(root, "train.sh");
  const portLine = masterPort > 0 ? `export MASTER_PORT=\${MASTER_PORT:-${masterPort}}\n` : "";
  writeFileSync(path, admissionPass
    ? `#!/bin/bash\n${portLine}echo 'SHA=pass entries=1'\necho 'ADMISSION=pass keys=1'\nexit 0\n`
    : "#!/bin/bash\necho 'admission broken'\nexit 1\n");
  // 段4 起 start 链带 prelaunch 在场检查——缺省夹具默认在场（缺失场景由用例显式删除）
  writeFileSync(join(root, "prelaunch-report.md"), "# 训练前报告\n");
  return path;
};

/** 在本进程内占住一个端口（测试结束由调用方关闭）。 */
const holdPort = (port: number): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => resolve(srv));
  });

describe("atf_run_training（danger 必确认＋DRY_RUN 校验门＋status 枚举）", () => {
  it("start：无审批服务 → 结构化拒绝（danger fail-closed，不启动）", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root);
    const tool = buildRunTrainingTool(noApproval, { runsRoot: root, logDir: root, ctx: noApproval }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result).toMatchObject({ error: "approval_denied", outcome: "unavailable" });
    expect(tmuxAbsent("atf-training-run")).toBe(true);
  });

  it("start：审批放行 + DRY_RUN 失败 → 如实拒启动（校验门），不进 tmux", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, false);
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once") }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result.started).toBe(false);
    expect(String(result.dry_stdout_head)).toContain("admission broken");
  });

  it("start：prelaunch 报告缺失 → prelaunch_report_missing 拒绝（prepare SKILL.md:84 确认制；不进审批不进 tmux）", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, true);
    rmSync(join(root, "prelaunch-report.md"));
    let calls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { calls += 1; return "allowed-once"; } } : undefined) };
    const tool = buildRunTrainingTool(ctx, { runsRoot: root, logDir: root, ctx }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("prelaunch_report_missing");
    expect(String(result.note)).toContain("atf_launch_execute");
    expect(calls).toBe(0);
    expect(tmuxAbsent("atf-training-run")).toBe(true);
  });

  it("start：prelaunch 报告在场（显式路径或 train.sh 同目录 prelaunch*）→ 通过在场检查继续后续链", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, true); // 夹具自带 prelaunch-report.md（在场）
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once") }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result.started).toBe(true); // 在场检查过后走完端口预检＋danger 放行
    expect(await probePortOccupant(39_001)).toBeNull(); // mock 秒退后端口归零
  });

  it("findPrelaunchReport：prelaunch*.md/json 命中，其他文件不命中", () => {
    const root = tempRoot();
    expect(findPrelaunchReport(root)).toBeNull();
    writeFileSync(join(root, "prelaunch-report.md"), "x");
    writeFileSync(join(root, "train.sh"), "x");
    expect(findPrelaunchReport(root)).toContain("prelaunch-report.md");
  });

  it("start：审批放行 + DRY_RUN 过 → tmux 常驻启动＋返回启动凭据（mock 秒退脚本）", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, true);
    const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once") }) as unknown as Tool;
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
    expect(result.started).toBe(true);
    expect(result.tmux).toBe("atf-training-run");
    expect(String(result.note)).toContain("status");
  });

  it("status：ckpt 枚举＋loss 点数（runs/<id>/training 布局）", async () => {
    const root = tempRoot();
    const ckpt = join(root, "r1", "training", "checkpoint-30");
    mkdirSync(ckpt, { recursive: true });
    writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
    const tool = buildRunTrainingTool(noApproval, { runsRoot: root, logDir: root, ctx: noApproval }) as unknown as Tool;
    const result = await tool.execute({ action: "status", train_sh: join(root, "x.sh"), run_id: "r1" }, fakeExec);
    expect(result.ckpts as string[]).toEqual(["checkpoint-30"]);
    expect(String(result.latest_ckpt)).toContain("checkpoint-30");
  });

  it("status：八段任务卡段状态（目录标记推导与监控同步器同源）＋render 渲染 checklist", async () => {
    const root = tempRoot();
    const runDir = join(root, "r-task");
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "registration.json"), "{}");
    writeFileSync(join(runDir, "training", "loss-series.json"), JSON.stringify([{ train_loss: 0.4 }]));
    const tool = buildRunTrainingTool(noApproval, { runsRoot: root, logDir: root, ctx: noApproval }) as unknown as Tool & { output: { render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> } };
    const result = await tool.execute({ action: "status", train_sh: join(root, "x.sh"), run_id: "r-task" }, fakeExec);
    const segments = result.segments as Array<{ key: string; status: string }>;
    expect(segments.find((s) => s.key === "register")?.status).toBe("done");
    // 段语义：loss-series 在场=done（面板口径）；进程态 running 单列
    expect(segments.find((s) => s.key === "training")?.status).toBe("done");
    const blocks = tool.output.render({}, result);
    const text = blocks[0]?.text ?? "";
    expect(text).toContain("训练任务卡 — run r-task");
    expect(text).toContain("✓ 数据登记");
    expect(text).toContain("进度 2/8");
    expect(text).toMatch(/运行中|未运行/); // tmux 在场与否二态均如实
    expect(text).toContain("loss 点数：1");
    // start 结果不走任务卡（保持 JSON 卡面）
    const startBlocks = tool.output.render({}, { started: true, tmux: "atf-training-run" });
    expect(startBlocks[0]?.text).toContain('"started"');
  });
});

describe("任务卡卡面（renderTaskCardText——liveness 覆盖语义）", () => {
  const base = { action: "status", run_id: "r1", loss_points: 3, segments: [
    { key: "register", label: "数据登记", status: "done" as const },
    { key: "training", label: "训练执行", status: "done" as const },
    { key: "evaluate", label: "评估与可视化", status: "pending" as const },
  ] };
  it("running=true：训练段提升 active（tmux 探测为进程态权威）", () => {
    const text = renderTaskCardText({ ...base, running: true });
    expect(text).toContain("● 训练执行");
    expect(text).toContain("运行中（tmux atf-training-run）");
    expect(text).toContain("进度 1/3");
  });
  it("running=false：训练段按段语义 done（loss-series 在场）", () => {
    const text = renderTaskCardText({ ...base, running: false });
    expect(text).toContain("✓ 训练执行");
    expect(text).toContain("未运行");
  });
  it("非 status/无段状态 → null（调用方保持 JSON 卡面）", () => {
    expect(renderTaskCardText({ action: "start" })).toBeNull();
    expect(renderTaskCardText({ action: "status" })).toBeNull();
  });
});

describe("atf_evaluate（批㉕B 段3 正道链——机器事实 fail-closed＋EVAL_RELEASE 确认卡）", () => {
  type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };
  const evalOf = (runsRoot: string, kernelDir: string, ctx: { get: (s: string) => unknown }): Tool =>
    (buildEvalTools(ctx, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_evaluate") as Tool);

  /** mock pin：generate_eval_service 可控失败（exit 2＋block JSON）或成功（写 manifest）；prelaunch 写报告；其余写最小产物。 */
  const writeMockPin = (pin: string, opts: { machineFactsFail?: boolean; labelLeak?: boolean } = {}) => {
    const dir = join(pin, "skills", "atf-evaluate-checkpoints", "scripts");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(pin, "skills", "atf-admit-training-data", "scripts"), { recursive: true });
    writeFileSync(join(pin, "skills", "atf-admit-training-data", "scripts", "render_prompt.py"), "# renderer\n");
    const models = opts.labelLeak
      ? ["gpt-4o", "gpt-4o-lora"]
      : ["test-awq-base", "run-regress-formal-02_ckpt141"];
    const gen = join(dir, "generate_eval_service.py");
    writeFileSync(gen, `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if "--record-eval-release" in args:
    print(json.dumps({"recorded": True})); sys.exit(0)
out = args[args.index("--out") + 1]
${opts.machineFactsFail
      ? `os.makedirs(out, exist_ok=True)
open(os.path.join(out, "machine-facts-block.json"), "w").write(json.dumps({"schema_version": "MissingFactsBlock/v1", "block": "machine_facts_missing", "missing": ["paths.awq_base"], "how_to_provide": {}, "rule": "机器事实不设默认值"}))
sys.stderr.write("machine_fact_missing:paths.awq_base\\n"); sys.exit(2)`
      : `os.makedirs(out, exist_ok=True)
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({"expected_model_names": ${JSON.stringify(models)}, "config_sha256": "a" * 64, "request_defaults": {"port": 5021, "temperature": 0}}))
print(json.dumps({"out": out}))`}`);
    writeFileSync(join(dir, "run_formal_eval.py"), "# runner mock（编排件引用存在性）\n");
    writeFileSync(join(dir, "generate_eval_orchestration.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "eval_orchestration.sh"), "w").write("#!/bin/bash\\necho '[mock] no-op orchestration'\\nexit 0\\n")
print("{}")`);
    writeFileSync(join(dir, "generate_checkpoint_plan.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "ckpt_plan.json"), "w").write("{}")
print("{}")`);
    writeFileSync(join(dir, "build_service_prelaunch_report.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
open(out, "w").write("# 九必报项\\n- GPU 现状\\n- 端口(环境档案层)\\n")
print("{}")`);
    // ckpt-plan 与 orchestration 的 --out 语义：ckpt-plan 产 ckpt_plan.json＋stage_checkpoints.sh；orch 产 eval_orchestration.sh（零 effect 假件）
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
open(os.path.join(out, "eval_orchestration.sh"), "w").write("#!/bin/bash\\necho '[dry-smoke] no-op orchestration'\\nexit 0\\n")
print("{}")`);
  };
  const writeFixtureInputs = (root: string) => {
    const assets = join(root, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "eval_labels.jsonl"), "{}\n");
    writeFileSync(join(assets, "test_images.json"), "{}");
    const serviceConfig = join(root, "EvalServiceConfig.v1.json");
    writeFileSync(serviceConfig, JSON.stringify({ schema_version: "EvalServiceConfig/v1", run_id: "run-regress-formal-02", port: 5021 }));
    const ckpt = join(root, "training", "checkpoint-141");
    mkdirSync(ckpt, { recursive: true });
    writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
    return { assets, serviceConfig, ckpt };
  };
  const startArgs = (root: string, f: { assets: string; serviceConfig: string; ckpt: string }, pin: string) => ({
    action: "start", run_id: "run-regress-formal-02", adapter_path: f.ckpt,
    eval_assets_dir: f.assets, field_config: join(root, "field-config.json"),
    service_config: f.serviceConfig, env_profile: "a800-local", deploy: join(root, "deploy.local.yaml"),
  });

  it("start：pin 脚本缺失 → skill_script_missing（不进审批）", async () => {
    const root = tempRoot();
    let calls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { calls += 1; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, tempRoot(), ctx).execute(startArgs(root, writeFixtureInputs(root), root), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("skill_script_missing");
    expect(calls).toBe(0);
  });

  it("adapter 固定编号校验：latest/无编号/符号链接/缺目录各拒；checkpoint-<数字> 过", async () => {
    expect(validateFixedCheckpoint("/x/latest")).toMatchObject({ ok: false });
    expect(validateFixedCheckpoint("/x/checkpoint-abc")).toMatchObject({ ok: false });
    expect(validateFixedCheckpoint("/x/does-not-exist/checkpoint-9")).toMatchObject({ ok: false });
    const root = tempRoot();
    const real = join(root, "checkpoint-141");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "adapter_model.safetensors"), "x");
    expect(validateFixedCheckpoint(real)).toEqual({ ok: true });
    const link = join(root, "checkpoint-7");
    symlinkSync(real, link);
    expect(validateFixedCheckpoint(link)).toMatchObject({ ok: false, reason: "checkpoint_symlink_forbidden" });
  });

  it("start：机器事实缺失（脚本 exit 2＋MissingFactsBlock）→ 结构化报缺＋指路，不进审批不启动", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, { machineFactsFail: true });
    const f = writeFixtureInputs(root);
    let calls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { calls += 1; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(startArgs(root, f, pin), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("machine_facts_missing");
    const block = result.missing_facts_block as Record<string, unknown>;
    expect(block.missing).toEqual(["paths.awq_base"]);
    expect(String(block.rule)).toContain("不设默认值");
    expect(calls).toBe(0);
  });

  it("start：manifest 期望模型名含 gpt-*/claude-* → serving_model_label_default_leak 拒收", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin, { labelLeak: true });
    const f = writeFixtureInputs(root);
    const result = await evalOf(root, pin, noApproval).execute(startArgs(root, f, pin), fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("serving_model_label_default_leak");
  });

  it("start 全链（mock pin）：确认报告上卡→放行→账本登记→ckpt 计划→编排件→tmux 后台（runner/坐标经 $@ 透传）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = writeFixtureInputs(root);
    const seen: string[] = [];
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { seen.push(req.reason); return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(startArgs(root, f, pin), fakeExec);
    expect(result.started).toBe(true);
    expect(result.tmux).toBe("atf-eval-orch");
    expect(String(result.eval_round)).toMatch(/1-\d{8}$/); // 首轮
    expect(String(result.release)).toContain("eval-release");
    // 确认卡带九必报项报告内容
    expect(seen[0]).toContain("九必报项");
    try { execSync("tmux kill-session -t atf-eval-orch 2>/dev/null"); } catch { /* 清理 */ }
  });

  it("status：轮目录布局下 receipt/state/四件套/model 与 manifest 对拍", async () => {
    const root = tempRoot();
    const round = join(root, "run-e2e", "eval", "1-20261003");
    const orchEval = join(round, "orch", "eval");
    mkdirSync(orchEval, { recursive: true });
    mkdirSync(join(round, "service", "service"), { recursive: true });
    writeFileSync(join(round, "service", "service", "service_receipt.json"), JSON.stringify({ status: "ready", models: ["m1"] }));
    writeFileSync(join(round, "service", "service_manifest.json"), JSON.stringify({ expected_model_names: ["base", "run-e2e_ckpt141"] }));
    writeFileSync(join(orchEval, "state.json"), JSON.stringify({ state: "eval_complete" }));
    for (const f of ["raw_predictions.jsonl", "metrics_summary.json", "badcases.jsonl", "indexes.csv"]) writeFileSync(join(orchEval, f), "{}\n");
    writeFileSync(join(orchEval, "metrics_summary.json"), JSON.stringify({ model: "run-e2e_ckpt141", micro: { f1: 0.26 } }));
    const tools = buildEvalTools(noApproval, { runsRoot: root, logDir: root, kernelDir: root });
    const evaluate = (tools as Tool[]).find((t) => t.name === "atf_evaluate") as Tool;
    const result = await evaluate.execute({ action: "status", run_id: "run-e2e", adapter_path: "x", eval_assets_dir: root, field_config: "x", service_config: "x", env_profile: "x" }, fakeExec);
    expect(result.eval_round).toBe(join(round));
    expect(result.files as string[]).toHaveLength(4);
    expect(result.model_matches_manifest).toBe(true);
    const orchestration = result.orchestration as Record<string, unknown>;
    expect(orchestration.state).toBe("eval_complete");
    const service = result.service as Record<string, unknown>;
    expect(service.status).toBe("ready");
  });
});

describe("atf_analyze_badcases（批㉕B 段1 两步链——冻结账本→一键链，pin 单源）", () => {
  /** 造 mock pin 脚本；recordArgv 给出时两脚本把各自 argv 追加进该文件（调用面断言用）。 */
  const writeMockPinScripts = (pinRoot: string, opts: { freezeFail?: boolean; chainFail?: boolean; recordArgv?: string } = {}) => {
    const record = opts.recordArgv
      ? `import json as _json, sys as _sys\nopen(${JSON.stringify(opts.recordArgv)}, "a").write(_json.dumps(_sys.argv[1:]) + "\\n")\n`
      : "";
    const freezeScript = join(pinRoot, "skills", "atf-evaluate-checkpoints", "scripts", "build_raw_badcase_input.py");
    const chainScript = join(pinRoot, "skills", "atf-analyze-badcases", "scripts", "run_analysis_chain.py");
    mkdirSync(join(pinRoot, "skills", "atf-evaluate-checkpoints", "scripts"), { recursive: true });
    mkdirSync(join(pinRoot, "skills", "atf-analyze-badcases", "scripts"), { recursive: true });
    writeFileSync(freezeScript, `#!/usr/bin/env python3
${record}import json, os, sys
args = sys.argv[1:]
out_dir = args[args.index("--out-dir") + 1]
${opts.freezeFail
      ? `sys.stderr.write('freeze broken\\n'); sys.exit(2)`
      : `os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, "raw-badcase-analysis.v1.json"), "w").write("{}")
print(json.dumps({"argv": args}))`}`);
    writeFileSync(chainScript, `#!/usr/bin/env python3
${record}import json, os, sys
args = sys.argv[1:]
${opts.chainFail
      ? `sys.stderr.write('chain broken\\n'); sys.exit(3)`
      : `out_dir = args[args.index("--output-dir") + 1]
os.makedirs(os.path.join(out_dir, "viewer"), exist_ok=True)
os.makedirs(os.path.join(out_dir, "report"), exist_ok=True)
open(os.path.join(out_dir, "viewer", "viewer.html"), "w").write("<html></html>")
open(os.path.join(out_dir, "report", "report.md"), "w").write("# report")
print(json.dumps({"argv": args}))`}`);
    return { freezeScript, chainScript };
  };
  /** 造评估四件套＋L1 eval 资产（images 布局＝assets 上级 images/，m12 同款）。 */
  const writeEvalFixtures = (root: string): { evalDir: string; assets: string } => {
    const evalDir = join(root, "r1", "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "badcases.jsonl"), "{}\n");
    writeFileSync(join(evalDir, "raw_predictions.jsonl"), "{}\n");
    const assets = join(root, "l1", "eval");
    mkdirSync(join(root, "l1", "images"), { recursive: true });
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(root, "l1", "images", "p1.png"), "png");
    writeFileSync(join(assets, "eval_labels.jsonl"), JSON.stringify({ page_id: "p1", image: "images/p1.png" }) + "\n");
    return { evalDir, assets };
  };
  const analyzeOf = (runsRoot: string, kernelDir: string): Tool =>
    (buildEvalTools(noApproval, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_analyze_badcases") as Tool);

  it("两步链：冻结账本落 analysis/ledger/，一键链收 --raw-mainline，产物路径对齐 <out>/viewer＋<out>/report", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPinScripts(pin);
    const { assets } = writeEvalFixtures(root);
    const result = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(result.ok).toBe(true);
    expect(String(result.ledger)).toContain(join("analysis", "ledger", "raw-badcase-analysis.v1.json"));
    expect(result.viewer_ready).toBe(true);
    expect(String(result.viewer_html)).toContain(join("analysis", "viewer", "viewer.html"));
    expect(result.report_ready).toBe(true);
    expect(String(result.report_md)).toContain(join("analysis", "report", "report.md"));
  });

  it("链调用参数：--raw-mainline 指向冻结产物＋--labels/--images-dir 显式传（无 l1/ 的 run 可跑）", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    const argvLog = join(pin, "chain-argv.jsonl");
    writeMockPinScripts(pin, { recordArgv: argvLog });
    const { assets } = writeEvalFixtures(root);
    await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets, coordinate_space: "qwen_axis_1000", gt_coordinate_space: "qwen_axis_1000" }, fakeExec);
    const calls = (readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]));
    expect(calls).toHaveLength(2); // freeze＋chain 各一次
    const chainArgs = calls[1] as string[];
    const rawIdx = chainArgs.indexOf("--raw-mainline");
    expect(rawIdx).toBeGreaterThan(-1);
    expect(chainArgs[rawIdx + 1]).toContain(join("analysis", "ledger", "raw-badcase-analysis.v1.json"));
    const labelsIdx = chainArgs.indexOf("--labels");
    expect(chainArgs[labelsIdx + 1]).toBe(join(assets, "eval_labels.jsonl"));
    // 坐标声明透传（不设缺省——声明了才传，链侧条款 fail-closed 兜底）
    const coordIdx = chainArgs.indexOf("--coordinate-space");
    expect(coordIdx).toBeGreaterThan(-1);
    expect(chainArgs[coordIdx + 1]).toBe("qwen_axis_1000");
    expect(chainArgs[chainArgs.indexOf("--gt-coordinate-space") + 1]).toBe("qwen_axis_1000");
  });

  it("freeze 失败 → 结构化报错不进链；chain 失败 → 报 step=chain 且账本可续查", async () => {
    const root = tempRoot();
    const pinFailFreeze = tempRoot();
    writeMockPinScripts(pinFailFreeze, { freezeFail: true });
    const { assets } = writeEvalFixtures(root);
    const freezeFail = await analyzeOf(root, pinFailFreeze).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(freezeFail).toMatchObject({ ok: false, step: "freeze" });
    expect(String(freezeFail.stderr_tail)).toContain("freeze broken");
    const pinFailChain = tempRoot();
    writeMockPinScripts(pinFailChain, { chainFail: true });
    const chainFail = await analyzeOf(root, pinFailChain).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(chainFail).toMatchObject({ ok: false, step: "chain" });
    expect(String(chainFail.ledger)).toContain("raw-badcase-analysis.v1.json");
  });

  it("pin 脚本缺失／四件套不齐／资产缺失 → 各自结构化报缺（不猜测）", async () => {
    const root = tempRoot();
    const emptyPin = tempRoot();
    const noScript = await analyzeOf(root, emptyPin).execute({ run_id: "r1" }, fakeExec);
    expect(noScript.error).toBe("skill_script_missing");
    const pin = tempRoot();
    writeMockPinScripts(pin);
    const noEval = await analyzeOf(root, pin).execute({ run_id: "r-missing" }, fakeExec);
    expect(noEval.error).toBe("eval_products_missing");
    const { assets } = writeEvalFixtures(root);
    rmSync(join(assets, "eval_labels.jsonl"));
    const noAssets = await analyzeOf(root, pin).execute({ run_id: "r1", eval_assets_dir: assets }, fakeExec);
    expect(noAssets.error).toBe("eval_assets_missing");
  });
});

describe("parseTrainerLine 与 loss 进料（监控管道协议）", () => {
  it("HF dict 行解析：loss/grad_norm/lr/epoch 提取；非 dict 行 null", () => {
    const p = parseTrainerLine("{'loss': 0.6885, 'grad_norm': 0.371, 'learning_rate': 7.09e-07, 'epoch': 0.04}");
    expect(p).toMatchObject({ train_loss: 0.6885, grad_norm: 0.371 });
    expect(parseTrainerLine("WARNING something")).toBeNull();
  });

  it("startLossIngest：新行追加写 loss-series.json（批⑯协议口径）", async () => {
    const root = tempRoot();
    const log = join(root, "train.log");
    writeFileSync(log, "{'loss': 0.5, 'grad_norm': 1.0, 'learning_rate': 1e-4, 'epoch': 0.1}\n");
    const series = join(root, "loss-series.json");
    const stop = startLossIngest(log, series, 200);
    await new Promise((r) => setTimeout(r, 700));
    stop();
    const parsed = JSON.parse(readFileSync(series, "utf8")) as Array<{ train_loss: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.train_loss).toBe(0.5);
  });
});

describe("批⑳dot3 修复 3——训练启动端口预检（撞前知道）", () => {
  it("extractMasterPort：两形态解析＋缺省回退", () => {
    expect(extractMasterPort("export MASTER_PORT=${MASTER_PORT:-29517}")).toBe(29517);
    expect(extractMasterPort("export MASTER_PORT=29765")).toBe(29765);
    expect(extractMasterPort("无端口声明")).toBe(29517);
  });

  it("probePortOccupant：空闲→null；占用→占用者身份（pid＋residueLike=false）", async () => {
    // 空闲端口（避让常用段）
    const free = 39311;
    expect(await probePortOccupant(free)).toBeNull();
    const srv = await holdPort(39312);
    try {
      const occupant = await probePortOccupant(39312);
      expect(occupant).not.toBeNull();
      expect(occupant?.pid).toBeGreaterThan(0);
      expect(occupant?.residueLike).toBe(false); // 本测试进程 cmdline 无训练特征
    } finally {
      srv.close();
    }
  });

  it("formatPortConflictNote：残留态带[确认清理并重试]，非残留态 fail-closed 文案", () => {
    const residue = formatPortConflictNote(29517, { pid: 71790, name: "pt_elastic", cmdline: "/usr/local/bin/torchrun --master_port 29517", residueLike: true });
    expect(residue).toContain("端口 29517 已被进程 71790(");
    expect(residue).toContain("疑似上轮残留");
    expect(residue).toContain("[确认清理并重试] [手动处理]");
    const foreign = formatPortConflictNote(29517, { pid: 42, name: "nginx", cmdline: "nginx: worker", residueLike: false });
    expect(foreign).toContain("非训练进程，不自动清理");
  });

  it("start：端口被非训练进程占用 → fail-closed 结构化拒绝（不进审批、不进 tmux）", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, true, 39313);
    const srv = await holdPort(39313);
    try {
      let approvalCalls = 0;
      const countingCtx = { get: (s: string) => (s === "approval" ? { request: async () => { approvalCalls += 1; return "allowed-once"; } } : undefined) };
      const tool = buildRunTrainingTool(countingCtx, { runsRoot: root, logDir: root, ctx: countingCtx }) as unknown as Tool;
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
      expect(result.error).toBe("port_occupied_non_residue");
      expect(result.port).toBe(39313);
      expect(approvalCalls).toBe(0); // 根因上卡面前不消耗审批
      expect(tmuxAbsent("atf-training-run")).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("start：端口被疑似残留占用 → danger 卡呈现根因 → [确认清理并重试] → 清理后成功启动（全链）", async () => {
    const root = tempRoot();
    const trainSh = writeMockTrainSh(root, true, 39314);
    // 残留态占用者：脚本文件名含 torchrun（cmdline 特征命中 TRAINING_RESIDUE_PATTERN）
    const stubPath = join(root, "torchrun-stub.js");
    writeFileSync(stubPath, "require('net').createServer().listen(39314,'0.0.0.0',()=>console.log('hold'));\nsetInterval(()=>{},1000);\n");
    const { spawn } = await import("node:child_process");
    const stub = spawn(process.execPath, [stubPath], { stdio: "ignore" });
    const stubExited = new Promise((r) => stub.once("exit", r));
    await new Promise((r) => setTimeout(r, 600)); // 等 stub 绑定
    try {
      expect((await probePortOccupant(39314))?.residueLike).toBe(true);
      const tool = buildRunTrainingTool(approvalCtx("allowed-once"), { runsRoot: root, logDir: root, ctx: approvalCtx("allowed-once") }) as unknown as Tool;
      const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: "r1" }, fakeExec);
      expect(result.started).toBe(true);
      await Promise.race([stubExited, new Promise((r) => setTimeout(r, 2000))]);
      expect(stub.exitCode !== null || stub.signalCode !== null).toBe(true); // 占用者已被清理
      await new Promise((r) => setTimeout(r, 500)); // mock 秒退后端口归零
      expect(await probePortOccupant(39314)).toBeNull();
    } finally {
      try { stub.kill("SIGKILL"); } catch { /* 已退 */ }
    }
  });

  it("terminateOccupant：SIGTERM 宽限后真实退出", async () => {
    const { spawn } = await import("node:child_process");
    const sleeper = spawn("sleep", ["30"]);
    const exited = new Promise((r) => sleeper.once("exit", r));
    const killed = await terminateOccupant(sleeper.pid!);
    expect(killed).toBe(true);
    await exited; // 等内核回收（子进程 zombie 窗口内 kill(pid,0) 仍成功）
  });
});

describe("批⑳dot3 修复 2——评估声明名与标签泄漏防线（harness 侧）", () => {
  it("deriveDeclaredModelName：basename＋adapter 后缀（禁 OpenAI 缺省名的源头）", () => {
    expect(deriveDeclaredModelName("/data/LLM_model/Qwen3-VL-32B-Instruct", true)).toBe("Qwen3-VL-32B-Instruct-lora");
    expect(deriveDeclaredModelName("Qwen3-VL-32B-Instruct/", false)).toBe("Qwen3-VL-32B-Instruct");
  });

  it("modelLabelLooksDefault：gpt-/claude- 前缀＝缺省泄漏；声明名放行", () => {
    expect(modelLabelLooksDefault("gpt-3.5-turbo")).toBe(true);
    expect(modelLabelLooksDefault("claude-3-sonnet")).toBe(true);
    expect(modelLabelLooksDefault("Qwen3-VL-32B-Instruct-lora")).toBe(false);
    expect(modelLabelLooksDefault(42)).toBe(false);
  });

  it("atf_evaluate status：轮内 metrics 含缺省标签 → model_label_warning 如实带出（正道链不应出现该形态）", async () => {
    const root = tempRoot();
    const orchEval = join(root, "r1", "eval", "1-20261003", "orch", "eval");
    mkdirSync(orchEval, { recursive: true });
    writeFileSync(join(orchEval, "metrics_summary.json"), JSON.stringify({ model: "gpt-3.5-turbo", pages: 10 }));
    const serviceDir2 = join(root, "r1", "eval", "1-20261003", "service");
    mkdirSync(serviceDir2, { recursive: true });
    writeFileSync(join(serviceDir2, "service_manifest.json"), JSON.stringify({ expected_model_names: ["b", "r1_x"] }));
    const tool = buildEvalTools(noApproval, { runsRoot: root, logDir: root, kernelDir: root }).find((t) => (t as Tool).name === "atf_evaluate") as Tool;
    const result = await tool.execute({ action: "status", run_id: "r1", adapter_path: "x", eval_assets_dir: root, field_config: "x", service_config: "x", env_profile: "x" }, fakeExec);
    expect(String(result["model_label_warning"])).toContain("标签泄漏");
    expect(result["metrics_summary"]).toBeTruthy();
    expect(result["model_matches_manifest"]).toBe(false);
  });
});

function tmuxAbsent(session: string): boolean {
  try {
    // tmux 无该会话时 has-session 非零退出即视为 absent（测试环境 tmux 在位）
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync(`tmux has-session -t ${session} 2>/dev/null`);
    return false;
  } catch {
    return true;
  }
}
