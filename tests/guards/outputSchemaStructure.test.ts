import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 工具面自描述守卫（2026-11-21「工具面自描述补全」批次）。
 *
 * defineTool 的 output.schema 由 dsh-system-prompt 自动组装进 agent prompt——
 * 是 agent 知道「会收到什么结构」的唯一来源。「无 properties 的裸开放
 * output schema」（{type:"object", additionalProperties:true} 且无 properties
 * 键）等同未声明＝agent 视角黑盒，本守卫禁止其存在于 atf-tools 源码。
 *
 * 检测形态＝单行字面量 `schema: { type: "object", additionalProperties: true }`
 * 后紧跟 `,` 或 `}`（render 单行 / output 块收口两种排布均命中）；
 * `looseObjectOutput` 常量引用形态由下方「output 块内 properties 必在」
 * 断言覆盖（引用不带字面量，靠逐工具结构断言兜住）。
 */

const SRC_ROOT = join(process.cwd(), "packages", "extensions", "atf-tools", "src");

/** 裸开放 output schema 的检测正则（单行形态，global）。 */
const BARE_OPEN_OUTPUT =
  /schema:\s*\{\s*type:\s*"object"\s*,\s*additionalProperties:\s*true\s*\}\s*[,}]/g;

/**
 * 已知残留（批次边界外——任务书只授权 6 个目标工具）：
 * 修复这两处需 lead 扩边裁定；清单非许可——新增命中一律失败，
 * 本清单内的计数变化（增多/清零后复现）同样失败。
 */
const KNOWN_RESIDUALS: Readonly<Record<string, number>> = {
  // atf_publish_confirm：盘点报告在册的松散工具之一，任务书 6 工具清单未含
  "confirmFace.ts": 1,
  // atf_publish_model：盘点误判 OK（单行形态漏检），任务书 6 工具清单未含
  "trainingFace.ts": 1,
};

/** 本批次 6 个目标工具：output 块内必须带 properties（声明面存在性）。 */
const DECLARED_TOOLS: ReadonlyArray<{ tool: string; file: string }> = [
  { tool: "atf_config_confirm", file: "confirmFace.ts" },
  { tool: "atf_pipeline_stage", file: "pipelineFace.ts" },
  { tool: "atf_training_preflight", file: "preflightFace.ts" },
  { tool: "atf_run_training", file: "trainingFace.ts" },
  { tool: "atf_evaluate", file: "trainingFace.ts" },
  { tool: "atf_analyze_badcases", file: "trainingFace.ts" },
];

/** 递归收集 src 下全部 .ts 源文件。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) continue;
    if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 对一段源码文本检测裸开放 output schema，返回命中片段列表。 */
export function findBareOpenOutputs(text: string): string[] {
  return [...text.matchAll(BARE_OPEN_OUTPUT)].map((match) => match[0]);
}

/** 取工具定义片段（name: 声明起到 async execute 为止——output 块在其中）。 */
function toolDefinitionSlice(text: string, toolName: string): string {
  const nameAt = text.indexOf(`name: "${toolName}"`);
  expect(nameAt, `${toolName} 定义应存在于源码`).toBeGreaterThanOrEqual(0);
  const executeAt = text.indexOf("async execute", nameAt);
  expect(executeAt, `${toolName} 定义后应有 execute`).toBeGreaterThan(nameAt);
  return text.slice(nameAt, executeAt);
}

describe("工具面自描述守卫（outputSchemaStructure）", () => {
  it("atf-tools 源码不存在无 properties 的裸开放 output schema（已知残留除外）", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hitsByFile: Record<string, string[]> = {};
    for (const file of files) {
      const hits = findBareOpenOutputs(readFileSync(file, "utf8"));
      if (hits.length > 0) hitsByFile[file.split("/").pop() as string] = hits;
    }
    // 已知残留逐一核对（计数精确匹配——变多=新腐化，变少=残留已修、清单待清）
    const residualFiles = Object.keys(KNOWN_RESIDUALS).sort();
    const hitFiles = Object.keys(hitsByFile).sort();
    expect(hitFiles).toEqual(residualFiles);
    for (const [file, expected] of Object.entries(KNOWN_RESIDUALS)) {
      expect(hitsByFile[file]?.length ?? 0, `${file} 的裸开放形态计数应恰为 ${expected}`).toBe(expected);
    }
  });

  it("阴性对照：检测器能命中合成源串里的裸开放形态（防检测器失效）", () => {
    const synthetic = [
      "    output: {",
      '      schema: { type: "object", additionalProperties: true },',
      "      render: (_args, value) => [],",
      "    },",
    ].join("\n");
    expect(findBareOpenOutputs(synthetic).length).toBe(1);
    // 单行收口形态（无 render 跟随）同样命中
    const syntheticInline = '    output: { schema: { type: "object", additionalProperties: true } },';
    expect(findBareOpenOutputs(syntheticInline).length).toBe(1);
    // 带 properties 的结构化声明不命中（防误报）
    const declared = [
      "    output: {",
      "      schema: {",
      '        type: "object",',
      "        additionalProperties: true,",
      "        properties: { ok: { type: \"boolean\" } },",
      "      },",
      "      render: (_args, value) => [],",
      "    },",
    ].join("\n");
    expect(findBareOpenOutputs(declared)).toEqual([]);
  });

  it("六个目标工具的 output 块内均带 properties（声明面存在，含 looseObjectOutput 引用形态）", () => {
    for (const { tool, file } of DECLARED_TOOLS) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      const slice = toolDefinitionSlice(text, tool);
      expect(slice, `${tool} 的定义片段应含 output 块`).toContain("output:");
      expect(slice, `${tool}（${file}）的 output schema 应带 properties——裸开放形态=agent 视角黑盒`).toContain("properties:");
    }
  });
});
