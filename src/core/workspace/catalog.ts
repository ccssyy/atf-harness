/**
 * Artifact Catalog——T1 不可变产物 sha 指纹登记的 harness 侧 JSON 清单承载
 * （owner 口径 #6，schema 登记于 workspace.contract.yaml artifact_catalog 节）。
 *
 * 纪律：
 * - 读入严格校验（fail-closed）：损坏清单上的任何晋升动作都拒绝，不猜测、不带病写入；
 * - 写入 = 临时文件 + rename，避免撕裂清单；
 * - 与 artifacts/ 目录的一致性由晋升闸负责（本模块只管清单自身的读写与校验）。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { err, ok, type Result } from "../../bridge/index.js";
import { workspaceError, type WorkspaceError } from "./errors.js";

export const CATALOG_SCHEMA_VERSION = 0;
export const CATALOG_FILENAME = "catalog.json";

/** catalog.json 单条登记（workspace.contract.yaml artifact_catalog.schema.artifacts 项）。 */
export interface CatalogEntry {
  /** = 源文件在 scratch/ 内的相对路径，run 内唯一 */
  artifact_id: string;
  /** 晋升来源（"scratch/" 前缀路径，登记留痕） */
  source: string;
  /** 64 位小写 hex，对晋升产物字节计算 */
  sha256: string;
  bytes: number;
  /** ISO 8601 UTC */
  promoted_at: string;
  /** 复现命令登记（owner 口径 #3），argv 形态 */
  reproduce: { command: string[] };
}

export interface CatalogFile {
  schema_version: 0;
  artifacts: CatalogEntry[];
}

const HEX64 = /^[0-9a-f]{64}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIso8601 = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !Number.isNaN(Date.parse(value));

/** 单条登记校验。返回 null = 合法。 */
export const validateCatalogEntry = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "catalog 条目不是 JSON 对象";
  if (typeof value["artifact_id"] !== "string" || value["artifact_id"] === "") {
    return 'catalog 条目缺少合法 artifact_id（非空字符串）';
  }
  if (typeof value["source"] !== "string" || value["source"] === "") {
    return 'catalog 条目缺少合法 source（非空字符串）';
  }
  if (typeof value["sha256"] !== "string" || !HEX64.test(value["sha256"])) {
    return 'catalog 条目 sha256 非法（须为 64 位小写 hex）';
  }
  if (typeof value["bytes"] !== "number" || !Number.isInteger(value["bytes"]) || value["bytes"] < 0) {
    return 'catalog 条目 bytes 非法（须为非负整数）';
  }
  if (!isIso8601(value["promoted_at"])) {
    return "catalog 条目 promoted_at 非法（须为可解析的 ISO 8601 时间串）";
  }
  const reproduce = value["reproduce"];
  if (!isPlainObject(reproduce)) return "catalog 条目缺少 reproduce 对象";
  const command = reproduce["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== "string" || part === "")
  ) {
    return "catalog 条目 reproduce.command 非法（须为非空 argv 数组）";
  }
  return null;
};

/** 整份 catalog 校验（严格白名单——未声明字段即损坏，防篡改/防漂移）。返回 null = 合法。 */
export const validateCatalogFile = (value: unknown): string | null => {
  if (!isPlainObject(value)) return "catalog 不是 JSON 对象";
  if (value["schema_version"] !== CATALOG_SCHEMA_VERSION) {
    return `catalog schema_version 非法（期望 ${String(CATALOG_SCHEMA_VERSION)}，实得 ${String(value["schema_version"])}）`;
  }
  const artifacts = value["artifacts"];
  if (!Array.isArray(artifacts)) return "catalog artifacts 非法（须为数组）";
  const seen = new Set<string>();
  for (let i = 0; i < artifacts.length; i += 1) {
    const violation = validateCatalogEntry(artifacts[i]);
    if (violation !== null) return `catalog.artifacts[${String(i)}] ${violation}`;
    const id = (artifacts[i] as Record<string, unknown>)["artifact_id"] as string;
    if (seen.has(id)) return `catalog.artifacts[${String(i)}] artifact_id 重复: ${id}`;
    seen.add(id);
  }
  return null;
};

/**
 * 读入 catalog：文件不存在 = 空 catalog（首个晋升前的常态）；
 * 存在但损坏（坏 JSON / 校验违规）= err(corrupt_catalog)。
 */
export const loadCatalog = async (catalogPath: string): Promise<Result<CatalogFile, WorkspaceError>> => {
  let text: string;
  try {
    text = await readFile(catalogPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return ok({ schema_version: CATALOG_SCHEMA_VERSION, artifacts: [] });
    }
    return err(workspaceError("corrupt_catalog", `读取 Artifact Catalog 失败: ${(cause as Error).message}`, {
      path: catalogPath,
      code: (cause as NodeJS.ErrnoException).code,
    }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err(workspaceError("corrupt_catalog", "Artifact Catalog 非法 JSON（可能被篡改或撕裂）", { path: catalogPath }));
  }
  const violation = validateCatalogFile(parsed);
  if (violation !== null) {
    return err(workspaceError("corrupt_catalog", `Artifact Catalog 校验失败: ${violation}`, { path: catalogPath }));
  }
  return ok(parsed as CatalogFile);
};

/** 写入 catalog：临时文件 + rename（同目录原子替换）；写失败 = err（晋升闸负责回滚补偿）。 */
export const saveCatalog = async (catalogPath: string, catalog: CatalogFile): Promise<Result<void, WorkspaceError>> => {
  const violation = validateCatalogFile(catalog);
  if (violation !== null) {
    return err(workspaceError("corrupt_catalog", `拒绝写出未通过校验的 catalog: ${violation}`));
  }
  const tempPath = `${catalogPath}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await rename(tempPath, catalogPath);
    return ok(undefined);
  } catch (cause) {
    return err(workspaceError("corrupt_catalog", `Artifact Catalog 写入失败: ${(cause as Error).message}`, {
      path: catalogPath,
      code: (cause as NodeJS.ErrnoException).code,
    }));
  }
};
