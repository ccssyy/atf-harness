/**
 * K-Gap-2 接线批：humanSummary 渲染与呈现层负向校验（门 1 放行件 §一.6；owner 裁定方案 A
 * 六字段冻结表）。断言面＝结构嗅探／六段版式／next_action 约定／负向校验逐类命中与降级。
 */
import { describe, expect, it } from "vitest";
import {
  engineeringLeak,
  humanSummaryLines,
  isHumanSummaryShape,
  nextActionOf,
  type HumanSummary,
} from "../../src/ui/humanSummary.js";

const cleanSummary: HumanSummary = {
  headline: "数据集已完成划分与准入检查，四项闸门全部通过，覆盖 100 张样本页。",
  sections: [{ title: "划分方式", items: ["划分依据：你确认的策略。", "比例：训练 80%，测试 20%。"] }],
  metrics: [{ label: "训练页", value: "80" }, { label: "测试页", value: "20" }],
  actions: [
    { title: "推进闸门登记", detail: "逐项推进四项数据闸门的登记复核。", needs_decision: false },
    { title: "裁决标注冲突", detail: "两处候选冲突需要你逐项裁决。", needs_decision: true },
  ],
  pending_confirmations: [{ title: "确认划分比例", detail: "默认 训练:测试 = 8:2，可修改", options: ["默认 8:2", "自定义比例"] }],
  notes: ["技术定位：summary 文件见工作区 runs/<run>/l1/。"],
};

describe("isHumanSummaryShape（六键结构嗅探）", () => {
  it("六键齐备命中；缺键/非对象不命中（回落既有渲染，零回归）", () => {
    expect(isHumanSummaryShape(cleanSummary)).toBe(true);
    expect(isHumanSummaryShape({ headline: "x" })).toBe(false);
    expect(isHumanSummaryShape(null)).toBe(false);
    expect(isHumanSummaryShape({ ...cleanSummary, notes: "不是数组" })).toBe(false);
  });
});

describe("humanSummaryLines（六段版式）", () => {
  it("结论先行→分组→量化→动作（含需要你决定标注）→待确认→补充；next_action 取 needs_decision=false 首条", () => {
    const lines = humanSummaryLines(cleanSummary);
    const text = lines.join("\n");
    expect(lines[0]).toContain("结论：");
    expect(text).toContain("· 划分方式");
    expect(text).toContain("· 训练页：80");
    expect(text).toContain("→ 推进闸门登记");
    expect(text).not.toContain("（需要你决定）\n→ 推进闸门登记");
    expect(text).toContain("→ 裁决标注冲突（需要你决定）");
    expect(text).toContain("? 确认划分比例");
    expect(text).toContain("可选：默认 8:2／自定义比例");
    expect(text).toContain("注：技术定位");
    expect(nextActionOf(cleanSummary)).toBe("逐项推进四项数据闸门的登记复核。");
  });
});

describe("engineeringLeak（负向校验：禁 code／schema 名／digest／gate 名直出）", () => {
  it("四类工程形态逐类命中", () => {
    expect(engineeringLeak("原因码 split_policy_missing 表示缺策略")).toBe(true); // snake_case 工程码
    expect(engineeringLeak("策略版本 DatasetSplitPolicy/v2")).toBe(true); // schema 名
    expect(engineeringLeak(`摘要 ${"a".repeat(64)} 校验`)).toBe(true); // 64 位 hex digest
    expect(engineeringLeak("闸门 G3 当前 blocked")).toBe(true); // gate 名
    expect(engineeringLeak("闸门 extraction-contract-valid 未通过")).toBe(true); // 完整 GateId
  });

  it("纯人读文案不误报（中文与普通数字/比例）", () => {
    expect(engineeringLeak("训练 80%，测试 20%；覆盖 100 张样本页。")).toBe(false);
    expect(engineeringLeak("版式聚类完成：共聚出 3 类版式。")).toBe(false);
  });

  it("主叙述行泄漏 → 渲染降级为中性提示（fail-closed，不放大内核漏映射）", () => {
    const leaked: HumanSummary = {
      ...cleanSummary,
      headline: "准入完成（split_policy_missing 已解除）",
    };
    const lines = humanSummaryLines(leaked);
    expect(lines[0]).toContain("已收起");
    expect(lines[0]).not.toContain("split_policy_missing");
    // notes[] 为工程细节降级区：技术定位原样呈现，不作检测对象
    const withNote = humanSummaryLines({ ...cleanSummary, notes: ["digest=0000000000000000000000000000000000000000000000000000000000000000"] });
    expect(withNote.some((line) => line.includes("digest="))).toBe(true);
  });
});
