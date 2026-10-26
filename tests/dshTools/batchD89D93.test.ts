/**
 * D89/D93 测试锚——atf_pipeline_stage 参数面增补（指令《ATF_指令_参数面增补_harness_
 * 20261023》sha b28887e02434 §一.1/§一.4；内核事实＝walkthrough_pipeline argparse 已
 * 声明的 --grouping-preset／--train-all／--assignment-source／--reuse-experiment-setup）。
 *
 * D89 覆盖（§一.1 分组确认可达）：
 *   A/B 逐值透传（仅 experiment_setup 段 argv 含 --grouping-preset）；未给 → argv 无该参
 *   （内核缺省 B 生效）＋返回体 grouping_preset="B"／grouping_preset_source="kernel_default"
 *   （「缺省不静默」）；显式给 → source="explicit"；非 experiment_setup 段给了也不出现在
 *   argv 且返回体无两键；审批卡 reason 含分组方案行（显式与缺省两形态）；参数 schema
 *   enum 闭集与 GROUPING_PRESET_VALUES 在位；描述不写死示例。
 * D93 覆盖（§一.4 三参接入——只透传内核已声明参数，不新增语义）：
 *   train_all／assignment_source／reuse_experiment_setup——给才下传、缺省不出现；
 *   三参并存透传互不干扰；与既有段特定追加逻辑并存零回归（不按段 gate——内核全局参数）。
 * mock 对端＝tests/fixtures/mock_pipeline_params.mjs（stdout JSON＋argv 回显，八段闭集）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPipelineTool,
  GROUPING_PRESET_SHAPE,
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
  it("内核取值逐值透传：experiment_setup 段 argv 含 --grouping-preset <值>；返回体 source=explicit", async () => {
    // G2：harness 不再声明词表——这里用内核 argparse 实际接受的取值（测试数据）
    for (const value of ["A", "B"]) {
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
  it("空白串 → 视同未给（trim 后空串走缺省，不触框架拒收也不进 argv）", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "d89-blank", workspace_path: tempRoot(), grouping_preset: "  " },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(summaryArgv(result)).not.toContain("--grouping-preset");
    expect(result["grouping_preset_source"]).toBe("kernel_default");
    expect(approvals).toHaveLength(1);
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
  it("取值集合归内核：形状合法的任意标识都透传（不再由 harness 枚举拒收）", async () => {
    const approvals: string[] = [];
    const result = (await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "d89-any", workspace_path: tempRoot(), grouping_preset: "custom_recipe" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    expect(summaryArgv(result)[summaryArgv(result).indexOf("--grouping-preset") + 1]).toBe("custom_recipe");
    // 越界值由内核 argparse choices 拒绝（回流为内核错误），harness 不复制词表
    expect(approvals).toHaveLength(1);
  });
});

describe("D89——审批卡分组方案呈现（reason 内追加一行，仅 experiment_setup 段）", () => {
  it("显式 A/B → 卡含「分组方案：<标识>（候选方案由训练内核定义…）」", async () => {
    for (const value of ["A", "B"] as const) {
      const approvals: string[] = [];
      await toolOf(approvals).execute(
        { stage: "experiment_setup", run_id: `d89-card-${value}`, workspace_path: tempRoot(), grouping_preset: value },
        fakeExec,
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toContain(groupingPresetApprovalLine(value));
      // G2：卡面只报标识＋「候选由内核定义」，不复述组构成（测试样板字段名不进产品文案）
      expect(approvals[0]).toContain(`分组方案：${value}（候选方案由训练内核定义，组构成以内核产出为准）`);
      expect(approvals[0]).not.toContain("doc_identifier");
      expect(approvals[0]).not.toContain("goods_item");
    }
  });
  it("未给 → 卡含「分组方案：未指定——将由训练内核按其缺省方案处理」（缺省不静默，卡上可见）", async () => {
    const approvals: string[] = [];
    await toolOf(approvals).execute(
      { stage: "experiment_setup", run_id: "d89-card-def", workspace_path: tempRoot() },
      fakeExec,
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toContain("分组方案：未指定——将由训练内核按其缺省方案处理（组构成以内核产出为准）");
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
  it("groupingPresetApprovalLine 纯函数：给值／未给两形态直测（文案单源，零组名词汇）", () => {
    expect(groupingPresetApprovalLine("A")).toBe("分组方案：A（候选方案由训练内核定义，组构成以内核产出为准）");
    expect(groupingPresetApprovalLine("custom_recipe")).toBe("分组方案：custom_recipe（候选方案由训练内核定义，组构成以内核产出为准）");
    expect(groupingPresetApprovalLine("")).toBe("分组方案：未指定——将由训练内核按其缺省方案处理（组构成以内核产出为准）");
  });
});

describe("D89——参数面 schema 与描述红线（不写死示例）", () => {
  it("G2：参数 schema 无枚举（词表归内核）、描述零组名；形状校验在位并被消费", () => {
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }> }).properties ?? {};
    expect(props["grouping_preset"]?.type).toBe("string");
    expect(props["grouping_preset"]?.enum).toBeUndefined();
    const desc = String(props["grouping_preset"]?.description);
    expect(desc).toContain("仅 experiment_setup 段有意义");
    expect(desc).toContain("由训练内核声明");
    expect(tool.description).toContain("grouping_preset");
    expect(tool.description).toContain("返回体如实标注分组来源");
    // 组名零残留（工具描述＋参数描述两面）
    for (const text of [desc, tool.description]) {
      for (const name of ["doc_identifier", "page_summary", "goods_item", "doc_level"]) {
        expect(text).not.toContain(name);
      }
    }
    // 形状校验单源在位（1-32 位字母数字/下划线/连字符）
    expect(GROUPING_PRESET_SHAPE.test("A")).toBe(true);
    expect(GROUPING_PRESET_SHAPE.test("custom_recipe-2")).toBe(true);
    expect(GROUPING_PRESET_SHAPE.test("a b")).toBe(false);
    expect(GROUPING_PRESET_SHAPE.test("x".repeat(33))).toBe(false);
  });
  it("G2：形状不合即拒（grouping_preset_invalid，不静默纠正不猜缺省）", async () => {
    const result = (await toolOf().execute(
      { stage: "experiment_setup", run_id: "d89-shape", workspace_path: tempRoot(), grouping_preset: "a b" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(false);
    expect(result["error"]).toBe("grouping_preset_invalid");
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

describe("D93——三参透传（train_all／assignment_source／reuse_experiment_setup）", () => {
  it("train_all=true → argv 含 --train-all；缺省/false 不出现", async () => {
    const on = (await toolOf().execute(
      { stage: "family_split", run_id: "d93-ta-on", workspace_path: tempRoot(), train_all: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(on["ok"]).toBe(true);
    expect(summaryArgv(on).filter((a) => a === "--train-all")).toHaveLength(1);
    const def = (await toolOf().execute(
      { stage: "family_split", run_id: "d93-ta-def", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(def)).not.toContain("--train-all");
  });
  it("assignment_source 给路径 → argv 含 --assignment-source <trim 值>；缺省/空白不出现", async () => {
    const given = (await toolOf().execute(
      { stage: "family_split", run_id: "d93-as", workspace_path: tempRoot(), assignment_source: "/tmp/d93-assign-dir  " },
      fakeExec,
    )) as Record<string, unknown>;
    expect(given["ok"]).toBe(true);
    const argv = summaryArgv(given);
    expect(argv[argv.indexOf("--assignment-source") + 1]).toBe("/tmp/d93-assign-dir");
    const blank = (await toolOf().execute(
      { stage: "family_split", run_id: "d93-as-blank", workspace_path: tempRoot(), assignment_source: "   " },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(blank)).not.toContain("--assignment-source");
  });
  it("reuse_experiment_setup=true → argv 含 --reuse-experiment-setup；缺省不出现", async () => {
    const on = (await toolOf().execute(
      { stage: "candidate_build", run_id: "d93-re-on", workspace_path: tempRoot(), reuse_experiment_setup: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(on["ok"]).toBe(true);
    expect(summaryArgv(on).filter((a) => a === "--reuse-experiment-setup")).toHaveLength(1);
    const def = (await toolOf().execute(
      { stage: "candidate_build", run_id: "d93-re-def", workspace_path: tempRoot() },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(def)).not.toContain("--reuse-experiment-setup");
  });
  it("三参并存透传互不干扰（同 argv 三旗标齐在、值各就位；experiment_setup 段与 grouping_preset 同车）", async () => {
    const result = (await toolOf().execute(
      {
        stage: "experiment_setup",
        run_id: "d93-all",
        workspace_path: tempRoot(),
        grouping_preset: "A",
        train_all: true,
        assignment_source: "/tmp/d93-assign-dir",
        reuse_experiment_setup: true,
      },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--grouping-preset") + 1]).toBe("A");
    expect(argv).toContain("--train-all");
    expect(argv[argv.indexOf("--assignment-source") + 1]).toBe("/tmp/d93-assign-dir");
    expect(argv).toContain("--reuse-experiment-setup");
  });
  it("三参不按段 gate（内核全局参数）：label_qc 段给三件照样下传", async () => {
    const result = (await toolOf().execute(
      {
        stage: "label_qc",
        run_id: "d93-global",
        workspace_path: tempRoot(),
        train_all: true,
        assignment_source: "/tmp/d93-assign-dir",
        reuse_experiment_setup: true,
      },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const argv = summaryArgv(result);
    expect(argv).toContain("--train-all");
    expect(argv).toContain("--assignment-source");
    expect(argv).toContain("--reuse-experiment-setup");
  });
  it("参数 schema 三件在位（boolean/boolean/string）且描述含互斥与缺省语义；工具描述含三参段", () => {
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {};
    expect(props["train_all"]?.type).toBe("boolean");
    expect(props["assignment_source"]?.type).toBe("string");
    expect(props["reuse_experiment_setup"]?.type).toBe("boolean");
    expect(String(props["train_all"]?.description)).toContain("与 assignment_source 互斥");
    expect(String(props["assignment_source"]?.description)).toContain("train.txt");
    expect(String(props["assignment_source"]?.description)).toContain("test.txt");
    expect(String(props["reuse_experiment_setup"]?.description)).toContain("配置不在场时内核拒绝");
    expect(tool.description).toContain("train_all／assignment_source／reuse_experiment_setup");
    expect(tool.description).toContain("同时给会被内核拒绝");
  });
});

describe("D108——token-provider／retry-coordinate-pending 透传（内核全局参数，给才下传）", () => {
  it("token_provider 给路径 → argv 含 --token-provider <trim 值>；缺省/空白不出现", async () => {
    const given = (await toolOf().execute(
      { stage: "experiment_setup", run_id: "d108-tp", workspace_path: tempRoot(), token_provider: "/data/kernel/skills/x/token_provider.py  " },
      fakeExec,
    )) as Record<string, unknown>;
    expect(given["ok"]).toBe(true);
    const argv = summaryArgv(given);
    expect(argv[argv.indexOf("--token-provider") + 1]).toBe("/data/kernel/skills/x/token_provider.py");
    const blank = (await toolOf().execute(
      { stage: "experiment_setup", run_id: "d108-tp-blank", workspace_path: tempRoot(), token_provider: "   " },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(blank)).not.toContain("--token-provider");
  });
  it("retry_coordinate_pending=true → argv 含 --retry-coordinate-pending；缺省/false 不出现", async () => {
    const on = (await toolOf().execute(
      { stage: "training_prep", run_id: "d108-rc-on", workspace_path: tempRoot(), base_model_path: "/data/LLM_model/fake-model", retry_coordinate_pending: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(on["ok"]).toBe(true);
    expect(summaryArgv(on).filter((a) => a === "--retry-coordinate-pending")).toHaveLength(1);
    const def = (await toolOf().execute(
      { stage: "training_prep", run_id: "d108-rc-def", workspace_path: tempRoot(), base_model_path: "/data/LLM_model/fake-model" },
      fakeExec,
    )) as Record<string, unknown>;
    expect(summaryArgv(def)).not.toContain("--retry-coordinate-pending");
  });
  it("两参不按段 gate（内核全局参数）：label_qc 段给两件照样下传；参数 schema 两件在位", async () => {
    const result = (await toolOf().execute(
      { stage: "label_qc", run_id: "d108-global", workspace_path: tempRoot(), token_provider: "/tmp/tp.py", retry_coordinate_pending: true },
      fakeExec,
    )) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);
    const argv = summaryArgv(result);
    expect(argv[argv.indexOf("--token-provider") + 1]).toBe("/tmp/tp.py");
    expect(argv).toContain("--retry-coordinate-pending");
    const tool = toolOf();
    const props = (tool.parameters as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {};
    expect(props["token_provider"]?.type).toBe("string");
    expect(props["retry_coordinate_pending"]?.type).toBe("boolean");
    expect(String(props["token_provider"]?.description)).toContain("真算");
    expect(String(props["retry_coordinate_pending"]?.description)).toContain("pending 清单");
  });
});
