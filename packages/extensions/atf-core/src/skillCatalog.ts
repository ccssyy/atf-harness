/**
 * SkillCatalog（批 3「创作执行面」§二，Pi lazy skills 模式）——
 * - 清单常驻：解析 `<内核>/skills/<技能>/SKILL.md` frontmatter（name + description），每技能一行；
 *   经 provider systemSuffix 追加进系统提示（常驻成本一行/技能，调用时载全文）；
 * - 按需读全文：atf_skill_read 消费 readSkillBody / readSkillFile——路径守卫在技能目录内，
 *   references/assets 可读，体量上限诚实截断。
 *
 * 单源纪律：技能唯一事实源＝pin 内核 checkout（<kernelDir>/skills，只读）；harness 不复制、
 * 不改写、不缓存副本（内核仓零写入红线）。skillsRoot 缺失＝装载降级（不注入、不报错——
 * skills 是增强而非依赖；模型面工具此时返回 rejected 如实告知）。
 *
 * ── G2 迁移改造（施工卡交付物 3）─────────────────────────────────────────────
 * 改的是**技能来源接口**：目录扫描 → `ctx.skills` 注册表读取。
 *
 * 分工（关键：不丢训练域增量）：
 * - **清单与全文归 vendor**：`ctx.skills.list()` / `ctx.skills.get(name)` 是唯一枚举与
 *   加载入口。vendor 的 `skill-filesystem` provider 已解析 frontmatter、已做根分层与
 *   优先级合并、已处理重复名。本包不再自己 readdir 技能根——那正是方案要消的机制重复。
 * - **训练域增量保留**：`readSkillFile`（references/assets/scripts 附属文件读取＋路径守卫
 *   ＋256KB 诚实截断）vendor 无对应能力（`tool-skill` 只返回 body 与 resourceBase，
 *   不提供附属文件读取）。故保留，但技能目录改成从 `SkillDefinition.resourceBase` 推导，
 *   不再自己拼 skillsRoot。
 * - **系统提示尾注保留**：`skillsSuffixText` 是 ATF 的训练链操作指引（atf_skill_read →
 *   atf_scratch_write → atf_scratch_exec 三步），属领域文案，原样保留；入参换成
 *   vendor `SkillSummary` 的形状适配（映射由 `summariesOfSkillRegistry` 做）。
 *
 * 为何定义自己的最小端口而不是 import `@deepseek-ai/dsh-skill`：本仓 `node_modules`
 * 只链接了 dsh-tools 与 schemastery 两个 vendor 包，其余 `@deepseek-ai/*` 在 tsc 下
 * 不可解析（实测 TS2307）。用结构化端口让本文件零 vendor import，typecheck 立刻可绿；
 * 端口形状逐字对齐 vendor `SkillRegistry.list/get` 与 `SkillSummary` 的用到子集，
 * G3 接线时把 `ctx.skills` 直接传进来即可（类型上已兼容）。
 */
import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../../../../src/bridge/index.js";

/** reference 全文读取字节上限（超限截断＋知情尾标）。 */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;

/** 技能条目摘要（清单一行；dir＝技能目录绝对路径）。
 *  dir 在 vendor 版由 `resourceBase`（kind:'directory'）推导；虚拟技能（无目录）为 null。 */
export interface SkillSummary {
  /** frontmatter name（如 atf-run-training） */
  name: string;
  /** frontmatter description（一行） */
  description: string;
  /** 技能目录绝对路径（pin 内只读）；虚拟技能＝null。 */
  dir: string | null;
}

/** vendor `SkillSummary`（@deepseek-ai/dsh-skill）用到的子集。 */
export interface VendorSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path?: string;
  readonly resourceBase?: { readonly kind: "directory"; readonly path: string } | { readonly kind: string };
}

/** vendor `SkillDefinition` 用到的子集（get 的返回值）。 */
export interface VendorSkillDefinition extends VendorSkillSummary {
  readonly content: string;
}

/**
 * 技能注册表端口（vendor `ctx.skills: SkillRegistry` 的结构子集）。
 * 只声明本模块用到的两个方法——`list` 取清单、`get` 取全文。
 */
