/**
 * D89 测试锚——atf_pipeline_stage 分组方案透传（指令《ATF_指令_参数面增补_harness_
 * 20261023》sha b28887e02434 §一.1；内核事实＝walkthrough_pipeline argparse 已声明的
 * --grouping-preset A/B，缺省 B，仅 experiment_setup 段消费）。
 *
 * 覆盖（§一.1 分组确认可达）：
 *   A/B 逐值透传（仅 experiment_setup 段 argv 含 --grouping-preset）；未给 → argv 无该参
 *   （内核缺省 B 生效）＋返回体 grouping_preset="B"／grouping_preset_source="kernel_default"
 *   （「缺省不静默」）；显式给 → source="explicit"；非 experiment_setup 段给了也不出现在
 *   argv 且返回体无两键；审批卡 reason 含分组方案行（显式与缺省两形态）；参数 schema
 *   enum 闭集与 GROUPING_PRESET_VALUES 在位；描述不写死示例。
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（stdout JSON＋argv 回显，八段闭集）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPipelineTool,
  GROUPING_PRESET_VALUES,
  groupingPresetApprovalLine,
} from "../../packages/extensions/atf-tools/src/pipelineFace.js";

interface DshToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}
const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "d89d93-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fakeExec = { agent: undefined, callId: "d89d93-call", signal: undefined };
// 审批 ctx：放行并记录 reason 原文（审批卡分组方案行断言面）
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

describe("D89——grouping_preset 透传（experiment_setup 段）", () => {
  it("A/B 逐值透传：experiment_setup 段 argv 含 --grouping-preset <值>；返回体 source=explicit", async () => {
    for (const value of GROUPING_PRESET_VALUES) {
      const result = (await toolOf().execute(
        { stage: "experiment_setup", run_id: `d89-${value}`, workspace_path: tempRoot(), grouping_preset: value },
        fakeExec,
      )) as Record<string, unknown>;
      expect((result as Record<string, unknown>)["ok"]).toBe(true);
      const argv = summaryArgv(result);
      expect(argv[argv.indexOf("--grouping-preset") + 1]).toBe(value);
      expect((result as Record<string, unknown>)["grouping_preset"]).toBe(value);
      expect((result as Record<string, unknown>)["grouping_preset_source"]).toBe("explicit");
    }
  });
  it("未给 → argv 无该参（按未给处理，内核缺省 B 生效）＋返回体标注 kernel_default 的 B（缺省不静默）", async () => {
    const result = (await toolOf().execute(
      { stage: "experiment_setup", run_id: "d89-omit", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    const argv = summaryArgv(result);
    expect(argv).not.toContain("--grouping-preset");
    expect((result as Record<string, unknown>)["grouping_preset"]).toBe("B");
    expect((result as Record<string, unknown>)["grouping_preset_source"]).toBe("kernel_default");
  });
  it("空白串 → 框架参数校验层拒（enum 校验先于 execute 的 trim 防御；审批零触达）", async () => {
    const approvals: string[] = [];
    await expect(
      toolOf(approvals).execute(
        { stage: "experiment_setup", run_id: "d89-blank", workspace_path: tempRoot(), grouping_preset: "  " },
        fakeExec,
      ),
    ).rejects.toThrow(/grouping_preset/);
    expect(approvals).toHaveLength(0);
  });
  it("非 experiment_setup 段（family_split）给了也不出现在 argv，且返回体无两键（仅 experiment_setup 加键）", async () => {
    const result = (await toolOf().execute(
      { stage: "family_split", run_id: "d89-other", workspace_path: tempRoot(), grouping_preset: "A" },
      fakeExec,
    )) as Record<string, unknown>;
    expect((result as Record<string, unknown>)["ok"]).toBe(true);
    expect(summaryArgv(result)).not.toContain("--grouping-preset");
    expect((result as Record<string, unknown>)["grouping_preset"]).toBeUndefined();
    expect((result as Record<string, unknown>)["grouping_preset_source"]).toBeUndefined();
  });
  it("非法值 → 框架参数校验层拒（enum 闭集；审批零触达）", async () => {
    const approvals: string[] = [];
    await expect(
      toolOf(approvals).execute(
        { stage: "experiment_setup", run_id: "d89-bad", workspace_path: tempRoot(), grouping_preset: "C" },
        fakeExec,
      ),
    ).rejects.toThrow(/grouping_preset/);
    expect(approvals).toHaveLength(0);
  });
});

describe("D89——审批卡分组方案呈现（reason 内追加一行，仅 experiment_setup 段）", () => {
  it("显式 A → 卡含「分组方案：A（3 组·按单据层级…）」；显式 B 同构", async () => {
    for (const value of ["A", "B"] as const) {
      const approvals: string[] = [];
      await toolOf(approvals).execute(
        { stage: "experiment_setup", run_id: `d89-card-${value}`, workspace_path: tempRoot(), grouping_preset: value },
        fakeExec,
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toContain(groupingPresetApprovalLine(value));
      expect(approvals[0]).toContain(
        value === "A"
          ? "分组方案：A（3 组·按单据层级：doc_identifier／page_summary／goods_item）"
          : "分组方案：B（2 组·单据级 vs 条目级：goods_item／doc_level）",
      );
    }
  });
  it("未给 → 卡含「分组方案：未指定——将按内核缺省 B（…）」（缺省不静默，卡上可见）", async () => {
    const approvals: string[] = [];
    await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "d89-card-def", workspace_path: tempRoot() },
      fakeExec,
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain(
      "分组方案：未指定——将按内核缺省 B（2 组·单据级 vs 条目级：goods_item／doc_level）",
    );
  });
  it("非 experiment_setup 段卡无分组方案行（该段该参无意义不上卡）", async () => {
    const approvals: string[] = [];
    await toolOf(approvals).execute(
      { stage: "label_qc", run_id: "d89-card-lq", workspace_path: tempRoot(), grouping_preset: "A" },
      fakeExec,
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).not.toContain("分组方案：");
  });
  it("groupingPresetApprovalLine 纯函数：A/B 两形态＋未指定形态直测（文案单源）", () => {
    expect(groupingPresetApprovalLine("A")).toBe("分组方案：A（3 组·按单据层级：doc_identifier／page_summary／goods_item）");
    expect(groupingPresetApprovalLine("B")).toBe("分组方案：B（2 组·单据级 vs 条目级：goods_item／doc_level）");
    expect(groupingPresetApprovalLine("")).toBe(
      "分组方案：未指定——将按内核缺省 B（2 组·单据级 vs 条目级：goods_item／doc_level）",
    );
  });
});

describe("D89——参数面 schema 与描述红线（不写死示例）", () => {
  it("GROUPING_PRESET_VALUES 闭集在位；参数 schema enum 同源；工具描述含关键句", () => {
    expect(GROUPING_PRESET_VALUES).toEqual(["A", "B"]);
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; enum?: string[] }> }).properties ?? {};
    expect(props["grouping_preset"]?.type).toBe("string");
    expect(props["grouping_preset"]?.enum).toEqual(["A", "B"]);
    const desc = String(props["grouping_preset"]?.description);
    expect(desc).toContain("仅 experiment_setup 段有意义");
    expect(desc).toContain("A＝3 组·按单据层级");
    expect(desc).toContain("B＝2 组·单据级 vs 条目级");
    expect(desc).toContain("内核缺省 B");
    expect(tool.description).toContain("grouping_preset");
    expect(tool.description).toContain("返回体如实标注分组来源");
  });
  it("描述不写死示例（红线）：参数描述与工具描述均无「grouping_preset='…'」式示例句", () => {
    const tool = toolOf();
    const desc = String(
      (tool.parameters as { properties?: Record<string, { description?: string }> }).properties?.["grouping_preset"]?.description,
    );
    for (const text of [desc, tool.description]) {
      expect(text).not.toMatch(/grouping_preset\s*[=＝:：]\s*["'「]?[AB]/);
      expect(text).not.toContain("如 grouping_preset");
    }
  });
});

