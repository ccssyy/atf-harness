/**
 * 丙 v2（批 P 续作，指令 6227dbfc §四.1）——A7 四工具治理包装：read/edit/write/bash
 * 按 ATF 治理接入模型面（工具面 13→17）。
 *
 * 治理形态（指令 §三.1 钉死项）：
 *   ① 路径白名单单源——workspace runs 根＋scratch 目录（FILE_TOOL 白名单解析单点
 *     resolveFileToolRoots／resolveWhitelistedPath；装配期给定，env ATF_V1_FILE_TOOL_ROOTS
 *     可追加），绝对路径越界／相对路径 .. 逃逸／symlink 逃逸一律结构化 rejected；
 *   ② 写类动作过审批闸——审批不在本层（approvalHook before_tool 同款语义：账本一次性
 *     消费＋fail-closed）；本层只提供判定单源 requiresApprovalFor 消费的谓词：
 *     atf_read=只读直通、atf_edit/atf_write=写闸、atf_bash=按命令分类（写语义命令进写闸，
 *     未知/组合/重定向/命令替换一律 fail-closed 按须审批处置）；
 *   ③ edit＝diff 精确替换语义（old_string 唯一匹配；多命中拒绝，replace_all 显式放开）；
 *   ④ read＝行区间分页（offset/limit＋has_more/next_offset，行内超长截断留痕）。
 *
 * 工具定义单源：FILE_TOOL_DEFINITIONS 为丙线本地治理面唯一出处——桥接方法面
 * （TOOL_DEFINITIONS，契约登记）零 diff，本面不经桥（本地 handler 执行，零桥接契约 diff）；
 * 审批 hook 经 atfAgentTools.toolDefinitionFor 同一查找出口消费本面（工具面收敛不破）。
 * 执行径终态只产出 executed / rejected（对齐 workspaceTools 本地 handler 纪律：
 * 基础设施故障折算 rejected 结构化回填，模型可如实转述）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { err, ok, type Result } from "../bridge/index.js";
import { checkSchema, validateCanonicalOutput, type SchemaNode, type ToolDefinition } from "../core/tools/index.js";
import { findBash, runScratchCommand, SCRATCH_EXEC_STDERR_TAIL_BYTES, SCRATCH_WRITE_MAX_BYTES } from "../core/workspace/scratchExec.js";

/** A7 四工具名（atf_ 前缀＝治理包装面，与全工具面命名一致；指令件记名 read/edit/write/bash）。 */
export const FILE_TOOL_NAMES: readonly string[] = ["atf_read", "atf_edit", "atf_write", "atf_bash"];

/** 单文件体量上限（写/编辑后；与 scratch 写闸同源常量，1 MiB）。 */
export const FILE_TOOL_MAX_BYTES = SCRATCH_WRITE_MAX_BYTES;

/** read 分页上限（缺省 200 行；单次最多 2000 行）。 */
export const FILE_TOOL_READ_DEFAULT_LINES = 200;
export const FILE_TOOL_READ_MAX_LINES = 2000;
/** read 行内截断（超长行截断留痕，防单行巨体量刷爆转录）。 */
export const FILE_TOOL_READ_LINE_CAP_CHARS = 2000;
/** read 文件体量上限（超限拒绝，不读入）。 */
export const FILE_TOOL_READ_MAX_BYTES = 8 * 1024 * 1024;

/** bash 受控执行：超时缺省/上限；env 白名单键（凭据不进子进程 env——红线 env-only 之外的键不透传）。 */
export const FILE_TOOL_BASH_TIMEOUT_MS_DEFAULT = 60_000;
export const FILE_TOOL_BASH_TIMEOUT_MS_MAX = 600_000;
export const FILE_TOOL_BASH_ENV_KEYS: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM", "ATF_CLI_PATH", "ATF_WORKSPACE_ROOT"];

/** 白名单追加 env（追加语义，不覆盖装配给定根；path.delimiter 分隔）。 */
export const FILE_TOOL_ROOTS_ENV = "ATF_V1_FILE_TOOL_ROOTS";

