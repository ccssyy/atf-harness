/**
 * 工作区工具面（批 3「创作执行面」§一/§二/§三，DDL 关键路径）——
 * 把既有工作区能力（T0 写 / 受控执行 / skills 读 / G5 后受控启动）包成模型面工具。
 *
 * 边界纪律（设计要点《ATF-Harness_批3创作执行面_设计要点_DDL合并门_20260922.md》）：
 * - INV-D：模型发 tool_call（LlmDecision 闭集零改动），工作区动作在 harness 侧本地 handler
 *   执行——脚本指令类型不进模型面；脚本专用步骤轨（scenario.ts）零改动，两轨并存；
 * - 审批策略：atf_scratch_write 免审批（T0 自由区＋路径/体量守卫兜底）；atf_scratch_exec /
 *   atf_launch_execute 需审批（执行类默认审批；账本轨 CAS 一次性消费 / 问答轨弹窗，不变）；
 *   atf_skill_read 免审批（纯读）；
 * - 产物只经既有晋升闸 A 进 artifacts（本批无模型面 promote，登记 backlog）；
 * - 注册隔离：本文件工具**不进** TOOL_DEFINITIONS（bridge 方法面零 diff）——经
 *   ToolRegistry.createWithWorkspaceTools() 只在 TUI/resume 装配；MCP/ACP 仍 7 工具（零风险）。
 * - 本地 handler 终态只产出 executed / rejected：基础设施故障折算 rejected（结构化回填，
 *   模型可如实转述——failed 会终局 run，不用于可转述的环境缺口）。
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildScratchExecEnv,
  ensureExecDirs,
  findBash,
  findPython3,
  guardScratchArgv,
  guardedScratchWrite,
  LAUNCH_WAIT_MS_DEFAULT,
  readLaunchState,
  runLaunchScript,
  runScratchCommand,
  scanLaunchReady,
  scanRunTreeLaunchReady,
  SCRATCH_EXEC_STDOUT_CAP_BYTES,
  SCRATCH_EXEC_TIMEOUT_MS_DEFAULT,
  SCRATCH_WRITE_MAX_BYTES,
  type LaunchReady,
} from "../workspace/scratchExec.js";
import { startLossIngest } from "../workspace/lossIngest.js";
import { recordFirstLaunchAt } from "../workspace/trainingPreflight.js";
import {
  listSkills,
  readSkillBody,
  readSkillFile,
  skillsSuffixText,
  SKILL_FILE_MAX_BYTES,
  type SkillSummary,
} from "../workspace/skillCatalog.js";
import { safeScratchPath } from "../workspace/runWorkspace.js";
import {
  KERNEL_ERROR_FACE_CODES,
  kernelErrorEnvelopeCode,
  replaceKernelErrorFace,
} from "../workspace/kernelErrorFace.js";
import {
  createExperimentInWorkspace,
  rebindWorkspaceToPath,
  resolveDshHome,
  type CreateExperimentOutcome,
  type RebindOutcome,
} from "../workspace/workspaceRegistry.js";
import { candidateDigestFromText, collectConfirmReport, unproducedFieldsFromCandidateText, type ConfirmRequestBody } from "../confirmRequest.js";
import { type SchemaNode } from "./canonical.js";
import { type ToolDefinition } from "./toolDefinition.js";

const HEX64 = "^[0-9a-f]{64}$";

/** 编排主路径 GPU 排队面（批㊶-S4b T1——结构契约归 core，实现由装配方注入）。
 *  排队语义单源在扩展层 gpuQueueFace 既有面（core 直引不可达：dist 构建图 rootDir=src
 *  不含 packages/）——本契约只约定返回闭集：轮询旋钮（ATF_GPU_POLL_MS 同源 0＝直启旁路）、
 *  整组空闲判定、gpu_queue 通报、命中琥珀卡全在适配实现内（gpuQueueFace 同型挂法）。
 *  装配缺席（host.gpuQueueFace === undefined）＝不排队直启——编排语义回退现状。 */
export interface LaunchGpuQueueFace {
  gateLaunch(input: {
    /** 启动所需卡数；null＝launch.sh/launch_manifest 均未声明 nproc（卡数不可判——
     *  fail-closed 不排队但发通报，不阻塞主线：owner 裁定固化）。 */
    requiredCards: number | null;
    /** run 目录（通报落点——alerts/notifications 既有 gpu_queue 通知面）。 */
    runDir: string;
    /** launch.sh 相对路径（通报与琥珀卡文案承载）。 */
    launchShRel: string;
  }): Promise<
    | { verdict: "proceed"; queued: boolean; waited_text?: string; amber?: "approved"; queue_note?: string }
    | { verdict: "aborted" }
    | { verdict: "denied"; outcome: string }
  >;
}

/** 本地工具宿主（TUI/resume 装配；测试注入临时目录）。 */
export interface LocalToolHost {
  /** 当前 run 的 scratch 绝对路径（T0 区；一切写与执行的落点） */
  scratchDir: string;
  /** D115：当前 run 目录绝对路径（run 树启动件解析与就绪检测的根；缺席＝仅 scratch 形态
   *  （TUI/resume 既有装配），run 树形态入口如实拒绝并指路） */
  runDir?: string;
  /** pin 内核 checkout 根（PYTHONPATH=<kernelDir>/src；skills 白名单根） */
  kernelDir: string;
  /** 执行 env HOME（对端隔离 home 同源——内核配置根/放行账本落点） */
  home: string;
  /** 对端同源基础 env（ATF_WORKSPACE_ROOT / ATF_SKILLS_AUTO_INSTALL 等） */
  baseEnv: Record<string, string>;
  /** python3 解释器覆盖（测试；缺省自动探测） */
  pythonPath?: string;
  /** launch.sh 执行等待上限覆盖（测试；缺省 120s，未退出不杀） */
  launchWaitMs?: number;
  /** 编排主路径 GPU 排队面（批㊶-S4b T1；web 桥装配注入——TUI/resume 缺席＝直启回退） */
  gpuQueueFace?: LaunchGpuQueueFace;
  /** DSH 家（目录结构 v1 工具链：注册表/会话桶定位根）。web 桥装配注入（DSH_HOME env
   *  同源）；缺席时 handler 回退 env→~/.dsh 解析链（与 vendor home-paths 缺省一致）。 */
  dshHome?: string;
}

/** 本地 handler 终态（无 failed——环境缺口一律结构化 rejected，模型可转述；见文件头）。 */
export type LocalToolResult =
  | { kind: "executed"; result: unknown }
  | { kind: "rejected"; reason: string; detail?: unknown };

export type LocalToolHandler = (params: unknown, host: LocalToolHost) => Promise<LocalToolResult>;

const rejected = (reason: string, detail?: unknown): LocalToolResult => ({ kind: "rejected", reason, detail });

