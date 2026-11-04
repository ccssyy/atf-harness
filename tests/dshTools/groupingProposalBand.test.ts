/**
 * D173 对抗锚：分组候选组数区间机检（出卡前拦截，owner 2026-11-04 裁定）。
 * 真机形态复现：候选 6 组（业务语义）/1 组（平铺全字段）曾照常出卡（卡面只
 * 标注「超出建议组数区间」）——本断言锚定 parseGroupingProposal 出卡前拦截。
 */
import { afterAll, describe, expect, it } from "vitest";
import { parseGroupingProposal } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

const candidateOf = (groupCount: number, fieldsPerGroup: number) => ({
  name: `${String(groupCount)} 组候选`,
  recommended: true,
  groups: Array.from({ length: groupCount }, (_, i) => ({
    name: `g${String(i + 1)}`,
    fields: Array.from({ length: fieldsPerGroup }, (_, j) => `f${String(i)}_${String(j)}`),
  })),
});

describe("D173 分组候选组数区间机检", () => {
  it("6 组候选拒（真机 ci-bl-test-1104-1 形态复现）", () => {
    const verdict = parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(6, 5)],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.includes("超过最多 5 组"))).toBe(true);
  });

  it("1 组（平铺全字段）拒——字段总数≥4 可两全时", () => {
    const verdict = parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(1, 25)],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.some((e) => e.includes("没分组"))).toBe(true);
  });

  it("2-3 组候选放行；小字段集（<4 字段）单组豁免", () => {
    expect(parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(3, 4)],
    }).ok).toBe(true);
    expect(parseGroupingProposal({
      schema_version: "GroupingProposal/v1",
      candidates: [candidateOf(1, 3)],
    }).ok).toBe(true);
  });
});

// ── D196（11-05 v-round-1105 实锤）：all_fields=true 路径的覆盖校验 ──
// D185 补修的条件洞:!all_fields 才做字段覆盖对账——全选路径跳过,
// f_a/f_b 类不存在字段提案静默落账(用户分组被构造段忽略,无静默违约)。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGroupingFace } from "../../packages/extensions/atf-tools/src/pipelineFace.js";

describe("D196 全选路径分组覆盖校验", () => {
  const homes: string[] = [];
  const seedAllFields = (fields: string[]): string => {
    const runDir = mkdtempSync(join(tmpdir(), "d196-"));
    homes.push(runDir);
    mkdirSync(join(runDir, "runtime", "webui"), { recursive: true });
    mkdirSync(join(runDir, "webui"), { recursive: true });
    // field-choice 账本:全选形态(all_fields=true + 全量清单——v-round 会话回显实证)
    writeFileSync(join(runDir, "webui", "field-choice.json"),
      JSON.stringify({ schema_version: "FieldChoice/v1", all_fields: true, confirmed_fields: fields }));
    writeFileSync(join(runDir, "runtime", "webui", "field-choice.json"),
      JSON.stringify({ schema_version: "FieldChoice/v1", all_fields: true, confirmed_fields: fields }));
    return runDir;
  };
  const ctx = { get: () => undefined };
  const exec = { agent: undefined, signal: undefined };

  it("全选账本 + 提案带不存在字段(f_a/f_b) → 拒并点名(D196 洞修复)", async () => {
    const runDir = seedAllFields(["shipper", "consignee", "bl_no"]);
    const verdict = await resolveGroupingFace({
      ctx, exec, runId: "r", fieldConfigPath: join(runDir, "fc.json"), runDir, fieldChoiceConfirmed: true,
      proposalRaw: { schema_version: "GroupingProposal/v1", candidates: [{
        name: "c1", recommended: true, reason: "",
        groups: [{ name: "g0", fields: ["f_a", "f_b"] }, { name: "g1", fields: ["f_solo"] }],
      }] },
    });
    expect((verdict as { decision?: string }).decision).toBe("none");
    expect((verdict as { note?: string }).note ?? "").toContain("f_a");
    expect((verdict as { note?: string }).note ?? "").toContain("漏了");
  });

  it("全选账本 + 提案漏字段 → 拒并点名漏项", async () => {
    const runDir = seedAllFields(["shipper", "consignee", "bl_no"]);
    const verdict = await resolveGroupingFace({
      ctx, exec, runId: "r", fieldConfigPath: join(runDir, "fc.json"), runDir, fieldChoiceConfirmed: true,
      proposalRaw: { schema_version: "GroupingProposal/v1", candidates: [{
        name: "c1", recommended: true, reason: "",
        groups: [{ name: "g0", fields: ["shipper", "consignee"] }], // 漏 bl_no
      }] },
    });
    expect((verdict as { decision?: string }).decision).toBe("none");
    expect((verdict as { note?: string }).note ?? "").toContain("bl_no");
  });

  it("全选账本 + 提案字段全对齐 → 过(合法分组不误拦)", async () => {
    const runDir = seedAllFields(["shipper", "consignee", "bl_no"]);
    const verdict = await resolveGroupingFace({
      ctx, exec, runId: "r", fieldConfigPath: join(runDir, "fc.json"), runDir, fieldChoiceConfirmed: true,
      proposalRaw: { schema_version: "GroupingProposal/v1", candidates: [{
        name: "c1", recommended: true, reason: "",
        groups: [{ name: "g0", fields: ["shipper"] }, { name: "g1", fields: ["consignee", "bl_no"] }],
      }] },
    });
    // 判据=覆盖校验未拦(note 无不一致点名;选定/待选由档位决定,非本锚对象)
    expect((verdict as { note?: string }).note ?? "").not.toContain("不一致");
    expect((verdict as { note?: string }).note ?? "").not.toContain("漏了");
  });

  afterAll(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
});
