/**
 * 批㊶R前置 真机重演锚（VERIFY1/2 工具面——真实产物×真实模型根×真实机器事实；
 * 守卫：重演件/真实模型根在场才跑，否则 skip——CI 无此现场不炸）。
 *
 * 场景＝cr_ci_smoke_r1 事件重演（修复计划 §一.1 陷阱形态：家族名当路径填入 base_model.path）。
 * 重演件＝uat 实件 cr_ci_smoke_r1 派生（train.sh/prelaunch 真件），base_model.path 改 qwen3_vl。
 * 注意：本锚为直接调用工具面（非会话端到端）；会话端到端＝VERIFY4（uat 部署后同事复推）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunTrainingTool } from "../../packages/extensions/atf-tools/src/trainingFace.js";
import { checkStartModelPath } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const MODEL_ROOT = "/data/LLM_model";
const REPLAY_RUNS = "/data/sam/atf-walkthrough/ws-walkthrough-pipeline/runs";
const REPLAY_ID = "cr_ci_smoke_r1_replay";

describe("批㊶R前置 VERIFY 工具面真机重演（真件×真根；现场缺席 skip）", () => {
  it("VERIFY1：qwen3_vl 家族名误填 → start 秒拒 model_path_missing＋真实模型清单回流（不进审批不进 tmux）", async () => {
    const trainSh = join(REPLAY_RUNS, REPLAY_ID, "launch", "train.sh");
    if (!existsSync(trainSh) || !existsSync(MODEL_ROOT)) {
      console.warn(`[guard] 重演现场缺席（${trainSh}）——skip`);
      return;
    }
    // arrange（幂等——VERIFY3 的确认流会把合法锚点写回 base_model.path，跨用例自污染会解除
    // 本用例的靶形；且靶形一旦解除，陈旧 train.sh 携原放行 sha 越账本闸真起训——20261012 事故实证）
    const iterPathV1 = join(REPLAY_RUNS, REPLAY_ID, "prep", "iteration-config", "iteration-config.json");
    const iterDocV1 = JSON.parse(readFileSync(iterPathV1, "utf8")) as { base_model: Record<string, unknown>; training: Record<string, unknown> };
    iterDocV1.base_model = { family: "qwen3_vl", path: "qwen3_vl" };
    iterDocV1.training["nproc_per_node"] = 1;
    writeFileSync(iterPathV1, `${JSON.stringify(iterDocV1, null, 1)}\n`);
    rmSync(join(REPLAY_RUNS, REPLAY_ID, "webui", "config-snapshot.json"), { force: true });
    // 双保险：即使靶形意外失效，也不得进 GPU 队列/真训（本锚定位＝秒拒面）
    process.env["ATF_GPU_POLL_MS"] = "0";
    // 真机实例 boot env 带 ATF_MODEL_ROOT（deploy/instances/*.env）——测试进程对齐注入
    const savedModelRoot = process.env["ATF_MODEL_ROOT"];
    process.env["ATF_MODEL_ROOT"] = MODEL_ROOT;
    let approvalCalls = 0;
    const ctx = { get: (s: string) => (s === "approval" ? { request: async () => { approvalCalls += 1; return "allowed-once"; } } : undefined) };
    const tool = buildRunTrainingTool(ctx, { runsRoot: REPLAY_RUNS, logDir: join(REPLAY_RUNS, "..", "logs"), ctx }) as unknown as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute({ action: "start", train_sh: trainSh, run_id: REPLAY_ID }, { callId: "verify1" });
    expect(result.started).toBe(false);
    expect(result.error).toBe("model_path_missing");
    expect(result.model_path).toBe("qwen3_vl");
    const models = result.models as string[];
    expect(models.length).toBeGreaterThan(0);
    expect(models).toContain("Qwen3-VL-32B-Instruct"); // 真实清单——本地在位，拒的是「家族名≠路径」
    expect(approvalCalls).toBe(0);
    expect(String(result.note)).toContain("不进训练进程");
    if (savedModelRoot === undefined) delete process.env["ATF_MODEL_ROOT"]; else process.env["ATF_MODEL_ROOT"] = savedModelRoot;
  });

  it("VERIFY2 前半：cr_ci_smoke_r1 实件合法路径 → 复核放行（gate pass；真训起跑＝VERIFY4 会话端到端候窗）", () => {
    const realRun = "/data/sam/ATF-Harness/poc/dsh-home-tongshi/runs/cr_ci_smoke_r1";
    if (!existsSync(join(realRun, "prep", "iteration-config", "iteration-config.json")) || !existsSync(MODEL_ROOT)) {
      console.warn("[guard] 实件现场缺席——skip");
      return;
    }
    const result = checkStartModelPath(realRun, { ATF_MODEL_ROOT: MODEL_ROOT });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("/data/LLM_model/Qwen3-VL-32B-Instruct");
  });
});

describe("批㊶R前置 VERIFY3 工具面真机重演（确认卡拦截＋卡数键呈现——实件配置靶）", () => {
  it("cr_ci_smoke_r1 实件配置（nproc=1×z3_offload）→ 建卡期拦截回退拉满＋note 可读＋卡数键入卡", async () => {
    const replayRun = join(REPLAY_RUNS, REPLAY_ID);
    if (!existsSync(join(replayRun, "prep", "iteration-config", "iteration-config.json"))) {
      console.warn("[guard] 重演现场缺席——skip");
      return;
    }
    // arrange（幂等——确认流会把回退值写回 iteration-config/快照，跨次运行须复位靶形）：
    // 事件实效配置＝nproc_per_node=1 × ds_z3_offload（train.sh NPROC_PER_NODE=1 的配置面还原）
    const iterPath = join(replayRun, "prep", "iteration-config", "iteration-config.json");
    const iterDoc = JSON.parse(readFileSync(iterPath, "utf8")) as { training: Record<string, unknown> };
    iterDoc.training["nproc_per_node"] = 1;
    writeFileSync(iterPath, `${JSON.stringify(iterDoc, null, 1)}\n`);
    rmSync(join(replayRun, "webui", "config-snapshot.json"), { force: true });
    process.env["ATF_MODEL_ROOT"] = MODEL_ROOT;
    const { buildConfirmTools } = await import("../../packages/extensions/atf-tools/src/confirmFace.js");
    const recorded: string[] = [];
    const tierCtx = {
      get: (service: string) => {
        if (service === "permissionPresets") {
          return { current: () => "auto_training", defaultPreset: "danger-full-access" };
        }
        if (service === "approval") return { request: async (req: { reason: string }) => { recorded.push(req.reason); return "allowed-once"; } };
        return undefined;
      },
    };
    const tools = buildConfirmTools({ runsRoot: REPLAY_RUNS, ctx: tierCtx }) as unknown as Array<{
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
    }>;
    const configTool = tools[0];
    if (configTool === undefined) throw new Error("confirm tool missing");
    const result = await configTool.execute(
      { action: "present", run_id: REPLAY_ID, recommend: { reason: "VERIFY3：实件配置重演（单卡×z3_offload 拦截靶）" } },
      { callId: "verify3", agent: { session: { id: "verify-session", header: { cwd: "/data/chris/docops/tasks/ci_smoke" } } } },
    );
    const fields = (result.fields ?? []) as Array<{ key: string; value: string; tag: string }>;
    const nprocRow = fields.find((f) => f.key === "nproc_per_node");
    expect(nprocRow).toBeDefined(); // 卡数显性卡入卡（VERIFY2 卡面半）
    expect(nprocRow?.value).toBe("8"); // 实件 1 → 拦截回退拉满（真机 8 卡）
    const notification = String(result.notification ?? "");
    expect(notification).toContain("卡数护栏");
    expect(notification).toContain("ZeRO-3"); // 反模式说明可读
    // 快照已按回退后值落盘（生效配置不含反模式组合）
    const snapshot = JSON.parse(readFileSync(join(replayRun, "webui", "config-snapshot.json"), "utf8")) as { confirmed?: Record<string, string> };
    expect(snapshot.confirmed?.["nproc_per_node"]).toBe("8");
  });
});
