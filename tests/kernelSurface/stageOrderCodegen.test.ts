// R1 段序 codegen 锚:生成物与内核 STAGE_ORDER 唯一源 diff=0(结构单源机检面)。
// 内核路径取 ATF_KERNEL_SOURCE(单版本源门同源);env 未设=如实 skip(与
// check_surface_fixture_parity 同款形态)。手改生成物→本锚红+重生成指令。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "";

function kernelStageOrder(): string[] {
  const script = resolve(
    kernelRoot,
    "skills/atf-admit-training-data/scripts/walkthrough_pipeline.py",
  );
  const out = execFileSync("python3", [script, "--print-stage-order"], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  return JSON.parse(out) as string[];
}

describe("R1 段序 codegen 单源锚", () => {
  it.runIf(kernelRoot)("生成物 stageOrder.ts 与内核 CLI 输出逐项一致", () => {
    const generated = readFileSync(
      resolve(process.cwd(), "src/core/generated/stageOrder.ts"),
      "utf-8",
    );
    const m = generated.match(/KERNEL_STAGE_ORDER[^=]*= (\[.*\]);/s);
    expect(m, "生成物形态异常:找不到 KERNEL_STAGE_ORDER 数组").toBeTruthy();
    expect(JSON.parse(m![1])).toEqual(kernelStageOrder());
  });

  it.runIf(kernelRoot)("六载体消费的导出值与内核一致(经生成物 import 链)", async () => {
    const kernel = kernelStageOrder();
    const mod = await import("../../../src/core/generated/stageOrder.js");
    expect([...mod.KERNEL_STAGE_ORDER]).toEqual(kernel);
    expect(mod.KERNEL_STAGE_ORDER).toHaveLength(9);
  });

  it("env 未设时如实提示(不静默绿)", () => {
    if (!kernelRoot) {
      console.info("ATF_KERNEL_SOURCE 未设置——codegen 单源对账 skip(单版本源门同源 env)");
    }
    expect(true).toBe(true);
  });
});
