/**
 * 训练自动驾驶测试锚（owner 2026-10-26 两轴裁定后的回归面）。
 *
 * 段1 预设面：权限轴回三档（auto_training 权限档退役）；Agent 预设 atf-training 在模板声明，
 *   其与 standard 的工具集差异（vendor 技能面关闭）与八段流程约束全在配置里；免审工具清单
 *   由 atf-tools config.approvalPolicy 显式列举（零前缀匹配、零治理点）。
 * 段2 两轴判据：预设 + 权限档**同时**齐备才算自动驾驶（任一缺席 fail-closed）；确认链路
 *   免阻塞落快照＋通报写入＋agent 推荐护栏；人工档 recommend 不消费＋审批链零变化。
 * 段3 训练链豁免 answerer：chainTools 未声明／预设不符／权限档不足三种情形一律 next()；
 *   三者齐备 allowed-once；治理点恒 next()；bash/write 类语义不变。
 * 段4 OOM 自动降档重发：批参解析/补丁纯函数＋编排护栏（通报前置·每 run 一次·bs1 不重发·
 *   端口占用停手·DRY_RUN 不过不重发）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import {
  agentPresetOf,
  isTrainingAutopilot,
  sandboxModeOf,
  ATF_TRAINING_PRESET,
} from "../../packages/extensions/atf-tools/src/trainingPreset.js";
import { makeApprovalExemptAnswerer, type ApprovalExemptPolicy } from "../../packages/extensions/atf-tools/src/approvalExempt.js";
import { readTrainShBatchParams, patchTrainShForOom, maybeAutoOomFallback, oomFallbackStatePath } from "../../src/core/workspace/oomFallback.js";
import { resolveLaunchSessionName, tmuxSocketFlag, trainingSessionBase } from "../../src/core/workspace/tmuxLiveness.js";
import { injectMonitorGlobal } from "../../packages/extensions/atf-ui/src/server.js";
import { buildRunTrainingTool } from "../../packages/extensions/atf-tools/src/trainingFace.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface DshToolLike {
  name: string;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const findTool = (tools: unknown[], name: string): DshToolLike => {
  const tool = tools.find((entry) => (entry as DshToolLike).name === name);
  if (tool === undefined) throw new Error(`工具未注册: ${name}`);
  return tool as DshToolLike;
};

/** exec 带 agent.session（档位识别与会话绑定双消费）。 */
const sessionExec = { agent: { session: { id: "sess-q-test" } }, callId: "q-call-1", signal: undefined };

/**
 * ctx 桩（两轴）：sessionProjections.agentPreset ＝ Agent 预设轴；
 * permissionPresets.current/resolve ＝ 权限档轴（按 sandbox 值判危险档）。
 * approval 记录调用（断言免阻塞/阻塞）。
 */
const twoAxisCtx = (
  axes: { preset: string | null; sandbox: string },
  recorded?: { approvals: string[] },
) => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: (session: unknown) => (session !== undefined ? "danger-full-access" : axes.sandbox),
        resolve: () => ({ sandbox: axes.sandbox, approval: "ask" }),
        defaultPreset: "danger-full-access",
        catalog: () => ({
          options: [
            { value: "read-only", name: "Read only" },
            { value: "workspace-write", name: "Workspace write" },
            { value: "danger-full-access", name: "Full access" },
          ],
          defaultPreset: "danger-full-access",
        }),
      };
    }
    if (service === "sessionProjections") {
      return {
        stateOf: (_session: unknown, key: string) =>
          key === "agentPreset" ? axes.preset : key === "sandboxMode" ? axes.sandbox : undefined,
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { recorded?.approvals.push(req.reason); return "allowed-once"; } };
    }
    if (service === "userQuestions") {
      // F5 表单卡假件：直接提交（空 selected＝零改动→按现值→审批卡）
      return { ask: async () => ({ answers: [{ id: "config-confirm-run-q", selected: [] }] }) };
    }
    return undefined;
  },
});

/** 自动驾驶档：预设 atf-training ＋ 权限档 danger-full-access（两轴齐备）。 */
const autopilotCtx = (recorded?: { approvals: string[] }) =>
  twoAxisCtx({ preset: "atf-training", sandbox: "danger-full-access" }, recorded);

/** 人工档：预设 standard（权限档仍是完全权限——故意让「只缺预设」这一轴单独成立）。 */
const manualCtx = (recorded?: { approvals: string[] }) =>
  twoAxisCtx({ preset: "standard", sandbox: "danger-full-access" }, recorded);

/** run 夹具：iteration-config 登记源（training 段带 L3 可 clamp 值）。 */
const seedRun = (root: string, runId = "run-q"): string => {
  const runDir = join(root, runId);
  mkdirSync(join(runDir, "prep", "iteration-config"), { recursive: true });
  writeFileSync(
    join(runDir, "prep", "iteration-config", "iteration-config.json"),
    JSON.stringify({
      schema_version: "IterationConfig/v1",
      training: {
        learning_rate: "1e-4",
        num_train_epochs: 2,
        per_device_train_batch_size: 2,
        cutoff_len: 9000,
        lora_rank: 32,
      },
    }),
  );
  return root;
};

