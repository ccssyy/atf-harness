/**
 * 门 1a spike（批 P）——工具挂接层：ATF 内核桥 tool 化（方案丙 §三「tool 挂接层」）。
 *
 * 单源纪律：AgentTool 定义从 src/core/tools TOOL_DEFINITIONS（桥接契约镜像）投影——
 * 不复制工具描述/参数 schema（D-b 原则：不引入第二权威）。模型可见面与 runner 线逐字同源。
 *
 * 执行径（spike 期职责切分）：审批在 beforeToolCall hook（approvalHook.ts，账本闸继承主线
 * 语义）；本层只做 参数校验 → 桥接请求 → canonical output 校验（与 ToolExecutor.request
 * 同型：对端 ok=false → 结构化 rejected 回填为 isError 工具结果；桥接/契约故障 → throw，
 * 由循环折算 error 工具结果）。门 2 收口时与 ToolExecutor 抽共享执行内核（工单登记）。
 *
 * spike 工具面 = atf_workspace_status（唯一经桥执行的工具，批 P 门 1a「单工具经桥」）＋
 * atf_gate（审批 hook 受试动作：action=advance 须审批，执行面被拦即不触桥）。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BridgeError } from "../bridge/index.js";
import {
  checkSchema,
  requiresApprovalFor,
  TOOL_DEFINITIONS,
  validateCanonicalOutput,
  type SchemaNode,
  type ToolDefinition,
} from "../core/tools/index.js";
import { type ScopeRef } from "../core/tools/approvalKey.js";

/** spike 桥接最小面（AtfBridgeConnection 结构满足；测试可注桩）。 */
export interface SpikeBridgeTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

// spike 工具面两项均为恒等映射（工具名=桥接方法名）。门 2 九工具全挂接时引入
// 点号方法映射表（对齐 core/tools/executor.ts TOOL_METHOD_OVERRIDES 单源表）。
const rpcMethodFor = (toolName: string): string => toolName;

export const SPIKE_TOOL_NAMES: readonly string[] = ["atf_workspace_status", "atf_gate"];

/** spike 工具定义（TOOL_DEFINITIONS 单源切片；顺序保持契约登记序）。 */
export const spikeToolDefinitions = (): ToolDefinition[] =>
  TOOL_DEFINITIONS.filter((definition) => SPIKE_TOOL_NAMES.includes(definition.name));

export interface AtfAgentToolDeps {
  bridge: SpikeBridgeTransport;
  /** atf_workspace_status 成功返回的 scope_ref 落点（审批 hook 的账本定位键来源）；
   *  spike 装配共享同一 box（approvalHook.ts 消费）。 */
  scopeRefBox: { current: ScopeRef | undefined };
}

const textOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
};

/** 工具定义 → pi-agent-core AgentTool（执行=桥接径；审批不在本层——见文件头）。 */
export const toAtfAgentTool = (definition: ToolDefinition, deps: AtfAgentToolDeps): AgentTool =>
  ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters as unknown as AgentTool["parameters"],
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<any>> => {
    const paramCheck = checkSchema(params ?? {}, definition.parameters, definition.name);
    if (paramCheck !== null) {
      // 入参违规（循环侧已先做 validateToolArguments；此处防御径）→ 结构化错误结果回流
      return {
        content: [{ type: "text", text: textOf({ error: "schema_violation", tool: definition.name, message: paramCheck }) }],
        details: { error: "schema_violation" },
      };
    }
    const response = await deps.bridge.request(rpcMethodFor(definition.name), params ?? {});
    if (!response.ok) {
      const { code } = (response.error.detail ?? {}) as { code?: string };
      if (response.error.code === "request_rejected") {
        // 对端业务拒绝：结构化回填（isError 结果，模型可转述换路径——主线 rejected 语义）
        const detail = { tool: definition.name, reason: code ?? "rejected", detail: response.error.detail };
        return {
          content: [{ type: "text", text: textOf({ error: "rejected", ...detail }) }],
          details: detail,
        };
      }
      throw new Error(`桥接失败（${response.error.code}）: ${response.error.message}`);
    }
    const canonicalCheck = validateCanonicalOutput(rpcMethodFor(definition.name), definition.canonical_output as SchemaNode, response.value);
    if (!canonicalCheck.ok) {
      throw new Error(`canonical 输出校验失败（${canonicalCheck.error.code}）: ${canonicalCheck.error.message}`);
    }
    // scope_ref 捕获（状态面 → 账本定位键；审批 hook 消费）
    const result = response.value as { scope_ref?: ScopeRef };
    if (definition.name === "atf_workspace_status" && result.scope_ref !== undefined) {
      deps.scopeRefBox.current = result.scope_ref;
    }
    return {
      content: [{ type: "text", text: textOf(response.value) }],
      details: response.value as Record<string, unknown>,
    };
  },
});

/** spike 工具面装配（含审批旗标透出——审批 hook 以同一单源谓词判定，见 approvalHook.ts）。 */
export const buildSpikeAgentTools = (deps: AtfAgentToolDeps): AgentTool[] =>
  spikeToolDefinitions().map((definition) => toAtfAgentTool(definition, deps));

/** 供审批 hook 直接复用的单源判定（与 executor 消费点同一出口）。 */
export const spikeRequiresApproval = (definition: ToolDefinition, params: unknown): boolean => requiresApprovalFor(definition, params);
