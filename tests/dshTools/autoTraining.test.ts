/**
 * 批㊶-Q 测试锚——全自动智能训练档三段（指令 6c936c82 v3）。
 *
 * 段1 档位面：dev profile 注册 auto_training（defaultPreset 不动）＋投影面 catalog additive；
 *   uat profile 本批零触碰（同事真训现场冻结）。
 * 段2 确认链路分支：档位识别 fail-closed；全自动档免阻塞落快照＋通报写入＋agent 推荐护栏
 *   （域内原样采纳／越界拦截回退／推荐缺失回退）＋amend 兼容；手动档 recommend 不消费＋
 *   审批链零变化（回归锚）。
 * 段3 OOM 自动降档重发：批参解析/补丁纯函数＋编排护栏（通报前置·每 run 一次·bs1 不重发·
 *   端口占用停手·DRY_RUN 不过不重发）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { currentPresetKey, isAutoTrainingTier } from "../../packages/extensions/atf-tools/src/autoTrainingTier.js";
import { readTrainShBatchParams, patchTrainShForOom, maybeAutoOomFallback, oomFallbackStatePath } from "../../src/core/workspace/oomFallback.js";
import { injectMonitorGlobal } from "../../packages/extensions/atf-ui/src/server.js";

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

/** ctx 桩：permissionPresets.current 按 tier 回值；approval 记录调用（断言免阻塞/阻塞）。 */
const tierCtx = (tier: string, recorded?: { approvals: string[] }) => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: (session: unknown) => (session !== undefined ? tier : "danger-full-access"),
        defaultPreset: "danger-full-access",
        catalog: () => ({
          options: [
            { value: "read-only", name: "Read only" },
            { value: "workspace-write", name: "Workspace write" },
            { value: "danger-full-access", name: "Full access" },
            { value: "auto_training", name: "全自动训练" },
          ],
          defaultPreset: "danger-full-access",
        }),
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { recorded?.approvals.push(req.reason); return "allowed-once"; } };
    }
    return undefined;
  },
});

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

// ---------------------------------------------------------------- 段1 档位面

describe("批㊶-Q 段1 档位面（auto_training 注册＋投影 catalog＋uat 零触碰）", () => {
  it("dev profile 注册 auto_training（name 全自动训练）；defaultPreset 仍为 danger-full-access（存量默认零变化）", () => {
    const profile = readFileSync(join(repoRoot, "poc", "dsh-home", "profiles", "web", "cordis.patch.yml"), "utf8");
    expect(profile).toMatch(/auto_training:\n\s+sandbox: danger-full-access\n\s+approval: ask\n\s+name: 全自动训练/);
    expect(profile).toContain("defaultPreset: danger-full-access");
  });
  it("uat profile（dsh-home-tongshi）本批零触碰——无 auto_training 键（同事真训现场冻结）", () => {
    const profile = readFileSync(join(repoRoot, "poc", "dsh-home-tongshi", "profiles", "web", "cordis.patch.yml"), "utf8");
    expect(profile).not.toContain("auto_training");
  });
  it("投影面：injectMonitorGlobal 增 catalog additive 键（key+label 两键形态，auto_training 流入）；旧键零变化", () => {
    const html = injectMonitorGlobal(
      "<html><head></head><body></body></html>",
      "/runs/atf-ui/monitor.json",
      { mode: "real", version: "v0.7.11b0" },
      { key: "danger-full-access", label: "Full access" },
      [
        { key: "read-only", label: "Read only" },
        { key: "danger-full-access", label: "Full access" },
        { key: "auto_training", label: "全自动训练" },
      ],
    );
    expect(html).toContain('"permissionPresets":[{"key":"read-only","label":"Read only"},{"key":"danger-full-access","label":"Full access"},{"key":"auto_training","label":"全自动训练"}]');
    expect(html).toContain('"permissionPreset":{"key":"danger-full-access","label":"Full access"}');
    expect(html).toContain('"monitorPath":"/runs/atf-ui/monitor.json"');
    // 缺席 catalog＝旧装配面零变化（不投影该键）
    expect(injectMonitorGlobal("<html></html>", "/m.json")).not.toContain("permissionPresets");
  });
});

// ---------------------------------------------------------------- 段2 档位识别（fail-closed）

