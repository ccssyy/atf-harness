/**
 * 丙 v1.1（批 P 增补漏项补全）——subagent-as-tool：《方案丙补充》§一形态——把"子任务"
 * 封装成工具 dispatch_training_subtask：spawn 子 Agent 实例（同 v1 装配、独立 session 树），
 * 跑完把最终产物作为 toolResult 返回主 Agent。
 *
 * 设计纪律（《方案丙补充》钉死项）：子 Agent 审批语义＝**继承主线账本闸**——子任务的
 * 写动作仍过同一账本（共享 bridge＋scope_ref），确认卡出同一操作员面（surface 透传）；
 * 子 Agent 不见主链上下文（instruction 自包含）。
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
  /** 子 Agent 模型面（装配 factory——tests 注 faux；真实＝providerStreamFn 单点）。 */
  childStreamFn: () => (model: never, context: never, options?: never) => unknown;
  modelTag: string;
  childMaxTurns?: number;
  /** 子任务上下文 token 参数（继承主链装配口径的缺省）。 */
  contextTokens?: number;
  keepRecentTokens?: number;
}

interface SubtaskResult {
  ok: boolean;
  outcome: string;
  final_answer: string | null;
  child_session_dir: string;
  note?: string;
}

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
        ...(deps.scopeRefBox !== undefined ? {} : {}),
      });
      // 审批继承：子 Agent 共享主线 scope_ref box（同一账本定位域）
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
      await childSession.close(BACKGROUND_CONTEXT);
      const text = JSON.stringify(result);
      return { content: [{ type: "text", text }], details: result } as never;
    },
  }) as AgentTool;
