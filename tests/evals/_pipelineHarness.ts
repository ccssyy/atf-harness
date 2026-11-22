/**
 * L1/L3 共用的段级驱动夹具（headless，不碰 WebUI/鉴权/端口——eval-spec §4.5 判据载体三分）。
 *
 * 三层都在场：
 *   ① 真模型面＝faux provider（`createFauxStreamFn`，零真实 LLM 调用——本批红线）；
 *   ② 真 agent loop＝pi-agent-core `Agent`（含 beforeToolCall/事件流，轨迹断言的数据源）；
 *   ③ 真工具＝`buildPipelineTool`（atf-tools 实际装配产物，不是复刻实现）。
 * 唯一替身是内核段子进程（`mockPipeline`：退出码/回执可控的确定性对端）——它替代的是
 * 「内核仓 + GPU + 训练」这条本批不可 CI 化的外部面，不是被测逻辑。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createFauxStreamFn, type FauxStreamFn } from "../../src/agent/fauxStream.js";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

/** agent 轨迹里被断言的一步（工具调用 + 它收到的回执原文）。 */
export interface TrajectoryStep {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** 回执 JSON 原文（模型实际看到的那段文本）。 */
  readonly resultText: string;
  /** 回执解析结果（解析失败＝null，如渲染非 JSON 时）。 */
  readonly result: Record<string, unknown> | null;
}

/** 一次段级回放的全部观测面。 */
export interface SegmentRun {
  readonly steps: readonly TrajectoryStep[];
  /** 牌面卡的完整请求（userQuestions 服务收到的原样入参，按调用序）。 */
  readonly cards: readonly Record<string, unknown>[];
  readonly workspace: string;
  readonly runDir: string;
}

/** 用户问题服务的应答脚本：按 question id 决定 selected / custom。 */
export type CardAnswerer = (question: { id: string; options?: Array<{ label: string }> }) => {
  selected?: readonly string[];
  custom?: string;
};

export interface SegmentScenario {
  /** 用户对每张卡的应答。缺省＝全部空选。 */
  readonly answer?: CardAnswerer;
  /** 内核段进程的脚本（写入 mock 的 mjs 源码；缺省＝成功退出 0）。 */
  readonly kernelScript?: string;
  /** run 目录预置（字段清单、账本等）；入参＝runDir。 */
  readonly seedRunDir?: (runDir: string) => void;
  /** 工作区预置（batch 目录等）；入参＝workspace 根。 */
  readonly seedWorkspace?: (workspace: string) => void;
  /** 会话权限档（缺省 danger-full-access＝构造卡走「问人」分支）。 */
  readonly sandbox?: string;
  /** 会话预设（缺省 atf-training）。 */
  readonly agentPreset?: string;
}

const MOCK_OK = "process.stdout.write(JSON.stringify({ stage: 'segment', ok: true, exit_code: 0 }) + '\\n');\n";

/** 建临时工作区（带 runs/ 标记＝已初始化工作区闸）。 */
export const makeWorkspace = (prefix = "g6-evals-"): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "runs"), { recursive: true });
  return root;
};

/** 清临时工作区。 */
export const dropWorkspace = (root: string): void => {
  rmSync(root, { recursive: true, force: true });
};

/**
 * 跑一段：faux 脚本先发一次 `atf_pipeline_stage` 调用，再收口。
 * @param scenario 段脚本与卡应答
 * @param stageArgs 工具调用参数（原样）
 * @returns 轨迹（步骤/卡/落点）
 */
