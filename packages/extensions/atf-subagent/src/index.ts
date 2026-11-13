/**
 * @atf/dsh-atf-subagent —— ATF 训练子任务派发三件套的会话级 plugin（C1，1113 验证轮）。
 *
 * B 批教训锁（1112-2/1113 实锚）：dispatch 三件此前装在 harness WebUiSessionManager
 * （eval 驱动器专用入口），真机 web 进程从不加载它——本包把三件装进 vendor 原生
 * preset plugin 体系（atf-training 预设 plugins 清单挂载），验收锚真机路径。
 *
 * 形态适配：subagent.ts 工厂产物是 pi-agent-core AgentTool（harness loop 内部约定，
 * execute(toolCallId, params)）；vendor 工具面是 dsh-tools ToolDefinition（execute(args, exec)
 * 返回 canonical 值）。本包只做签名/结果包装——派发、fan-out、GateLock 串行、结果聚合
 * 全部复用工厂 execute（逻辑零复制，测真实实现）；schema 由 JSON Schema 方言直译为
 * DSH 参数表（照 atf-tools schemaTranslate 同款直译子集）。
 *
 * 装配语义（B1 保持）：
 * - 桥接连接共享 atf-tools 实例级 BridgeManager（ctx.atfBridgeManager，单连接不双 spawn）；
 * - 子任务审批继承同一操作员面：ApprovalSurface 适配 vendor approval 服务
 *   （allowed-once/rejected/cancelled/unavailable → granted/denied/aborted/suspended），
 *   主线 agent 从 dsh exec.agent 绑定（wrapper 先赋值再放行工厂 execute）；
 * - 写动作逐条过 GateLock（subagent.ts 工厂自挂，本包不重复实现）；
 * - 子任务模型面走 ATF_LLM_CONFIG（HarnessLlmConfig/v3）独立装配——与 vendor 会话
 *   选型解耦（headless 线同口径）；配置缺席降级 faux 并在 boot 日志留痕（可观测，非静默）。
 *
 * 残留（如实呈报）：主线 scopeRefBox 在 vendor 链无 harness 装配对应物——子任务账本
 * 定位域为空 box（审批走 surface+GateLock 不受影响；scope 域对账随真机轮验证）。
 * @module @atf/dsh-atf-subagent
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createChildInstructionRunner,
  createDispatchParallelTrainingSubtaskTool,
  createDispatchTrainingSubtaskTool,
  type SubagentDeps,
} from "../../../../src/agent/subagent.js";
import { createDeferredToolSet } from "../../../../src/agent/deferredTools.js";
import type { ApprovalSurface, ApprovalSurfaceVerdict } from "../../../../src/agent/approvalSurface.js";
import { createProviderStreamFn } from "../../../../src/agent/providerStreamFn.js";
import { loadLlmProviderConfig } from "../../../../src/llm/providerConfig.js";
import { createFauxStreamFn, fauxAssistantMessage } from "../../../../src/agent/fauxStream.js";
import type { SpikeBridgeTransport } from "../../../../src/agent/atfAgentTools.js";
import type { BridgeError } from "../../../../src/bridge/index.js";

export const name = "atf-subagent";
export const inject = ["tools"];

/** vendor approval 服务请求形态（本包只消费 request 一个面）。 */
interface VendorApprovalService {
  request(req: { agent: unknown; toolName: string; reason?: string }): Promise<string>;
}

/** DSH 属性 spec 直译子集（对齐 atf-tools schemaTranslate 的 DshPropertySpec 同款）。 */
type DshPropertySpec =
  | { type: "string"; description?: string; required?: true }
  | { type: "json"; description?: string; required?: true }
  | { type: "integer"; description?: string; required?: true }
  | { type: "number"; description?: string; required?: true }
  | { type: "boolean"; description?: string; required?: true };

/** JSON Schema 方言 → DSH 参数表（直译；未知类型如实抛错不猜——契约漂移宁可加载失败）。 */
const translateParams = (schema: unknown): Record<string, DshPropertySpec> => {
  const node = (schema ?? {}) as { properties?: Record<string, Record<string, unknown>>; required?: unknown };
  const requiredList = Array.isArray(node.required) ? (node.required as unknown[]) : [];
  const out: Record<string, DshPropertySpec> = {};
  for (const [key, prop] of Object.entries(node.properties ?? {})) {
    const description = typeof prop["description"] === "string" ? prop["description"] : undefined;
    const base = { ...(description !== undefined ? { description } : {}), ...(requiredList.includes(key) ? { required: true as const } : {}) };
    switch (prop["type"]) {
      case "string":
        out[key] = { type: "string", ...base };
        break;
      case "integer":
        out[key] = { type: "integer", ...base };
        break;
      case "number":
        out[key] = { type: "number", ...base };
        break;
      case "boolean":
        out[key] = { type: "boolean", ...base };
        break;
      case "object":
      case "array":
        out[key] = { type: "json", ...base };
        break;
      default:
        throw new Error(`[atf-subagent] 参数 ${key} 类型 ${JSON.stringify(prop["type"])} 不在直译闭集（fail-closed）`);
    }
  }
  return out;
};

/** 通用输出（与 atf-tools 桥接工具同款：loose object＋JSON 文本渲染——几行通用件自带）。 */
const looseObjectOutput = { type: "object", additionalProperties: true } as const;
const renderAsJsonText = (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
  { type: "text", text: JSON.stringify(value, null, 1) },
];

/** execute 返回收口：递归清洗为无损 JSON（DSH output 校验拒收 undefined 等非 lossless
 *  值——与 atf-tools asToolValue 同口径，几行通用件自带）。 */
