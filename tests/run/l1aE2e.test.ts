/**
 * L1a 门 2 端到端测试（任务书 §3 VERIFY 3–7；本地假端点 + mock 对端 + 真实 runner 全链）。
 * 通道应答经 runner resume 面在进程内提交（CLI 子进程路径由 smoke:l1a 实跑承载）。
 * 零真实网络：假端点恒绑 127.0.0.1；config base_url 指向回环（零外连断言见假端点台账）。
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeLlmEndpoint,
  HttpLlmProvider,
  LLM_CONFIG_SCHEMA_VERSION,
  loadLlmProviderConfig,
  PROVIDER_ENV_VARS,
  type FakeEndpointScriptItem,
  type ResolvedLlmProviderConfig,
} from "../../src/llm/index.js";
import type { Scenario, ScenarioStep } from "../../src/llm/index.js";
import { ScenarioRunner, deriveLoopStateFromEvents, type ApprovalStubResponse, type BranchRunReport } from "../../src/core/run/index.js";
import { ToolRegistry } from "../../src/core/tools/index.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const FAKE_KEY = "fake-l1a-e2e-key-DO-NOT-USE";
/** 修订 v2：配置文件只留凭据引用（api_key_env 指向本环境变量名）。 */
const FAKE_KEY_ENV = "ATF_LLM_KEY_E2E_FAKE";
const FAKE_MODEL = "fake-model-l1a-e2e";
const FAKE_PROVIDER = "local-fake";

