/**
 * RunWorkspace——三层工作区 run 目录结构 v0（ADR-08 / 任务书 §4.1 / workspace.contract.yaml）。
 *
 * 纪律：
 * - 宿主 = harness 仓测试工作区（owner 口径 #1）：库只接受调用方注入的 run 根路径，
 *   不内置路径策略、永不向内核仓写入（内核仓 runs/ 只读纪律不变）；
 *   "在 ATF 现有 run 目录内扩展" = 语义对齐（目录形状与命名沿用内核惯例），非物理写入内核仓；
 * - 先落盘再继续：provenance / scratch / sidecar 写入等待完成才返回（任务书硬约束）；
 * - T1 不可变、T2 只读：本模块对 artifacts/ 只经晋升闸写入、对 contracts/ 永不写入（只做清点）；
 * - 禁止异常穿越边界：一切可能失败的路径返回 Result。
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../bridge/index.js";
import { CATALOG_FILENAME, loadCatalog } from "./catalog.js";
import { workspaceError, type WorkspaceError } from "./errors.js";

/** T0 自由区内的 provenance 文件名（workspace.contract.yaml run_dir.provenance.path）。 */
export const PROVENANCE_FILENAME = "provenance.json";

/** 产物元数据 sidecar 后缀：登记复现命令（owner 口径 #3），与产物一一相邻。 */
export const REPRODUCE_META_SUFFIX = ".meta.json";

/** 会话事件流默认约定路径（session.contract.yaml persistence.path 之 S4 落地）。 */
export const SESSION_LOG_FILENAME = "session.jsonl";

/** provenance 四元组（owner 口径 #2：冒烟阶段 model_id = "faux"；trigger_instruction/run_id 本 slice 由调用方给定）。 */
export interface ProvenanceInput {
  run_id: string;
  trigger_instruction: string;
  model_id: string;
}

/** 工作区状态（T2 只读展示，owner 口径 #5：目录存在 + 条目清点，永不写入）。 */
export interface WorkspaceStatus {
  run_id: string;
  scratch: { entry_count: number };
  artifacts: { catalog_count: number; file_count: number };
  contracts: { exists: boolean; entry_count: number };
  session_log: { exists: boolean };
}

/** 复现命令 sidecar 的登记形态（workspace.contract.yaml promotion_gate_a.reproduce_check.command_source）。 */
export interface ReproduceMeta {
  /** 登记的源产物（scratch 内相对路径），promote 时与请求路径严格比对 */
  artifact: string;
  reproduce: { command: string[] };
  /** ISO 8601 UTC */
  registered_at: string;
}

export interface RunWorkspaceOptions {
  /** 时间源注入（默认 UTC ISO 8601）；测试可用固定时钟。 */
  now?: () => string;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIso8601 = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));

export class RunWorkspace {
  private constructor(
    readonly rootDir: string,
    readonly scratchDir: string,
    readonly artifactsDir: string,
    readonly contractsDir: string,
    private readonly now: () => string,
  ) {}

  /**
   * 创建（或按重开语义打开）一个 run 工作区：建立 scratch/artifacts/contracts 三层目录，
   * 并在 scratch/ 自动生成 provenance.json（已存在则逐字段比对，不一致 = err，fail-closed）。
   */
  public static async create(
    rootDir: string,
    input: ProvenanceInput,
    options: RunWorkspaceOptions = {},
  ): Promise<Result<RunWorkspace, WorkspaceError>> {
    if (!isNonEmptyString(input.run_id) || !isNonEmptyString(input.trigger_instruction) || !isNonEmptyString(input.model_id)) {
      return err(workspaceError("invalid_input", "provenance 输入非法（run_id / trigger_instruction / model_id 均须为非空字符串）"));
    }
    const now = options.now ?? ((): string => new Date().toISOString());
    const scratchDir = join(rootDir, "scratch");
    const artifactsDir = join(rootDir, "artifacts");
    const contractsDir = join(rootDir, "contracts");
    try {
      await mkdir(scratchDir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });
      await mkdir(contractsDir, { recursive: true });
    } catch (cause) {
      return err(workspaceError("invalid_input", `run 目录创建失败: ${(cause as Error).message}`, {
        root: rootDir,
        code: (cause as NodeJS.ErrnoException).code,
      }));
    }

