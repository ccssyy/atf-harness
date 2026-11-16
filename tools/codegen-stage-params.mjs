#!/usr/bin/env node
// A6 桥参数 schema 生成化一期(1116 发现 15 桥面/总案⑥):内核 argparse_surface.json
// (D94 契约快照,tools/generate_argparse_surface.py 产物)唯一源 → harness 生成物。
// 一期=参数名/类型/必填面(描述类字段缺口挂二期,候裁动作许可——argparse help 文本
// 不进一期生成物)。描述面(工具 description)仍手写,对账面只对参数结构。
// 内核路径取 ATF_KERNEL_SOURCE(单版本源门同源 env);生成物不入手改,重生成:
//   npm run codegen:stage-params
// 漂移防护:prebuild 断言 git diff --exit-code(内核参数变更未重生成即红)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const kernelRoot = process.env.ATF_KERNEL_SOURCE;
if (!kernelRoot) {
  console.error(
    "ATF_KERNEL_SOURCE 未设置——内核仓根须 env 注入(与单版本源门同源);" +
      "设置后重跑 npm run codegen:stage-params"
  );
  process.exit(2);
}

const surfacePath = resolve(kernelRoot, "tools/argparse_surface.json");
const surface = JSON.parse(readFileSync(surfacePath, "utf-8"));
const entry = surface.find(
  (e) => typeof e?.script === "string" && e.script.endsWith("walkthrough_pipeline.py"),
);
if (!entry || !Array.isArray(entry.args) || entry.args.length < 20) {
  console.error(`argparse_surface 无 walkthrough_pipeline 条目或参数面异常: ${surfacePath}`);
  process.exit(2);
}
const params = entry.args.map((a) => ({
  option: String(a.option),
  dest: String(a.dest),
  action: String(a.action ?? "store"),
  type: a.type ?? null,
  choices: Array.isArray(a.choices) ? a.choices : null,
  default: a.default === undefined ? null : a.default,
  required: a.required === true,
}));
if (params.length < 20 || !params.some((p) => p.dest === "workspace")) {
  console.error("walkthrough 参数面缺核心参数(workspace)——argparse_surface 过期?");
  process.exit(2);
}

const banner =
  "// 自动生成(A6 桥参数 codegen 一期)——内核 argparse_surface.json 唯一源,请勿手改;\n" +
  "// 重生成: npm run codegen:stage-params (源=ATF_KERNEL_SOURCE/tools/argparse_surface.json)\n" +
  "// 一期=参数名/类型/必填面(结构对账);描述面仍手写(二期,候裁动作许可)。\n";
const body = JSON.stringify({ script: entry.script, params });
const ts =
  `${banner}` +
  `export interface StageCliParam { option: string; dest: string; action: string; type: string | null; choices: readonly string[] | null; default: unknown; required: boolean; }\n` +
  `export interface StageCliParamsDoc { script: string; params: readonly StageCliParam[]; }
export const STAGE_CLI_PARAMS: StageCliParamsDoc = ${body};\n`;
const js = `${banner}export const STAGE_CLI_PARAMS = ${body};\n`;

const dir = "src/core/generated";
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/stageParams.ts`, ts, "utf-8");
writeFileSync(`${dir}/stageParams.js`, js, "utf-8");
console.log(
  `stage-params codegen 一期 ok: ${params.length} 参数 → ${dir}/stageParams.ts + .js`,
);
