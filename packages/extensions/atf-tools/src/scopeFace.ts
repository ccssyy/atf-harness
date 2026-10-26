/**
 * 会话作用域解析面（D81-B——run 面读具缺省只看当前会话归属工作区）。
 *
 * 指令《ATF_指令_D81B_会话作用域隔离_20261023》§二（对表四产品会话隔离实现）：
 *
 * 1. 作用域键＝当前会话归属的工作区。归属解析序（两通道，皆无＝fail-closed）：
 *    ① 会话 cwd 向上逐级发现 `.atf/workspace.json`（workspace_id 单源，认领按 id 不按 path）；
 *    ② DSH 工作区注册表归属——vendor workspace 语义：会话 canonical cwd 与 record.path
 *      精确相等才归属（packages/workspace/workspace/src/entity.ts attachSession 同口径）。
 *    两通道皆无 → fail-closed 空＋「请先在 WebUI 添加工作区」指引，禁回落全局扫描。
 * 2. 本区 runs 子目录双布局兼容（沿用 RunLayout/v1 事实）：canonical `workspace/runs/`
 *    优先，legacy `runs/` 回退；皆不在场＝本区无 run（空，不猜测）。
 * 3. 真 run 识别：`run.json` 在场且可解析为 JSON 对象（canonical 身份锚，与 runLayout
 *    canonicalRunDirOf / atf-ui classifyRunRootEntries 同口径）∪ `launch_manifest.json`
 *    （顶层或 launch/ 下，legacy run 形态）。杂项目录/文件（bl.zip/bl_source 一类）永不入列。
 * 4. 跨任务显式通道：scope 参数（缺省 current）→ 走既有 approvalFace 审批（不另造通道）；
 *    输出分组标注「本任务／历史任务」；拒绝即零返回。
 *
 * 本模块为纯解析/枚举面：只读文件系统、零写盘；错误一律降级为 null/空（调用方折算
 * 为结构化回执），不 throw 穿过工具边界。
 */
import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  findRecordById,
  findRecordIdByPath,
  readRegistryFile,
  readWorkspaceIdentity,
  registryPathOf,
  resolveDshHome,
} from "../../../../src/core/workspace/workspaceRegistry.js";
import { flatRunDirNames } from "../../../../src/core/workspace/runLayout.js";
import { deriveRunEntry } from "../../../../src/webui/readOnlyTools.js";

/** 会话 cwd 取法（vendor ptc.ts 同款锚：exec.agent.session.header.cwd——会话创建时的
 *  绝对工作目录；取不到＝undefined，调用方 fail-closed）。 */
export const sessionCwdOfExec = (exec: unknown): string | undefined => {
  const cwd = (exec as { agent?: { session?: { header?: { cwd?: unknown } } } })?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
};

/** 已解析的会话归属工作区（workspace_id 单源＝身份文件；注册表通道身份文件缺失时以
 *  record.id 兜底——注册表 id 与身份 id 在 WebUI 正常流同源）。 */
export interface WorkspaceScope {
  /** 工作区根绝对路径（canonical）。 */
  root: string;
  /** 工作区身份 id（uuid 单源）。 */
  workspaceId: string;
  /** 归属通道（诊断/回执呈现用）。 */
  via: "identity_file" | "registry_path" | "registry_id";
}

/** 身份文件安全读取（缺席/损坏＝null——归属解析的降噪读，不抛）。 */
const readIdentitySafe = (workspacePath: string): { id: string } | null => {
  try {
    const identity = readWorkspaceIdentity(workspacePath);
    return identity !== null && identity.id !== "" ? { id: identity.id } : null;
  } catch {
    return null;
  }
};

