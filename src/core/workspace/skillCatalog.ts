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
 */
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../../bridge/index.js";

/** reference 全文读取字节上限（超限截断＋知情尾标）。 */
export const SKILL_FILE_MAX_BYTES = 256 * 1024;

export interface SkillSummary {
  /** frontmatter name（如 atf-run-training） */
  name: string;
  /** frontmatter description（一行） */
  description: string;
  /** 技能目录绝对路径（pin 内只读） */
  dir: string;
}

export const skillCatalogError = (code: string, message: string): { code: string; message: string } => ({ code, message });
export type SkillCatalogError = ReturnType<typeof skillCatalogError>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 解析 SKILL.md frontmatter（行级：--- 界定；键: 值；值续行以空白缩进并入）。 */
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

/** 技能清单（skillsRoot 不存在 = err(skills_root_missing)；单技能 SKILL.md 缺失/非法 = 跳过）。 */
export const listSkills = async (skillsRoot: string): Promise<Result<SkillSummary[], SkillCatalogError>> => {
  if (!existsSync(skillsRoot)) {
    return err(skillCatalogError("skills_root_missing", `技能根不存在: ${skillsRoot}`));
  }
  let entries;
  try {
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

/** 技能目录守卫：skill 名不得含路径分隔/越界；返回技能目录绝对路径。 */
const resolveSkillDir = (skillsRoot: string, skill: string): Result<string, SkillCatalogError> => {
  if (skill === "" || skill.includes("/") || skill.includes("\\") || skill.includes("..")) {
    return err(skillCatalogError("skill_unknown", `技能名非法: ${skill}`));
  }
  const dir = join(skillsRoot, skill);
  if (!existsSync(dir)) return err(skillCatalogError("skill_unknown", `未登记技能: ${skill}（用 atf_skill_read 无参调用取清单）`));
  return ok(dir);
};

/** 按需读全文：SKILL.md 正文（去 frontmatter）＋ references/assets 文件清单。 */
export const readSkillBody = async (skillsRoot: string, skill: string): Promise<Result<{ skill: string; body: string; references: string[] }, SkillCatalogError>> => {
  const dir = resolveSkillDir(skillsRoot, skill);
  if (!dir.ok) return dir;
  let text: string;
  try {
    text = await readFile(join(dir.value, "SKILL.md"), "utf8");
  } catch (cause) {
    return err(skillCatalogError("skill_unreadable", `SKILL.md 读取失败: ${String(cause)}`));
  }
  const frontmatterClosed = text.startsWith("---");
  const body = frontmatterClosed ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : text;
  const references: string[] = [];
  for (const sub of ["references", "assets", "scripts"]) {
    const subDir = join(dir.value, sub);
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
  return ok({ skill, body, references });
};

/** 读技能附属文件（references/assets 内；SKILL.md 走 readSkillBody；路径守卫在技能目录内）。 */
export const readSkillFile = async (skillsRoot: string, skill: string, file: string): Promise<Result<{ skill: string; file: string; body: string; truncated: boolean }, SkillCatalogError>> => {
  const dir = resolveSkillDir(skillsRoot, skill);
  if (!dir.ok) return dir;
  if (file === "" || file.endsWith("/")) {
    return err(skillCatalogError("skill_file_forbidden", `文件路径非法: ${file}`));
  }
  const abs = resolve(dir.value, file);
  const rel = relative(dir.value, abs);
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
