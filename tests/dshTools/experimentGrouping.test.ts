/**
 * 分组节卡面回归锚（内核 65a0106c：GROUPING_PRESETS 已删，grouping 改新 keys）。
 *
 * 锚点：
 *  ① 来源三种各一段业务话（按你字段配置里的分组／按抽取约定里的分组／不分组，全部平铺）；
 *  ② 确认态两态（false＝「这些分组是我按字段推的，你可以改」；true＝「已确认」）；
 *  ③ 组清单读 `group_plan`（list）每组一行「组名：N 个字段」＋字段业务名展开；
 *  ④ `groups` 是 dict（构造器按 .values() 消费）——**不遍历**，dict 形态不崩；
 *  ⑤ `group_plan` 空/缺 → 不崩、如实说「不分组」；
 *  ⑥ 用户面零 `A`/`B`/`preset`/`grouping_preset` 字样。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fieldNameMapOf,
  readExperimentGrouping,
  renderGroupingSection,
} from "../../src/core/workspace/experimentGrouping.js";
import { buildPipelineTool } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

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
  fields: [
    { field_id: "doc_identifier", zh: "单据标识" },
    { field_id: "page_summary", zh: "页级汇总" },
    { field_id: "goods_name", zh: "货名" },
  ],
};

const seed = (grouping: unknown, withFieldConfig = true): string => {
  const root = tempRoot("grp-");
  mkdirSync(join(root, "experiment-setup"), { recursive: true });
  if (withFieldConfig) writeFileSync(join(root, "experiment-setup", "field-config.json"), JSON.stringify(FIELD_CONFIG));
  writeFileSync(join(root, "experiment-setup", "experiment-config.json"), JSON.stringify({ schema_version: "ExperimentConfig/v1", grouping }));
  return root;
};

/** 内核真实形态：groups 是 dict，group_plan 是 list。 */
const GROUPING_FIELD_GROUP = {
  source: "field_group",
  source_note: "字段配置里已经给了分组",
  preset: null,
  preset_name: "字段配置里的分组",
  groups: { doc_level: ["doc_identifier", "page_summary"], item_level: ["goods_name"] },
  group_plan: [
    { key: "doc_level", field_ids: ["doc_identifier", "page_summary"] },
    { key: "item_level", field_ids: ["goods_name"] },
  ],
  confirmed: false,
  decision: "pending",
  limit_source: "user_specified",
  notes: [],
};

describe("分组节：三种来源", () => {
  it("field_group（未确认）→ 业务话来源＋「你可以改」＋按 group_plan 分组名与字段业务名", () => {
    const runDir = seed(GROUPING_FIELD_GROUP);
    const text = renderGroupingSection(readExperimentGrouping(runDir), fieldNameMapOf(runDir));
    expect(text).toBe([
      "分组来源：按你字段配置里的分组——字段配置里已经给了分组",
      "分组确认：这些分组是我按字段推的，你可以改",
      "组清单（2 组）：",
      "  · doc_level：2 个字段",
      "      单据标识（doc_identifier）、页级汇总（page_summary）",
      "  · item_level：1 个字段",
      "      货名（goods_name）",
    ].join("\n"));
  });

  it("field_projection（已确认）→ 「按抽取约定里的分组」＋「已确认」", () => {
    const runDir = seed({
      ...GROUPING_FIELD_GROUP,
      source: "field_projection",
      source_note: "抽取约定里声明了分组",
      confirmed: true,
    });
    const text = renderGroupingSection(readExperimentGrouping(runDir), fieldNameMapOf(runDir));
    expect(text.split("\n")[0]).toBe("分组来源：按抽取约定里的分组——抽取约定里声明了分组");
    expect(text).toContain("分组确认：已确认");
  });

  it("none → 「不分组，全部平铺」＋组清单一行", () => {
    const runDir = seed({ source: "none", source_note: "", preset: null, preset_name: "", groups: {}, group_plan: [], confirmed: true });
    const text = renderGroupingSection(readExperimentGrouping(runDir), fieldNameMapOf(runDir));
    expect(text).toContain("分组来源：不分组，全部平铺");
    expect(text).toContain("组清单：不分组（全部平铺成一行一样本）");
  });
});

