/**
 * R-3 接线批（2026-09-23）：core/workspace/labelQc 单测——登记面报告只读解析（越界拒、
 * digest 不符 fail-honest）、已裁决集剔除（fail-open）、九项 disposition 闭集×检查类组合
 * （呈现层镜像逐字对齐内核 label_qc.py）、必填附加字段、Q2 判断依据（basis=user）、
 * 未决项不默认处置（合成 params 只含显式确认项）。
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLabelQcResolveParams,
  checkClassShort,
  DISPOSITIONS_BY_CHECK_CLASS,
  LABEL_QC_DISPOSITIONS,
  pendingItemsOf,
  readLabelQcReport,
  readResolvedItemIds,
  readSliceImageRef,
  REQUIRED_DECISION_FIELDS,
  resolveWorkspaceRef,
  type LabelQcDecisionDraft,
  type LabelQcReportFile,
} from "../../../src/core/workspace/index.js";

const REPORT_DIGEST = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const sampleReport = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  schema_version: "LabelQcReport/v1",
  dataset_id: "ds-3b7551bca6ec",
  pin: "5fe2a8c9a98b",
  report_digest: REPORT_DIGEST,
  counts: { total_items: 2, pending: 2, resolved: 0, by_check_class: { q2_same_box_same_value_diff_field: 1, q4_box_out_of_bounds: 1 } },
  items: [
    {
      item_id: "qc-q2-aaaaaaaaaaaa",
      check_class: "q2_same_box_same_value_diff_field",
      human_label: "同一位置、同样的值，却标给了不同字段（需确认归属）",
      suggested_action: { action_hint: "dispose", disposition_hint: "keep_first", target_candidate_id: "cand-1" },
      locator: { sample_id: "img-0001", field: "date", page: "3" },
      evidence: [{ kind: "annotation_slice", ref: "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc/qc-q2-aaaaaaaaaaaa.json", digest: "e" }],
      candidates: [
        { candidate_id: "cand-1", value: "2026-01-01", source: "field_a" },
        { candidate_id: "cand-2", value: "2026-01-01", source: "field_b" },
      ],
    },
    {
      item_id: "qc-q4-bbbbbbbbbbbb",
      check_class: "q4_box_out_of_bounds",
      human_label: "坐标框超出图片边界",
      suggested_action: { action_hint: "dispose", disposition_hint: "clip_to_bounds" },
      locator: { sample_id: "img-0002" },
      evidence: [],
      candidates: [],
    },
    ...((overrides["extra_items"] as unknown[]) ?? []),
  ],
  ...overrides,
});

const roots: string[] = [];
const makeRoot = async (report?: Record<string, unknown>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "labelqc-test-"));
  roots.push(root);
  const datasetDir = join(root, "datasets", "ds-3b7551bca6ec@5fe2a8c9a98b");
  await mkdir(datasetDir, { recursive: true });
  if (report !== undefined) {
    await writeFile(join(datasetDir, "label-qc-report.json"), JSON.stringify(report), "utf8");
  }
  return root;
};
const REPORT_REF = "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc-report.json";

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("resolveWorkspaceRef：workspace 相对引用禁越界（TCB 只读纪律）", () => {
  it("相对引用可解析；.. 逃逸与绝对路径越界拒绝", async () => {
    const root = await makeRoot();
    expect(resolveWorkspaceRef(root, REPORT_REF).ok).toBe(true);
    const escape = resolveWorkspaceRef(root, "../outside.json");
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.code).toBe("label_qc_report_unreadable");
    const outside = resolveWorkspaceRef(root, "/etc/passwd");
    expect(outside.ok).toBe(false);
  });
});

describe("readLabelQcReport：只读解析＋fail-honest", () => {
  it("合法报告解析成功；digest 与 inspect 返回值不符 → label_qc_report_digest_mismatch 不出卡", async () => {
    const root = await makeRoot(sampleReport());
    const report = await readLabelQcReport(root, REPORT_REF, REPORT_DIGEST);
    expect(report.ok).toBe(true);
    if (report.ok) {
      expect(report.value.dataset_id).toBe("ds-3b7551bca6ec");
      expect(report.value.items).toHaveLength(2);
    }
    const mismatch = await readLabelQcReport(root, REPORT_REF, "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("label_qc_report_digest_mismatch");
  });

  it("缺文件/坏 JSON → label_qc_report_unreadable（fail-honest 不造数）", async () => {
    const root = await makeRoot();
    const missing = await readLabelQcReport(root, REPORT_REF);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("label_qc_report_unreadable");
    const badRoot = await makeRoot();
    await writeFile(join(badRoot, REPORT_REF), "{not-json", "utf8");
    const bad = await readLabelQcReport(badRoot, REPORT_REF);
    expect(bad.ok).toBe(false);
  });
});

describe("readResolvedItemIds：裁决累积剔除（fail-open；仅同 report_digest）", () => {
  it("同 digest 裁决剔除；异 digest/缺文件返回空集", async () => {
    const root = await makeRoot(sampleReport());
    const datasetDir = join(root, "datasets", "ds-3b7551bca6ec@5fe2a8c9a98b");
    await writeFile(
      join(datasetDir, "label-qc-decisions.json"),
      JSON.stringify({ schema_version: "LabelQcDecision/v1", report_digest: REPORT_DIGEST, decisions: [{ item_id: "qc-q4-bbbbbbbbbbbb", action: "accept" }] }),
      "utf8",
    );
    const resolved = await readResolvedItemIds(root, REPORT_REF, REPORT_DIGEST);
    expect(resolved.has("qc-q4-bbbbbbbbbbbb")).toBe(true);
    const foreign = await readResolvedItemIds(root, REPORT_REF, "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    expect(foreign.size).toBe(0);
  });
});

describe("pendingItemsOf：卡面待确认＝报告项 − 已裁决", () => {
  it("排除已裁决项；空 id 防御性排除", async () => {
    const root = await makeRoot(sampleReport());
    const report = (await readLabelQcReport(root, REPORT_REF)) as Extract<Awaited<ReturnType<typeof readLabelQcReport>>, { ok: true }>;
    const items = pendingItemsOf(report.value, new Set(["qc-q2-aaaaaaaaaaaa"]));
    expect(items.map((item) => item.item_id)).toEqual(["qc-q4-bbbbbbbbbbbb"]);
  });
});

describe("组合闭集与必填字段表：呈现层镜像逐字对齐内核 label_qc.py", () => {
  it("九项闭集；检查类组合表（accept/modify 菜单不含 no_action 由调用方过滤）", () => {
    expect([...LABEL_QC_DISPOSITIONS].sort()).toEqual(["clip_to_bounds", "dedupe", "drop_both", "fix_field", "keep_both", "keep_first", "keep_second", "no_action", "set_value"]);
    expect(DISPOSITIONS_BY_CHECK_CLASS.q1_same_box_same_value_same_field).toEqual(["dedupe", "no_action"]);
    expect(DISPOSITIONS_BY_CHECK_CLASS.q2_same_box_same_value_diff_field).toEqual(["keep_first", "keep_second", "keep_both", "drop_both", "set_value", "no_action"]);
    expect(DISPOSITIONS_BY_CHECK_CLASS.q3_value_box_shape_mismatch).toEqual(["set_value", "fix_field", "drop_both", "no_action"]);
    expect(DISPOSITIONS_BY_CHECK_CLASS.q4_box_out_of_bounds).toEqual(["clip_to_bounds", "no_action"]);
    expect(REQUIRED_DECISION_FIELDS.dedupe).toEqual(["keep_ref"]);
    expect(REQUIRED_DECISION_FIELDS.set_value).toEqual(["modified_value"]);
    expect(REQUIRED_DECISION_FIELDS.clip_to_bounds).toEqual([]);
    expect(checkClassShort("q2_same_box_same_value_diff_field")).toBe("q2");
  });
});

describe("buildLabelQcResolveParams：确定性合成（未决不默认＝只含显式确认项）", () => {
  const base = async () => {
    const root = await makeRoot(sampleReport());
    const report = (await readLabelQcReport(root, REPORT_REF)) as Extract<Awaited<ReturnType<typeof readLabelQcReport>>, { ok: true }>;
    return report.value as LabelQcReportFile;
  };

  it("空草案 → label_qc_no_decisions（未决项不默认处置）", async () => {
    const report = await base();
    const result = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "2026-09-23T00:00:00Z", drafts: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("label_qc_no_decisions");
  });

  it("报告外 item_id → label_qc_item_unknown", async () => {
    const report = await base();
    const result = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q2-zzzz", action: "reject" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("label_qc_item_unknown");
  });

  it("reject＝维持原状：可省略 disposition；携带非 no_action 处置 → invalid", async () => {
    const report = await base();
    const okResult = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q4-bbbbbbbbbbbb", action: "reject" }] });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) expect(okResult.value["decisions"]).toEqual([{ item_id: "qc-q4-bbbbbbbbbbbb", action: "reject" }]);
    const bad = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q4-bbbbbbbbbbbb", action: "reject", disposition: "clip_to_bounds" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("label_qc_decision_invalid");
  });

  it("accept 按建议：disposition 取 hint；建议携带 target_candidate_id；缺必填字段 → invalid", async () => {
    const report = await base();
    // qc-q2 建议 keep_first＋target_candidate_id 在 suggested_action → 直接收
    const okResult = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q2-aaaaaaaaaaaa", action: "accept", disposition: "keep_first", target_candidate_id: "cand-1", judgement_note: "整图看归属为 A" }] });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      const decisions = okResult.value["decisions"] as Record<string, unknown>[];
      expect(decisions[0]).toMatchObject({ item_id: "qc-q2-aaaaaaaaaaaa", action: "accept", disposition: "keep_first", target_candidate_id: "cand-1" });
      // Q2 项：判断依据恒附（basis=user）
      expect(decisions[0]?.["judgements"]).toEqual([{ item_id: "qc-q2-aaaaaaaaaaaa", basis: "user", reason_text: "整图看归属为 A" }]);
    }
    // 无建议项（action_hint=review、无 disposition_hint；accept 无显式 disposition）→ 须显式给出
    const noHintReport = sampleReport({
      extra_items: [{ item_id: "qc-q3-cccccccccccc", check_class: "q3_value_box_shape_mismatch", human_label: "值与坐标框不匹配", suggested_action: { action_hint: "review" }, locator: {}, evidence: [], candidates: [] }],
    });
    const noHintRoot = await makeRoot(noHintReport);
    const noHintReportParsed = await readLabelQcReport(noHintRoot, REPORT_REF);
    expect(noHintReportParsed.ok).toBe(true);
    if (!noHintReportParsed.ok) throw new Error("unreachable");
    const noHint = buildLabelQcResolveParams({ report: noHintReportParsed.value, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q3-cccccccccccc", action: "accept" }] });
    expect(noHint.ok).toBe(false);
    if (!noHint.ok) expect(noHint.error.message).toContain("无建议");
    // set_value 缺 modified_value → invalid
    const missing = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q2-aaaaaaaaaaaa", action: "modify", disposition: "set_value" }] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("modified_value");
  });

  it("组合闭集：q2 给 dedupe → invalid（越出允许组合）；合成 params 顶层形态完整", async () => {
    const report = await base();
    const cross = buildLabelQcResolveParams({ report, actor: "tui-operator", decidedAt: "x", drafts: [{ item_id: "qc-q2-aaaaaaaaaaaa", action: "modify", disposition: "dedupe", keep_ref: "marks[0]" }] });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.message).toContain("允许组合闭集");
    const result = buildLabelQcResolveParams({
      report,
      actor: "tui-operator",
      decidedAt: "2026-09-23T01:02:03Z",
      drafts: [
        { item_id: "qc-q2-aaaaaaaaaaaa", action: "modify", disposition: "keep_both", reason_text: "两条都保留", judgement_note: "" },
        { item_id: "qc-q4-bbbbbbbbbbbb", action: "modify", disposition: "clip_to_bounds" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ dataset_id: "ds-3b7551bca6ec", pin: "5fe2a8c9a98b", actor: "tui-operator", decided_at: "2026-09-23T01:02:03Z", report_digest: REPORT_DIGEST });
      const decisions = result.value["decisions"] as Record<string, unknown>[];
      expect(decisions).toHaveLength(2); // 未决不默认：只含显式确认项
      expect(decisions[0]?.["judgements"]).toEqual([{ item_id: "qc-q2-aaaaaaaaaaaa", basis: "user" }]);
      expect(decisions[1]).not.toHaveProperty("judgements");
    }
  });
});

describe("readSliceImageRef：裁定 B 整图引用（仅 workspace 内给值；fail-soft）", () => {
  it("切片含 image_workspace_ref → 取值；null/缺文件 → null", async () => {
    const root = await makeRoot(sampleReport());
    const sliceDir = join(root, "datasets", "ds-3b7551bca6ec@5fe2a8c9a98b", "label-qc");
    await mkdir(sliceDir, { recursive: true });
    await writeFile(join(sliceDir, "qc-q2-aaaaaaaaaaaa.json"), JSON.stringify({ item_id: "qc-q2-aaaaaaaaaaaa", image_workspace_ref: "source/img-0001.png" }), "utf8");
    const ref = await readSliceImageRef(root, "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc/qc-q2-aaaaaaaaaaaa.json");
    expect(ref).toBe("source/img-0001.png");
    const external = await readSliceImageRef(root, "datasets/ds-3b7551bca6ec@5fe2a8c9a98b/label-qc/qc-q4-bbbbbbbbbbbb.json");
    expect(external).toBeNull();
  });
});
