/**
 * 批D17——评估并发参数测试锚：atf_evaluate 增 concurrency（可选，缺省 1）＋concurrency_reason；
 * 透传三处（generate_eval_service 不需要；prelaunch --concurrency/--concurrency-recommended/
 * --concurrency-reason；generate_eval_orchestration --concurrency——generator 内嵌 runner 调用
 * 与 plan）；容量门 fail-closed（>service_config.max_num_seqs → concurrency_exceeds_capacity，
 * 零轮目录零审批——先于一切产物生成）；卡面「并发」行紧凑投影（并发＝N/M（容量 C）——
 * 行在 prelaunch 报告「参数对账」节，实锚 1-20261019 报告 :32）。
 * mock pin 形态沿 evalInherit.test.ts（真 python3 子进程面；prelaunch 按内核实形条件渲染
 * 并发行＋argv 落盘）；tmux 走全局测试 socket fixture。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvalTools,
  projectConcurrencyMetricLine,
  resolveEvalConcurrency,
  summarizeEvalPrelaunchReport,
} from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { evalOrchSessionBase, resolveLaunchSessionName } from "../../src/core/workspace/tmuxLiveness.js";
import { tmuxTest, tmuxTestOk } from "../fixtures/tmuxTestSocket.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d17-eval-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { callId: "t" };
type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> };

const RUN_ID = "run-d17";

/** mock pin：编排件（"$@" 落盘 argv-capture.txt＋sleep 2 保活）＋prelaunch（argv 落盘
 *  prelaunch-argv.txt；并发行按收参条件渲染——内核 v0.7.21b0 :394-414 实形逐字）。 */
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
open(os.path.join(out, "service_manifest.json"), "w").write(json.dumps({
  "expected_model_names": ["test-awq-base", "${RUN_ID}_ckpt141"], "config_sha256": "a" * 64,
  "argv": ["vllm", "serve", "--tensor-parallel-size", "4"],
  "request_defaults": {"port": 5031, "temperature": 0}}))
print(json.dumps({"out": out}))`);
  writeFileSync(join(dir, "run_formal_eval.py"), "# runner mock\n");
  writeFileSync(join(dir, "generate_checkpoint_plan.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, "ckpt_plan.json"), "w").write("{}")
open(os.path.join(out, "stage_checkpoints.sh"), "w").write("#!/bin/bash\\nexit 0\\n")
print("{}")`);
  writeFileSync(join(dir, "generate_eval_orchestration.py"), `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
os.makedirs(out, exist_ok=True)
cc = args[args.index("--concurrency") + 1] if "--concurrency" in args else "1"
open(os.path.join(out, "eval_orchestration.sh"), "w").write(
  "#!/bin/bash\\n"
  + "printf '%s\\\\n' \\"$@\\" > " + out + "/argv-capture.txt\\n"
  + "runner_invocation=\\"--concurrency " + cc + "\\"\\n"
  + "sleep 2\\nexit 0\\n")
open(os.path.join(out, "eval_plan.json"), "w").write(json.dumps({"schema_version": "EvalOrchestrationPlan/v1", "request_concurrency": int(cc)}))
print("{}")`);
  writeFileSync(join(dir, "build_service_prelaunch_report.py"), `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
out = args[args.index("--out") + 1]
svc_dir = os.path.dirname(out)
open(os.path.join(svc_dir, "prelaunch-argv.txt"), "w").write("\\n".join(args) + "\\n")
conc = args[args.index("--concurrency") + 1] if "--concurrency" in args else "1"
rec = args[args.index("--concurrency-recommended") + 1] if "--concurrency-recommended" in args else None
reason = args[args.index("--concurrency-reason") + 1] if "--concurrency-reason" in args else ""
if rec is not None:
    conc_text = "runner 实际=%s(缺省 1 保守底);agent 推荐=%s(推荐 ≤ 服务容量 ✓);推荐理由:%s" % (conc, rec, reason)
else:
    conc_text = "runner 实际=%s(缺省 1 保守底);✗ 缺 agent 推荐并发与理由(未推荐即 prelaunch 不完备)" % conc
conc_row = "| 并发 | %s | 服务 max_num_seqs=8 |" % conc_text
report = """# 推理服务接入确认报告

- 环境档案:\`b25-eval-a800\` | 接入形态:**编排自起新服务**

## 生效服务参数(反生成自 service_manifest.json,来源列即产物字段,无人工叙述)

| 参数 | 值 | 来源 |
|---|---|---|
| 环境来源 | env-profile:b25-eval-a800 | deploy_effective.source |
| eval_env | \`/data/venv/torch291_vllm016_bnb_qwen3vl\` | deploy_effective.eval_env |
| 绑卡 | \`0,2,3,4\`(可见 4 卡) | deploy_effective.visible_devices |
| 端口/TP/gpu_mem_util | 5031 / 4(实用 4 卡) / 0.85 | argv |
| max_model_len/max_num_seqs/batched_tokens | 12800 / 8 / 8192 | argv |
| adapters | ['${RUN_ID}_ckpt141'] | manifest.adapters |
| request_defaults | {'temperature': 0} | manifest |

## 参数对账

| 参数 | 评估要求 | 生效/实测 | 判定 |
|---|---|---|---|
| temperature | 0(确定性) | 请求侧 request-defaults | ✓ |
__CONC_ROW__
| 端口 | 环境配置层确定 | 5031 | ✓ |
"""
open(out, "w").write(report.replace("__CONC_ROW__", conc_row))
print("{}")`);
};