/** 本地工具宿主（装配期给定；roots[0]＝主根，相对路径落点——scratch 优先，runs 根随装配追加）。 */
export interface FileToolHost {
  roots: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** 白名单解析单源：绝对化＋去重＋env 追加；空串过滤。结果恒非空有序（roots[0] 主根）。 */
export const resolveFileToolRoots = (input: { roots: readonly string[]; env?: NodeJS.ProcessEnv }): string[] => {
  const extra = (input.env?.[FILE_TOOL_ROOTS_ENV] ?? "")
    .split(sep === "\\" ? ";" : ":")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const raw of [...input.roots, ...extra]) {
    if (raw.trim() === "") continue;
    const abs = resolve(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);
    resolved.push(abs);
  }
  return resolved;
};

const isInside = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(root + sep);

/** 最深已存在祖先的 realpath（锚点；根/目标可能尚不存在——写类动作先建父目录）。 */
const realpathAnchor = async (start: string): Promise<string> => {
  let probe = start;
  for (let guard = 0; guard < 64; guard += 1) {
    const real = await realpath(probe).catch(() => undefined);
    if (real !== undefined) return real;
    const parent = dirname(probe);
    if (parent === probe) return probe;
    probe = parent;
  }
  return probe;
};

/** 白名单路径解析单点：绝对路径须落在某根内；相对路径落主根（roots[0]）；realpath 锚点
 *  防 symlink/.. 逃逸——根不存在时以最深已存在祖先为锚双端比对（根由写动作按需创建）。 */
export const resolveWhitelistedPath = async (
  host: FileToolHost,
  rawPath: string,
): Promise<Result<{ abs: string }, { reason: string; message: string }>> => {
  const roots = resolveFileToolRoots({ roots: host.roots, env: host.env });
  if (roots.length === 0) {
    return err({ reason: "whitelist_empty", message: "路径白名单为空（装配缺 roots）——fail-closed 拒绝一切文件访问" });
  }
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return err({ reason: "invalid_path", message: "path 须为非空字符串" });
  }
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(roots[0] as string, rawPath));
  const inRoot = roots.find((root) => isInside(abs, root));
  if (inRoot === undefined) {
    return err({
      reason: "path_escape",
      message: `路径越出白名单（workspace runs 根＋scratch 目录；${FILE_TOOL_ROOTS_ENV} 可追加）: ${rawPath}`,
    });
  }
  const [absAnchor, rootAnchor] = await Promise.all([realpathAnchor(abs), realpathAnchor(inRoot)]);
  if (!isInside(absAnchor, rootAnchor)) {
    return err({ reason: "path_escape", message: `symlink 解析后越出白名单: ${rawPath}` });
  }
  return ok({ abs });
};

// ---------------------------------------------------------------- bash 命令分类（审批判定单源）

/** bash 只读首词白名单（保守闭集：纯读器；sed/awk/python 等具写语义能力者一律不入）。 */
export const BASH_READONLY_COMMANDS: readonly string[] = [
  "cat", "ls", "head", "tail", "wc", "grep", "rg", "find", "file", "stat", "du", "df", "ps",
  "pwd", "which", "date", "echo", "printf", "sort", "uniq", "diff", "jq", "sha256sum", "md5sum",
  "base64", "tree",
];

/** git 只读子命令闭集（git 其余子命令一律按须审批处置）。 */
export const BASH_GIT_READONLY_SUBCOMMANDS: readonly string[] = ["status", "log", "show", "diff", "describe", "rev-parse"];

/** find 的副作用旗标（命中即按写语义处置）。 */
const FIND_SIDE_EFFECT_FLAGS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"];

/**
 * bash 命令审批分类单源（atf_bash.requiresApproval 谓词；hook 与测试同一出口）。
 * 规则（fail-closed：不能确证只读＝须审批）：
 *   含重定向（< >）、命令替换（$(` `)、反引号）→ 须审批；
 *   按 ; && || | 与换行切段，每段首词须命中只读白名单（git 限只读子命令闭集；
 *   find 命中副作用旗标即写语义）；任何一段不满足 → 须审批。
 */