const readAlertsFile = (runDir: string): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(runDir, "webui", "alerts.json"), "utf8")) as Array<Record<string, unknown>>;

// ---------------------------------------------------------------- 段1 预设面（权限轴回三档）

describe("两轴改造 段1：权限轴回三档＋Agent 预设 atf-training 声明在配置里", () => {
  const template = readFileSync(join(repoRoot, "deploy", "profiles", "web", "cordis.patch.template.yml"), "utf8");
  it("模板不再注册 auto_training 档（训练形态已改由 Agent 预设承担；权限轴回三档）", () => {
    expect(template).not.toMatch(/^\s+auto_training:\s*$/m);
    const sandboxLines = template.match(/^\s{6}(read-only|workspace-write|danger-full-access):$/gm) ?? [];
    expect(sandboxLines).toHaveLength(3);
    expect(template).toContain("defaultPreset: danger-full-access");
  });
  it("Agent 预设 atf-training 在模板声明：id／order／八段流程约束／工具集差异全在配置里", () => {
    expect(template).toContain("- id: preset-atf-training");
    expect(template).toMatch(/id: atf-training\n\s+order: 2/);
    // 八段流程约束（persona 内，配置声明——不是 TS 分支）
    for (const stage of ["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission", "training_prep"]) {
      expect(template).toContain(stage);
    }
    expect(template).toContain("训练链固定八段");
    // 工具集差异：vendor 技能面关（atf_skill_read 单源）
    expect(template).toMatch(/- id: skill-filesystem\n\s+name: '@deepseek-ai\/dsh-skill-filesystem'\n\s+disabled: true/);
    expect(template).toMatch(/- id: tool-skill\n\s+name: '@deepseek-ai\/dsh-tool-skill'\n\s+disabled: true/);
  });
  it("免审清单在 atf-tools config.approvalPolicy：显式工具名、零 atf_ 前缀、零治理点", () => {
    const block = template.slice(template.indexOf("approvalPolicy:"), template.indexOf("# —— M3 品牌定稿"));
    expect(block).toContain("preset: atf-training");
    for (const tool of ["atf_pipeline_stage", "atf_config_confirm", "atf_training_preflight"]) {
      expect(block).toContain(`- ${tool}`);
    }
    // 治理点排除（既有裁定「GPU 训练启动确认任何档位阻塞」因此无需废止）
    for (const governed of ["atf_run_training", "atf_publish_confirm", "atf_publish_model", "atf_launch_execute", "atf_joint_train", "atf_gate", "atf_admit_data", "atf_scratch_exec", "atf_quantize_annotations"]) {
      expect(block).not.toContain(`- ${governed}`);
      expect(block).not.toContain(governed);
    }
    // 禁前缀/通配：清单行必须是完整工具名（无 atf_* / atf_ 结尾通配）
    const entries = block.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- "));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).toMatch(/^- atf_[a-z_]+$/);
  });
  it("投影面：injectMonitorGlobal catalog 投影仍为 additive（三档时代形态不变）", () => {
    const html = injectMonitorGlobal(
      "<html><head></head><body></body></html>",
      "/runs/atf-ui/monitor.json",
      { mode: "real", version: "v0.7.11b0" },
      { key: "danger-full-access", label: "Full access" },
      [
        { key: "read-only", label: "Read only" },
        { key: "workspace-write", label: "Workspace write" },
        { key: "danger-full-access", label: "Full access" },
      ],
    );
    expect(html).toContain('"permissionPresets":[{"key":"read-only","label":"Read only"},{"key":"workspace-write","label":"Workspace write"},{"key":"danger-full-access","label":"Full access"}]');
    expect(html).toContain('"permissionPreset":{"key":"danger-full-access","label":"Full access"}');
    // 缺席 catalog＝旧装配面零变化（不投影该键）
    expect(injectMonitorGlobal("<html></html>", "/m.json")).not.toContain("permissionPresets");
  });
});

// ---------------------------------------------------------------- 段2 两轴判据（fail-closed）