/** 25 字段 field_config（沿 D14 夹具口径：训练字段 25）。 */
const fieldConfig25 = (): string => `${JSON.stringify({
  schema_version: "PromptFieldConfig/v1", document_type: "pl", document_zh: "装箱单",
  fields: Array.from({ length: 25 }, (_, i) => ({ field_id: `f${String(i + 1).padStart(2, "0")}`, group: `g${String(i + 1).padStart(2, "0")}`, zh: `字段${i + 1}`, definition: "d", locators: [] })),
  training_excluded_fields: [],
}, null, 1)}\n`;

/** run 夹具：service_config 带 max_num_seqs=8（容量门数据源；opts.maxNumSeqs=false 验缺省容忍面）。 */
const seedRun = (root: string, opts: { maxNumSeqs?: boolean } = {}): { assets: string; serviceConfig: string; ckpt: string } => {
  const runDir = join(root, RUN_ID);
  mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
  const fcText = fieldConfig25();
  writeFileSync(join(runDir, "experiment-setup", "field-config.json"), fcText);
  mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
  const sha = createHash("sha256").update(Buffer.from(fcText, "utf8")).digest("hex");
  writeFileSync(join(runDir, "prep", "iteration-config", "iteration-config.json"), `${JSON.stringify({
    run_id: RUN_ID,
    dataset: { modes: [], digest_provenance: { field_config_sha256: sha } },
  }, null, 1)}\n`);
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "eval_labels.jsonl"), `${JSON.stringify({ page_id: "p1", labels: { f01: [{ value: "v" }] } })}\n`);
  writeFileSync(join(assets, "test_images.json"), "{}");
  const serviceConfig = join(root, "EvalServiceConfig.v1.json");
  writeFileSync(serviceConfig, JSON.stringify(opts.maxNumSeqs === false
    ? { schema_version: "EvalServiceConfig/v1", run_id: RUN_ID, port: 5031, tensor_parallel_size: 4 }
    : { schema_version: "EvalServiceConfig/v1", run_id: RUN_ID, port: 5031, tensor_parallel_size: 4, max_num_seqs: 8 }));
  const ckpt = join(runDir, "training", "checkpoint-141");
  mkdirSync(ckpt, { recursive: true });
  writeFileSync(join(ckpt, "adapter_model.safetensors"), "x");
  return { assets, serviceConfig, ckpt };
};

const baseArgs = (root: string, f: { assets: string; serviceConfig: string; ckpt: string }): Record<string, unknown> => ({
  action: "start", run_id: RUN_ID, adapter_path: f.ckpt,
  eval_assets_dir: f.assets, service_config: f.serviceConfig, env_profile: "a800-local", deploy: join(root, "deploy.local.yaml"),
  assets_external_confirm: true,
});

const orchName = (): string => resolveLaunchSessionName(evalOrchSessionBase(RUN_ID));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const waitNonEmpty = async (probe: () => string, timeoutMs = 4_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== "") return value;
    if (Date.now() >= deadline) return "";
    await sleep(100);
  }
};

