/**
 * 桥接工具面（6 个契约工具：workspace_status / admit_data / label_qc_inspect /
 * scratch_exec / skill_read / gate）——逻辑零重写：直接复用手搓执行径
 * toAtfAgentTool（src/agent/atfAgentTools.ts：参数校验 → 桥接 request → canonical
 * 校验 → 结构化 rejected 回填），本层只做 DSH defineTool 包装＋DSH 审批 seam 前置。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtfMcpConnection } from "../../../../src/mcp/connection.js";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import {
  TOOL_DEFINITIONS,
  WORKSPACE_TOOL_DEFINITIONS,
  WORKSPACE_TOOL_HANDLERS,
  checkSchema,
  requiresUserConfirmationOf,
  validateCanonicalOutput,
  type LaunchGpuQueueFace,
  type LocalToolHost,
  type SchemaNode,
  type ToolDefinition,
} from "../../../../src/core/tools/index.js";
import { rpcMethodFor } from "../../../../src/core/tools/methodOverrides.js";
import { appendNotification } from "@atf/dsh-atf-core";
import { registeredWorkspaceRoots, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import { awaitGpuWindow, formatCardTable, gpuQueuePollMsFromEnv } from "./gpuQueueFace.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { translateParameters, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import { askWithTimeout, ASK_TIMEOUT_MS_DEFAULT, type FormAskService } from "./confirmFace.js";
import type { ChoiceAskQuestion } from "./confirmFace.js";
import { APPROVAL_SEMANTICS_BY_TOOL } from "../../../../src/core/tools/toolDefinition.js";
import { permissionTierOf } from "./permissionTier.js";
import { appendExemptionRecord } from "./approvalExempt.js";
import { isTrainingAutopilot } from "./trainingPreset.js";
import { appendSegmentFact } from "@atf/dsh-atf-core";
import { appendBinding } from "@atf/dsh-atf-core";
import { resolveRunDir, sessionWorkspaceSlug } from "@atf/dsh-atf-core";
import { resolvePipelineRunDir } from "./pipelineFace.js";
import { SCOPE_UNRESOLVED_NOTE, resolveSessionWorkspace, sessionCwdOfExec } from "./scopeFace.js";
// E8c：业务动作名映射单源（webui GPU 队列卡同表复用——D152 卡面零内部工具名）
import { BRIDGE_ACTION_LABELS } from "../../../../src/agent/bridgeActionLabels.js";

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
/** 桥接返回体 pending_confirmations → 原生选项卡问题集（#13 统一交互面）。
 *  仅收编选项类（title 非空且 options 非空）；纯信息披露（无 options）不进卡。
 *  返回 questions（ ChoiceAskQuestion[]）与 meta（对应 title 序，答案映射基准）。 */
export const pendingChoiceQuestionsOf = (
  pending: readonly unknown[],
): { questions: ChoiceAskQuestion[]; meta: Array<{ title: string }> } => {
  const questions: ChoiceAskQuestion[] = [];
  const meta: Array<{ title: string }> = [];
  for (const item of pending) {
    if (item === null || typeof item !== "object") continue;
    const row = item as { title?: unknown; detail?: unknown; options?: unknown };
    const title = typeof row.title === "string" && row.title !== "" ? row.title : "";
    const options = Array.isArray(row.options)
      ? row.options.filter((opt): opt is string => typeof opt === "string" && opt !== "")
      : [];
    if (title === "" || options.length === 0) continue; // 非选项类不收编
    questions.push({
      id: `pending-${questions.length}`,
      question: title,
      ...(typeof row.detail === "string" && row.detail !== "" ? { detail: row.detail } : {}),
      options: options.map((opt) => ({ label: opt })),
      multiSelect: false,
    });
    meta.push({ title });
  }
  return { questions, meta };
};

/** 提问卡答案 → pending_answers（title 对位；custom 自由输入非空才带）。 */
export const pendingAnswersOf = (
  meta: readonly { title: string }[],
  answers: ReadonlyArray<{ id: string; selected: readonly string[]; custom?: string }>,
): Array<{ title: string; selected: string[]; custom?: string }> =>
  meta.map((entry, i) => {
    const ans = answers.find((row) => row.id === `pending-${i}`);
    const custom = ans !== undefined && typeof ans.custom === "string" && ans.custom.trim() !== "" ? ans.custom.trim() : undefined;
    return {
      title: entry.title,
      selected: ans !== undefined ? [...ans.selected] : [],
      ...(custom !== undefined ? { custom } : {}),
    };
  });
/** 桥接执行结果 details 安全读取（缺席/非对象=null）。 */
const detailsOf = (result: unknown): Record<string, unknown> | undefined => {
  const details = (result as { details?: unknown } | null)?.details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
};
/** D277:裁决卡分组摘要(模块级纯函数,vitest 可测)——disposition 归三类计数。 */
export const resolveCardGroupSummary = (ds: Array<Record<string, unknown>>): string => {
  const groups = new Map<string, number>();
  for (const d of ds) {
    const disp = String(d["disposition"] ?? "");
    const kind = disp.startsWith("keep_") ? "归属保留类" : disp === "set_value" ? "值修正类" : disp !== "" ? `其他(${disp})` : "未分类";
    groups.set(kind, (groups.get(kind) ?? 0) + 1);
  }
  return [...groups.entries()].map(([k, n]) => `${k} ${String(n)} 项`).join(" · ");
};
export const BRIDGE_TOOL_NAMES: readonly string[] = [
  "atf_workspace_status",
  "atf_admit_data",
  "atf_label_qc_inspect",
  // F14（2026-10-28）：裁决入口必须与 inspect 同面开放——只给 inspect 等于"看得到冲突、
  // 提交不了裁决"，agent 只能把任务当新的重开，于是同实验下不断新增 run 目录（现场
  // run-awb-01/03/04）。内核方法 atf_label_qc.resolve 早已就绪（tools.py 的
  // registry.register 登记位），harness 定义与审批文案也在
  // （toolDefinition.ts:394、approvalCopy.ts:93），缺的只是这张名单。
  "atf_label_qc_resolve",
  "atf_scratch_exec",
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
  // G5 阶段 2（D6 基线并集=9 模型面+5 本地治理面）：其余四件模型面工具经 MCP
  // tools/list 进装配——此前仅在 webui/pi 线可达，MCP 化后与内核 15 方法模型面
  // 完全对齐（fact_scan/data_admission_request/preparation_propose/style_cluster_execute）。
  "atf_fact_scan",
  "atf_data_admission_request",
  "atf_preparation_propose",
  "atf_style_cluster_execute",
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
/** 会话工作区路径反查（ci-bl-1103 治理面分连接用）。
 *
 *  exec.agent.session.header.cwd（vendor 锚，与 sessionWorkspaceSlug 同源）的
 *  basename slug 在注册工作区根（registeredWorkspaceRoots）下恰一处在场 →
 *  返回该工作区绝对路径；取不到/不在注册表/多义 → null（调用方落 default 连接）。
 *  注册表缺席形态不猜根（与 fileGuard 围栏同纪律）。 */
export const workspacePathOfExec = (exec: unknown): string | null => {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } })
    ?.agent?.session?.header?.cwd;
  const slug = sessionWorkspaceSlug(exec);
  if (typeof cwd !== "string" || slug === null) return null;
  const hits: string[] = [];
  for (const root of registeredWorkspaceRoots()) {
    const candidate = join(root, slug);
    if (existsSync(candidate)) hits.push(candidate);
  }
  return hits.length === 1 ? (hits[0] as string) : null;
};