describe("两轴改造 段2：预设 + 权限档双齐才自动驾驶（任一缺席 fail-closed）", () => {
  const exec = { agent: { session: { id: "sess-axis" } } };
  const ctxOf = (axes: { preset?: string | null; sandbox?: string | null }) => ({
    get: (name: string) => {
      if (name === "sessionProjections") {
        return {
          stateOf: (_s: unknown, key: string) => {
            if (key === "agentPreset") return axes.preset === undefined ? "atf-training" : axes.preset;
            if (key === "sandboxMode") return axes.sandbox === undefined ? "danger-full-access" : axes.sandbox;
            return undefined;
          },
        };
      }
      if (name === "permissionPresets") {
        return {
          current: () => "any",
          resolve: () => ({ sandbox: axes.sandbox === undefined ? "danger-full-access" : axes.sandbox }),
        };
      }
      return undefined;
    },
  });
  it("两轴齐备 → isTrainingAutopilot true（预设/权限档各自可见）", () => {
    expect(isTrainingAutopilot(ctxOf({}), exec)).toBe(true);
    expect(agentPresetOf(ctxOf({}), exec)).toBe("atf-training");
    expect(sandboxModeOf(ctxOf({}), exec)).toBe("danger-full-access");
  });
  it("只缺预设轴（standard）或只缺权限轴（workspace-write）→ 一律 false", () => {
    expect(isTrainingAutopilot(ctxOf({ preset: "standard" }), exec)).toBe(false);
    expect(isTrainingAutopilot(ctxOf({ sandbox: "workspace-write" }), exec)).toBe(false);
    expect(isTrainingAutopilot(ctxOf({ preset: null }), exec)).toBe(false);
    expect(isTrainingAutopilot(ctxOf({ sandbox: null }), exec)).toBe(false);
  });
  it("服务缺席 / 会话缺席 / stateOf 抛错 → 一律 false（fail-closed 阻塞审批语义不变）", () => {
    expect(isTrainingAutopilot({ get: () => undefined }, exec)).toBe(false);
    expect(isTrainingAutopilot(ctxOf({}), { agent: undefined })).toBe(false);
    expect(isTrainingAutopilot({ get: () => { throw new Error("boom"); } }, exec)).toBe(false);
  });
  it("ATF 预设 id 常量与模板一致（防两份字面量漂移）", () => {
    const template = readFileSync(join(repoRoot, "deploy", "profiles", "web", "cordis.patch.template.yml"), "utf8");
    expect(template).toContain(`preset: ${ATF_TRAINING_PRESET}`);
    expect(template).toContain(`id: ${ATF_TRAINING_PRESET}`);
  });
});

// ---------------------------------------------------------------- 段3 训练链豁免 answerer 真值表

describe("两轴改造 段3：训练链豁免 = 声明命中 + 预设 + 权限档三齐（治理点恒 next）", () => {
  const policy: ApprovalExemptPolicy = {
    preset: "atf-training",
    chainTools: ["atf_pipeline_stage", "atf_config_confirm"],
  };
  const answer = async (
    toolName: string,
    ctx: { get(service: string): unknown },
    declared: ApprovalExemptPolicy | undefined = policy,
  ): Promise<{ outcome: string; nextCalled: boolean }> => {
    let nextCalled = false;
    const outcome = await makeApprovalExemptAnswerer({ ctx, policy: declared })({ toolName, agent: { session: { id: "s" } } }, async () => {
      nextCalled = true;
      return "unavailable";
    });
    return { outcome, nextCalled };
  };

  it("三齐 → allowed-once（面板不见，next 零触达）", async () => {
    const hit = await answer("atf_pipeline_stage", autopilotCtx());
    expect(hit).toEqual({ outcome: "allowed-once", nextCalled: false });
  });
  it("未声明 chainTools / 未给 policy → next()（治理语义零变化）", async () => {
    expect(await answer("atf_pipeline_stage", autopilotCtx(), { preset: "atf-training", chainTools: [] })).toEqual({ outcome: "unavailable", nextCalled: true });
    let nextCalled = false;
    const outcome = await makeApprovalExemptAnswerer({ ctx: autopilotCtx() })({ toolName: "atf_pipeline_stage", agent: { session: { id: "s" } } }, async () => {
      nextCalled = true;
      return "unavailable";
    });
    expect(outcome).toBe("unavailable");
    expect(nextCalled).toBe(true);
  });
  it("预设不符（standard）→ next()（预设不得替用户放大能力）", async () => {
    expect(await answer("atf_pipeline_stage", manualCtx())).toEqual({ outcome: "unavailable", nextCalled: true });
  });
  it("权限档不足（workspace-write）→ next()（授权轴优先）", async () => {
    const weak = twoAxisCtx({ preset: "atf-training", sandbox: "workspace-write" });
    expect(await answer("atf_pipeline_stage", weak)).toEqual({ outcome: "unavailable", nextCalled: true });
  });
  it("治理点即使三齐也恒 next()：训练启动/发布/release/编排/联合训练/门/准入/临时执行", async () => {
    for (const governed of ["atf_run_training", "atf_publish_confirm", "atf_publish_model", "atf_evaluate", "atf_launch_execute", "atf_joint_train", "atf_gate", "atf_admit_data", "atf_scratch_exec"]) {
      expect(await answer(governed, autopilotCtx())).toEqual({ outcome: "unavailable", nextCalled: true });
    }
  });
  it("禁前缀匹配：清单里没有 atf_ 前缀时，同前缀的治理点不被连带放行", async () => {
    const loose: ApprovalExemptPolicy = { preset: "atf-training", chainTools: ["atf_pipeline_stage"] };
    expect(await answer("atf_pipeline_stage_v2", autopilotCtx(), loose)).toEqual({ outcome: "unavailable", nextCalled: true });
    expect(await answer("atf_run_training", autopilotCtx(), { preset: "atf-training", chainTools: ["atf_"] })).toEqual({ outcome: "unavailable", nextCalled: true });
  });
  it("bash/write 类语义不变：不看预设与档位，恒 allowed-once", async () => {
    for (const toolName of ["bash", "write", "edit"]) {
      expect(await answer(toolName, manualCtx(), { preset: "", chainTools: [] })).toEqual({ outcome: "allowed-once", nextCalled: false });
    }
  });
  it("声明预设与实际预设漂移（policy.preset=other）→ next()", async () => {
    expect(await answer("atf_pipeline_stage", autopilotCtx(), { preset: "other", chainTools: ["atf_pipeline_stage"] })).toEqual({ outcome: "unavailable", nextCalled: true });
  });
});