/** canonical 目录起点（realpath 成功后：文件则从其父目录起，目录原样）。 */
const canonicalStartDir = (rawPath: string): string | null => {
  try {
    const resolved = realpathSync(rawPath);
    try {
      return statSync(resolved).isDirectory() ? resolved : dirname(resolved);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
};

/** 通道①：cwd 向上逐级发现 `.atf/workspace.json`（workspace_id 单源）。 */
const resolveByIdentityFileUpward = (startDir: string): WorkspaceScope | null => {
  let cur = startDir;
  for (;;) {
    const identity = readIdentitySafe(cur);
    if (identity !== null) return { root: cur, workspaceId: identity.id, via: "identity_file" };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
};

export interface ScopeResolveOptions {
  /** DSH 家（注册表解析根）；缺省 env DSH_HOME → ~/.dsh 解析链（与 vendor home-paths 一致）。 */
  dshHome?: string;
}

/** 会话归属解析单源（两通道；皆无＝null＝fail-closed）。 */
export const resolveSessionWorkspace = (cwd: string | undefined, opts?: ScopeResolveOptions): WorkspaceScope | null => {
  if (typeof cwd !== "string" || cwd === "") return null;
  const startDir = canonicalStartDir(cwd);
  if (startDir === null) return null;
  // 通道①：身份文件向上（workspace_id 单源——不依赖注册表在场）
  const byIdentity = resolveByIdentityFileUpward(startDir);
  if (byIdentity !== null) return byIdentity;
  // 通道②：DSH 注册表按 canonical cwd 归属（vendor 语义：realpath 与 record.path 精确相等）
  const dshHome = opts?.dshHome ?? resolveDshHome();
  const registry = readRegistryFileSafe(registryPathOf(dshHome));
  if (registry !== null) {
    const recordId = findRecordIdByPath(registry, startDir);
    if (recordId !== null) {
      const record = findRecordById(registry, recordId);
      const identity = record !== null ? readIdentitySafe(record.path) : null;
      return { root: record?.path ?? startDir, workspaceId: identity?.id ?? recordId, via: "registry_path" };
    }
  }
  return null;
};

/** 显式 scope 解析（跨任务通道：绝对路径 or 注册 id）。无效引用＝null（调用方给指路回执）。 */
export const resolveExplicitWorkspace = (ref: string, opts?: ScopeResolveOptions): WorkspaceScope | null => {
  if (typeof ref !== "string" || ref === "") return null;
  const dshHome = opts?.dshHome ?? resolveDshHome();
  if (isAbsolute(ref)) {
    const startDir = canonicalStartDir(ref);
    if (startDir === null) return null;
    const byIdentity = resolveByIdentityFileUpward(startDir);
    if (byIdentity !== null) return byIdentity;
    const registry = readRegistryFileSafe(registryPathOf(dshHome));
    if (registry !== null) {
      const recordId = findRecordIdByPath(registry, startDir);
      if (recordId !== null) {
        const record = findRecordById(registry, recordId);
        const identity = record !== null ? readIdentitySafe(record.path) : null;
        return { root: record?.path ?? startDir, workspaceId: identity?.id ?? recordId, via: "registry_path" };
      }
    }
    return null;
  }
  // 非绝对路径＝注册 id（认领按 id 不按 path）
  const registry = readRegistryFileSafe(registryPathOf(dshHome));
  if (registry === null) return null;
  const record = findRecordById(registry, ref);
  if (record === null || record.path === "") return null;
  const identity = readIdentitySafe(record.path);
  return { root: record.path, workspaceId: identity?.id ?? record.id, via: "registry_id" };
};

const readRegistryFileSafe = (registryPath: string): Record<string, unknown> | null => {
  try {
    return readRegistryFile(registryPath);
  } catch {
    return null; // 注册表损坏＝归属通道②不可用（降级，不炸工具）
  }
};

// ---------------------------------------------------------------- runs 布局与真 run 识别

/** 本工作区 runs 面根集合（RunLayout/v2 单源）：`<ws>/experiments/<exp>/runs` 全部命中，
 *  再追加 legacy 两桶（已废止的 v1 桶与 ADR-0005 旧桶，只读兼容）。皆不在场＝空数组。 */
export const workspaceRunDirs = (workspaceRoot: string): string[] => {
  const out: string[] = [];
  const experiments = join(workspaceRoot, "experiments");
  try {
    for (const entry of readdirSync(experiments, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const runs = join(experiments, entry.name, "runs");
      if (existsSync(runs)) out.push(runs);
    }
  } catch {
    // 无 experiments 目录＝纯 legacy 工作区
  }
  for (const legacy of [
    join(workspaceRoot, "workspace", "runs"), // legacy v1 桶（只读）
    join(workspaceRoot, "runs"), // legacy ADR-0005 桶（只读）
  ]) {
    if (existsSync(legacy)) out.push(legacy);
  }
  return out;
};

/** @deprecated v2 无单一 runs 根，改用 :func:`workspaceRunDirs`；本函数仅返回首个候选。 */
export const workspaceRunsDir = (workspaceRoot: string): string | null => {
  const dirs = workspaceRunDirs(workspaceRoot);
  return dirs.length > 0 ? dirs[0]! : null;
};

/** 真 run 识别（指令 §二.2）：run.json 在场且可解析为 JSON 对象（RunLayout/v1 身份锚）
 *  ∪ launch_manifest.json 在场（顶层或 launch/ 下——legacy run 形态）。杂项目录/文件
 *  （bl.zip/bl_source/png_mirror.py 一类）零特征不入列。 */
export const isTrueRunDir = (dir: string): boolean => {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return false;
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  if (entries.includes("launch_manifest.json") || entries.includes("run.json")) {
    // run.json 需可解析为 JSON 对象（与 canonicalRunDirOf 同口径）；manifest 在场即认
    if (entries.includes("run.json")) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  return entries.includes("launch") && existsSync(join(dir, "launch", "launch_manifest.json"));
};

/** runs 目录内真 run 枚举（一级目录＋真 run 判据过滤；条目结构与 readOnlyTools.listRuns
 *  同款——deriveRunEntry 复用单源，模型面消费结构不变）。 */
export const listTrueRuns = (runsDir: string, workspace: string | null): Array<Record<string, unknown>> => {
  let names: string[];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const runs: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const dir = join(runsDir, name);
    if (!isTrueRunDir(dir)) continue;
    runs.push(deriveRunEntry(dir, name, workspace));
  }
  return runs.sort((a, b) => String(a["run_id"]).localeCompare(String(b["run_id"])));
};

/** 全量枚举分组（scope=all 跨任务显式通道）：本任务组＝归属工作区 runs 子目录；
 *  历史任务组＝runs 根平铺层真 run＋runs 根下各工作区目录的 runs 子目录真 run
 *  （历史 run 原地保留——不迁移不拆分，指令 §二.5）。本区条目不重复入历史组。 */
export interface RunGroup {
  /** 分组标注（用户可见文案）。 */
  group: "本任务" | "历史任务";
  runs: Array<Record<string, unknown>>;
}

export const collectAllRunGroups = (runsRoot: string, current: WorkspaceScope | null): RunGroup[] => {
  // 本任务组（归属工作区 runs 子目录；双布局兼容）
  const currentRunsDir = current !== null ? workspaceRunsDir(current.root) : null;
  const currentRuns = currentRunsDir !== null && current !== null ? listTrueRuns(currentRunsDir, current.root) : [];
  // 历史任务组：runs 根平铺层（真 run 直接入组；本区工作区目录跳过——不与本任务组重复）
  const historical: Array<Record<string, unknown>> = [];
  for (const name of flatRunDirNames(runsRoot)) {
    const dir = join(runsRoot, name);
    if (current !== null && dir === current.root) continue;
    if (isTrueRunDir(dir)) {
      historical.push(deriveRunEntry(dir, name, null));
      continue;
    }
    // 非真 run 的一级目录 → 若为工作区形态（含 workspace/runs 或 runs 子目录）展开其内真 run
    const nestedRunsDir = workspaceRunsDir(dir);
    if (nestedRunsDir !== null) {
      historical.push(...listTrueRuns(nestedRunsDir, dir));
    }
  }
  return [
    { group: "本任务", runs: currentRuns },
    { group: "历史任务", runs: historical.sort((a, b) => String(a["run_id"]).localeCompare(String(b["run_id"]))) },
  ];
};

// ---------------------------------------------------------------- 回执文案（用户可见单源）

/** 归属缺失 fail-closed 指引（指令 §二.1——禁回落全局扫描）。 */
export const SCOPE_UNRESOLVED_NOTE =
  "当前会话未归属任何工作区（会话目录向上未发现 .atf/workspace.json，工作区注册表亦无本目录记录）——" +
  "请先在 WebUI「添加工作区」选择任务目录，再将会话开在该工作区目录内；缺省不返回全局扫描结果。";

/** 本区无 runs 子目录（归属成立但双布局皆缺）。 */
export const workspaceRunsDirMissingNote =
  "当前归属工作区内未发现 runs 目录（experiments/<exp>/runs 与历史两桶均不在场）——本工作区还没有任何 run。";

/** 越界指引（指令 §二.4——错误回流带「显式请求跨任务」指引）。 */
export const scopeOutOfWorkspaceNote =
  "该 run 不在当前会话归属的工作区内——如需跨任务查看，请显式传 scope:\"all\"（全量枚举，需用户审批），" +
  "或在 scope 中给出目标工作区的绝对路径／注册 id。";

/** scope 参数描述（工具面可发现性——缺省作用域与跨任务代价写明）。 */
export const SCOPE_PARAM_DESCRIPTION =
  "run 面作用域：缺省 current＝只看当前会话归属工作区内的 run（跨任务历史不出现）；" +
  "\"all\"＝跨任务全量枚举（本任务＋历史任务分组标注，需用户审批放行）；" +
  "也可给目标工作区的绝对路径或注册 id（同样需审批）。缺省不扫描全局。";