    const workspace = new RunWorkspace(rootDir, scratchDir, artifactsDir, contractsDir, now);
    const provenance = await workspace.ensureProvenance(input);
    if (!provenance.ok) return provenance;
    return ok(workspace);
  }

  /** Artifact Catalog 路径（T1 sha 指纹登记，owner 口径 #6）。 */
  public get catalogPath(): string {
    return join(this.artifactsDir, "catalog.json");
  }

  /** 会话事件流默认约定路径（不预创建——由 SessionLog 按需落盘）。 */
  public get sessionLogPath(): string {
    return join(this.rootDir, SESSION_LOG_FILENAME);
  }

  /**
   * T0 自由区写入：路径须为 scratch/ 内的相对路径（绝对路径 / 越界 = err，防逃逸）。
   * T0 是晋升前的自由区，允许覆盖同路径；晋升后不可变语义由 T1（晋升闸）保证。
   */
  public async scratchWrite(
    relPath: string,
    content: string | Uint8Array,
  ): Promise<Result<{ path: string; bytes: number }, WorkspaceError>> {
    const guard = safeScratchPath(this.scratchDir, relPath);
    if (!guard.ok) return guard;
    const target = join(this.scratchDir, relPath);
    const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return ok({ path: target, bytes });
    } catch (cause) {
      return err(workspaceError("invalid_input", `scratch 写入失败: ${(cause as Error).message}`, {
        path: relPath,
        code: (cause as NodeJS.ErrnoException).code,
      }));
    }
  }

  /**
   * 登记复现命令到产物元数据 sidecar（owner 口径 #3：复现命令登记于产物元数据，
   * 晋升闸只负责执行 + 比对）。登记一次性：sidecar 已存在 = 拒绝覆盖；
   * 源产物不存在 = 拒绝登记（fail early，不带病进入晋升闸）。
   */
  public async registerReproduce(relPath: string, command: string[]): Promise<Result<{ metaPath: string }, WorkspaceError>> {
    const guard = safeScratchPath(this.scratchDir, relPath);
    if (!guard.ok) return guard;
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => !isNonEmptyString(part))) {
      return err(workspaceError("invalid_input", "复现命令非法（须为非空 argv 数组，元素均为非空字符串）", { command }));
    }
    try {
      await stat(join(this.scratchDir, relPath));
    } catch {
      return err(workspaceError("invalid_input", `源产物不存在，拒绝登记复现命令: ${relPath}`, { path: relPath }));
    }
    const metaPath = join(this.scratchDir, `${relPath}${REPRODUCE_META_SUFFIX}`);
    try {
      await stat(metaPath);
      return err(workspaceError("invalid_input", `复现命令已登记（登记一次性，拒绝覆盖）: ${relPath}`));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        return err(workspaceError("invalid_input", `sidecar 状态检查失败: ${(cause as Error).message}`));
      }
    }
    const meta: ReproduceMeta = {
      artifact: relPath,
      reproduce: { command: [...command] },
      registered_at: this.now(),
    };
    try {
      await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
      return ok({ metaPath });
    } catch (cause) {
      return err(workspaceError("invalid_input", `sidecar 写入失败: ${(cause as Error).message}`, { path: relPath }));
    }
  }

  /** 工作区状态查询（T2 只读展示）。catalog 读入损坏 = err（fail-closed，不带病报告）。 */
  public async status(): Promise<Result<WorkspaceStatus, WorkspaceError>> {
    const provenance = await this.readProvenance();
    if (!provenance.ok) return provenance;
    const catalog = await loadCatalog(this.catalogPath);
    if (!catalog.ok) return catalog;
    const scratchEntries = await countEntries(this.scratchDir);
    if (!scratchEntries.ok) return scratchEntries;
    const artifactFiles = await countEntries(this.artifactsDir, CATALOG_FILENAME);
    if (!artifactFiles.ok) return artifactFiles;
    const contractsEntries = await countEntries(this.contractsDir);
    if (!contractsEntries.ok) return contractsEntries;
    let sessionLogExists = false;
    try {
      await stat(this.sessionLogPath);
      sessionLogExists = true;
    } catch {
      sessionLogExists = false;
    }
    return ok({
      run_id: provenance.value.run_id,
      scratch: { entry_count: scratchEntries.value },
      artifacts: { catalog_count: catalog.value.artifacts.length, file_count: artifactFiles.value },
      contracts: { exists: true, entry_count: contractsEntries.value },
      session_log: { exists: sessionLogExists },
    });
  }

  // ------------------------------------------------------------------ 内部

  /** provenance 生成/校验（workspace.contract.yaml run_dir.provenance.rules）。 */
  private async ensureProvenance(input: ProvenanceInput): Promise<Result<{ run_id: string }, WorkspaceError>> {
    const provenancePath = join(this.scratchDir, PROVENANCE_FILENAME);
    let existing: string | null;
    try {
      existing = await readFile(provenancePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        return err(workspaceError("provenance_conflict", `provenance 读取失败: ${(cause as Error).message}`, {
          code: (cause as NodeJS.ErrnoException).code,
        }));
      }
      existing = null;
    }
    if (existing !== null) {
      // 重开语义：形状非法或四元组不一致（created_at 以既有为准）一律 err，不猜测同源
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        return err(workspaceError("provenance_conflict", "provenance.json 非法 JSON（可能被篡改）"));
      }
      if (!isPlainObject(parsed)) {
        return err(workspaceError("provenance_conflict", "provenance.json 不是 JSON 对象"));
      }
      for (const field of ["run_id", "trigger_instruction", "model_id"] as const) {
        if (!isNonEmptyString(parsed[field])) {
          return err(workspaceError("provenance_conflict", `provenance.json 字段 ${field} 非法（须为非空字符串）`));
        }
      }
      if (!isIso8601(parsed["created_at"])) {
        return err(workspaceError("provenance_conflict", "provenance.json created_at 非法（须为可解析的 ISO 8601 时间串）"));
      }
      for (const field of ["run_id", "trigger_instruction", "model_id"] as const) {
        if (parsed[field] !== input[field]) {
          return err(workspaceError("provenance_conflict", `provenance.json ${field} 与本次创建输入不一致（重开语义 fail-closed）`, {
            existing: parsed[field],
            requested: input[field],
          }));
        }
      }
      return ok({ run_id: parsed["run_id"] as string });
    }
    const provenance = { ...input, created_at: this.now() };
    try {
      await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    } catch (cause) {
      return err(workspaceError("provenance_conflict", `provenance.json 写入失败: ${(cause as Error).message}`, {
        code: (cause as NodeJS.ErrnoException).code,
      }));
    }
    return ok({ run_id: input.run_id });
  }

  private async readProvenance(): Promise<Result<{ run_id: string }, WorkspaceError>> {
    try {
      const text = await readFile(join(this.scratchDir, PROVENANCE_FILENAME), "utf8");
      const parsed: unknown = JSON.parse(text);
      if (isPlainObject(parsed) && isNonEmptyString(parsed["run_id"])) {
        return ok({ run_id: parsed["run_id"] });
      }
      return err(workspaceError("provenance_conflict", "provenance.json run_id 非法"));
    } catch (cause) {
      return err(workspaceError("provenance_conflict", `provenance.json 读取失败: ${(cause as Error).message}`));
    }
  }
}

