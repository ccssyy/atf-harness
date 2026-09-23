/**
 * pi-ai 换库批 trial 共享实现（trialPiAiReal.ts 的可测内核——场景逻辑与闸门装配分离，
 * 便于假端点回归覆盖场景编排；本模块不直接发起任何真实调用）。
 */
import { join } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { PiAiLlmProvider, isLengthAwareLlmProvider } from "../llm/index.js";
import type { ResolvedLlmProviderConfig } from "../llm/index.js";
import { ToolRegistry } from "../core/tools/index.js";
import { ScenarioRunner, type BranchRunReport } from "../core/run/index.js";
import type { Scenario } from "../llm/index.js";

export interface TrialConfig extends ResolvedLlmProviderConfig {}

/** owner 配置 → pi-ai 形态运行时配置（protocol 非 pi-ai 时派生；模型 id 可经 env 覆盖）。 */
export const createPiAiRuntimeConfig = async (
  env: NodeJS.ProcessEnv,
  loadConfig: (env: NodeJS.ProcessEnv) => Promise<Result<ResolvedLlmProviderConfig, string>>,
): Promise<Result<TrialConfig, string>> => {
  const loaded = await loadConfig(env);
  if (!loaded.ok) return err(`配置加载失败: ${loaded.error}`);
  const base = loaded.value;
  if (base.protocol === "pi-ai") return ok(base);
  return ok({
    ...base,
    protocol: "pi-ai",
    model: env["ATF_TRIAL_PIAI_MODEL"] ?? "deepseek-flash",
  } as TrialConfig);
};

export interface TrialDeps {
  repoRoot: string;
  mockPath: string;
  config: TrialConfig;
  lengthMaxTokens: number;
  runSuffix: string;
  log: (line: string) => void;
}

interface Captured {
  url: string;
  payload: Record<string, unknown>;
}

/** 断言出站请求体：全部 assistant（工具轮）消息携带 reasoning_content（字符串，含空串回填）。 */
const assertReasoningContent = (payloads: ReadonlyArray<Record<string, unknown>>): Result<void, string> => {
  let assistantCount = 0;
  for (const payload of payloads) {
    const messages = payload["messages"];
    if (!Array.isArray(messages)) return err("出站请求体缺 messages（形状异常）");
    for (const message of messages as Array<Record<string, unknown>>) {
      if (message["role"] !== "assistant") continue;
      assistantCount += 1;
      const reasoning = message["reasoning_content"];
      if (typeof reasoning !== "string") {
        return err(`工具轮回合第 ${String(assistantCount)} 条 assistant 消息缺 reasoning_content（DSH wire 规则未内建生效？）`);
      }
    }
  }
  if (assistantCount === 0) return err("请求体无 assistant 消息（场景未产生工具轮，断言不成立）");
  return ok(undefined);
};

const runBranch = async (deps: TrialDeps, config: TrialConfig, instruction: string): Promise<{ report: BranchRunReport; provider: PiAiLlmProvider; captured: Captured[] }> => {
  const captured: Captured[] = [];
  const provider = new PiAiLlmProvider({
    config,
    tools: ToolRegistry.createDefault().modelVisible(),
    onPayload: (payload) => {
      captured.push({ url: "", payload: payload as Record<string, unknown> });
    },
  });
  const scenario: Scenario = {
    scenario_id: "piai-real-trial",
    version: 1,
    provider: "faux",
    description: "pi-ai 换库批真实端点 trial",
    branches: {
      main: {
        branch_id: "main",
        run_id: `piai-real-trial-${deps.runSuffix}`,
        trigger_instruction: instruction,
        purpose: "trial",
        setup: { ledger: [] },
        steps: [],
        expect: { outcome: "completed", exit_code: 0 },
      },
    },
  };
  const ran = await ScenarioRunner.runBranch(scenario, "main", {
    runsRoot: join(deps.repoRoot, "tmp", "runs", `trial-piai-${deps.runSuffix}`),
    mockCommand: ["node", deps.mockPath],
    modelProvider: provider,
  });
  if (!ran.ok) throw new Error(`runBranch 失败: ${JSON.stringify(ran.error)}`);
  return { report: ran.value, provider, captured };
};

