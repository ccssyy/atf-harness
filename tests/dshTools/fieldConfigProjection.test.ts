// -*- coding: utf-8 -*-
// StageIoContract 切片 2·C7（2a 前置）：回执投影补洞纯函数测试。
// 断点实锚：内核捕获孙进程 ValueError 后只写落盘 summary 的 raw_response.field_config、
// 不回显自身 stderr → 扩展层 stderr 提取恒 null → agent 回执丢 how_to_fix/skeleton
// （1112 真机 agent 三轮试错同根）。修法=从已解析的落盘 summary 直接提取。
import { describe, expect, it } from "vitest";
import { summaryFieldConfigErrorOf } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const SUMMARY_WITH_FC = {
  schema_version: "WalkthroughPipelineReport/v1",
  results: [
    {
      stage: "experiment_setup",
      status: "blocked",
      reason_codes: ["field_config_invalid"],
      missing: ["字段配置不合契约:缺顶层键 template"],
      raw_response: {
        field_config: {
          error: "field_config_invalid",
          missing_top: ["template"],
          how_to_fix: "先走素材装配七步产出字段配置草案…",
          skeleton: { template: "<string: 抽取模板>" },
        },
      },
    },
  ],
};

describe("summaryFieldConfigErrorOf（C7 投影补洞）", () => {
  it("summary.results[].raw_response.field_config 在场 → 提取（agent 回执可拿 how_to_fix）", () => {
    const fc = summaryFieldConfigErrorOf(SUMMARY_WITH_FC);
    expect(fc).not.toBeNull();
    expect(fc?.how_to_fix).toContain("七步");
    expect(fc?.skeleton).toBeDefined();
  });

  it("summary 无 results / raw_response 缺席 → null（回落 stderr 兜底面）", () => {
    expect(summaryFieldConfigErrorOf({ schema_version: "WalkthroughPipelineReport/v1" })).toBeNull();
    expect(summaryFieldConfigErrorOf({ results: [{ stage: "register", status: "ok" }] })).toBeNull();
    expect(summaryFieldConfigErrorOf(null)).toBeNull();
    expect(summaryFieldConfigErrorOf("not-object")).toBeNull();
  });

  it("多段 results 取首个带 field_config 的条目（blocked 段即目标）", () => {
    const doc = {
      results: [
        { stage: "experiment_setup", status: "blocked", raw_response: { other: 1 } },
        { stage: "experiment_setup", status: "blocked", raw_response: { field_config: { error: "field_config_invalid", how_to_fix: "x" } } },
      ],
    };
    expect(summaryFieldConfigErrorOf(doc)?.how_to_fix).toBe("x");
  });
});
