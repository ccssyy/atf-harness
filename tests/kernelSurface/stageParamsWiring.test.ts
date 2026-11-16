// A6 装接对账锚:codegen 生成物(STAGE_CLI_PARAMS)↔pipelineFace 手写参数声明面
// 结构对账——键集恒等。手写面漂移(新增/改名参数未随生成物)即红;A5 --unit-bindings
// 已入 pipelineFace 参数区(生成物对账的真实消费面);A2 lane 退役反向锚。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface StageCliParam {
  option: string;
  dest: string;
  required: boolean;
}

const loadGenerated = (): StageCliParam[] => {
  const src = readFileSync(
    resolve(process.cwd(), "src/core/generated/stageParams.ts"),
    "utf-8",
  );
  const m = src.match(/STAGE_CLI_PARAMS[^=]*= (\{.*\});/s);
  expect(m, "生成物形态异常").toBeTruthy();
  return JSON.parse(m![1]!).params as StageCliParam[];
};

const loadPipelineFaceDests = (): string[] => {
  const src = readFileSync(
    resolve(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts"),
    "utf-8",
  );
  const decl = src
    .split("\n")
    .find((line) => line.includes("args: { stage: string; run_id: string"));
  expect(decl, "pipelineFace 段参数声明行缺失").toBeTruthy();
  const inner = decl!.slice(
    decl!.indexOf("args: {") + "args: {".length,
    decl!.lastIndexOf("}"),
  );
  return inner
    .split(";")
    .map((chunk) => chunk.trim().split("?:")[0]!.split(":")[0]!.trim())
    .filter((key) => key !== "" && key !== "stage" && key !== "run_id");
};

describe("A6 codegen 生成物↔手写面装接对账", () => {
  const generated = loadGenerated();
  const faceDests = loadPipelineFaceDests();

  it("手写面透传键 ⊆ 生成物（内核 argv 面已声明）；harness 专有键须登记白名单", () => {
    const genDests = new Set(generated.map((p) => p.dest));
    // harness 专有键（非内核 argparse 透传——工具侧语义）闭集:新增须显式登记,漏登记=漏对账
    const HARNESS_LOCAL_KEYS = new Set([
      "workspace_path",       // 会话工作区根（harness 定位 run 用,不传内核）
      "base_model_path",      // K-E14a 本地目录形态（工具侧解析后转 --base-model）
      "pixel_pair_reason",    // D106 像素对确认话由（工具侧组装进基模型参数面）
      "prompt_material_hint", // D181 段内路由非透传键
      "visual_plan_only",     // 视觉计划态工具面开关（组合自内核双旗标）
    ]);
    const faceSet = new Set(faceDests);
    for (const key of faceSet) {
      if (HARNESS_LOCAL_KEYS.has(key)) continue;
      expect(
        genDests.has(key),
        `透传键 ${key} 不在生成物——内核 argv 未声明该旗标,真传必报 unrecognized（1109 跨仓断裂同族）`,
      ).toBe(true);
    }
  });

  it("A5 unit_bindings 装接锚：生成物与手写面均在案", () => {
    expect(generated.some((p) => p.dest === "unit_bindings"), "生成物含 --unit-bindings").toBe(true);
    expect(faceDests).toContain("unit_bindings");
    const face = readFileSync(
      resolve(process.cwd(), "packages/extensions/atf-tools/src/pipelineFace.ts"),
      "utf-8",
    );
    expect(face).toContain('--unit-bindings"');
  });

  it("A2 lane 退役锚：生成物与手写面均无 lane_suffix", () => {
    expect(generated.some((p) => p.dest === "lane_suffix")).toBe(false);
    expect(faceDests).not.toContain("lane_suffix");
  });
});
