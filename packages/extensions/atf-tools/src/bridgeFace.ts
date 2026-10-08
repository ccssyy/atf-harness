/**
 * 桥接工具面（6 个契约工具：workspace_status / admit_data / label_qc_inspect /
 * scratch_exec / skill_read / gate）——逻辑零重写：直接复用手搓执行径
 * toAtfAgentTool（src/agent/atfAgentTools.ts：参数校验 → 桥接 request → canonical
 * 校验 → 结构化 rejected 回填），本层只做 DSH defineTool 包装＋DSH 审批 seam 前置。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AtfBridgeConnection } from "../../../../src/bridge/index.js";
import {
  TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_HANDLERS,
  requiresApprovalFor,
  type LocalToolHost,
  type ToolDefinition,
} from "../../../../src/core/tools/index.js";
import { toAtfAgentTool } from "../../../../src/agent/atfAgentTools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { translateParameters, looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, requestApproval } from "./approvalFace.js";

/** M1 指令清单里的桥接工具名（桥接契约面 ∪ 工作区治理分册）。 */
export const BRIDGE_TOOL_NAMES: readonly string[] = [
  "atf_workspace_status",
  "atf_admit_data",
  "atf_label_qc_inspect",
  "atf_scratch_exec",
  "atf_skill_read",
  "atf_gate",
];

/** 定义查找单源：桥接契约面（TOOL_DEFINITIONS）＋工作区治理分册（WORKSPACE_TOOL_DEFINITIONS，
 *  scratch_exec/skill_read 在此登记）——与手搓审批 hook 的唯一查找出口同构。 */
export const allDefinitions = (): ToolDefinition[] => {
  const seen = new Set<string>();
  const merged: ToolDefinition[] = [];
  for (const definition of [...TOOL_DEFINITIONS, ...WORKSPACE_TOOL_DEFINITIONS]) {
    if (!seen.has(definition.name)) {
      seen.add(definition.name);
      merged.push(definition);
    }
  }
  return merged;
};

/** 桥接连接懒管理：插件级单连接，失败/断线丢弃、下次调用重连（M1 生命周期决策：长驻＋重连）。 */
export class BridgeManager {
  private connection: AtfBridgeConnection | null = null;
  private connecting: Promise<AtfBridgeConnection> | null = null;

  constructor(
    private readonly command: readonly string[],
    private readonly cwd: string,
    /** 批㊶-E-H 项 2.1：桥子进程私有 env 增量（PYTHONPATH 等——不污进程面）。 */
    private readonly childEnv?: Readonly<Record<string, string>>,
  ) {}

  private async get(): Promise<AtfBridgeConnection> {
    if (this.connection !== null) return this.connection;
    if (this.connecting === null) {
      this.connecting = AtfBridgeConnection.spawn({
        command: this.command,
        cwd: this.cwd,
        ...(this.childEnv !== undefined ? { env: this.childEnv } : {}),
      }).then((spawned) => {
        if (!spawned.ok) {
          this.connecting = null;
          throw new Error(`atf 桥 spawn 失败（${spawned.error.code}）: ${spawned.error.message}`);
        }
        this.connection = spawned.value;
        this.connecting = null;
        return spawned.value;
      });
    }
    return this.connecting;
  }

  /** 连接直通（AtfBridgeConnection.request 返回 Result<unknown, BridgeError>——满足 SpikeBridgeTransport）。 */
  async transport(): Promise<AtfBridgeConnection> {
    try {
      return await this.get();
    } catch (cause: unknown) {
      this.connection = null;
      throw cause;
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) await connection.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
}

/** 本地治理工具的 run 落点（M1 语义：scratch 落 runs/<run_id>/scratch，缺省 run "default"）。 */
const localHostFor = (localRoots: { runsRoot: string; kernelDir: string; execHome: string }, args: Record<string, unknown>): LocalToolHost => {
  const runId = typeof args["run_id"] === "string" && args["run_id"] !== "" ? args["run_id"] : "default";
  const scratchDir = join(localRoots.runsRoot, runId, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  return {
    scratchDir,
    kernelDir: localRoots.kernelDir,
    home: localRoots.execHome,
    baseEnv: { ATF_SKILLS_AUTO_INSTALL: "0" },
  };
};

export const buildBridgeTools = (
  ctx: { get(service: string): unknown },
  manager: BridgeManager,
  localRoots?: { runsRoot: string; kernelDir: string; execHome: string },
): unknown[] => {
  const tools: unknown[] = [];
  const definitions = allDefinitions().filter((definition) => BRIDGE_TOOL_NAMES.includes(definition.name));
  for (const definition of definitions) {
    tools.push(
      defineTool({
        name: definition.name,
        description: definition.description,
        parameters: translateParameters(definition.parameters),
        output: {
          schema: looseObjectOutput,
          render: renderAsJsonText,
        },
        async execute(args: Record<string, unknown>, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
          // 审批前置（指令要求 2）：手搓 requiresApprovalFor 语义为唯一判定源
          if (requiresApprovalFor(definition, args)) {
            const verdict = await requestApproval(ctx, exec, definition.name, `执行 ${definition.name}（手搓版同款审批语义）`);
            if (!verdict.ok) return approvalDeniedResult(definition.name, verdict.outcome);
          }
          // 执行径分派（复用面与手搓一致）：工作区治理面（scratch_exec/skill_read）走
          // WORKSPACE_TOOL_HANDLERS 本地执行；桥接契约面走 toAtfAgentTool 桥接执行径。
          const localHandler = WORKSPACE_TOOL_HANDLERS[definition.name];
          if (localHandler !== undefined) {
            if (localRoots === undefined) throw new Error(`本地治理工具 ${definition.name} 缺 localRoots 装配（runsRoot/kernelDir/execHome）`);
            const host = localHostFor(localRoots, args);
            const localResult = await localHandler(args, host);
            if (localResult.kind === "executed") return asToolValue(localResult.result);
            return asToolValue({ error: "rejected", tool: definition.name, reason: localResult.reason, ...(localResult.detail !== undefined ? { detail: localResult.detail } : {}) });
          }
          const bridge = await manager.transport();
          const agentTool = toAtfAgentTool(definition, { bridge, scopeRefBox: { current: undefined } });
          const result = await agentTool.execute(`dsh-${exec.callId ?? "call"}`, args);
          return asToolValue(result.details);
        },
      }),
    );
  }
  return tools;
};