export const bashCommandRequiresApproval = (command: unknown): boolean => {
  if (typeof command !== "string" || command.trim() === "") return true;
  if (command.includes(">") || command.includes("<")) return true; // 重定向（含 2>&1、here-doc）一律按写语义
  if (command.includes("`") || command.includes("$(")) return true;
  const segments = command
    .split(/;|&&|\|\||\||\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  if (segments.length === 0) return true;
  return segments.some((segment) => segmentRequiresApproval(segment));
};

const segmentRequiresApproval = (segment: string): boolean => {
  const words = segment.split(/\s+/);
  const head = words[0] ?? "";
  if (head === "git") {
    const sub = words[1] ?? "";
    return !BASH_GIT_READONLY_SUBCOMMANDS.includes(sub);
  }
  if (head === "find" && FIND_SIDE_EFFECT_FLAGS.some((flag) => words.includes(flag))) return true;
  return !BASH_READONLY_COMMANDS.includes(head);
};

// ---------------------------------------------------------------- 工具定义（JSON Schema 完整参数）

const HEX64 = "^[0-9a-f]{64}$";

const READ_PARAMS: SchemaNode = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string", description: "目标文件：白名单内绝对路径，或相对主根（scratch）的相对路径；越界拒绝" },
    offset: { type: "integer", optional: true, description: `起始行（1 基；缺省 1）` },
    limit: { type: "integer", optional: true, description: `行数（缺省 ${String(FILE_TOOL_READ_DEFAULT_LINES)}，上限 ${String(FILE_TOOL_READ_MAX_LINES)}；has_more 时以 next_offset 续读）` },
  },
};

const READ_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "path", "content", "total_lines", "offset", "limit", "has_more"],
  properties: {
    ok: { const: true },
    path: { type: "string" },
    content: { type: "string" },
    total_lines: { type: "integer" },
    offset: { type: "integer" },
    limit: { type: "integer" },
    has_more: { type: "boolean" },
    next_offset: { type: "integer", optional: true },
    lines_truncated: { type: "integer", optional: true, description: "行内超长被截断的行数" },
  },
};

const WRITE_PARAMS: SchemaNode = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: { type: "string", description: "目标文件：白名单内绝对路径，或相对主根（scratch）的相对路径；父目录自动创建；越界拒绝" },
    content: { type: "string", description: `文件全文（UTF-8；上限 ${String(Math.floor(FILE_TOOL_MAX_BYTES / 1024))} KiB）` },
  },
};

const WRITE_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "path", "bytes", "sha256", "created"],
  properties: {
    ok: { const: true },
    path: { type: "string" },
    bytes: { type: "integer" },
    sha256: { type: "string", pattern: HEX64 },
    created: { type: "boolean" },
  },
};

const EDIT_PARAMS: SchemaNode = {
  type: "object",
  required: ["path", "old_string", "new_string"],
  properties: {
    path: { type: "string", description: "目标文件（必须已存在）：白名单内绝对路径，或相对主根（scratch）的相对路径" },
    old_string: { type: "string", description: "被替换原文（精确匹配；须唯一命中——多命中拒绝并提示加下文定界，或显式 replace_all）" },
    new_string: { type: "string", description: "替换后文本（可为空串＝删除）" },
    replace_all: { type: "boolean", optional: true, description: "全部替换（缺省 false＝要求唯一命中）" },
  },
};

const EDIT_CANONICAL: SchemaNode = {
  type: "object",
  required: ["ok", "path", "replacements", "bytes", "sha256"],
  properties: {
    ok: { const: true },
    path: { type: "string" },
    replacements: { type: "integer" },
    bytes: { type: "integer" },
    sha256: { type: "string", pattern: HEX64 },
  },
};

const BASH_PARAMS: SchemaNode = {
  type: "object",
  required: ["command"],
  properties: {
    command: {
      type: "string",
      description:
        "bash 命令（经 bash -c 受控执行；工作目录缺省主根 scratch，env 白名单最小集）。治理：纯读命令（cat/ls/grep/find/git status 等）免审批直通；写语义命令（重定向、rm/mv/cp、sed/awk/python 等）须账本审批——不确定即按须审批处置，勿试图绕分类",
    },
    cwd: { type: "string", optional: true, description: "工作目录：白名单内绝对路径，或相对主根的相对路径；越界拒绝" },
    timeout_seconds: { type: "integer", optional: true, description: `超时秒数（1..${String(FILE_TOOL_BASH_TIMEOUT_MS_MAX / 1000)}，缺省 ${String(FILE_TOOL_BASH_TIMEOUT_MS_DEFAULT / 1000)}）；超时进程被终止并如实标注 timed_out` },
  },
};

const BASH_CANONICAL: SchemaNode = {
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
  },
};

