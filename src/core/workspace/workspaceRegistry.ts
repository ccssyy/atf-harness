/**
 * 工作区注册表与身份面（目录结构 v1 两目录制）——确定性文件操作单源：
 *
 * - 工作区身份真相：`<工作区>/.atf/workspace.json`（id=uuid 不变＋name=slug＋实验索引）；
 * - DSH 注册表：`<DSH_HOME>/storages/workspace.json`（unit v2——运行时侧栏/归属唯一读写面，
 *   本模块把它当标准接口做 schema 忠实的定向更新：按 id 定位、只改授权字段、写前备份、
 *   原子落盘；其他 record 零触碰）；
 * - 会话桶：`<DSH_HOME>/sessions/<projectKey(cwd)>/`——路径→桶名编码单源（与 vendor
 *   projectKey 同构）；会话桶本身零操作（vendor 存储层按会话头 cwd 做桶名同一性断言，
 *   挪桶即碎——既有会话归属由头 cwd 的 realpath 正典承载，见 rebindWorkspaceToPath 注）。
 *
 * 运行时一致性注记：DSH 进程对注册表是 open 时一次载入、内存权威、写时全量回写
 * （vendor storage-json single-unit 语义）——本模块的注册表写入在进程外落盘后，须等
 * 实例重启才进入运行时视野；调用方（工具层）在回执里如实携带该语义，运维序列把
 * rebind 与实例重启合并执行。
 *
 * 全部函数确定性、无 LLM 参与；错误以异常抛出（字符串消息面向模型回流），由工具
 * handler 层折算为结构化 rejected（invalid_params／指路文案）。
 */
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** 实验名 slug 闭集（小写字母/数字开头，[a-z0-9-] 组成）。 */
export const EXPERIMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 工作区身份文件（.atf/workspace.json）冻结结构。 */
export interface WorkspaceIdentity {
  /** 工作区 id——**已退役**（2026-11-23）：权威 id 是 vendor 注册表的 record key。
   *  旧身份文件带此字段时读得出（兼容），新写入不再产生。 */
  id?: string;
  name: string;
  experiments: ExperimentIndexEntry[];
  createdAt: string;
}

/** 实验索引条目（身份文件 experiments[] 数组元素）。 */
export interface ExperimentIndexEntry {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
}

/** experiment.json 冻结结构。 */
export interface ExperimentMeta {
  id: string;
  name: string;
  createdAt: string;
  workspaceId: string;
  datasets: unknown[];
  baseline: null;
}

/** DSH 注册表定向更新后的 record 形状（本模块只消费/产出这些字段，未知字段原样保留）。 */
export interface RegistryRecordView {
  id: string;
  path: string;
  title: string;
  sessionIds: string[];
}

/** DSH 家解析：显式注入 ＞ DSH_HOME env ＞ ~/.dsh（与 vendor home-paths 缺省一致——
 *  写入方必须对齐读取方（DSH 运行时）的真实解析链，不以部署层软链别名另立缺省）。 */
