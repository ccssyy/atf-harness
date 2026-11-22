/**
 * G6 分层 evals · L0 结构断言（秒级，永远全跑）。
 *
 * 载体：源码扫描 + 仓库树事实（无 spawn/无模型/无网络）。
 * 事故出处见逐条注释（编号 + 原症状 + verdict/盘点文档锚）。
 * 与既有守卫的分工：
 *   - tests/guards/outputSchemaStructure.test.ts 守「已结构化工具的 properties 在场 + 裸开放形态为零」；
 *   - 本文件守它没有的入口枚举面：`defineTool` 定义点全量枚举 × output 块 properties 在场
 *     （新增工具不带 properties 即红，不依赖任何 DECLARED_TOOLS 名单维护）。
 *   - import 深度面本文件独有（事故 5）。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// tests/evals → 仓根恒 2 级（与 tests/** 其余文件同构：本文件自身即事故 5 的合规样本）。
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const TESTS_ROOT = join(REPO_ROOT, "tests");
const ATF_TOOLS_SRC = join(REPO_ROOT, "packages", "extensions", "atf-tools", "src");

// ---------------------------------------------------------------- 事故 5：import 深度

/**
 * 事故 5 · worktree 深度（原症状）：G5 执行批在 worktree `.worktrees/g5-mcp` 里把
 * tests/dshTools 的 import 写成 4 级 `../../../../src/...`——worktree 恰多两层目录，
 * 4 级正好落仓根，worktree 内 tsc/vitest 全绿；主仓 tests/dshTools 距仓根仅 2 级，
 * 4 级落到仓外 → tsc TS2307×4 + vitest 加载失败。
 * 文档锚：docs/verdicts/verdict-g1-g4-20261121.md（§四 未清偿项处置 · 陈旧残留取证）；
 *        提交 68e9629f 的 message 是完整事故记录。
 *
 * 不变量：`tests/<sub>/...` 里指向仓根的相对 import，层数必须等于该文件到仓根的深度，
 * 不许「多写一层」——多写一层的文件在 worktree 布局下反而能解析，这是掩盖机制。
 */
const IMPORT_SPECIFIER_RE = /(?:from|import)\s*\(?\s*"((?:\.\.\/)+[^"]*)"/g;

/** 收集 tests 下全部 .ts 文件（递归）。 */
const listTestSources = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTestSources(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
};

/** 相对路径的 `../` 前缀层数（"../../src/x" → 2）。 */
const upLevelsOf = (specifier: string): number => {
  let count = 0;
  let rest = specifier;
  while (rest.startsWith("../")) {
    count += 1;
    rest = rest.slice(3);
  }
  return count;
};

/** 文件所在目录到仓根的层数（tests/evals/x.ts → 2）。 */
const depthToRepoRootOf = (file: string): number =>
  relative(REPO_ROOT, file).split("/").length - 1;

describe("L0 · 事故5 worktree 深度：tests/** 相对 import 层数锚 repo 布局", () => {
  it("每个 tests 文件的 `../` 层数不超过「到仓根的深度」，且无 4 级形态（4 级=事故原形）", () => {
    const files = listTestSources(TESTS_ROOT);
    expect(files.length, "tests 下应有测试源码").toBeGreaterThan(100);

    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const depth = depthToRepoRootOf(file);
      for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = match[1] ?? "";
        const levels = upLevelsOf(specifier);
        if (levels > depth) {
          const line = text.slice(0, match.index).split("\n").length;
          violations.push(
            `${relative(REPO_ROOT, file)}:${line} 用了 ${levels} 级（该文件到仓根仅 ${depth} 级）——${specifier}`,
          );
        }
      }
    }
    expect(
      violations,
      "相对 import 层数超过文件到仓根的深度：worktree（多两层目录）能解析、主仓必红——层数必须锚 repo 布局而不是验证环境布局",
    ).toEqual([]);
  });

  it("阴性对照：检测器能命中合成串里的「多写一层」形态（防检测器失效）", () => {
    // tests/dshTools/x.ts 深度=2；4 级即多写两层。
    // 合成串由段拼出——本文件自身也在上面那条全量扫描里，写死字面量会把自己扫成违规。
    const depth = 2;
    const four = ["..", "..", "..", ".."].join("/");
    const three = ["..", "..", ".."].join("/");
    const two = ["..", ".."].join("/");
    const synthetic = [
      `import { A } from "${four}/src/core/tools/index.js";`,
      `import { B } from "${two}/src/core/tools/index.js";`,
      `const lazy = await import("${three}/packages/x.js");`,
    ].join("\n");
    const hits = [...synthetic.matchAll(IMPORT_SPECIFIER_RE)]
      .map((match) => ({ specifier: match[1] ?? "", levels: upLevelsOf(match[1] ?? "") }))
      .filter((entry) => entry.levels > depth);
    expect(hits.map((entry) => entry.levels)).toEqual([4, 3]); // 2 级那条合规，不命中
  });

  it("本文件自身合规：2 级 import 指到仓根（README 级样本，防本文件自己踩坑）", () => {
    expect(upLevelsOf("../../src/agent/index.js")).toBe(2);
    expect(depthToRepoRootOf(join(TESTS_ROOT, "evals", "l0.structure.test.ts"))).toBe(2);
  });
});

// ---------------------------------------------------------------- 事故 6：output.schema 黑盒