export interface SkillRegistryPort {
  list(options?: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined }): Promise<VendorSkillSummary[]>;
  get(
    name: string,
    options?: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined },
  ): Promise<VendorSkillDefinition | undefined>;
}

export const skillCatalogError = (code: string, message: string): { code: string; message: string } => ({ code, message });
export type SkillCatalogError = ReturnType<typeof skillCatalogError>;

/** 解析 SKILL.md frontmatter（行级：--- 界定；键: 值；值续行以空白缩进并入）。
 *  保留理由：vendor 的 provider 内部同样解析，但它的解析结果不外露为纯函数；
 *  本函数是**测试锚**（G2 起的单测与历史 tests/workspace/scratchTools.test.ts 都测它），
 *  且 virtual skill 注册（`ctx.skills.register`）需要它把磁盘 SKILL.md 变成注册项。
 *  实现逐字未改——避免同一批里既有接口改造又改解析语义。 */
export const parseSkillFrontmatter = (text: string): { name: string; description: string } | null => {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const fields: Record<string, string> = {};
  let currentKey: string | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "---") break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match !== null) {
      currentKey = match[1] as string;
      fields[currentKey] = (match[2] as string).trim();
      continue;
    }
    if (currentKey !== null && /^\s+\S/.test(line)) {
      fields[currentKey] = `${fields[currentKey] ?? ""} ${(line as string).trim()}`.trim();
    }
  }
  const name = fields["name"];
  const description = fields["description"];
  if (typeof name !== "string" || name === "" || typeof description !== "string" || description === "") return null;
  return { name, description };
};

/** 技能目录推导：优先 resourceBase（目录型），退化到 path 的父目录。
 *  两者都缺（虚拟技能）＝null——附属文件读取会据此返回 skill_no_directory。 */
const skillDirOf = (summary: VendorSkillSummary): string | null => {
  const base = summary.resourceBase;
  if (base !== undefined && base.kind === "directory" && "path" in base) return (base as { path: string }).path;
  if (typeof summary.path === "string" && summary.path !== "") {
    // path 指向 SKILL.md 本体：其父目录即技能目录。
    return resolve(summary.path, "..");
  }
  return null;
};

