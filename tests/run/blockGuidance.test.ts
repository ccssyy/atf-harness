/**
 * 走查修复小批 §二.3/§三.3（2026-09-23）：extraction_contract_bundle_missing 缺料指引条目
 * ——命中即出可行动文案（含「勿遍历文件系统找料」，直接治走查 A4 全盘扫描）；material gap
 * 形态与既有 split_policy_missing 同构（缺口卡四段＋options ≤3 首条推荐＋停止出口）。
 */
import { describe, expect, it } from "vitest";
import { INTEGRITY_GATE_IDS } from "../../src/core/tools/index.js";
import { gapCardFor, guidanceFor, guidanceLineFor, integrityGateBlockedGuidance, isMaterialGapCode } from "../../src/core/run/blockGuidance.js";

describe("走查修复小批：extraction_contract_bundle_missing 缺料指引", () => {
  const code = "extraction_contract_bundle_missing";

  it("回流附注：命中即出指引，含「勿遍历文件系统找料」与补齐路径（atf-validate-extraction-contract publish）", () => {
    const line = guidanceLineFor(code);
    expect(line).toBeDefined();
    expect(line).toContain(code);
    expect(line).toContain("勿遍历文件系统找料");
    expect(line).toContain("atf-validate-extraction-contract");
    expect(line).toContain("ExtractionContractBundle");
  });

  it("material gap 同构：isMaterialGapCode=true；缺口卡四段＋options ≤3 首条推荐＋停止出口", () => {
    expect(isMaterialGapCode(code)).toBe(true);
    const entry = guidanceFor(code);
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("unreachable");
    expect(entry.meaning.length).toBeGreaterThan(0);
    expect(entry.missing.length).toBeGreaterThan(0);
    expect(entry.producedBy).toContain("atf-validate-extraction-contract");
    expect(entry.why.length).toBeGreaterThan(0);
    const card = gapCardFor("atf_admit_data", code);
    expect(card.stuck).toContain(code);
    expect(card.missing).toBe(entry.missing);
    expect(card.why).toBe(entry.why);
    expect(card.options.length).toBeGreaterThanOrEqual(1);
    expect(card.options.length).toBeLessThanOrEqual(3);
    expect(card.options[0]?.recommended).toBe(true);
    expect(card.options[card.options.length - 1]?.text).toContain("停止");
  });

  it("登记面既有条目零扰动（split_policy_missing 仍命中既有文案）", () => {
    expect(guidanceLineFor("split_policy_missing")).toContain("划分");
  });

  it("R-3 接线批：label_qc_required 前瞻登记——指路一键体检入口，勿遍历文件系统（现 pin 不触发）", () => {
    const line = guidanceLineFor("label_qc_required");
    expect(line).toContain("label_qc_required");
    expect(line).toContain("atf_label_qc.inspect");
    expect(line).toContain("勿遍历文件系统");
    expect(isMaterialGapCode("label_qc_required")).toBe(false); // 模型可自 remediate：调工具
  });

  it("R-3 接线批：label_qc_pending——material gap 请示式；未决不默认＋勿重复探查", () => {
    const line = guidanceLineFor("label_qc_pending");
    expect(line).toContain("整体阻断");
    expect(line).toContain("勿默认处置");
    expect(line).toContain("勿重复探查");
    expect(isMaterialGapCode("label_qc_pending")).toBe(true);
    const card = gapCardFor("atf_data_admission_request", "label_qc_pending");
    expect(card.options[0]?.recommended).toBe(true);
    expect(card.options[card.options.length - 1]?.text).toContain("停止");
  });
});

