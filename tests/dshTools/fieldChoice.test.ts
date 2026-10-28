/**
 * 问题 1 防回退：字段清单必须经用户确认（FieldChoice/v1）+ D-f 判据纠正。
 *
 * 现场（dev 2026-10-28）：
 * - 用户从没给过字段列表，agent 自己从标注 `marks[].pselect` 数出 17 个、自己起中文名与定义；
 * - 更糟的是它为了「出卡」先给 17 个字段写了 group 占位值 → `fieldGroupsOf` 判成「用户已给」
 *   → 分组卡永远出不来 → 它读内核源码自救 **9 分钟**（D-f）。
 *
 * 这里锁四件事：
 * 1. 账本落在 `runtime/webui/`（卡面输入态），**不在** `analysis/decisions/`（内核判定账）；
 * 2. 清单读不出来时不造伪数据（返回 null，调用方不弹卡）；
 * 3. 不勾＝全部训练（不强迫用户逐项点）；
 * 4. `user_provided` 只在「用户确认过」时成立——未确认且 agent 给了候选时必须继续出卡。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FIELD_CHOICE_SCHEMA,
  fieldChoiceDetailOf,
  fieldChoicePathOf,
  fieldLabelsPathOf,
  readFieldChoice,
  readFieldLabels,
  writeFieldChoice,
  type FieldLabels,
} from "../../packages/extensions/atf-tools/src/fieldChoice.js";
import { resolveGroupingFace } from "../../packages/extensions/atf-tools/src/pipelineFace.js";
import {
  fieldsDigestOf,
  writeGroupingDecision,
} from "../../packages/extensions/atf-tools/src/groupingDecision.js";

const runDirOf = (): string => mkdtempSync(join(tmpdir(), "atf-fc-"));

/** 落点必须走与读侧同一个解析器：v3 树是 data/、v2 存量树是 prep/。 */
const writeLabels = (runDir: string, payload: unknown): string => {
  const path = fieldLabelsPathOf(runDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return path;
};

const LABELS: FieldLabels = {
  page_count: 12,
  label_count: 3,
  box_count: 30,
  labels: [
    { label: "awb", box_count: 14, page_count: 12, absent_pages: 0 },
    { label: "shipper", box_count: 12, page_count: 12, absent_pages: 0 },
    { label: "notify_party", box_count: 4, page_count: 3, absent_pages: 9 },
  ],
};

describe("字段清单读取（内核产出，harness 只读）", () => {
  it("正常清单可读；缺席/坏行/schema 不符一律 null（不造伪数据）", () => {
    const runDir = runDirOf();
    expect(readFieldLabels(runDir)).toBeNull();

    writeLabels(runDir, {
      schema_version: "FieldLabels/v1",
      page_count: 12,
      label_count: 3,
      box_count: 30,
      labels: LABELS.labels,
    });
    const labels = readFieldLabels(runDir);
    expect(labels?.label_count).toBe(3);
    expect(labels?.labels[2]).toEqual({ label: "notify_party", box_count: 4, page_count: 3, absent_pages: 9 });

    writeLabels(runDir, { schema_version: "FieldLabels/v0", labels: [] });
    expect(readFieldLabels(runDir)).toBeNull();

    writeLabels(runDir, { schema_version: "FieldLabels/v1", labels: [] });
    expect(readFieldLabels(runDir)).toBeNull();
  });
});

describe("字段确认账本", () => {
  it("落在 runtime/webui（卡面输入态），不在 analysis/decisions（内核判定账）", () => {
    const runDir = runDirOf();
    const path = writeFieldChoice(runDir, {
      run_id: "run-awb-01",
      confirmed_fields: ["awb", "shipper"],
      all_fields: false,
      total_fields: 3,
      decided_at: "2026-10-28T19:40:00.000Z",
      source: "user_confirmed",
    });
    expect(path).toBe(fieldChoicePathOf(runDir));
    expect(path).toContain("webui");
    expect(path).not.toContain("analysis");

    const record = readFieldChoice(runDir);
    expect(record?.schema_version).toBe(FIELD_CHOICE_SCHEMA);
    expect(record?.confirmed_fields).toEqual(["awb", "shipper"]);
    expect(record?.all_fields).toBe(false);
  });

  it("没确认过 → null（调用方据此出卡）", () => {
    expect(readFieldChoice(runDirOf())).toBeNull();
  });
});

describe("卡面文案", () => {
  it("逐字段给出「多少页出现」与框数，并明说「不勾＝全部训练」", () => {
    const detail = fieldChoiceDetailOf(LABELS);
    expect(detail).toContain("标注里一共 3 个字段（30 个框，覆盖 12 页）");
    expect(detail).toContain("不是系统编的");
    expect(detail).toContain("awb —— 每页都有（12/12 页），14 个框");
    expect(detail).toContain("notify_party —— 只在 3/12 页出现，4 个框");
    expect(detail).toContain("这些字段要全部训练吗？");
  });
});

describe("D-f：user_provided 只在「用户确认过」时成立", () => {
  const fieldConfigWithGroups = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "atf-fc-cfg-"));
    const path = join(dir, "field-config.json");
    writeFileSync(
      path,
      JSON.stringify({
        document_type: "awb",
        fields: [
          { field_id: "awb", zh: "运单号", definition: "x", group: "文档标识" },
          { field_id: "shipper", zh: "托运人", definition: "y", group: "当事方" },
        ],
      }),
      "utf8",
    );
    return path;
  };

  const proposal = {
    schema_version: "GroupingProposal/v1",
    candidates: [
      { name: "按业务域两组", recommended: true, groups: [{ name: "文档标识", fields: ["awb"] }, { name: "当事方", fields: ["shipper"] }] },
      { name: "全部平铺", recommended: false, groups: [{ name: "全部", fields: ["awb", "shipper"] }] },
    ],
  };

  it("分组账本里有记录 → 走配置里的分组，不出卡", async () => {
    const runDir = runDirOf();
    const cfg = fieldConfigWithGroups();
    // 只有「分组自己的账本」才算用户确认过分组——字段清单确认过不算（真机踩过）
    writeGroupingDecision(runDir, {
      run_id: "r1",
      candidate_name: "按业务域两组",
      groups: [],
      payload: { schema_version: "GroupingProposal/v1", candidates: [] },
      fields_digest: fieldsDigestOf(cfg),
      field_count: 2,
      decided_at: "2026-10-28T20:00:00.000Z",
      source: "user_selected",
    });
    const face = await resolveGroupingFace({
      ctx: { get: () => undefined },
      exec: {},
      runId: "r1",
      fieldConfigPath: cfg,
      proposalRaw: proposal,
      runDir,
    });
    expect("source" in face && face.source).toBe("user_provided");
    expect("note" in face && String(face.note)).toContain("你在分组卡上选定过");
  });

  it("未确认 + agent 给了候选 → **不短路**，继续走候选（D-f 现场就是卡在这里）", async () => {
    const face = await resolveGroupingFace({
      ctx: { get: () => undefined }, // 无 userQuestions 服务 → 落到「不替你选」
      exec: {},
      runId: "r1",
      fieldConfigPath: fieldConfigWithGroups(),
      proposalRaw: proposal,
      runDir: runDirOf(),   // 无账本
    });
    expect("source" in face && face.source).toBe("proposal");
    expect("note" in face && String(face.note)).toContain("选择卡通道不可用");
  });

  it("未确认 + 没有候选 → 仍用配置分组，但必须明说「你没在卡上确认过」", async () => {
    const face = await resolveGroupingFace({
      ctx: { get: () => undefined },
      exec: {},
      runId: "r1",
      fieldConfigPath: fieldConfigWithGroups(),
      proposalRaw: undefined,
      runDir: runDirOf(),   // 无账本
    });
    expect("source" in face && face.source).toBe("user_provided");
    expect("note" in face && String(face.note)).toContain("没在卡上确认过");
  });
});
