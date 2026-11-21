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
 * 后紧跟 `,` 或 `}`（render 单行 / output 块收口两种排布均命中）。
 * `looseObjectOutput` 常量引用形态（schemaTranslate.ts）仍在 12 个存量工具位
 * 使用——字面量检测器抓不到引用，其处置待批次裁定；本守卫当前覆盖 inline
 * 形态清零 + 已结构化工具的 properties 存在性（防回退）。
 */

const SRC_ROOT = join(process.cwd(), "packages", "extensions", "atf-tools", "src");

/** 裸开放 output schema 的检测正则（单行形态，global）。 */
const BARE_OPEN_OUTPUT =
  /schema:\s*\{\s*type:\s*"object"\s*,\s*additionalProperties:\s*true\s*\}\s*[,}]/g;

/**
 * 已知残留：无——inline 裸形态已全部清零（本批 6 目标 + lead 扩边的
 * publish_confirm/publish_model）。`looseObjectOutput` 常量引用形态的
 * 存量缺口（12 个工具位）待 lead 裁定处置方案后补充对应断言。
 */

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
  it("atf-tools 源码不存在无 properties 的裸开放 output schema（inline 形态为零）", () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      hits.push(...findBareOpenOutputs(readFileSync(file, "utf8")).map((fragment) => `${file.split("/").pop()}: ${fragment}`));
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
  });

  it("已结构化工具的 output 块内均带 properties（声明面存在，防回退为裸开放）", () => {
    for (const { tool, file } of DECLARED_TOOLS) {
      const text = readFileSync(join(SRC_ROOT, file), "utf8");
      const slice = toolDefinitionSlice(text, tool);
      expect(slice, `${tool} 的定义片段应含 output 块`).toContain("output:");
      expect(slice, `${tool}（${file}）的 output schema 应带 properties——裸开放形态=agent 视角黑盒`).toContain("properties:");
    }
  });

  // 显式存量清单（2026-11-21 批裁定 A）：looseObjectOutput 引用位按文件精确计数，
  // 漂移（新增/清退未同步本清单）即红——报错点名文件。新代码禁用该常量（@deprecated）。
  const KNOWN_LOOSE_SITES: ReadonlyArray<{ readonly file: string; readonly count: number; readonly note: string }> = [
    { file: "fileFace.ts", count: 4, note: "atf_run_list / atf_report_read / atf_metrics_compare / atf_gpu_status" },
    { file: "fileGuardFace.ts", count: 1, note: "FILE_TOOL_DEFINITIONS 文件工具族（atf_read/write/edit/bash 等）" },
    { file: "attachmentsFace.ts", count: 1, note: "atf_attachments_assembly" },
    { file: "jointTrainFace.ts", count: 1, note: "atf_joint_train" },
    { file: "prelaunchFace.ts", count: 1, note: "atf_prelaunch_report" },
    { file: "recordsFace.ts", count: 1, note: "atf_records_query" },
    { file: "quantizeFace.ts", count: 1, note: "atf_quantize_annotations" },
    { file: "bridgeFace.ts", count: 1, note: "label-qc resolve 卡工具（agent 可见）" },
  ];

  it("looseObjectOutput 引用位＝显式存量清单（按文件精确计数，漂移即红）", () => {
    const totalExpected = KNOWN_LOOSE_SITES.reduce((sum, s) => sum + s.count, 0);
    const usageRe = /schema:\s*looseObjectOutput,/g;
    let totalActual = 0;
    const perFileActual = new Map<string, number>();
    for (const entry of readdirSync(SRC_ROOT)) {
      if (!entry.endsWith(".ts")) continue;
      const text = readFileSync(join(SRC_ROOT, entry), "utf8");
      const n = (text.match(usageRe) ?? []).length;
      if (n > 0) { perFileActual.set(entry, n); totalActual += n; }
    }
    expect(totalActual, `looseObjectOutput 引用位总数应为 ${String(totalExpected)}（显式清单）——实得 ${String(totalActual)}，见逐文件差异`).toBe(totalExpected);
    for (const site of KNOWN_LOOSE_SITES) {
      expect(perFileActual.get(site.file) ?? 0,
        `${site.file} 的 looseObjectOutput 引用数应为 ${String(site.count)}（${site.note}）——清单与代码漂移，双向都要同步`).toBe(site.count);
    }
    for (const [file, n] of perFileActual) {
      const known = KNOWN_LOOSE_SITES.find((s) => s.file === file);
      expect(known, `${file} 出现 ${String(n)} 处 looseObjectOutput 引用但不在存量清单——新代码禁用该常量（@deprecated）`).toBeDefined();
    }
  });
});