// ---------------------------------------------------------------------------
// 走查修复批 B3（2026-09-23，指令 7158bf43）：完整性闸门 blocked 三段式指引——
// [缺什么]（闸门结果 missing 透传，不新增猜测）＋[产出路径]（技能链名）＋[登记动作]
// （atf_gate action=advance 示例）；内核原始 guidance 保留拼接、不覆盖。仅 harness 措辞层。
// ---------------------------------------------------------------------------
describe("走查修复批 B3：完整性闸门 blocked 三段式指引", () => {
  const blockedResult = {
    ok: true,
    gate: "extraction-contract-valid",
    status: "blocked",
    reason: "required_evidence_missing",
    reason_codes: ["required_evidence_missing"],
    missing: ["artifact:contract-bundle:abc123"],
    guidance: "该完整性闸门推进所必需的证据缺失。补齐路径:按该闸门对应流程补齐证据产物后重新推进。",
  };

  it("extraction-contract-valid blocked → 三段齐备＋产出路径锚定＋登记动作示例（走查 #2254 同形态）", () => {
    const line = integrityGateBlockedGuidance("extraction-contract-valid", blockedResult);
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("unreachable");
    // 三段齐备（fixture 断言三段）
    expect(line).toContain("缺什么：");
    expect(line).toContain("产出路径：");
    expect(line).toContain("登记动作：");
    // 段序：缺什么 → 产出路径 → 登记动作
    expect(line.indexOf("缺什么：")).toBeLessThan(line.indexOf("产出路径："));
    expect(line.indexOf("产出路径：")).toBeLessThan(line.indexOf("登记动作："));
    // 第一段：缺失证据清单从结果透传（不新增猜测）
    expect(line).toContain("artifact:contract-bundle:abc123");
    // 第二段：技能链名（指令原文锚定）
    expect(line).toContain("atf-validate-extraction-contract");
    expect(line).toContain("atf-build-family-split 技能 publish 节");
    // 第三段：advance 携证据引用示例
    expect(line).toContain('atf_gate(gate="extraction-contract-valid", action="advance"');
    // 被拦原因码在案
    expect(line).toContain("required_evidence_missing");
    // 内核原始 guidance 保留拼接、不覆盖
    expect(line).toContain("内核指引：该完整性闸门推进所必需的证据缺失");
  });

  it("missing 未列明（走查 #2254 实测形态）→ 指向 query 回显核对，不编造清单；reason 取 reason_codes 首位", () => {
    const line = integrityGateBlockedGuidance("extraction-contract-valid", {
      ok: true,
      gate: "extraction-contract-valid",
      status: "blocked",
      reason_codes: ["required_evidence_missing"],
    });
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("unreachable");
    expect(line).toContain("未列明缺失清单");
    expect(line).toContain('action="query"');
    expect(line).not.toContain("缺什么：artifact"); // 无清单即不造清单
    expect(line).toContain("required_evidence_missing"); // reason 兜底自 reason_codes[0]
  });

  it("七组完整性 GateId 全映射产出路径；内核无 guidance → 无拼接段", () => {
    for (const gate of INTEGRITY_GATE_IDS) {
      const line = integrityGateBlockedGuidance(gate, { gate, status: "blocked", reason_codes: ["x"] });
      expect(line, `${gate} 应命中三段式`).toBeDefined();
      expect(line).toContain("产出路径：");
    }
    const bare = integrityGateBlockedGuidance("training-data-valid", { gate: "training-data-valid", status: "blocked" });
    expect(bare).toBeDefined();
    if (bare !== undefined) expect(bare).not.toContain("内核指引：");
  });

  it("非完整性闸门（G1 命名分流）／非 blocked 状态 → undefined（零加工透传既有行为）", () => {
    expect(integrityGateBlockedGuidance("G1", { gate: "G1", status: "blocked" })).toBeUndefined();
    // pass/warn 为合法业务产出（非被拦），不附指引
    expect(integrityGateBlockedGuidance("extraction-contract-valid", { gate: "extraction-contract-valid", status: "pass" })).toBeUndefined();
    expect(integrityGateBlockedGuidance("extraction-contract-valid", { gate: "extraction-contract-valid", status: "warn" })).toBeUndefined();
    // 形态异常（非对象结果）→ undefined（fail-closed 不猜测）
    expect(integrityGateBlockedGuidance("extraction-contract-valid", "not-an-object")).toBeUndefined();
    expect(integrityGateBlockedGuidance(undefined, { status: "blocked" })).toBeUndefined();
  });

  // F5 改动二同步（2026-09-26）：内核 guidance 结构化三段式对象 → renderGuidanceText
  // 人读展开后保留拼接段（不静默丢段）；字符串形态零回归由上方既有用例承载。
  it("F5：内核 guidance 结构化对象 → 「内核指引」拼接三段渲染文本", () => {
    const line = integrityGateBlockedGuidance("extraction-contract-valid", {
      gate: "extraction-contract-valid",
      status: "blocked",
      reason_codes: ["contract_experiment_gate_required"],
      guidance: {
        current_node: "发布受理（publish_contract）",
        missing: ["实验门产物标记"],
        legal_path: "先跑 build_experiment_setup.py",
      },
    });
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("unreachable");
    expect(line).toContain("内核指引：当前流程节点：发布受理（publish_contract）");
    expect(line).toContain('前序缺失：["实验门产物标记"]');
    expect(line).toContain("合法取得路径：先跑 build_experiment_setup.py");
  });
});