/** 批㊶-S4b T1：编排启动所需卡数派生（对照 trainingFace 派生逻辑——launch.sh
 *  NPROC_PER_NODE ＞ launch_manifest nproc_per_node/nproc ＞ null＝卡数不可判）。 */
export const parseLaunchRequiredCards = (launchShText: string, manifest: Record<string, unknown> | undefined): number | null => {
  const shMatch = /^NPROC_PER_NODE=['"]?([0-9]+)['"]?\s*$/m.exec(launchShText);
  if (shMatch !== null) {
    const parsed = Number.parseInt(shMatch[1] ?? "0", 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  const raw = manifest?.["nproc_per_node"] ?? manifest?.["nproc"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------- 工具定义

/** atf_scratch_write 参数（模型可见白名单）。 */
const SCRATCH_WRITE_PARAMS: SchemaNode = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: {
      type: "string",
      description: "目标文件路径：scratch 工作区内的相对路径（如 prep/iteration-config.json）；不接受绝对路径、不允许 .. 越界",
    },
    content: {
      type: "string",
      description: `文件全文（UTF-8 文本；上限 ${String(Math.floor(SCRATCH_WRITE_MAX_BYTES / 1024))} KiB）`,
    },
  },
};

const SCRATCH_WRITE_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "path", "bytes", "sha256"],
  properties: {
    ok: { const: true },
    path: { type: "string" },
    bytes: { type: "integer" },
    sha256: { type: "string", pattern: HEX64 },
  },
};

/** atf_scratch_exec 参数。 */
const SCRATCH_EXEC_PARAMS: SchemaNode = {
  type: "object",
  required: ["argv"],
  properties: {
    argv: {
      type: "array",
      items: { type: "string" },
      description:
        "命令 argv（1..32 个非空字符串元素）。argv[0] 只允许 python3 或 .py 脚本（pin 内 skills scripts 的绝对/相对路径，或 scratch 内脚本路径）；不接受 shell。示例：[\"python3\", \"/abs/pin/skills/atf-prepare-training/scripts/generate_train_launch.py\", \"--config\", \"prep/iteration-config.json\", \"--out\", \"launch\"]。产物（--out）一律指向 scratch 内相对路径，工作目录即 scratch。",
    },
    timeout_seconds: {
      type: "integer",
      optional: true,
      description: `超时秒数（1..3600，缺省 ${String(Math.floor(SCRATCH_EXEC_TIMEOUT_MS_DEFAULT / 1000))}）；超时进程被终止并如实标注 timed_out`,
    },
  },
};

const SCRATCH_EXEC_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "timed_out", "stdout", "stdout_truncated", "stderr_tail", "duration_ms"],
  properties: {
    ok: { const: true },
    exit_code: { type: "integer", optional: true },
    timed_out: { type: "boolean" },
    stdout: { type: "string" },
    stdout_truncated: { type: "boolean" },
    stderr_tail: { type: "string" },
    duration_ms: { type: "integer" },
    launch_ready: { type: "object", optional: true, strict: false },
    note: { type: "string", optional: true, description: "D71：命中码的人话文案（含业务描述与下一步；散文零内部码）。D77：完整码不再进返回体——对账面＝scratch 观测账（known_code 行），不是模型可见返回体" },
  },
};

/** atf_skill_read 参数。 */
const SKILL_READ_PARAMS: SchemaNode = {
  type: "object",
  required: [],
  properties: {
    skill: {
      type: "string",
      optional: true,
      description: "技能名（清单内的 name，如 atf-run-training）；缺省＝返回技能清单",
    },
    file: {
      type: "string",
      optional: true,
      description: "技能内附属文件（references/assets/scripts 内相对路径，随全文返回的 references 清单取值）；缺省＝只读 SKILL.md 全文",
    },
  },
};

const SKILL_READ_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { const: true },
    skills: {
      type: "array",
      optional: true,
      items: {
        type: "object",
        required: ["name", "description"],
        properties: { name: { type: "string" }, description: { type: "string" } },
      },
    },
    skill: { type: "string", optional: true },
    body: { type: "string", optional: true },
    references: { type: "array", optional: true, items: { type: "string" } },
    file: { type: "string", optional: true },
    truncated: { type: "boolean", optional: true },
  },
};

/** atf_launch_execute 参数。
 *
 *  两种调用形态等价（run 直调优先）：真机教训是启动件本来就由内核落在 <run>/launch/，
 *  而参数面把 launch_sh 的语义锁死在 scratch（launch_ready）——模型手上没有 scratch 路径，
 *  于是判定「没有合法调用方式」并把执行推回 operator。系统知识不得由持有人提示词承载：
 *  形态须在 schema 与错误回流里自陈。
 *    ① run 直调：run_id（+ workspace_path）→ launch_sh 缺席时默认 <run>/launch/launch.sh；
 *    ② scratch 路径：launch_sh＝atf_scratch_exec 返回的 launch_ready.launch_sh。
 *  launch_sh 自身三形态（绝对＝run 树内守卫／相对＝run 树优先／scratch 回落）见
 *  resolveLaunchShPath；config 省略时按 run 树 canonical→legacy 探测（见 handler）。
 */
const LAUNCH_EXECUTE_PARAMS: SchemaNode = {
  type: "object",
  required: [],
  properties: {
    run_id: {
      type: "string",
      optional: true,
      description: "run 标识（run 直调形态）：定位 <workspace_path>/experiments/<exp>/runs/<run_id>；launch_sh 省略时取其 launch/launch.sh",
    },
    workspace_path: {
      type: "string",
      optional: true,
      description: "工作区根（run 直调形态，可选）：run 落在 <workspace_path>/experiments/<exp>/runs/<run_id>（RunLayout/v2 单源）；缺省按会话 cwd→工作区身份→实例配置解析",
    },
    launch_sh: {
      type: "string",
      optional: true,
      description: "launch.sh 路径，三形态均可：绝对路径（须在本 run 目录内）／run 树内相对路径（如 launch/launch.sh）／scratch 相对路径（atf_scratch_exec 返回的 launch_ready.launch_sh）。run 直调形态下可省略",
    },
    config: {
      type: "string",
      optional: true,
      description: "IterationConfig 路径（run 树内相对或绝对均可）。省略时按 run 树 prep/iteration-config/iteration-config.json → prep/iteration-config.json 探测；提供后执行放行记录登记（--record-training-release，须用户确认），随后执行 launch.sh",
    },
    note: { type: "string", optional: true, description: "放行记录备注（缺省标注来源为启动确认卡）" },
  },
};

const LAUNCH_EXECUTE_CANONICAL: SchemaNode = {
  type: "object",
  strict: false,
  required: ["ok", "release_recorded", "release_result", "state", "log_path", "timed_out"],
  properties: {
    ok: { const: true },
    release_recorded: { type: "boolean" },
    release_result: { type: "string" },
    state: { type: "string" },
    launcher_count: { type: "integer", optional: true },
    effect_started: { type: "boolean", optional: true },
    pid: { type: "integer", optional: true },
    log_path: { type: "string" },
    timed_out: { type: "boolean" },
    exit_code: { type: "integer", optional: true },
    launch_sh: { type: "string", optional: true },
  },
};