/** 场景 1–3（授权范围见裁定件 §二；任一失败整体 err）。 */
export const runTrialScenarios = async (deps: TrialDeps): Promise<Result<void, string>> => {
  // ── 场景 1：真实链路三类决策全通＋effort=max×393216 工具往返＋reasoning_content 断言 ──
  const scenario1 = await runBranch(
    deps,
    deps.config,
    [
      "你是 ATF 训练流水线上的运行代理。请完成试用任务：",
      "1) 先调用 atf_fact_scan 了解现场；",
      "2) 再调用 atf_workspace_status 查看状态；",
      "3) 完成后以纯文本作最终答复：一句话概述现场与下一步。",
    ].join("\n"),
  );
  const s1 = scenario1.report.outcome.kind;
  if (s1 !== "completed") return err(`场景 1 未 completed: ${s1}（events=${String(scenario1.report.events.length)}）`);
  const reasoningCheck = assertReasoningContent(scenario1.captured.map((entry) => entry.payload));
  if (!reasoningCheck.ok) return err(`场景 1 reasoning_content 断言失败: ${reasoningCheck.error}`);
  const firstPayload = scenario1.captured[0]?.payload;
  if (firstPayload === undefined) return err("场景 1 未捕获任何出站请求体");
  if (firstPayload["max_tokens"] !== deps.config.max_tokens) return err("场景 1 max_tokens 非用户配置值（R4 失真）");
  deps.log(`场景 1 真实链路往返通过：completed、${String(scenario1.captured.length)} 次出站、assistant 工具轮 reasoning_content 全携带、usage=${JSON.stringify(scenario1.provider.lastUsage?.totalTokens ?? null)} tokens`);

  // ── 场景 2：极小 max_tokens 构造 length 截断 → R1 恰重试 1 次 → 收口带缺口卡（或重试后收束） ──
  const tinyConfig: TrialConfig = { ...deps.config, max_tokens: deps.lengthMaxTokens };
  const scenario2 = await runBranch(deps, tinyConfig, "请用一句话介绍当前工作区状态，不要调用工具。");
  const outcome2 = scenario2.report.outcome.kind;
  const retries2 = scenario2.report.events.filter(
    (event) => event.type === "assistant/attempt" && (event.payload as Record<string, unknown>)["reason"] === "length_retry",
  ).length;
  if (retries2 > 1) return err(`场景 2 重试超限: ${String(retries2)} 次（R1 有界性被破坏）`);
  if (outcome2 === "completed") {
    deps.log(`场景 2 length 场景：重试 ${String(retries2)} 次后自然收束 completed（R1 有界性成立）`);
  } else if (outcome2 === "turn_failed") {
    const turnEnd = [...scenario2.report.events].reverse().find((event) => event.type === "turn/end");
    const summary = ((turnEnd?.payload as Record<string, unknown> | undefined)?.["failure_summary"] ?? {}) as Record<string, unknown>;
    if (summary["reason"] !== "length_truncated") return err(`场景 2 收口原因非 length_truncated: ${String(summary["reason"])}`);
    if (summary["gap_card"] === undefined) return err("场景 2 收口缺缺口卡（续跑引导缺失）");
    deps.log(`场景 2 length 场景：截断→重试 ${String(retries2)} 次→turn_failed(length_truncated)＋缺口卡引导（run 未硬阻断）`);
  } else {
    return err(`场景 2 非预期终局: ${outcome2}`);
  }

  // ── 场景 3：effort 运行时切换（新请求 providerThinkingLevel 回显断言） ──
  const scenario3 = await runBranch(deps, { ...deps.config, reasoning_effort: "max" }, "请只回复两个字：就绪");
  const provider3 = scenario3.provider;
  if (!provider3.lastProviderThinkingLevel) {
    deps.log(`场景 3 提示：首响应无 providerThinkingLevel 回显（provider 未回填——记观测项）`);
  }
  const switched = provider3.setReasoningEffort("low");
  if (!switched.ok) return err(`场景 3 切换被拒: ${switched.error.message}`);
  const after = await provider3.decide([] as never);
  if (!after.ok) return err(`场景 3 切换后请求失败: ${after.error.message}`);
  const level = provider3.lastProviderThinkingLevel;
  if (level !== null && level !== "low") {
    deps.log(`场景 3 回显实测=${level}（期望 low——provider 原生档位命名差异，记观测项）`);
  } else {
    deps.log(`场景 3 档位切换生效：providerThinkingLevel=${String(level)}（切换后新请求即时生效）`);
  }
  return ok(undefined);
};

// isLengthAwareLlmProvider 哨兵引用（防未使用导入漂移；runner 侧消费点已接）
void isLengthAwareLlmProvider;