export class BridgeManager {
  /** G5：内部传输已换 MCP stdio 连接器（AtfMcpConnection——request 面 SpikeBridgeTransport
   *  兼容，消费面零改动）；单连接懒建立、失败/断线丢弃重连语义不变。 */
  private connection: AtfMcpConnection | null = null;
  private connecting: Promise<AtfMcpConnection> | null = null;
  /** 工作区分连接池（ci-bl-1103 治理面）：key=工作区绝对路径。 */
  private readonly scopedConnections = new Map<string, Promise<AtfMcpConnection>>();

  constructor(
    private readonly command: readonly string[],
    private readonly cwd: string,
    /** 批㊶-E-H 项 2.1：桥子进程私有 env 增量（PYTHONPATH 等——不污进程面）。 */
    private readonly childEnv?: Readonly<Record<string, string>>,
  ) {}

  private async get(): Promise<AtfMcpConnection> {
    if (this.connection !== null) return this.connection;
    if (this.connecting === null) {
      this.connecting = AtfMcpConnection.spawn({
        command: this.command,
        cwd: this.cwd,
        ...(this.childEnv !== undefined ? { env: this.childEnv } : {}),
      }).then((spawned) => {
        if (!spawned.ok) {
          this.connecting = null;
          throw new Error(`atf MCP 连接 spawn 失败（${spawned.error.code}）: ${spawned.error.message}`);
        }
        this.connection = spawned.value;
        this.connecting = null;
        return spawned.value;
      });
    }
    return this.connecting;
  }

  /** 连接直通（AtfMcpConnection.request 返回 Result<unknown, BridgeError>——满足 SpikeBridgeTransport）。 */
  async transport(): Promise<AtfMcpConnection> {
    try {
      return await this.get();
    } catch (cause: unknown) {
      this.connection = null;
      throw cause;
    }
  }

  /** MCP tools/list 装配面（懒连接+缓存；失败 fail-closed 抛错——任务书候裁默认②：
   *  server 启动/列举失败即拒绝装配，不静默降级本地 schema 副本）。 */
  async mcpTools(): Promise<import("../../../../src/mcp/connection.js").McpToolDescriptor[]> {
    const connection = await this.transport();
    const listed = await connection.listTools();
    if (!listed.ok) {
      this.connection = null; // 列举失败丢弃连接（下次重 spawn）
      throw new Error(`MCP tools/list 失败（fail-closed 拒装配）: ${listed.error.message}`);
    }
    return listed.value;
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
    const scoped = Array.from(this.scopedConnections.values());
    this.scopedConnections.clear();
    for (const pending of scoped) {
      pending.then((conn) => conn.close({ timeoutMs: 5_000 }).catch(() => undefined)).catch(() => undefined);
    }
  }

  /** 治理面工作区分连接（ci-bl-1103）：同一工作区的会话共享一个 serve，
   *  首连 bind_workspace 把内核 workspace 根定到该工作区（此后登记面/事实面
   *  解析都落本工作区——段驱动登记的 dataset 治理面可见）。
   *
   *  与 bind_run 的 fail-open 不同：workspace 绑定决定数据落点，绑不上就
   *  fail-closed 抛错（宁可拒绝不可落错根——错根即跨工作区数据事故）。
   *  连接失败不缓存（下次调用重 spawn）；bind 成功后连接按工作区复用。 */
  async transportForWorkspace(workspacePath: string): Promise<AtfMcpConnection> {
    const existing = this.scopedConnections.get(workspacePath);
    if (existing !== undefined) return existing;
    const pending = AtfMcpConnection.spawn({
      command: this.command,
      cwd: this.cwd,
      ...(this.childEnv !== undefined ? { env: this.childEnv } : {}),
    }).then(async (spawned) => {
      if (!spawned.ok) {
        throw new Error(`atf 治理面 MCP spawn 失败（${spawned.error.code}）: ${spawned.error.message}`);
      }
      const bound = await spawned.value.request("atf.bind_workspace", { workspace_path: workspacePath });
      if (!bound.ok) {
        await spawned.value.close({ timeoutMs: 5_000 }).catch(() => undefined);
        throw new Error(`atf.bind_workspace 失败（${workspacePath}）: ${bound.error.message}`);
      }
      return spawned.value;
    });
    this.scopedConnections.set(workspacePath, pending);
    // 失败不缓存：并发等待者共享同一 rejection，下次调用重新 spawn
    pending.catch(() => { this.scopedConnections.delete(workspacePath); });
    return pending;
  }
}

/** 本地治理工具的 run 落点（M1 语义：scratch 落 runs/<run_id>/scratch，缺省 run "default"）。
 *  批㊶Q增补三 段3：双形态解析——新建 run 按发起会话工作区入桶（runs/<工作区>/<run_id>，
 *  workspace 归属由调用方传 exec 推导；default 系统级留根目录）。
 *  批㊶-P1 S2（D2①）：exec home 会话作用域化——WebUI 会话形态以会话 id 派生子目录
 *  `exec-home/<session-id>/`；无会话 id（CLI 单会话/测试）落 `exec-home/default/`。
 *  跨会话同名暂存互踩面（散放 awb_*.json 实锚）在子目录层消除；既有散放文件不迁移
 *  （D4①——根目录原地保留不冲突）；清理策略候裁本批不实现。 */
export const localHostFor = (localRoots: { runsRoot: string; kernelDir: string; execHome: string; dshHome?: string }, args: Record<string, unknown>, exec: unknown): LocalToolHost => {
  const runId = typeof args["run_id"] === "string" && args["run_id"] !== "" ? args["run_id"] : "default";
  // 显式工作区优先：验证/临时工作区的 run 不在实例桶布局下（<ws>/workspace/runs/<id>），
  // 只按实例 runsRoot 解析会落到桶里的同名残留目录（真机 ws2 事故：启动件被"布点"进
  // runs/default，且读的是 10-24 的旧件）。显式给了工作区就按 RunLayout 单源解析。
  const explicitWorkspace = typeof args["workspace_path"] === "string" ? args["workspace_path"].trim() : "";
  const runDir = (() => {
    if (explicitWorkspace !== "") {
      const resolved = resolvePipelineRunDir(explicitWorkspace, runId);
      if (!("error" in resolved)) return resolved.runDir;
    }
    // D115：run 目录单源（与 scratch 同一解析——run 树启动件/就绪检测的根）。
    // RunLayout/v3 canonical 档带注册工作区根：v3 canonical run 住
    // `<ws>/experiments/<exp>/<run_id>`，不带＝落到 runsRoot 同名残留目录（真机 ws2 事故同族）。
    return resolveRunDir(localRoots.runsRoot, runId, {
      workspace: sessionWorkspaceSlug(exec),
      canonicalRoots: registeredWorkspaceRoots(localRoots.dshHome),
    });
  })();
  const scratchDir = join(runDir, "scratch");
  // 显式工作区形态不代建目录：工作区路径是否存在由治理工具校验——此处无条件 mkdir
  // 会把「不存在的路径」变成存在，绕过 atf_create_experiment 的「不代建顶层工作区
  // 目录」闸（真机表现为该工具对不存在路径返回 ok:true）。
  // 追加 gate（RunLayout/v3 fail-closed）：run 目录本身不在场＝run 还没建（register 段经内核
  // create_run 落位）——此时在占位路径下建 scratch 会让内核判「落点已被占用且缺合法 run.json」
  // 而永久拒绝该 run_id。故只在 run 已存在时建 scratch（runDir 由上面的单源解析给出）。
  if ((explicitWorkspace === "" || existsSync(explicitWorkspace)) && existsSync(runDir)) {
    mkdirSync(scratchDir, { recursive: true });
  }
  const sessionId = sessionIdOfExec(exec);
  const home = join(localRoots.execHome, sessionHomeSlug(sessionId ?? "default"));
  mkdirSync(home, { recursive: true });
  return {
    scratchDir,
    runDir,
    kernelDir: localRoots.kernelDir,
    home,
    baseEnv: { ATF_SKILLS_AUTO_INSTALL: "0" },
    // 目录结构 v1 工具链：DSH 家同源注入（装配面显式值优先，回退本进程 DSH_HOME env→
    // ~/.dsh 解析链——与 vendor home-paths 一致；TUI/resume 装配缺席时 handler 同链回退）。
    dshHome: localRoots.dshHome ?? resolveDshHome(),
    // 实例根同源注入（ATF_INSTANCE_ROOT 由实例 env 声明；缺席＝非实例形态，定域校验不启用）。
    instanceRoot: process.env["ATF_INSTANCE_ROOT"],
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
    const amber = await requestApproval(ctx, exec ?? {}, "atf_launch_execute",
      buildApprovalReason({
        action: "启动训练编排",
        target: `（GPU ${windowState.snapshot.gpuIndexes.join("、")} 空闲命中，已等待 ${windowState.snapshot.waitedText}；launch.sh=${input.launchShRel}）`,
        effect: "占用 GPU 与写训练编排产物",
        reversible: "不可自动回滚（产物可人工清理）",
      }) + `\n${formatCardTable(windowState.snapshot.table)}`);
    if (!amber.ok) return { verdict: "denied", outcome: amber.outcome };
    return { verdict: "proceed", queued: true, waited_text: windowState.snapshot.waitedText, amber: "approved" };
  },
});

