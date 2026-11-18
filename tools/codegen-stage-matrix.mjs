#!/usr/bin/env node
// D318 M2——段×参数矩阵 codegen（M1 内核单源 → harness 生成物）。
// 源=ATF_KERNEL_SOURCE/src stage_registry（python3 -c 派生口直读，与段序 codegen 同模式）；
// 生成物=src/core/generated/stageMatrix.ts/.js；漂移防护=prebuild 断言 git diff --exit-code
// （单源变更不重新生成即红）。SOURCE_ROOT_ARGV_STAGES 手写形态退役（M6 预演实锚的
// 单源门真红=本批清偿对象）。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const kernelRoot = process.env.ATF_KERNEL_SOURCE;
if (!kernelRoot) {
  console.error("ATF_KERNEL_SOURCE 未设置——与单版本源门同源 env；设置后重跑 npm run codegen:stage-matrix");
  process.exit(2);
}
const out = execFileSync("python3", ["-c", `
import sys, json
sys.path.insert(0, "${kernelRoot}/src")
from agentic_training_flow.application.stage_registry import (
    STAGE_ORDER_V2, source_root_required_stages, stage_param_req_of)
rows = {
    "source_root_explicit": list(source_root_required_stages("explicit")),
    "source_root_recoverable": list(source_root_required_stages("recoverable")),
    "base_model_explicit": [e.stage for e in STAGE_ORDER_V2
        for r in e.param_requirements if r.param == "base_model_path" and r.mode == "explicit"],
}
print(json.dumps(rows))
`], { encoding: "utf-8", env: { ...process.env, PYTHONPATH: `${kernelRoot}/src` } });
const matrix = JSON.parse(out);

const banner =
  "// 自动生成(D318 M2 段×参数矩阵 codegen)——内核 stage_registry 唯一源,请勿手改;\n" +
  "// 重生成: npm run codegen:stage-matrix (源=ATF_KERNEL_SOURCE stage_registry)\n" +
  "// SOURCE_ROOT_ARGV_STAGES 手写形态退役(D317b 时代两仓各持一份的断裂温床根治)。\n";
const body = JSON.stringify(matrix);
const ts = `${banner}export interface StageMatrixDoc { source_root_explicit: readonly string[]; source_root_recoverable: readonly string[]; base_model_explicit: readonly string[]; }
export const STAGE_MATRIX: StageMatrixDoc = ${body};
export const SOURCE_ROOT_ARGV_STAGES: ReadonlySet<string> = new Set(STAGE_MATRIX.source_root_explicit);
export const SOURCE_ROOT_RECOVERABLE_STAGES: ReadonlySet<string> = new Set(STAGE_MATRIX.source_root_recoverable);\n`;
const js = `${banner}export const STAGE_MATRIX = ${body};
export const SOURCE_ROOT_ARGV_STAGES = new Set(STAGE_MATRIX.source_root_explicit);
export const SOURCE_ROOT_RECOVERABLE_STAGES = new Set(STAGE_MATRIX.source_root_recoverable);\n`;

const dir = "src/core/generated";
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/stageMatrix.ts`, ts, "utf-8");
writeFileSync(`${dir}/stageMatrix.js`, js, "utf-8");
console.log(
  `stage-matrix codegen ok: explicit ${matrix.source_root_explicit.length} 段 / recoverable ${matrix.source_root_recoverable.length} 段 → ${dir}/stageMatrix.ts + .js`,
);