/** 本轮（最新轮目录）面内文件读取。 */
const latestRoundFile = (root: string, rel: string): string => {
  const evalRoot = join(root, RUN_ID, "eval");
  if (!existsSync(evalRoot)) return "";
  const rounds = readdirSync(evalRoot).sort();
  const latest = rounds[rounds.length - 1];
  if (latest === undefined) return "";
  const p = join(evalRoot, latest, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

const probePrelaunchArgv = (root: string): string => latestRoundFile(root, join("service", "prelaunch-argv.txt"));

describe("批D17——评估并发参数（缺省 1/传 4 透传/超容量拒/卡面并发行）", () => {
  const evalOf = (runsRoot: string, kernelDir: string, ctx: { get: (s: string) => unknown }): Tool =>
    (buildEvalTools(ctx, { runsRoot, logDir: runsRoot, kernelDir }).find((t) => (t as Tool).name === "atf_evaluate") as Tool);

  it("缺省不传 → prelaunch 命令含 --concurrency 1（无 recommended/reason）＋orch 脚本/plan 含 1", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute(baseArgs(root, f), fakeExec);
    expect(result.started).toBe(true);
    expect(result.concurrency).toBe(1);
    const argv = await waitNonEmpty(() => probePrelaunchArgv(root));
    const lines = argv.split("\n");
    expect(lines.filter((l) => l === "--concurrency").length).toBe(1);
    expect(lines[lines.indexOf("--concurrency") + 1]).toBe("1");
    expect(lines).not.toContain("--concurrency-recommended");
    expect(lines).not.toContain("--concurrency-reason");
    // 编排面：generator 产物（脚本 runner 调用＋plan 口径披露）各恰一处 1
    const orchSh = await waitNonEmpty(() => latestRoundFile(root, join("orch", "eval_orchestration.sh")));
    expect((orchSh.match(/--concurrency 1/g) ?? []).length).toBe(1);
    const plan = JSON.parse(latestRoundFile(root, join("orch", "eval_plan.json"))) as Record<string, unknown>;
    expect(plan["request_concurrency"]).toBe(1);
    // 卡面：缺省串行（报告 ✗ 缺推荐形态）→「并发＝1（容量 8）」
    expect(cardText).toContain("并发＝1（容量 8）");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("传 4＋理由 → 两命令含 --concurrency 4；prelaunch 含 recommended/reason；卡面「并发＝4/4（容量 8）」", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let approvalCalls = 0;
    let cardText = "";
    const ctx = { get: (s: string) => (s === "approval" ? { request: async (req: { reason: string }) => { approvalCalls += 1; cardText = req.reason; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute({
      ...baseArgs(root, f), concurrency: 4, concurrency_reason: "服务容量 8；117 页图像；c=1 约 31s/页，取 4 留 KV 余量",
    }, fakeExec);
    expect(result.started).toBe(true);
    expect(result.concurrency).toBe(4);
    expect(result.concurrency_reason).toBe("服务容量 8；117 页图像；c=1 约 31s/页，取 4 留 KV 余量");
    const argv = await waitNonEmpty(() => probePrelaunchArgv(root));
    const lines = argv.split("\n");
    expect(lines[lines.indexOf("--concurrency") + 1]).toBe("4");
    expect(lines[lines.indexOf("--concurrency-recommended") + 1]).toBe("4");
    expect(lines[lines.indexOf("--concurrency-reason") + 1]).toBe("服务容量 8；117 页图像；c=1 约 31s/页，取 4 留 KV 余量");
    // 编排面：脚本 runner 调用 --concurrency 4 恰一处＋plan request_concurrency=4
    const orchSh = await waitNonEmpty(() => latestRoundFile(root, join("orch", "eval_orchestration.sh")));
    expect((orchSh.match(/--concurrency 4/g) ?? []).length).toBe(1);
    const plan = JSON.parse(latestRoundFile(root, join("orch", "eval_plan.json"))) as Record<string, unknown>;
    expect(plan["request_concurrency"]).toBe(4);
    // 卡面：并发行紧凑投影（mock 报告按内核实形渲染「runner 实际=4…agent 推荐=4…」）
    expect(cardText).toContain("并发＝4/4（容量 8）");
    expect(tmuxTestOk(`kill-session -t ${orchName()}`)).toBe(true);
  });

  it("传 9（max_num_seqs=8）→ concurrency_exceeds_capacity＋容量与建议值；零轮目录零审批无 tmux", async () => {
    const root = tempRoot();
    const pin = tempRoot();
    writeMockPin(pin);
    const f = seedRun(root);
    let approvalCalls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { approvalCalls += 1; return "allowed-once"; } } : undefined) };
    const result = await evalOf(root, pin, ctx).execute({ ...baseArgs(root, f), concurrency: 9 }, fakeExec);
    expect(result.started).toBe(false);
    expect(result.error).toBe("concurrency_exceeds_capacity");
    expect(result.concurrency).toBe(9);
    expect(result.max_num_seqs).toBe(8);
    expect(result.suggested_concurrency).toBe(8);
    expect(String(result.note)).toContain("超服务容量");
    expect(approvalCalls).toBe(0);
    expect(existsSync(join(root, RUN_ID, "eval"))).toBe(false); // 零落盘
    tmuxTestOk(`kill-session -t ${orchName()}`); // 前序用例会话残留容忍（本用例自身零启动）
    expect(tmuxTestOk(`has-session -t ${orchName()}`)).toBe(false);
  });

  it("容量门参数面：缺省恒过（配置无 max_num_seqs 不拒——容量未知交 prelaunch，不设第二套校验）；非法值拒", () => {
    expect(resolveEvalConcurrency(JSON.stringify({ port: 5031 }))).toEqual({ ok: true, concurrency: 1 });
    expect(resolveEvalConcurrency(JSON.stringify({ max_num_seqs: 8 }), 4)).toEqual({ ok: true, concurrency: 4 });
    expect(resolveEvalConcurrency(JSON.stringify({ max_num_seqs: 8 }), 8)).toEqual({ ok: true, concurrency: 8 });
    expect(resolveEvalConcurrency("not-json{", 2)).toEqual({ ok: true, concurrency: 2 });
    const zero = resolveEvalConcurrency(JSON.stringify({ max_num_seqs: 8 }), 0);
    expect(zero.ok).toBe(false);
    const frac = resolveEvalConcurrency(JSON.stringify({ max_num_seqs: 8 }), 2.5);
    expect(frac.ok).toBe(false);
    expect((frac as { error: string }).error).toBe("concurrency_invalid");
    const over = resolveEvalConcurrency(JSON.stringify({ max_num_seqs: 8 }), 9);
    expect(over).toEqual({
      ok: false, error: "concurrency_exceeds_capacity", concurrency: 9, max_num_seqs: 8, suggested_concurrency: 8,
      note: "并发 9 超服务容量 max_num_seqs=8——按容量收紧后重推（图像类任务建议从中等并发起步，不要默认拉满）",
    });
  });

  it("卡面并发行投影（纯函数锚）：对账节并发行上卡、其余对账行不上卡；缺推荐/缺容量/解析失败三态", async () => {
    const { summarizeEvalPrelaunchReport: summarize } = await import("../../packages/extensions/atf-tools/src/trainingFace.js");
    const report = [
      "# 推理服务接入确认报告",
      "",
      "## 生效服务参数(反生成自 service_manifest.json)",
      "",
      "| 参数 | 值 | 来源 |",
      "|---|---|---|",
      "| 绑卡 | `0,2,3,4`(可见 4 卡) | deploy_effective.visible_devices |",
      "",
      "## 参数对账",
      "",
      "| 参数 | 评估要求 | 生效/实测 | 判定 |",
      "|---|---|---|---|",
      "| temperature | 0(确定性) | 请求侧 | ✓ |",
      "| 并发 | runner 实际=4(缺省 1 保守底);agent 推荐=4(推荐 ≤ 服务容量 ✓);推荐理由:容量 8 留 KV 余量 | 服务 max_num_seqs=8 |",
      "| 端口 | 环境配置层确定 | 8200 | ✓ |",
      "",
    ].join("\n");
    const s = summarize(report, "run-x");
    expect(s.metrics).toContain("并发＝4/4（容量 8）");
    expect(s.metrics.some((m) => m.startsWith("temperature"))).toBe(false); // 对账节其余行不上卡
    expect(s.metrics.some((m) => m.startsWith("端口＝"))).toBe(false);
    // 缺推荐（串行缺省 ✗ 形态——E6 首轮报告实形）
    expect(projectConcurrencyMetricLine(
      "runner 实际=1(缺省 1 保守底);✗ 缺 agent 推荐并发与理由(未推荐即 prelaunch 不完备)",
      "服务 max_num_seqs=8",
    )).toBe("并发＝1（容量 8）");
    // 缺容量（来源列「实测」）
    expect(projectConcurrencyMetricLine("runner 实际=2(缺省 1 保守底);agent 推荐=2(✗ 超容量)", "服务 max_num_seqs=实测")).toBe("并发＝2/2");
    // 解析失败＝值原样（kernel 文案变动兜底，不丢事实）
    expect(projectConcurrencyMetricLine("完全未知的文案", "服务 max_num_seqs=8")).toBe("并发＝完全未知的文案");
  });
});
