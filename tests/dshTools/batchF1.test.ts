/**
 * F1（首跑体验批）测试锚——训练链入口预检单卡（指令《ATF_指令_首跑体验F1_预检单卡_20261024》§二）。
 *
 * 四面对照指令 §二.4：
 * 1. 三态渲染：固定 schema 校验（好样例／畸形逐键拒）＋三态分组·依赖链序·待依赖标注渲染；
 * 2. apply 路径：参数直给与预检卡勾选两入口，授权恒走审批卡（拒＝不执行清单如实返回）；
 * 3. KPI 落盘：preflight／first_launch_at 首写固定（launch-kpi.json）；放行成功路径实锚；
 * 4. 预检卡在九要素前：config_confirm 前置预检出卡顺序（机制保证）＋KPI 在场跳过＋
 *    装配缺席/脚本在场缺席零回归（pin 未含脚本过渡态）。
 * mock 对端＝tests/fixtures/mock_preflight.mjs（固定 schema 单源——先对 schema 后集成）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePreflightReport,
  renderPreflightChecklist,
  recordPreflightAt,
  recordFirstLaunchAt,
  readLaunchKpi,
  launchKpiPathOf,
  dependencyBlockersOf,
  type PreflightReport,
} from "../../src/core/workspace/trainingPreflight.js";
import { buildPreflightTool, runPreflightFlow, preflightScriptAvailable, type PreflightDeps } from "../../packages/extensions/atf-tools/src/preflightFace.js";
import { buildConfirmTools } from "../../packages/extensions/atf-tools/src/confirmFace.js";
import { WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/workspaceTools.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const mockPreflightCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight.mjs")}`;
const mockPreflightBadCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight_bad.mjs")}`;

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

const sessionExec = { agent: { session: { id: "sess-f1-test" } }, callId: "f1-call-1", signal: undefined };

/** ask 桩：按问题 id 前缀分发预设 selected；log 记录出卡顺序（断言「预检在前」）。 */
const makeUserQuestions = (
  script: ReadonlyArray<{ match: string; selected: string[] }>,
  log: string[],
) => ({
  ask: async (req: { questions: ReadonlyArray<{ id: string; options?: unknown; intent?: unknown }> }): Promise<{ answers: ReadonlyArray<{ id: string; selected: ReadonlyArray<string> }> }> => {
    // 形态分流：决策卡（options 形态、无 intent）不参与表单卡脚本与出卡顺序断言——
    // 本组断言的是「表单卡相对预检卡的顺序」。
    if (req.questions.every((item) => item.intent === undefined)) {
      return { answers: req.questions.map((item) => ({ id: item.id, selected: [] })) };
    }
    const question = req.questions[0];
    if (question === undefined) throw new Error("ask 桩收到空问题集");
    log.push(question.id);
    const step = script.find((entry) => question.id.startsWith(entry.match));
    return { answers: [{ id: question.id, selected: step === undefined ? [] : [...step.selected] }] };
  },
});

/** ctx 桩：手动档 permissionPresets＋approval（记录 reason）＋userQuestions。 */
const manualCtx = (
  askScript: ReadonlyArray<{ match: string; selected: string[] }>,
  askLog: string[],
  approvals: string[],
  approvalOutcome = "allowed-once",
) => ({
  get: (service: string) => {
    if (service === "permissionPresets") {
      return {
        current: () => "danger-full-access",
        defaultPreset: "danger-full-access",
        catalog: () => ({ options: [{ value: "danger-full-access", name: "Full access" }], defaultPreset: "danger-full-access" }),
      };
    }
    if (service === "approval") {
      return { request: async (req: { reason: string }) => { approvals.push(req.reason); return approvalOutcome; } };
    }
    if (service === "userQuestions") return makeUserQuestions(askScript, askLog);
    return undefined;
  },
});

const preflightDepsOf = (ctx: unknown, command = mockPreflightCommand, runsRoot = tempRoot("f1-runs-")): PreflightDeps =>
  ({ command, timeoutMs: 15_000, runsRoot, ctx: ctx as PreflightDeps["ctx"] });

