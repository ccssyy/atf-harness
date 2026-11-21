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
 * 后紧跟 `,` 或 `}`（render 单行 / output 块收口两种排布均命中）——断言为零。
 * `looseObjectOutput` 常量引用形态（schemaTranslate.ts @deprecated）存量 11 个
 * 工具位在用（盘点正则只查字面量、引用全部漏计）——按文件计数精确登记，
 * 新增引用即失败；待独立批次逐个结构化后清零并删除常量。
 */

const SRC_ROOT = join(process.cwd(), "packages", "extensions", "atf-tools", "src");

/** 裸开放 output schema 的检测正则（单行形态，global）。 */
const BARE_OPEN_OUTPUT =
  /schema:\s*\{\s*type:\s*"object"\s*,\s*additionalProperties:\s*true\s*\}\s*[,}]/g;

/** looseObjectOutput 引用使用位的检测正则（schema: looseObjectOutput）。 */
const LOOSE_REF_USAGE = /schema:\s*looseObjectOutput\b/g;

/**
 * 引用形态存量登记（文件 → [计数, 身份]；精确匹配——变多=新腐化，
 * 变少=存量已修、登记待清）。定义处（schemaTranslate.ts）不计——
 * 检测串锚定 `schema: looseObjectOutput` 使用形态。
 * 身份注释吸收自 lead 2d301c7b 版守卫（fileGuard/bridge 非盘点 18 清单
 * 工具的真实归属）。
 */
const KNOWN_LEGACY_REFS: Readonly<Record<string, [number, string]>> = {
  "fileFace.ts": [4, "atf_run_list / atf_report_read / atf_metrics_compare / atf_gpu_status"],
  "attachmentsFace.ts": [1, "atf_attachments_assembly"],
  "jointTrainFace.ts": [1, "atf_joint_train"],
  "prelaunchFace.ts": [1, "atf_prelaunch_report"],
  "recordsFace.ts": [1, "atf_records_query"],
  "quantizeFace.ts": [1, "atf_quantize_annotations"],
  "bridgeFace.ts": [1, "label-qc resolve 卡工具（agent 可见）"],
  "fileGuardFace.ts": [1, "FILE_TOOL_DEFINITIONS 文件工具族（atf_read/write/edit/bash 等）"],
};

/** 本批次结构化声明的工具：output 块内必须带 properties（声明面存在性）。 */
const DECLARED_TOOLS: ReadonlyArray<{ tool: string; file: string }> = [
  { tool: "atf_config_confirm", file: "confirmFace.ts" },
  { tool: "atf_publish_confirm", file: "confirmFace.ts" },
  { tool: "atf_pipeline_stage", file: "pipelineFace.ts" },
  { tool: "atf_training_preflight", file: "preflightFace.ts" },
  { tool: "atf_run_training", file: "trainingFace.ts" },
  { tool: "atf_publish_model", file: "trainingFace.ts" },
  { tool: "atf_evaluate", file: "trainingFace.ts" },
  { tool: "atf_analyze_badcases", file: "trainingFace.ts" },
  { tool: "atf_hello", file: "index.ts" },
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

/** 对一段源码文本检测 looseObjectOutput 引用使用位，返回命中片段列表。 */
export function findLooseRefUsages(text: string): string[] {
  return [...text.matchAll(LOOSE_REF_USAGE)].map((match) => match[0]);
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
  it("atf-tools 源码不存在无 properties 的裸开放 output schema（inline 形态为零）", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      hits.push(...findBareOpenOutputs(readFileSync(file, "utf8")).map((fragment) => `${file.split("/").pop()}: ${fragment}`));
    }
    expect(hits).toEqual([]);
  });

  it("looseObjectOutput 引用仅存于已登记的存量工具位（新增即失败）", () => {
    const files = listSourceFiles(SRC_ROOT);
    const refsByFile: Record<string, number> = {};
    for (const file of files) {
      const count = findLooseRefUsages(readFileSync(file, "utf8")).length;
      if (count > 0) refsByFile[file.split("/").pop() as string] = count;
    }
    // 文件集与逐文件计数精确匹配——变多=新腐化（新代码禁用该常量），
    // 变少=存量已修、登记待清（清零后本断言与常量一起退役）
    expect(Object.keys(refsByFile).sort()).toEqual(Object.keys(KNOWN_LEGACY_REFS).sort());
    for (const [file, [expected, note]] of Object.entries(KNOWN_LEGACY_REFS)) {
      expect(refsByFile[file] ?? 0, `${file} 的 looseObjectOutput 引用计数应恰为 ${expected}（${note}）`).toBe(expected);
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
    // 引用形态检测器：使用位命中、import 行与结构化声明不命中
    expect(findLooseRefUsages("      schema: looseObjectOutput,\n").length).toBe(1);
    expect(findLooseRefUsages('import { looseObjectOutput, renderAsJsonText } from "./schemaTranslate.js";\n')).toEqual([]);
    expect(findLooseRefUsages(declared)).toEqual([]);
  });

  it("已结构化工具的 output 块内均带 properties（声明面存在，防回退为裸开放）", () => {
    for (const { tool, file } of DECLARED_TOOLS) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      const slice = toolDefinitionSlice(text, tool);
      expect(slice, `${tool} 的定义片段应含 output 块`).toContain("output:");
      expect(slice, `${tool}（${file}）的 output schema 应带 properties——裸开放形态=agent 视角黑盒`).toContain("properties:");
    }
  });
});
