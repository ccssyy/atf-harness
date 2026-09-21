/**
 * F6 harness 侧小批门 2（裁定件 v2 §二；门 2 放行件 7e51dcc7…）。用例五组：
 * ① canonical 两态（mock --ws-overview 缺省关，概览透传不 fail-closed）
 * ② 状态面渲染（人读行＋禁直出工程语）
 * ③ guidance 文案修正断言（invalid_params 含"路径不存在或不可达/先探测实际形态"；禁含"示例"）
 * ④ 描述层指引断言（两工具"先探测/查看实际数据形态"；禁含具名形态示例）
 * ⑤ §三 双面覆盖：FakeLlmEndpoint＋HttpLlmProvider 走真投影路径（状态面调用 → 下一拍 decide 成功）
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import {
  FakeLlmEndpoint,
  HttpLlmProvider,
  loadLlmProviderConfig,
  type LlmProvider,
  type Scenario,
} from "../../src/llm/index.js";
import { ScenarioRunner, guidanceLineFor, type BranchRunReport } from "../../src/core/run/index.js";
import { ToolRegistry } from "../../src/core/tools/index.js";
import { formatEventDetailLines, formatEventLine, statusOverviewLines } from "../../src/ui/eventView.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const scenarioOf = (runId: string, instruction: string): Scenario => ({
  scenario_id: "f6-status-face",
  version: 1,
  provider: "faux",
  description: "F6 harness 侧小批门 2 测试",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "f6-status-face",
      setup: { ledger: [] },
      steps: [],
      expect: { outcome: "completed", exit_code: 0 },
    },
  },
});

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "f6-host" });
const runsRootOf = (): string => join(repoRoot, "tmp", "runs", `f6-${randomUUID()}`);

const resultsOf = (report: BranchRunReport): Array<{ tool?: string; ok?: boolean; result?: unknown }> =>
  report.events
    .filter((event) => event.type === "tool/result")
    .map((event) => event.payload as { tool?: string; ok?: boolean; result?: unknown });

describe("F6 用例 ①：canonical 两态（概览透传，多返回字段不 fail-closed）", () => {
  it("不带概览（旗标缺省关）→ 照常执行（既有行为零回归）", async () => {
    const ran = await ScenarioRunner.runBranch(scenarioOf(`f6-off-${randomUUID()}`, "查状态"), "main", {
      runsRoot: runsRootOf(),
      mockCommand: ["node", mockPath],
      modelProvider: {
        providerId: "f6-stub",
        decide: async () => ok({ type: "tool_call", tool: "atf_workspace_status", params: {} }),
      },
      approvalSurface: { stub: grantedStub },
    });
    expect(ran.ok).toBe(true);
    if (!ran.ok) throw new Error("unreachable");
    const result = resultsOf(ran.value).find((entry) => entry.tool === "atf_workspace_status");
    expect(result?.ok).toBe(true);
    expect((result?.result as Record<string, unknown>)["datasets"]).toBeUndefined();
  });

  it("带概览（--ws-overview）→ datasets/human_summary 透传通过 canonical（多返回字段不拦）", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const sourceRoot = mkdtempSync(join(tmpdir(), "f6-src-"));
    const splitRoot = mkdtempSync(join(tmpdir(), "f6-split-"));
    const runsRoot = runsRootOf();
    const runId = `f6-on-${randomUUID()}`;
    // 先登记后查状态——同一会话（mock 登记态在进程内存，跨进程不承接）
    const registerQueue: Array<{ type: "tool_call"; tool: string; params: Record<string, unknown> } | { type: "final_answer"; text: string }> = [
      { type: "tool_call", tool: "atf_admit_data", params: { source_root: sourceRoot, split_root: splitRoot } },
      { type: "tool_call", tool: "atf_workspace_status", params: {} },
      { type: "final_answer", text: "登记并核对状态完成。" },
    ];
    const first = await ScenarioRunner.runBranch(scenarioOf(runId, "登记数据"), "main", {
      runsRoot,
      mockCommand: ["node", mockPath, "--ws-overview"],
      modelProvider: {
        providerId: "f6-stub",
        decide: async () => {
          const next = registerQueue.shift();
          return ok(next ?? { type: "final_answer", text: "登记并核对状态完成。" });
        },
      },
      approvalSurface: { stub: grantedStub },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.outcome.kind).toBe("completed");
    const derivedId = ((resultsOf(first.value).find((entry) => entry.tool === "atf_admit_data")?.result as Record<string, unknown>)["dataset_id"] as string) ?? "ds-x";
    // 同会话（同 mock 进程内登记态）取状态面结果
    const ran = first;
    const result = resultsOf(ran.value).find((entry) => entry.tool === "atf_workspace_status");
    expect(result?.ok).toBe(true);
    const value = (result?.result ?? {}) as Record<string, unknown>;
    expect(Array.isArray(value["datasets"])).toBe(true);
    const firstDataset = (value["datasets"] as unknown[])[0] as Record<string, unknown>;
    expect(typeof firstDataset["fact_id"]).toBe("string");
    expect((firstDataset["fact_id"] as string).startsWith(derivedId)).toBe(true);
    expect(typeof firstDataset["shape_summary"]).toBe("string");
    expect((value["human_summary"] as Record<string, unknown>)["headline"]).toBeDefined();
  });
});

describe("F6 用例 ②：状态面渲染（人读行＋禁直出工程语）", () => {
  const overviewResult = {
    ok: true,
    run_id: "r1",
    admitted_count: 1,
    scope_ref: { project_id: "p", scope_type: "run", scope_id: "r1", scope_mode: "headless" },
    datasets: [{ fact_id: "ds-abc123def456@0123456789ab", shape_summary: "成对样本 50 张（png×json 成对）", registered_at: "2026-09-21T12:00:00Z" }],
    human_summary: {
      headline: "工作区已有 1 批已登记数据。",
      sections: [{ title: "已登记：ds-abc123def456", items: ["形态摘要：成对样本 50 张。"] }],
      pending_confirmations: [],
      notes: [],
    },
  };
  const event = (id: number) => ({
    id,
    ts: "2026-09-21T00:00:00Z",
    type: "tool/result" as const,
    payload: { tool: "atf_workspace_status", ok: true, result: overviewResult, call_ref: 1 },
    projection: { evidence_event: null },
  });

  it("机器行人读化＋detail-lines 人读行（human_summary 优先）", () => {
    const line = formatEventLine(event(7), "live");
    expect(line).toContain("已登记 1 批");
    expect(line).not.toContain('"datasets"');
    const details = formatEventDetailLines(event(7));
    const text = details.join("\n");
    expect(details[0]).toMatch(/^#0007 /);
    expect(text).toContain("工作区已有 1 批已登记数据");
    expect(text).toContain("· 已登记：ds-abc123def456");
  });

  it("禁直出工程语：digest／schema 名／snake_case 行降级为中性提示", () => {
    const leaked = {
      ok: true,
      run_id: "r1",
      admitted_count: 1,
      scope_ref: { project_id: "p", scope_type: "run", scope_id: "r1", scope_mode: "headless" },
      datasets: [{ fact_id: "ds-x", shape_summary: `split_integrity_unavailable digest=${"a".repeat(64)} (DatasetSplitPolicy/v2)` }],
    };
    const lines = statusOverviewLines(leaked);
    expect(lines.join("\n")).not.toContain("split_integrity_unavailable");
    expect(lines.join("\n")).not.toContain("a".repeat(64));
    expect(lines.join("\n")).not.toContain("DatasetSplitPolicy/v2");
    expect(lines.join("\n")).toContain("已收起");
  });

  it("两字段皆无 → 单行人读现状（兜底）", () => {
    const lines = statusOverviewLines({ ok: true, run_id: "r1", admitted_count: 0, scope_ref: {} });
    expect(lines).toEqual(["工作区暂无已登记数据集"]);
  });
});

describe("F6 用例 ③：guidance 文案修正断言（invalid_params；F6-b 改向）", () => {
  it("一行文案含『路径不存在或不可达』与『先探测实际形态，再决定来源根与整备方式』；禁含『示例』字样", () => {
    const line = guidanceLineFor("invalid_params");
    expect(line).toBeDefined();
    expect(line ?? "").toContain("路径不存在或不可达");
    expect(line ?? "").toContain("先探测实际形态，再决定来源根与整备方式");
    expect(line ?? "").not.toContain("示例");
  });
});

describe("F6 用例 ④：描述层指引断言（两工具；F6-b 改向）", () => {
  it("正向：两工具描述含『先探测/查看实际数据形态』；负向：不得含具名形态示例片段", () => {
    const registry = ToolRegistry.createDefault();
    for (const name of ["atf_admit_data", "atf_data_admission_request"]) {
      const definition = registry.get(name);
      expect(definition.ok).toBe(true);
      if (!definition.ok) continue;
      expect(definition.value.description).toContain("先探测/查看实际数据形态");
      // F6-b 负向断言：具名形态示例已删（normalized/<类型>/groups/…、png×json）
      for (const forbidden of ["normalized/", "groups/", "<类型>", "png×json"]) {
        expect(definition.value.description, `${name} 描述不得含 "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });
});

describe("F6 用例 ⑤：§三 双面覆盖——http 投影路径（状态面 → 下一拍 decide 成功）", () => {
  it("FakeLlmEndpoint＋HttpLlmProvider：概览回流后第二拍投影成功并收束（completed）", { timeout: 60_000 }, async () => {
    const endpoint = await FakeLlmEndpoint.start({
      protocol: "openai-chat",
      script: [
        { kind: "response", response: { tool_calls: [{ tool: "atf_workspace_status", params: {} }] } },
        { kind: "response", response: { final_answer: "已按工作区现状核对来源根形态，等待指示。" } },
      ],
      expectedApiKey: "f6-fake-key",
      model: "f6-fake-model",
    });
    try {
      const configPath = join(repoRoot, "tmp", `f6-cfg-${Date.now()}.json`);
      const { writeFile, chmod } = await import("node:fs/promises");
      await writeFile(
        configPath,
        JSON.stringify({
          schema_version: "HarnessLlmConfig/v3",
          default_provider: "f6-fake",
          timeout_ms: 30000,
          providers: {
            "f6-fake": {
              protocol: "openai-chat",
              base_url: endpoint.baseUrl,
              api_key_env: "F6_FAKE_KEY_ENV",
              models: [{ id: "f6-fake-model", reasoning: false, max_tokens: 4096 }],
            },
          },
        }),
        { mode: 0o600 },
      );
      await chmod(configPath, 0o600);
      const loaded = await loadLlmProviderConfig({ ATF_LLM_CONFIG: configPath, F6_FAKE_KEY_ENV: "f6-fake-key" });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const provider: LlmProvider = new HttpLlmProvider({ config: loaded.value, tools: ToolRegistry.createDefault().modelVisible() });
      const ran = await ScenarioRunner.runBranch(scenarioOf(`f6-http-${randomUUID()}`, "看工作区里有什么数据"), "main", {
        runsRoot: runsRootOf(),
        mockCommand: ["node", mockPath, "--ws-overview"],
        modelProvider: provider,
        approvalSurface: { stub: grantedStub },
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      // 概览透传不 fail-closed：投影两拍全通（第二拍在概览回流之后）
      expect(ran.value.outcome.kind).toBe("completed");
      expect(ran.value.exit_code).toBe(0);
      // 该拍确经真投影路径：伪端点恰收到两次请求（首拍状态面＋次拍收束）
      expect(endpoint.requests.length).toBe(2);
    } finally {
      await endpoint.close().catch(() => undefined);
    }
  });
});
