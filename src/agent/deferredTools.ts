/**
 * 丙 v2（批 P 续作，指令 6227dbfc §四.3）——ckpt 伴生模型面：deferredFace Registry 的
 * 工具化（spawn/poll/cancel；本地工具，零桥接契约 diff）。
 *
 * 产出回注主链通道（指令 §四.3 要求二选一并登记）：**toolResult 通道**——atf_deferred_poll
 * 把伴生子任务结果作为自身工具结果回注转录（first-class 工具输出，经 after_tool 镜像入
 * EvidenceEvent 事实轨，可审计）；steering 通道保留给操作员/主链中途输入，不挪作伴生产出
 * 回注。轮询驱动＝B9 boundary（driveFace.planRunBoundary trigger="deferred"）＋run 收口
 * 边界的有界续跑轮次（runV1Headless），模型侧 poll 自身有界（deferredFace.poll maxPolls）。
 *
 * 审批面：三工具为伴生控制面（派发/轮询/取消），动作本身免审批（与 dispatch 豁免面同款
 * 登记，approvalHook exemptTools）；伴生子任务内部写动作仍过同一账本闸（继承不豁免）。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { checkSchema, validateCanonicalOutput, type SchemaNode } from "../core/tools/index.js";
import {
  DEFERRED_POLL_MAX_POLLS_CEILING,
  createDeferredSubtaskRegistry,
  type DeferredPollOutcome,
  type DeferredSubtaskRegistry,
} from "./deferredFace.js";

export const DEFERRED_TOOL_NAMES: readonly string[] = ["atf_deferred_spawn", "atf_deferred_poll", "atf_deferred_cancel"];

export interface DeferredToolDeps {
  registry: DeferredSubtaskRegistry;
  /** 伴生子任务执行器（装配期注入：subagent.createChildInstructionRunner；tests 注 faux）。 */
  childRunner: (instruction: string) => Promise<string>;
}

const SPAWN_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "handle_id", "label", "state"],
  properties: {
    ok: { const: true },
    handle_id: { type: "string" },
    label: { type: "string" },
    state: { const: "running" },
  },
};

const POLL_CANONICAL: SchemaNode = {
  type: "object",
  strict: false,
  required: ["ok", "handle_id", "outcome", "polls_used"],
  properties: {
    ok: { type: "boolean" },
    handle_id: { type: "string" },
    outcome: { enum: ["done", "cancelled", "failed", "running", "timeout"] },
    polls_used: { type: "integer" },
    result: { type: "string", optional: true },
    error: { type: "string", optional: true },
    note: { type: "string", optional: true },
  },
};

const CANCEL_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "handle_id", "state"],
  properties: {
    ok: { const: true },
    handle_id: { type: "string" },
    state: { type: "string" },
  },
};

const pollOutcomePayload = (handleId: string, outcome: DeferredPollOutcome): Record<string, unknown> => {
  switch (outcome.outcome) {
    case "done":
      return { ok: true, handle_id: handleId, outcome: "done", result: outcome.result, polls_used: outcome.polls_used };
    case "failed":
      return { ok: false, handle_id: handleId, outcome: "failed", error: outcome.error, polls_used: outcome.polls_used };
    case "cancelled":
      return { ok: true, handle_id: handleId, outcome: "cancelled", polls_used: outcome.polls_used };
    case "running":
      return {
        ok: false,
        handle_id: handleId,
        outcome: "running",
        polls_used: outcome.polls_used,
        note: "伴生子任务未收口——可降低 interval_ms 再 poll、或 cancel 收口；run 收口边界会按 B9 规划跟进",
      };
    case "timeout":
      return {
        ok: false,
        handle_id: handleId,
        outcome: "timeout",
        polls_used: outcome.polls_used,
        note: `有界轮询轮次耗尽（max_polls≤${String(DEFERRED_POLL_MAX_POLLS_CEILING)}）超时收口——任务仍在册，可再次 poll 或 cancel`,
      };
  }
};

const textOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
};

const toolResultOf = (definition: { name: string; canonical_output: SchemaNode }, value: unknown): AgentToolResult<any> => {
  const canonicalCheck = validateCanonicalOutput(definition.name, definition.canonical_output, value);
  if (!canonicalCheck.ok) {
    throw new Error(`canonical 输出校验失败（${canonicalCheck.error.code}）: ${canonicalCheck.error.message}`);
  }
  return { content: [{ type: "text", text: textOf(value) }], details: value as Record<string, unknown> };
};

const invalidResult = (message: string): AgentToolResult<any> => ({
  content: [{ type: "text", text: textOf({ ok: false, error: "invalid_input", message }) }],
  details: { ok: false, error: "invalid_input" },
});