/** G5 MCP 工厂装配面门控（阶段 1：atf_workspace_status 先行验证；阶段 2 扩至 9 件）。 */
const MCP_FACTORY_NAMES: ReadonlySet<string> = new Set([
  "atf_workspace_status",
  "atf_fact_scan",
  "atf_gate",
  "atf_admit_data",
  "atf_data_admission_request",
  "atf_preparation_propose",
  "atf_style_cluster_execute",
  "atf_label_qc_inspect",
  "atf_label_qc_resolve",
]);

/** MCP 执行径（G5）：checkSchema → tools/call → canonical 校验 → rejected 回填——
 *  回填形态与 toAtfAgentTool（src/agent/atfAgentTools.ts）逐字对齐，仅传输层换 MCP。 */
const runKernelViaMcp = async (
  definition: ToolDefinition,
  bridge: AtfMcpConnection,
  args: Record<string, unknown>,
): Promise<{ rejected: boolean; details: Record<string, unknown> }> => {
  const paramCheck = checkSchema(args ?? {}, definition.parameters, definition.name);
  if (paramCheck !== null) {
    return { rejected: true, details: { error: "schema_violation", tool: definition.name, message: paramCheck } };
  }
  const response = await bridge.request(rpcMethodFor(definition.name), args);
  if (!response.ok) {
    const { code } = (response.error.detail ?? {}) as { code?: string };
    if (response.error.code === "request_rejected") {
      // 对端业务拒绝：结构化回填（isError 结果，模型可转述换路径——与旧径 rejected 语义逐字一致）
      return { rejected: true, details: { tool: definition.name, reason: code ?? "rejected", detail: response.error.detail } };
    }
    throw new Error(`桥接失败（${response.error.code}）: ${response.error.message}`);
  }
  const canonicalCheck = validateCanonicalOutput(rpcMethodFor(definition.name), definition.canonical_output as SchemaNode, response.value);
  if (!canonicalCheck.ok) {
    throw new Error(`canonical 输出校验失败（${canonicalCheck.error.code}）: ${canonicalCheck.error.message}`);
  }
  return { rejected: false, details: response.value as Record<string, unknown> };
};