/** ask_user_for_input 参数（F5 4.1 confirm 型；本批唯一 kind=confirm，其余 fail-closed）。 */
const ASK_USER_PARAMS: SchemaNode = {
  type: "object",
  required: ["kind", "candidate_ref"],
  properties: {
    kind: { enum: ["confirm"], description: "请示类型：confirm＝抽取契约发布确认（渲染确认报告卡面，经问答轨落账后发确认凭据）" },
    title: { type: "string", optional: true, description: "卡面标题（缺省「抽取契约发布确认」）" },
    candidate_ref: {
      type: "string",
      description: "候选契约 JSON 文件（scratch 内相对路径；candidate_digest 由 harness 对该文件复算——模型自报摘要不采信，内核侧亦会复算 fail-closed）",
    },
    report_ref: { type: "string", optional: true, description: "确认报告文件（scratch 内相对路径；build_contract_confirmation_report.py 产物——inline 字段缺项时由此补齐）" },
    prompt_texts: { type: "array", optional: true, items: { type: "string" }, description: "inline 形态：Prompt 实文（与报告文件二选一并集；inline 优先）" },
    field_ids: { type: "array", optional: true, items: { type: "string" }, description: "inline 形态：字段序（顺序敏感；空心卡面拒绝渲染）" },
    field_groups: { type: "array", optional: true, items: { type: "string" }, description: "inline 形态：字段分组（可选）" },
    coordinate_policy: { type: "string", optional: true, description: "inline 形态：坐标策略声明（如 pixel）" },
  },
};

const ASK_USER_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "kind", "candidate_ref", "candidate_digest", "report"],
  properties: {
    ok: { const: true },
    kind: { const: "confirm" },
    candidate_ref: { type: "string" },
    candidate_digest: { type: "string", pattern: HEX64, description: "harness 对候选文件复算的规范化 sha256（确认对象绑定）" },
    report: { type: "object", strict: false, description: "确认报告投影（prompt_texts/field_ids/field_groups/coordinate_policy）" },
    // user_confirmation 由 runner 在问答轨 granted 后合成并入（by/at 取自应答事件、
    // approval_ref=approval_session_id）——handler 层不产凭据（无账面访问权）。
    user_confirmation: { type: "object", optional: true, strict: false },
    approval_session_id: { type: "string", optional: true },
  },
};

/** atf_create_experiment 参数（目录结构 v1：实验是工作区内一等实体）。 */
const CREATE_EXPERIMENT_PARAMS: SchemaNode = {
  type: "object",
  required: ["workspace_path", "experiment_name"],
  properties: {
    workspace_path: {
      type: "string",
      description: "工作区根目录绝对路径（用户任意位置；目录必须已存在——本工具不代建顶层目录）。身份文件 .atf/workspace.json 缺席时自动初始化",
    },
    experiment_name: {
      type: "string",
      description: "实验名 slug（[a-z0-9][a-z0-9-]*）：小写字母或数字开头，仅含小写字母/数字/连字符；实验目录为 experiments/<YYYYMMDD>-<名>/",
    },
  },
};

const CREATE_EXPERIMENT_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "workspace_path", "workspace_id", "experiment_dir", "experiment_id", "experiment_name", "registry_status", "experiments_count"],
  properties: {
    ok: { const: true },
    workspace_path: { type: "string" },
    workspace_id: { type: "string", description: "工作区身份 id（uuid，永不改变）" },
    experiment_dir: { type: "string", description: "实验根目录绝对路径（含 experiment.json 与 runs/）" },
    experiment_id: { type: "string" },
    experiment_name: { type: "string" },
    registry_status: { enum: ["already_registered", "pending_registration"] },
    registry_note: { type: "string", optional: true, description: "pending_registration 时的指路文案（在 WebUI 添加工作区后归属方能生效）" },
    experiments_count: { type: "integer" },
    identity_created: { type: "boolean", optional: true },
    created_at: { type: "string", optional: true },
  },
};

/** atf_rebind_workspace 参数（目录迁移后的按 id 认领）。 */
const REBIND_WORKSPACE_PARAMS: SchemaNode = {
  type: "object",
  required: ["workspace_path"],
  properties: {
    workspace_path: {
      type: "string",
      description: "工作区新位置绝对路径（迁移后的实际目录，须含 .atf/workspace.json 身份文件——认领按 id 不按 path）",
    },
  },
};

const REBIND_WORKSPACE_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "workspace_id", "old_path", "new_path", "registry_updated", "bucket_disposition", "old_anchor_removed"],
  properties: {
    ok: { const: true },
    workspace_id: { type: "string", description: "工作区身份 id（认领单源，永不改变）" },
    old_path: { type: "string" },
    new_path: { type: "string" },
    registry_updated: { type: "boolean", description: "注册表 path 字段是否发生写入（no-op 为 false）" },
    bucket_disposition: { enum: ["old_bucket_present_kept", "old_bucket_absent", "unchanged"] },
    bucket_old_name: { type: "string", optional: true },
    bucket_new_name: { type: "string", optional: true },
    old_anchor_removed: { type: "boolean" },
    old_anchor_note: { type: "string", optional: true },
    note: { type: "string", optional: true, description: "归属语义注记（会话桶零操作＋运行时生效路径）" },
  },
};

// ---------------------------------------------------------------------------
// F5 改动四 4.1（2026-09-26）：confirm 型请示 handler——卡面材料收集（候选摘要复算＋
// 确认报告收集）。凭据（user_confirmation）不在此层：handler 无账面访问权，runner 在
// 问答轨 granted 后按应答事件合成并入结果（见 runner.ts attachConfirmationCredential）。
// ---------------------------------------------------------------------------

const askUserHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const kind = stringParam(rawParams, "kind");
  if (kind !== "confirm") {
    return rejected("invalid_input", { message: `kind 仅支持 confirm（得 ${kind ?? "（缺失）"}）——其他请示类型未开通` });
  }
  const candidateRef = stringParam(rawParams, "candidate_ref");
  if (candidateRef === undefined) {
    return rejected("invalid_input", { message: "candidate_ref 必填（候选契约 JSON 文件，scratch 相对路径）——确认对象必须绑定实际文件，不收模型自报摘要" });
  }
  const guardCandidate = safeScratchPath(host.scratchDir, candidateRef);
  if (!guardCandidate.ok) return rejected(guardCandidate.error.code, { message: guardCandidate.error.message });
  let candidateText: string;
  try {
    candidateText = await readFile(guardCandidate.value.resolved, "utf8");
  } catch {
    return rejected("invalid_input", { message: `候选文件不可读: ${candidateRef}` });
  }
  const candidateDigest = candidateDigestFromText(candidateText);
  if (candidateDigest === null) {
    return rejected("invalid_input", { message: `候选文件不是合法 JSON（摘要复算失败）: ${candidateRef}` });
  }
  // E15b：无生产者字段呈现——候选文件单源（复用已读 candidateText，不新增 inline 参数）；
  // 缺省/空数组 → 不传（卡面零该节）；形态非法 → invalid_input 拒绝（不渲染半真卡面）。
  const unproduced = unproducedFieldsFromCandidateText(candidateText);
  if (!unproduced.ok) {
    return rejected("invalid_input", { message: unproduced.message });
  }
  const reportRef = stringParam(rawParams, "report_ref");
  let reportFile: unknown = undefined;
  if (reportRef !== undefined) {
    const guardReport = safeScratchPath(host.scratchDir, reportRef);
    if (!guardReport.ok) return rejected(guardReport.error.code, { message: guardReport.error.message });
    try {
      reportFile = JSON.parse(await readFile(guardReport.value.resolved, "utf8"));
    } catch {
      return rejected("invalid_input", { message: `确认报告文件不可读或非 JSON: ${reportRef}` });
    }
  }
  const report = collectConfirmReport(rawParams as unknown as ConfirmRequestBody, reportFile);
  if (report === null) {
    return rejected("invalid_input", {
      message:
        "确认报告三要素缺失（Prompt 实文／字段序／坐标策略）——以 inline 字段或 report_ref（build_contract_confirmation_report.py 产物）补齐后再请示；不渲染空心卡面",
    });
  }
  // E15b：声明随 report 下发（仅非空——handler 单源回填，params 面零新增）
  if (unproduced.fields !== undefined) report.unproduced_fields = unproduced.fields;
  return {
    kind: "executed",
    result: {
      ok: true,
      kind: "confirm",
      candidate_ref: candidateRef,
      candidate_digest: candidateDigest,
      report: report as unknown as Record<string, unknown>,
    },
  };
};

/** 工作区工具面（7 个；与 TOOL_DEFINITIONS 分册——不进桥接方法面，注册走 createWithWorkspaceTools）。ask_user_for_input 为 F5 改动四 4.1 增补（2026-09-26，工具面 4→5）；atf_create_experiment／atf_rebind_workspace 为目录结构 v1 工具链增补（2026-10-16，工具面 5→7——TUI/resume 与 WebUI 桥面同源装配；MCP/ACP 不装配零风险）。 */
export const WORKSPACE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "atf_scratch_write",
    description:
      "在当前 run 工作区的 scratch 区写入文件（T0 自由区，免审批）：用于准备执行内核 skills scripts 所需的输入文件（如 IterationConfig JSON）。path 为 scratch 内相对路径（禁绝对路径与 .. 越界），content 为 UTF-8 全文。写入的文件留在 T0，晋升进 artifacts 只能经既有晋升闸。",
    parameters: SCRATCH_WRITE_PARAMS,
    requires_approval: false,
    canonical_output: SCRATCH_WRITE_CANONICAL,
  },
  {
    name: "atf_scratch_exec",
    description:
      "在 scratch 工作区内受控执行 Python（须审批）：工作目录＝scratch、env 白名单（已注入 PYTHONPATH=<内核>/src 与 python3 解释器，可直接 import 内核包）、stdout 上限、超时保护。用途：执行内核 skills 的 scripts/（如 atf-prepare-training 的 generate_train_launch.py、atf-run-training 的 generate_launch_orchestration.py、评估与 badcase 分析脚本）——这些脚本直接 import 内核包、不经 CLI。产物用 --out 指到 scratch 内相对路径。执行结束后 harness 自动检测 scratch 内是否已生成 launch.sh（训练启动就绪信号）。禁止用它执行启动类脚本（launch.sh/train.sh 由 harness 在用户确认后执行）。",
    parameters: SCRATCH_EXEC_PARAMS,
    // 批㊶-F2（2026-10-08 转派裁定）：requires_approval true→false——临时目录只写执行非
    // 治理点（uat 448 弹卡中 59 次误弹根因）；治理语义由既有护栏承载（scratch 区 T0 边界、
    // env 白名单、禁止启动类脚本条款、launch.sh 仅经 atf_launch_execute 放行）。
    // description 内「须审批」字样待文案面另批修正。
    requires_approval: false,
    canonical_output: SCRATCH_EXEC_CANONICAL,
  },
  {
    name: "atf_skill_read",
    description:
      "读 ATF 训练链技能（skills）操作定义（纯读，免审批）：无参调用返回技能清单（name+一行描述）；给 skill 返回该技能 SKILL.md 全文（操作定义，含 scripts 用法与交互纪律）与附属文件清单；给 skill+file 读 references/assets 内附属文件。训练准备/启动/评估/badcase 分析的操作步骤都在对应技能的 SKILL.md 里——先读再按其指引执行。",
    parameters: SKILL_READ_PARAMS,
    requires_approval: false,
    canonical_output: SKILL_READ_CANONICAL,
  },
  {
    name: "atf_launch_execute",
    description:
      "训练启动放行与执行（须审批，harness 专执行点）：G5 preview 闭合且 launch.sh 已生成后，由用户确认触发——harness 先按 IterationConfig 登记训练放行记录（--record-training-release，内核审批账本），再执行 launch.sh（其内置 TRAINING_RELEASE 闸核对该记录）。不要自行调用本工具之外的任何方式启动训练；未经用户确认不得发起。",
    parameters: LAUNCH_EXECUTE_PARAMS,
    requires_approval: true,
    canonical_output: LAUNCH_EXECUTE_CANONICAL,
  },
  {
    // F5 改动四 4.1（2026-09-26）：confirm 型请示——抽取契约发布确认走真人卡面落账，
    // 确认凭据（user_confirmation＋approval_ref）由 harness 合成随工具结果下发。
    name: "ask_user_for_input",
    description:
      "向用户发起确认型请示（须审批——本工具的「审批」即把请示落账并等真人应答）：kind=confirm 用于抽取契约发布前的人工确认。必须给出 candidate_ref（候选契约文件，harness 复算 candidate_digest）；确认报告三要素（Prompt 实文/字段序/坐标策略）以 inline 字段或 report_ref（build_contract_confirmation_report.py 产物）提供，缺任一即拒绝（不渲染空心卡）。用户确认后工具结果携带 user_confirmation（by/at/approval_ref），把它原样写入发布件的用户确认记录（勿改写、勿代签）；用户拒绝则如实停止，勿绕道伪造确认件——内核会复算摘要并 fail-closed。",
    parameters: ASK_USER_PARAMS,
    requires_approval: true,
    canonical_output: ASK_USER_CANONICAL,
  },
  {
    name: "atf_create_experiment",
    description:
      "在工作区内创建实验（须审批）：实验目录 experiments/<YYYYMMDD>-<实验名>/（含 experiment.json 元数据与 runs/），工作区身份文件 .atf/workspace.json 缺席时自动初始化（id=uuid 永不变）。workspace_path 必须是已存在的目录（不代建顶层目录）；实验名重复（同日同名目录已在）即拒绝并指路。工作区未注册到 DSH 侧栏时返回 pending_registration 回执——请引导用户在 WebUI「添加工作区」选择该目录，本工具不代建注册表记录。",
    parameters: CREATE_EXPERIMENT_PARAMS,
    requires_approval: true,
    canonical_output: CREATE_EXPERIMENT_CANONICAL,
  },
  {
    name: "atf_rebind_workspace",
    description:
      "工作区目录迁移后的重新定位（须审批）：读新位置 .atf/workspace.json 的身份 id，在 DSH 注册表按 id 定位原记录并更新 path 字段（其余记录零触碰、id 永不改变）。会话桶零操作（会话归属由会话头 cwd 的 realpath 正典承载——旧路径以符号链接续用时既有会话归属保持，旧路径消失时会话显性入任务桶）；旧位置目录仅在确认为真实空目录时删除。新位置必须已含身份文件（随目录迁移带走）；注册表按 id 无记录时拒绝并指路（先在 WebUI 添加工作区建立记录）。注册表写入在实例重启后进入运行时视野——回执附注该语义。",
    parameters: REBIND_WORKSPACE_PARAMS,
    requires_approval: true,
    canonical_output: REBIND_WORKSPACE_CANONICAL,
  },
];

