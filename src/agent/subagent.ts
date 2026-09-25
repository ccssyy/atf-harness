/**
 * 丙 v1.1（批 P 增补漏项补全）——subagent-as-tool：《方案丙补充》§一形态——把"子任务"
 * 封装成工具 dispatch_training_subtask：spawn 子 Agent 实例（同 v1 装配、独立 session 树），
 * 跑完把最终产物作为 toolResult 返回主 Agent。
 *
 * 丙 v2（批 P 续作，指令 6227dbfc §四.2）——并行 fan-out：dispatch_parallel_training_subtask
 * （独立工具，二选一取此并登记理由：与单发工具 required 参数面/结果聚合面不同构，独立
 * schema 使模型面无歧义，且单发语义与既有测试零回归）。多子任务并发 spawn——并发的是
 * **模型轮与只读工作**；写动作审批不并发：全部执行体共享 GateLock 串行化账本闸临界段
 * （approvalHook.createGateLock），逐条确认卡、逐条消费、授权对象不错位——并行 fan-out
 * 不构成绕过账本的理由（指令 §三.3；如需并发授权模型，先登记设计另批）。
 *
 * 设计纪律（《方案丙补充》钉死项，v2 沿用）：子 Agent 审批语义＝**继承主线账本闸**——
 * 子任务的写动作仍过同一账本（共享 bridge＋scope_ref），确认卡出同一操作员面（surface
 * 透传）；子 Agent 不见主链上下文（instruction 自包含）。
 *
 * 工具面纪律：本地工具（不进 TOOL_DEFINITIONS／零桥接契约 diff）——丙线 tools 数组装配
 * 期追加（deps.subagent 显式开启）。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assembleV1Agent } from "./cli.js";
import { createJsonlSessionRepo } from "./sessionMirror.js";
import type { SpikeBridgeTransport } from "./atfAgentTools.js";
import type { ApprovalSurface } from "./approvalSurface.js";
import type { GateLock } from "./approvalHook.js";
import { ensureTemBranch } from "./tem/store.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";

export interface SubagentDeps {
  bridge: SpikeBridgeTransport;
  /** 子 session 根（每次派发在其下 mkdtemp 独立树）。 */
  sessionsRoot: string;
  /** 主线 scope_ref box（共享引用＝同一账本定位域——审批继承的技术承载）。 */
  scopeRefBox: { current: import("../core/tools/approvalKey.js").ScopeRef | undefined };
  /** 主线确认卡 surface（透传＝同一操作员面；缺省＝子任务内 headless fail-closed）。 */
  surface?: ApprovalSurface;
  /** 账本闸临界区锁（v2 并行 fan-out：与主链 hook 共享同一把——watermark 保护，见文件头）。 */
  gateLock?: GateLock;
  /** 子 Agent 模型面（装配 factory——tests 注 faux；真实＝providerStreamFn 单点）。 */
  childStreamFn: () => (model: never, context: never, options?: never) => unknown;
  modelTag: string;
  childMaxTurns?: number;
  /** 子任务上下文 token 参数（继承主链装配口径的缺省）。 */
  contextTokens?: number;
  keepRecentTokens?: number;
}

export interface SubtaskResult {
  ok: boolean;
  outcome: string;
  final_answer: string | null;
  child_session_dir: string;
  label?: string;
  note?: string;
}

