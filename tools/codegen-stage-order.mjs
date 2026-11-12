#!/usr/bin/env node
// R1/G5 段序 codegen v2:内核 stage_registry.STAGE_ORDER_V2 唯一源 → harness 生成物。
// 双导出:KERNEL_STAGE_ORDER(walkthrough 管线 9 段,工具面 CLI 合同)+
// STAGE_REGISTRY_V2(17 段全段元数据,灯面/探针/卡片段键对齐源,ADR-0020)。
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

// v2:源=stage_registry(ADR-0020 全局单一段序);G1a 后 walkthrough 管线段序
// 与 v2 子序列同步派生(walkthrough_subset),双导出同一进程读单源。
const probe = `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(kernelRoot, "src"))})
from agentic_training_flow.application.stage_registry import STAGE_ORDER_V2, walkthrough_subset
print(json.dumps({
    "registry": [
        {"stage": e.stage, "label_zh": e.label_zh, "phase": e.phase, "skill_package": e.skill_package,
         "output_artifacts": [
             {"name": d.name, "schema_ref": d.schema_ref, "path_pattern": d.path_pattern}
             for d in e.output_artifacts
         ]}
        for e in STAGE_ORDER_V2
    ],
    "walkthrough": list(walkthrough_subset()),
}))
`;
const out = execFileSync("python3", ["-c", probe], { encoding: "utf-8", timeout: 60_000 });
const parsed = JSON.parse(out);
const registry = parsed.registry;
const walkthrough = parsed.walkthrough;
if (
  !Array.isArray(registry) ||
  registry.length < 10 ||
  !Array.isArray(walkthrough) ||
  walkthrough.length < 3 ||
  walkthrough.some((s) => typeof s !== "string")
) {
  console.error(`内核 stage_registry 输出形态非法: ${out.slice(0, 200)}`);
  process.exit(2);
}
const registryStages = registry.map((e) => e.stage);
for (const stage of walkthrough) {
  if (!registryStages.includes(stage)) {
    console.error(`walkthrough 子序列段不在 v2 表: ${stage}`);
    process.exit(2);
  }
}

const banner =
  "// 自动生成(R1/G5 段序 codegen v2)——内核 stage_registry.STAGE_ORDER_V2 唯一源,请勿手改;\n" +
  "// 重生成: npm run codegen:stage-order (源=ATF_KERNEL_SOURCE 内核仓 stage_registry)\n" +
  "// KERNEL_STAGE_ORDER=walkthrough 管线段序(工具面 CLI 合同);STAGE_REGISTRY_V2=17 段全段元数据(ADR-0020)+output_artifacts(StageIoContract C2 写时校验声明)\n";
const registryBody = JSON.stringify(registry);
const walkthroughBody = JSON.stringify(walkthrough);
const ts =
  `${banner}` +
  `export const STAGE_REGISTRY_V2: readonly { stage: string; label_zh: string; phase: number; skill_package: string; output_artifacts: readonly { name: string; schema_ref: string; path_pattern: string }[] }[] = ${registryBody};\n` +
  `export const STAGE_REGISTRY_ORDER: readonly string[] = ${JSON.stringify(registryStages)};\n` +
  `export const KERNEL_STAGE_ORDER: readonly string[] = ${walkthroughBody};\n`;
const js =
  `${banner}` +
  `export const STAGE_REGISTRY_V2 = ${registryBody};\n` +
  `export const STAGE_REGISTRY_ORDER = ${JSON.stringify(registryStages)};\n` +
  `export const KERNEL_STAGE_ORDER = ${walkthroughBody};\n`;

const dirTs = "src/core/generated";
mkdirSync(dirTs, { recursive: true });
writeFileSync(`${dirTs}/stageOrder.ts`, ts, "utf-8");
writeFileSync(`${dirTs}/stageOrder.js`, js, "utf-8");
console.log(
  `stage-order codegen v2 ok: ${registry.length} 段注册表 + ${walkthrough.length} 段管线 → ${dirTs}/stageOrder.ts + .js`,
);