// ---------------------------------------------------------------- 本地 handler

const stringParam = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const scratchWriteHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const path = stringParam(rawParams, "path");
  const content = rawParams["content"];
  if (path === undefined) return rejected("invalid_input", { message: "path 须为非空字符串" });
  if (typeof content !== "string") return rejected("invalid_input", { message: "content 须为字符串" });
  const written = await guardedScratchWrite({
    scratchDir: host.scratchDir,
    relPath: path,
    content,
    maxBytes: SCRATCH_WRITE_MAX_BYTES,
  });
  if (!written.ok) return rejected(written.error.reason, { message: written.error.message, path });
  return {
    kind: "executed",
    result: { ok: true, path: written.value.path, bytes: written.value.bytes, sha256: written.value.sha256 },
  };
};

/** D71 scratch 通道内核错误码观测账（scratch 内点目录——G5 扫描跳点、晋升面之外）。
 *  append-only JSONL：已知码命中记 kind=known_code（code+原文），未知码记 kind=unknown_code
 *  （code 位+原文）——码与原文的唯一落账面（model-facing 只留人话）。fail-open：账写失败
 *  不阻塞执行返回（与 appendSegmentFact 同款），返回体如实携带替换结果。 */
const KERNEL_ERROR_FACE_LOG_DIR = ".harness";
const KERNEL_ERROR_FACE_LOG_REL = ".harness/kernel-error-face.jsonl";