describe("分组节：形态健壮性与用词纪律", () => {
  it("groups 是 dict 也不崩：列表形态只读 group_plan（不遍历 groups）", () => {
    const runDir = seed({ ...GROUPING_FIELD_GROUP, group_plan: [{ key: "only", field_ids: ["goods_name"] }] });
    const parsed = readExperimentGrouping(runDir);
    expect(parsed?.groups).toEqual([{ key: "only", fieldIds: ["goods_name"] }]);
    const text = renderGroupingSection(parsed, fieldNameMapOf(runDir));
    expect(text).toContain("组清单（1 组）");
    expect(text).not.toContain("doc_level");
  });

  it("group_plan 空/缺 → 不崩、如实说「不分组」；groups 非法形状也不崩", () => {
    const empty = seed({ source: "field_group", groups: { a: ["x"] }, group_plan: [], confirmed: false });
    expect(renderGroupingSection(readExperimentGrouping(empty), fieldNameMapOf(empty))).toContain("组清单：不分组（全部平铺成一行一样本）");
    const missing = seed({ source: "field_group", groups: "oops" });
    expect(() => renderGroupingSection(readExperimentGrouping(missing), fieldNameMapOf(missing))).not.toThrow();
    const noFile = tempRoot("grp-none-");
    expect(readExperimentGrouping(noFile)).toBeNull();
    expect(renderGroupingSection(null, new Map())).toContain("还没有分组结果");
  });

  it("用户面零内部词：不出现 A/B、preset、grouping_preset（preset_name 只作来源说明）", () => {
    const runDir = seed({ ...GROUPING_FIELD_GROUP, preset: "custom-recipe", preset_name: "A" });
    const text = renderGroupingSection(readExperimentGrouping(runDir), fieldNameMapOf(runDir));
    for (const token of ["grouping_preset", "preset", "方案 A", "方案 B", "＝A", "＝B"]) expect(text, token).not.toContain(token);
    expect(text).not.toMatch(/^A$|^B$/m);
  });
});

describe("分组节接线：experiment_setup 段回执带 grouping_section", () => {
  const MOCK = join(import.meta.dirname, "..", "fixtures", "mock_pipeline_params.mjs");
  const toolOf = (record: string[]) =>
    buildPipelineTool({ get: (service: string) => (service === "approval" ? { request: async (req: { reason?: string }) => { record.push(req?.reason ?? ""); return "allowed-once"; } } : undefined) }, `node ${MOCK}`, 20_000) as unknown as {
      execute: (a: Record<string, unknown>, e: unknown) => Promise<Record<string, unknown>>;
    };

  it("跑完 experiment_setup：回执 grouping_section 复用同一渲染（业务话、按 group_plan 列组）", async () => {
    const ws = tempRoot("grp-ws-");
    const runDir = join(ws, "runs", "grp-run");
    mkdirSync(join(runDir, "experiment-setup"), { recursive: true });
    writeFileSync(join(runDir, "experiment-setup", "field-config.json"), JSON.stringify(FIELD_CONFIG));
    writeFileSync(join(runDir, "experiment-setup", "experiment-config.json"), JSON.stringify({ grouping: GROUPING_FIELD_GROUP }));
    const record: string[] = [];
    const result = await toolOf(record).execute(
      { stage: "experiment_setup", run_id: "grp-run", workspace_path: ws },
      { agent: { session: { id: "g" } }, callId: "g1", signal: undefined },
    );
    expect(result["ok"]).toBe(true);
    const section = String(result["grouping_section"]);
    expect(section).toContain("分组来源：按你字段配置里的分组");
    expect(section).toContain("组清单（2 组）");
    expect(section).toContain("单据标识（doc_identifier）");
    // 审批卡面也带上（run 里已有配置 → 作为「上一轮产物」提示）
    expect(record.join("\n")).toContain("以下是 run 里已有的一次实验配置");
    expect(record.join("\n")).toContain("分组来源：按你字段配置里的分组");
  });

  it("非 experiment_setup 段：回执不带 grouping_section（不越段呈现）", async () => {
    const ws = tempRoot("grp-ws2-");
    const result = await toolOf([]).execute(
      { stage: "label_qc", run_id: "grp-run2", workspace_path: ws },
      { agent: { session: { id: "g" } }, callId: "g2", signal: undefined },
    );
    expect(result["grouping_section"]).toBeUndefined();
  });
});
