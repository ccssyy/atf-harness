/**
 * F5 改动四 4.1 单元用例（2026-09-26）——confirm 型请示核心（core/confirmRequest.ts）：
 * 卡面渲染（三要素齐备才成卡/长 prompt 截断留痕）／确认报告收集（inline 与报告文件并集、
 * 缺项 fail-closed 拒空心卡）／候选摘要复算（内核 canonical form；非法 JSON 拒绝）／
 * 确认凭据合成（by/at 账面事实、approval_ref=approval_session_id）。
 */
import { describe, expect, it } from "vitest";
import {
  candidateDigestFromText,
  collectConfirmReport,
  renderConfirmRequestLines,
  synthesizeUserConfirmation,
  UNPRODUCED_FIELDS_SECTION_TITLE,
  unproducedFieldsFromCandidateText,
  type ConfirmRequestBody,
  type ContractConfirmationReport,
} from "../../src/core/confirmRequest.js";
import { canonicalDigestHex } from "../../src/core/canonicalDigest.js";

const REPORT: ConfirmRequestBody = {
  kind: "confirm",
  title: "抽取契约发布确认",
  candidate_ref: "scratch/candidate.json",
  prompt_texts: ["训练 Prompt 实文……", "评估 Prompt 实文……"],
  field_ids: ["invoice_number", "date", "total"],
  coordinate_policy: "pixel",
};

describe("F5 4.1 collectConfirmReport——三要素缺一即拒（空心卡面禁放行）", () => {
  it("inline 齐备 → 成卡（field_ids/坐标策略/prompt 实文透传）", () => {
    const report = collectConfirmReport(REPORT, undefined);
    expect(report).not.toBeNull();
    expect(report?.field_ids).toEqual(["invoice_number", "date", "total"]);
    expect(report?.coordinate_policy).toBe("pixel");
    expect(report?.prompt_texts).toHaveLength(2);
  });

  it("inline 缺项由报告文件补齐（并集语义）", () => {
    const report = collectConfirmReport(
      { kind: "confirm", candidate_ref: "c.json", coordinate_policy: "pixel" },
      { prompt_texts: ["文件内 prompt"], field_ids: ["a", "b"] },
    );
    expect(report).not.toBeNull();
    expect(report?.field_ids).toEqual(["a", "b"]);
    expect(report?.prompt_texts).toEqual(["文件内 prompt"]);
  });

  it("缺字段序 → null（不渲染空心卡——F5 §一.3 空心报告教训）", () => {
    expect(collectConfirmReport({ kind: "confirm", candidate_ref: "c.json", prompt_texts: ["p"], coordinate_policy: "pixel" }, undefined)).toBeNull();
  });

  it("缺坐标策略 → null", () => {
    expect(collectConfirmReport({ kind: "confirm", candidate_ref: "c.json", prompt_texts: ["p"], field_ids: ["a"] }, undefined)).toBeNull();
  });

  it("缺 prompt 实文（报告文件也没有）→ null", () => {
    expect(collectConfirmReport({ kind: "confirm", candidate_ref: "c.json", field_ids: ["a"], coordinate_policy: "pixel" }, undefined)).toBeNull();
  });

  it("空数组字段序视同缺失 → null", () => {
    expect(collectConfirmReport({ kind: "confirm", candidate_ref: "c.json", prompt_texts: ["p"], field_ids: [], coordinate_policy: "pixel" }, undefined)).toBeNull();
  });
});

describe("F5 4.1 renderConfirmRequestLines——卡面用户可读", () => {
  it("卡面含字段序（顺序敏感）、坐标策略、逐份 prompt 实文与凭据说明", () => {
    const report = collectConfirmReport(REPORT, undefined);
    expect(report).not.toBeNull();
    if (report === null) throw new Error("unreachable");
    const lines = renderConfirmRequestLines(report, "abcd1234ef5678".repeat(4));
    const text = lines.join("\n");
    expect(text).toContain("字段序（3 项）：invoice_number、date、total");
    expect(text).toContain("坐标策略：pixel");
    expect(text).toContain("[1] 训练 Prompt 实文……");
    expect(text).toContain("[2] 评估 Prompt 实文……");
    expect(text).toContain("sha256:abcd1234ef56…");
    expect(text).toContain("审批会话号");
  });

  it("超长 prompt 实文截断留痕（卡面人读体量纪律；全文长度可见）", () => {
    const report = collectConfirmReport(
      { ...REPORT, prompt_texts: ["长".repeat(1000)] },
      undefined,
    );
    if (report === null) throw new Error("unreachable");
    const lines = renderConfirmRequestLines(report, "abcd");
    const text = lines.join("\n");
    expect(text).toContain("…(截断，全文 1000 字符见报告文件)");
    expect(text.length).toBeLessThan(2000);
  });
});

describe("F5 4.1 candidateDigestFromText——内核 canonical form 复算", () => {
  it("键序无关：同内容不同键序 JSON → 同一摘要（canonical sort_keys 语义）", () => {
    const a = candidateDigestFromText('{"b":1,"a":"中文"}');
    const b = candidateDigestFromText('{"a":"中文","b":1}');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).toBe(canonicalDigestHex({ b: 1, a: "中文" }));
  });

  it("内容不同 → 摘要不同（确认对象绑定语义）", () => {
    expect(candidateDigestFromText('{"a":1}')).not.toBe(candidateDigestFromText('{"a":2}'));
  });

  it("非法 JSON → null（handler 折 invalid_input，不猜摘要）", () => {
    expect(candidateDigestFromText("not-json{")).toBeNull();
  });
});

