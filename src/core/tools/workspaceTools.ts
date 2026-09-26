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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  SCRATCH_EXEC_STDOUT_CAP_BYTES,
  SCRATCH_EXEC_TIMEOUT_MS_DEFAULT,
  SCRATCH_WRITE_MAX_BYTES,
  type LaunchReady,
} from "../workspace/scratchExec.js";
import {
  listSkills,
  readSkillBody,
  readSkillFile,
  skillsSuffixText,
  SKILL_FILE_MAX_BYTES,
  type SkillSummary,
} from "../workspace/skillCatalog.js";
import { safeScratchPath } from "../workspace/runWorkspace.js";
import { candidateDigestFromText, collectConfirmReport, type ConfirmRequestBody } from "../confirmRequest.js";
import { type SchemaNode } from "./canonical.js";
import { type ToolDefinition } from "./toolDefinition.js";

const HEX64 = "^[0-9a-f]{64}$";

/** 本地工具宿主（TUI/resume 装配；测试注入临时目录）。 */
export interface LocalToolHost {
  /** 当前 run 的 scratch 绝对路径（T0 区；一切写与执行的落点） */
  scratchDir: string;
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
}

/** 本地 handler 终态（无 failed——环境缺口一律结构化 rejected，模型可转述；见文件头）。 */
export type LocalToolResult =
  | { kind: "executed"; result: unknown }
  | { kind: "rejected"; reason: string; detail?: unknown };

export type LocalToolHandler = (params: unknown, host: LocalToolHost) => Promise<LocalToolResult>;

const rejected = (reason: string, detail?: unknown): LocalToolResult => ({ kind: "rejected", reason, detail });

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

/** atf_launch_execute 参数。 */
const LAUNCH_EXECUTE_PARAMS: SchemaNode = {
  type: "object",
  required: ["launch_sh"],
  properties: {
    launch_sh: { type: "string", description: "launch.sh 的 scratch 相对路径（来自 atf_scratch_exec 返回的 launch_ready.launch_sh）" },
    config: {
      type: "string",
      optional: true,
      description: "IterationConfig 的 scratch 相对路径（来自 launch_ready.config）。提供时执行放行记录登记（--record-training-release，须用户确认），随后执行 launch.sh",
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

/** 工作区工具面（5 个；与 TOOL_DEFINITIONS 分册——不进桥接方法面，注册走 createWithWorkspaceTools）。ask_user_for_input 为 F5 改动四 4.1 增补（2026-09-26，工具面 4→5——TUI/resume 装配面；MCP/ACP 不装配零风险）。 */
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
    requires_approval: true,
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
  // G5 就绪检测（确定性；仅成功退出后扫——失败执行可能留半成品）
  let launchReady: LaunchReady | null = null;
  if (outcome.exit_code === 0) {
    launchReady = await scanLaunchReady(host.scratchDir);
  }
  return {
    kind: "executed",
    result: {
      ok: true,
      ...(outcome.exit_code !== null ? { exit_code: outcome.exit_code } : {}),
      timed_out: outcome.timed_out,
      stdout: outcome.stdout,
      stdout_truncated: outcome.stdout_truncated,
      stderr_tail: outcome.stderr_tail,
      duration_ms: outcome.duration_ms,
      ...(launchReady !== null ? { launch_ready: launchReady } : {}),
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

const launchExecuteHandler: LocalToolHandler = async (rawParams, host) => {
  if (!isPlainObject(rawParams)) return rejected("invalid_input", { message: "参数须为 JSON 对象" });
  const launchShRel = stringParam(rawParams, "launch_sh");
  if (launchShRel === undefined) return rejected("invalid_input", { message: "launch_sh 须为非空字符串" });
  const configRel = stringParam(rawParams, "config");
  const note = stringParam(rawParams, "note") ?? "训练启动确认卡放行";
  const pythonPath = findPython3(host.pythonPath);
  const env = buildScratchExecEnv({
    scratchDir: host.scratchDir,
    kernelDir: host.kernelDir,
    baseEnv: { ...host.baseEnv, HOME: host.home },
    pythonPath,
  });

  // ① 定位 launch.sh（守卫在 scratch 内）+ 从脚本文本解析 TRAIN_DIR → launch_manifest.json
  const guard = safeScratchPath(host.scratchDir, launchShRel);
  if (!guard.ok) return rejected("path_escape", { message: guard.error.message });
  let launchShText: string;
  try {
    launchShText = await readFile(guard.value.resolved, "utf8");
  } catch (cause) {
    return rejected("launch_sh_missing", { message: `launch.sh 不可读: ${String(cause)}` });
  }
  const trainDirMatch = /^TRAIN_DIR=['\"]?(.+?)['\"]?\s*$/m.exec(launchShText);
  let manifestSha: string | undefined;
  if (trainDirMatch !== null) {
    const trainDir = (trainDirMatch[1] as string).trim().replace(/^['\"]|['\"]$/g, "");
    try {
      const manifest = JSON.parse(await readFile(join(trainDir, "launch_manifest.json"), "utf8")) as Record<string, unknown>;
      if (typeof manifest["iteration_config_sha256"] === "string") manifestSha = manifest["iteration_config_sha256"];
    } catch {
      // manifest 不可读＝放行对拍不可做，下方按 config sha 直录（launch.sh 闸会如实裁决）
    }
  }

  // ② 放行记录（harness 代执行——以用户确认卡为前提；agent 永不代签）
  let releaseRecorded = false;
  let releaseResult = "skipped_no_config";
  if (configRel !== undefined) {
    const configGuard = safeScratchPath(host.scratchDir, configRel);
    if (!configGuard.ok) return rejected("path_escape", { message: configGuard.error.message });
    let configBytes: Buffer;
    try {
      configBytes = await readFile(configGuard.value.resolved);
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
    const recorded = await runScratchCommand({
      argv: [pythonPath, recordScript, "--record-training-release", "--config", configGuard.value.resolved, "--note", note],
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

  // ③ 执行 launch.sh（cwd=launch.sh 所在目录；stdout/stderr 落 harness 日志；未退出不杀）
  const launchShAbs = guard.value.resolved;
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
  return {
    kind: "executed",
    result: {
      ok: true,
      release_recorded: releaseRecorded,
      release_result: releaseResult,
      state: typeof state?.["state"] === "string" ? state["state"] : "unknown",
      ...(typeof state?.["launcher_count"] === "number" ? { launcher_count: state["launcher_count"] as number } : {}),
      ...(typeof state?.["effect_started"] === "boolean" ? { effect_started: state["effect_started"] as boolean } : {}),
      ...(launched.value.pid !== null ? { pid: launched.value.pid } : {}),
      log_path: launched.value.log_path,
      timed_out: launched.value.timed_out,
      ...(launched.value.exit_code !== null ? { exit_code: launched.value.exit_code } : {}),
      launch_sh: launchShRel,
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
};

/** 装配 helper（TUI/resume 消费）：技能常驻清单 systemSuffix（skillsRoot 缺失 = undefined，装载降级）。 */
export const buildSkillsSystemSuffix = async (kernelDir: string): Promise<string | undefined> => {
  const listed = await listSkills(join(kernelDir, "skills"));
  return listed.ok ? skillsSuffixText(listed.value) : undefined;
};