// ---------------------------------------------------------------- 段2 confirmFace 全自动分支

describe("批㊶-Q 段2 atf_config_confirm 全自动分支（免阻塞落快照＋agent 推荐护栏＋通报）", () => {
  it("present＋域内推荐：免审批落快照（auto/tier/sources），alerts info·config_auto 通报含全键取值＋来源，无 pending 卡", async () => {
    const root = seedRun(tempRoot("kQ-auto-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: autopilotCtx(recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { num_train_epochs: 3, learning_rate: "2e-4", lora_rank: 64, reason: "2.8万样本→3 epochs 防欠拟合" } },
      sessionExec,
    )) as Record<string, unknown>;
    // 免阻塞：审批零调用；结构化 auto 面
    expect(recorded.approvals).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, confirmed: true, auto: true, tier: "atf-training" });
    // 推荐域内原样采纳（不做判断——lr 2e-4 非 clamp 出口形态也保留）
    const fields = result.fields as Array<{ key: string; value: string; tag: string }>;
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey["num_train_epochs"]).toEqual({ key: "num_train_epochs", value: "3", tag: "agent_recommend" });
    expect(byKey["learning_rate"]).toEqual({ key: "learning_rate", value: "2e-4", tag: "agent_recommend" });
    expect(byKey["lora_rank"]).toEqual({ key: "lora_rank", value: "64", tag: "agent_recommend" });
    expect(byKey["lora_alpha"]).toEqual({ key: "lora_alpha", value: "128", tag: "agent_recommend" });
    // 快照 auto 面＋逐键来源（agent 推荐键＝default:agent-recommend:<简据>，其余＝default:harness-smart-defaults）
    const snap = JSON.parse(readFileSync(join(root, "run-q", "webui", "config-snapshot.json"), "utf8")) as { auto?: boolean; tier?: string; sources?: Record<string, string>; confirmed: Record<string, string> };
    expect(snap.auto).toBe(true);
    expect(snap.tier).toBe("atf-training");
    expect(snap.confirmed["num_train_epochs"]).toBe("3");
    expect(snap.sources?.["num_train_epochs"]).toMatch(/^default:agent-recommend:.+/);
    expect(snap.sources?.["cutoff_len"]).toBe("default:harness-smart-defaults");
    // 通报：alerts.json info·config_auto，含取值＋来源标注＋推荐理由
    const alerts = readAlertsFile(join(root, "run-q"));
    const notice = alerts.find((a) => a["kind"] === "config_auto");
    expect(notice).toMatchObject({ level: "info" });
    expect(String(notice?.["reason"])).toContain("num_train_epochs=3");
    expect(String(notice?.["reason"])).toContain("default:agent-recommend:");
    expect(String(notice?.["reason"])).toContain("2.8万样本");
    // 无 pending 卡（卡面内容转为通报——无审批可应答面）
    expect(existsSync(join(root, "run-q", "webui", "pending-confirm.json"))).toBe(false);
    // E4-乙（改动 2）：停写 iteration-config——param_sources/training 段由内核 training_prep 段写
    // （user_confirmed(ref=stage:training_overrides)）；确认链零触碰内核产物（夹具原值原样）
    const iter = JSON.parse(readFileSync(join(root, "run-q", "prep", "iteration-config", "iteration-config.json"), "utf8")) as { param_sources?: Record<string, string>; training?: Record<string, unknown> };
    expect(iter.param_sources).toBeUndefined(); // 停写锚：确认链不再落 param_sources
    expect(iter.training?.["num_train_epochs"]).toBe(2); // 夹具预置原值——零改写（回写时代会被改成 "3"）
  });
  it("越界推荐逐键拦截回退：epochs 15 / lr 9e-4 被拒（终值=登记建议），拦截事实进通报；快照仍落盘", async () => {
    const root = seedRun(tempRoot("kQ-clamp-"));
    const tools = buildConfirmTools({ runsRoot: root, ctx: autopilotCtx() });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { num_train_epochs: 15, learning_rate: "9e-4" } },
      sessionExec,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, confirmed: true, auto: true });
    const fields = result.fields as Array<{ key: string; value: string; tag: string }>;
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey["num_train_epochs"]).toEqual({ key: "num_train_epochs", value: "2", tag: "from_registry" });
    expect(byKey["learning_rate"]).toEqual({ key: "learning_rate", value: "1e-4", tag: "from_registry" });
    const report = result.recommend_report as Array<{ key: string; accepted: boolean; note: string }>;
    expect(report.find((v) => v.key === "num_train_epochs")?.accepted).toBe(false);
    expect(report.find((v) => v.key === "num_train_epochs")?.note).toContain("越界被拒");
    expect(String(result.notification)).toContain("拦截");
  });
  it("rank 非档位（24）拦截；推荐缺失全键回退固定建议（不猜不编造）", async () => {
    const root = seedRun(tempRoot("kQ-fallback-"));
    const tools = buildConfirmTools({ runsRoot: root, ctx: autopilotCtx() });
    const rankResult = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { lora_rank: 24 } },
      sessionExec,
    )) as Record<string, unknown>;
    const rankFields = rankResult.fields as Array<{ key: string; value: string }>;
    expect(Object.fromEntries(rankFields.map((f) => [f.key, f]))["lora_rank"]).toMatchObject({ key: "lora_rank", value: "32" });

    const root2 = seedRun(tempRoot("kQ-missing-"));
    const missing = (await findTool(buildConfirmTools({ runsRoot: root2, ctx: autopilotCtx() }), "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: {} },
      sessionExec,
    )) as Record<string, unknown>;
    expect(missing).toMatchObject({ ok: true, recommend: "missing_fallback_defaults" });
    expect(String(missing.notification)).toContain("agent 推荐缺失——全键回退固定建议");
  });
  it("全自动档 amend 结构化改参（F5 edits 形态）：同样免阻塞，改参键来源 user-specified", async () => {
    const root = seedRun(tempRoot("kQ-amend-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: autopilotCtx(recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "amend", run_id: "run-q", edits: { learning_rate: "2e-4" } },
      sessionExec,
    )) as Record<string, unknown>;
    expect(recorded.approvals).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, confirmed: true, auto: true });
    const sources = result.sources as Record<string, string>;
    expect(sources["learning_rate"]).toBe("user-specified");
    const fields = result.fields as Array<{ key: string; value: string; tag: string }>;
    expect(Object.fromEntries(fields.map((f) => [f.key, f]))["learning_rate"]).toMatchObject({ value: "2e-4", tag: "need_confirm" });
  });
});