describe("F5 4.1 synthesizeUserConfirmation——凭据合成（改动一 1.1/1.3 形态）", () => {
  it("by/at 取自账面应答、approval_ref＝approval_session_id、channel 固定、digest 透传", () => {
    const credential = synthesizeUserConfirmation({
      actor: "tui-operator",
      answeredAt: "2026-09-26T10:00:00.000Z",
      candidateDigest: "deadbeef",
      approvalSessionId: "aps-3",
    });
    expect(credential).toEqual({
      by: "tui-operator",
      at: "2026-09-26T10:00:00.000Z",
      channel: "harness-confirm-card",
      candidate_digest: "deadbeef",
      approval_ref: "aps-3",
    });
  });
});

// ---------------------------------------------------------------------------
// E15b——无生产者字段呈现（指令件 afd30333）：单源解析／卡面节仅非空出现／超限截断
// ---------------------------------------------------------------------------

describe("E15b unproducedFieldsFromCandidateText——候选单源解析（形态非法拒绝指路）", () => {
  const candidateWith = (projection: unknown): string => JSON.stringify({ field_projection: projection });

  it("缺省（无 field_projection/unproduced_targets）→ ok 且无 fields（卡面零该节）", () => {
    expect(unproducedFieldsFromCandidateText('{"fields":[]}')).toEqual({ ok: true });
    expect(unproducedFieldsFromCandidateText(candidateWith({ target_fields: ["a"] }))).toEqual({ ok: true });
  });

  it("空数组 → ok 且无 fields（缺省/空数组不传）", () => {
    expect(unproducedFieldsFromCandidateText(candidateWith({ unproduced_targets: [] }))).toEqual({ ok: true });
  });

  it("两条声明 → 三键映射（declared_at 留内核不上卡）", () => {
    const parsed = unproducedFieldsFromCandidateText(candidateWith({
      unproduced_targets: [
        { field_id: "hs_code", reason: "业务要、数据零页", declared_by: "owner", declared_at: "2026-10-18T00:00:00Z" },
        { field_id: "currency", reason: "本轮未训练", declared_by: "agent" },
      ],
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.fields).toEqual([
      { field_id: "hs_code", reason: "业务要、数据零页", declared_by: "owner" },
      { field_id: "currency", reason: "本轮未训练", declared_by: "agent" },
    ]);
  });

  it.each([
    ["非数组", candidateWith({ unproduced_targets: "hs_code" }), "得非数组"],
    ["元素非对象", candidateWith({ unproduced_targets: ["hs_code"] }), "须为对象"],
    ["缺 field_id", candidateWith({ unproduced_targets: [{ reason: "r", declared_by: "d" }] }), "缺 field_id/reason/declared_by"],
    ["缺 declared_by", candidateWith({ unproduced_targets: [{ field_id: "f", reason: "r" }] }), "缺 field_id/reason/declared_by"],
    ["field_projection 非对象", JSON.stringify({ field_projection: 3 }), "须为对象"],
  ])("形态非法：%s → ok:false 带指路", (_label, text, part) => {
    const parsed = unproducedFieldsFromCandidateText(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.message).toContain("候选契约 field_projection.unproduced_targets 须为 [{field_id,reason,declared_by}]");
    expect(parsed.message).toContain(part);
  });
});

describe("E15b renderConfirmRequestLines——无生产者字段节（仅非空出现／超限截断）", () => {
  const reportWith = (fields: ContractConfirmationReport["unproduced_fields"]): ContractConfirmationReport => ({
    prompt_texts: ["p"],
    field_ids: ["a", "b"],
    coordinate_policy: "pixel",
    ...(fields !== undefined ? { unproduced_fields: fields } : {}),
  });

  it("两条声明 → 标题节逐字＋两行（字段：原因（声明人 x））", () => {
    const lines = renderConfirmRequestLines(
      reportWith([
        { field_id: "hs_code", reason: "业务要、数据零页", declared_by: "owner" },
        { field_id: "currency", reason: "本轮未训练", declared_by: "agent" },
      ]),
      "abcd1234ef56",
    );
    const text = lines.join("\n");
    expect(text).toContain(UNPRODUCED_FIELDS_SECTION_TITLE);
    expect(text).toContain("本轮未训练，输出为空属预期");
    expect(text).toContain("- hs_code：业务要、数据零页（声明人 owner）");
    expect(text).toContain("- currency：本轮未训练（声明人 agent）");
  });

  it("无声明 → 卡面零该节（回归：三要素仍过）", () => {
    const lines = renderConfirmRequestLines(reportWith(undefined), "abcd1234ef56");
    const text = lines.join("\n");
    expect(text).not.toContain("无生产者字段");
    expect(text).toContain("字段序（2 项）：a、b");
    expect(text).toContain("坐标策略：pixel");
  });

  it("超 20 项 → 截断前 20 行＋注明共 N 项（数据不丢语义）", () => {
    const fields = Array.from({ length: 25 }, (_, i) => ({ field_id: `f${String(i)}`, reason: "业务要、数据零页", declared_by: "owner" }));
    const lines = renderConfirmRequestLines(reportWith(fields), "abcd1234ef56");
    const itemLines = lines.filter((line) => line.includes("（声明人 owner）"));
    expect(itemLines).toHaveLength(20);
    expect(lines.join("\n")).toContain("…共 25 项");
  });
});