/**
 * 事故 6 · schema 黑盒（原症状）：18 个工具里前 11 位的 output.schema 是
 * `{type:"object", additionalProperties:true}` 裸开放形态（经 looseObjectOutput 常量承载），
 * 没有 properties——agent 拿不到「会收到什么结构」，只能靠试错。
 * 文档锚：docs/audit/ATF_工具面自描述盘点_20261121.md（§盘点：looseObjectOutput 11 位清退，
 * 常量已加 @deprecated）；A1 清退批（2026-11-22）逐位结构化完成。
 *
 * 本断言补的是既有守卫没有的**入口枚举**：既有守卫维护 DECLARED_TOOLS 白名单，
 * 新增工具不登记就漏检；本断言从 `defineTool({` 定义点全量枚举，新增定义点没 properties 即红。
 */
const listAtfToolSources = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
};

interface DefineToolSite {
  readonly file: string;
  readonly line: number;
  readonly toolName: string;
  readonly hasProperties: boolean;
}

/** output schema 块内 `properties` 键的检测（键名锚定，不用裸子串）。
 *  裸子串会被 `x_disabled_properties:` 这类派生名命中的假阴性放过——演练实测发现。 */
const HAS_PROPERTIES_KEY = /(?:^|[^A-Za-z0-9_$])properties\s*:/;

/** 从 `defineTool({ ... })` 定义点切出 output.schema 片段并判 properties 在场。 */
const defineToolSitesOf = (file: string): DefineToolSite[] => {
  const text = readFileSync(file, "utf8");
  const starts: number[] = [];
  for (let at = text.indexOf("defineTool({"); at >= 0; at = text.indexOf("defineTool({", at + 1)) {
    starts.push(at);
  }
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? (starts[index + 1] as number) : text.length;
    const segment = text.slice(start, end);
    const nameMatch = segment.match(/name:\s*(?:"([^"]+)"|`([^`$]+)`|([A-Za-z_][A-Za-z0-9_.]*))/);
    const outputAt = segment.indexOf("output: {");
    const schemaAt = outputAt >= 0 ? segment.indexOf("schema:", outputAt) : -1;
    const renderAt = schemaAt >= 0 ? segment.indexOf("render:", schemaAt) : -1;
    const schemaSlice = schemaAt >= 0 ? segment.slice(schemaAt, renderAt > schemaAt ? renderAt : end - start) : "";
    return {
      file,
      line: text.slice(0, start).split("\n").length,
      toolName: nameMatch === null ? "(动态)" : (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? "(动态)"),
      hasProperties: HAS_PROPERTIES_KEY.test(schemaSlice),
    };
  });
};

describe("L0 · 事故6 output.schema 黑盒：新增工具必须带 properties（定义点全量枚举）", () => {
  it("atf-tools 每个 defineTool 定义点的 output.schema 都带 properties", () => {
    const files = listAtfToolSources(ATF_TOOLS_SRC);
    expect(files.length, "atf-tools/src 应有 .ts 源").toBeGreaterThan(10);

    const sites = files.flatMap(defineToolSitesOf);
    expect(sites.length, "defineTool 定义点应被枚举到（少于 15 说明扫描面失效）").toBeGreaterThanOrEqual(15);

    const violations = sites
      .filter((site) => !site.hasProperties)
      .map((site) => {
        const rel = relative(REPO_ROOT, site.file);
        return `${rel}:${site.line} ${site.toolName} 的 output.schema 无 properties——agent 视角黑盒（事故6）`;
      });
    expect(
      violations,
      "新增工具必须声明 output.schema.properties：裸开放形态=agent 不知返回结构，只能试错（事故6 schema 黑盒的根因）",
    ).toEqual([]);
  });

  it("阴性对照：检测器能命中合成源串里的裸开放定义点（防检测器失效）", () => {
    const synthetic = [
      "  defineTool({",
      '    name: "atf_bare_tool",',
      '    description: "x",',
      "    parameters: {},",
      "    output: {",
      '      schema: { type: "object", additionalProperties: true },',
      "      render: (_a, v) => [],",
      "    },",
      "    async execute() { return {}; },",
      "  });",
    ].join("\n");
    const text = synthetic;
    const start = text.indexOf("defineTool({");
    const segment = text.slice(start);
    const schemaAt = segment.indexOf("schema:");
    const renderAt = segment.indexOf("render:");
    const schemaSlice = segment.slice(schemaAt, renderAt);
    expect(HAS_PROPERTIES_KEY.test(schemaSlice), "检测器对裸形态应判「无 properties」").toBe(false);

    const declared = synthetic.replace(
      'schema: { type: "object", additionalProperties: true },',
      'schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean" } } },',
    );
    const segment2 = declared.slice(declared.indexOf("defineTool({"));
    const schemaAt2 = segment2.indexOf("schema:");
    const renderAt2 = segment2.indexOf("render:");
    expect(HAS_PROPERTIES_KEY.test(segment2.slice(schemaAt2, renderAt2))).toBe(true);
  });

  it("工具名可枚举：定义点的 name 不是全部为动态表达式（否则入口枚举退化）", () => {
    const sites = listAtfToolSources(ATF_TOOLS_SRC).flatMap(defineToolSitesOf);
    const literal = sites.filter((site) => /^atf_/.test(site.toolName));
    expect(literal.length, "至少多数 defineTool 定义点带字面量 atf_ 名（动态名=循环挂载面，另计）").toBeGreaterThan(10);
  });
});
