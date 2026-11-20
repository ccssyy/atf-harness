/**
 * G2 交付物 3 测试：skillCatalog → ctx.skill（端口化）。
 *
 * 两条路都测真实实现：
 * - 端口版：注册表端口用真实磁盘上的技能目录做 provider（只有端口边界是测试替身，
 *   不 mock 技能内容与 frontmatter 解析）；
 * - 目录版：直接跑 listSkills / readSkillBody / readSkillFile 的磁盘实现。
 * 断言聚焦「同一批磁盘技能，两条路给出同一份清单与同一份全文」与附属文件的守卫语义。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILL_FILE_MAX_BYTES,
  listSkills,
  listSkillsFromRegistry,
  parseSkillFrontmatter,
  readSkillBody,
  readSkillBodyFromRegistry,
  readSkillFile,
  readSkillFileFromRegistry,
  skillsSuffixText,
  summariesOfSkillRegistry,
  type SkillRegistryPort,
  type VendorSkillDefinition,
  type VendorSkillSummary,
} from "../src/skillCatalog.js";

let skillsRoot = "";

/** 建一个真实技能目录（SKILL.md＋references/＋assets/＋scripts/）。 */
const makeSkill = (
  name: string,
  description: string,
  options: { references?: Record<string, string>; body?: string } = {},
): string => {
  const dir = join(skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  const body = options.body ?? `${name} 的操作定义正文。`;
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, "utf8");
  for (const [rel, content] of Object.entries(options.references ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
};

/**
 * 以真实磁盘目录为后端的注册表端口：行为对齐 vendor `SkillRegistry.list/get` 的
 * 用到子集（list 返回摘要、get 返回正文＋resourceBase）。这是端口边界的最小替身，
 * 技能内容与 frontmatter 解析仍走真实文件。
 */
const registryOverDir = (root: string): SkillRegistryPort => ({
  list: async (): Promise<VendorSkillSummary[]> => {
    const listed = await listSkills(root);
    if (!listed.ok) return [];
    return listed.value.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.dir === null ? undefined : join(skill.dir, "SKILL.md"),
      resourceBase: skill.dir === null ? undefined : { kind: "directory", path: skill.dir },
    }));
  },
  get: async (name: string): Promise<VendorSkillDefinition | undefined> => {
    const listed = await listSkills(root);
    if (!listed.ok) return undefined;
    const hit = listed.value.find((skill) => skill.name === name);
    if (hit === undefined || hit.dir === null) return undefined;
    const read = await readSkillBody(root, name);
    if (!read.ok) return undefined;
    return { name, description: hit.description, path: join(hit.dir, "SKILL.md"), resourceBase: { kind: "directory", path: hit.dir }, content: read.value.body };
  },
});

beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "atf-skills-"));
});

afterEach(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
});

describe("skillCatalog——frontmatter 解析（实现未改，作回归锚）", () => {
  it("解析 name/description，续行并入", () => {
    expect(parseSkillFrontmatter("---\nname: a-skill\ndescription: 第一行\n  第二行\n---\n正文")).toEqual({
      name: "a-skill",
      description: "第一行 第二行",
    });
  });

  it("缺 name 或 description → null；无 frontmatter → null", () => {
    expect(parseSkillFrontmatter("---\nname: a\n---\n正文")).toBeNull();
    expect(parseSkillFrontmatter("正文のみ")).toBeNull();
  });
});

