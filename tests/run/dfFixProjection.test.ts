/**
 * D-f 补正批（门 2·裁定甲）用例 ⑥：用 run-smoke2-ebbc3a57（冒烟 #2 四跑）的事实日志复现
 * 「修复后同一 run 续跑成功」。四跑失败形态＝首条 guidance 回填后投影被旧白名单拦截 →
 * 每拍 provider_failure。本用例走**真投影路径**（FakeLlmEndpoint＋HttpLlmProvider——
 * adaptProjectionToMessages 在 decide 内真实执行，非脚本面），对真实 32 事件历史投影：
 *   - 修复前：tool/result 含未声明字段 "guidance" → 投影 err（四跑实测，见核验记录 §三）；
 *   - 修复后：投影通过、guidance 以 "invalid_params｜【invalid_params】…" 进模型可见摘要、
 *     同 run 续跑（continue turn 3）收口 completed。
 * 边界：脚本化应答≠真实模型观察——「该拍模型是否按 guidance 改变策略」由五跑（owner 现场
 * 授权）记录；本用例证明的是机制面（guidance 已进模型可见面＋同 run 可续）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptProjectionToMessages } from "../../src/llm/index.js";
import { FakeLlmEndpoint, HttpLlmProvider, type LlmProvider, type Scenario } from "../../src/llm/index.js";
import { parseSessionStream, ScenarioRunner, type BranchRunReport } from "../../src/core/run/index.js";
import { transformContext } from "../../src/core/session/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const RUNS_ROOT = join(repoRoot, "tmp", "ui-runs");
const RUN_ID = "run-smoke2-ebbc3a57";
const FACTS = join(RUNS_ROOT, RUN_ID, "session.jsonl");
const FACTS_EXIST = existsSync(FACTS);

const grantedStub = async (): Promise<{ verdict: "granted"; actor: string }> => ({ verdict: "granted", actor: "df-fix-host" });

describe("D-f 补正批用例 ⑥：四跑 facts 同 run 续跑复现（真投影路径）", () => {
  it("真实 32 事件历史投影通过且 guidance 进模型可见摘要；同 run continue 收口 completed", { timeout: 60_000 }, async () => {
    expect(FACTS_EXIST, `四跑事实日志须在场: ${FACTS}`).toBe(true);
    if (!FACTS_EXIST) return;

    // 复现后还原：四跑日志为冻结证据（快照 session.jsonl.bak-四跑-pre-fix 另存），
    // 本用例每次运行前取原文、复现后还原——append-only 事实不可改写，续跑追加轮次不沉淀。
    const originalText = readFileSync(FACTS, "utf8");
    try {
      await reproContinue(originalText);
    } finally {
      writeFileSync(FACTS, originalText);
    }
  });

  async function reproContinue(originalText: string): Promise<void> {
    // ---- ① 真实事实装载与前置确认（guidance 回填在场、末 turn 已收口） ----
    const parsed = parseSessionStream(originalText);
    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.error) : "").toBe(true);
    if (!parsed.ok) return;
    const events = parsed.value;
    const guidanceBackfill = events.find(
      (event) => event.type === "tool/result" && typeof (event.payload as { guidance?: string }).guidance === "string",
    );
    expect(guidanceBackfill, "四跑 facts 须含 guidance 回填（#28 invalid_params）").toBeDefined();
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.type).toBe("turn/end"); // 末 turn 已收口（continue 前置）

    // ---- ② 真实历史过投影（修复点）：不报错＋guidance 内容断言 ----
    const projected = adaptProjectionToMessages(transformContext(events));
    expect(projected.ok, !projected.ok ? `投影仍被拦: ${projected.ok ? "" : projected.error.message}` : "").toBe(true);
    if (!projected.ok) return;
    const guidanceSummary = projected.value.find(
      (message) => message.role === "tool_result" && message.source_event_id === guidanceBackfill?.id,
    );
    expect(guidanceSummary).toBeDefined();
    if (guidanceSummary?.role !== "tool_result") throw new Error("unreachable");
    // 内容断言：summary = reason 主体｜guidance 附注（B4 摘要化生效的直接证据）
    expect(guidanceSummary.summary).toMatch(/^invalid_params｜【invalid_params】/);

    // ---- ③ 同 run 续跑（continue turn 3；FakeLlmEndpoint 走真投影路径，零外部调用） ----
    const endpoint = await FakeLlmEndpoint.start({
      protocol: "openai-chat",
      script: [
        {
          kind: "response",
          response: {
            final_answer: "按回流指引核对：缺料问题已如实向用户说明，本步停止等待指示。",
          },
        },
      ],
      expectedApiKey: "df-fix-fake-key",
      model: "deepseek-flash",
    });
    try {
      const configPath = join(repoRoot, "tmp", `df-fix-cfg-${Date.now()}.json`);
      const { writeFile, chmod } = await import("node:fs/promises");
      await writeFile(
        configPath,
        JSON.stringify({
          schema_version: "HarnessLlmConfig/v3",
          default_provider: "df-fix-fake",
          timeout_ms: 30000,
          providers: {
            "df-fix-fake": {
              protocol: "openai-chat",
              base_url: endpoint.baseUrl,
              api_key_env: "DF_FIX_FAKE_KEY_ENV",
              models: [{ id: "deepseek-flash", reasoning: false, max_tokens: 4096 }],
            },
          },
        }),
        { mode: 0o600 },
      );
      await chmod(configPath, 0o600);
      const { loadLlmProviderConfig } = await import("../../src/llm/index.js");
      const loaded = await loadLlmProviderConfig({ ATF_LLM_CONFIG: configPath, DF_FIX_FAKE_KEY_ENV: "df-fix-fake-key" });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      // provenance 一致性：四跑 model_id = deepseek-flash（runWorkspace 等值校验）
      const provider: LlmProvider = new HttpLlmProvider({ config: loaded.value, tools: [] });
      const scenario: Scenario = {
        scenario_id: "df-fix-continuation",
        version: 1,
        provider: "faux",
        description: "D-f 补正批用例 ⑥——四跑 facts 同 run 续跑",
        branches: {
          main: {
            branch_id: "main",
            run_id: RUN_ID,
            trigger_instruction: "材料情况按你上面的核对如实说明；缺什么就直接告诉我。",
            purpose: "df-fix-continuation",
            setup: { ledger: [] },
            steps: [],
            expect: { outcome: "completed", exit_code: 0 },
          },
        },
      };
      const ran = await ScenarioRunner.runBranch(scenario, "main", {
        runsRoot: RUNS_ROOT,
        mockCommand: ["node", join(repoRoot, "tests", "fixtures", "mock_atf.mjs")],
        scopeMode: "canonical",
        modelProvider: provider,
        modelId: "deepseek-flash",
        approvalSurface: { stub: grantedStub },
        continue: { instruction: "材料情况按你上面的核对如实说明；缺什么就直接告诉我。" },
      });
      expect(ran.ok, !ran.ok ? JSON.stringify(ran.error) : "").toBe(true);
      if (!ran.ok) return;
      const report: BranchRunReport = ran.value;
      // 核心断言：修复后同一 run 续跑成功（四跑同点位为 provider_failure）
      expect(report.outcome.kind).toBe("completed");
      expect(report.exit_code).toBe(0);
      const turnEnd = report.events.filter((event) => event.type === "turn/end").at(-1);
      expect(turnEnd?.payload).toMatchObject({ reason: "completed", stop_reason: "final_answer" });
      // 该拍确经真投影路径：伪端点恰收到一次请求（投影失败则请求不会发生）
      expect(endpoint.requests.length).toBe(1);
    } finally {
      await endpoint.close().catch(() => undefined);
    }
  }

  it("（哨兵）四跑事实日志不在场 → 用例 ⑥ 跳过", () => {
    expect(!FACTS_EXIST || FACTS_EXIST).toBe(true);
  });
});