const appendKernelErrorFaceLog = async (scratchDir: string, entry: {
  kind: "known_code" | "unknown_code";
  key: "stdout" | "stderr_tail";
  code: string;
  raw: string;
}): Promise<boolean> => {
  try {
    await mkdir(join(scratchDir, KERNEL_ERROR_FACE_LOG_DIR), { recursive: true });
    await appendFile(
      join(scratchDir, KERNEL_ERROR_FACE_LOG_REL),
      `${JSON.stringify({ ts: new Date().toISOString(), tool: "atf_scratch_exec", ...entry })}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false; // 观测账写失败不阻塞执行返回
  }
};

const scratchExecHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const rawArgv = rawParams["argv"];
  if (!Array.isArray(rawArgv) || rawArgv.some((part) => typeof part !== "string" || part === "")) {
    return rejected("argv_invalid", { message: "argv 须为 1..32 个非空字符串元素" });
  }
  const timeoutParam = rawParams["timeout_seconds"];
  let timeoutMs = SCRATCH_EXEC_TIMEOUT_MS_DEFAULT;
  if (timeoutParam !== undefined) {
    if (typeof timeoutParam !== "number" || !Number.isInteger(timeoutParam) || timeoutParam < 1 || timeoutParam > 3600) {
      return rejected("timeout_invalid", { message: "timeout_seconds 须为 1..3600 的整数" });
    }
    timeoutMs = timeoutParam * 1000;
  }
  const pythonPath = findPython3(host.pythonPath);
  const guard = guardScratchArgv({ argv: rawArgv as string[], scratchDir: host.scratchDir, kernelDir: host.kernelDir, pythonPath });
  if (!guard.ok) return rejected(guard.reason, { message: guard.message });
  const dirs = await ensureExecDirs(host.scratchDir);
  if (!dirs.ok) return rejected(dirs.error.reason, { message: dirs.error.message });
  const env = buildScratchExecEnv({
    scratchDir: host.scratchDir,
    kernelDir: host.kernelDir,
    baseEnv: { ...host.baseEnv, HOME: host.home },
    pythonPath,
  });
  const ran = await runScratchCommand({ argv: guard.spawnArgv, cwd: host.scratchDir, env, timeoutMs });
  if (!ran.ok) return rejected(ran.error.reason, { message: ran.error.message });
  const outcome = ran.value;
  // G5 就绪检测（确定性；仅成功退出后扫——失败执行可能留半成品）。
  // D115：台账按 run 刷新——run 树正道落点（<runDir>/launch/launch.sh）优先，scratch
  // 旧条目不再遮蔽新件（B7 §5.4「生成位置→执行台账」断裂收口；禁滞留旧条目）
  let launchReady: LaunchReady | null = null;
  if (outcome.exit_code === 0) {
    const fromRunTree = host.runDir !== undefined ? await scanRunTreeLaunchReady(host.runDir) : null;
    launchReady = fromRunTree ?? (await scanLaunchReady(host.scratchDir));
  }
  // D71 封口：scratch 直调通道的 model-facing 文本键（stdout/stderr_tail）已知码 → 人话
  // （复用 kernelErrorFace 闭集单源；扫描不看 exit_code——code==0 但文本含码同样处理）。
  // 原文只进 scratch 观测账；未知码（内核错误信封 code 位不属闭集）不替换不猜，落观测。
  const stdoutFace = replaceKernelErrorFace(outcome.stdout);
  const stderrFace = replaceKernelErrorFace(outcome.stderr_tail);
  const kernelFaceHit = stdoutFace?.hits[0] ?? stderrFace?.hits[0] ?? null;
  for (const [key, text, face] of [
    ["stdout", outcome.stdout, stdoutFace],
    ["stderr_tail", outcome.stderr_tail, stderrFace],
  ] as const) {
    if (face !== null) {
      await appendKernelErrorFaceLog(host.scratchDir, { kind: "known_code", key, code: face.hits[0]?.code ?? "", raw: text });
      continue;
    }
    const envelope = kernelErrorEnvelopeCode(text);
    if (envelope !== null && !KERNEL_ERROR_FACE_CODES.has(envelope.base)) {
      await appendKernelErrorFaceLog(host.scratchDir, { kind: "unknown_code", key, code: envelope.base, raw: text });
    }
  }
  return {
    kind: "executed",
    result: {
      ok: true,
      ...(outcome.exit_code !== null ? { exit_code: outcome.exit_code } : {}),
      timed_out: outcome.timed_out,
      stdout: stdoutFace !== null ? stdoutFace.text : outcome.stdout,
      stdout_truncated: outcome.stdout_truncated,
      stderr_tail: stderrFace !== null ? stderrFace.text : outcome.stderr_tail,
      duration_ms: outcome.duration_ms,
      ...(launchReady !== null ? { launch_ready: launchReady } : {}),
      // D71：内核错误码人话回流（与 pipelineFace/trainingFace 接线同形态——note 人话；
      // 散文零码）。D77：完整码（code:detail）从模型可见返回体移出——模型照抄进散文即
      // 用户可见（H 复跑实测），对账面＝scratch 观测账（known_code 行 code+raw），非返回体。
      ...(kernelFaceHit !== null ? { note: kernelFaceHit.note } : {}),
    },
  };
};

const skillReadHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const skillsRoot = join(host.kernelDir, "skills");
  const skill = stringParam(rawParams, "skill");
  const file = stringParam(rawParams, "file");
  if (skill === undefined) {
    const listed = await listSkills(skillsRoot);
    if (!listed.ok) return rejected(listed.error.code, { message: listed.error.message });
    const skills = listed.value.map((summary: SkillSummary) => ({ name: summary.name, description: summary.description }));
    return { kind: "executed", result: { ok: true, skills } };
  }
  if (file !== undefined) {
    const read = await readSkillFile(skillsRoot, skill, file);
    if (!read.ok) return rejected(read.error.code, { message: read.error.message });
    return {
      kind: "executed",
      result: {
        ok: true,
        skill: read.value.skill,
        file: read.value.file,
        body: read.value.body,
        ...(read.value.truncated ? { truncated: true, truncation_note: `超 ${String(Math.floor(SKILL_FILE_MAX_BYTES / 1024))} KiB 已截断` } : {}),
      },
    };
  }
  const read = await readSkillBody(skillsRoot, skill);
  if (!read.ok) return rejected(read.error.code, { message: read.error.message });
  return {
    kind: "executed",
    result: { ok: true, skill: read.value.skill, body: read.value.body, references: read.value.references },
  };
};

/** D115：launch_sh 三形态解析——绝对路径＝runDir 树内守卫（越界拒）；相对路径＝runDir 树内
 *  优先（launch/ 布局正道落点，禁滞留旧条目——新件在 run 树时不被旧 scratch 条目遮蔽），
 *  scratch 回落存量语义（run 树无该相对路径时）。 */
const resolveLaunchShPath = (
  host: LocalToolHost,
  launchSh: string,
): { ok: true; abs: string } | { ok: false; reason: string; message: string } => {
  const runDir = host.runDir;
  if (isAbsolute(launchSh)) {
    if (runDir === undefined) {
      return { ok: false, reason: "run_tree_form_disabled", message: "绝对路径启动件须 runDir 装配在场（当前装配面缺席——用 scratch 相对路径形态）" };
    }
    const abs = resolve(launchSh);
    const rel = relative(runDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, reason: "run_tree_escape", message: `绝对路径启动件须位于本 run 目录内（${runDir}），越界拒绝: ${launchSh}` };
    }
    return { ok: true, abs };
  }
  if (runDir !== undefined) {
    const runTreeAbs = resolve(runDir, launchSh);
    const rel = relative(runDir, runTreeAbs);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(runTreeAbs)) {
      return { ok: true, abs: runTreeAbs };
    }
  }
  const guard = safeScratchPath(host.scratchDir, launchSh);
  if (!guard.ok) return { ok: false, reason: "path_escape", message: guard.error.message };
  return { ok: true, abs: guard.value.resolved };
};

/** D115：config（IterationConfig）同款三形态解析（run 树内优先——prep/ 布局；scratch 回落）。 */
const resolveConfigPath = (
  host: LocalToolHost,
  configPath: string,
): { ok: true; abs: string } | { ok: false; reason: string; message: string } => {
  const runDir = host.runDir;
  if (isAbsolute(configPath)) {
    if (runDir === undefined) {
      return { ok: false, reason: "run_tree_form_disabled", message: "绝对路径配置须 runDir 装配在场（当前装配面缺席——用 scratch 相对路径形态）" };
    }
    const abs = resolve(configPath);
    const rel = relative(runDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return { ok: false, reason: "run_tree_escape", message: `绝对路径配置须位于本 run 目录内（${runDir}），越界拒绝: ${configPath}` };
    }
    return { ok: true, abs };
  }
  if (runDir !== undefined) {
    const runTreeAbs = resolve(runDir, configPath);
    const rel = relative(runDir, runTreeAbs);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(runTreeAbs)) {
      return { ok: true, abs: runTreeAbs };
    }
  }
  const guard = safeScratchPath(host.scratchDir, configPath);
  if (!guard.ok) return { ok: false, reason: "path_escape", message: guard.error.message };
  return { ok: true, abs: guard.value.resolved };
};

const launchExecuteHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const note = stringParam(rawParams, "note") ?? "训练启动确认卡放行";

  // ① launch.sh 定位（形态收敛）：显式 launch_sh 三形态直通；缺席则按 run 直调取
  // <run>/launch/launch.sh。缺参不静默——错误里把两种合法形态都点名，模型不必猜。
  let launchShRel = stringParam(rawParams, "launch_sh");
  let launchTargetForm = "explicit";
  if (launchShRel === undefined) {
    if (host.runDir === undefined) {
      return rejected("launch_target_unresolved", {
        message:
          "未给出 launch_sh，且当前装配无 run 目录可回退——请改用任一种合法形态：" +
          "① run 直调：run_id（+ workspace_path）由工具按 RunLayout 定位 <run>/launch/launch.sh；" +
          "② 显式路径：launch_sh 传 launch/launch.sh（run 树内相对）或 atf_scratch_exec 返回的 launch_ready.launch_sh",
      });
    }
    const defaultLaunchSh = join(host.runDir, "launch", "launch.sh");
    if (!existsSync(defaultLaunchSh)) {
      return rejected("launch_target_unresolved", {
        message:
          `未给出 launch_sh，run 树内也没有默认启动件（${defaultLaunchSh} 不存在）——` +
          "启动件须先由训练准备段产出；请先跑训练准备/启动编排生成 <run>/launch/launch.sh，或显式传 launch_sh",
        run_dir: host.runDir,
        expected: defaultLaunchSh,
      });
    }
    launchShRel = "launch/launch.sh";
    launchTargetForm = "run_default";
  }

  // ② config 定位：省略时按 run 树 canonical→legacy 探测（canonical 优先与内核 RunLayout
  // 同序——平铺副本可能是陈旧件）。探测到即用；都无则保持 skipped_no_config 并在结果如实标注。
  let configRel = stringParam(rawParams, "config");
  if (configRel === undefined && host.runDir !== undefined) {
    for (const candidate of [
      join(host.runDir, "prep", "iteration-config", "iteration-config.json"),
      join(host.runDir, "prep", "iteration-config.json"),
    ]) {
      if (existsSync(candidate)) {
        configRel = candidate;
        break;
      }
    }
  }
  const pythonPath = findPython3(host.pythonPath);
  const env = buildScratchExecEnv({
    scratchDir: host.scratchDir,
    kernelDir: host.kernelDir,
    baseEnv: { ...host.baseEnv, HOME: host.home },
    pythonPath,
  });

  // ① 定位 launch.sh（D115 三形态：绝对＝runDir 树内守卫；相对＝run 树优先→scratch 回落）
  // + 从脚本文本解析 TRAIN_DIR → launch_manifest.json
  const launchGuard = resolveLaunchShPath(host, launchShRel);
  if (!launchGuard.ok) return rejected(launchGuard.reason, { message: launchGuard.message });
  let launchShText: string;
  try {
    launchShText = await readFile(launchGuard.abs, "utf8");
  } catch (cause) {
    return rejected("launch_sh_missing", { message: `launch.sh 不可读: ${String(cause)}` });
  }
  const trainDirMatch = /^TRAIN_DIR=['\"]?(.+?)['\"]?\s*$/m.exec(launchShText);
  let manifestSha: string | undefined;
  let manifestRecord: Record<string, unknown> | undefined;
  if (trainDirMatch !== null) {
    const trainDir = (trainDirMatch[1] as string).trim().replace(/^['\"]|['\"]$/g, "");
    try {
      const manifest = JSON.parse(await readFile(join(trainDir, "launch_manifest.json"), "utf8")) as Record<string, unknown>;
      if (typeof manifest["iteration_config_sha256"] === "string") manifestSha = manifest["iteration_config_sha256"];
      manifestRecord = manifest;
    } catch {
      // manifest 不可读＝放行对拍不可做，下方按 config sha 直录（launch.sh 闸会如实裁决）
    }
  }

  // ② 放行记录（harness 代执行——以用户确认卡为前提；agent 永不代签）
  let releaseRecorded = false;
  let releaseResult = "skipped_no_config";
  let releaseLedger: string | undefined;
  if (configRel !== undefined) {
    const configGuard = resolveConfigPath(host, configRel);
    if (!configGuard.ok) return rejected(configGuard.reason, { message: configGuard.message });
    let configBytes: Buffer;
    try {
      configBytes = await readFile(configGuard.abs);
    } catch (cause) {
      return rejected("launch_config_missing", { message: `IterationConfig 不可读: ${String(cause)}` });
    }
    const configSha = createHash("sha256").update(configBytes).digest("hex");
    if (manifestSha !== undefined && manifestSha !== configSha) {
      return rejected("launch_config_mismatch", {
        message: "IterationConfig 与 launch_manifest 的 iteration_config_sha256 不一致（放行对拍 fail-closed）",
        manifest_sha256: manifestSha,
        config_sha256: configSha,
      });
    }
    const recordScript = join(host.kernelDir, "skills", "atf-prepare-training", "scripts", "generate_train_launch.py");
    const dirs = await ensureExecDirs(host.scratchDir);
    if (!dirs.ok) return rejected(dirs.error.reason, { message: dirs.error.message });
    // 放行账本单源：以 launch_manifest 的 approval_ledger 为准（train.sh 头部 export 与
    // launch.sh 放行闸的同一值）。让内核按自身进程 HOME 重新解析会与另外两处错位——真机
    // 曾出现两份账本：launch.sh 闸读一份、train.sh 闸读另一份，真训必须换两个 HOME 各写
    // 一遍账才起得来。manifest 未声明（旧产物）时才交回内核解析（其回退只到实例根，不猜 HOME）。
    const manifestLedger =
      manifestRecord !== undefined && typeof manifestRecord["approval_ledger"] === "string" && String(manifestRecord["approval_ledger"]).trim() !== ""
        ? String(manifestRecord["approval_ledger"]).trim()
        : undefined;
    releaseLedger = manifestLedger;
    const recorded = await runScratchCommand({
      argv: [
        pythonPath,
        recordScript,
        "--record-training-release",
        "--config",
        configGuard.abs,
        "--note",
        note,
        ...(manifestLedger !== undefined ? ["--approval-ledger", manifestLedger] : []),
      ],
      cwd: host.scratchDir,
      env,
      timeoutMs: 60_000,
    });
    if (!recorded.ok) return rejected("release_record_failed", { message: recorded.error.message });
    if (recorded.value.exit_code !== 0) {
      return rejected("release_record_failed", {
        message: `放行记录登记失败（exit ${String(recorded.value.exit_code)}）`,
        stderr_tail: recorded.value.stderr_tail,
      });
    }
    releaseRecorded = true;
    releaseResult = /already_recorded/.test(recorded.value.stdout) ? "already_recorded" : "recorded";
  }

  // 批㊶-S4b T1：GPU 排队补挂编排主路径（挂点＝放行记录登记后、launch.sh 执行前——与
  // atf_run_training「本机重跑」次要路径的排队语义对称；atf_launch_execute 此前零排队，
  // 主线经系统 launch 的链路 GPU 忙时直接启动撞车）。排队面经 host.gpuQueueFace 注入
  // （web 桥装配——扩展层 gpuQueueFace 既有原语同型挂法）；装配缺席＝不排队直启（现状
  // 语义回退，结果如实标注 gpu_queue:"face_absent"）。卡数不可判＝fail-closed 不排队但
  // 发通报（不阻塞主线——owner 裁定固化，通报在适配实现内落 gpu_queue 通知面）。
  let gpuQueueResult: Record<string, unknown> = { gpu_queue: "face_absent" };
  if (host.gpuQueueFace !== undefined) {
    const gate = await host.gpuQueueFace.gateLaunch({
      requiredCards: parseLaunchRequiredCards(launchShText, manifestRecord),
      runDir: host.runDir ?? dirname(host.scratchDir),
      launchShRel,
    });
    if (gate.verdict === "aborted") return rejected("gpu_queue_aborted", { message: "GPU 排队等待被中止——launch.sh 未启动" });
    if (gate.verdict === "denied") {
      return rejected("gpu_window_hit_not_confirmed", { message: "GPU 窗口命中后未获人工确认——launch.sh 未启动", outcome: gate.outcome });
    }
    gpuQueueResult = {
      gpu_queue: gate.queued ? "queued_hit" : "not_queued",
      ...(gate.waited_text !== undefined ? { gpu_queue_waited: gate.waited_text } : {}),
      ...(gate.amber !== undefined ? { gpu_queue_amber: gate.amber } : {}),
      ...(gate.queue_note !== undefined ? { gpu_queue_note: gate.queue_note } : {}),
    };
  }

  // ③ 执行 launch.sh（cwd=launch.sh 所在目录；stdout/stderr 落 harness 日志；未退出不杀）
  const launchShAbs = launchGuard.abs;
  const logPath = join(dirname(launchShAbs), "launch", `harness-launch-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const launched = await runLaunchScript({
    launchShAbs,
    bashPath: findBash(),
    cwd: dirname(launchShAbs),
    env,
    logFileAbs: logPath,
    waitMs: host.launchWaitMs ?? LAUNCH_WAIT_MS_DEFAULT,
  });
  if (!launched.ok) return rejected(launched.error.reason, { message: launched.error.message });
  const state = await readLaunchState(launchShAbs);
  // 批㊶-K 项 4：登记放行后同挂曲线进料（harness-launch-*.log 此前全仓零消费＝曲线进料断根因面；
  // 共享 lossIngest 单源——run 目录由 scratch 约定上溯：runs/<run_id>/scratch → runs/<run_id>/training）
  // D115：run 目录单源——host.runDir（run 树形态同值）优先；scratch 上溯为既有装配回退
  const runDir = host.runDir ?? dirname(host.scratchDir);
  const lossSeriesPath = join(runDir, "training", "loss-series.json");
  // F1（首跑体验批）：首次放行时间戳（launch-kpi.json first_launch_at——首写固定，
  // time-to-launch 统计口径；写失败静默 fail-open，不阻塞放行主流程）
  recordFirstLaunchAt(runDir, new Date().toISOString());
  startLossIngest(logPath, lossSeriesPath);
  return {
    kind: "executed",
    result: {
      ok: true,
      release_recorded: releaseRecorded,
      release_result: releaseResult,
      release_config: configRel ?? null,
      release_ledger: releaseLedger ?? null,
      state: typeof state?.["state"] === "string" ? state["state"] : "unknown",
      ...(typeof state?.["launcher_count"] === "number" ? { launcher_count: state["launcher_count"] as number } : {}),
      ...(typeof state?.["effect_started"] === "boolean" ? { effect_started: state["effect_started"] as boolean } : {}),
      ...(launched.value.pid !== null ? { pid: launched.value.pid } : {}),
      log_path: launched.value.log_path,
      loss_ingest_attached: true,
      loss_series_path: lossSeriesPath,
      timed_out: launched.value.timed_out,
      ...(launched.value.exit_code !== null ? { exit_code: launched.value.exit_code } : {}),
      launch_sh: launchShRel,
      launch_target_form: launchTargetForm,
      ...gpuQueueResult,
    },
  };
};

// ---------------------------------------------------------------- 目录结构 v1 工具链 handler
// （确定性文件操作单源在 workspaceRegistry.ts——本层只做参数折算与结构化回流：
//   一切业务错误折算 rejected(invalid_params)＋指路文案，不猜测不代建。）

const createExperimentHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const workspacePath = stringParam(rawParams, "workspace_path");
  const experimentName = stringParam(rawParams, "experiment_name");
  if (workspacePath === undefined) return rejected("invalid_params", { message: "workspace_path 须为非空字符串（工作区根目录绝对路径）" });
  if (experimentName === undefined) return rejected("invalid_params", { message: "experiment_name 须为非空字符串（slug 形态 [a-z0-9][a-z0-9-]*）" });
  let outcome: CreateExperimentOutcome;
  try {
    outcome = createExperimentInWorkspace(workspacePath, experimentName, new Date(), host.dshHome ?? resolveDshHome());
  } catch (cause) {
    return rejected("invalid_params", { message: (cause as Error).message });
  }
  return {
    kind: "executed",
    result: {
      ok: true,
      workspace_path: outcome.workspacePath,
      workspace_id: outcome.workspaceId,
      experiment_dir: outcome.experimentDir,
      experiment_id: outcome.experimentId,
      experiment_name: outcome.experimentName,
      registry_status: outcome.registryStatus,
      ...(outcome.registryStatus === "pending_registration"
        ? { registry_note: "工作区尚未注册到 DSH 侧栏——请在 WebUI「添加工作区」选择该目录（本工具不代建注册表记录）；注册后新会话按 cwd 归属该工作区" }
        : {}),
      experiments_count: outcome.experimentsCount,
      ...(outcome.identityCreated ? { identity_created: true } : {}),
      created_at: outcome.createdAt,
    },
  };
};

const rebindWorkspaceHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const workspacePath = stringParam(rawParams, "workspace_path");
  if (workspacePath === undefined) return rejected("invalid_params", { message: "workspace_path 须为非空字符串（迁移后新位置绝对路径）" });
  const dshHome = host.dshHome ?? resolveDshHome();
  let outcome: RebindOutcome;
  try {
    outcome = rebindWorkspaceToPath(workspacePath, dshHome, new Date());
  } catch (cause) {
    return rejected("invalid_params", { message: (cause as Error).message });
  }
  return {
    kind: "executed",
    result: {
      ok: true,
      workspace_id: outcome.workspaceId,
      old_path: outcome.oldPath,
      new_path: outcome.newPath,
      registry_updated: outcome.registryUpdated,
      bucket_disposition: outcome.bucketDisposition,
      ...(outcome.bucketOldName !== undefined ? { bucket_old_name: outcome.bucketOldName } : {}),
      bucket_new_name: outcome.bucketNewName,
      old_anchor_removed: outcome.oldAnchorRemoved,
      old_anchor_note: outcome.oldAnchorNote,
      note: "注册表变更已落盘；会话桶零操作（既有会话归属由会话头 cwd 正典承载——旧路径以符号链接续用则归属保持，旧路径消失则会话显性入任务桶）；运行中的 DSH 实例在重启后进入新归属",
    },
  };
};

/** 工具名 → 本地 handler（executor 本地分派表）。 */
export const WORKSPACE_TOOL_HANDLERS: Readonly<Record<string, LocalToolHandler>> = {
  atf_scratch_write: scratchWriteHandler,
  atf_scratch_exec: scratchExecHandler,
  atf_skill_read: skillReadHandler,
  atf_launch_execute: launchExecuteHandler,
  ask_user_for_input: askUserHandler,
  atf_create_experiment: createExperimentHandler,
  atf_rebind_workspace: rebindWorkspaceHandler,
};

/** 装配 helper（TUI/resume 消费）：技能常驻清单 systemSuffix（skillsRoot 缺失 = undefined，装载降级）。 */
export const buildSkillsSystemSuffix = async (kernelDir: string): Promise<string | undefined> => {
  const listed = await listSkills(join(kernelDir, "skills"));
  return listed.ok ? skillsSuffixText(listed.value) : undefined;
};
