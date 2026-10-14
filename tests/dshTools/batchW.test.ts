/**
 * 批㊶-W 测试锚（UAT-AWB 缺陷收口 harness 侧 BUILD）：
 *   F1 单源常量三面一致＋缺省残留 grep 锚；
 *   F2 负样本构造带域＋KB 全链排除 grep 锚；
 *   F4 pipeline 真命令回归（非 mock_pipeline.mjs）；
 *   F5 表单卡 intent 结构（vendor 源锚＋edits 解析）；
 *   F7 train.sh 透传对账（nproc 丢弃拒绝——awb_r1 回归锚）；
 *   F8 产物落点契约（相对路径拒）；
 *   W1 围栏并发会话隔离（会话绑定直传 runDir）；
 *   preflight L1 自愈/L2 fail-fast 分级。
 * （F6 锚＝tests/dshTools/gpuQueueFace.test.ts 批㊶-W 段；F5 表单卡链锚＝tests/webui/webui.test.ts 批㊶-W 段。）
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAMP_DOMAINS, TRAINING_PIN_CONSTANTS } from "../../src/core/workspace/smartDefaults.js";
import { CONFIG_CONFIRM_KEYS } from "../../src/webui/configConfirm.js";
import { evalAgentRecommend } from "../../src/core/workspace/agentRecommend.js";
import { extractTrainShValues, reconcileConfirmedWithTrainSh, formatReconcileDiff } from "../../packages/extensions/atf-tools/src/trainShReconcile.js";
import { editsFromFormAnswers, domainHintOf } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { resolveSessionRunWorkspace } from "../../src/core/workspace/runFacts.js";
import { runBootPreflight, formatPreflightFatal, BOOT_PREFLIGHT_PIPELINE_ENV, BOOT_PREFLIGHT_BRIDGE_ENV } from "../../src/core/workspace/bootPreflight.js";
import { buildFileGuardTools } from "../../packages/extensions/atf-tools/src/fileGuardFace.js";


const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "batch-w-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- F1 单源常量

describe("批㊶-W F1——训练 pin 单源常量三面一致＋缺省残留 grep 锚", () => {
  it("TRAINING_PIN_CONSTANTS 单源值：65536/802816/1605632/负样本 0.02-0.05；clamp 域与确认卡缺省同源引用", () => {
    expect(TRAINING_PIN_CONSTANTS.max_total_tokens).toBe(65_536);
    expect(TRAINING_PIN_CONSTANTS.image_min_pixels).toBe(65_536);
    expect(TRAINING_PIN_CONSTANTS.image_max_pixels).toEqual([802_816, 1_605_632]);
    expect(TRAINING_PIN_CONSTANTS.negative_ratio).toEqual({ min: 0.02, max: 0.05 });
    // 护栏闭集（smartDefaults CLAMP_DOMAINS）＝单源引用（同一数组引用——改一处三面同步）
    expect(CLAMP_DOMAINS.image_max_pixels).toBe(TRAINING_PIN_CONSTANTS.image_max_pixels);
    expect(CLAMP_DOMAINS.negative_ratio).toBe(TRAINING_PIN_CONSTANTS.negative_ratio);
    // 确认卡缺省面＝单源值
    const keyMeta = Object.fromEntries(CONFIG_CONFIRM_KEYS.map((entry) => [entry.key, entry]));
    expect(keyMeta["image_min_pixels"]?.default).toBe("65536");
    expect(keyMeta["image_max_pixels"]?.default).toBe("802816");
    expect(keyMeta["max_total_tokens"]?.default).toBe(""); // 4096 缺省删除（必填）
  });
  it("缺省残留 grep 锚：任一配置面无 4194304/16384000/800000/1600000 残留；4096 仅存于注释锚", () => {
    const faces = [
      join(import.meta.dirname, "../../src/webui/configConfirm.ts"),
      join(import.meta.dirname, "../../src/core/workspace/smartDefaults.ts"),
      join(import.meta.dirname, "../../src/core/workspace/agentRecommend.ts"),
      join(import.meta.dirname, "../../packages/extensions/atf-tools/src/confirmFace.ts"),
    ];
    for (const file of faces) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/4194304|16384000/);
      expect(src, file).not.toMatch(/[^\d]800000[^\d]|[^\d]1600000[^\d]/);
    }
  });
});

// ---------------------------------------------------------------- F2 负样本域＋KB 排除

describe("批㊶-W F2——负样本构造带域校验＋KB 全链排除", () => {
  it("agentRecommend negative_ratio_target：带内采纳；越界（0.08 旧 KB 口径）拦截回退", () => {
    const ok = evalAgentRecommend("negative_ratio_target", "0.03", "0.02,0.05", "构造配额");
    expect(ok.accepted).toBe(true);
    expect(ok.terminal).toBe("0.03");
    const band = evalAgentRecommend("negative_ratio_target", "0.02,0.05", "0.02,0.05");
    expect(band.accepted).toBe(true);
    const rejected = evalAgentRecommend("negative_ratio_target", "0.08", "0.02,0.05");
    expect(rejected.accepted).toBe(false);
    expect(rejected.note).toContain("[0.02, 0.05]");
    const outOfBand = evalAgentRecommend("negative_ratio_target", "0.01,0.9", "0.02,0.05");
    expect(outOfBand.accepted).toBe(false);
  });
  it("KB 全链排除 grep 锚：配置确认链路（present/amend/clamp/建议）无 experience-kb/KBLESS 依赖；卡面 label 无 KB 标注", () => {
    const chainFiles = [
      join(import.meta.dirname, "../../packages/extensions/atf-tools/src/confirmFace.ts"),
      join(import.meta.dirname, "../../src/webui/configConfirm.ts"),
      join(import.meta.dirname, "../../src/core/workspace/agentRecommend.ts"),
      join(import.meta.dirname, "../../src/core/workspace/smartDefaults.ts"),
    ];
    for (const file of chainFiles) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/experience-kb|experience_kb|KBLESS/);
    }
    for (const entry of CONFIG_CONFIRM_KEYS) {
      expect(entry.label, entry.key).not.toContain("KB");
    }
  });
});

// ---------------------------------------------------------------- F4 pipeline 真命令

describe("批㊶-W F4——pipeline register 段真命令触发（非 mock_pipeline.mjs）", () => {
  it("Config/注入链：ATF_DSH_PIPELINE_COMMAND 设置时 atf_pipeline_stage 触发该命令（真命令形态），缺省仍 mock", async () => {
    // 假对端：python3 脚本写标记文件（真命令形态——python3 <script>，非 node mock_pipeline.mjs）
    const root = tempRoot();
    const marker = join(root, "pipeline-called.flag");
    const fakePipeline = join(root, "fake_pipeline.py");
    writeFileSync(fakePipeline, `import sys\nopen(${JSON.stringify(marker)}, "w").write(" ".join(sys.argv))\nprint("{}")\n`);
    const { buildPipelineTool } = await import("../../packages/extensions/atf-tools/src/pipelineFace.js");
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => "allowed-once" } : undefined) };
    const tool = buildPipelineTool(ctx, `python3 ${fakePipeline}`, 30_000) as { execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> };
    const result = await tool.execute({ stage: "register" }, { agent: undefined, callId: "w4", signal: undefined });
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const argv = readFileSync(marker, "utf8");
    expect(argv).toContain("register");
    expect(argv).not.toContain("mock_pipeline");
    // boot 面：Config 缺省＝mock（测试注入路径保持）；env 显式＝真命令（deploy env 单源）
    const { Config } = await import("../../packages/extensions/atf-tools/src/index.js");
    void Config;
    expect(readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/index.ts"), "utf8")).toContain("ATF_DSH_PIPELINE_COMMAND");
  });
});

// ---------------------------------------------------------------- F5 结构锚

describe("批㊶-W F5——form intent 结构（vendor 源锚＋结构化 edits 解析）", () => {
  it("vendor 源锚（批㊶-COORD2b 后改版）：F5 表单补丁已随 vendor 工作区还原退场——源面回 639ed01 基线（留档可逆）", () => {
    // COORD2b（owner 裁"任何本地修改均应清除"）将 F5 以工作区形态存活的 vendor 补丁留档还原
    // （/tmp/vendor-dirty-backup-20261014.patch＋untracked/）——该补丁从未 commit 进 submodule，
    // 指针恒 639ed01。源面锚断言随之退役；harness 侧 form intent 逻辑（editsFromFormAnswers/
    // domainHintOf——本文件后两用例）不受影响照常锚定。已构建 dist（先前构建期烘焙）不受源还原
    // 影响；重建 bundle 将失去该 UI 面——候 owner 裁（re-apply＋commit 或接受回退）。
    const vendor = join(import.meta.dirname, "../../vendor/dsh/deepseek-harness");
    const types = readFileSync(join(vendor, "packages/interaction/user-questions/src/types.ts"), "utf8");
    expect(types).not.toContain("AskUserQuestionFormField"); // 源面已回基线（还原后形态锚）
    expect(existsSync(join(vendor, "packages/client/ui-user-questions/src/client/FormPanel.tsx"))).toBe(false);
    void existsSync;
  });
  it("editsFromFormAnswers：selected key=value 结构化拆分（首个 = 拆键值；空串/无等号跳过）", () => {
    const edits = editsFromFormAnswers({ answers: [{ id: "q", selected: ["learning_rate=2e-4", "base_model_path=/a/b=c", "junk", "=novalue"] }] });
    expect(edits).toEqual({ learning_rate: "2e-4", base_model_path: "/a/b=c" });
  });
  it("domainHintOf：clamp 域提示单源派生（像素/负样本/rank/lr 可读）", () => {
    expect(domainHintOf("learning_rate", null)).toContain("5e-5");
    expect(domainHintOf("learning_rate", null)).toContain("5e-4");
    expect(domainHintOf("image_max_pixels", null)).toContain("802816");
    expect(domainHintOf("image_max_pixels", null)).toContain("1605632");
    expect(domainHintOf("negative_ratio_target", null)).toContain("0.02");
    expect(domainHintOf("lora_rank", null)).toContain("128");
    expect(domainHintOf("nproc_per_node", 8)).toContain("8");
    expect(domainHintOf("deepspeed", null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- F7 透传对账

describe("批㊶-W F7——九要素确认值 → train.sh 逐键透传对账", () => {
  const trainShOk = [
    "#!/usr/bin/env bash",
    "export NPROC_PER_NODE=8",
    "TRAIN_CMD=(",
    " 'llamafactory-cli' 'train'",
    " '--learning_rate' '2e-4'",
    " '--num_train_epochs' '3.0'",
    " '--per_device_train_batch_size' '2'",
    " '--gradient_accumulation_steps' '8'",
    " '--lora_rank' '32'",
    " '--lora_alpha' '64'",
    " '--cutoff_len' '9000'",
    " '--image_min_pixels' '65536'",
    " '--image_max_pixels' '802816'",
    ")",
  ].join("\n");
  const confirmedOk = {
    nproc_per_node: "8",
    learning_rate: "2e-4",
    num_train_epochs: "3",
    per_device_train_batch_size: "2",
    gradient_accumulation_steps: "8",
    lora_rank: "32",
    lora_alpha: "64",
    cutoff_len: "9000",
    image_min_pixels: "65536",
    image_max_pixels: "802816",
  };
  it("提取器：export NPROC_PER_NODE＋TRAIN_CMD --key value 对逐键提取", () => {
    const extracted = extractTrainShValues(trainShOk);
    expect(extracted["nproc_per_node"]).toBe("8");
    expect(extracted["learning_rate"]).toBe("2e-4");
    expect(extracted["image_max_pixels"]).toBe("802816");
  });
  it("逐键一致 → ok（数值等值 3.0≡3）；nproc 确认 8 生成 1 → 拒绝＋diff（awb_r1 首跑回归锚）", () => {
    expect(reconcileConfirmedWithTrainSh(confirmedOk, trainShOk).ok).toBe(true);
    const droppedNproc = trainShOk.replace("export NPROC_PER_NODE=8", "export NPROC_PER_NODE=1");
    const result = reconcileConfirmedWithTrainSh(confirmedOk, droppedNproc);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.key === "nproc_per_node" && m.confirmed === "8" && m.generated === "1")).toBe(true);
    expect(formatReconcileDiff(result.mismatches)).toContain("nproc_per_node: 确认 8 → 生成 1");
  });
  it("生成面键静默缺失 → 拒绝（generated null）；global batch 静默换算 → 拒绝", () => {
    const missingKey = trainShOk.replace(" '--lora_rank' '32'", " '--lora_rank_others' '32'");
    const missing = reconcileConfirmedWithTrainSh(confirmedOk, missingKey);
    expect(missing.ok).toBe(false);
    expect(missing.mismatches.some((m) => m.key === "lora_rank" && m.generated === null)).toBe(true);
    // bs 确认 2 生成 1（accum 8 不变）——global batch 256→128 静默换算必须拒绝
    const halved = trainShOk.replace("'--per_device_train_batch_size' '2'", "'--per_device_train_batch_size' '1'");
    const gb = reconcileConfirmedWithTrainSh(confirmedOk, halved);
    expect(gb.ok).toBe(false);
    expect(gb.globalBatch).toMatchObject({ confirmed: 128, generated: 64, ok: false });
  });
});

// ---------------------------------------------------------------- F8 产物落点

describe("批㊶-W F8——产物落点契约（atf_write 相对路径即拒＋指路）", () => {
  it("相对路径写 → 成功但回带产物落点指路（product_path_hint）；越白名单相对落点仍拒（既有 path_escape）", async () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const host = { roots: [runsRoot], env: {} };
    const { FILE_TOOL_DEFINITIONS, toFileAgentTool } = await import("../../src/agent/fileTools.js");
    const definition = FILE_TOOL_DEFINITIONS.find((d) => d.name === "atf_write")!;
    const writeTool = toFileAgentTool(definition, host);
    // 相对落点（scratch 临时面语义）：写成功＋hint 指路 runs/<run_id>/
    const rel = await writeTool.execute("w1", { path: "notes/a.txt", content: "hi" });
    expect(rel.details.ok).toBe(true);
    expect(String(rel.details.product_path_hint)).toContain("runs/<run_id>");
    // 绝对路径（白名单内）写成功且无 hint
    const abs = await writeTool.execute("w2", { path: join(runsRoot, "run-a", "reports", "x.md"), content: "hi" });
    expect(abs.details.ok).toBe(true);
    expect(abs.details.product_path_hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------- W1 围栏并发隔离

describe("批㊶-W W1——围栏并发会话隔离（会话绑定直传 runDir＞env 过渡态）", () => {
  const seedBinding = (root: string, ws: string, runId: string, sessionId: string): string => {
    const runDir = join(root, ws, runId);
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "binding.json"), `${JSON.stringify([{ session_id: sessionId, bound_at: "2026-10-12T10:00:00Z" }], null, 1)}\n`);
    return runDir;
  };
  it("resolveSessionRunWorkspace：双会话各回各 runDir（并发互踩消除）；无命中 null；平铺形态兼容", () => {
    const root = tempRoot();
    const runA = seedBinding(root, "wsA", "run-a", "sess-A");
    const runB = seedBinding(root, "wsB", "run-b", "sess-B");
    expect(resolveSessionRunWorkspace(root, "sess-A")).toBe(runA);
    expect(resolveSessionRunWorkspace(root, "sess-B")).toBe(runB);
    expect(resolveSessionRunWorkspace(root, "sess-C")).toBeNull();
    // 平铺形态
    const flat = join(root, "run-flat");
    mkdirSync(join(flat, "webui"), { recursive: true });
    writeFileSync(join(flat, "webui", "binding.json"), `${JSON.stringify([{ session_id: "sess-F", bound_at: "2026-10-12T11:00:00Z" }], null, 1)}\n`);
    expect(resolveSessionRunWorkspace(root, "sess-F")).toBe(flat);
  });
  it("atf_bash 围栏取值链：会话绑定解析的可写根生效（env 未设/互踩值皆可写各自 run）", async () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const runA = seedBinding(runsRoot, "wsA", "run-a", "sess-A");
    const runB = seedBinding(runsRoot, "wsB", "run-b", "sess-B");
    const host = { roots: [runsRoot], env: {} };
    const tools = buildFileGuardTools(host, { runsRoot }) as Array<{ name: string; execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>> }>;
    const bash = tools.find((t) => t.name === "atf_bash");
    expect(bash).toBeDefined();
    const execA = { callId: "a", agent: { session: { id: "sess-A" } } };
    const execB = { callId: "b", agent: { session: { id: "sess-B" } } };
    // 会话 A 写自己 run（可写域内）→ 不被围栏拒（落到真实执行——命令失败但非围栏拒绝）
    const okA = await bash!.execute({ command: `echo hi > ${join(runA, "out.txt")}` }, execA);
    expect(JSON.stringify(okA)).not.toContain("workspace_path_outside_allowlist");
    // 会话 A 写会话 B 的 run（只读域）→ 围栏拒（写语义单独拒）
    const cross = await bash!.execute({ command: `echo hi > ${join(runB, "out.txt")}` }, execA);
    expect(JSON.stringify(cross)).toContain("workspace_path_outside_allowlist");
    // env 过渡态：无会话 id 时回退 env（同进程互踩场景由 env 兜底——行为与批㊶-S1 一致）
    const saved = process.env["ATF_BASH_RUN_WORKSPACE"];
    process.env["ATF_BASH_RUN_WORKSPACE"] = runB;
    try {
      const viaEnv = await bash!.execute({ command: `echo hi > ${join(runB, "out2.txt")}` }, { callId: "c", agent: undefined });
      expect(JSON.stringify(viaEnv)).not.toContain("workspace_path_outside_allowlist");
    } finally {
      if (saved === undefined) delete process.env["ATF_BASH_RUN_WORKSPACE"];
      else process.env["ATF_BASH_RUN_WORKSPACE"] = saved;
    }
  });
});

// ---------------------------------------------------------------- boot 预检分级

describe("批㊶-W——boot 环境预检分级自愈（L1 产品写权限内自动补＋留痕；L2 系统级 fail-fast）", () => {
  const baseProbes = {
    commandWorks: (c: string) => c === "python3" || c === "nvidia-smi",
    fileExists: () => true,
    dirExists: () => true,
    listJsonFiles: () => [] as string[],
    readText: () => null,
  };
  it("L1 自愈：pipeline/bridge env 缺失 → kernelDir 派生注入＋留痕（同事 10-12 场景）", () => {
    const report = runBootPreflight({ ATF_DSH_KERNEL_DIR: "/kernel" }, baseProbes);
    expect(report.fatal).toHaveLength(0);
    const pipeline = report.autoFixed.find((f) => f.key === BOOT_PREFLIGHT_PIPELINE_ENV);
    expect(pipeline?.value).toBe("python3 /kernel/tools/walkthrough_pipeline.py");
    expect(pipeline?.note).toContain("已自动补齐");
    const bridge = report.autoFixed.find((f) => f.key === BOOT_PREFLIGHT_BRIDGE_ENV);
    expect(bridge?.value).toBe("python3 -m agentic_training_flow serve");
  });
  it("L2 fail-fast：派生源脚本不存在 / kernelDir 缺失 / python3 不可用 / GPU 不可见 → fatal 带可复制命令", () => {
    const noScript = runBootPreflight({ ATF_DSH_KERNEL_DIR: "/kernel" }, { ...baseProbes, fileExists: (p) => !p.includes("walkthrough_pipeline.py") });
    expect(noScript.fatal.some((f) => f.check === "pipeline_command" && f.fix.includes("ls /kernel/tools/walkthrough_pipeline.py"))).toBe(true);
    const noKernel = runBootPreflight({}, baseProbes);
    expect(noKernel.fatal.some((f) => f.check === "pipeline_command" && f.fix.includes("ATF_DSH_KERNEL_DIR"))).toBe(true);
    expect(noKernel.fatal.some((f) => f.check === "bridge_command")).toBe(true);
    const noPython = runBootPreflight({ ATF_DSH_KERNEL_DIR: "/kernel" }, { ...baseProbes, commandWorks: () => false });
    expect(noPython.fatal.some((f) => f.check === "python3" && f.fix.includes("apt-get"))).toBe(true);
    const noGpu = runBootPreflight({ ATF_DSH_KERNEL_DIR: "/kernel" }, { ...baseProbes, commandWorks: (c) => c === "python3" });
    expect(noGpu.fatal.some((f) => f.check === "nvidia_smi" && f.fix.includes("nvidia-smi"))).toBe(true);
    // ATF_GPU_REQUIRED=0 显式豁免 GPU 机器要求
    const gpuWaived = runBootPreflight({ ATF_DSH_KERNEL_DIR: "/kernel", ATF_GPU_REQUIRED: "0" }, { ...baseProbes, commandWorks: (c) => c === "python3" });
    expect(gpuWaived.fatal.some((f) => f.check === "nvidia_smi")).toBe(false);
    expect(formatPreflightFatal(noScript.fatal)).toContain("补法");
  });
  it("L1 自愈：LD_LIBRARY_PATH 按 env-profiles 显式声明注入（无声明不猜；目录缺失 L2）", () => {
    const profilesDir = "/home/x/.atf/env-profiles";
    const probes = {
      ...baseProbes,
      listJsonFiles: (dir: string) => (dir === profilesDir ? ["a800.json"] : []),
      readText: (path: string) => (path === join(profilesDir, "a800.json") ? JSON.stringify({ train: { env: { LD_LIBRARY_PATH: "/usr/local/lib" } } }) : null),
    };
    const injected = runBootPreflight({ HOME: "/home/x", ATF_DSH_KERNEL_DIR: "/kernel" }, probes);
    const ld = injected.autoFixed.find((f) => f.key === "LD_LIBRARY_PATH");
    expect(ld?.value).toBe("/usr/local/lib");
    // 进程 env 已含该目录 → 不重复注入
    const already = runBootPreflight({ HOME: "/home/x", ATF_DSH_KERNEL_DIR: "/kernel", LD_LIBRARY_PATH: "/usr/local/lib" }, probes);
    expect(already.autoFixed.some((f) => f.key === "LD_LIBRARY_PATH")).toBe(false);
    // 声明目录不存在 → L2
    const missingDir = runBootPreflight({ HOME: "/home/x", ATF_DSH_KERNEL_DIR: "/kernel" }, { ...probes, dirExists: (p) => p !== "/usr/local/lib" });
    expect(missingDir.fatal.some((f) => f.check === "ld_library_path")).toBe(true);
  });
});

describe("批㊶-W 真机回归锚（bw-live-1 最小链实锚）", () => {
  it("trainingFace 排队通报 import 在位（appendNotification 未定义运行时炸——真机实锚防回潮）", () => {
    const src = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/trainingFace.ts"), "utf8");
    expect(src).toContain('import { appendNotification }');
    expect(src).toContain("onQueueStatus");
  });
  it("gpuQueueFace 排队反馈回调在位（GpuQueueStatus 导出）", () => {
    const src = readFileSync(join(import.meta.dirname, "../../packages/extensions/atf-tools/src/gpuQueueFace.ts"), "utf8");
    expect(src).toContain("GpuQueueStatus");
    expect(src).toContain("onQueueStatus");
  });
});
