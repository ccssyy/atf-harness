/**
 * D99 测试锚——atf_pipeline_stage 增 negative_ratio_target 透传（指令
 * 《ATF_指令_窗口B6_20261024》sha b24fa77d9c68 L-H1；内核事实＝walkthrough_pipeline
 * argparse 已声明的 --negative-ratio-target <下限,上限>，D90 用户确认值通路的 harness
 * 侧补派——此前九要素确认的负样本带到不了实验门）。
 *
 * 覆盖：
 *   显式值透传（仅 experiment_setup 段 argv 含 --negative-ratio-target，返回体
 *   negative_ratio_target=<值>／source="explicit"）；未给 → argv 无该参＋返回体
 *   negative_ratio_target="0.02,0.05"／source="kernel_default"（「缺省不静默」，常量带
 *   与内核 NEGATIVE_RATIO_CONSTRUCTION_BAND=(0.02,0.05) 同源）；空白串视同未给；
 *   非 experiment_setup 段给了也不出现在 argv 且返回体无两键；审批卡 reason 含负样本带
 *   行（显式与缺省两形态，其它段不上卡）；与 grouping_preset 并存透传互不干扰；
 *   negativeRatioApprovalLine 纯函数文案直测。
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（stdout JSON＋argv 回显，八段闭集）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPipelineTool,
  NEGATIVE_RATIO_DEFAULT_BAND,
  negativeRatioApprovalLine,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d99-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: undefined, callId: "d99-call", signal: undefined };
const approvalCtx = (record: string[]): { get(service: string): unknown } => ({
  get: (service: string) =>
    (service === "approval"
      ? { request: async (req: { reason: string }) => { record.push(req.reason); return "allowed-once"; } }
      : undefined),
});
const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
const toolOf = (record: string[] = []): DshToolLike =>
  buildPipelineTool(approvalCtx(record), `node ${MOCK}`, 30_000) as unknown as DshToolLike;

const summaryArgv = (result: unknown): string[] =>
  ((result as { summary?: { argv?: string[] } }).summary?.argv ?? []);

describe("D99——negative_ratio_target 透传（仅 experiment_setup 段）", () => {
  it("显式值透传：argv 含 --negative-ratio-target <值>；返回体值＋source=explicit", async () => {
    for (const value of ["0.03,0.06", "0.02,0.05"]) {
      const result = await toolOf().execute(
        { stage: "experiment_setup", run_id: `d99-${value}`, workspace_path: tempRoot(), negative_ratio_target: value },
        fakeExec,
      );
      expect(summaryArgv(result)).toContain("--negative-ratio-target");
      expect(summaryArgv(result)).toContain(value);
      expect((result as Record<string, unknown>)["negative_ratio_target"]).toBe(value);
      expect((result as Record<string, unknown>)["negative_ratio_target_source"]).toBe("explicit");
    }
  });

  it("未给 → argv 无该参＋返回体按常量带标注 kernel_default（缺省不静默）", async () => {
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "d99-absent", workspace_path: tempRoot() },
      fakeExec,
    );
    expect(summaryArgv(result)).not.toContain("--negative-ratio-target");
    expect((result as Record<string, unknown>)["negative_ratio_target"]).toBe(NEGATIVE_RATIO_DEFAULT_BAND);
    expect((result as Record<string, unknown>)["negative_ratio_target_source"]).toBe("kernel_default");
    expect(NEGATIVE_RATIO_DEFAULT_BAND).toBe("0.02,0.05"); // 与内核构造器常量带同源
  });

  it("空白串视同未给（trim 口径）——argv 不下传、返回体 kernel_default", async () => {
    const result = await toolOf().execute(
      { stage: "experiment_setup", run_id: "d99-blank", workspace_path: tempRoot(), negative_ratio_target: "  " },
      fakeExec,
    );
    expect(summaryArgv(result)).not.toContain("--negative-ratio-target");
    expect((result as Record<string, unknown>)["negative_ratio_target_source"]).toBe("kernel_default");
  });

  it("非 experiment_setup 段给了也不下传、返回体无两键", async () => {
    const result = await toolOf().execute(
      { stage: "family_split", run_id: "d99-other", workspace_path: tempRoot(), negative_ratio_target: "0.03,0.06" },
      fakeExec,
    );
    expect(summaryArgv(result)).not.toContain("--negative-ratio-target");
    expect((result as Record<string, unknown>)["negative_ratio_target"]).toBeUndefined();
    expect((result as Record<string, unknown>)["negative_ratio_target_source"]).toBeUndefined();
  });

  it("审批卡：负样本带行仅 experiment_setup 段呈现（显式与缺省两形态）", async () => {
    for (const value of ["0.03,0.06", ""]) {
      const record: string[] = [];
      await toolOf(record).execute(
        { stage: "experiment_setup", run_id: `d99-card-${value || "default"}`, workspace_path: tempRoot(), ...(value === "" ? {} : { negative_ratio_target: value }) },
        fakeExec,
      );
      expect(record[0]).toContain(negativeRatioApprovalLine(value));
    }
    const otherRecord: string[] = [];
    await toolOf(otherRecord).execute(
      { stage: "label_qc", run_id: "d99-card-lq", workspace_path: tempRoot(), negative_ratio_target: "0.03,0.06" },
      fakeExec,
    );
    expect(otherRecord[0]).not.toContain("负样本构造带");
  });

  it("negativeRatioApprovalLine 纯函数：显式与未指定两形态直测（文案单源）", () => {
    expect(negativeRatioApprovalLine("0.03,0.06")).toBe("负样本构造带：0.03,0.06（用户指定——实验门以该值锁定）");
    expect(negativeRatioApprovalLine("")).toBe("负样本构造带：未指定——将按构造器内置常量带（0.02,0.05）兜底");
  });

  it("与 grouping_preset 并存透传互不干扰（两参同段同下传）", async () => {
    const result = await toolOf().execute(
      {
        stage: "experiment_setup",
        run_id: "d99-with-d89",
        workspace_path: tempRoot(),
        grouping_preset: "A",
        negative_ratio_target: "0.03,0.06",
      },
      fakeExec,
    );
    const argv = summaryArgv(result);
    expect(argv).toContain("--grouping-preset");
    expect(argv).toContain("A");
    expect(argv).toContain("--negative-ratio-target");
    expect(argv).toContain("0.03,0.06");
    expect((result as Record<string, unknown>)["grouping_preset_source"]).toBe("explicit");
    expect((result as Record<string, unknown>)["negative_ratio_target_source"]).toBe("explicit");
  });

  it("参数 schema 在位：string 型无 enum（形态由内核实验门解析）且描述带形态示例", () => {
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }> }).properties ?? {};
    const param = props["negative_ratio_target"];
    expect(param).toBeDefined();
    expect(param?.["type"]).toBe("string");
    expect(param?.["enum"]).toBeUndefined();
    expect(String(param?.["description"])).toContain("<下限,上限>");
    expect(String(tool.description)).toContain("negative_ratio_target");
  });
});