describe("批㊶-Q 段2 手动档回归（确认卡行为零变化＋recommend 不消费）", () => {
  it("手动档 present：审批链原样（requestApproval 调用），确认完成后 pending 卡清（增补二3——.answered 备份留存），alerts 无 config_auto 通报", async () => {
    const root = seedRun(tempRoot("kQ-manual-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: manualCtx(recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute({ action: "present", run_id: "run-q" }, sessionExec)) as Record<string, unknown>;
    expect(recorded.approvals).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, confirmed: true });
    // 增补二3：确认完成即清 pending 卡（备份改名 .answered——原文件不在场）
    expect(existsSync(join(root, "run-q", "webui", "pending-confirm.json"))).toBe(false);
    const webuiFiles = readdirSync(join(root, "run-q", "webui"));
    expect(webuiFiles.some((f) => f.startsWith("pending-confirm.json.answered."))).toBe(true);
    expect(existsSync(join(root, "run-q", "webui", "alerts.json"))).toBe(false);
    expect(result["auto"]).toBeUndefined();
  });
  it("增补二3：自动档确认清理历史残留 pending 卡（手动卡后切档场景）", async () => {
    const root = seedRun(tempRoot("kQ-auto-pending-"));
    mkdirSync(join(root, "run-q", "webui"), { recursive: true });
    writeFileSync(join(root, "run-q", "webui", "pending-confirm.json"), '{"kind":"config_confirm","run_id":"run-q"}');
    const tools = buildConfirmTools({ runsRoot: root, ctx: autopilotCtx() });
    await findTool(tools, "atf_config_confirm").execute({ action: "present", run_id: "run-q" }, sessionExec);
    expect(existsSync(join(root, "run-q", "webui", "pending-confirm.json"))).toBe(false);
    const webuiFiles = readdirSync(join(root, "run-q", "webui"));
    expect(webuiFiles.some((f) => f.startsWith("pending-confirm.json.answered."))).toBe(true);
  });
  it("手动档 recommend 参数不消费（自动档专属）——不落快照不通报，结构化提示", async () => {
    const root = seedRun(tempRoot("kQ-manual-rec-"));
    const tools = buildConfirmTools({ runsRoot: root, ctx: manualCtx() });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { num_train_epochs: 3 } },
      sessionExec,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: false });
    expect(String(result.note)).toContain("全自动训练档专属");
    expect(existsSync(join(root, "run-q", "webui", "config-snapshot.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------- 段3 OOM 自动降档重发

const TRAIN_SH_TEMPLATE = [
  "#!/usr/bin/env bash",
  "# test fixture",
  "export NPROC_PER_NODE=8",
  "export MASTER_PORT=${MASTER_PORT:-29517}",
  "TRAIN_CMD=(",
  "  'llamafactory-cli' \\",
  "  'train' \\",
  "  '--per_device_train_batch_size' \\",
  "  '2' \\",
  "  '--gradient_accumulation_steps' \\",
  "  '16' \\",
  "  '--bf16'",
  ")",
  'if [[ "${DRY_RUN:-0}" == "1" ]]; then',
  "  printf 'COMMAND='; printf '%q ' \"${TRAIN_CMD[@]}\"; printf '\\n'",
  "  echo ADMISSION=pass",
  "  exit 0",
  "fi",
  "echo training-sim",
  "",
].join("\n");

describe("批㊶-Q 段3 OOM 自动降档重发（纯函数＋编排护栏）", () => {
  it("批参解析：bs/accum/nproc 三值提取；特征行缺失 fail-closed", () => {
    const ok = readTrainShBatchParams(TRAIN_SH_TEMPLATE);
    expect(ok).toEqual({ bs: 2, accum: 16, nproc: 8 });
    expect(readTrainShBatchParams("echo nothing")).toMatchObject({ error: expect.stringContaining("train_sh_batch_params_missing") });
  });
  it("降档补丁：bs 2→1、accum 16→32、头部来历注记；纯函数不改原文", () => {
    const patched = patchTrainShForOom(TRAIN_SH_TEMPLATE, { bs: 1, accum: 32 }, "2026-10-10T00:00:00Z");
    expect(patched).not.toBeNull();
    expect(patched).toContain("'--per_device_train_batch_size' \\\n  '1' \\");
    expect(patched).toContain("'--gradient_accumulation_steps' \\\n  '32' \\");
    expect(patched).toContain("OOM 自动降档重发");
    // 原文不动（调用方写新文件）
    expect(TRAIN_SH_TEMPLATE).toContain("'--per_device_train_batch_size' \\\n  '2' \\");
    // 特征行缺失 → null
    expect(patchTrainShForOom("echo x", { bs: 1, accum: 32 }, "n")).toBeNull();
  });
  it("编排 happy path：通报先于重发（alerts 在 tmux 之前），fallback 脚本 bs1/accum32，状态文件落盘，原 train.sh 不动", async () => {
    const root = tempRoot("kQ-oom-");
    const runDir = join(root, "run-q");
    mkdirSync(join(runDir, "launch"), { recursive: true });
    writeFileSync(join(runDir, "launch", "train.sh"), TRAIN_SH_TEMPLATE);
    const calls: string[] = [];
    const outcome = await maybeAutoOomFallback({
      runDir,
      runId: "run-q",
      logDir: join(root, "logs"),
      alert: { level: "error", kind: "probe", reason: "CUDA out of memory（训练日志 OOM 特征）", since: "2026-10-10T00:00:00.000Z" },
      now: () => new Date("2026-10-10T00:05:00Z"),
      log: () => {},
      exists: (abs) => existsSync(abs),
      readText: (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : null),
      writeText: (abs, text) => {
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, text, "utf8");
      },
      dryRun: async () => ({ code: 0, stdout: "ADMISSION=pass\n" }),
      probePort: async () => null,
      tmux: (command) => calls.push(command),
      rotateLog: (logPath) => calls.push(`rotate:${logPath}`),
      startIngest: (logPath) => calls.push(`ingest:${logPath}`),
    });
    expect(outcome.triggered).toBe(true);
    expect(calls[0]).toContain("rotate:");
    expect(calls[1]).toContain("kill-session");
    // 批㊶-ISO E1/D2①：重发会话名走命名域单源＋命令构造带测试 socket 注入（fixture env 同源）
    expect(calls[1]).toContain(resolveLaunchSessionName(trainingSessionBase("run-q")));
    expect(calls[1]).toContain(tmuxSocketFlag().trim());
    expect(calls[2]).toContain("new-session");
    expect(calls[2]).toContain(resolveLaunchSessionName(trainingSessionBase("run-q")));
    expect(calls[2]).toContain(tmuxSocketFlag().trim());
    expect(calls[2]).toContain("train-oom-fallback.sh");
    // 通报先于重发（alerts.json 已在 tmux 调用前写盘）
    const alerts = readAlertsFile(runDir);
    const notice = alerts.find((a) => a["kind"] === "oom_fallback");
    expect(notice).toMatchObject({ level: "info" });
    expect(String(notice?.["reason"])).toContain("2→1");
    expect(String(notice?.["reason"])).toContain("16→32");
    expect(String(notice?.["reason"])).toContain("256 不变");
    // fallback 脚本降档形态＋原件不动
    const fallbackText = readFileSync(join(runDir, "launch", "train-oom-fallback.sh"), "utf8");
    expect(fallbackText).toContain("'--per_device_train_batch_size' \\\n  '1' \\");
    expect(fallbackText).toContain("'--gradient_accumulation_steps' \\\n  '32' \\");
    expect(readFileSync(join(runDir, "launch", "train.sh"), "utf8")).toBe(TRAIN_SH_TEMPLATE);
    // 状态文件（每 run 一次护栏）
    const state = JSON.parse(readFileSync(oomFallbackStatePath(runDir), "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({ status: "relaunched", bs: 1, accum: 32, global_batch: 256 });
  });
  it("护栏：状态文件在场／bs 已 1／非探针 OOM 告警 → 不重发", async () => {
    const mk = async (preState: boolean, alert: { level: string; kind?: string; reason: string; since: string }): Promise<{ triggered: boolean }> => {
      const root = tempRoot("kQ-guard-");
      const runDir = join(root, "run-q");
      mkdirSync(join(runDir, "launch"), { recursive: true });
      writeFileSync(join(runDir, "launch", "train.sh"), TRAIN_SH_TEMPLATE);
      if (preState) {
        mkdirSync(join(runDir, "webui"), { recursive: true });
        writeFileSync(oomFallbackStatePath(runDir), "{}\n");
      }
      const outcome = await maybeAutoOomFallback({
        runDir, runId: "run-q", logDir: join(root, "logs"), alert,
        now: () => new Date(), log: () => {},
        exists: (abs) => existsSync(abs),
        readText: (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : null),
        writeText: (abs, text) => writeFileSync(abs, text, "utf8"),
        dryRun: async () => ({ code: 0, stdout: "ADMISSION=pass" }),
        probePort: async () => null,
        tmux: () => {}, rotateLog: () => {}, startIngest: () => {},
      });
      return { triggered: outcome.triggered };
    };
    expect((await mk(true, { level: "error", kind: "probe", reason: "CUDA out of memory", since: "s" })).triggered).toBe(false);
    expect((await mk(false, { level: "info", kind: "config_auto", reason: "CUDA out of memory", since: "s" })).triggered).toBe(false);
    expect((await mk(false, { level: "error", kind: "probe", reason: "训练疑似停滞", since: "s" })).triggered).toBe(false);
    const root2 = tempRoot("kQ-bs1-");
    const runDir2 = join(root2, "run-q");
    mkdirSync(join(runDir2, "launch"), { recursive: true });
    writeFileSync(join(runDir2, "launch", "train.sh"), TRAIN_SH_TEMPLATE.replace("'--per_device_train_batch_size' \\\n  '2' \\", "'--per_device_train_batch_size' \\\n  '1' \\").replace("'--gradient_accumulation_steps' \\\n  '16' \\", "'--gradient_accumulation_steps' \\\n  '32' \\"));
    const skip = await maybeAutoOomFallback({
      runDir: runDir2, runId: "run-q", logDir: join(root2, "logs"),
      alert: { level: "error", kind: "probe", reason: "CUDA out of memory", since: "s" },
      now: () => new Date(), log: () => {},
      exists: (abs) => existsSync(abs),
      readText: (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : null),
      writeText: (abs, text) => writeFileSync(abs, text, "utf8"),
      dryRun: async () => ({ code: 0, stdout: "ADMISSION=pass" }),
      probePort: async () => null, tmux: () => {}, rotateLog: () => {}, startIngest: () => {},
    });
    expect(skip.triggered).toBe(false);
    expect(JSON.parse(readFileSync(oomFallbackStatePath(runDir2), "utf8"), undefined)).toMatchObject({ status: "skipped_already_bs1" });
    expect((await mk(false, { level: "info", kind: "config_auto", reason: "CUDA out of memory", since: "s" })).triggered).toBe(false);
    expect((await mk(false, { level: "error", kind: "probe", reason: "训练疑似停滞", since: "s" })).triggered).toBe(false);
  });
  it("护栏：DRY_RUN 不过／端口占用 → warn 通报＋不重发＋状态留痕", async () => {
    const mk = (dry: { code: number; stdout: string }, port: unknown | null): Promise<{ triggered: boolean; runDir: string }> => {
      const root = tempRoot("kQ-fail-");
      const runDir = join(root, "run-q");
      mkdirSync(join(runDir, "launch"), { recursive: true });
      writeFileSync(join(runDir, "launch", "train.sh"), TRAIN_SH_TEMPLATE);
      return maybeAutoOomFallback({
        runDir, runId: "run-q", logDir: join(root, "logs"),
        alert: { level: "error", kind: "probe", reason: "CUDA out of memory", since: "s" },
        now: () => new Date(), log: () => {},
        exists: (abs) => existsSync(abs),
        readText: (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : null),
        writeText: (abs, text) => writeFileSync(abs, text, "utf8"),
        dryRun: async () => dry,
        probePort: async () => port,
        tmux: () => {}, rotateLog: () => {}, startIngest: () => {},
      }).then((outcome) => ({ triggered: outcome.triggered, runDir }));
    };
    const dryFail = await mk({ code: 1, stdout: "ADMISSION=fail" }, null);
    expect(dryFail.triggered).toBe(false);
    const alerts = readAlertsFile(join(dryFail.runDir));
    expect(alerts.find((a) => a["kind"] === "oom_fallback")).toMatchObject({ level: "warn" });
    const portBusy = await mk({ code: 0, stdout: "ADMISSION=pass" }, { occupied: true });
    expect(portBusy.triggered).toBe(false);
    expect(readAlertsFile(join(portBusy.runDir)).find((a) => a["kind"] === "oom_fallback")).toMatchObject({ level: "warn" });
  });
});

// ------------------------------------------------- 批㊶Q增补一 danger 卡收窄（裁定 1 乙）


/** 审批结果可控的 ctx 桩（tierCtx 的 request 恒 allowed-once——本组需要 rejected 形态）。 */
const tierCtxOutcome = (axes: { preset: string | null; sandbox: string }, outcome: string, recorded: { approvals: string[] }) => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: (session: unknown) => (session !== undefined ? "danger-full-access" : axes.sandbox),
        resolve: () => ({ sandbox: axes.sandbox, approval: "ask" }),
        defaultPreset: "danger-full-access",
      };
    }
    if (service === "sessionProjections") {
      return {
        stateOf: (_session: unknown, key: string) =>
          key === "agentPreset" ? axes.preset : key === "sandboxMode" ? axes.sandbox : undefined,
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { recorded.approvals.push(req.reason); return outcome; } };
    }
    return undefined;
  },
});