export const runSegment = async (
  scenario: SegmentScenario,
  stageArgs: Record<string, unknown>,
): Promise<SegmentRun> => {
  const workspace = makeWorkspace();
  const runId = String(stageArgs["run_id"] ?? "run-evals");
  const experiment = typeof stageArgs["experiment"] === "string" ? stageArgs["experiment"] : "exp-evals";
  const runDir = join(workspace, "experiments", experiment, runId);
  mkdirSync(join(runDir, "runtime", "webui"), { recursive: true });
  mkdirSync(join(runDir, "webui"), { recursive: true });
  mkdirSync(join(runDir, "data"), { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: runId, experiment_id: experiment }), "utf8");
  scenario.seedWorkspace?.(workspace);
  scenario.seedRunDir?.(runDir);

  const mockPath = join(workspace, "mock_segment.mjs");
  writeFileSync(mockPath, scenario.kernelScript ?? MOCK_OK, "utf8");

  const cards: Array<Record<string, unknown>> = [];
  const sandbox = scenario.sandbox ?? "danger-full-access";
  const preset = scenario.agentPreset ?? "atf-training";
  const ctx = {
    get(service: string) {
      if (service === "approval") return { request: async () => "allowed-once" };
      if (service === "permissionPresets") {
        return { current: () => sandbox, resolve: () => ({ sandbox }) };
      }
      if (service === "sessionProjections") return { stateOf: () => preset };
      if (service === "userQuestions") {
        return {
          ask: async (request: Record<string, unknown>) => {
            cards.push(request);
            const questions = (request["questions"] ?? []) as Array<{
              id: string;
              options?: Array<{ label: string }>;
            }>;
            return {
              answers: questions.map((question) => {
                const verdict = scenario.answer?.(question) ?? {};
                return {
                  id: question.id,
                  selected: [...(verdict.selected ?? [])],
                  ...(verdict.custom === undefined ? {} : { custom: verdict.custom }),
                };
              }),
            };
          },
        };
      }
      return undefined;
    },
  };

  const raw = buildPipelineTool(ctx as never, "node " + mockPath, 30_000) as unknown as {
    name: string;
    description: string;
    parameters: unknown;
    execute: (args: unknown, exec: unknown) => Promise<unknown>;
  };
  const tool = {
    name: raw.name,
    label: raw.name,
    description: raw.description,
    parameters: raw.parameters,
    execute: async (toolCallId: string, params: unknown) => {
      const value = (await raw.execute(params, {
        agent: { session: { id: "g6-evals-session" } },
        callId: toolCallId,
        signal: undefined,
      })) as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        details: value as never,
      };
    },
  };

  // 落点单源由夹具给：workspace_path 恒为临时工作区（用例不必知道 tmp 路径）；
  // source_root 只在该段需要且用例未显式覆盖时补默认批根。
  const callArgs: Record<string, unknown> = {
    ...stageArgs,
    workspace_path: workspace,
    ...(stageArgs["source_root"] === undefined ? {} : {}),
  };
  if (callArgs["stage"] === "register" && callArgs["source_root"] === undefined) {
    // register 段按「批根 + 单据类型 → 子目录存在」校验（source_root_doc_type_subdir_missing）；
    // 夹具补出该形态，让用例专注被测面而非目录骨架。
    const batch = join(workspace, "batch");
    mkdirSync(join(batch, String(callArgs["doc_type"] ?? "doc")), { recursive: true });
    callArgs["source_root"] = batch;
  }
  const { fauxFinalAnswer, fauxMessageWithToolCalls } = await import("../../src/agent/fauxStream.js");
  const script = [
    fauxMessageWithToolCalls("触发该段。", [
      { id: "call-1", name: raw.name, arguments: callArgs as never },
    ]),
    fauxFinalAnswer("段已回执，按回执决定下一步。"),
  ];
  const streamFn: FauxStreamFn = createFauxStreamFn(script);
  const events: Array<Record<string, unknown>> = [];
  const agent = new Agent({
    initialState: { systemPrompt: "g6-evals", tools: [tool] },
    streamFn: streamFn as never,
    toolExecution: "sequential",
  });
  agent.subscribe((event) => {
    events.push(event as unknown as Record<string, unknown>);
  });
  await agent.prompt("触发该段。");

  const steps: TrajectoryStep[] = [];
  for (const event of events) {
    if (event["type"] === "tool_execution_start") {
      steps.push({
        toolName: String(event["toolName"]),
        args: (event["args"] ?? {}) as Record<string, unknown>,
        resultText: "",
        result: null,
      });
    }
    if (event["type"] === "tool_execution_end") {
      const result = event["result"] as { content?: Array<{ text?: string }> } | undefined;
      const text = (result?.content ?? []).map((part) => part.text ?? "").join("");
      const last = steps[steps.length - 1];
      if (last !== undefined) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        steps[steps.length - 1] = { ...last, resultText: text, result: parsed };
      }
    }
  }

  return { steps, cards, workspace, runDir };
};

/** 读 run 目录下的 marker/账本（缺省＝null）。 */
export const readJsonIfPresent = (path: string): Record<string, unknown> | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};
