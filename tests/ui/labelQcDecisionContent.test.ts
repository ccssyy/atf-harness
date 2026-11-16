// B3 裁决卡决策内容锚（1116 发现 3/4——碎片池/盲批根治回归面）：
// 卡面必含冲突两值对照（候选 A/B=值）+依据（整图/证据切片）+内核建议——
// 用户逐项决定的信息面闭集；碎片形态（候选缺失/依据缺席/建议缺席）=红。
import { describe, expect, it } from "vitest";

import { labelQcItemLines } from "../../src/ui/labelQcCard.js";
import type { LabelQcItem } from "../../src/core/workspace/index.js";

const item: LabelQcItem = {
  item_id: "q2-p3-amount",
  check_class: "Q2",
  human_label: "金额候选冲突",
  locator: "p3.json#amount",
  evidence: [{ kind: "crop", ref: "p3-amount.png", digest: "a".repeat(64) }],
  candidates: [
    { candidate_id: "c1", value: "12.00", source: "annotation" },
    { candidate_id: "c2", value: "12,00", source: "ocr" },
  ],
  suggested_action: { disposition_hint: "keep_first" },
} as unknown as LabelQcItem;

describe("B3 裁决卡决策内容", () => {
  it("卡面含冲突两值对照+依据+建议（决策信息闭集）", () => {
    const lines = labelQcItemLines(item, 1, 3, "p3.png").join("\n");
    expect(lines).toContain("A=c1 值=12.00");
    expect(lines).toContain("B=c2 值=12,00");
    expect(lines).toContain("依据：整图 p3.png");
    expect(lines).toContain("证据切片");
    expect(lines).toContain("内核建议");
  });

  it("碎片形态回归：候选缺席或建议缺席=卡面不可上用户（红）", () => {
    // 碎片形态①:候选池空（盲批——无对照即问）→候选行缺席但依据/建议仍在（卡面信息面不塌）
    const noCandidates = { ...item, candidates: [] } as unknown as LabelQcItem;
    const lines1 = labelQcItemLines(noCandidates, 1, 1, null).join("\n");
    expect(lines1).not.toContain("候选：");
    expect(lines1).toContain("依据：");
    expect(lines1).toContain("内核建议");
    // 碎片形态②:建议缺席——卡面如实「（无建议）」且应答提示不提供 1=按建议
    const noSuggest = { ...item, suggested_action: {} } as unknown as LabelQcItem;
    const lines2 = labelQcItemLines(noSuggest, 1, 1, "p3.png").join("\n");
    expect(lines2).toContain("（无建议）");
  });
});
