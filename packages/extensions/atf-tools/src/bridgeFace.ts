/**
 * 桥接工具面（6 个契约工具：workspace_status / admit_data / label_qc_inspect /
 * scratch_exec / skill_read / gate）——逻辑零重写：直接复用手搓执行径
 * toAtfAgentTool（src/agent/atfAgentTools.ts：参数校验 → 桥接 request → canonical
 * 校验 → 结构化 rejected 回填），本层只做 DSH defineTool 包装＋DSH 审批 seam 前置。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { registeredWorkspaceRoots, resolveDshHome } from "../../../../src/core/workspace/workspaceRegistry.js";
import { awaitGpuWindow, formatCardTable, gpuQueuePollMsFromEnv } from "./gpuQueueFace.js";
import { toAtfAgentTool } from "../../../../src/agent/atfAgentTools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { translateParameters, looseObjectOutput, renderAsJsonText, asToolValue } from "./schemaTranslate.js";
import { approvalDeniedResult, buildApprovalReason, requestApproval } from "./approvalFace.js";
import type { ChoiceAskQuestion } from "./confirmFace.js";
import { APPROVAL_SEMANTICS_BY_TOOL } from "../../../../src/core/tools/toolDefinition.js";
import { permissionTierOf } from "./permissionTier.js";
import { isTrainingAutopilot } from "./trainingPreset.js";
import { appendSegmentFact } from "../../../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../../../src/core/workspace/runFacts.js";
import { resolveRunDir, sessionWorkspaceSlug } from "../../../../src/core/workspace/runLayout.js";
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
  // run-awb-01/03/04）。内核 `atf_label_qc.resolve` 早已就绪（tools.py:
  // registry.register("atf_label_qc.resolve", …)），harness 定义与审批文案也在
  // （toolDefinition.ts:394、approvalCopy.ts:93），缺的只是这张名单。
  "atf_label_qc_resolve",
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
  private connection: AtfBridgeConnection | null = null;
  private connecting: Promise<AtfBridgeConnection> | null = null;
  /** 工作区分连接池（ci-bl-1103 治理面）：key=工作区绝对路径。 */
  private readonly scopedConnections = new Map<string, Promise<AtfBridgeConnection>>();

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
  async transportForWorkspace(workspacePath: string): Promise<AtfBridgeConnection> {
    const existing = this.scopedConnections.get(workspacePath);
    if (existing !== undefined) return existing;
    const pending = AtfBridgeConnection.spawn({
      command: this.command,
      cwd: this.cwd,
      ...(this.childEnv !== undefined ? { env: this.childEnv } : {}),
    }).then(async (spawned) => {
      if (!spawned.ok) {
        throw new Error(`atf 治理面桥 spawn 失败（${spawned.error.code}）: ${spawned.error.message}`);
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
        // 参数面单一真相源＝定义处（workspaceTools 的 LAUNCH_EXECUTE_PARAMS 已含
        // run_id／workspace_path／launch_sh 三形态／config 自动探测）——此处只做投影，
        // 不得二次增删参数：投影层加的参数 handler 不读，是假参数（真机踩过，
        // 模型照 schema 传了却被 handler 判缺参）。
        parameters: translateParameters(definition.parameters),
        output: {
          schema: looseObjectOutput,
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
  exec: { agent?: unknown; signal?: unknown },
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; note: string }> => {
  const svc = ctx.get("userQuestions") as { ask?: (payload: unknown) => Promise<{ answers: Array<{ selected?: string[]; custom?: string }> }> } | undefined;
  if (svc === undefined || typeof svc.ask !== "function") {
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
    const answers = await svc.ask({
      questions: [{
        id: `user-decision-${toolName}-${String(Date.now())}`,
        question: `${title}${groupNote !== "" ? "" : `——以下 ${String(decisions.length)} 项处置请确认`}`,
        header: title,
        detail: [
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
    });
    const first = answers.answers[0];
    const picked = [...(first?.selected ?? [])].join("") || (first?.custom ?? "");
    const confirmed = picked.includes("确认按建议提交") || (picked.trim() !== "" && !picked.includes("暂停"));
    return { ok: confirmed, note: confirmed ? "用户已在卡上确认(留痕)" : "用户暂停——未提交,等调整意见" };
  } catch {
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

          // 审批前置（指令要求 2）：requiresApprovalFor 语义为唯一判定源；E8b·H3 D152——
          // 卡面三行模板＋业务动作名（零内部工具名：工具名经 requestApproval 的 toolName
          // 进审批服务记录＝日志审计面，卡面 reason 不出现）。
          // 语义分类表判定(D170v2 §4.1):链内推进在训练预设+完全权限档免审
          // (免审放行 stderr 留痕可审计,对齐 approvalExempt 的可见性纪律)。
          const approvalContext = {
            tier: permissionTierOf(ctx as never, exec as never),
            trainingAutopilot: isTrainingAutopilot(ctx as never, exec as never),
          };
          if (
            !requiresApprovalFor(definition, args, approvalContext)
            && APPROVAL_SEMANTICS_BY_TOOL[definition.name] === "chain_advance"
          ) {
            // 免审放行留痕(§4.2 auto-allowed 可审计:stderr 告警保留,非隔离执行事实)
            console.warn(`[approval] ${definition.name} 链内推进免审放行(训练预设+完全权限档,写 run 域内可逆)`);
          }
          if (requiresApprovalFor(definition, args, approvalContext)) {
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
                        writeFileSync(join(decisionsDir, "label-qc-decisions.json"),
                          `${JSON.stringify({
                            schema_version: "LabelQcUserDecisions/v1", decided_by: "user_confirmed",
                            decided_at: new Date().toISOString(),
                            decisions: (Array.isArray(args["decisions"]) ? args["decisions"] : []).map((d) => {
                              const entry = d as Record<string, unknown>;
                              return { item_id: entry["item_id"], action: entry["action"], disposition: entry["disposition"] };
                            }),
                          }, null, 1)}\n`, "utf8");
                      }
                    }
                  } catch { /* 账本写失败→内核按凭据缺席拦截重跑,如实暴露 */ }
                }
              }
            }
            if (definition.name === "atf_launch_execute" && approvalContext.tier === "full-access") {
              const launchConfirm = await launchConfirmCardOf(ctx, exec, args);
              if (!launchConfirm.ok) {
                return asToolValue({ error: "launch_paused_by_user", tool: definition.name, note: launchConfirm.note });
              }
            } else {
            const verdict = await requestApproval(ctx, exec, definition.name,
              buildApprovalReason({
                action: BRIDGE_ACTION_LABELS[definition.name] ?? "执行训练流程操作",
                target: "",
                effect: "按该操作的业务语义执行（写面以实际参数为准）",
                reversible: "按操作语义（写盘产物可人工清理）",
              }));
            if (!verdict.ok) return approvalDeniedResult(definition.name, verdict.outcome);
            }
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
          // 治理面按会话工作区分连接（ci-bl-1103）：exec cwd 在注册工作区根内 →
          //  该工作区的 scoped serve（首连 bind_workspace）；无 cwd/不在注册表
          //  （CLI 单会话/测试）→ default 连接现状零变更。
          const sessionWorkspace = workspacePathOfExec(exec);
          const bridge = sessionWorkspace !== null
            ? await manager.transportForWorkspace(sessionWorkspace)
            : await manager.transport();
          const agentTool = toAtfAgentTool(definition, { bridge, scopeRefBox: { current: undefined } });
          const result = await agentTool.execute(`dsh-${exec.callId ?? "call"}`, args);
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
      }),
    );
  }
  return tools;
};
