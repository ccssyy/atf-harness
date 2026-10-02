/**
 * 批⑱M2.75 测试锚——训练执行段三工具投影（atf_run_training/atf_evaluate/atf_analyze_badcases）：
 * 协议适配＋danger_confirm 联动＋mock 执行（DRY_RUN mock train.sh／status 枚举）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunTrainingTool,
  buildEvalTools,
  deriveDeclaredModelName,
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

describe("atf_evaluate（确认＋四件套 status）", () => {
  it("start：审批 unavailable → fail-closed 结构化拒绝（同 seam 语义）；放行后 adapter 缺失 → 如实报不启动", async () => {
    const root = tempRoot();
    const denied = buildEvalTools(approvalCtx("unavailable"), { runsRoot: root, logDir: root }).find((t) => (t as Tool).name === "atf_evaluate") as Tool;
    if (denied === undefined) throw new Error("atf_evaluate missing");
    const deniedResult = (await denied.execute({ action: "start", run_id: "r1", eval_assets_dir: root }, fakeExec)) as Record<string, unknown>;
    expect(deniedResult["error"]).toBe("approval_denied");
    expect(deniedResult["outcome"]).toBe("unavailable");
    const allowed = buildEvalTools(approvalCtx("allowed-once"), { runsRoot: root, logDir: root }).find((t) => (t as Tool).name === "atf_evaluate") as Tool;
    const missing = (await allowed.execute({ action: "start", run_id: "r1", adapter_path: join(root, "no-adapter"), eval_assets_dir: root }, fakeExec)) as Record<string, unknown>;
    expect(missing["started"]).toBe(false);
    expect(String(missing["error"])).toContain("no-adapter");
  });

  it("status：四件套文件枚举＋metrics_summary 透出", async () => {
    const root = tempRoot();
    const evalDir = join(root, "r1", "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "raw_predictions.jsonl"), "{}\n");
    writeFileSync(join(evalDir, "metrics_summary.json"), JSON.stringify({ micro: { f1: 0.29 } }));
    const tool = buildEvalTools(noApproval, { runsRoot: root, logDir: root }).find((t) => (t as Tool).name === "atf_evaluate") as Tool;
    const result = await tool.execute({ action: "status", run_id: "r1", eval_assets_dir: root }, fakeExec);
    const files = result.files as string[];
    expect(files.slice().sort()).toEqual(["metrics_summary.json", "raw_predictions.jsonl"]);
    const summary = result.metrics_summary as { micro: { f1: number } };
    expect(summary.micro.f1).toBe(0.29);
  });
});

describe("atf_analyze_badcases（一键链轻量＋manifest 透传）", () => {
  it("缺 eval 产物 → 链如实报失败路径（不静默造数）；viewer 路径返回", async () => {
    const root = tempRoot();
    const tools = buildEvalTools(noApproval, { runsRoot: root, logDir: root });
    const analyze = (tools as Tool[]).find((t) => t.name === "atf_analyze_badcases") as Tool;
    const result = await analyze.execute({ run_id: "r-missing" }, fakeExec);
    expect(result.ok).toBe(false);
    expect(result.viewer_html).toContain("viewer.html");
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

  it("atf_evaluate status：历史 metrics 含缺省标签 → model_label_warning 如实带出", async () => {
    const root = tempRoot();
    const evalDir = join(root, "r1", "eval");
    mkdirSync(evalDir, { recursive: true });
    writeFileSync(join(evalDir, "metrics_summary.json"), JSON.stringify({ model: "gpt-3.5-turbo", pages: 10 }));
    const tool = buildEvalTools(noApproval, { runsRoot: root, logDir: root }).find((t) => (t as Tool).name === "atf_evaluate") as Tool;
    const result = await tool.execute({ action: "status", run_id: "r1", eval_assets_dir: root }, fakeExec);
    expect(String(result["model_label_warning"])).toContain("标签泄漏");
    expect(result["metrics_summary"]).toBeTruthy();
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
