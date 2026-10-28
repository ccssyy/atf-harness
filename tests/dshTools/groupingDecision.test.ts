/**
 * D-c 防回退：分组选择**账本**（用户选定 → 落盘 → 重跑沿用）。
 *
 * 现场（dev 2026-10-28 webui 真机）：C2 分组卡弹出、用户选定「按业务域分五组」，
 * 但选定只是 `resolveGroupingFace` 的进程内返回值；该段随后失败（field_config 错误归因，
 * experiment_setup 连续四次失败）→ 零写入 → 选择蒸发。agent 原话：
 * 「那次零写入，选定记录没存下来」。重跑只能再问一遍，换会话必然重问。
 *
 * 这里锁四件事：
 * 1. 写入即读回一致（记录里必须有 payload——否则重跑下传不了「用户选了哪套」）；
 * 2. 字段集合**顺序变/内容换行**不算失效（agent 会重写字段配置，那不代表分组决策失效）；
 * 3. 字段**增删**必须失效（不能拿旧选择套新字段），且失效原因是人话；
 * 4. 账本损坏/版本不符 → 视为不可用（malformed），不静默当成"没选过"。
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROUPING_DECISION_SCHEMA,
  fieldsDigestOf,
  groupingDecisionPathOf,
  readGroupingDecision,
  writeGroupingDecision,
} from "../../packages/extensions/atf-tools/src/groupingDecision.js";

const runDirOf = (): string => mkdtempSync(join(tmpdir(), "atf-gd-"));

/** 造一份字段配置：ids 决定指纹。 */
const fieldConfigOf = (ids: string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "atf-gd-cfg-"));
  const path = join(dir, "field-config.json");
  writeFileSync(
    path,
    JSON.stringify({ document_type: "awb", fields: ids.map((id) => ({ field_id: id, group: "g" })) }),
    "utf8",
  );
  return path;
};

const recordOf = (candidateName: string, fieldCount: number, digest: string | null) => ({
  run_id: "run-awb-01",
  candidate_name: candidateName,
  groups: [{ name: "文档标识", fields: ["awb_title"] }] as Record<string, unknown>[],
  payload: { schema_version: "GroupingProposal/v1", candidates: [{ name: candidateName, recommended: true }] },
  fields_digest: digest,
  field_count: fieldCount,
  decided_at: "2026-10-28T17:20:00.000Z",
  source: "user_selected" as const,
});

describe("fieldsDigestOf（字段集合指纹）", () => {
  it("字段顺序不同但集合相同 → 指纹相同（agent 重写配置不该让选择失效）", () => {
    expect(fieldsDigestOf(fieldConfigOf(["a", "b", "c"]))).toBe(fieldsDigestOf(fieldConfigOf(["c", "a", "b"])));
  });

  it("字段增删 → 指纹变化", () => {
    expect(fieldsDigestOf(fieldConfigOf(["a", "b"]))).not.toBe(fieldsDigestOf(fieldConfigOf(["a", "b", "c"])));
  });

  it("文件不存在 / 空路径 → null（无法判定，调用方按允许继承处理）", () => {
    expect(fieldsDigestOf("")).toBeNull();
    expect(fieldsDigestOf(join(tmpdir(), "atf-gd-absent.json"))).toBeNull();
  });
});

describe("分组选择账本（写入 → 读回 → 沿用判定）", () => {
  it("写入后落在 runtime/webui 下（不是判定账目录），且读回一致（payload 必须在）", () => {
    const runDir = runDirOf();
    const digest = fieldsDigestOf(fieldConfigOf(["a", "b"]));
    const path = writeGroupingDecision(runDir, recordOf("按业务域分五组", 2, digest));

    expect(path).toBe(groupingDecisionPathOf(runDir));
    // 卡面输入态 → runtime/webui（v3）／webui（v2 存量树）；**不是** analysis/decisions
    // （那是内核 DecisionGate 的判定账：每个询问点问还是自动决定 + 依据，语义不同层）
    expect(path).toContain("webui");
    expect(path).not.toContain("analysis");
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { schema_version?: string };
    expect(onDisk.schema_version).toBe(GROUPING_DECISION_SCHEMA);

    const read = readGroupingDecision(runDir, digest);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.candidate_name).toBe("按业务域分五组");
      // 重跑要能原样下传「用户选了哪套」——payload 缺了就等于没记住
      expect(read.record.payload).toEqual(recordOf("按业务域分五组", 2, digest).payload);
    }
  });

  it("字段集合未变 → 沿用（不出卡）", () => {
    const runDir = runDirOf();
    const cfg = fieldConfigOf(["a", "b", "c"]);
    writeGroupingDecision(runDir, recordOf("业务域五组", 3, fieldsDigestOf(cfg)));
    const read = readGroupingDecision(runDir, fieldsDigestOf(cfg));
    expect(read.ok).toBe(true);
  });

  it("字段集合变了 → stale，且理由是人话（含前后字段数）", () => {
    const runDir = runDirOf();
    writeGroupingDecision(runDir, recordOf("业务域五组", 3, fieldsDigestOf(fieldConfigOf(["a", "b", "c"]))));
    const read = readGroupingDecision(runDir, fieldsDigestOf(fieldConfigOf(["a", "b", "c", "d"])));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toBe("stale");
      expect(read.note).toContain("已作废");
      expect(read.note).toContain("业务域五组");
      expect(read.note).toContain("3");
      expect(read.note).toContain("4");
    }
  });

  it("没选过 → absent（note 为空，调用方按无账本继续）", () => {
    const read = readGroupingDecision(runDirOf(), "digest-x");
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toBe("absent");
      expect(read.note).toBe("");
    }
  });

  it("账本坏行 / 版本不符 / 缺 payload → malformed（不静默当成没选过）", () => {
    const bad = runDirOf();
    const path = groupingDecisionPathOf(bad);
    mkdirSync(join(bad, "webui"), { recursive: true });   // 卡面输入态目录（v2 树名）

    writeFileSync(path, "{ not json", "utf8");
    const broken = readGroupingDecision(bad, null);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.reason).toBe("malformed");

    writeFileSync(path, JSON.stringify({ schema_version: "GroupingChoice/v0", candidate_name: "x", groups: [] }), "utf8");
    const wrongVersion = readGroupingDecision(bad, null);
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.reason).toBe("malformed");

    // 版本对、groups 有，但缺 payload → 仍不可用（重跑下传不了选择）
    writeFileSync(
      path,
      JSON.stringify({ schema_version: GROUPING_DECISION_SCHEMA, candidate_name: "x", groups: [], fields_digest: null }),
      "utf8",
    );
    const noPayload = readGroupingDecision(bad, null);
    expect(noPayload.ok).toBe(false);
    if (!noPayload.ok) expect(noPayload.reason).toBe("malformed");
  });
});
