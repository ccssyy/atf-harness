// C4 mock 对账锚（1116 发现 6 根因二——mock 自洽当验证的根治面）：
// mock_pipeline_params.mjs 的 KNOWN 段闭集（静态字面量）↔ stageOrder.js 生成物
// （内核 STAGE_ORDER 唯一源 codegen 产物）diff=0——内核段序变更未随迁 mock 即红。
// 演练：注入形态（模拟内核新增段）喂对账语义必判不等——mock 不得自洽脱离内核契约。
// 附：mock 的 argv 透传面不校验参数（回显语义）——段参数契约的对账在
// stageParamsCodegen（argparse_surface 单源）+stageFaceParams（快照消费），
// 本锚补齐段闭集这一环。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { KERNEL_STAGE_ORDER } from "../../src/core/generated/stageOrder.js";

const readKnown = (): string[] => {
  const src = readFileSync(
    resolve(process.cwd(), "tests/fixtures/mock_pipeline_params.mjs"),
    "utf-8",
  );
  const m = src.match(/const KNOWN = (\[.*?\]);/s);
  expect(m, "mock KNOWN 数组形态异常").toBeTruthy();
  return JSON.parse(m![1]!) as string[];
};

describe("C4 mock 对端↔内核契约对账", () => {
  it("mock KNOWN 段闭集与 stageOrder 生成物（内核 STAGE_ORDER 产物）diff=0", () => {
    expect(readKnown()).toEqual([...KERNEL_STAGE_ORDER]);
  });

  it("演练：内核新增段未随迁 mock → 对账语义必判不等（注入形态）", () => {
    const known = readKnown();
    const injected = [...known, "ut_new_stage"];
    expect(injected).not.toEqual([...KERNEL_STAGE_ORDER]);
    expect(known).toEqual([...KERNEL_STAGE_ORDER]);
  });

  it("mock 文件保留对账指路注释（随迁义务可见）", () => {
    const src = readFileSync(
      resolve(process.cwd(), "tests/fixtures/mock_pipeline_params.mjs"),
      "utf-8",
    );
    expect(src).toContain("guardStageList");
  });
});