/** 子任务执行单径（单发/并行 fan-out/deferred 伴生同一径——审批继承与结果分类不分叉）。 */
export const runChildSubtask = async (deps: SubagentDeps, instruction: string, label?: string): Promise<SubtaskResult> => {
  const repo = createJsonlSessionRepo(deps.sessionsRoot);
  const childSessionRoot = await mkdtemp(join(deps.sessionsRoot, "dispatch-"));
  const childSession = await repo.create({ cwd: childSessionRoot }, BACKGROUND_CONTEXT);
  await ensureTemBranch(childSession);
  const assembled = assembleV1Agent({
    bridge: deps.bridge,
    session: childSession,
    maxTurns: deps.childMaxTurns ?? 8,
    streamFn: deps.childStreamFn() as never,
    modelTag: deps.modelTag,
    approval: deps.surface !== undefined ? { kind: "surface", surface: deps.surface } : { kind: "headless" },
    steeringMode: "all",
    followUpMode: "all",
    contextTokens: deps.contextTokens ?? 24_000,
    keepRecentTokens: deps.keepRecentTokens ?? 8_000,
    ...(deps.gateLock !== undefined ? { gateLock: deps.gateLock } : {}),
  });  // 审批继承：子 Agent 共享主线 scope_ref box（同一账本定位域）
  Object.assign(assembled.scopeRefBox, { current: deps.scopeRefBox.current });
  let failure: string | undefined;
  try {
    await assembled.agent.prompt(instruction);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  const lastAssistant = [...assembled.agent.state.messages].reverse().find((message) => (message as { role?: string }).role === "assistant") as AssistantMessage | undefined;
  const hasFinal = lastAssistant !== undefined && !lastAssistant.content.some((block) => block.type === "toolCall");
  const approvalBlocked = assembled.audit.some((entry) => entry.verdict === "blocked_approval_missing");
  const denied = assembled.audit.some((entry) => entry.verdict === "blocked_denied");
  let result: SubtaskResult;
  if (hasFinal && lastAssistant !== undefined) {
    result = {
      ok: true,
      outcome: "completed",
      final_answer: lastAssistant.content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join(""),
      child_session_dir: childSessionRoot,
    };
  } else if (approvalBlocked) {
    result = { ok: false, outcome: "approval_missing", final_answer: null, child_session_dir: childSessionRoot, note: "子任务内高危动作缺授权（同账本 fail-closed）——主线获授权后可重新派发" };
  } else if (denied) {
    result = { ok: false, outcome: "denied", final_answer: null, child_session_dir: childSessionRoot, note: "子任务内动作被操作员否决" };
  } else {
    result = { ok: false, outcome: failure !== undefined ? "failed" : "incomplete", final_answer: null, child_session_dir: childSessionRoot, ...(failure !== undefined ? { note: failure } : {}) };
  }
  if (label !== undefined) result = { ...result, label };
  await childSession.close(BACKGROUND_CONTEXT);
  return result;
};

/** 子指令执行器（deferred 伴生消费：完成→final_answer 文本；未完成→抛错折算 failed）。 */
export const createChildInstructionRunner =
  (deps: SubagentDeps) =>
  async (instruction: string): Promise<string> => {
    const result = await runChildSubtask(deps, instruction);
    if (result.ok && result.final_answer !== null) return result.final_answer;
    throw new Error(`子任务未完成（outcome=${result.outcome}）${result.note !== undefined ? `: ${result.note}` : ""}`);
  };

/** dispatch_training_subtask 工具（装配期追加；审批继承主线账本闸）。 */
export const createDispatchTrainingSubtaskTool = (deps: SubagentDeps): AgentTool =>
  ({
    name: "dispatch_training_subtask",
    label: "dispatch_training_subtask",
    description:
      "派发伴生训练子任务（subagent）：在独立会话树中执行自包含子指令，返回子任务最终答复。适用：单数据集体检细化、评估证据核验、TEM 检索深查等可切分子任务。纪律：子 Agent 不见主链上下文（instruction 必须自包含）；子任务内写动作仍经同一审批账本闸（确认卡出同一操作员面）——不因子 Agent 绕过治理。",
    parameters: {
      type: "object",
      required: ["instruction"],
      properties: {
        instruction: {
          type: "string",
          description: "子任务指令（自包含：目标、所需数据引用、期望产物形态；子 Agent 不见主链对话）",
        },
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const instruction = (params as { instruction?: unknown } | null)?.instruction;
      if (typeof instruction !== "string" || instruction.trim() === "") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "instruction 必填（非空字符串）" }) }], details: { ok: false } };
      }
      const result = await runChildSubtask(deps, instruction);
      const text = JSON.stringify(result);
      return { content: [{ type: "text", text }], details: result } as never;
    },
  }) as AgentTool;

// ---------------------------------------------------------------- v2 并行 fan-out

/** fan-out 上限（并发 spawn 上限；审批闸段另经 GateLock 串行——见文件头）。 */
export const DISPATCH_PARALLEL_MAX_SUBTASKS = 8;
export const DISPATCH_PARALLEL_DEFAULT_CONCURRENCY = 4;

interface ParallelSubtaskInput {
  label?: unknown;
  instruction: unknown;
}

