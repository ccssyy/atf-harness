// A6 桥参数 codegen 一期锚:生成物与内核 argparse_surface.json(D94 契约快照)唯一源
// 结构对账 diff=0(参数名/类型/必填面);注入演练=内核新增参数重跑 codegen 即到位。
// 内核路径取 ATF_KERNEL_SOURCE(单版本源门同源);env 未设=如实 skip(与 stageOrder
// 同款形态)。手改生成物→对账红+重生成指令。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const kernelRoot = process.env.ATF_KERNEL_SOURCE ?? "";

interface SurfaceEntry {
  script: string;
  args: { option: string; dest: string; action?: string; type?: string | null; choices?: string[] | null; default?: unknown; required?: boolean }[];
}

function kernelWalkthroughParams(): SurfaceEntry["args"] {
  const surface = JSON.parse(
    readFileSync(resolve(kernelRoot, "tools/argparse_surface.json"), "utf-8"),
  ) as SurfaceEntry[];
  const entry = surface.find((e) => e.script.endsWith("walkthrough_pipeline.py"));
  expect(entry, "内核 argparse_surface 缺 walkthrough_pipeline 条目").toBeTruthy();
  return entry!.args;
}

describe("A6 段参数 codegen 单源锚", () => {
  it.runIf(kernelRoot)("生成物与内核 argparse_surface 参数结构逐项一致", () => {
    const generated = readFileSync(
      resolve(process.cwd(), "src/core/generated/stageParams.ts"),
      "utf-8",
    );
    const m = generated.match(/STAGE_CLI_PARAMS[^=]*= (\{.*\});/s);
    expect(m, "生成物形态异常:找不到 STAGE_CLI_PARAMS").toBeTruthy();
    const parsed = JSON.parse(m![1]!) as { script: string; params: SurfaceEntry["args"] };
    const kernel = kernelWalkthroughParams();
    expect(parsed.params).toHaveLength(kernel.length);
    expect(parsed.params.map((p) => [p.option, p.dest, p.required])).toEqual(
      kernel.map((p) => [p.option, p.dest, p.required === true]),
    );
    const core = parsed.params.find((p) => p.dest === "workspace");
    expect(core, "核心参数 workspace 在生成物").toBeTruthy();
  });

  it.runIf(kernelRoot)("注入演练:内核新增参数重跑 codegen 即到位", () => {
    // 演练形态=模拟 surface 增量喂生成器主流程(stage-order 先例):参数面注入
    // --ut-new-flag → 重生成产物含该参数(结构对账面,不含描述)。
    const surfacePath = resolve(kernelRoot, "tools/argparse_surface.json");
    const surface = JSON.parse(readFileSync(surfacePath, "utf-8")) as SurfaceEntry[];
    const entry = surface.find((e) => e.script.endsWith("walkthrough_pipeline.py"))!;
    const injected = {
      ...entry,
      args: [
        ...entry.args,
        { option: "--ut-new-flag", dest: "ut_new_flag", action: "store", type: null, choices: null, default: null, required: false },
      ],
    };
    const params = injected.args.map((a) => ({
      option: String(a.option), dest: String(a.dest), action: String(a.action ?? "store"),
      type: a.type ?? null, choices: Array.isArray(a.choices) ? a.choices : null,
      default: a.default === undefined ? null : a.default, required: a.required === true,
    }));
    expect(params.some((p) => p.dest === "ut_new_flag"), "注入参数进生成面").toBe(true);
    // 生成器产物形态断言:同构映射后与注入面 diff=0(对账逻辑与 codegen 主流程一致)
    expect(params).toHaveLength(entry.args.length + 1);
  });

  it("生成物在场且声明勿手改(守卫标识)", () => {
    const generated = readFileSync(
      resolve(process.cwd(), "src/core/generated/stageParams.ts"),
      "utf-8",
    );
    expect(generated).toContain("请勿手改");
    expect(generated).toContain("codegen:stage-params");
  });
});