export const buildBridgeTools = async (
  ctx: { get(service: string): unknown },
  manager: BridgeManager,
  localRoots?: { runsRoot: string; kernelDir: string; execHome: string },
): Promise<unknown[]> => {
  const tools: unknown[] = [];
  // G5：tools/list 装配面拉取（fail-closed——候裁默认②：server 启动/列举失败即拒装配，
  // 不静默降级本地 schema 副本）。schema 零复制：工厂件三件套全部取自此处。
  const mcpDescriptors = await manager.mcpTools();
  const descriptorByRawName = new Map(mcpDescriptors.map((tool) => [tool.name, tool]));
  const definitions = allDefinitions().filter((definition) => BRIDGE_TOOL_NAMES.includes(definition.name));
  for (const definition of definitions) {
    const governedTool = defineTool({
        name: definition.name,
        description: definition.description,
        // 参数面单一真相源＝定义处（workspaceTools 的 LAUNCH_EXECUTE_PARAMS 已含
        // run_id／workspace_path／launch_sh 三形态／config 自动探测）——此处只做投影，
        // 不得二次增删参数：投影层加的参数 handler 不读，是假参数（真机踩过，
        // 模型照 schema 传了却被 handler 判缺参）。
        parameters: translateParameters(definition.parameters),
        output: {
          // 声明面（保守——候裁默认动作：族并集共有键）：本位一位多工具（BRIDGE_TOOL_NAMES
          // 十一件：workspace_status/admit_data/label_qc_inspect/label_qc_resolve/scratch_exec/
          // skill_read/gate/launch_execute/create_experiment/rebind_workspace），各工具成功
          // details 形态由内核 canonical 各自定义（run_id/admitted_count/counts/scope_ref 等）
          // ——单工具特有键不入声明。跨全族稳定的顶层键＝包装层守卫早退与桥接执行径
          // rejected 面的并集：resolve 缺参 {error,tool,missing,how_to_fix}；确认卡暂停两态
          // {error,tool,note}；本地治理 rejected {error,tool,reason[,detail]}；桥接 schema_
          // violation {error,tool,message}／request_rejected {tool,reason[,detail]}；成功 details
          // 就地附加键（pending_answers/pending_card_note/workspace_id 等）随内核体开放透出。
          schema: {
            type: "object",
            additionalProperties: true,
            properties: {
              error: { type: "string", description: "拒绝码（label_qc_resolve_params_missing/user_decision_paused/launch_paused_by_user/rejected/schema_violation 或内核业务拒绝码）——note/message 里带对应说明" },
              tool: { type: "string", description: "产生本回执的工具名（atf_* 桥接/治理工具名）" },
              note: { type: "string", description: "人读说明与行为指引（确认卡暂停/附加说明等）" },
              message: { type: "string", description: "参数校验拒绝说明（error=schema_violation 时）" },
              reason: { type: "string", description: "执行拒绝原因码（error=rejected 时——本地治理/桥接对端拒绝）" },
              missing: { type: "array", description: "缺失参数名清单（label_qc_resolve 缺参时）" },
              how_to_fix: { type: "string", description: "缺参修复指引（label_qc_resolve 缺参时）" },
              detail: { type: "json", description: "拒绝明细原样透传（对端/本地治理拒绝时——形态不定）" },
            },
          },
          render: renderAsJsonText,
        },
        async execute(args: Record<string, unknown>, exec: { agent?: unknown; callId?: string; signal?: unknown }) {
/** D184 重做:resolve 的 decisions 与用户卡面凭据账本逐项一致判定。
 *  账本由 harness 在用户逐项裁决卡落卡后写入(runtime/webui/label-qc-decisions.json);
 *  agent 自拟 decisions 或篡改项即不一致→走批量确认卡。 */
const matchesLabelQcUserDecisions = async (args: Record<string, unknown>): Promise<boolean> => {
  const runId = typeof args["run_id"] === "string" ? args["run_id"] : "";
  const workspacePath = typeof args["workspace_path"] === "string" ? args["workspace_path"] : "";
  const decisions = Array.isArray(args["decisions"]) ? (args["decisions"] as Array<Record<string, unknown>>) : [];
  if (runId === "" || workspacePath === "" || decisions.length === 0) return false;
  try {
    const resolvedRun = resolvePipelineRunDir(workspacePath, runId);
    if ("error" in resolvedRun) return false;
    const ledgerPath = join(resolvedRun.runDir, "runtime", "webui", "label-qc-decisions.json");
    if (!existsSync(ledgerPath)) return false;
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      decided_by?: unknown; decisions?: Array<{ item_id?: unknown; action?: unknown; disposition?: unknown }>;
    };
    if (ledger.decided_by !== "user_confirmed" || !Array.isArray(ledger.decisions)) return false;
    if (ledger.decisions.length !== decisions.length) return false;
    return ledger.decisions.every((entry, i) => {
      const given = decisions[i] ?? {};
      return String(given["item_id"] ?? "") === String(entry.item_id ?? "")
        && String(given["action"] ?? "") === String(entry.action ?? "")
        && String(given["disposition"] ?? "") === String(entry.disposition ?? "");
    });
  } catch {
    return false;
  }
};

/** D192 用户决定确认卡:裁决类工具(user_decision)执行前逐项呈现并停等确认。
 *  decisions 逐项(item_id/action/disposition)进卡面 markdown 表;确认=执行
 *  (卡面回执即 user_confirmed 凭据),暂停=不执行。通道缺席 fail-closed(不放行)。 */
const userDecisionConfirmCardOf = async (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; signal?: unknown; callId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; note: string }> => {
  const svc = ctx.get("userQuestions") as FormAskService | undefined;
  if (svc === undefined || typeof svc.ask !== "function") {
    // D284 无人值守形态（env 开关，与 approvalExempt/unattendedGuard 对称）:
    // headless 宿主无 userQuestions 服务——atf-unattended 档语义=需要用户决定的点
    // 由 agent 自行判断（decided_by=agent 落账,代决项进结论）,裁决照提不放空;
    // 无 env=原 fail-closed 语义零变化（用户决定不可代行）。
    if (process.env.ATF_HEADLESS_PRESET === "atf-unattended") {
      return { ok: true, note: "无人值守档（headless）:确认卡通道缺席,裁决由 agent 判定（decided_by=agent 落账,代决项须在结论列明）" };
    }
    return { ok: false, note: "确认卡通道缺席——裁决类工具不放行(用户决定不可代行);稍后重试或在对话里说明处置意见" };
  }
  const decisions = Array.isArray(args["decisions"]) ? (args["decisions"] as Array<Record<string, unknown>>) : [];
  if (decisions.length === 0) {
    return { ok: true, note: "无逐项决定载荷——按工具自身校验处理" };
  }
  // D252 用户可读投影：处置枚举翻用户话（九项闭集），judgements/reason_text 的
  // agent 看图结论随行上卡——item_id/枚举裸值对用户无意义（盲确认=治理空转）。
  const DISPOSITION_ZH: Record<string, string> = {
    keep_first: "保留第一候选",
    keep_second: "保留第二候选",
    keep_both: "两个候选都保留",
    drop_both: "两个候选都丢弃",
    set_value: "改为指定值",
    dedupe: "去重合并",
    fix_field: "归属到正确字段",
    clip_to_bounds: "裁剪到边界内",
    no_action: "不处理",
  };
  const reasonOf = (d: Record<string, unknown>): string => {
    const juds = Array.isArray(d["judgements"]) ? (d["judgements"] as Array<Record<string, unknown>>) : [];
    for (const j of juds) {
      const rt = typeof j["reason_text"] === "string" ? j["reason_text"].trim() : "";
      if (rt !== "") return rt;
    }
    const rt = typeof d["reason_text"] === "string" ? d["reason_text"].trim() : "";
    return rt !== "" ? rt : (String(d["disposition"] ?? "") !== "" ? "（agent 未附理由——详情见对话分析）" : "");
  };
  const dispositionZhOf = (d: Record<string, unknown>): string => {
    const disp = String(d["disposition"] ?? "");
    const zh = DISPOSITION_ZH[disp] ?? disp;
    const target = typeof d["target_candidate_id"] === "string" && d["target_candidate_id"] !== "" ? `（${String(d["target_candidate_id"])}）` : "";
    const value = typeof d["modified_value"] === "string" && d["modified_value"] !== "" ? `（新值：${String(d["modified_value"])}）` : "";
    const field = typeof d["target_field"] === "string" && d["target_field"] !== "" ? `（归属 ${String(d["target_field"])}）` : "";
    return `${zh}${target}${value}${field}`;
  };
  const rows = decisions.map((d, i) => {
    const item = String(d["item_id"] ?? "?");
    const reason = reasonOf(d);
    const itemCell = reason !== "" ? `${item}——${reason}` : item;
    return `| ${String(i + 1)} | ${itemCell} | ${dispositionZhOf(d)} | ${d["action"] === "reject" ? "维持原状不处置" : "按建议处置"} |`;
  }).join("\n");
  // D277:卡面按裁决类型分组摘要——操作员连开多卡/单卡多裁决时可辨类型
  // (归属保留类 vs 值修正类),不再因标题同形误判「重复弹卡」。
  const groupNote = toolName === "atf_label_qc_resolve" ? resolveCardGroupSummary(decisions) : "";
  const title = toolName === "atf_label_qc_resolve"
    ? `标注冲突裁决确认（共 ${String(decisions.length)} 项${groupNote !== "" ? `：${groupNote}` : ""}）`
    : "用户决定确认";
  try {
    // 阶段2-1：卡面限时等待（解 zcode A3「resolve 挂起 25 分钟无超时无告警」）。
    // 有 askTimed 能力且未关闭限时 → 超时转 pending 并如实回执，不永久阻塞 agent 回合。
    const answers = await askWithTimeout(svc, {
      questions: [{
        id: `user-decision-${toolName}-${String(Date.now())}`,
        question: `${title}${groupNote !== "" ? "" : `——以下 ${String(decisions.length)} 项处置请确认`}`,
        header: title,
        detail: [
          ...(toolName === "atf_label_qc_resolve" && decisions.length === 1
            ? ["〔D277 提醒〕本卡仅 1 项——若同 run 尚有其它待裁决项，应汇总为一次提交，不要逐条多次调用。", ""]
            : []),
          `| # | 待裁决项 | 建议处置 | 说明 |`,
          `|---|---|---|---|`,
          rows,
          "",
          "以上每行=一项冲突裁决:裁决项含 agent 看图结论,处置已翻成用户话(保留哪个候选/改成什么值);确认后逐项按上表提交并留痕(要改某项就在输入框写哪一项怎么改)。",
          "暂停则不提交,你在对话里说明想怎么改。",
        ].join("\n"),
        options: [
          { label: "确认按建议提交", description: "逐项按上表处置提交并留痕" },
          { label: "暂停，我要调整", description: "不提交;在对话里说明调整意见" },
        ],
        multiSelect: false,
      }],
      agent: exec.agent,
      signal: exec.signal,
    }, exec);
    if ("pending" in answers && answers.pending === true) {
      // 超时转 pending：不当作"未作答"，也不假报确认——如实说"等你回来续答"。
      return {
        ok: false,
        note: `等待超时（${String(Math.round(ASK_TIMEOUT_MS_DEFAULT / 1000))}s 内未应答）——本项待续答，未提交；你在下一轮可直接作答，或再次调用本工具`,
      };
    }
    const first = answers.answers[0];
    const picked = [...(first?.selected ?? [])].join("") || (first?.custom ?? "");
    const confirmed = picked.includes("确认按建议提交") || (picked.trim() !== "" && !picked.includes("暂停"));
    return { ok: confirmed, note: confirmed ? "用户已在卡上确认(留痕)" : "用户暂停——未提交,等调整意见" };
  } catch (error) {
    // D284 无人值守形态（与 svc 缺席分支对称）:ask 通道在 headless 异常/暂停
    // （user_decision_paused）——atf-unattended 档裁决照提（decided_by=agent 落账,
    // 代决项列明）;无 env 原 fail-closed 零变化。
    if (process.env.ATF_HEADLESS_PRESET === "atf-unattended") {
      console.warn(`[approval] 无人值守档（headless）:确认卡通道异常（${String(error instanceof Error ? error.message : error).slice(0, 80)}）,裁决由 agent 判定照提（decided_by=agent 落账）`);
      return { ok: true, note: "无人值守档（headless）:确认卡通道异常,裁决由 agent 判定照提（decided_by=agent 落账,代决项须在结论列明）" };
    }
    return { ok: false, note: "确认卡通道异常——不放行" };
  }
};

/** D186 训练启动确认卡：完全权限档下替代 DSH 审批卡（owner 2026-11-04 裁定——
 * 不弹审批卡，停下来给用户汇报完整实验准备与参数设置报告，确认后再启动）。
 * 报告数据全部只读自 run 树（variants_report/iteration-config/train.sh/prelaunch 报告）。 */
const launchConfirmCardOf = async (
  ctx: { get(service: string): unknown },
  exec: { agent?: unknown; signal?: unknown },
  args: Record<string, unknown>,
): Promise<{ ok: boolean; note: string }> => {
  const svc = ctx.get("userQuestions") as { ask?: (payload: unknown) => Promise<{ answers: Array<{ selected?: string[]; custom?: string }> }> } | undefined;
  if (svc === undefined || typeof svc.ask !== "function") {
    return { ok: true, note: "确认卡通道缺席——按既有审批轨处理" };
  }
  const runId = typeof args["run_id"] === "string" ? args["run_id"] : "";
  const workspacePath = typeof args["workspace_path"] === "string" ? args["workspace_path"] : "";
  const lines: string[] = [];
  let paramTable = "";
  let scriptLink = "";
  if (runId !== "" && workspacePath !== "") {
    const resolved = resolvePipelineRunDir(workspacePath, runId);
    if (!("error" in resolved)) {
      const runDir = resolved.runDir;
      // ① 数据集组成（D259②:详报归对话流——本卡只留一行引用+增强缺口警示;
      //    完整 kind 组成/token 门/负样本对账在 variants-analysis-<doc>.md 与对话流报告）
      lines.push("### 数据构造状态");
      const variantsRoot = join(runDir, "data", "variants");
      if (existsSync(variantsRoot)) {
        const docs = readdirSync(variantsRoot).filter((doc) =>
          existsSync(join(variantsRoot, doc, "variants_report.json")));
        if (docs.length > 0) {
          const analysisLinks = docs
            .map((doc) => `[variants-analysis-${doc}.md](${join(runDir, "analysis", `variants-analysis-${doc}.md`)})`)
            .join(" ｜ ");
          lines.push(`- 构造已完成（${docs.join("、")}）——完整构造报告已在对话流展示，验收报告：${analysisLinks}`);
          // D210(e2e 轮实锚,保留):增强缺口是治理必要披露——缺口与原因必须在卡面可见
          for (const doc of docs) {
            try {
              const report = JSON.parse(readFileSync(join(variantsRoot, doc, "variants_report.json"), "utf8")) as {
                mode5?: { status?: string; requested_rows_total?: number; effective_rows_total?: number; shortfall_rows?: number; support_note?: string };
                kind_counts?: Record<string, number>;
              };
              const m5 = report.mode5;
              if (m5 !== undefined && m5.status === "completed_with_shortfall") {
                lines.push(`  - ⚠ ${doc} 增强缺口：请求 ${String(m5.requested_rows_total ?? "?")} 条、实产 ${String(m5.effective_rows_total ?? "?")} 条（差 ${String(m5.shortfall_rows ?? "?")}）——${m5.support_note ?? "字段池/尝试预算耗尽"}`);
              }
              const tg2 = (report as { targeted?: { advice_source?: string } | null }).targeted;
              if (tg2 !== undefined && tg2 !== null && tg2.advice_source === "guard_unavailable") {
                lines.push(`  - ⚠ ${doc} 重点增强守护缺席（advice_source=guard_unavailable）：重点字段的选择依据未经守护校验，产出条数参考价值有限`);
              }
              if (report.kind_counts !== undefined && report.kind_counts["targeted"] === undefined) {
                lines.push(`  - ⚠ ${doc} 未含 targeted 重点增强（建议确认链未走或构造链缺陷 D261——详见对话流报告）`);
              }
            } catch { /* 报告不可读按缺省呈现 */ }
          }
        } else {
          lines.push("-（构造产物目录缺席）");
        }
      } else {
        lines.push("-（构造产物目录缺席）");
      }
      // ② 参数设置报告（iteration-config 关键训练参数）
      const configCandidates = [
        join(runDir, "config", "iteration-config", "iteration-config.json"),
        join(runDir, "prep", "iteration-config", "iteration-config.json"),
      ];
      const configPath = configCandidates.find((candidate) => existsSync(candidate));
      if (configPath !== undefined) {
        try {
          const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
          const training = (config["training"] ?? {}) as Record<string, unknown>;
          // D213(e2e 轮实锚,owner 反验收):卡数与卡位入参数表——用户确认训练方案时
          // 必须看到「占多少卡/占哪几张卡」(GPU 占用是启动确认的核心代价面)。
          const cardBinding = (training["card_binding"] ?? {}) as Record<string, unknown>;
          const visibleDevices = [cardBinding["visible_devices"], training["visible_devices"], config["visible_devices"]]
            .find((v) => typeof v === "string" && v !== "");
          const nproc = [cardBinding["nproc_per_node"], training["nproc_per_node"], config["nproc_per_node"]]
            .find((v) => v !== undefined && v !== null);
          const resourceKeys: Array<[string, unknown]> = [
            ["nproc_per_node(卡数)", nproc],
            ["visible_devices(卡位)", visibleDevices],
          ];
          const keys = ["learning_rate", "num_train_epochs", "per_device_train_batch_size",
            "gradient_accumulation_steps", "global_batch_size", "optim", "lora_rank", "lora_alpha",
            "cutoff_len", "warmup_ratio"];
          const rows = [
            ...resourceKeys
              .filter(([, v]) => v !== undefined)
              .map(([label, v]) => `| ${label} | ${String(v)} |`),
            ...keys
              .filter((key) => training[key] !== undefined || config[key] !== undefined)
              .map((key) => `| ${key} | ${String(training[key] ?? config[key] ?? "")} |`),
          ];
          // D260:accum 生效值+派生依据随卡（方案 C 口径——accum 是派生披露面,
          // derived_accum_below_floor 只披露不改写;用户确认训练参数必须含 accum）。
          const accumDerivation = (training["accum_derivation"] ?? {}) as
            { accum?: number; formula?: string; gb_target?: number; source?: string } | undefined;
          if (accumDerivation?.accum !== undefined) {
            rows.push(`| gradient_accumulation_steps(派生) | ${String(accumDerivation.accum)}`
              + `（${String(accumDerivation.formula ?? "")}，目标 global_batch=${String(accumDerivation.gb_target ?? "?")}`
              + `，来源 ${String(accumDerivation.source ?? "?")}） |`);
          }
          if (rows.length > 0) paramTable = "\n### 训练参数\n\n| 参数 | 值 |\n|---|---|\n" + rows.join("\n");
        } catch { /* 配置不可读按缺省呈现 */ }
      }
      // ③ 训练脚本链接（train.sh——vendor 本地文件链接原生可点击）
      const trainSh = join(runDir, "launch", "train.sh");
      if (existsSync(trainSh)) {
        scriptLink = `\n\n[查看训练脚本 train.sh](${trainSh})`;
        const prelaunch = join(runDir, "launch", "prelaunch-report.md");
        if (existsSync(prelaunch)) {
          scriptLink += ` ｜ [完整启动前报告](${prelaunch})`;
        }
      }
    }
  }
  try {
    const answers = await svc.ask({
      questions: [{
        id: `launch-confirm-${runId}`,
        question: `训练启动确认 — ${runId}`,
        header: "训练启动",
        detail: [lines.join("\n"), paramTable,
          "\n\n确认后将写入放行记录并启动训练；暂停则不启动，可先改参数。",
          scriptLink].filter((part) => part !== "").join(""),
        options: [
          { label: "确认启动", description: "已查看上述实验准备与参数，写入放行记录并启动" },
          { label: "暂停，我要改参数", description: "不启动；告诉我你想改什么，改完再确认" },
        ],
        multiSelect: false,
      }],
      agent: exec.agent,
      signal: exec.signal,
    });
    const first = answers.answers[0];
    const picked = [...(first?.selected ?? [])].join("") || (first?.custom ?? "");
    const confirmed = picked.includes("确认启动");
    return { ok: confirmed, note: confirmed ? "用户已确认启动（确认卡留痕）" : "用户暂停启动（可在对话里说想改什么参数）" };
  } catch {
    return { ok: true, note: "确认卡通道异常——按既有审批轨处理" };
  }
};

          // 确认卡前置（ADR-0022 后：requiresUserConfirmationOf 语义为唯一判定源——
          // 原档位审批轴退役；chain_advance 直通留痕写账，stderr 通报保留可审计）。
          const approvalContext = {
            tier: permissionTierOf(ctx as never, exec as never),
          };
          if (
            !requiresUserConfirmationOf(definition, args)
            && APPROVAL_SEMANTICS_BY_TOOL[definition.name] === "chain_advance"
          ) {
            // 直通留痕(ADR-0022:chain_advance 写账+stderr 通报,非隔离执行事实可审计)
            await appendExemptionRecord(definition.name, "chain");
            console.warn(`[approval] ${definition.name} 链内推进直通放行(chain 留痕,ADR-0022,写 run 域内可逆)`);
          }
          if (requiresUserConfirmationOf(definition, args)) {
            // D186(owner 2026-11-04 裁定):完全权限档下训练启动不弹审批卡——改停等
            // 「训练启动确认卡」(完整实验准备+参数报告+脚本链接),确认即用户决定
            // (审计=卡面回执+放行账本);暂停不启动。guarded 档审批卡照旧。
            // D192:裁决决定(user_decision 类)任何档位都先过用户确认卡——逐项呈现
            // decisions(item/两值/agent 建议),确认才执行;暂停不执行。修复
            // chain_advance 误分类导致的完全权限免审代裁(1104-5 实锤)。
            if (APPROVAL_SEMANTICS_BY_TOOL[definition.name] === "user_decision") {
              // D244 fail-fast:resolve 缺 run_id/workspace_path 时拒绝执行(不弹卡不静默)
              // ——弹卡后确认但无法写凭据=用户白点确认+agent 无限重试(真机 7 次卡循环实锚)
              if (definition.name === "atf_label_qc_resolve") {
                const _runId = typeof args["run_id"] === "string" ? args["run_id"] : "";
                const _wsPath = typeof args["workspace_path"] === "string" ? args["workspace_path"] : "";
                if (_runId === "" || _wsPath === "") {
                  return asToolValue({
                    error: "label_qc_resolve_params_missing",
                    tool: definition.name,
                    missing: [
                      ...(_runId === "" ? ["run_id"] : []),
                      ...(_wsPath === "" ? ["workspace_path"] : []),
                    ],
                    how_to_fix: "atf_label_qc_resolve 必须带 run_id 和 workspace_path 两个参数(用户确认后 harness 需要它们定位 run 目录写凭据);缺参调用被拒绝,不会弹确认卡。重调时补全参数。",
                  });
                }
              }
              // D184 重做:decisions 与用户卡面凭据账本(label-qc-decisions.json,harness
              // 写、agent 不可伪造)逐项一致→直通(卡上逐项选择即用户决定,不再批量确认卡
              // 重复打扰);不一致(agent 自拟/改动)→批量确认卡拦。
              if (definition.name === "atf_label_qc_resolve" && await matchesLabelQcUserDecisions(args)) {
                console.warn("[approval] atf_label_qc_resolve decisions 与用户卡面凭据一致,直通(不再批量确认)");
              } else {
                const confirm = await userDecisionConfirmCardOf(ctx, exec, definition.name, args);
                if (!confirm.ok) {
                  return asToolValue({ error: "user_decision_paused", tool: definition.name, note: confirm.note });
                }
                // 轮三凭据闭环:用户在确认卡上做出决定→写凭据账本(harness 写、
                // agent 不可伪造),内核重跑 label_qc 据此放行(user_card 凭据)。
                // 账本写法与退役前的 D184 链同形态(LabelQcUserDecisions/v1)。
                if (definition.name === "atf_label_qc_resolve") {
                  try {
                    const runId = typeof args["run_id"] === "string" ? args["run_id"] : "";
                    const wsPath = typeof args["workspace_path"] === "string" ? args["workspace_path"] : "";
                    if (runId !== "" && wsPath !== "") {
                      const resolvedRun = resolvePipelineRunDir(wsPath, runId);
                      if (!("error" in resolvedRun)) {
                        const decisionsDir = join(resolvedRun.runDir, "runtime", "webui");
                        mkdirSync(decisionsDir, { recursive: true });
                        // D319 覆写挤掉修复（M6 保护下修 1118）：账本按 item_id 合并累积
                        // （多类 run 的 BL/CI 各批凭据并存——覆写曾挤掉先批条目）；
                        // 附绑定 report_digest（D319 重映射反查源）。
                        const ledgerPath = join(decisionsDir, "label-qc-decisions.json");
                        const existingLedger = existsSync(ledgerPath)
                          ? (JSON.parse(readFileSync(ledgerPath, "utf8")) as { decisions?: Array<Record<string, unknown>> })
                          : { decisions: [] as Array<Record<string, unknown>> };
                        const merged = new Map((existingLedger.decisions ?? []).map((d) => [String(d["item_id"]), d]));
                        for (const d of (Array.isArray(args["decisions"]) ? args["decisions"] : [])) {
                          // 条目级 dataset_id+report_digest：多类 run 各批绑定不同代际报告——
                          // 内核重映射按条目分组反查（单顶层 digest 跨批必错配，1118 预演实锚）。
                          merged.set(String((d as Record<string, unknown>)["item_id"]), {
                            ...(d as Record<string, unknown>),
                            dataset_id: String(args["dataset_id"] ?? ""),
                            report_digest: String(args["report_digest"] ?? ""),
                          });
                        }
                        writeFileSync(ledgerPath,
                          `${JSON.stringify({
                            schema_version: "LabelQcUserDecisions/v1", decided_by: "user_confirmed",
                            decided_at: new Date().toISOString(),
                            // M6 预演实锚（1118）：剥离式写账丢 disposition 必填附加字段
                            // （keep_both 缺 reason_text）→ 内核重跑校验必拒。凭据账本=
                            // 用户卡确认的完整决策（含 reason_text/modified_value 等），
                            // 原样保全（agent 不可伪造语义不变——账本仍由 harness 写）。
                            report_digest: String(args["report_digest"] ?? ""),
                            decisions: [...merged.values()],
                          }, null, 1)}\n`, "utf8");
                      }
                    }
                  } catch { /* 账本写失败→内核按凭据缺席拦截重跑,如实暴露 */ }
                }
              }
            }
            if (APPROVAL_SEMANTICS_BY_TOOL[definition.name] === "user_decision") {
              // D318（1117-2 真机实锚「老问题又弹审批卡」）：user_decision 的卡面
              // 终点=上方逐项业务确认卡（决策内容形态）——不再落宿主泛化审批卡
              // （「执行训练流程操作」零决策内容文案与逐项确认卡重复，双卡冗余；
              // 拒绝动作由确认卡拒绝承载，决定能力不损失）。governance（launch）
              // 宿主面板照旧——治理点双保险不动。
            } else if (definition.name === "atf_launch_execute") {
              const launchConfirm = await launchConfirmCardOf(ctx, exec, args);
              if (!launchConfirm.ok) {
                return asToolValue({ error: "launch_paused_by_user", tool: definition.name, note: launchConfirm.note });
              }
            }
            // D318：泛化审批卡调用点删除（ADR-0022「禁止留半截调用链」）——
            // requiresUserConfirmationOf=true 仅 governance（launch 专属确认卡）与
            // user_decision（逐项确认卡）两类，各有 B 层卡面终点，泛化 fallback
            // （「执行训练流程操作」+空 target）不可达且属 A 层审批拦截残留形态。
          }
          // 执行径分派（复用面与手搓一致）：工作区治理面（scratch_exec/skill_read）走
          // WORKSPACE_TOOL_HANDLERS 本地执行；桥接契约面走 runKernelViaMcp（G5 MCP 径）。
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
          // 治理面按会话工作区分连接（ci-bl-1103）：exec cwd 在注册工作区根内 →
          //  该工作区的 scoped serve（首连 bind_workspace）；无 cwd/不在注册表
          //  （CLI 单会话/测试）→ default 连接现状零变更。
          // G5 阶段 2：执行径换 MCP（toAtfAgentTool 语义逐字对齐——checkSchema/
          //  rejected 回填/canonical 校验在 runKernelViaMcp；治理链零变化）。
          const sessionWorkspace = workspacePathOfExec(exec);
          const bridge = sessionWorkspace !== null
            ? await manager.transportForWorkspace(sessionWorkspace)
            : await manager.transport();
          const outcome = await runKernelViaMcp(definition, bridge, args);
          const result: { details: Record<string, unknown> } = { details: outcome.details };
          // 选项类待确认统一走原生提问卡（#13 owner 裁定：提问卡=产品统一问询通道，
          // 聊天框不承载选项问询——此前 agent 拿到 pending_confirmations 后聊天转述，
          // 两套交互并存）。仅 options 在场的选项类出卡；无 options 的纯信息披露不动；
          // 卡通道缺席/无人值守档=现状零变更（返回体原样，聊天转述兜底）。答案结构化
          // 回传 pending_answers，agent 按答案组装重跑参数（参数自动回填归段语义级
          // 改造，不在此越界）。
          const pendingAsk = detailsOf(result)?.["pending_confirmations"];
          if (
            Array.isArray(pendingAsk) && pendingAsk.length > 0
            && approvalContext.tier !== "unattended"
          ) {
            const { questions: choiceQuestions, meta: pendingMeta } =
              pendingChoiceQuestionsOf(pendingAsk);
            const askSvc = ctx.get("userQuestions") as
              | { ask(req: { questions: ChoiceAskQuestion[]; agent?: unknown; signal?: unknown }):
                  Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> }
              | undefined;
            if (choiceQuestions.length > 0 && askSvc !== undefined && typeof askSvc.ask === "function") {
              try {
                const answered = await askSvc.ask({ questions: choiceQuestions, agent: exec.agent, signal: exec.signal });
                const pendingAnswers = pendingAnswersOf(pendingMeta, answered.answers);
                const detailBody = detailsOf(result);
                if (detailBody !== undefined) {
                  detailBody["pending_answers"] = pendingAnswers;
                  detailBody["pending_answers_note"] = "用户已在提问卡上作答（pending_answers）——按所选答案组装参数重跑对应段；不要在聊天里重复提问。";
                }
              } catch (cause) {
                const detailBody = detailsOf(result);
                if (detailBody !== undefined) {
                  detailBody["pending_answers_note"] = `提问卡应答失败（${String(cause).slice(0, 120)}）——待确认项仍在 pending_confirmations，改在聊天中向用户转述选项。`;
                }
              }
            }
          }
          // 批㊶-M M-3 段事实轨：桥接面工具成功即登记（register/label_qc——run 归属取参数）
          const details = result.details as Record<string, unknown> | undefined;
          // D81-B（指令 §二.4）：状态面附加当前会话归属工作区身份（atf_workspace_status 显示
          // 当前 workspace_id）。附加在内核返回体之上（canonical root strict:false 放行附加
          // 字段——bridge.contract.yaml 零 diff）；归属缺失如实给指引 note，状态面核心事实
          // （run_id/admitted_count/scope_ref）不被遮蔽。
          if (definition.name === "atf_workspace_status" && details !== undefined && details !== null && !("error" in details)) {
            const sessionScope = resolveSessionWorkspace(sessionCwdOfExec(exec));
            if (sessionScope !== null) {
              details["workspace_id"] = sessionScope.workspaceId;
              details["workspace_path"] = sessionScope.root;
            } else {
              details["workspace_scope_note"] = SCOPE_UNRESOLVED_NOTE;
            }
          }
          // D318 挂卡（1117-2 死锁实锚）：inspect 回执 pending>0 时把待裁决项直接以
          // 确认卡呈现（用户逐项点选→写 dataset_dir 侧凭据账本→同 run 重跑 label_qc
          // 段放行）——确认卡与 resolve 调用解耦（此前卡只在 resolve 调用时弹出：模型
          // 调用生成塌缩=卡不存在=用户无处确认=死锁；内核凭据读取的 dataset_dir 侧
          // fallback 与本写入配对）。幂等：已确认项不重复问。
          if (definition.name === "atf_label_qc_inspect" && details !== undefined && details !== null && typeof details === "object" && !("error" in details)) {
            try {
              const countsObj = details["counts"] as { pending?: number } | undefined;
              const pendingCount = Number(countsObj?.pending ?? 0);
              const scopeForCard = resolveSessionWorkspace(sessionCwdOfExec(exec));
              const reportRef = String(details["report_ref"] ?? "");
              if (pendingCount > 0 && scopeForCard !== null && reportRef !== "") {
                const reportPath = join(scopeForCard.root, reportRef);
                const report = JSON.parse(readFileSync(reportPath, "utf-8")) as { items?: Array<Record<string, unknown>> };
                const pendingItems = (report["items"] ?? []).filter((i) => String(i["status"] ?? "") === "pending");
                if (pendingItems.length > 0) {
                  const datasetDirRel = reportRef.split("/").slice(0, 2).join("/");
                  const credDir = join(scopeForCard.root, datasetDirRel, "runtime", "webui");
                  const credPath = join(credDir, "label-qc-decisions.json");
                  let confirmedIds = new Set<string>();
                  try {
                    const existing = JSON.parse(readFileSync(credPath, "utf-8")) as { decisions?: Array<{ item_id?: string }> };
                    for (const d of existing.decisions ?? []) confirmedIds.add(String(d.item_id ?? ""));
                  } catch { /* 账本缺席=全 pending 待问 */ }
                  const open = pendingItems.filter((i) => !confirmedIds.has(String(i["item_id"] ?? "")));
                  if (open.length > 0) {
                    const svcCard = ctx.get("userQuestions") as { ask?: (payload: unknown) => Promise<{ answers: Array<{ selected?: string[]; custom?: string }> }> } | undefined;
                    if (svcCard !== undefined && typeof svcCard.ask === "function") {
                      const zhOf = (i: Record<string, unknown>): string => {
                        const sa = (i["suggested_action"] ?? {}) as Record<string, unknown>;
                        return String(sa["review_hint"] ?? "") !== "" ? String(sa["review_hint"])
                          : String(i["value_summary"] ?? "") !== "" ? `现值「${String(i["value_summary"])}」` : String(i["human_label"] ?? i["check_class"] ?? i["item_id"]);
                      };
                      const rows = open.map((i, idx) => {
                        const itemCell = `${String(i["item_id"] ?? "?")}——${String(i["human_label"] ?? i["check_class"] ?? "")}`;
                        return `| ${idx + 1} | ${itemCell} | ${zhOf(i)} |`;
                      }).join("\n");
                      const answers = await svcCard.ask({
                        questions: [{
                          id: `label-qc-pending-card-${String(Date.now())}`,
                          question: `标注体检待确认（共 ${open.length} 项）——确认后落账并放行重跑`,
                          header: "标注体检裁决确认",
                          detail: [
                            `| # | 待裁决项 | agent 看图结论/建议 |`,
                            `|---|---|---|`,
                            rows,
                            "",
                            "确认=逐项按上表建议处置提交并留账（decided_by=user_confirmed）；暂停则在对话里说明想怎么改。",
                          ].join("\n"),
                          options: [
                            { label: "确认按建议处置", description: `逐项按上表 agent 建议提交并留账（${open.length} 项）` },
                            { label: "暂停，我要调整", description: "不提交；在对话里说明调整意见" },
                          ],
                          multiSelect: false,
                        }],
                      });
                      const picked = answers.answers[0]?.selected?.[0] ?? "";
                      if (picked.startsWith("确认")) {
                        const confirmed = open.map((i) => {
                          const sa = (i["suggested_action"] ?? {}) as Record<string, unknown>;
                          const entry: Record<string, unknown> = {
                            item_id: String(i["item_id"] ?? ""),
                            action: "modify",
                            disposition: String(sa["disposition_hint"] ?? "no_action"),
                            reason_text: `用户卡上确认：${String(sa["review_hint"] ?? "按建议处置")}`,
                          };
                          if (typeof sa["visual_fix"] === "object" && sa["visual_fix"] !== null) {
                            const fix = sa["visual_fix"] as Record<string, unknown>;
                            if (fix["new_value"] !== undefined && fix["new_value"] !== null) entry["modified_value"] = fix["new_value"];
                          }
                          return entry;
                        });
                        mkdirSync(credDir, { recursive: true });
                        let merged: Array<Record<string, unknown>> = confirmed;
                        try {
                          const existing = JSON.parse(readFileSync(credPath, "utf-8")) as { decisions?: Array<Record<string, unknown>> };
                          merged = [...(existing.decisions ?? []), ...confirmed];
                        } catch { /* 首写 */ }
                        writeFileSync(credPath, `${JSON.stringify({
                          schema_version: "LabelQcUserDecisions/v1", decided_by: "user_confirmed",
                          decided_at: new Date().toISOString(), decisions: merged,
                        }, null, 1)}\n`, "utf8");
                        details["pending_card_note"] = `卡面已确认 ${confirmed.length} 项并落账（${datasetDirRel}/runtime/webui/label-qc-decisions.json，decided_by=user_confirmed）——同 run 重跑 label_qc 段即放行（有看图核查时重跑带 --visual-check）`;
                      } else {
                        details["pending_card_note"] = "卡面选择暂停——pending 维持；调整意见确认后可重跑本工具重新出卡";
                      }
                    }
                  }
                }
              }
            } catch (cause) {
              // 挂卡失败不阻断 inspect 回执（回执与 resolve 指路完整在——agent 可走 resolve 通路或重试出卡）
              if (details !== undefined && details !== null && typeof details === "object") {
                details["pending_card_note"] = `挂卡未完成（${String(cause).slice(0, 120)}）——待裁决项仍在，可重跑本工具重新出卡或走 atf_label_qc_resolve 通路`;
              }
            }
          }
          if (details !== undefined && details !== null && typeof details === "object" && !("error" in details)) {
            const segmentByTool: Record<string, string> = { atf_admit_data: "register", atf_label_qc_inspect: "label_qc" };
            const segment = segmentByTool[definition.name];
            const runIdForFact = typeof args["run_id"] === "string" && args["run_id"] !== "" ? args["run_id"] : "default";
            if (segment !== undefined && localRoots !== undefined) {
              // 段事实/绑定落实际 run 目录（多形态解析单源——dir 已由 scratch 建立或存量平铺；
              // canonical 档带注册工作区根，否则 v3 实验树内的 run 会落到 legacy 同名目录）
              const factRunDir = resolveRunDir(localRoots.runsRoot, runIdForFact, {
                workspace: sessionWorkspaceSlug(exec),
                canonicalRoots: registeredWorkspaceRoots(),
              });
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
      }) as unknown as Record<string, unknown>;
    if (MCP_FACTORY_NAMES.has(definition.name)) {
      // —— G5 MCP 工厂装配面（vendor createMcpToolDefinition：name=模型可见名〔D6〕，
      //    rawName=内核方法名）：description/parameters 覆写为 tools/list 动态拉取
      //    （schema 零复制——内核 mcp/tools.py 唯一源），output/execute 保持治理面
      //    （错误回填/回执形态与切换前逐字一致）。工厂 call 不经此径（治理 execute
      //    直连 runKernelViaMcp），仅满足工厂接口形态。
      const rawName = rpcMethodFor(definition.name);
      const descriptor = descriptorByRawName.get(rawName);
      if (descriptor === undefined) {
        throw new Error(`MCP tools/list 未含内核方法 ${rawName}（fail-closed 拒装配）`);
      }
      const factoryDef = createMcpToolDefinition(ctx as never, {
        name: definition.name,
        rawName,
        description: descriptor.description ?? definition.description,
        inputSchema: descriptor.inputSchema ?? { type: "object", properties: {}, additionalProperties: true },
        outputSchema: descriptor.outputSchema,
        call: async () => {
          throw new Error(`工厂 call 不经此径（治理 execute 直连 runKernelViaMcp）: ${rawName}`);
        },
      }) as unknown as Record<string, unknown>;
      governedTool["description"] = factoryDef["description"];
      governedTool["parameters"] = factoryDef["parameters"];
    }
    tools.push(governedTool);
  }
  return tools;
};