/** A7 四工具定义（丙线本地治理面单源；不进 TOOL_DEFINITIONS——桥接方法面零 diff）。 */
export const FILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "atf_read",
    description:
      "读白名单内文件（只读直通，免审批）：行区间分页——返回带行号内容、总行数与 has_more；has_more 时以 next_offset 续读。路径限 workspace runs 根与 scratch 目录（白名单），越界拒绝。",
    parameters: READ_PARAMS,
    requires_approval: false,
    canonical_output: READ_CANONICAL,
  },
  {
    name: "atf_edit",
    description:
      "精确编辑白名单内已有文件（写动作，须审批）：old_string 精确匹配唯一命中方可替换（多命中拒绝——扩充上下文定界或显式 replace_all；零命中拒绝）。返回替换计数与新文件 sha256。",
    parameters: EDIT_PARAMS,
    requires_approval: true,
    canonical_output: EDIT_CANONICAL,
  },
  {
    name: "atf_write",
    description:
      "写白名单内文件（写动作，须审批）：创建或整文件覆写（父目录自动创建），返回字节数与 sha256。路径限 workspace runs 根与 scratch 目录（白名单），越界拒绝。产物进 artifacts 只能经既有晋升闸。",
    parameters: WRITE_PARAMS,
    requires_approval: true,
    canonical_output: WRITE_CANONICAL,
  },
  {
    name: "atf_bash",
    description:
      "受控执行 bash 命令：纯读命令免审批直通（白名单见工具面清单）；写语义命令（重定向/写类程序/未知命令）须账本审批（fail-closed 分类——不能确证只读即须审批）。stdout 有上限截断、超时保护、env 最小白名单；工作目录限白名单内。",
    parameters: BASH_PARAMS,
    requires_approval: true,
    requiresApproval: (params: unknown): boolean => {
      const command = typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as { command?: unknown }).command
        : undefined;
      return bashCommandRequiresApproval(command);
    },
    canonical_output: BASH_CANONICAL,
  },
];

// ---------------------------------------------------------------- 本地 handler 与装配