/** vendor 摘要列表 → 本包 SkillSummary（dir 由 resourceBase 推导）。 */
export const summariesOfSkillRegistry = (skills: readonly VendorSkillSummary[]): SkillSummary[] =>
  skills
    .map((skill) => ({ name: skill.name, description: skill.description, dir: skillDirOf(skill) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

/**
 * 技能清单（端口版）：走 `ctx.skills.list()`。
 * - skillsRoot 不存在 → 不再自判（vendor provider 会给出它自己参与的清单，
 *   根缺失＝该根零贡献，不报错——原「装载降级」语义由 provider 承担）；
 * - cwd 透传（project 层技能按工作区选取）。
 */
export const listSkillsFromRegistry = async (
  registry: SkillRegistryPort,
  options: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<Result<SkillSummary[], SkillCatalogError>> => {
  try {
    return ok(summariesOfSkillRegistry(await registry.list(options)));
  } catch (cause) {
    return err(skillCatalogError("skills_registry_unreadable", `技能注册表读取失败: ${String(cause)}`));
  }
};

/**
 * 技能清单（目录版，保留）：原签名原行为，供内核 checkout 直读与测试使用。
 * 与端口版并存的理由：迁移期 src/core/tools 仍按目录版消费（那属于 G5 的接线面），
 * 本批不断它的链。
 */
export const listSkills = async (skillsRoot: string): Promise<Result<SkillSummary[], SkillCatalogError>> => {
  if (!existsSync(skillsRoot)) {
    return err(skillCatalogError("skills_root_missing", `技能根不存在: ${skillsRoot}`));
  }
  let entries;
  try {
    const { readdir } = await import("node:fs/promises");
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch (cause) {
    return err(skillCatalogError("skills_root_unreadable", `技能根不可读: ${String(cause)}`));
  }
  const summaries: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsRoot, entry.name);
    try {
      const text = await readFile(join(dir, "SKILL.md"), "utf8");
      const parsed = parseSkillFrontmatter(text);
      if (parsed !== null) summaries.push({ name: parsed.name, description: parsed.description, dir });
    } catch {
      continue;
    }
  }
  summaries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return ok(summaries);
};

/** 技能目录守卫：skill 名不得含路径分隔/越界；返回技能目录绝对路径（目录版用）。 */
const resolveSkillDir = (skillsRoot: string, skill: string): Result<string, SkillCatalogError> => {
  if (skill === "" || skill.includes("/") || skill.includes("\\") || skill.includes("..")) {
    return err(skillCatalogError("skill_unknown", `技能名非法: ${skill}`));
  }
  const dir = join(skillsRoot, skill);
  if (!existsSync(dir)) return err(skillCatalogError("skill_unknown", `未登记技能: ${skill}（用 atf_skill_read 无参调用取清单）`));
  return ok(dir);
};

/** 技能名合法性（与 vendor `isSkillName` 同判据的本地形态：路径分隔/越界即非法）。 */
const isSafeSkillName = (skill: string): boolean =>
  skill !== "" && !skill.includes("/") && !skill.includes("\\") && !skill.includes("..");

/** 附属文件清单（references/assets/scripts 内；SKILL.md 走 readSkillBody）。 */
const listSkillAttachments = async (dir: string): Promise<string[]> => {
  const references: string[] = [];
  const { readdir } = await import("node:fs/promises");
  for (const sub of ["references", "assets", "scripts"]) {
    const subDir = join(dir, sub);
    if (!existsSync(subDir)) continue;
    try {
      for (const entry of await readdir(subDir, { withFileTypes: true })) {
        if (entry.isFile()) references.push(`${sub}/${entry.name}`);
        else if (entry.isDirectory()) references.push(`${sub}/${entry.name}/`);
      }
    } catch {
      continue;
    }
  }
  references.sort();
  return references;
};

/** 正文读取＋frontmatter 剥离（目录版与端口版共用）。 */
const readSkillBodyAt = async (
  dir: string,
  skill: string,
): Promise<Result<{ skill: string; body: string; references: string[] }, SkillCatalogError>> => {
  let text: string;
  try {
    text = await readFile(join(dir, "SKILL.md"), "utf8");
  } catch (cause) {
    return err(skillCatalogError("skill_unreadable", `SKILL.md 读取失败: ${String(cause)}`));
  }
  const frontmatterClosed = text.startsWith("---");
  const body = frontmatterClosed ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : text;
  return ok({ skill, body, references: await listSkillAttachments(dir) });
};

/** 按需读全文（目录版，保留）：SKILL.md 正文（去 frontmatter）＋ references/assets 文件清单。 */
export const readSkillBody = async (skillsRoot: string, skill: string): Promise<Result<{ skill: string; body: string; references: string[] }, SkillCatalogError>> => {
  const dir = resolveSkillDir(skillsRoot, skill);
  if (!dir.ok) return dir;
  return readSkillBodyAt(dir.value, skill);
};

/** 按需读全文（端口版，G2 新增）：正文归 vendor `ctx.skills.get`，
 *  附属文件清单由 resourceBase 目录推导。虚拟技能（无目录）＝references 空。 */
export const readSkillBodyFromRegistry = async (
  registry: SkillRegistryPort,
  skill: string,
  options: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<Result<{ skill: string; body: string; references: string[] }, SkillCatalogError>> => {
  if (!isSafeSkillName(skill)) return err(skillCatalogError("skill_unknown", `技能名非法: ${skill}`));
  let definition: VendorSkillDefinition | undefined;
  try {
    definition = await registry.get(skill, options);
  } catch (cause) {
    return err(skillCatalogError("skill_unreadable", `技能读取失败: ${String(cause)}`));
  }
  if (definition === undefined) {
    return err(skillCatalogError("skill_unknown", `未登记技能: ${skill}（用 atf_skill_read 无参调用取清单）`));
  }
  const dir = skillDirOf(definition);
  return ok({
    skill: definition.name,
    body: definition.content,
    references: dir === null ? [] : await listSkillAttachments(dir),
  });
};

/** 读技能附属文件（端口版，G2 新增）：技能目录由注册表解析，路径守卫与截断语义不变。 */
export const readSkillFileFromRegistry = async (
  registry: SkillRegistryPort,
  skill: string,
  file: string,
  options: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<Result<{ skill: string; file: string; body: string; truncated: boolean }, SkillCatalogError>> => {
  if (!isSafeSkillName(skill)) return err(skillCatalogError("skill_unknown", `技能名非法: ${skill}`));
  let definition: VendorSkillDefinition | undefined;
  try {
    definition = await registry.get(skill, options);
  } catch (cause) {
    return err(skillCatalogError("skill_unreadable", `技能读取失败: ${String(cause)}`));
  }
  if (definition === undefined) {
    return err(skillCatalogError("skill_unknown", `未登记技能: ${skill}（用 atf_skill_read 无参调用取清单）`));
  }
  const dir = skillDirOf(definition);
  if (dir === null) {
    return err(skillCatalogError("skill_no_directory", `技能无附属目录（虚拟技能）: ${skill}`));
  }
  return readSkillFileAt(dir, skill, file);
};

/** 读技能附属文件（目录版，保留）：references/assets 内；SKILL.md 走 readSkillBody；
 *  路径守卫在技能目录内。 */
export const readSkillFile = async (skillsRoot: string, skill: string, file: string): Promise<Result<{ skill: string; file: string; body: string; truncated: boolean }, SkillCatalogError>> => {
  const dir = resolveSkillDir(skillsRoot, skill);
  if (!dir.ok) return dir;
  return readSkillFileAt(dir.value, skill, file);
};

/** 附属文件读取的单源实现（守卫＋截断）：目录版与端口版共用。 */
const readSkillFileAt = async (
  dir: string,
  skill: string,
  file: string,
): Promise<Result<{ skill: string; file: string; body: string; truncated: boolean }, SkillCatalogError>> => {
  if (file === "" || file.endsWith("/")) {
    return err(skillCatalogError("skill_file_forbidden", `文件路径非法: ${file}`));
  }
  const abs = resolve(dir, file);
  const rel = relative(dir, abs);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    return err(skillCatalogError("skill_file_forbidden", `文件路径越界（须在技能目录内）: ${file}`));
  }
  const firstSegment = rel.split("/")[0] ?? "";
  if (!["references", "assets", "scripts"].includes(firstSegment)) {
    return err(skillCatalogError("skill_file_forbidden", `仅可读 references/assets/scripts 内文件: ${file}`));
  }
  let statResult;
  try {
    statResult = await stat(abs);
  } catch {
    return err(skillCatalogError("skill_file_missing", `文件不存在: ${file}`));
  }
  if (!statResult.isFile()) {
    return err(skillCatalogError("skill_file_forbidden", `目标不是常规文件: ${file}`));
  }
  const capped = Math.min(statResult.size, SKILL_FILE_MAX_BYTES);
  const handle = await open(abs, "r");
  try {
    const buffer = Buffer.alloc(capped);
    await handle.read(buffer, 0, capped, 0);
    return ok({
      skill,
      file,
      body: buffer.toString("utf8"),
      truncated: statResult.size > SKILL_FILE_MAX_BYTES,
    });
  } finally {
    await handle.close();
  }
};

/** Pi 模式常驻清单文本（systemSuffix；每技能一行 + 一行使用指引）。 */
export const skillsSuffixText = (summaries: readonly SkillSummary[]): string =>
  [
    "",
    "可用技能（ATF 训练链操作定义；清单常驻，全文按需读取）：",
    ...summaries.map((summary) => `- ${summary.name} — ${summary.description}`),
    "用法：atf_skill_read 读技能全文（SKILL.md 即操作定义）→ atf_scratch_write 在工作区 scratch 写输入文件 → atf_scratch_exec 执行该技能 scripts/ 内的 Python 脚本（已注入内核 PYTHONPATH）→ 产物留在 scratch，供后续引用与晋升。",
  ].join("\n");
