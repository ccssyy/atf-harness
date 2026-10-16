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
  type LaunchGpuQueueFace,
  type LocalToolHost,
  type ToolDefinition,
} from "../../../../src/core/tools/index.js";
import { appendNotification } from "../../../../src/core/workspace/trainProbe.js";
import { resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import { awaitGpuWindow, gpuQueuePollMsFromEnv, queueHitText } from "./gpuQueueFace.js";
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
  // 批㊶-S4b-T4b（owner 产品裁定 2026-10-15「1甲」）：编排执行点对 DSH 面开放——
  // 桥接面六件→七件；本地治理径（WORKSPACE_TOOL_HANDLERS）经 bridgeFace 既有分派执行，
  // GPU 排队面（createLaunchGpuQueueFace）随 localHandler 注入同场生效。
  "atf_launch_execute",
  // 目录结构 v1 工具链（设计基线 D4/D5/D6）：工作区治理两件对 DSH 面开放——七件→九件。
  // 同为本地治理径（WORKSPACE_TOOL_HANDLERS），确定性文件操作单源 workspaceRegistry.ts；
  // 注册表写入语义（备份/原子落盘/实例重启生效）随工具回执如实携带。
  "atf_create_experiment",
  "atf_rebind_workspace",
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

  /** 批㊶-TRAIN-OBS-FIX2 T1：内核侧会话绑定（atf.bind_run——WebUI 宿主链对齐
   *  core/run/runner.ts:391-395 既有调用形态，connection.request 一跳、session 由
   *  bridge/内核侧记录，不新造机制）。幂等沿内核 B4（重复绑定允许覆盖＋event 留痕）；
   *  容错沿 appendBinding 既有语义（fail-open——spawn 失败/断线/error response 一律
   *  留痕降级，不阻塞工具主流程）。 */
  async bindRun(runId: string): Promise<void> {
    if (runId === "") return;
    try {
      const bridge = await this.transport();
      const bound = await bridge.request("atf.bind_run", { run_id: runId });
      if (!bound.ok) console.warn(`[atf-tools] atf.bind_run fail-open（run=${runId}）: ${bound.error.message}`);
    } catch (cause) {
      console.warn(`[atf-tools] atf.bind_run fail-open（run=${runId}）: ${(cause as Error).message}`);
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
const localHostFor = (localRoots: { runsRoot: string; kernelDir: string; execHome: string; dshHome?: string }, args: Record<string, unknown>, exec: unknown): LocalToolHost => {
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
    // 目录结构 v1 工具链：DSH 家同源注入（装配面显式值优先，回退本进程 DSH_HOME env→
    // ~/.dsh 解析链——与 vendor home-paths 一致；TUI/resume 装配缺席时 handler 同链回退）。
    dshHome: localRoots.dshHome ?? resolveDshHome(),
  };
};

/** 批㊶-S4b T1：编排主路径 GPU 排队面（host.gpuQueueFace 注入实现——gpuQueueFace 既有面
 *  同型挂法，对照 trainingFace atf_run_training :636–668 既有接线：ATF_GPU_POLL_MS 同源
 *  0＝直启旁路；整组 nproc 卡空闲判定＋compute-apps 归属；首探命中 7s 复探；无超时等待；
 *  gpu_queue 通报面（首探＋空闲数变化再报）；命中琥珀卡＝requestApproval 既有审批面
 *  （exec 信号 abort 直通）。requiredCards=null＝卡数不可判 fail-closed 不排队但发通报，
 *  不阻塞主线（owner 裁定固化）。core 直引 gpuQueueFace 不可达（dist 构建图 rootDir=src
 *  不含 packages/）——经 host 面注入是既有面的唯一干净复用通道。 */
export const createLaunchGpuQueueFace = (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; callId?: string; signal?: unknown } | undefined,
  overrides?: {
    awaitWindow?: typeof awaitGpuWindow;
    env?: NodeJS.ProcessEnv;
  },
): LaunchGpuQueueFace => ({
  gateLaunch: async (input) => {
    const pollMs = gpuQueuePollMsFromEnv(overrides?.env ?? process.env);
    if (pollMs === null) return { verdict: "proceed", queued: false }; // ATF_GPU_POLL_MS=0＝直启旁路
    if (input.requiredCards === null) {
      appendNotification(input.runDir, {
        level: "warn",
        kind: "gpu_queue",
        reason: "GPU 排队：launch.sh／launch_manifest 均未声明 nproc——卡数不可判、未排队（不阻塞主线，直接启动）",
        since: new Date().toISOString(),
      });
      return { verdict: "proceed", queued: false, queue_note: "required_cards_unknown_not_queued" };
    }
    let lastNotifiedIdle = -1;
    const windowState = await (overrides?.awaitWindow ?? awaitGpuWindow)({
      pollMs,
      requiredCards: input.requiredCards,
      signal: exec?.signal as { aborted: boolean } | undefined,
      onQueueStatus: (status) => {
        if (status.idle === lastNotifiedIdle) return;
        lastNotifiedIdle = status.idle;
        const short = status.idle < status.required
          ? `空闲不足（${status.required} 卡才能开跑）——等待释放，或在聊天显式降档 nproc 后重走确认卡`
          : "整组空闲数已满足——复探后开跑";
        appendNotification(input.runDir, {
          level: status.idle < status.required ? "warn" : "info",
          kind: "gpu_queue",
          reason: `GPU 排队：需 ${status.required} 卡、现空闲 ${status.idle}（已等待 ${status.waitedText}）——${short}`,
          since: new Date().toISOString(),
        });
      },
    });
    if (windowState.kind === "aborted") return { verdict: "aborted" };
    // 命中琥珀卡（放行守门——编排启动的工具审批此前已放行；此处为等待后的二次人工确认）
    const amber = await requestApproval(ctx, exec ?? {}, "atf_launch_execute", `${queueHitText(windowState.snapshot.gpuIndexes, windowState.snapshot.table)}（已等待 ${windowState.snapshot.waitedText}）——GPU 窗口命中，确认启动编排（launch.sh=${input.launchShRel}）`);
    if (!amber.ok) return { verdict: "denied", outcome: amber.outcome };
    return { verdict: "proceed", queued: true, waited_text: windowState.snapshot.waitedText, amber: "approved" };
  },
});

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
            // 批㊶-S4b T1：编排主路径排队面注入（atf_launch_execute 专用——其余本地工具不受影响；
            // 审批上下文 ctx/exec 与 gpuQueueFace 既有原语在此装配点同场可达）
            const host = localHostFor(localRoots, args, exec);
            if (definition.name === "atf_launch_execute") {
              host.gpuQueueFace = createLaunchGpuQueueFace(ctx, exec as { agent?: unknown; callId?: string; signal?: unknown } | undefined);
            }
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