describe("skillCatalog——目录版与注册表版给出同一清单", () => {
  it("两份技能按名字排序，两条路结果一致", async () => {
    makeSkill("b-skill", "第二个");
    makeSkill("a-skill", "第一个");
    const dirListed = await listSkills(skillsRoot);
    expect(dirListed.ok).toBe(true);
    const fromDir = dirListed.ok ? dirListed.value : [];

    const registryListed = await listSkillsFromRegistry(registryOverDir(skillsRoot));
    expect(registryListed.ok).toBe(true);
    const fromRegistry = registryListed.ok ? registryListed.value : [];

    expect(fromDir.map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(fromRegistry.map((s) => s.name)).toEqual(["a-skill", "b-skill"]);
    expect(fromRegistry.map((s) => s.description)).toEqual(fromDir.map((s) => s.description));
  });

  it("技能根不存在：目录版 err(skills_root_missing)；注册表版给空清单（provider 承担降级）", async () => {
    const missing = join(skillsRoot, "nope");
    const dirListed = await listSkills(missing);
    expect(dirListed.ok).toBe(false);
    if (!dirListed.ok) expect(dirListed.error.code).toBe("skills_root_missing");

    const registryListed = await listSkillsFromRegistry(registryOverDir(missing));
    expect(registryListed.ok).toBe(true);
    if (registryListed.ok) expect(registryListed.value).toEqual([]);
  });

  it("summariesOfSkillRegistry：resourceBase 目录型 → dir；path 退化取父目录；虚拟技能 dir=null", () => {
    expect(
      summariesOfSkillRegistry([
        { name: "x", description: "d", resourceBase: { kind: "directory", path: "/s/x" } },
        { name: "y", description: "d", path: "/s/y/SKILL.md" },
        { name: "z", description: "d" },
      ]),
    ).toEqual([
      { name: "x", description: "d", dir: "/s/x" },
      { name: "y", description: "d", dir: "/s/y" },
      { name: "z", description: "d", dir: null },
    ]);
  });
});

describe("skillCatalog——全文与附属文件读取", () => {
  it("正文去掉 frontmatter，附属文件清单排序，两条路一致", async () => {
    makeSkill("a-skill", "第一个", {
      references: { "references/guide.md": "指南", "assets/pic.txt": "图", "scripts/run.py": "print(1)" },
    });
    const fromDir = await readSkillBody(skillsRoot, "a-skill");
    const fromRegistry = await readSkillBodyFromRegistry(registryOverDir(skillsRoot), "a-skill");
    expect(fromDir.ok && fromRegistry.ok).toBe(true);
    if (fromDir.ok && fromRegistry.ok) {
      // 去 frontmatter 后保留正文自身换行（原实现语义，不在此批改动）
      expect(fromDir.value.body.trim()).toBe("a-skill 的操作定义正文。");
      expect(fromDir.value.body).toBe(fromRegistry.value.body);
      expect(fromRegistry.value.references).toEqual(["assets/pic.txt", "references/guide.md", "scripts/run.py"]);
      expect(fromDir.value.references).toEqual(fromRegistry.value.references);
    }
  });

  it("未登记技能 → skill_unknown（两条路同码）", async () => {
    const fromDir = await readSkillBody(skillsRoot, "absent");
    const fromRegistry = await readSkillBodyFromRegistry(registryOverDir(skillsRoot), "absent");
    expect(fromDir.ok).toBe(false);
    expect(fromRegistry.ok).toBe(false);
    if (!fromDir.ok) expect(fromDir.error.code).toBe("skill_unknown");
    if (!fromRegistry.ok) expect(fromRegistry.error.code).toBe("skill_unknown");
  });

  it("技能名含路径分隔/越界 → skill_unknown（端口版守卫）", async () => {
    const registry = registryOverDir(skillsRoot);
    for (const bad of ["../etc", "a/b", "a\\b", ""]) {
      const read = await readSkillBodyFromRegistry(registry, bad);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe("skill_unknown");
    }
  });

  it("附属文件：references 内可读；越界/非白名单前缀/SKILL.md 本体 → 拒绝", async () => {
    makeSkill("a-skill", "第一个", { references: { "references/guide.md": "指南内容" } });
    const registry = registryOverDir(skillsRoot);

    const okRead = await readSkillFileFromRegistry(registry, "a-skill", "references/guide.md");
    expect(okRead.ok).toBe(true);
    if (okRead.ok) expect(okRead.value.body).toBe("指南内容");

    const dirRead = await readSkillFile(skillsRoot, "a-skill", "references/guide.md");
    expect(dirRead.ok).toBe(true);

    for (const bad of ["../escape.txt", "SKILL.md", "other/x.md", "references/"]) {
      const denied = await readSkillFileFromRegistry(registry, "a-skill", bad);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("skill_file_forbidden");
    }
  });

  it("附属文件超上限诚实截断并置 truncated", async () => {
    const big = "x".repeat(SKILL_FILE_MAX_BYTES + 1024);
    makeSkill("a-skill", "第一个", { references: { "references/big.md": big } });
    const read = await readSkillFileFromRegistry(registryOverDir(skillsRoot), "a-skill", "references/big.md");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.truncated).toBe(true);
      expect(read.value.body.length).toBe(SKILL_FILE_MAX_BYTES);
    }
  });

  it("虚拟技能（无目录）读附属文件 → skill_no_directory", async () => {
    const virtual: SkillRegistryPort = {
      list: async () => [{ name: "v", description: "d" }],
      get: async (name) => (name === "v" ? { name: "v", description: "d", content: "虚拟正文" } : undefined),
    };
    const body = await readSkillBodyFromRegistry(virtual, "v");
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.value.references).toEqual([]);

    const file = await readSkillFileFromRegistry(virtual, "v", "references/x.md");
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.error.code).toBe("skill_no_directory");
  });

  it("注册表抛错 → skills_registry_unreadable / skill_unreadable（不把异常漏给调用方）", async () => {
    const broken: SkillRegistryPort = {
      list: async () => {
        throw new Error("boom");
      },
      get: async () => {
        throw new Error("boom");
      },
    };
    const listed = await listSkillsFromRegistry(broken);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).toBe("skills_registry_unreadable");

    const read = await readSkillBodyFromRegistry(broken, "a-skill");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("skill_unreadable");
  });
});

describe("skillCatalog——systemSuffix 文案", () => {
  it("每技能一行，含三步用法指引", () => {
    const text = skillsSuffixText([
      { name: "a-skill", description: "第一个", dir: "/s/a" },
      { name: "b-skill", description: "第二个", dir: null },
    ]);
    expect(text).toContain("- a-skill — 第一个");
    expect(text).toContain("- b-skill — 第二个");
    expect(text).toContain("atf_skill_read");
    expect(text).toContain("atf_scratch_write");
    expect(text).toContain("atf_scratch_exec");
  });
});