/** atf_deferred_spawn：发起伴生子任务（立即返回句柄；主链不被阻塞）。 */
export const createDeferredSpawnTool = (deps: DeferredToolDeps): AgentTool =>
  ({
    name: "atf_deferred_spawn",
    label: "atf_deferred_spawn",
    description:
      "发起伴生子任务（训练中 ckpt 抽查等长时伴生）：子指令在后台独立会话树异步执行，立即返回句柄不阻塞主链；稍后以 atf_deferred_poll 有界轮询取回（run 收口边界会自动规划轮询续跑）。纪律：instruction 必须自包含；子任务内写动作仍经同一审批账本闸。",
    parameters: {
      type: "object",
      required: ["label", "instruction"],
      properties: {
        label: { type: "string", description: "伴生任务标签（清单/日志对位，如 ckpt-抽查-r3）" },
        instruction: { type: "string", description: "子任务指令（自包含：目标、数据引用、期望产物形态）" },
      },
    },
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<any>> => {
      const check = checkSchema(params ?? {}, {
        type: "object",
        required: ["label", "instruction"],
        properties: { label: { type: "string" }, instruction: { type: "string" } },
      }, "atf_deferred_spawn");
      if (check !== null) return invalidResult(check);
      const { label, instruction } = params as { label: string; instruction: string };
      if (label.trim() === "" || instruction.trim() === "") return invalidResult("label/instruction 均须非空字符串");
      const handle = deps.registry.spawn(label, () => deps.childRunner(instruction));
      return toolResultOf({ name: "atf_deferred_spawn", canonical_output: SPAWN_CANONICAL }, { ok: true, handle_id: handle.id, label, state: "running" });
    },
  }) as AgentTool;

/** atf_deferred_poll：有界轮询取回（结果经 toolResult 回注主链）。 */
export const createDeferredPollTool = (deps: DeferredToolDeps): AgentTool =>
  ({
    name: "atf_deferred_poll",
    label: "atf_deferred_poll",
    description:
      "轮询伴生子任务（有界，禁无界轮询）：至多 max_polls 次（缺省 10、上限 100）、每次间隔 interval_ms；done 返回子任务结果（本工具结果即产物，如实向用户转述）；running/timeout 照返未收口态——可再 poll 或 cancel。",
    parameters: {
      type: "object",
      required: ["handle_id"],
      properties: {
        handle_id: { type: "string", description: "atf_deferred_spawn 返回的句柄 id" },
        max_polls: { type: "integer", optional: true, description: `轮询次数上限（1..${String(DEFERRED_POLL_MAX_POLLS_CEILING)}；缺省 10）` },
        interval_ms: { type: "integer", optional: true, description: "轮询间隔毫秒（≥1；缺省 250）" },
      },
    },
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<any>> => {
      const raw = (params ?? {}) as { handle_id?: unknown; max_polls?: unknown; interval_ms?: unknown };
      if (typeof raw.handle_id !== "string" || raw.handle_id === "") return invalidResult("handle_id 必填（非空字符串）");
      if (raw.max_polls !== undefined && (typeof raw.max_polls !== "number" || !Number.isInteger(raw.max_polls) || raw.max_polls < 1 || raw.max_polls > DEFERRED_POLL_MAX_POLLS_CEILING)) {
        return invalidResult(`max_polls 须为 1..${String(DEFERRED_POLL_MAX_POLLS_CEILING)} 的整数`);
      }
      if (raw.interval_ms !== undefined && (typeof raw.interval_ms !== "number" || !Number.isInteger(raw.interval_ms) || raw.interval_ms < 1)) {
        return invalidResult("interval_ms 须为 ≥1 的整数");
      }
      const outcome = await deps.registry.poll(
        { id: raw.handle_id, label: "" },
        {
          ...(raw.max_polls !== undefined ? { maxPolls: raw.max_polls } : {}),
          ...(raw.interval_ms !== undefined ? { intervalMs: raw.interval_ms } : {}),
        },
      );
      return toolResultOf({ name: "atf_deferred_poll", canonical_output: POLL_CANONICAL }, pollOutcomePayload(raw.handle_id, outcome));
    },
  }) as AgentTool;

/** atf_deferred_cancel：取消伴生子任务（幂等；终态照认）。 */
export const createDeferredCancelTool = (deps: DeferredToolDeps): AgentTool =>
  ({
    name: "atf_deferred_cancel",
    label: "atf_deferred_cancel",
    description: "取消伴生子任务（幂等）：运行中→cancelled；已终态照认原状态。取消后不再为其规划轮询续跑。",
    parameters: {
      type: "object",
      required: ["handle_id"],
      properties: {
        handle_id: { type: "string", description: "atf_deferred_spawn 返回的句柄 id" },
      },
    },
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<any>> => {
      const raw = (params ?? {}) as { handle_id?: unknown };
      if (typeof raw.handle_id !== "string" || raw.handle_id === "") return invalidResult("handle_id 必填（非空字符串）");
      await deps.registry.cancel({ id: raw.handle_id, label: "" });
      const status = await deps.registry.fetch({ id: raw.handle_id, label: "" });
      return toolResultOf({ name: "atf_deferred_cancel", canonical_output: CANCEL_CANONICAL }, { ok: true, handle_id: raw.handle_id, state: status.state });
    },
  }) as AgentTool;

/** 伴生工具面装配（registry 缺省自建；装配点传入共享实例供 boundary 规划消费）。 */
export const buildDeferredAgentTools = (deps: DeferredToolDeps): AgentTool[] => [
  createDeferredSpawnTool(deps),
  createDeferredPollTool(deps),
  createDeferredCancelTool(deps),
];

/** 装配便捷入口（registry 单源自建）。 */
export const createDeferredToolSet = (childRunner: (instruction: string) => Promise<string>): { tools: AgentTool[]; registry: DeferredSubtaskRegistry } => {
  const registry = createDeferredSubtaskRegistry();
  return { registry, tools: buildDeferredAgentTools({ registry, childRunner }) };
};