const parseParallelParams = (
  params: unknown,
): { ok: true; subtasks: Array<{ label: string; instruction: string }>; maxConcurrency: number } | { ok: false; error: string } => {
  const raw = (params as { subtasks?: unknown; max_concurrency?: unknown } | null) ?? {};
  if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) {
    return { ok: false, error: "subtasks 必填（非空数组，1..8 项）" };
  }
  if (raw.subtasks.length > DISPATCH_PARALLEL_MAX_SUBTASKS) {
    return { ok: false, error: `subtasks 超上限（最多 ${String(DISPATCH_PARALLEL_MAX_SUBTASKS)} 项）` };
  }
  const subtasks: Array<{ label: string; instruction: string }> = [];
  for (const [index, item] of raw.subtasks.entries()) {
    const entry = item as ParallelSubtaskInput | null;
    const instruction = entry?.instruction;
    if (typeof instruction !== "string" || instruction.trim() === "") {
      return { ok: false, error: `subtasks[${String(index)}].instruction 必填（非空字符串）` };
    }
    const label = typeof entry?.label === "string" && entry.label.trim() !== "" ? entry.label : `subtask-${String(index + 1)}`;
    subtasks.push({ label, instruction });
  }
  let maxConcurrency = DISPATCH_PARALLEL_DEFAULT_CONCURRENCY;
  if (raw.max_concurrency !== undefined) {
    if (typeof raw.max_concurrency !== "number" || !Number.isInteger(raw.max_concurrency) || raw.max_concurrency < 1 || raw.max_concurrency > DISPATCH_PARALLEL_MAX_SUBTASKS) {
      return { ok: false, error: `max_concurrency 须为 1..${String(DISPATCH_PARALLEL_MAX_SUBTASKS)} 的整数` };
    }
    maxConcurrency = raw.max_concurrency;
  }
  return { ok: true, subtasks, maxConcurrency };
};

/** dispatch_parallel_training_subtask 工具（v2 fan-out；审批继承同单发——闸段经 GateLock 串行）。 */
export const createDispatchParallelTrainingSubtaskTool = (deps: SubagentDeps): AgentTool =>
  ({
    name: "dispatch_parallel_training_subtask",
    label: "dispatch_parallel_training_subtask",
    description:
      "并行派发多个训练子任务（fan-out）：各自在独立会话树并发执行自包含子指令，聚合返回逐项结果。适用：多数据集并行体检、多假设并行核验等多路可切分子任务。上限 8 项，缺省并发 4。纪律：子 Agent 不见主链上下文（instruction 必须自包含）；子任务内写动作仍逐条经同一审批账本闸（确认卡逐条出同一操作员面，账本闸临界段跨执行体串行——并行不构成绕过治理的理由）。",
    parameters: {
      type: "object",
      required: ["subtasks"],
      properties: {
        subtasks: {
          type: "array",
          items: {
            type: "object",
            required: ["instruction"],
            properties: {
              label: { type: "string", optional: true, description: "子任务标签（结果聚合对位键；缺省 subtask-<序号>）" },
              instruction: { type: "string", description: "子任务指令（自包含：目标、所需数据引用、期望产物形态）" },
            },
          },
          description: `子任务清单（1..${String(DISPATCH_PARALLEL_MAX_SUBTASKS)} 项）`,
        },
        max_concurrency: {
          type: "integer",
          optional: true,
          description: `最大并发数（1..${String(DISPATCH_PARALLEL_MAX_SUBTASKS)}；缺省 ${String(DISPATCH_PARALLEL_DEFAULT_CONCURRENCY)}）`,
        },
      },
    },
    execute: async (_toolCallId: string, params: unknown) => {
      const parsed = parseParallelParams(params);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: parsed.error }) }], details: { ok: false } };
      }
      const { subtasks, maxConcurrency } = parsed;
      // 信号量限流（并发 spawn 上限）；结果按入参序聚合（并发完成序不改变对位）
      let cursor = 0;
      const nextSlot = (): boolean => (cursor < maxConcurrency ? ((cursor += 1), true) : false);
      const releaseSlot = (): void => {
        cursor -= 1;
      };
      const results: SubtaskResult[] = new Array(subtasks.length);
      await Promise.all(
        subtasks.map(async (item, index) => {
          while (!nextSlot()) await new Promise((resolve) => setTimeout(resolve, 5));
          try {
            results[index] = await runChildSubtask(deps, item.instruction, item.label);
          } finally {
            releaseSlot();
          }
        }),
      );
      const completed = results.filter((result) => result.ok).length;
      const aggregate = {
        ok: completed === results.length,
        completed,
        failed: results.length - completed,
        results,
      };
      const text = JSON.stringify(aggregate);
      return { content: [{ type: "text", text }], details: aggregate } as never;
    },
  }) as AgentTool;
