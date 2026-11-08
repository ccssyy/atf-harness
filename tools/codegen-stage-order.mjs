#!/usr/bin/env node
// R1 段序 codegen:内核 STAGE_ORDER 唯一源 → harness 生成物(ts+js 双产物)。
// 内核路径取 ATF_KERNEL_SOURCE(单版本源门同源 env);生成物不入手改,重生成:
//   npm run codegen:stage-order
// 漂移防护:prebuild 断言 git diff --exit-code(内核段序变更未重生成即红)。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const kernelRoot = process.env.ATF_KERNEL_SOURCE;
if (!kernelRoot) {
  console.error(
    "ATF_KERNEL_SOURCE 未设置——内核仓根须 env 注入(与单版本源门同源);" +
      "设置后重跑 npm run codegen:stage-order"
  );
  process.exit(2);
}
const script = resolve(
  kernelRoot,
  "skills/atf-admit-training-data/scripts/walkthrough_pipeline.py"
);
const out = execFileSync("python3", [script, "--print-stage-order"], {
  encoding: "utf-8",
  timeout: 60_000,
});
const stages = JSON.parse(out);
if (!Array.isArray(stages) || stages.length < 3 || stages.some((s) => typeof s !== "string")) {
  console.error(`内核段序输出形态非法: ${out.slice(0, 200)}`);
  process.exit(2);
}

const banner =
  "// 自动生成(R1 段序 codegen)——内核 STAGE_ORDER 唯一源,请勿手改;\n" +
  "// 重生成: npm run codegen:stage-order (源=ATF_KERNEL_SOURCE 内核仓 CLI)\n";
const body = JSON.stringify(stages);
const ts = `${banner}export const KERNEL_STAGE_ORDER: readonly string[] = ${body};\n`;
const js = `${banner}export const KERNEL_STAGE_ORDER = ${body};\n`;

const dirTs = "src/core/generated";
mkdirSync(dirTs, { recursive: true });
writeFileSync(`${dirTs}/stageOrder.ts`, ts, "utf-8");
writeFileSync(`${dirTs}/stageOrder.js`, js, "utf-8");
console.log(`stage-order codegen ok: ${stages.length} 段 → ${dirTs}/stageOrder.ts + .js`);