describe("批㊶-Q 段2 档位识别（fail-closed＝手动语义）", () => {
  const ctxOf = (service: unknown) => ({ get: (name: string) => (name === "permissionPresets" ? service : undefined) });
  it("current=auto_training → isAutoTrainingTier true", () => {
    const service = { current: () => "auto_training" };
    expect(isAutoTrainingTier(ctxOf(service), sessionExec)).toBe(true);
    expect(currentPresetKey(ctxOf(service), sessionExec)).toBe("auto_training");
  });
  it("其他档位/服务缺席/会话缺席/current 抛错 → 一律 false（fail-closed 阻塞审批语义不变）", () => {
    expect(isAutoTrainingTier(ctxOf({ current: () => "danger-full-access" }), sessionExec)).toBe(false);
    expect(isAutoTrainingTier(ctxOf(undefined), sessionExec)).toBe(false);
    expect(isAutoTrainingTier(ctxOf({ current: () => "auto_training" }), { agent: undefined })).toBe(false);
    expect(isAutoTrainingTier(ctxOf({ current: () => { throw new Error("boom"); } }), sessionExec)).toBe(false);
  });
});

// ---------------------------------------------------------------- 段2 confirmFace 全自动分支

describe("批㊶-Q 段2 atf_config_confirm 全自动分支（免阻塞落快照＋agent 推荐护栏＋通报）", () => {
  it("present＋域内推荐：免审批落快照（auto/tier/sources），alerts info·config_auto 通报含全键取值＋来源，无 pending 卡", async () => {
    const root = seedRun(tempRoot("kQ-auto-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("auto_training", recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { num_train_epochs: 3, learning_rate: "2e-4", lora_rank: 64, reason: "2.8万样本→3 epochs 防欠拟合" } },
      sessionExec,
    )) as Record<string, unknown>;
    // 免阻塞：审批零调用；结构化 auto 面
    expect(recorded.approvals).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, confirmed: true, auto: true, tier: "auto_training" });
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
    expect(snap.tier).toBe("auto_training");
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
    // param_sources 逐键回写（内核文法内：default:<依据>）
    const iter = JSON.parse(readFileSync(join(root, "run-q", "prep", "iteration-config", "iteration-config.json"), "utf8")) as { param_sources?: Record<string, string>; training?: Record<string, unknown> };
    expect(iter.param_sources?.["learning_rate"]).toMatch(/^default:agent-recommend:/);
    expect(iter.training?.["num_train_epochs"]).toBe("3");
  });
  it("越界推荐逐键拦截回退：epochs 15 / lr 9e-4 被拒（终值=登记建议），拦截事实进通报；快照仍落盘", async () => {
    const root = seedRun(tempRoot("kQ-clamp-"));
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("auto_training") });
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
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("auto_training") });
    const rankResult = (await findTool(tools, "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: { lora_rank: 24 } },
      sessionExec,
    )) as Record<string, unknown>;
    const rankFields = rankResult.fields as Array<{ key: string; value: string }>;
    expect(Object.fromEntries(rankFields.map((f) => [f.key, f]))["lora_rank"]).toMatchObject({ key: "lora_rank", value: "32" });

    const root2 = seedRun(tempRoot("kQ-missing-"));
    const missing = (await findTool(buildConfirmTools({ runsRoot: root2, ctx: tierCtx("auto_training") }), "atf_config_confirm").execute(
      { action: "present", run_id: "run-q", recommend: {} },
      sessionExec,
    )) as Record<string, unknown>;
    expect(missing).toMatchObject({ ok: true, recommend: "missing_fallback_defaults" });
    expect(String(missing.notification)).toContain("agent 推荐缺失——全键回退固定建议");
  });
  it("全自动档 amend 纯文字改参：同样免阻塞，改参键来源 user-specified", async () => {
    const root = seedRun(tempRoot("kQ-amend-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("auto_training", recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute(
      { action: "amend", run_id: "run-q", amend_text: "lr 改 2e-4 其他 ok" },
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
  it("手动档 present：审批链原样（requestApproval 调用＋pending 卡落盘），alerts 无 config_auto 通报", async () => {
    const root = seedRun(tempRoot("kQ-manual-"));
    const recorded = { approvals: [] as string[] };
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("danger-full-access", recorded) });
    const result = (await findTool(tools, "atf_config_confirm").execute({ action: "present", run_id: "run-q" }, sessionExec)) as Record<string, unknown>;
    expect(recorded.approvals).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, confirmed: true });
    expect(existsSync(join(root, "run-q", "webui", "pending-confirm.json"))).toBe(true);
    expect(existsSync(join(root, "run-q", "webui", "alerts.json"))).toBe(false);
    expect(result["auto"]).toBeUndefined();
  });
  it("手动档 recommend 参数不消费（自动档专属）——不落快照不通报，结构化提示", async () => {
    const root = seedRun(tempRoot("kQ-manual-rec-"));
    const tools = buildConfirmTools({ runsRoot: root, ctx: tierCtx("danger-full-access") });
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
    expect(calls[2]).toContain("new-session");
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
