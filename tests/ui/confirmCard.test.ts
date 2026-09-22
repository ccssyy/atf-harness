/**
 * L1c 提前批 A2（2026-09-22）：两阶段确认卡——识别／渲染／harness 译码／逐项修改／
 * 审批一致性回显（纯函数面；TUI 交互挂点在 tui.ts）。
 * 交互闭环纪律：确认卡与工具链（propose→execute／request）同批交付（本批＝UI 补齐批）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyFieldInput,
  canonicalConfirmationText,
  cardFields,
  confirmCardFromResult,
  confirmCardLines,
  confirmationEchoLine,
  type ConfirmCard,
} from "../../src/ui/confirmCard.js";

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL("../fixtures/realvolume/${name}".replace("${name}", name), import.meta.url), "utf8"));

const splitCard: ConfirmCard = {
  kind: "split",
  factId: "ds-3b7551bca6ec@5fe2a8c9a98b",
  template: { target_ratios: { train: 0.8, test: 0.2 }, style_cluster_assignment_ref: "l1/ds-x@pin/style-cluster-assignment.json", policy_id: null, seed: null },
};

describe("A2 确认卡：识别（模板回显单源）", () => {
  it("propose 真实体 fixture（五跑 #18）→ 聚类卡：六键模板＋登记身份", () => {
    const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
    expect(card).not.toBeNull();
    if (card === null) throw new Error("unreachable");
    expect(card.kind).toBe("cluster");
    expect(card.factId).toBe("ds-3b7551bca6ec@5fe2a8c9a98b");
    expect(Object.keys(card.template).sort()).toEqual([
      "algorithm_version", "granularity", "linkage", "metric", "min_cluster_size", "threshold",
    ]);
  });

  it("split_confirmation＋policy_template → 划分卡；无模板（合法复查 propose）→ null 不弹卡", () => {
    const split = confirmCardFromResult({ ok: true, fact_id: "ds-x@pin", stage: "split_confirmation", policy_template: splitCard.template });
    expect(split?.kind).toBe("split");
    expect(confirmCardFromResult({ ok: true, fact_id: "ds-x@pin", stage: "split_confirmation" })).toBeNull();
    expect(confirmCardFromResult({ ok: true, fact_id: "ds-x@pin", stage: "cluster_confirmation" })).toBeNull();
    expect(confirmCardFromResult("not-an-object")).toBeNull();
  });
});

describe("A2 确认卡：渲染（中文名＋推荐值；B 静默口径）", () => {
  it("聚类卡行：卡头＋聚类一句＋推荐参数（内核模板）＋中文标签＋推荐值＋应答键位", () => {
    const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
    if (card === null) throw new Error("unreachable");
    const text = confirmCardLines(card).join("\n");
    expect(text).toContain("确认卡 · 版式聚类参数（数据集 ds-3b7551bca6ec@5fe2a8c9a98b）");
    expect(text).toContain("推荐参数（内核模板，可直接采用）");
    expect(text).toContain("分组粒度：\"page\"");
    expect(text).toContain("最小组容量：\"1\"");
    expect(text).toContain("算法版本：\"bbox_layout_v1\"");
    expect(text).toContain("1=按推荐确认 2=逐项修改");
    // 值闭集零复制断言的另一面：取值来自模板回显（与 fixture 逐字一致）
    expect(text).toContain("\"auto_candidates\"");
  });

  it("划分卡行：null 待定字段不向用户要值（owner 21:38 原则）", () => {
    const text = confirmCardLines(splitCard).join("\n");
    expect(text).toContain("确认卡 · 数据划分策略");
    expect(text).toContain("划分比例：{\"train\":0.8,\"test\":0.2}");
    expect(text).toContain("策略标识：（由 Agent 按模板规则补全）");
    const fields = cardFields(splitCard);
    expect(fields.find((field) => field.key === "policy_id")?.editable).toBe(false);
    expect(fields.find((field) => field.key === "target_ratios")?.editable).toBe(true);
  });
});

describe("A2 确认卡：harness 译码（三道防线之一）＋逐项修改", () => {
  it("一键确认译码：规范化文本含逐字段精确值＋逐字复制指令（用户不碰参数名）", () => {
    const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
    if (card === null) throw new Error("unreachable");
    const text = canonicalConfirmationText(card, { ...card.template });
    expect(text).toContain("【确认卡·聚类参数】");
    expect(text).toContain('algorithm_version="bbox_layout_v1"');
    expect(text).toContain('min_cluster_size="1"');
    expect(text).toContain("逐字");
    expect(text).toContain("atf_style_cluster_execute");
  });

  it("划分译码：比例人读＋待定字段标注由 Agent 补全（审批弹窗回显）", () => {
    const text = canonicalConfirmationText(splitCard, { ...splitCard.template });
    expect(text).toContain("【确认卡·划分策略】");
    expect(text).toContain("待定字段（policy_id、seed）");
    expect(text).toContain("atf_data_admission_request");
    expect(text).toContain("80:20（百分比）");
  });

  it("逐项修改：7:3 简写按模板键序映射（键名单源=模板）；回车保留；非 JSON 落字符串", () => {
    const next = applyFieldInput(splitCard, "target_ratios", "7:3", { ...splitCard.template });
    expect(next["target_ratios"]).toEqual({ train: 0.7, test: 0.3 });
    const kept = applyFieldInput(splitCard, "policy_id", "", { ...splitCard.template });
    expect(kept["policy_id"]).toBeNull();
    const raw = applyFieldInput(splitCard, "policy_id", "abc", { ...splitCard.template });
    expect(raw["policy_id"]).toBe("abc");
    const numeric = applyFieldInput(splitCard, "seed", "42", { ...splitCard.template });
    expect(numeric["seed"]).toBe(42);
  });
});

describe("A2 确认卡：审批一致性回显（三道防线之三；只提示不拦截）", () => {
  const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
  if (card === null) throw new Error("unreachable");
  const confirmed = { ...card.template };

  it("实际提交＝确认值 → （与确认卡一致）", () => {
    const params = { dataset_id: "ds-3b7551bca6ec", cluster_params: { ...card.template } };
    expect(confirmationEchoLine("atf_style_cluster_execute", params, card, confirmed)).toBe("（与确认卡一致）");
  });

  it("漂移 → 逐键差异中文回显（相似阈值：确认 …→ 实际 …）", () => {
    const drifted = { dataset_id: "ds-3b7551bca6ec", cluster_params: { ...card.template, threshold: "0.30", extra_key: "x" } };
    const echo = confirmationEchoLine("atf_style_cluster_execute", drifted, card, confirmed);
    expect(echo).toContain("与确认卡不一致");
    expect(echo).toContain("相似阈值");
    expect(echo).toContain("auto_candidates");
    expect(echo).toContain("0.30");
  });

  it("无关工具 / 未确认卡 → null（不回显）；调用未携带参数对象 → 提示", () => {
    const params = { dataset_id: "ds-3b7551bca6ec", cluster_params: { ...card.template } };
    expect(confirmationEchoLine("atf_admit_data", params, card, confirmed)).toBeNull();
    expect(confirmationEchoLine("atf_style_cluster_execute", params, null, null)).toBeNull();
    expect(confirmationEchoLine("atf_style_cluster_execute", { dataset_id: "x" }, card, confirmed)).toContain("未携带");
  });
});
