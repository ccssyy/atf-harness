import { describe, expect, it } from "vitest";
import { MockDigestResolver } from "../../src/core/session/digestResolver.js";
import { type SessionEvent } from "../../src/core/session/index.js";
import {
  buildSwitchPayload,
  checkSwitchBoundary,
  verifyDigestContinuity,
} from "../../src/core/run/index.js";

/**
 * P2-S3 切换编排原语测试（启动决议口径 #5/#6/#4）：
 * 边界判据 / digest 连续性复跑（正例 + 三类断裂反例：标记残留 / digest 不一致 / resolver 故障）/
 * 载荷定死形态。反例均要求「不放行、不落事件」由 runner 集成侧保证，此处断言原语判定本身。
 */

const DIGEST = "a".repeat(64);
const event = (id: number, overrides: Partial<SessionEvent> = {}): SessionEvent => ({
  id,
  ts: new Date().toISOString(),
  type: "tool/result",
  payload: {},
  projection: { evidence_event: null },
  ...overrides,
});

describe("边界判据（口径 #5：仅 turn 边界合法）", () => {
  it("open turn = 越界 block provider_switch_out_of_boundary；closed turn = null（合法）", () => {
    const block = checkSwitchBoundary(true, { to: "faux-alt" });
    expect(block).not.toBeNull();
    expect(block?.reason).toBe("provider_switch_out_of_boundary");
    expect(checkSwitchBoundary(false)).toBeNull();
  });
});

describe("payload 构造（口径 #4 定死形态；凭据与端点不进载荷）", () => {
  it("字段集恰为 from/to/boundary(+reason)，boundary 含 turn_index 与 after_event_id", () => {
    const withReason = buildSwitchPayload("faux", "faux-alt", 1, 7, "轮换");
    expect(Object.keys(withReason).sort()).toEqual(["boundary", "from", "reason", "to"]);
    expect(withReason).toEqual({
      from: { provider_id: "faux" },
      to: { provider_id: "faux-alt" },
      boundary: { turn_index: 1, after_event_id: 7 },
      reason: "轮换",
    });

    const withoutReason = buildSwitchPayload("faux", "faux-alt", 2, 9);
    expect(Object.keys(withoutReason).sort()).toEqual(["boundary", "from", "to"]);
    expect(withoutReason.boundary).toEqual({ turn_index: 2, after_event_id: 9 });
    expect(JSON.stringify(withoutReason)).not.toContain("credential");
  });
});

describe("digest 连续性复跑（口径 #6：ref_invalid 为零 + resolver 可用）", () => {
  it("正例：全部引用 found + digest 一致 → 通过（含 checked_refs 统计）", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "f1", sha256_digest: DIGEST },
    ]);
    const events = [
      event(1),
      event(2, { domain_refs: [{ journal_type: "run_journal", fact_id: "f1", sha256_digest: DIGEST }] }),
    ];
    const pre = await verifyDigestContinuity(events, resolver, "pre");
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(pre.value.checked_refs).toBe(1);
  });

  it("反例：流内残留 ref_invalid 标记 → provider_switch_digest_broken（不放行）", async () => {
    const resolver = MockDigestResolver.withDigests([]);
    const events = [event(1, { ref_invalid: [{ index: 0, journal_type: "run_journal", fact_id: "f1", claimed_digest: DIGEST, cause: "fact_not_found" }] })];
    const checked = await verifyDigestContinuity(events, resolver, "pre");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.reason).toBe("provider_switch_digest_broken");
      expect(checked.error.message).toContain("ref_invalid");
    }
  });

  it("反例：digest 不一致 / 事实不存在 → provider_switch_digest_broken", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "f1", sha256_digest: "b".repeat(64) }, // 对端 digest 已漂移
    ]);
    const drifted = await verifyDigestContinuity(
      [event(1, { domain_refs: [{ journal_type: "run_journal", fact_id: "f1", sha256_digest: DIGEST }] })],
      resolver,
      "pre",
    );
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) expect(drifted.error.reason).toBe("provider_switch_digest_broken");

    const missing = await verifyDigestContinuity(
      [event(1, { domain_refs: [{ journal_type: "run_journal", fact_id: "ghost", sha256_digest: DIGEST }] })],
      MockDigestResolver.withDigests([]),
      "post",
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("事实不存在");
  });

  it("反例：resolver 查询自身故障 → 断裂处理（基础设施故障不放行切换）", async () => {
    const failing: Parameters<typeof verifyDigestContinuity>[1] = {
      lookupDigest: async () => ({ ok: false, error: { code: "resolver_failure", message: "注入:对端不可用" } }),
    };
    const checked = await verifyDigestContinuity(
      [event(1, { domain_refs: [{ journal_type: "run_journal", fact_id: "f1", sha256_digest: DIGEST }] })],
      failing,
      "pre",
    );
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.reason).toBe("provider_switch_digest_broken");
      expect(checked.error.message).toContain("resolver 查询失败");
    }
  });

  it("无引用流 → 通过（checked_refs = 0，空流等价断言不空转失败）", async () => {
    const checked = await verifyDigestContinuity([event(1)], MockDigestResolver.withDigests([]), "pre");
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.checked_refs).toBe(0);
  });
});