/**
 * 读取既有 provenance 四元组（L1a 门 2 resume 前置：重开语义的输入以既有文件为准，
 * RunWorkspace.create 内做逐字段等值校验）。文件缺失/非法 → err（fail-closed）。
 */
export const readRunProvenance = async (rootDir: string): Promise<Result<ProvenanceInput, WorkspaceError>> => {
  const provenancePath = join(rootDir, "scratch", PROVENANCE_FILENAME);
  let text: string;
  try {
    text = await readFile(provenancePath, "utf8");
  } catch (cause) {
    return err(workspaceError("provenance_conflict", `provenance.json 读取失败: ${(cause as Error).message}`, { path: provenancePath }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(workspaceError("provenance_conflict", "provenance.json 非法 JSON（可能被篡改）"));
  }
  if (!isPlainObject(parsed)) {
    return err(workspaceError("provenance_conflict", "provenance.json 不是 JSON 对象"));
  }
  for (const field of ["run_id", "trigger_instruction", "model_id"] as const) {
    if (!isNonEmptyString(parsed[field])) {
      return err(workspaceError("provenance_conflict", `provenance.json 字段 ${field} 非法（须为非空字符串）`));
    }
  }
  return ok({
    run_id: parsed["run_id"] as string,
    trigger_instruction: parsed["trigger_instruction"] as string,
    model_id: parsed["model_id"] as string,
  });
};

/**
 * scratch 相对路径守卫：绝对路径、含 ".." 逃逸、解析后落点越出 scratch/ 的路径一律拒绝。
 * 供 scratchWrite / registerReproduce / promote 共用（fail-closed：路径形态不合法即拒绝）。
 */
export const safeScratchPath = (
  scratchDir: string,
  relPath: string,
): Result<{ resolved: string }, WorkspaceError> => {
  if (!isNonEmptyString(relPath)) {
    return err(workspaceError("invalid_input", "路径非法（须为非空相对路径）", { path: relPath }));
  }
  if (isAbsolute(relPath)) {
    return err(workspaceError("invalid_input", "路径非法（拒绝绝对路径）", { path: relPath }));
  }
  const resolved = resolve(scratchDir, relPath);
  const rel = relative(scratchDir, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return err(workspaceError("invalid_input", "路径越界（解析后落点须在 scratch/ 内）", { path: relPath }));
  }
  return ok({ resolved });
};

/** 目录一级条目清点（T2 只读展示与 scratch/artifacts 计数；exclude 可排除登记簿等基建文件；不可读 = err）。 */
const countEntries = async (dir: string, exclude?: string): Promise<Result<number, WorkspaceError>> => {
  try {
    const entries = await readdir(dir);
    return ok(exclude === undefined ? entries.length : entries.filter((entry) => entry !== exclude).length);
  } catch (cause) {
    return err(workspaceError("invalid_input", `目录清点失败: ${(cause as Error).message}`, { dir }));
  }
};
