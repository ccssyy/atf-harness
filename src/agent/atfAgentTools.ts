/**
 * 工具挂接层（方案丙 §三「tool 挂接层」）——ATF 内核桥 tool 化。
 *
 * 丙 v1（批 P）：九工具全挂接——TOOL_DEFINITIONS 全量投影（桥接契约单源，D-b 不引入
 * 第二权威），点号方法映射表与 core/tools/executor.ts 同表恢复。
 * 门 1a spike 双工具面保留为过滤视图（SPIKE_TOOL_NAMES）。
 *
 * 执行径（职责切分）：审批在 beforeToolCall hook（approvalHook.ts，账本闸继承主线语义）；
 * 本层只做 参数校验 → 桥接请求 → canonical output 校验（对端 ok=false → 结构化 rejected
 * 回填 isError 结果；桥接/契约故障 → throw 由循环折算 error 工具结果）。
 * 门 2 收口时与 ToolExecutor 抽共享执行内核（工单登记）。
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
import { FILE_TOOL_DEFINITIONS } from "./fileTools.js";

/** spike 桥接最小面（AtfBridgeConnection 结构满足；测试可注桩）。 */
export interface SpikeBridgeTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
}

/** 工具名 → RPC 方法显式映射（R1 D-1：模型面工具名不允许 "."；与 core/tools/executor.ts
 *  TOOL_METHOD_OVERRIDES 同表——门 2 抽共享单点，本表为丙线镜像）。 */
const TOOL_METHOD_OVERRIDES: Readonly<Record<string, string>> = {
  atf_data_admission_request: "atf_data_admission.request",
  atf_preparation_propose: "atf_preparation.propose",
  atf_style_cluster_execute: "atf_style_cluster.execute",
  atf_label_qc_inspect: "atf_label_qc.inspect",
  atf_label_qc_resolve: "atf_label_qc.resolve",
};

const rpcMethodFor = (toolName: string): string => TOOL_METHOD_OVERRIDES[toolName] ?? toolName;

/** 门 1a spike 双工具面（status 经桥执行＋gate 审批受试）。 */
export const SPIKE_TOOL_NAMES: readonly string[] = ["atf_workspace_status", "atf_gate"];

/** 全量工具定义（九工具，契约登记序）。 */
export const allToolDefinitions = (): ToolDefinition[] => [...TOOL_DEFINITIONS];

/** spike 工具定义切片（TOOL_DEFINITIONS 单源过滤）。 */
export const spikeToolDefinitions = (): ToolDefinition[] =>
  TOOL_DEFINITIONS.filter((definition) => SPIKE_TOOL_NAMES.includes(definition.name));

/** 全 face 查找单点（丙 v2 A7 起）：桥接面（TOOL_DEFINITIONS，契约登记）＋丙线本地治理面
 *  （FILE_TOOL_DEFINITIONS，A7 四工具）——审批 hook 以本出口为唯一工具定义查找点，
 *  本地工具同样入闸分类（写闸 fail-closed），不因不经桥而脱治理。 */
export const toolDefinitionFor = (toolName: string): ToolDefinition | undefined =>
  TOOL_DEFINITIONS.find((definition) => definition.name === toolName) ??
  FILE_TOOL_DEFINITIONS.find((definition) => definition.name === toolName);

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
  }) as AgentTool;

/** 丙 v1 装配：九工具全 face（缺省）或按 names 过滤（spike/门 1b 场景）。 */
export const buildAtfAgentTools = (deps: AtfAgentToolDeps, opts?: { names?: readonly string[] }): AgentTool[] => {
  const names = opts?.names;
  const definitions = names !== undefined ? TOOL_DEFINITIONS.filter((definition) => names.includes(definition.name)) : allToolDefinitions();
  return definitions.map((definition) => toAtfAgentTool(definition, deps));
};

/** spike 双工具面装配（门 1a 兼容入口）。 */
export const buildSpikeAgentTools = (deps: AtfAgentToolDeps): AgentTool[] => buildAtfAgentTools(deps, { names: SPIKE_TOOL_NAMES });

/** 供审批 hook 直接复用的单源判定（与 executor 消费点同一出口）。 */
export const spikeRequiresApproval = (definition: ToolDefinition, params: unknown): boolean => requiresApprovalFor(definition, params);
