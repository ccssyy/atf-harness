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
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";

/** 批㊶-N N-5：会话身份提取（exec.agent.session.id；取不到＝undefined 如实跳过）。 */
const sessionIdOfExec = (exec: unknown): string | undefined => {
  const id = (exec as { agent?: { session?: { id?: unknown } } }).agent?.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

/** 批㊶-P1 S2：会话 id → exec home 子目录段（路径安全词表 `A-Za-z0-9._-` 外折 `_`；
 *  空段折 `default`＝CLI 单会话形态）。仅作用于目录名段，会话 id 本体不改动。 */
const sessionHomeSlug = (sessionId: string): string => {
  const slug = sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return slug === "" ? "default" : slug;
};

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

/** 本地治理工具的 run 落点（M1 语义：scratch 落 runs/<run_id>/scratch，缺省 run "default"）。
 *  批㊶Q增补三 段3：双形态解析——新建 run 按发起会话工作区入桶（runs/<工作区>/<run_id>，
 *  workspace 归属由调用方传 exec 推导；default 系统级留根目录）。
 *  批㊶-P1 S2（D2①）：exec home 会话作用域化——WebUI 会话形态以会话 id 派生子目录
 *  `exec-home/<session-id>/`；无会话 id（CLI 单会话/测试）落 `exec-home/default/`。
 *  跨会话同名暂存互踩面（散放 awb_*.json 实锚）在子目录层消除；既有散放文件不迁移
 *  （D4①——根目录原地保留不冲突）；清理策略候裁本批不实现。 */
const localHostFor = (localRoots: { runsRoot: string; kernelDir: string; execHome: string }, args: Record<string, unknown>, exec: unknown): LocalToolHost => {
  const runId = typeof args["run_id"] === "string" && args["run_id"] !== "" ? args["run_id"] : "default";
  const scratchDir = join(resolveRunDir(localRoots.runsRoot, runId, { workspace: sessionWorkspaceSlug(exec) }), "scratch");
  mkdirSync(scratchDir, { recursive: true });
  const sessionId = sessionIdOfExec(exec);
  const home = join(localRoots.execHome, sessionHomeSlug(sessionId ?? "default"));
  mkdirSync(home, { recursive: true });
  return {
    scratchDir,
    kernelDir: localRoots.kernelDir,
    home,
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
            const host = localHostFor(localRoots, args, exec);
            const localResult = await localHandler(args, host);
            if (localResult.kind === "executed") return asToolValue(localResult.result);
            return asToolValue({ error: "rejected", tool: definition.name, reason: localResult.reason, ...(localResult.detail !== undefined ? { detail: localResult.detail } : {}) });
          }
          const bridge = await manager.transport();
          const agentTool = toAtfAgentTool(definition, { bridge, scopeRefBox: { current: undefined } });
          const result = await agentTool.execute(`dsh-${exec.callId ?? "call"}`, args);
          // 批㊶-M M-3 段事实轨：桥接面工具成功即登记（register/label_qc——run 归属取参数）
          const details = result.details as Record<string, unknown> | undefined;
          if (details !== undefined && details !== null && typeof details === "object" && !("error" in details)) {
            const segmentByTool: Record<string, string> = { atf_admit_data: "register", atf_label_qc_inspect: "label_qc" };
            const segment = segmentByTool[definition.name];
            const runIdForFact = typeof args["run_id"] === "string" && args["run_id"] !== "" ? args["run_id"] : "default";
            if (segment !== undefined && localRoots !== undefined) {
              // 批㊶Q增补三 段3：段事实/绑定落实际 run 目录（双形态解析——dir 已由 scratch 建立或存量平铺）
              const factRunDir = resolveRunDir(localRoots.runsRoot, runIdForFact);
              appendSegmentFact(factRunDir, segment, definition.name);
              // 批㊶-N N-5：会话绑定（桥接面——run_id 显式给出时才绑定；default 归属不明不绑）
              const sessionIdBridge = sessionIdOfExec(exec);
              if (sessionIdBridge !== undefined && runIdForFact !== "default") {
                appendBinding(factRunDir, sessionIdBridge);
              }
            }
          }
          return asToolValue(result.details);
        },
      }),
    );
  }
  return tools;
};