let scenarioSeq = 0;
const workDirs: string[] = [];
const endpoints: FakeLlmEndpoint[] = [];

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  await Promise.all(workDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Rig {
  runsRoot: string;
  config: ResolvedLlmProviderConfig;
  requestsOf: () => readonly string[];
}

/** 建一套假端点 + 配置文件 + runs 根（协议可选；脚本按测试声明）。 */
const makeRig = async (
  script: FakeEndpointScriptItem[],
  overrides: Partial<Record<string, unknown>> = {},
  protocol: "openai-chat" | "anthropic-messages" = "openai-chat",
): Promise<Rig> => {
  const endpoint = await FakeLlmEndpoint.start({ protocol, script: [...script], expectedApiKey: FAKE_KEY, model: FAKE_MODEL });
  endpoints.push(endpoint);
  const workDir = join(tmpdir(), `atf-l1a-e2e-${randomUUID()}`);
  await mkdir(join(workDir, "runs"), { recursive: true });
  workDirs.push(workDir);
  const configPath = join(workDir, "llm.config.json");
  const { timeout_ms, max_retries, max_calls_per_run } = overrides as Record<string, unknown>;
  await writeFile(
    configPath,
    JSON.stringify({
      // 修订 v2 两层清单：凭据只留引用（api_key_env），假 key 运行期注入环境变量
      schema_version: LLM_CONFIG_SCHEMA_VERSION,
      default_provider: FAKE_PROVIDER,
      ...(timeout_ms !== undefined ? { timeout_ms } : {}),
      ...(max_retries !== undefined ? { max_retries } : {}),
      ...(max_calls_per_run !== undefined ? { max_calls_per_run } : {}),
      providers: {
        [FAKE_PROVIDER]: {
          protocol,
          base_url: endpoint.baseUrl,
          api_key_env: FAKE_KEY_ENV,
          models: [{ id: FAKE_MODEL, reasoning: false, max_tokens: 4096 }],
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  const loaded = await loadLlmProviderConfig({
    [PROVIDER_ENV_VARS.configPath]: configPath,
    [FAKE_KEY_ENV]: FAKE_KEY,
  });
  if (!loaded.ok) throw new Error(`rig 配置失败: ${loaded.error.message}`);
  return { runsRoot: join(workDir, "runs"), config: loaded.value, requestsOf: () => endpoint.requests.map((r) => r.path) };
};

let runSeq = 0;
const makeScenario = (opts: { gatePreRecord: boolean; runLabel: string }): Scenario => {
  scenarioSeq += 1;
  return {
    scenario_id: `l1a-e2e-${String(scenarioSeq)}`,
    version: 1,
    provider: "faux",
    description: "L1a 门 2 e2e",
    branches: {
      main: {
        branch_id: "main",
        run_id: `run-l1a-e2e-${opts.runLabel}-${String(scenarioSeq)}`,
        trigger_instruction: "读取事实索引，报告数据集登记与闸门状态并给建议；如需准入发起 atf_admit_data。",
        purpose: "L1a e2e",
        setup: { ledger: opts.gatePreRecord ? [{ tool: "atf_gate", params: { gate: "g1", action: "query" } }] : [] },
        steps: [],
        expect: { outcome: "completed", exit_code: 0 },
      },
    },
  };
};

const providerOf = (rig: Rig, overrides: Partial<Record<string, unknown>> = {}): HttpLlmProvider =>
  new HttpLlmProvider({
    config: (overrides === undefined ? rig.config : ({ ...rig.config, ...overrides } as ResolvedLlmProviderConfig)),
    tools: ToolRegistry.createDefault().modelVisible(),
  });

const TIMEOUT_STUB = async (): Promise<ApprovalStubResponse> => ({ verdict: "timeout" });

const run = async (
  rig: Rig,
  scenario: Scenario,
  provider: HttpLlmProvider,
  resume?: { verdict: "granted" | "advised" | "denied" | "abort"; note?: string; request_event_id?: number },
): Promise<BranchRunReport> => {
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: rig.runsRoot,
    mockCommand: ["node", mockPath],
    modelProvider: provider,
    modelId: FAKE_MODEL,
    approvalSurface: { stub: TIMEOUT_STUB },
    ...(resume !== undefined ? { resume } : {}),
  });
  if (!ran.ok) throw new Error(`runner 失败: ${ran.error.message}`);
  return ran.value;
};

const toolResults = (report: BranchRunReport) =>
  report.events.filter((event) => event.type === "tool/result").map((event) => event.payload as { tool: string; ok: boolean; call_ref?: number; reason?: string });

const requests = (report: BranchRunReport) => report.events.filter((event) => event.type === "approval/request").map((event) => ({ id: event.id, payload: event.payload as Record<string, unknown> }));
const responses = (report: BranchRunReport) => report.events.filter((event) => event.type === "approval/response").map((event) => event.payload as Record<string, unknown>);

// 只读链脚本（bind_run 由 runner 桥接承载，非模型工具）
const RO: FakeEndpointScriptItem[] = [
  { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_fact_scan", params: {} }] } },
  { kind: "response", response: { tool_calls: [{ tool: "atf_gate", params: { gate: "g1", action: "query" } }] } },
  { kind: "response", response: { final_answer: "闸门 G1 通过；无待登记数据集；建议保持监控。" } },
];

describe("VERIFY 3——只读链路自主完成（假端点，零人工干预）", () => {
  it("workspace_status → fact_scan → gate(query) → final_answer；无审批事件；请求全命中回环", async () => {
    const rig = await makeRig(RO);
    const provider = providerOf(rig);
    const report = await run(rig, makeScenario({ gatePreRecord: true, runLabel: "ro" }), provider);
    expect(report.outcome.kind).toBe("completed");
    expect(report.exit_code).toBe(0);
    const results = toolResults(report);
    expect(results.filter((r) => r.ok)).toHaveLength(3); // ws / fact_scan / gate(query)
    expect(results.find((r) => r.tool === "atf_gate")).toBeDefined();
    expect(report.events.some((event) => event.type === "approval/request")).toBe(false); // 零人工干预
    // 零外连：全部请求命中回环协议路径（台账）
    for (const path of rig.requestsOf()) expect(path).toBe("/v1/chat/completions");
    expect(rig.requestsOf()).toHaveLength(provider.calls);
  });
});

describe("VERIFY 4/5——挂起闭环 + 人放行闭环", () => {
  const SUSPEND: FakeEndpointScriptItem[] = [
    ...RO.slice(0, 3),
    { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-l1a-e2e" } }] } },
    { kind: "response", response: { final_answer: "数据集 ds-l1a-e2e 已准入；G1 通过；建议推进 G2。" } },
  ];

  it("触发 admit → approval/request + exit 75 + turn 收口（INV-2）；CLI 面应答 → resume 开新 turn → 真正执行", async () => {
    const rig = await makeRig(SUSPEND);
    const scenario = makeScenario({ gatePreRecord: true, runLabel: "grant" });
    const report1 = await run(rig, scenario, providerOf(rig));
    // 挂起闭环
    expect(report1.outcome.kind).toBe("suspended");
    expect(report1.exit_code).toBe(75);
    const turnEnds1 = report1.events.filter((event) => event.type === "turn/end");
    expect((turnEnds1.at(-1)?.payload as { reason?: string }).reason).toBe("suspended"); // INV-2
    const request1 = requests(report1)[0];
    expect(request1?.payload["tool"]).toBe("atf_admit_data");
    const callEvent = report1.events.find(
      (event) => event.type === "tool/call" && (event.payload as { tool?: string }).tool === "atf_admit_data",
    );
    // 人放行闭环（进程内通道应答；CLI 子进程路径见 smoke:l1a）
    const report2 = await run(rig, scenario, providerOf(rig), {
      verdict: "granted",
      note: "同意准入（已备案）",
      request_event_id: request1?.id,
    });
    expect(report2.outcome.kind).toBe("completed");
    expect(report2.exit_code).toBe(0);
    // INV-1：resume 开新 turn；durability：turn 计数自事件流推导
    expect(deriveLoopStateFromEvents(report2.events).turns_opened).toBe(2);
    // 答复落事件（actor=cli-operator）
    const granted = responses(report2).find((payload) => payload["verdict"] === "granted");
    expect(granted).toMatchObject({ actor: "cli-operator", request_event_ref: request1?.id });
    // 动作真正执行（可复核证据：ok=true + call_ref 与原 tool/call 配对——重派复用原事件 id）
    const executed = toolResults(report2).find((r) => r.tool === "atf_admit_data" && r.ok === true);
    expect(executed?.call_ref).toBe(callEvent?.id);
    expect(report2.events.some((event) => event.type === "assistant/message")).toBe(true); // 模型收束
    // 脱敏：两份报告全序列化不含 fake key
    expect(JSON.stringify([report1, report2])).not.toContain(FAKE_KEY);
  });

  it("resume 前置 fail-closed：非挂起流拒绝恢复", async () => {
    const rig = await makeRig(RO);
    const scenario = makeScenario({ gatePreRecord: true, runLabel: "nosusp" });
    const completed = await run(rig, scenario, providerOf(rig));
    expect(completed.outcome.kind).toBe("completed");
    const refused = await run(rig, scenario, providerOf(rig), { verdict: "granted" });
    expect(refused.outcome.kind).toBe("failed");
    if (refused.outcome.kind === "failed") {
      expect(refused.outcome.error.code).toBe("invalid_input");
      expect(refused.outcome.error.message).toContain("suspended");
    }
  });
});

describe("VERIFY 6——拒绝/建议/中止分支", () => {
  it("denied → 动作不执行且可解释；模型换路径收束", async () => {
    const rig = await makeRig([
      { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
      { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-denied" } }] } },
      { kind: "response", response: { final_answer: "准入被拒（未备案）；建议先完成数据集备案后重试。" } },
    ]);
    const scenario = makeScenario({ gatePreRecord: false, runLabel: "deny" });
    const report1 = await run(rig, scenario, providerOf(rig));
    const request1 = requests(report1)[0];
    const report2 = await run(rig, scenario, providerOf(rig), {
      verdict: "denied",
      note: "数据集未备案，不予准入",
      request_event_id: request1?.id,
    });
    expect(report2.outcome.kind).toBe("completed");
    // 动作未执行：无 atf_admit_data 成功回填
    expect(toolResults(report2).some((r) => r.tool === "atf_admit_data" && r.ok === true)).toBe(false);
    // 可解释：denied 应答（含人读理由）落流内
    const denied = responses(report2).find((payload) => payload["verdict"] === "denied");
    expect(denied).toMatchObject({ actor: "cli-operator", reason: "数据集未备案，不予准入" });
  });

  it("advised → 建议回填（不构成放行）→ 模型重提案（supersedes 链跨进程延续）→ 再挂起 → granted 执行", async () => {
    const rig = await makeRig([
      { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
      { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-adv" } }] } },
      { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-adv" } }] } },
      { kind: "response", response: { final_answer: "数据集已准入；建议归档草案。" } },
    ]);
    const scenario = makeScenario({ gatePreRecord: false, runLabel: "advise" });
    const report1 = await run(rig, scenario, providerOf(rig));
    const request1 = requests(report1)[0];
    // 第一轮：advised（不构成放行——无任何执行回填）
    const report2 = await run(rig, scenario, providerOf(rig), {
      verdict: "advised",
      note: "补备案说明后重提",
      request_event_id: request1?.id,
    });
    expect(report2.outcome.kind).toBe("suspended"); // 重提案再次等待人工（headless 超时挂起）
    expect(toolResults(report2).some((r) => r.tool === "atf_admit_data" && r.ok === true)).toBe(false); // 未执行
    const advised = responses(report2).find((payload) => payload["verdict"] === "advised");
    expect(advised?.["advice_text"]).toBe("补备案说明后重提");
    // 重提案（同提案键）：跨进程 supersedes 链延续（attempt+1 指回原 request）
    const request2 = requests(report2).at(-1);
    expect(request2?.payload).toMatchObject({ attempt: 2, supersedes: request1?.id });
    // 第二轮：granted → 执行 → 收束
    const report3 = await run(rig, scenario, providerOf(rig), {
      verdict: "granted",
      request_event_id: request2?.id,
    });
    expect(report3.outcome.kind).toBe("completed");
    const executed = toolResults(report3).find((r) => r.tool === "atf_admit_data" && r.ok === true);
    expect(executed).toBeDefined();
  });

  it("abort → run 终态 exit 79；不开新 turn；动作不执行", async () => {
    const rig = await makeRig([
      { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
      { kind: "response", response: { tool_calls: [{ tool: "atf_admit_data", params: { dataset_id: "ds-abort" } }] } },
      { kind: "response", response: { final_answer: "不可达" } },
    ]);
    const scenario = makeScenario({ gatePreRecord: false, runLabel: "abort" });
    const report1 = await run(rig, scenario, providerOf(rig));
    const request1 = requests(report1)[0];
    const report2 = await run(rig, scenario, providerOf(rig), {
      verdict: "abort",
      note: "任务取消",
      request_event_id: request1?.id,
    });
    expect(report2.outcome.kind).toBe("aborted");
    expect(report2.exit_code).toBe(79);
    expect(report2.events.filter((event) => event.type === "turn/start")).toHaveLength(1); // 仅 run 1 的 turn
    expect(toolResults(report2).some((r) => r.tool === "atf_admit_data" && r.ok === true)).toBe(false);
  });
});

describe("VERIFY 7——成本护栏（max_calls_per_run，与轮次预算正交）", () => {
  it("超上限 → 收敛且原因可区分（call_budget_exhausted）", async () => {
    const rig = await makeRig(RO, { max_calls_per_run: 2 });
    const provider = providerOf(rig);
    const report = await run(rig, makeScenario({ gatePreRecord: true, runLabel: "budget" }), provider);
    expect(report.outcome.kind).toBe("failed");
    if (report.outcome.kind !== "failed") return;
    // runner 折算 provider_failure 终局；原始错误码在 detail 内可区分（非轮次预算 32/8）
    expect(report.outcome.error.code).toBe("provider_failure");
    expect((report.outcome.error.detail as { code?: string }).code).toBe("call_budget_exhausted");
    expect((report.outcome.error.detail as { detail?: { limit?: number } }).detail?.limit).toBe(2);
  });
});

describe("anthropic-messages 协议全链（codec 互换性）", () => {
  it("同型闭环在 anthropic-messages 下成立（只读链）", async () => {
    const rig = await makeRig(RO, {}, "anthropic-messages");
    const provider = providerOf(rig);
    const report = await run(rig, makeScenario({ gatePreRecord: true, runLabel: "anthro" }), provider);
    expect(report.outcome.kind).toBe("completed");
    expect(toolResults(report).filter((r) => r.ok)).toHaveLength(3);
    for (const path of rig.requestsOf()) expect(path).toBe("/v1/messages");
  });
});