const stringParam = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const intParam = (params: Record<string, unknown>, key: string): number | undefined => {
  const value = params[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

const rejected = (reason: string, message: string): Result<Record<string, unknown>, { reason: string; message: string }> =>
  err({ reason, message });

const sha256Of = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

const readHandler = async (params: Record<string, unknown>, host: FileToolHost): Promise<Result<Record<string, unknown>, { reason: string; message: string }>> => {
  const path = stringParam(params, "path");
  if (path === undefined) return rejected("invalid_input", "path 须为非空字符串");
  const guard = await resolveWhitelistedPath(host, path);
  if (!guard.ok) return err(guard.error);
  const info = await stat(guard.value.abs).catch(() => undefined);
  if (info === undefined) return rejected("file_missing", `文件不存在: ${path}`);
  if (!info.isFile()) return rejected("not_a_file", `非普通文件: ${path}`);
  if (info.size > FILE_TOOL_READ_MAX_BYTES) {
    return rejected("read_too_large", `文件超读取上限（${String(FILE_TOOL_READ_MAX_BYTES)} 字节）: ${path}`);
  }
  let text: string;
  try {
    text = await readFile(guard.value.abs, "utf8");
  } catch (cause) {
    return rejected("read_failed", `读取失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const allLines = text.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const total = allLines.length;
  let offset = intParam(params, "offset") ?? 1;
  if (offset < 1) return rejected("offset_invalid", "offset 须为 ≥1 的整数（1 基行号）");
  if (offset > total && total > 0) return rejected("offset_out_of_range", `offset 越界（总行数 ${String(total)}）`);
  let limit = intParam(params, "limit") ?? FILE_TOOL_READ_DEFAULT_LINES;
  if (limit < 1) return rejected("limit_invalid", "limit 须为 ≥1 的整数");
  if (limit > FILE_TOOL_READ_MAX_LINES) limit = FILE_TOOL_READ_MAX_LINES;
  const slice = allLines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length - 1).length;
  let linesTruncated = 0;
  const rendered = slice.map((line, index) => {
    let body = line;
    if (body.length > FILE_TOOL_READ_LINE_CAP_CHARS) {
      body = `${body.slice(0, FILE_TOOL_READ_LINE_CAP_CHARS)}…(行内截断)`;
      linesTruncated += 1;
    }
    return `${String(offset + index).padStart(width, " ")}\t${body}`;
  });
  const hasMore = offset - 1 + slice.length < total;
  return ok({
    ok: true,
    path,
    content: rendered.join("\n") + (rendered.length > 0 ? "\n" : ""),
    total_lines: total,
    offset,
    limit,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + slice.length } : {}),
    ...(linesTruncated > 0 ? { lines_truncated: linesTruncated } : {}),
  });
};

const writeHandler = async (params: Record<string, unknown>, host: FileToolHost): Promise<Result<Record<string, unknown>, { reason: string; message: string }>> => {
  const path = stringParam(params, "path");
  if (path === undefined) return rejected("invalid_input", "path 须为非空字符串");
  const content = params["content"];
  if (typeof content !== "string") return rejected("invalid_input", "content 须为字符串");
  if (Buffer.byteLength(content, "utf8") > FILE_TOOL_MAX_BYTES) {
    return rejected("write_too_large", `内容超写上限（${String(FILE_TOOL_MAX_BYTES)} 字节）`);
  }
  const guard = await resolveWhitelistedPath(host, path);
  if (!guard.ok) return err(guard.error);
  const existing = await stat(guard.value.abs).catch(() => undefined);
  if (existing !== undefined && !existing.isFile()) return rejected("not_a_file", `目标已存在且非普通文件: ${path}`);
  try {
    await mkdir(dirname(guard.value.abs), { recursive: true });
    await writeFile(guard.value.abs, content, "utf8");
  } catch (cause) {
    return rejected("write_failed", `写入失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return ok({ ok: true, path, bytes: Buffer.byteLength(content, "utf8"), sha256: sha256Of(content), created: existing === undefined });
};

const editHandler = async (params: Record<string, unknown>, host: FileToolHost): Promise<Result<Record<string, unknown>, { reason: string; message: string }>> => {
  const path = stringParam(params, "path");
  if (path === undefined) return rejected("invalid_input", "path 须为非空字符串");
  const oldString = params["old_string"];
  const newString = params["new_string"];
  if (typeof oldString !== "string" || oldString === "") return rejected("invalid_input", "old_string 须为非空字符串（空串匹配无意义，拒绝）");
  if (typeof newString !== "string") return rejected("invalid_input", "new_string 须为字符串");
  const replaceAll = params["replace_all"] === true;
  const guard = await resolveWhitelistedPath(host, path);
  if (!guard.ok) return err(guard.error);
  let text: string;
  try {
    text = await readFile(guard.value.abs, "utf8");
  } catch (cause) {
    return rejected("edit_target_unreadable", `目标不可读（edit 只改已有文件）: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const hits = text.split(oldString).length - 1;
  if (hits === 0) return rejected("old_string_not_found", "old_string 零命中——先 atf_read 核对原文（diff 精确替换语义：不猜测）");
  if (hits > 1 && !replaceAll) {
    return rejected("old_string_ambiguous", `old_string 命中 ${String(hits)} 处——扩充上下文定界至唯一，或显式 replace_all`);
  }
  const updated = replaceAll ? text.replaceAll(oldString, newString) : text.replace(oldString, newString);
  if (Buffer.byteLength(updated, "utf8") > FILE_TOOL_MAX_BYTES) {
    return rejected("write_too_large", `编辑后超写上限（${String(FILE_TOOL_MAX_BYTES)} 字节）`);
  }
  try {
    await writeFile(guard.value.abs, updated, "utf8");
  } catch (cause) {
    return rejected("write_failed", `写回失败: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return ok({ ok: true, path, replacements: hits, bytes: Buffer.byteLength(updated, "utf8"), sha256: sha256Of(updated) });
};

const bashHandler = async (params: Record<string, unknown>, host: FileToolHost): Promise<Result<Record<string, unknown>, { reason: string; message: string }>> => {
  const command = stringParam(params, "command");
  if (command === undefined) return rejected("invalid_input", "command 须为非空字符串");
  let timeoutMs = FILE_TOOL_BASH_TIMEOUT_MS_DEFAULT;
  const timeoutSeconds = intParam(params, "timeout_seconds");
  if (timeoutSeconds !== undefined) {
    if (timeoutSeconds < 1 || timeoutSeconds > FILE_TOOL_BASH_TIMEOUT_MS_MAX / 1000) {
      return rejected("timeout_invalid", `timeout_seconds 须为 1..${String(FILE_TOOL_BASH_TIMEOUT_MS_MAX / 1000)} 的整数`);
    }
    timeoutMs = timeoutSeconds * 1000;
  }
  let cwdAbs: string;
  const cwd = stringParam(params, "cwd");
  if (cwd === undefined) {
    const roots = resolveFileToolRoots({ roots: host.roots, env: host.env });
    if (roots.length === 0) return rejected("whitelist_empty", "路径白名单为空（装配缺 roots）——fail-closed 拒绝执行");
    cwdAbs = roots[0] as string;
  } else {
    const guard = await resolveWhitelistedPath(host, cwd);
    if (!guard.ok) return err(guard.error);
    cwdAbs = guard.value.abs;
  }
  await mkdir(cwdAbs, { recursive: true }); // 白名单内 cwd 缺失即建（首跑 scratch 未落盘）
  const env: Record<string, string> = {};
  const source = host.env ?? process.env;
  for (const key of FILE_TOOL_BASH_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  const ran = await runScratchCommand({ argv: [findBash(), "-c", command], cwd: cwdAbs, env, timeoutMs });
  if (!ran.ok) return err(ran.error);
  const outcome = ran.value;
  return ok({
    ok: true,
    ...(outcome.exit_code !== null ? { exit_code: outcome.exit_code } : {}),
    timed_out: outcome.timed_out,
    stdout: outcome.stdout,
    stdout_truncated: outcome.stdout_truncated,
    stderr_tail: outcome.stderr_tail,
    duration_ms: outcome.duration_ms,
  });
};

type FileToolHandler = (params: Record<string, unknown>, host: FileToolHost) => Promise<Result<Record<string, unknown>, { reason: string; message: string }>>;

/** 工具名 → 本地 handler（A7 单源分派表）。 */
export const FILE_TOOL_HANDLERS: Readonly<Record<string, FileToolHandler>> = {
  atf_read: readHandler,
  atf_edit: editHandler,
  atf_write: writeHandler,
  atf_bash: bashHandler,
};

const textOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
};

/** 工具定义 → pi-agent-core AgentTool（本地执行径；审批在 beforeToolCall hook——见文件头）。 */
export const toFileAgentTool = (definition: ToolDefinition, host: FileToolHost): AgentTool =>
  ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters as unknown as AgentTool["parameters"],
    execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<any>> => {
      const paramCheck = checkSchema(params ?? {}, definition.parameters, definition.name);
      if (paramCheck !== null) {
        return {
          content: [{ type: "text", text: textOf({ ok: false, error: "schema_violation", tool: definition.name, message: paramCheck }) }],
          details: { ok: false, error: "schema_violation" },
        };
      }
      const handler = FILE_TOOL_HANDLERS[definition.name];
      if (handler === undefined) {
        return {
          content: [{ type: "text", text: textOf({ ok: false, error: "handler_missing", tool: definition.name }) }],
          details: { ok: false, error: "handler_missing" },
        };
      }
      const outcome = await handler((params ?? {}) as Record<string, unknown>, host);
      if (!outcome.ok) {
        const detail = { ok: false, error: outcome.error.reason, message: outcome.error.message, tool: definition.name };
        return { content: [{ type: "text", text: textOf(detail) }], details: detail };
      }
      const canonicalCheck = validateCanonicalOutput(definition.name, definition.canonical_output, outcome.value);
      if (!canonicalCheck.ok) {
        throw new Error(`canonical 输出校验失败（${canonicalCheck.error.code}）: ${canonicalCheck.error.message}`);
      }
      return { content: [{ type: "text", text: textOf(outcome.value) }], details: outcome.value as Record<string, unknown> };
    },
  }) as AgentTool;

/** A7 四工具装配（白名单在装配点解析定形——env 追加在构建时一次性生效）。 */
export const buildFileAgentTools = (host: FileToolHost): AgentTool[] =>
  FILE_TOOL_DEFINITIONS.map((definition) => toFileAgentTool(definition, { ...host, roots: resolveFileToolRoots({ roots: host.roots, env: host.env }) }));

/** A7 审批闸判定（hook 消费单源——requiresApprovalFor 对本面定义的直通出口）。 */
export const fileToolRequiresApproval = (definition: ToolDefinition, params: unknown): boolean =>
  definition.requiresApproval !== undefined ? definition.requiresApproval(params) : definition.requires_approval;