export const resolveDshHome = (env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string =>
  env["DSH_HOME"] !== undefined && env["DSH_HOME"] !== "" ? env["DSH_HOME"] : join(home, ".dsh");

/** 注册表文件路径（DSH 家下 storages/workspace.json）。 */
export const registryPathOf = (dshHome: string): string => join(dshHome, "storages", "workspace.json");

/** 会话桶根（DSH 家下 sessions/）。 */
export const sessionsRootOf = (dshHome: string): string => join(dshHome, "sessions");

/** 路径 → 会话桶名编码（实证单源，dev 家实锚两例：`data/sam`→`--data-sam--`、
 *  `tmp/b18-ws`→`--tmp-b18-ws--`；
 *  规则＝去首斜杠＋斜杠折 '-'＋双侧 '--' 包裹）。仅接受绝对路径。 */
export const bucketNameForWorkspacePath = (workspacePath: string): string => {
  if (!isAbsolute(workspacePath)) throw new Error(`会话桶编码仅接受绝对路径: ${workspacePath}`);
  const stripped = workspacePath.replace(/\/+$/, "");
  const body = stripped.startsWith("/") ? stripped.slice(1) : stripped;
  return `--${body.replaceAll("/", "-")}--`;
};

/** 注册表文件读取（缺席＝null；解析失败如实抛——不猜测空形态）。 */
export const readRegistryFile = (registryPath: string): Record<string, unknown> | null => {
  if (!existsSync(registryPath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`注册表文件形态异常（非对象）: ${registryPath}`);
  return parsed as Record<string, unknown>;
};

const registryWorkspacesTable = (registry: Record<string, unknown>): Record<string, Record<string, unknown>> => {
  const tables = registry["tables"];
  if (typeof tables !== "object" || tables === null) throw new Error("注册表缺 tables 段（形态异常）");
  const workspaces = (tables as Record<string, unknown>)["workspaces"];
  if (typeof workspaces !== "object" || workspaces === null) throw new Error("注册表缺 tables.workspaces 段（形态异常）");
  return workspaces as Record<string, Record<string, unknown>>;
};

/** 按 id 取注册表 record（id 永不改变——认领单源）。 */
export const findRecordById = (registry: Record<string, unknown>, id: string): RegistryRecordView | null => {
  const raw = registryWorkspacesTable(registry)[id];
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    id,
    path: typeof record["path"] === "string" ? record["path"] : "",
    title: typeof record["title"] === "string" ? record["title"] : "",
    sessionIds: Array.isArray(record["sessionIds"]) ? (record["sessionIds"] as string[]) : [],
  };
};

/** 按 canonical path 找注册表 record id（ realpath 相等判定；未注册＝null）。 */
export const findRecordIdByPath = (registry: Record<string, unknown>, canonicalPath: string): string | null => {
  for (const [id, raw] of Object.entries(registryWorkspacesTable(registry))) {
    if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>)["path"] === canonicalPath) return id;
  }
  return null;
};

/** 注册表定向写回（写前备份＋原子落盘）：只换按 id 定位的 record 的 path/updatedAt，
 *  其余 record 与全局段逐字节保留（JSON 全文重序化——键序沿既有对象序）。 */
