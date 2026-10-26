/**
 * E3 只读呈现回归锚（本次训练字段＋prompt 字段段）。
 *
 * 锚点：
 *  ① 字段清单＝业务名＋字段 id，来源两类（按你配置的分段声明／随字段定义生成）；
 *  ② prompt 字段段＝内核报告实文样例块里的字段行原文（逐行，不重渲染）；
 *  ③ 保真回退（说明按原文原样使用）有一句业务话说明；
 *  ④ 用户面零内部词（FieldSpec／segments／classifier／heuristic）；
 *  ⑤ 产物缺席时如实说明，不造占位。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTrainingPromptPreview, renderTrainingPromptPreviewBlock } from "../../src/core/workspace/trainingPromptPreview.js";
import { buildPrelaunchReportTool } from "../../packages/extensions/atf-tools/src/prelaunchFace.js";

const tempRoots: string[] = [];
const tempRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FIELD_CONFIG = {
  schema_version: "PromptFieldConfig/v1",
  document_type: "packing_list",
  document_zh: "装箱单",
  variant: "flat",
  fields: [
    { field_id: "doc_identifier", group: "doc_identifier", zh: "单据标识", definition: "提取页面上出现的单据编号、参考号", locators: ["No.", "Ref"] },
    // 有分段声明 → 来源「按你配置里的字段分段声明」
    {
      field_id: "goods_name",
      group: "goods_item",
      zh: "货名",
      definition: "提取商品名称/描述",
      locators: ["DESCRIPTION"],
      segments: [{ kind: "header", text: "货名" }, { kind: "description", text: "提取商品名称/描述" }],
    },
    // 渲染行＝「字段名＋定义」逐字 → 保真回退（说明按原文原样使用）
    { field_id: "total_amount", group: "doc_level", zh: "总金额", definition: "提取总金额值" },
  ],
  training_excluded_fields: [],
};

const REPORT_MD = [
  "# 实验启动配置确认报告",
  "",
  "## 训练 prompt 实文样例(mode0 全字段,与训练行逐字同式)",
  "",
  "```text",
  "你的核心任务如下：",
  "1. 装箱单信息结构化提取：从单据中定位并解析关键信息；",
  "需提取的字段（字段名使用 snake_case）：",
  "- doc_identifier：单据标识，根据 No.、Ref 等关键字定位，提取页面上出现的单据编号、参考号",
  "- goods_name：货名，提取商品名称/描述",
  "- total_amount：总金额，提取总金额值",
  "输出格式规范：",
  "- 所有字段输出为数组形式",
  "```",
  "",
  "## 期望输出形态(JSON 键序=prompt 提及序)",
].join("\n");

const seedRun = (): { root: string; runDir: string } => {
  const root = tempRoot("e3-");
  const runDir = join(root, "runs", "run-e3");
  mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
  writeFileSync(join(runDir, "experiment-setup", "field-config.json"), JSON.stringify(FIELD_CONFIG, null, 1));
  writeFileSync(join(runDir, "experiment-setup", "experiment_setup_report.md"), REPORT_MD);
  return { root, runDir };
};

describe("E3 字段与 prompt 只读呈现", () => {
  it("字段清单：业务名＋id；来源两类；prompt 字段段只取字段行（不夹任务说明/输出规范）", () => {
    const { runDir } = seedRun();
    const preview = buildTrainingPromptPreview(runDir);
    expect(preview.fields.map((field) => `${field.name}（${field.id}）`)).toEqual([
      "单据标识（doc_identifier）",
      "货名（goods_name）",
      "总金额（total_amount）",
    ]);
    expect(preview.fields.find((field) => field.id === "goods_name")?.source).toBe("declared");
    expect(preview.fields.find((field) => field.id === "doc_identifier")?.source).toBe("generated");
    // 只取 `- <id>：…` 字段行（3 行），不含任务说明与输出规范
    expect(preview.promptLines).toEqual([
      "- doc_identifier：单据标识，根据 No.、Ref 等关键字定位，提取页面上出现的单据编号、参考号",
      "- goods_name：货名，提取商品名称/描述",
      "- total_amount：总金额，提取总金额值",
    ]);
    // 保真回退：total_amount 的渲染行＝字段名＋定义逐字（无定位/排除子句）
    expect(preview.verbatimFields).toEqual(["total_amount"]);
  });

  it("呈现块：字段逐行＋prompt 原文＋保真回退业务话；零内部词", () => {
    const { runDir } = seedRun();
    const block = renderTrainingPromptPreviewBlock(buildTrainingPromptPreview(runDir));
    expect(block).toContain("本次训练字段（3 项；字段说明来源：1 项按你配置的字段分段声明、2 项随字段定义生成）");
    expect(block).toContain("· 单据标识（doc_identifier）——随字段定义生成");
    expect(block).toContain("· 货名（goods_name）——按你配置里的字段分段声明");
    expect(block).toContain("prompt 里的字段段（逐行原文，训练行与它同式）：");
    expect(block).toContain("  - doc_identifier：单据标识，根据 No.、Ref 等关键字定位，提取页面上出现的单据编号、参考号");
    expect(block).toContain("字段说明按原文原样使用（1 项）：total_amount");
    for (const token of ["FieldSpec", "segments", "classifier", "heuristic", "field_id"]) {
      expect(block, token).not.toContain(token);
    }
  });

  it("产物缺席：如实说明，不造占位", () => {
    const root = tempRoot("e3-empty-");
    const preview = buildTrainingPromptPreview(join(root, "runs", "absent"));
    expect(preview.fields).toEqual([]);
    expect(preview.promptLines).toEqual([]);
    expect(preview.unavailable).toContain("还没有产出字段清单");
    expect(renderTrainingPromptPreviewBlock(preview)).toContain("本次训练字段与 prompt：");
  });

  it("接线：atf_prelaunch_report 回执带只读呈现块（不改写、原样转述）", async () => {
    const { root, runDir } = seedRun();
    mkdirSync(join(runDir, "launch"), { recursive: true });
    writeFileSync(join(runDir, "launch", "launch.sh"), "#!/bin/sh\n");
    mkdirSync(join(runDir, "prep"), { recursive: true });
    writeFileSync(join(runDir, "prep", "iteration-config.json"), JSON.stringify({ training: {} }));
    // 假内核脚本：只把报告写到 --out（本用例验的是 harness 侧读盘与呈现，不验内核报告内容）
    const kernelDir = tempRoot("e3-kernel-");
    const scriptDir = join(kernelDir, "skills", "atf-prepare-training", "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "build_prelaunch_report.py"),
      "import sys,pathlib\nout=sys.argv[sys.argv.index('--out')+1]\npathlib.Path(out).write_text('# prelaunch\\n- 训练参数终值: 见 IterationConfig\\n', encoding='utf-8')\n",
    );
    const tool = buildPrelaunchReportTool({ get: () => undefined }, { kernelDir, timeoutMs: 30_000 }) as unknown as {
      execute: (a: unknown, e: unknown) => Promise<Record<string, unknown>>;
    };
    const result = await tool.execute(
      { run_id: "run-e3", workspace_path: join(root, "runs", "..") },
      { agent: { session: { id: "s" } }, callId: "e3", signal: undefined },
    );
    expect(result["ok"]).toBe(true);
    const block = String(result["training_prompt_preview"]);
    expect(block).toContain("本次训练字段（3 项");
    expect(block).toContain("prompt 里的字段段（逐行原文");
    expect(result["training_fields"]).toEqual([
      { name: "单据标识", id: "doc_identifier", source: "generated" },
      { name: "货名", id: "goods_name", source: "declared" },
      { name: "总金额", id: "total_amount", source: "generated" },
    ]);
    expect(result["fields_using_verbatim_text"]).toEqual(["total_amount"]);
    for (const token of ["FieldSpec", "segments", "classifier"]) expect(block, token).not.toContain(token);
  });
});

/** 现场有实件时跑真盘断言（无该 run 的机器自动跳过——纯函数与接线由上面四例覆盖）。 */
const LIVE_RUN = "/data/atf/dev/runs/run-admit-qc-02-d76fx";

describe.skipIf(!existsSync(`${LIVE_RUN}/experiment-setup/experiment_setup_report.md`))("E3 真机（实件 run-admit-qc-02-d76fx）", () => {
  it("真实字段配置＋真实报告：字段清单与字段段原文可读出，字段行形态正确，零内部词", () => {
    const preview = buildTrainingPromptPreview(LIVE_RUN);
    expect(preview.fields.length).toBeGreaterThan(0);
    expect(preview.promptLines.length).toBeGreaterThan(0);
    for (const line of preview.promptLines) expect(line).toMatch(/^-\s+[A-Za-z0-9_]+\s*[：:]/);
    const block = renderTrainingPromptPreviewBlock(preview);
    for (const token of ["FieldSpec", "segments", "classifier", "heuristic"]) expect(block, token).not.toContain(token);
  });
});