const asToolValue = (value: unknown): Record<string, never> => {
  const clean = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (Array.isArray(v)) return v.map(clean);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (item !== undefined) out[k] = clean(item);
      }
      return out;
    }
    return v;
  };
  return clean(value) as Record<string, never>;
};

export async function apply(ctx: unknown, _config: unknown): Promise<void> {
  const c = ctx as {
    tools: { register(tool: unknown): void };
    get(service: string): unknown;
    atfBridgeManager?: {
      transport(): Promise<{ request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }> }>;
    };
  };
  // —— 前置依赖 fail-loud（可观测降级＝不注册三件，boot 日志留痕；不静默）——
  const manager = c.atfBridgeManager;
  if (manager === undefined) {
    console.warn("[atf-subagent] ⚠ ctx.atfBridgeManager 缺席（atf-tools 未挂载或未暴露）——dispatch 三件不注册（fail-closed）");
    return;
  }
  const sessionsRoot = process.env.ATF_WEBUI_SESSIONS_ROOT;
  if (sessionsRoot === undefined || sessionsRoot === "") {
    console.warn("[atf-subagent] ⚠ ATF_WEBUI_SESSIONS_ROOT 未设置——dispatch 三件不注册（本环境非 WebUI 实例形态）");
    return;
  }
  // 桥接惰性代理：首唤时经 BridgeManager 建连（与 atf-tools 工具面同一连接，不双 spawn）。
  const bridge: SpikeBridgeTransport = {
    request: async (method, params) => {
      const conn = await manager.transport();
      return conn.request(method, params);
    },
  };
  // —— 子任务模型面（ATF_LLM_CONFIG 独立装配；缺席 faux 降级留痕）——
  let childStreamFn: () => unknown;
  let childModel: unknown;
  let modelTag: string;
  const resolved = await loadLlmProviderConfig(process.env);
  if (resolved.ok) {
    const cfg = resolved.value;
    const assembled = createProviderStreamFn({
      provider_id: cfg.provider_id,
      model: cfg.model,
      base_url: cfg.base_url,
      api_key: cfg.api_key,
    });
    childStreamFn = () => assembled.streamFn;
    childModel = assembled.model;
    modelTag = cfg.model;
  } else {
    console.warn(`[atf-subagent] ⚠ LLM 配置解析失败（${resolved.error.message}）——子任务模型面降级 faux（主线模型不受影响）`);
    childStreamFn = () =>
      createFauxStreamFn([
        fauxAssistantMessage(
          [{ type: "text", text: "子任务模型宿主未配置（ATF_LLM_CONFIG）——请配置 Provider 后重试。" }],
          "stop",
        ),
      ]);
    modelTag = "webui";
  }
  // —— 审批继承：dsh execute 的 exec.agent 是主线 agent 唯一可靠绑定点（vendor UI
  // answerer 只应答自己拥有的 agent）；wrapper 先赋值再放行工厂 execute——子任务内
  // surface.ask 的时序必然晚于赋值。 ——
  const executionBox: { agent: unknown } = { agent: undefined };
  const surface: ApprovalSurface = {
    ask: async (info) => {
      const approval = c.get("approval") as VendorApprovalService | undefined;
      const agent = executionBox.agent;
      if (approval === undefined || agent === undefined) return { kind: "suspended" };
      const outcome = await approval.request({
        agent,
        toolName: info.tool,
        reason: `子任务内写动作确认（dispatch 派发链——继承同一操作员面）：${info.tool}`,
      });
      switch (String(outcome)) {
        case "allowed-once":
          return { kind: "granted" };
        case "rejected":
          return { kind: "denied" };
        case "cancelled":
          return { kind: "aborted" };
        default:
          return { kind: "suspended" };
      }
    },
  };
  const deps: SubagentDeps = {
    bridge,
    sessionsRoot,
    scopeRefBox: { current: undefined },
    surface,
    childStreamFn: childStreamFn as () => never,
    ...(childModel !== undefined ? { childModel: childModel as SubagentDeps["childModel"] } : {}),
    modelTag,
  };
  // —— dsh-tools 包装：签名/结果转换零逻辑复制（工厂 execute 内的参数校验、fan-out、
  // GateLock 串行、聚合全量复用）；AgentTool 返回 {content, details}，canonical 值取
  // details（SubtaskResult / 并行聚合形态）。 ——
  const dshToolOf = (agentTool: AgentTool): unknown =>
    defineTool({
      name: agentTool.name,
      description: agentTool.description,
      parameters: translateParams(agentTool.parameters),
      output: { schema: looseObjectOutput, render: renderAsJsonText },
      async execute(args: unknown, exec: { agent?: unknown }) {
        const agent = (exec as { agent?: unknown } | undefined)?.agent;
        if (agent !== undefined) executionBox.agent = agent;
        const outcome = (await (agentTool.execute as (id: string, p: unknown) => Promise<unknown>)("atf-subagent", args)) as {
          details?: unknown;
        };
        return asToolValue(outcome.details ?? outcome);
      },
    });
  const { tools: deferredTools } = createDeferredToolSet(createChildInstructionRunner(deps));
  const registered: string[] = [];
  for (const agentTool of [
    createDispatchTrainingSubtaskTool(deps),
    createDispatchParallelTrainingSubtaskTool(deps),
    ...deferredTools,
  ]) {
    c.tools.register(dshToolOf(agentTool));
    registered.push(agentTool.name);
  }
  console.log(`[atf-subagent] 已装配 dispatch 三件套（${registered.join(" / ")}；会话级 plugin——真机 WebUI 工具面；sessionsRoot=${sessionsRoot}）`);
}