/** 自动驾驶两轴 / 人工两轴（danger 卡阻塞回归的两侧）。 */
const AUTOPILOT_AXES = { preset: "atf-training", sandbox: "danger-full-access" } as const;
const MANUAL_AXES = { preset: "standard", sandbox: "danger-full-access" } as const;

describe("批㊶Q增补一 danger 卡任何档位阻塞（owner 裁定 1 乙——真实 GPU 训练启动确认永远人工审批）", () => {
  /** start 前置夹具：DRY_RUN 过（ADMISSION=pass）＋prelaunch 报告在场＋冷端口＋
   *  批㊶R前置 防线③ 模型夹具（run-q iteration-config 指向本地假模型目录）。 */
  const seedStart = (root: string): { trainSh: string } => {
    const runDir = join(root, "run-q");
    const launchDir = join(runDir, "launch");
    mkdirSync(launchDir, { recursive: true });
    const trainSh = join(launchDir, "train.sh");
    writeFileSync(trainSh, TRAIN_SH_TEMPLATE.replace("29517", "39577"));
    writeFileSync(join(launchDir, "prelaunch-report.md"), "# prelaunch（增补一 danger 锚夹具）\n");
    const modelDir = join(root, "models", "fake-model");
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, "config.json"), "{}\n");
    mkdirSync(join(runDir, "prep"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config.json"), `${JSON.stringify({ base_model: { path: modelDir }, training: {} }, null, 1)}\n`);
    return { trainSh };
  };

  it("全自动档 start：danger 卡仍阻塞——审批恰一次（理由含真实 GPU 训练启动确认），拒绝即结构化拒绝，无 train_auto 通报", async () => {
    const root = tempRoot("kQz1-auto-");
    const { trainSh } = seedStart(root);
    const recorded = { approvals: [] as string[] };
    const tool = buildRunTrainingTool(tierCtxOutcome(AUTOPILOT_AXES, "rejected", recorded), { runsRoot: root, logDir: join(root, "logs"), ctx: {} as never });
    const result = (await (tool as unknown as DshToolLike).execute(
      { action: "start", train_sh: trainSh, run_id: "run-q" },
      sessionExec,
    )) as Record<string, unknown>;
    // danger 卡任何档位阻塞：审批调用恰一次；拒绝即不开训
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.approvals[0]).toContain("将要执行：启动真实 GPU 训练");
    expect(result).toMatchObject({ error: "approval_denied", outcome: "rejected" });
    // 不再转通报（train_auto 通报块已随裁定 1 乙移除）
    expect(existsSync(join(root, "run-q", "webui", "alerts.json"))).toBe(false);
  });

  it("手动档 start 全链不变：同样 danger 卡一次审批＋拒绝即停（与全自动档同语义）", async () => {
    const root = tempRoot("kQz1-manual-");
    const { trainSh } = seedStart(root);
    const recorded = { approvals: [] as string[] };
    const tool = buildRunTrainingTool(tierCtxOutcome(MANUAL_AXES, "rejected", recorded), { runsRoot: root, logDir: join(root, "logs"), ctx: {} as never });
    const result = (await (tool as unknown as DshToolLike).execute(
      { action: "start", train_sh: trainSh, run_id: "run-q" },
      sessionExec,
    )) as Record<string, unknown>;
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.approvals[0]).toContain("将要执行：启动真实 GPU 训练");
    expect(result).toMatchObject({ error: "approval_denied", outcome: "rejected" });
  });

  it("源码锚：GPU 琥珀卡免再确认分支在位（自动驾驶通报化语义保持）＋train_auto 放行通报块已移除", () => {
    const src = readFileSync(join(repoRoot, "packages", "extensions", "atf-tools", "src", "trainingFace.ts"), "utf8");
    // 琥珀卡：全自动档免再确认（窗口命中即启动）保持 Q 批语义
    expect(src).toContain("if (!autoTierStart)");
    // 裁定 1 乙：train_auto「训练自动放行（免审批）」通报块不再存在
    expect(src).not.toContain("训练自动放行");
    // danger 卡无条件审批（任何档位）——注释行以「本 danger 卡永远保留人工审批」声明
    expect(src).toContain("本 danger 卡永远保留人工审批");
    expect(src).toContain("atf_run_training 不进 chainTools");
  });
});
