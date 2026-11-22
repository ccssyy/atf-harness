import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 工具面自描述守卫（2026-11-21「工具面自描述补全」批次建立；2026-11-22 A1 清退批收口）。
 *
 * defineTool 的 output.schema 由 dsh-system-prompt 自动组装进 agent prompt——
 * 是 agent 知道「会收到什么结构」的唯一来源。「无 properties 的裸开放
 * output schema」（{type:"object", additionalProperties:true} 且无 properties
 * 键）等同未声明＝agent 视角黑盒，本守卫禁止其存在于 atf-tools 源码。
 *
 * 检测形态＝单行字面量 `schema: { type: "object", additionalProperties: true }`
 * 后紧跟 `,` 或 `}`（render 单行 / output 块收口两种排布均命中）——断言为零。
 * `looseObjectOutput` 常量（schemaTranslate.ts）曾以 `schema: looseObjectOutput`
 * 引用形态承载 11 个工具位的裸开放声明——A1 批逐位结构化后清零、常量已删；
 * 本守卫对引用形态保持零断言（任何回潮引用即失败）。
 */

const SRC_ROOT = join(process.cwd(), "packages", "extensions", "atf-tools", "src");

/** 裸开放 output schema 的检测正则（单行形态，global）。 */
const BARE_OPEN_OUTPUT =
  /schema:\s*\{\s*type:\s*"object"\s*,\s*additionalProperties:\s*true\s*\}\s*[,}]/g;

/** looseObjectOutput 引用使用位的检测正则（schema: looseObjectOutput）。 */
const LOOSE_REF_USAGE = /schema:\s*looseObjectOutput\b/g;

/** 本批次结构化声明的工具：output 块内必须带 properties（声明面存在性）。
 *  A1 批（2026-11-22）清退 11 位：9 个字面量 name 工具入本表；fileGuardFace
 *  （FILE_TOOL_DEFINITIONS 循环挂载）与 bridgeFace（BRIDGE_TOOL_NAMES 循环挂载）
 *  两位的 name 为动态表达式（definition.name），toolDefinitionSlice 锚不到字面量
 *  ——由「循环挂载面」断言单独覆盖。 */
const DECLARED_TOOLS: ReadonlyArray<{ tool: string; file: string }> = [
  { tool: "atf_config_confirm", file: "confirmFace.ts" },
  { tool: "atf_publish_confirm", file: "confirmFace.ts" },
  { tool: "atf_pipeline_stage", file: "pipelineFace.ts" },
  { tool: "atf_training_preflight", file: "preflightFace.ts" },
  { tool: "atf_run_training", file: "trainingFace.ts" },
  { tool: "atf_publish_model", file: "trainingFace.ts" },
  { tool: "atf_evaluate", file: "trainingFace.ts" },
  { tool: "atf_analyze_badcases", file: "trainingFace.ts" },
  // ── A1 批清退位（2026-11-22）──
  { tool: "atf_run_list", file: "fileFace.ts" },
  { tool: "atf_report_read", file: "fileFace.ts" },
  { tool: "atf_metrics_compare", file: "fileFace.ts" },
  { tool: "atf_gpu_status", file: "fileFace.ts" },
  { tool: "atf_attachments_assembly", file: "attachmentsFace.ts" },
  { tool: "atf_joint_train", file: "jointTrainFace.ts" },
  { tool: "atf_prelaunch_report", file: "prelaunchFace.ts" },
  { tool: "atf_records_query", file: "recordsFace.ts" },
  { tool: "atf_quantize_annotations", file: "quantizeFace.ts" },
];

/** 循环挂载面（一位多工具、name 为动态表达式）：文件级声明面存在性。 */
const LOOP_MOUNTED_FACES: ReadonlyArray<{ face: string; file: string; note: string }> = [
  { face: "BRIDGE_TOOL_NAMES 桥接面", file: "bridgeFace.ts", note: "label-qc resolve 卡工具等" },
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

  it("looseObjectOutput 引用为零（A1 批清退后常量已删——任何引用即回潮失败）", () => {
    const files = listSourceFiles(SRC_ROOT);
    const hits: string[] = [];
    for (const file of files) {
      hits.push(...findLooseRefUsages(readFileSync(file, "utf8")).map((fragment) => `${file.split("/").pop()}: ${fragment}`));
    }
    expect(hits).toEqual([]);
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

  it("循环挂载面（一位多工具）的 output schema 块带 properties（声明面存在）", () => {
    for (const { face, file, note } of LOOP_MOUNTED_FACES) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      // 循环挂载面唯一的 output 块即共享 schema 声明——文件级锚定足够
      // （fileGuardFace/bridgeFace 的 name 为 definition.name 动态表达式，
      //  无法按工具名切片；本断言与「inline 裸形态为零」互为犄角）。
      const outputAt = text.indexOf("output: {");
      expect(outputAt, `${face}（${file}）应含 output 块`).toBeGreaterThanOrEqual(0);
      const schemaAt = text.indexOf("schema: {", outputAt);
      expect(schemaAt, `${face}（${file}）的 output 块应含 schema 声明`).toBeGreaterThan(outputAt);
      const renderAt = text.indexOf("render:", schemaAt);
      const schemaSlice = text.slice(schemaAt, renderAt > schemaAt ? renderAt : undefined);
      expect(schemaSlice, `${face}（${file}，${note}）的 output schema 应带 properties——裸开放形态=agent 视角黑盒`).toContain("properties:");
    }
  });
});