// ── 1. 三态渲染（固定 schema 校验＋渲染单源）──

const SAMPLE_REPORT_JSON = `{
  "generated_at": "2026-10-24T08:00:00Z",
  "items": [
    {"id": "token_provider", "state": "missing", "detail": "token provider 未配置", "action": "配置 provider 或 --apply 内置计量", "depends_on": []},
    {"id": "token_budget", "state": "derivable", "detail": "prep/token_budget.json 缺失", "action": "--apply 用内置 provider 计量生成", "depends_on": ["token_provider"]},
    {"id": "coordinate_pending", "state": "derivable", "detail": "坐标换算 pending 3 对", "action": "--apply 整批重试", "depends_on": []},
    {"id": "grouping_preset", "state": "needs_confirm", "detail": "分组 preset 未定", "action": "确认分组方案 A/B", "depends_on": []}
  ],
  "order": ["token_provider", "token_budget", "coordinate_pending", "grouping_preset"],
  "summary": {"missing": 1, "derivable": 2, "confirm": 1}
}`;

describe("F1 §二.4-1 三态渲染——固定 schema 校验（fail-closed）", () => {
  it("好样例解析通过（三态各就位、order/summary 对账）", () => {
    const parsed = parsePreflightReport(SAMPLE_REPORT_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.report.items).toHaveLength(4);
    expect(parsed.report.summary).toEqual({ missing: 1, derivable: 2, confirm: 1 });
  });

  it("畸形逐键拒：非 JSON／缺 generated_at／state 越闭集／order 不对账／summary 缺键", () => {
    expect(parsePreflightReport("not-json").ok).toBe(false);
    const base = JSON.parse(SAMPLE_REPORT_JSON) as Record<string, unknown>;
    const mutate = (fn: (report: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      fn(copy);
      return JSON.stringify(copy);
    };
    expect(parsePreflightReport(mutate((r) => { delete r["generated_at"]; })).ok).toBe(false);
    expect(parsePreflightReport(mutate((r) => { ((r["items"] as Array<Record<string, unknown>>)[1] as Record<string, unknown>)["state"] = "maybe"; })).ok).toBe(false);
    expect(parsePreflightReport(mutate((r) => { r["order"] = ["token_provider"]; })).ok).toBe(false);
    expect(parsePreflightReport(mutate((r) => { delete (r["summary"] as Record<string, unknown>)["derivable"]; })).ok).toBe(false);
    // item.id 重复拒
    expect(parsePreflightReport(mutate((r) => { ((r["items"] as Array<Record<string, unknown>>)[2] as Record<string, unknown>)["id"] = "token_budget"; })).ok).toBe(false);
  });

  it("渲染：三态分组序（missing→derivable→needs_confirm）＋组内依赖链 order 序＋derivable 待依赖标注＋summary 尾行", () => {
    const parsed = parsePreflightReport(SAMPLE_REPORT_JSON);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = renderPreflightChecklist(parsed.report);
    // 三组头按态序
    const atMissing = text.indexOf("missing——环境/用户必须提供");
    const atDerivable = text.indexOf("derivable——可自动执行");
    const atConfirm = text.indexOf("needs_confirm——业务确认");
    expect(atMissing).toBeGreaterThanOrEqual(0);
    expect(atDerivable).toBeGreaterThan(atMissing);
    expect(atConfirm).toBeGreaterThan(atDerivable);
    // 组内依赖链序：token_budget 在 coordinate_pending 前（order 序，非字典序——coordinate < token）
    expect(text.indexOf("token_budget")).toBeLessThan(text.indexOf("coordinate_pending"));
    // 待依赖标注：token_budget 依赖 token_provider（在场＝未就绪）——不误报可立即派生
    expect(text).toContain("待依赖：token_provider 未就绪");
    // coordinate_pending 无依赖不标
    const coordBlock = text.slice(text.indexOf("coordinate_pending"), text.indexOf("grouping_preset"));
    expect(coordBlock).not.toContain("待依赖");
    // summary 尾行
    expect(text).toContain("missing 1／derivable 2／needs_confirm 1");
    // 依赖阻塞单源：清掉 provider 项后 token_budget 无阻塞
    const cleared: PreflightReport = { ...parsed.report, items: parsed.report.items.filter((item) => item.id !== "token_provider") };
    const budget = cleared.items.find((item) => item.id === "token_budget");
    expect(budget !== undefined ? dependencyBlockersOf(budget, cleared) : ["should-not-reach"]).toEqual([]);
  });

  it("全绿渲染：零问题项＝全绿文案（预检不替代段内校验注记在场）", () => {
    const text = renderPreflightChecklist({ generated_at: "2026-10-24T08:00:00Z", items: [], order: [], summary: { missing: 0, derivable: 0, confirm: 0 } });
    expect(text).toContain("预检全绿");
    expect(text).toContain("预检不替代段内校验");
  });
});

// ── 2. KPI 落盘（launch-kpi.json 首写固定）──

describe("F1 §二.4-3 KPI 落盘——preflight／first_launch_at 首写固定", () => {
  it("recordPreflightAt：首写落盘，重跑不覆盖（time-to-launch 基线不漂移）", () => {
    const runDir = tempRoot("f1-kpi-");
    expect(recordPreflightAt(runDir, "2026-10-24T08:00:00Z")).toBe(true);
    expect(readLaunchKpi(runDir)?.preflight).toBe("2026-10-24T08:00:00Z");
    recordPreflightAt(runDir, "2026-10-24T09:00:00Z");
    expect(readLaunchKpi(runDir)?.preflight).toBe("2026-10-24T08:00:00Z");
  });

  it("recordFirstLaunchAt：首写固定；两键共存互不干扰", () => {
    const runDir = tempRoot("f1-kpi-");
    recordPreflightAt(runDir, "2026-10-24T08:00:00Z");
    expect(recordFirstLaunchAt(runDir, "2026-10-24T08:14:00Z")).toBe(true);
    recordFirstLaunchAt(runDir, "2026-10-24T10:00:00Z");
    const kpi = readLaunchKpi(runDir);
    expect(kpi?.preflight).toBe("2026-10-24T08:00:00Z");
    expect(kpi?.first_launch_at).toBe("2026-10-24T08:14:00Z");
    expect(existsSync(launchKpiPathOf(runDir))).toBe(true);
  });

  it("放行成功路径实锚：launchExecuteHandler executed → run 目录 first_launch_at 落盘且重复放行不覆盖", async () => {
    const root = tempRoot("f1-launch-");
    const runDir = join(root, "run");
    const scratchDir = join(runDir, "scratch");
    mkdirSync(join(scratchDir, "out"), { recursive: true });
    writeFileSync(join(scratchDir, "out", "launch.sh"), [
      "#!/usr/bin/env bash",
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'mkdir -p "$SCRIPT_DIR/launch"',
      "sleep 0.1",
      'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
      '{"state": "started", "run_token": "stub", "pid": 4321, "log": "stub.log", "launcher_count": 1, "effect_started": true}',
      "EOF",
      "",
    ].join("\n"));
    const host: LocalToolHost = { scratchDir, kernelDir: root, home: root, baseEnv: {} };
    const handler = WORKSPACE_TOOL_HANDLERS["atf_launch_execute"];
    if (handler === undefined) throw new Error("atf_launch_execute handler 未注册");
    const first = await handler({ launch_sh: "out/launch.sh" }, host);
    expect(first.kind).toBe("executed");
    const kpiPath = join(runDir, "webui", "launch-kpi.json");
    expect(existsSync(kpiPath)).toBe(true);
    const firstAt = (JSON.parse(readFileSync(kpiPath, "utf8")) as { first_launch_at?: string }).first_launch_at;
    expect(typeof firstAt).toBe("string");
    // 二次放行（同 run）：first_launch_at 不漂移
    const second = await handler({ launch_sh: "out/launch.sh" }, host);
    expect(second.kind).toBe("executed");
    const secondAt = (JSON.parse(readFileSync(kpiPath, "utf8")) as { first_launch_at?: string }).first_launch_at;
    expect(secondAt).toBe(firstAt);
  });
});

// ── 3. apply 路径（工具面——授权恒走审批卡）──

describe("F1 §二.4-2 apply 路径——atf_training_preflight 工具面", () => {
  it("只读预检：三态清单＋待依赖＋可派生未执行指路；KPI preflight 首记", async () => {
    const runsRoot = tempRoot("f1-runs-");
    // E2 对齐：落点探测 fail-closed——run 目录须在场（实例 runsRoot 平铺兜底序 c）
    mkdirSync(join(runsRoot, "f1-apply-1"), { recursive: true });
    const askLog: string[] = [];
    const approvals: string[] = [];
    const deps = preflightDepsOf(manualCtx([
      { match: "preflight-", selected: ["grouping_preset=B"] },
    ], askLog, approvals), mockPreflightCommand, runsRoot);
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-1" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["checklist"]).toContain("needs_confirm——业务确认");
    expect(result["checklist"]).toContain("待依赖：token_provider 未就绪");
    // A3 收编：工具不弹卡，ask 项随 decisions 结构化回传（agent 对话流组织问询）
    expect(askLog).toEqual([]);
    const decisions = result["decisions"] as { access_mode: string; ask: number; entries: Array<{ question_id: string; mode: string }> };
    expect(decisions.access_mode).toBe("limited");
    expect(decisions.ask).toBe(2);
    expect(decisions.entries.map((entry) => entry.question_id).sort()).toEqual(["grouping", "token_provider"]);
    // 未申请 apply＝零审批卡；note 指路 agent 发起问询
    expect(approvals).toHaveLength(0);
    expect(String(result["note"])).toContain("待确认");
    // KPI 首记
    const runDir = join(runsRoot, "f1-apply-1");
    expect(readLaunchKpi(runDir)?.preflight).toBeDefined();
  });

  it("apply=true 直参：审批卡放行 → 内核 --apply 执行 → 执行后清单（derivable 清零）", async () => {
    const askLog: string[] = [];
    const approvals: string[] = [];
    const runsRoot = tempRoot("f1-runs-");
    mkdirSync(join(runsRoot, "f1-apply-2"), { recursive: true });
    const deps = preflightDepsOf(manualCtx([
      { match: "preflight-", selected: ["grouping_preset=B"] },
    ], askLog, approvals), mockPreflightCommand, runsRoot);
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-2", apply: true }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(result["applied"]).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("执行预检可派生项");
    expect(approvals[0]).toContain("token_budget");
    // apply 后清单：derivable 清零、missing/needs_confirm 原样（apply 只做 derivable）
    expect(result["summary"]).toEqual({ missing: 1, derivable: 0, confirm: 1 });
    expect(String(result["checklist"])).not.toContain("derivable——可自动执行");
  });

  it("apply 审批拒：不执行（applied 不在场）、原清单如实返回", async () => {
    const askLog: string[] = [];
    const approvals: string[] = [];
    const runsRoot = tempRoot("f1-runs-");
    mkdirSync(join(runsRoot, "f1-apply-3"), { recursive: true });
    const deps = preflightDepsOf(manualCtx([
      { match: "preflight-", selected: [] },
    ], askLog, approvals, "denied"), mockPreflightCommand, runsRoot);
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-3", apply: true }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect("applied" in result).toBe(false);
    expect(String(result["note"])).toContain("apply 未获放行");
    expect(result["summary"]).toEqual({ missing: 1, derivable: 2, confirm: 1 });
  });

  it("A3 收编：apply_derivables 卡上意愿路径退役——无 apply 直参零审批零执行（apply 只收工具参数）", async () => {
    const askLog: string[] = [];
    const approvals: string[] = [];
    const runsRoot = tempRoot("f1-runs-");
    mkdirSync(join(runsRoot, "f1-apply-4"), { recursive: true });
    const deps = preflightDepsOf(manualCtx([
      { match: "preflight-", selected: ["grouping_preset=B", "apply_derivables=yes"] },
    ], askLog, approvals), mockPreflightCommand, runsRoot);
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-4" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    // 卡上勾选行已删除：无 apply=true 直参＝不执行、不审批（确定性计算不占问询面）
    expect("applied" in result).toBe(false);
    expect(approvals).toHaveLength(0);
    expect(askLog).toEqual([]);
  });

  it("A3 收编：userQuestions 服务缺席零影响（工具本就不弹卡），decisions 照常回传", async () => {
    const approvals: string[] = [];
    const ctx = {
      get: (service: string) => {
        if (service === "approval") return { request: async () => "allowed-once" };
        return undefined;
      },
    };
    const deps = preflightDepsOf(ctx);
    mkdirSync(join(deps.runsRoot, "f1-apply-5"), { recursive: true });
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-5" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const decisions = result["decisions"] as { ask: number } | undefined;
    expect(decisions?.ask).toBe(2);
    expect(String(result["note"])).toContain("待确认");
    expect(String(result["checklist"])).toContain("needs_confirm——业务确认");
  });

  it("脚本缺席（pin 未含过渡态）：fail-closed 报 preflight_script_missing，不 mock 不猜", async () => {
    expect(preflightScriptAvailable("python3 /nonexistent/training_preflight.py")).toBe(false);
    const deps = preflightDepsOf(manualCtx([], [], []), "python3 /nonexistent/training_preflight.py");
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-6" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("preflight_script_missing");
  });

  it("schema 不符对端：结构化拒（preflight_schema_invalid），不猜不修", async () => {
    const deps = preflightDepsOf(manualCtx([], [], []), mockPreflightBadCommand);
    mkdirSync(join(deps.runsRoot, "f1-apply-7"), { recursive: true });
    const tool = findTool([buildPreflightTool(deps)], "atf_training_preflight");
    const result = (await tool.execute({ run_id: "f1-apply-7" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("preflight_schema_invalid");
  });
});

// ── 4. 预检卡在九要素前（confirmFace 前置——顺序机制保证）──

describe("F1 §二.4-4 预检卡在九要素前——config_confirm 前置预检（机制保证顺序）", () => {
  const CONFIRM_ASK_SCRIPT = [
    { match: "preflight-", selected: ["grouping_preset=B"] },
    { match: "config-confirm-", selected: ["max_total_tokens=9000"] },
  ];

  it("A3 收编：前置预检不再出卡（ask 清单进 preflightNote），唯一问卡＝九要素表单卡", async () => {
    const runsRoot = tempRoot("f1-order-");
    mkdirSync(join(runsRoot, "f1-order-1"), { recursive: true });
    const askLog: string[] = [];
    const approvals: string[] = [];
    const ctx = manualCtx(CONFIRM_ASK_SCRIPT, askLog, approvals);
    const tools = buildConfirmTools({ runsRoot, ctx, preflight: preflightDepsOf(ctx, mockPreflightCommand, runsRoot) });
    const configConfirm = findTool(tools, "atf_config_confirm");
    const result = (await configConfirm.execute({ action: "present", run_id: "f1-order-1" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    // 预检工具不再弹卡：唯一 ask＝九要素表单卡
    expect(askLog).toEqual(["config-confirm-f1-order-1"]);
    // 审批：九要素确认 1 次（apply 意愿已不进预检卡＝零 apply 审批）
    expect(approvals).toHaveLength(1);
    expect(String(result["preflight"])).toContain("missing——环境/用户必须提供");
    // KPI 首记（前置预检成功即落）
    expect(readLaunchKpi(join(runsRoot, "f1-order-1"))?.preflight).toBeDefined();
  });

  it("KPI preflight 已在场：不重跑预检（零多余卡），首问即九要素表单卡", async () => {
    const runsRoot = tempRoot("f1-order-");
    const runDir = join(runsRoot, "f1-order-2");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    writeFileSync(join(runDir, "webui", "launch-kpi.json"), `${JSON.stringify({ preflight: "2026-10-24T08:00:00Z" }, null, 1)}\n`);
    const askLog: string[] = [];
    const approvals: string[] = [];
    const ctx = manualCtx(CONFIRM_ASK_SCRIPT, askLog, approvals);
    const tools = buildConfirmTools({ runsRoot, ctx, preflight: preflightDepsOf(ctx, mockPreflightCommand, runsRoot) });
    const configConfirm = findTool(tools, "atf_config_confirm");
    const result = (await configConfirm.execute({ action: "present", run_id: "f1-order-2" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(askLog).toEqual(["config-confirm-f1-order-2"]);
  });

  it("装配缺席（deps.preflight undefined）：九要素链现状零回归（首问即表单卡）", async () => {
    const askLog: string[] = [];
    const approvals: string[] = [];
    const ctx = manualCtx(CONFIRM_ASK_SCRIPT, askLog, approvals);
    const runsRoot = tempRoot("f1-order-");
    // 夹具建模「run 已在场」（confirmFace 对解析不到的 run fail-closed——ADR-0018）
    mkdirSync(join(runsRoot, "f1-order-3"), { recursive: true });
    const tools = buildConfirmTools({ runsRoot, ctx });
    const configConfirm = findTool(tools, "atf_config_confirm");
    const result = (await configConfirm.execute({ action: "present", run_id: "f1-order-3" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(askLog).toEqual(["config-confirm-f1-order-3"]);
  });

  it("脚本缺席（pin 未含过渡态）：前置预检跳过，九要素链零回归", async () => {
    const runsRoot = tempRoot("f1-order-");
    // 夹具建模「run 已在场」（confirmFace 对解析不到的 run fail-closed——ADR-0018）
    mkdirSync(join(runsRoot, "f1-order-4"), { recursive: true });
    const askLog: string[] = [];
    const approvals: string[] = [];
    const ctx = manualCtx(CONFIRM_ASK_SCRIPT, askLog, approvals);
    const tools = buildConfirmTools({ runsRoot, ctx, preflight: preflightDepsOf(ctx, "python3 /nonexistent/training_preflight.py", runsRoot) });
    const configConfirm = findTool(tools, "atf_config_confirm");
    const result = (await configConfirm.execute({ action: "present", run_id: "f1-order-4" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(askLog).toEqual(["config-confirm-f1-order-4"]);
    expect("preflight" in result).toBe(false);
  });

  it("A3 收编：前置预检零卡零审批（apply_derivables 意愿路径退役），九要素链独走", async () => {
    const runsRoot = tempRoot("f1-order-");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const ctx = manualCtx([
      { match: "preflight-", selected: ["grouping_preset=B", "apply_derivables=yes"] },
      { match: "config-confirm-", selected: ["max_total_tokens=9000"] },
    ], askLog, approvals);
    mkdirSync(join(runsRoot, "f1-order-5"), { recursive: true });
    const tools = buildConfirmTools({ runsRoot, ctx, preflight: preflightDepsOf(ctx, mockPreflightCommand, runsRoot) });
    const configConfirm = findTool(tools, "atf_config_confirm");
    const result = (await configConfirm.execute({ action: "present", run_id: "f1-order-5" }, sessionExec)) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    // 前置预检零弹卡：apply_derivables 勾选即使出现也无人消费（preflight- 前缀无卡可答）
    expect(askLog).toEqual(["config-confirm-f1-order-5"]);
    // 审批：仅九要素确认 1 次（派生项执行申请改走 atf_training_preflight apply=true 直参）
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("确认训练配置并落快照");
  });

  it("runPreflightFlow 直调：全绿报告不出卡零审批（只记 KPI）——全绿零介入锚", async () => {
    const runsRoot = tempRoot("f1-green-");
    const askLog: string[] = [];
    const approvals: string[] = [];
    const greenCommand = `node ${join(repoRoot, "tests", "fixtures", "mock_preflight_green.mjs")}`;
    mkdirSync(join(runsRoot, "f1-green-1"), { recursive: true });
    const deps = preflightDepsOf(manualCtx([], askLog, approvals), greenCommand, runsRoot);
    const outcome = await runPreflightFlow(deps, { runId: "f1-green-1", apply: false }, sessionExec);
    expect(outcome.ok).toBe(true);
    expect(askLog).toEqual([]);
    expect(approvals).toHaveLength(0);
    expect(outcome.report?.items).toEqual([]);
    expect(readLaunchKpi(join(runsRoot, "f1-green-1"))?.preflight).toBeDefined();
  });
});