export const updateRegistryRecordPath = (registryPath: string, id: string, nextPath: string, now: string): void => {
  const registry = readRegistryFile(registryPath);
  if (registry === null) throw new Error(`注册表不存在: ${registryPath}`);
  const table = registryWorkspacesTable(registry);
  const record = table[id];
  if (typeof record !== "object" || record === null) throw new Error(`注册表无 id 记录: ${id}`);
  // 写前备份（红线：注册表写入前备份——同刻时间戳后缀，写失败时备份在位可手工回滚）
  // 序列化形态对齐 vendor 落盘（2 空格缩进＋尾换行——diff 最小化）。
  const backupPath = `${registryPath}.bak-${now.replace(/[:.]/g, "-")}`;
  writeFileSync(backupPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  const updated: Record<string, unknown> = { ...record, path: nextPath, updatedAt: now };
  table[id] = updated;
  const tmpPath = `${registryPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
};

/** 身份文件读取（缺席＝null）。 */
export const readWorkspaceIdentity = (workspacePath: string): WorkspaceIdentity | null => {
  const identityPath = join(workspacePath, ".atf", "workspace.json");
  if (!existsSync(identityPath)) return null;
  const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as Partial<WorkspaceIdentity>;
  // id 不再是身份文件的必填字段（2026-11-23）：工作区权威 id 来自 vendor
  // `ctx.workspaceRegistry`（storages/workspace.json 的 record key）。身份文件
  // 只保留「实验索引」这一项 vendor 无对应的领域数据。旧文件带 id 仍读得出来
  // （兼容），但新写入不再产生。
  return {
    id: typeof parsed.id === "string" ? parsed.id : "",
    name: typeof parsed.name === "string" ? parsed.name : "",
    experiments: Array.isArray(parsed.experiments) ? (parsed.experiments as ExperimentIndexEntry[]) : [],
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
  };
};

/**
 * 实验目录名（＝实验名裸名）。
 *
 * 轮三单源化实锚：此前 UI 建实验用「YYYYMMDD-<name>」+「runs/」中间层（v2 形态），
 * 内核管线 RunLayout/v3 用裸名且 run 直挂实验目录——同名实验经两个入口落两个目录
 * （真机：20261107-ci-bl-joint/ 与 ci-bl-joint/ 并存）。实验目录形态唯一权威＝内核
 * v3：UI 建实验不再自造日期前缀与 runs 层；已建的历史形态目录只读兼容不迁移。
 */
export const experimentDirName = (_now: Date, name: string): string => name;

/** 按 canonical 路径查 vendor 注册表的 record key（工作区权威 id）。
 *
 * 为什么按路径查而不是读身份文件：vendor `ctx.workspaceRegistry` 的 id 才是
 * 侧栏/会话归属的唯一真相；身份文件的 id 是重复来源，已停止写入。
 * 未注册时返回 null——调用方以 `registryStatus: pending_registration` 指示用户。
 */
const resolveVendorWorkspaceId = (canonicalPath: string, dshHome: string | undefined): string | null => {
  const registry = readRegistryFile(registryPathOf(dshHome ?? resolveDshHome()));
  return registry === null ? null : findRecordIdByPath(registry, canonicalPath);
};

export interface CreateExperimentOutcome {
  workspacePath: string;
  workspaceId: string;
  workspaceName: string;
  experimentDir: string;
  experimentId: string;
  experimentName: string;
  createdAt: string;
  experimentsCount: number;
  identityCreated: boolean;
  registryStatus: "already_registered" | "pending_registration";
}

/**
 * 建实验（确定性五步：身份初始化→实验目录＋元数据＋runs→索引追加→注册表判定→摘要）。
 * 不代建顶层目录（workspacePath 不存在/非目录即抛）；不代建 DSH 注册表记录（未注册＝
 * pending_registration 回执，由用户在 WebUI 添加工作区建立记录）。dshHome 显式注入
 * （装配面/host.dshHome）优先于 env 解析——注册表判定与 rebind 同一取值链。
 */
export const createExperimentInWorkspace = (workspacePath: string, experimentName: string, now: Date, dshHome?: string): CreateExperimentOutcome => {
  if (!isAbsolute(workspacePath)) {
    throw new Error(`workspace_path 须为绝对路径（得 ${workspacePath}）——工作区是用户任意位置创建的目录`);
  }
  if (!EXPERIMENT_NAME_PATTERN.test(experimentName)) {
    throw new Error(`experiment_name 须为 slug 形态（[a-z0-9][a-z0-9-]*，得 ${experimentName}）——小写字母或数字开头，仅含小写字母/数字/连字符`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(workspacePath);
  } catch {
    throw new Error(
      `工作区路径不存在: ${workspacePath}——请先创建目录（mkdir -p）后重试；本工具不代建顶层工作区目录`,
    );
  }
  const st = statSync(canonical);
  if (!st.isDirectory()) {
    throw new Error(`工作区路径不是目录: ${canonical}——请给目录路径，不给文件路径`);
  }

  const createdAt = now.toISOString();
  const identityPath = join(canonical, ".atf", "workspace.json");
  const identityExists = existsSync(identityPath);
  let identity: WorkspaceIdentity;
  if (identityExists) {
    identity = readWorkspaceIdentity(canonical) as WorkspaceIdentity;
  } else {
    // D170:身份文件缺席时先按路径收编注册表正典 id——不自造 uuid（自造会让
    // rebind 按 id 查注册表必然落空，web 重启后的会话绑定恢复链断）。
    let adoptedId: string | null = null;
    try {
      const registry = readRegistryFile(registryPathOf(dshHome ?? resolveDshHome()));
      if (registry !== null) {
        for (const [recordId, record] of Object.entries(registryWorkspacesTable(registry))) {
          if (String(record["path"] ?? "") === canonical) {
            adoptedId = recordId;
            break;
          }
        }
      }
    } catch {
      // 注册表缺席/形态异常按无记录处理——维持自造路径（与既有行为一致）
    }
    // 身份文件不再写 id（工作区权威 id 由 vendor 注册表持有）；
    // 实验索引是 vendor 无对应的领域数据，留在这里。
    identity = {
      name: basenameOf(canonical),
      experiments: [],
      createdAt,
    };
    mkdirSync(dirname(identityPath), { recursive: true });
    writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\n", { mode: 0o644 });
  }

  const dirName = experimentDirName(now, experimentName);
  const experimentDir = join(canonical, "experiments", dirName);
  if (existsSync(experimentDir)) {
    throw new Error(
      `重名实验: experiments/${dirName} 已存在——请换一个 experiment_name，或先清理同名目录后再建`,
    );
  }
  const experimentId = randomUUID();
  mkdirSync(experimentDir, { recursive: true });
  // RunLayout/v3：run 直挂实验目录，不建 runs/ 中间层（见 experimentDirName 单源注记）。
  const meta: ExperimentMeta = {
    id: experimentId,
    name: experimentName,
    createdAt,
    // workspaceId 取 vendor 注册表 record key（按 canonical 路径查）；未注册时留空，
    // 由 registryStatus=pending_registration 指示用户去 WebUI 添加。
    workspaceId: resolveVendorWorkspaceId(canonical, dshHome) ?? "",
    datasets: [],
    baseline: null,
  };
  writeFileSync(join(experimentDir, "experiment.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o644 });

  identity.experiments.push({ id: experimentId, name: experimentName, dir: dirName, createdAt });
  writeFileSync(identityPath, JSON.stringify(identity, null, 2) + "\n", { mode: 0o644 });

  const registryPath = registryPathOf(dshHome ?? resolveDshHome());
  const registry = readRegistryFile(registryPath);
  const registryStatus: CreateExperimentOutcome["registryStatus"] =
    registry !== null && findRecordIdByPath(registry, canonical) !== null ? "already_registered" : "pending_registration";

  return {
    workspacePath: canonical,
    workspaceId: resolveVendorWorkspaceId(canonical, dshHome) ?? identity.id ?? "",
    workspaceName: identity.name,
    experimentDir,
    experimentId,
    experimentName,
    createdAt,
    experimentsCount: identity.experiments.length,
    identityCreated: !identityExists,
    registryStatus,
  };
};

const basenameOf = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};



const lstatSyncSafe = (p: string): ReturnType<typeof lstatSync> | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

/** 注册表 record 清单＋目录在位状态（atf-ui 目录丢失呈现面——只读）。 */
export const listRegistryRecords = (dshHome: string): Array<RegistryRecordView & { exists: boolean }> => {
  const registry = readRegistryFile(registryPathOf(dshHome));
  if (registry === null) return [];
  const out: Array<RegistryRecordView & { exists: boolean }> = [];
  for (const [id, raw] of Object.entries(registryWorkspacesTable(registry))) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const path = typeof record["path"] === "string" ? record["path"] : "";
    if (path === "") continue;
    let exists = false;
    try {
      exists = statSync(resolve(path)).isDirectory();
    } catch {
      exists = false;
    }
    out.push({
      id,
      path,
      title: typeof record["title"] === "string" ? record["title"] : "",
      sessionIds: Array.isArray(record["sessionIds"]) ? (record["sessionIds"] as string[]) : [],
      exists,
    });
  }
  return out;
};

/** 注册工作区根清单（存在于本机者）——`resolveRunDir` canonical 档的注入源。
 *
 *  RunLayout/v3 canonical run 住在 `<ws>/experiments/<exp>/<run_id>`，故凡是要按 run_id
 *  定位 run 的调用点都必须带本清单（缺省＝只查平铺/桶＝落到 legacy 桶，webui 落错树即由此来）。
 *  只读探测（stat 级），与 listRegistryRecords 同源同口径；dshHome 缺省按 resolveDshHome() 解析。
 */
export const registeredWorkspaceRoots = (dshHome?: string): string[] => {
  // vendor 源在场（装配期注入）→ 直接取投影，不解析存储文件。
  if (workspaceSource !== null) {
    return workspaceSource.list().map((workspace) => workspace.path);
  }
  // 回落：文件解析（测试/纯函数调用/未注入场景，行为逐位不变）。
  return listRegistryRecords(dshHome ?? resolveDshHome())
    .filter((record) => record.exists)
    .map((record) => record.path);
};


/** 默认工作区（B3/D-1、D-4）：未指定工作区的会话的确定落点。
 *
 *  位置 ``<ATF_HOME>/default-workspace``（内部实现名）；**UI 呈现为「任务」分组**
 *  ——与具名工作区分组并列，语义对齐「不绑定具体工作区的会话集合」，不展示路径。
 */
export const DEFAULT_WORKSPACE_DIRNAME = "default-workspace";
export const DEFAULT_WORKSPACE_TITLE = "任务";

/** 默认工作区绝对路径＝``<DSH_HOME>/default-workspace``。
 *
 *  **必须与 DSH 的 session cwd 解析同根**：DSH 把工作区 path 当作会话 cwd 的
 *  唯一真相，登记路径与它解析出的路径不一致时会 ``workspace-attach-failed``。
 *  实例化部署里 DSH_HOME 是实例目录（与 ``$HOME/.atf`` 不同），
 *  不等于 ``$HOME/.atf``——早期按 ATF 家目录落位正是 attach 失败的成因。
 */
export const defaultWorkspacePathOf = (dshHome: string): string =>
  join(dshHome, DEFAULT_WORKSPACE_DIRNAME);

export interface EnsureDefaultWorkspaceOutcome {
  /** 默认工作区绝对路径。 */
  path: string;
  /** 身份 id（uuid，永不改变）。 */
  id: string;
  /** 本次是否新建了目录/身份文件。 */
  created: boolean;
  /** 注册表处置：已登记／本次登记／呈现名已迁移／注册表缺失。 */
  registryStatus: "already_registered" | "registered" | "title_updated" | "registry_missing";
  /** 本次登记是否要等实例重启才进入运行时视野。 */
  restartRequired: boolean;
}

/** vendor 工作区注册表端口（`ctx.workspaceRegistry` 的结构子集）。
 *
 * 为什么走端口而非直接 ctx：本文件是纯函数模块（可单测、无 ctx 依赖），
 * 端口由装配方注入；未注入时回落文件写入（测试/无 vendor 场景）。
 *
 * 语义差异：vendor `create(path, title)` **幂等**（同 canonical path 返回
 * 已有实体、不改 title）；`rename` 改的是 title 不是 path。故：
 * - 登记新记录 → `create`
 * - title 迁移 → `rename`（vendor 的 rename 语义就是改 title）
 * - path 迁移 → **vendor 无对应能力**（明写 immutable），已随 rebind 退役放弃
 */
export interface WorkspaceRegistryPort {
  create(path: string, title?: string): Promise<{ readonly id: string; readonly path: string; readonly title: string }>;
  rename?(id: string, title: string): Promise<unknown>;
}

let workspaceRegistryPort: WorkspaceRegistryPort | null = null;

/** 装配期注入 vendor 注册表端口（null 撤销→回落文件写入）。 */
export const setWorkspaceRegistryPort = (port: WorkspaceRegistryPort | null): void => {
  workspaceRegistryPort = port;
};

/** 当前是否走 vendor 端口（诊断/测试用）。 */
export const workspaceRegistryPortKind = (): "vendor" | "file" =>
  workspaceRegistryPort === null ? "file" : "vendor";

/** 注册表追加 record（写前备份＋tmp 原子落盘；global.workspaceIds 同步追加）。
 *  与 updateRegistryRecordPath 同一落盘纪律（2 空格缩进＋尾换行，diff 最小）。 */
export const appendRegistryRecord = (
  registryPath: string,
  registry: Record<string, unknown>,
  rec: { id: string; path: string; title: string; now: string },
): void => {
  const table = registryWorkspacesTable(registry);
  if (typeof table[rec.id] === "object" && table[rec.id] !== null) return;
  const backupPath = `${registryPath}.bak-${rec.now.replace(/[:.]/g, "-")}`;
  writeFileSync(backupPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  table[rec.id] = {
    id: rec.id,
    path: rec.path,
    title: rec.title,
    sessionIds: [],
    createdAt: rec.now,
    updatedAt: rec.now,
  };
  const globalRaw = registry["global"];
  if (typeof globalRaw === "object" && globalRaw !== null) {
    const global = globalRaw as Record<string, unknown>;
    const ids = Array.isArray(global["workspaceIds"]) ? (global["workspaceIds"] as string[]) : [];
    if (!ids.includes(rec.id)) global["workspaceIds"] = [...ids, rec.id];
  }
  const tmpPath = `${registryPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
};

/** 注册表 record 呈现名定向更新（写前备份＋tmp 原子落盘，其余字段与 record 原样保留）。
 *  用途：默认工作区的 UI 名从旧呈现名迁移到当前常量（一次即幂等）。 */
export const updateRegistryRecordTitle = (
  registryPath: string,
  id: string,
  nextTitle: string,
  now: string,
): void => {
  const registry = readRegistryFile(registryPath);
  if (registry === null) throw new Error(`注册表不存在: ${registryPath}`);
  const table = registryWorkspacesTable(registry);
  const record = table[id];
  if (typeof record !== "object" || record === null) throw new Error(`注册表无 id 记录: ${id}`);
  const backupPath = `${registryPath}.bak-${now.replace(/[:.]/g, "-")}`;
  writeFileSync(backupPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  table[id] = { ...(record as Record<string, unknown>), title: nextTitle, updatedAt: now };
  const tmpPath = `${registryPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, registryPath);
};

/** 确保默认工作区存在并登记（幂等；纯本地文件面，零网络）。
 *
 *  行为：①建 ``datasets/ splits/ experiments/`` 三桶；②缺身份文件则生成
 *  （id 由调用方注入，便于测试确定性）；③注册表未含该路径则追加 record
 *  （title=「任务」），已含则仅校验呈现名；④注册表文件本身缺失时如实返回
 *  ``registry_missing``（与 atf_create_workspace 同口径：不代建注册表）。
 *
 *  :param opts.atfHome: ATF 家目录（``~/.atf``）。
 *  :param opts.dshHome: DSH 家目录（注册表根）。
 *  :param opts.now: ISO 时刻（注入以便测试确定性）。
 *  :param opts.newId: id 生成器（缺省 uuid v4）。
 *  :return: 处置结果（含是否需重启生效）。
 */
export const ensureDefaultWorkspace = (opts: {
  dshHome: string;
  now: string;
  /** 旧落点（``~/.atf``）：仅用于把早期按 ATF 家目录登记的默认工作区迁到 DSH 根。 */
  legacyAtfHome?: string;
  newId?: () => string;
}): EnsureDefaultWorkspaceOutcome => {
  const wsPath = defaultWorkspacePathOf(opts.dshHome);
  let created = false;
  // 旧落点迁移（一次即幂等）：早期把默认工作区登记在 ``<ATF_HOME>/default-workspace``,
  // 而 DSH 的 session cwd 解析以 DSH_HOME 为根 → 登记路径与解析路径不一致会 attach 失败。
  // 处置：目录搬到 DSH 根（跨设备用 cpSync），注册表 path 同步改写；旧目录不删（只读留证）。
  if (opts.legacyAtfHome) {
    const legacyPath = join(opts.legacyAtfHome, DEFAULT_WORKSPACE_DIRNAME);
    const legacyRegistry = readRegistryFile(registryPathOf(opts.dshHome));
    const staleId = legacyRegistry !== null ? findRecordIdByPath(legacyRegistry, legacyPath) : null;
    if (staleId !== null && existsSync(legacyPath)) {
      if (!existsSync(wsPath)) {
        try {
          renameSync(legacyPath, wsPath);
        } catch {
          // 跨设备(EXDEV)等：递归复制后保留源目录（不删,留作只读证据）
          cpSync(legacyPath, wsPath, { recursive: true });
        }
        created = true;
      }
      updateRegistryRecordPath(registryPathOf(opts.dshHome), staleId, wsPath, opts.now);
    }
  }
  for (const sub of ["datasets", "splits", "experiments"]) {
    const dir = join(wsPath, sub);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
  }
  let identity = readWorkspaceIdentity(wsPath);
  if (identity === null) {
    const id = (opts.newId ?? (() => randomUUID()))();
    identity = { id, name: "default", experiments: [], createdAt: opts.now };
    const metaDir = join(wsPath, ".atf");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "workspace.json"), JSON.stringify(identity, null, 2) + "\n", "utf8");
    created = true;
  }
  const registryPath = registryPathOf(opts.dshHome);
  const registry = readRegistryFile(registryPath);
  if (registry === null) {
    return { path: wsPath, id: identity.id ?? "", created, registryStatus: "registry_missing", restartRequired: false };
  }
  const existingId = findRecordIdByPath(registry, wsPath);
  if (existingId !== null) {
    const existing = findRecordById(registry, existingId);
    if (existing !== null && existing.title !== DEFAULT_WORKSPACE_TITLE) {
      // 呈现名迁移（旧记录仍是旧名时一次性改写；幂等,二次进 already 分支）
      // vendor 端口在场走 `rename`（vendor 的 rename 语义正是改 title）；否则回落文件写入。
      if (workspaceRegistryPort !== null && typeof workspaceRegistryPort.rename === "function") {
        void workspaceRegistryPort.rename(existingId, DEFAULT_WORKSPACE_TITLE).catch((cause: unknown) => {
          console.warn(`[workspace-registry] vendor rename 失败（回落文件写入）：${cause instanceof Error ? cause.message : String(cause)}`);
          updateRegistryRecordTitle(registryPath, existingId, DEFAULT_WORKSPACE_TITLE, opts.now);
        });
      } else {
        updateRegistryRecordTitle(registryPath, existingId, DEFAULT_WORKSPACE_TITLE, opts.now);
      }
      return {
        path: wsPath, id: identity.id ?? "", created,
        registryStatus: "title_updated", restartRequired: true,
      };
    }
    return { path: wsPath, id: identity.id ?? "", created, registryStatus: "already_registered", restartRequired: false };
  }
  // vendor 端口在场走 `create`（幂等：同 canonical path 返回已有实体）；
  // 否则回落文件写入（测试/无 vendor 场景，行为逐位不变）。
  if (workspaceRegistryPort !== null) {
    void workspaceRegistryPort.create(wsPath, DEFAULT_WORKSPACE_TITLE).catch((cause: unknown) => {
      console.warn(`[workspace-registry] vendor create 失败（回落文件写入）：${cause instanceof Error ? cause.message : String(cause)}`);
      appendRegistryRecord(registryPath, registry, {
        // 回落路径（无 vendor 端口）：id 就地生成——注意这会与 vendor 的 id 不同源，
        // 仅用于测试/无 vendor 场景，生产路径恒走 vendor create。
        id: identity.id ?? randomUUID(),
        path: wsPath,
        title: DEFAULT_WORKSPACE_TITLE,
        now: opts.now,
      });
    });
  } else {
    appendRegistryRecord(registryPath, registry, {
      id: identity.id ?? randomUUID(),
      path: wsPath,
      title: DEFAULT_WORKSPACE_TITLE,
      now: opts.now,
    });
  }
  return { path: wsPath, id: identity.id ?? "", created, registryStatus: "registered", restartRequired: true };
};


export interface EnsureExperimentMetaOutcome {
  /** 本次是否补写了 experiment.json。 */
  written: boolean;
  /** 实验 id。 */
  experimentId: string;
  /** 实验名（＝目录名，adhoc 形态为 `<YYYYMMDD>-adhoc`）。 */
  experimentName: string;
}

/** 补齐单个实验的元数据（B3）：内核 adhoc 实验只建目录、不写 experiment.json，
 *  本函数按「工作区身份」单源补写 experiment.json 与身份索引 experiments[]；
 *  已存在则不触碰（幂等，只补缺不覆写）。
 *
 *  displayName 不落盘：`<YYYYMMDD>-adhoc` → 「未命名实验」的映射属 UI 呈现，
 *  避免把展示文案钉进数据文件。
 *
 *  :param workspacePath: 工作区根（须有 .atf/workspace.json）。
 *  :param dirName: 实验目录名（`experiments/` 下一级）。
 *  :param now: 注入时刻（写 createdAt 用）。
 *  :param newId: id 生成器（缺省 uuid v4，注入以便测试确定性）。
 *  :return: 补写结果。
 */
export const ensureExperimentMeta = (
  workspacePath: string,
  dirName: string,
  now: Date,
  newId?: () => string,
): EnsureExperimentMetaOutcome => {
  const experimentDir = join(workspacePath, "experiments", dirName);
  if (!existsSync(experimentDir)) throw new Error(`实验目录不存在: ${experimentDir}`);
  const identity = readWorkspaceIdentity(workspacePath);
  if (identity === null) throw new Error(`工作区缺身份文件: ${join(workspacePath, ".atf", "workspace.json")}`);
  const metaPath = join(experimentDir, "experiment.json");
  const createdAt = now.toISOString();
  const patchIndex = (id: string, name: string): void => {
    if (identity.experiments.some((entry) => entry.dir === dirName)) return;
    identity.experiments.push({ id, name, dir: dirName, createdAt });
    writeFileSync(join(workspacePath, ".atf", "workspace.json"),
      JSON.stringify(identity, null, 2) + "\n", { mode: 0o644 });
  };
  if (existsSync(metaPath)) {
    const existing = JSON.parse(readFileSync(metaPath, "utf8")) as ExperimentMeta;
    patchIndex(existing.id, existing.name);
    return { written: false, experimentId: existing.id, experimentName: existing.name };
  }
  const experimentId = (newId ?? (() => randomUUID()))();
  const meta: ExperimentMeta = {
    id: experimentId,
    name: dirName,
    createdAt,
    // 同 createExperimentInWorkspace：workspaceId 取 vendor 注册表 record key。
    workspaceId: resolveVendorWorkspaceId(workspacePath, undefined) ?? identity.id ?? "",
    datasets: [],
    baseline: null,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o644 });
  patchIndex(experimentId, dirName);
  return { written: true, experimentId, experimentName: dirName };
};

/** 给工作区内所有缺元数据的实验补写（boot 期自愈；零改动时返回 0）。 */
export const syncWorkspaceExperiments = (
  workspacePath: string,
  now: Date,
  newId?: () => string,
): number => {
  const experimentsDir = join(workspacePath, "experiments");
  if (!existsSync(experimentsDir)) return 0;
  let patched = 0;
  for (const entry of readdirSync(experimentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const outcome = ensureExperimentMeta(workspacePath, entry.name, now, newId);
    if (outcome.written) patched += 1;
  }
  return patched;
};


// ── vendor `ctx.workspaces` 适配（2026-11-23 owner 裁决 A）────────────────────
// 背景：本文件的读存储部分（readRegistryFile / listRegistryRecords / registryPathOf）
// 是在直接解析 vendor 写的 `<DSH_HOME>/storages/workspace.json`——那是重复实现。
// 正解是 `ctx.workspaces.list()`（vendor 提供的同步投影，返回 Workspace[]，带 path/title）。
//
// 过渡策略（不一次断链）：
// - 装配期由宿主调用 `setWorkspaceRegistrySource(ctx.workspaces)` 注入 vendor 服务；
// - 未注入时（测试、纯函数调用、vendor 未挂）回落到文件解析——行为逐位不变；
// - 注入后 `registeredWorkspaceRoots` / `listRegistryRecords` 优先走 vendor。
//
// 边界：vendor 的 list() 只给"已注册工作区"（含不存在的——它还带 path）；
// 本文件既有的 `exists` 探测（stat 级）保留在文件路径上，vendor 分支不复制该探测。

/** vendor `ctx.workspaces` 的结构子集（不 import vendor 包，避免包解析耦合）。 */
export interface WorkspaceRegistrySource {
  list(): ReadonlyArray<{ readonly path: string; readonly title?: string }>;
}

let workspaceSource: WorkspaceRegistrySource | null = null;

/** 装配期注入 vendor 工作区服务（idempotent；传 null 撤销）。 */
export const setWorkspaceRegistrySource = (source: WorkspaceRegistrySource | null): void => {
  workspaceSource = source;
};

/** 当前是否走 vendor 源（诊断/测试用）。 */
export const workspaceRegistrySourceKind = (): "vendor" | "file" =>
  workspaceSource === null ? "file" : "vendor";
