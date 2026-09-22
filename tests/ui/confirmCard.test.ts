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
  synthesizeAction,
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
  it("聚类卡行：卡头＋聚类一句＋内置推荐参数＋中文标签＋推荐值＋闭集值域＋应答键位（批 2.5 §三.2/§三.3 文案）", () => {
    const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
    if (card === null) throw new Error("unreachable");
    const text = confirmCardLines(card).join("\n");
    expect(text).toContain("确认卡 · 版式聚类参数（数据集 ds-3b7551bca6ec@5fe2a8c9a98b）");
    expect(text).toContain("内置推荐参数（可直接采用）");
    expect(text).not.toContain("内核模板");
    expect(text).toContain("分组粒度：\"page\"（取值：page）");
    expect(text).toContain("最小组容量：\"1\"");
    expect(text).toContain("算法版本：\"bbox_layout_v1\"");
    expect(text).toContain("1=按推荐确认 2=逐项修改");
    expect(text).toContain("其余参数（内置项与待定项）由系统按推荐规则自动补全，实际值在执行前回显。");
  });

  it("划分卡行：内置键与待定键卡面折叠不暴露，只列用户可决键（批 2.5 §三.2）", () => {
    const text = confirmCardLines(splitCard).join("\n");
    expect(text).toContain("确认卡 · 数据划分策略");
    expect(text).toContain("划分比例：{\"train\":0.8,\"test\":0.2}");
    expect(text).not.toContain("策略标识");
    expect(text).not.toContain("分配模式");
    expect(text).toContain("其余参数（内置项与待定项）由系统按推荐规则自动补全，实际值在执行前回显。");
    const fields = cardFields(splitCard);
    expect(fields.find((field) => field.key === "policy_id")?.hidden).toBe(true);
    expect(fields.find((field) => field.key === "style_cluster_assignment_ref")?.hidden).toBe(true); // builtIn 键折叠
    expect(fields.find((field) => field.key === "target_ratios")?.hidden).toBe(false);
    expect(fields.find((field) => field.key === "target_ratios")?.editable).toBe(true);
  });
});

describe("A2 确认卡：harness 译码（三道防线之一）＋逐项修改", () => {
  it("一键确认译码：规范化文本含逐字段精确值＋确定性合成声明（模型决策面收窄为读结果）", () => {
    const card = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
    if (card === null) throw new Error("unreachable");
    const text = canonicalConfirmationText(card, { ...card.template });
    expect(text).toContain("【确认卡·聚类参数】");
    expect(text).toContain('algorithm_version="bbox_layout_v1"');
    expect(text).toContain('min_cluster_size="1"');
    expect(text).toContain("系统将按上述确认值直接执行");
    expect(text).toContain("确定性合成，不经模型改写");
    expect(text).toContain("atf_style_cluster_execute");
  });

  it("划分译码：比例人读＋待定项系统补全声明（执行前回显）", () => {
    const text = canonicalConfirmationText(splitCard, { ...splitCard.template });
    expect(text).toContain("【确认卡·划分策略】");
    expect(text).toContain("待定项由系统按推荐规则自动补全");
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

// ---------------------------------------------------------------------------
// 批 2.5 §一 A2.5（2026-09-22）：确定性合成——核心判据＝确认值 → params 逐字节一致（无 LLM 参与）。
// digest 对码基准＝内核自身 canonical_digest 实算值（.atf-pinned v0.7.3b1 实读运行，
// 处置① 对码：policy_id 非空字符串✓／seed int✓／integrity_digest 提交方必须自带）。
// ---------------------------------------------------------------------------
describe("A2.5 确认直填：确定性合成（synthesizeAction）", () => {
  const clusterCard = confirmCardFromResult(loadFixture("propose-cluster-template.json"));
  if (clusterCard === null) throw new Error("unreachable");

  it("聚类：确认值 → cluster_params 与模板六键逐字一致；dataset_id/pin 自 factId 确定性解析", () => {
    const action = synthesizeAction(clusterCard, { ...clusterCard.template }, new Date("2026-09-22T00:00:00Z"));
    expect(action.tool).toBe("atf_style_cluster_execute");
    expect(action.origin).toBe("confirm_card");
    expect(action.params["dataset_id"]).toBe("ds-3b7551bca6ec");
    expect(action.params["pin"]).toBe("5fe2a8c9a98b");
    expect(action.params["cluster_params"]).toEqual(clusterCard.template); // 逐字节（同键同值同序）
    expect(JSON.stringify(action.params["cluster_params"])).toBe(JSON.stringify(clusterCard.template));
  });

  it("划分：模板全键保留＋确认值覆盖＋null 补全（policy_id/seed 规则值）＋integrity_digest＝内核算法", () => {
    // 对码卡模板＝处置① 参考载荷逐键（七键，与内核 canonical_digest 实算输入完全一致）
    const digestCard: ConfirmCard = {
      kind: "split",
      factId: "ds-3b7551bca6ec@5fe2a8c9a98b",
      template: {
        assignment_mode: "recompute_with_policy",
        auto_style_cluster: false,
        policy_id: null,
        schema_version: "DatasetSplitPolicy/v2",
        seed: null,
        split_strategy: "cluster_content_family_seeded",
        target_ratios: { test: 0.2, train: 0.8 },
      },
    };
    const confirmed = { ...digestCard.template, target_ratios: { train: 0.8, test: 0.2 } };
    const action = synthesizeAction(digestCard, confirmed, new Date("2026-09-22T00:00:00Z"));
    expect(action.tool).toBe("atf_data_admission_request");
    const policy = action.params["split_policy"] as Record<string, unknown>;
    // 补全规则值（确定性；处置① 对码：policy_id 非空串✓、seed int✓）
    expect(policy["policy_id"]).toBe("policy-ds-3b7551bca6ec-20260922");
    expect(policy["seed"]).toBe(0);
    expect(policy["target_ratios"]).toEqual({ train: 0.8, test: 0.2 });
    expect(policy["split_strategy"]).toBe("cluster_content_family_seeded");
    // ★digest 对码（处置①核心）：TS 移植必须复现内核 canonical_digest 的实算值
    expect(policy["integrity_digest"]).toBe("sha256:a896daa38ac832756b048d25d6164ec6407a276f5c0abc243f6d32099a2ba13d");
  });

  it("确定性：同 (card, confirmed, now) 同输出（无 LLM 参与的可测形态）", () => {
    const a = synthesizeAction(splitCard, { ...splitCard.template }, new Date("2026-09-22T00:00:00Z"));
    const b = synthesizeAction(splitCard, { ...splitCard.template }, new Date("2026-09-22T00:00:00Z"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
