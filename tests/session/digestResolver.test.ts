import { describe, expect, it } from "vitest";
import { MockDigestResolver } from "../../src/session/digestResolver.js";

/**
 * DigestResolver 契约 mock 行为（owner 口径 #1：可配置返回指定 digest / 缺失）。
 * 真实对端 = 内核 fact digest 查询能力，落地后 re-pin 接入——本 mock 是其占位对端。
 */

describe("MockDigestResolver——契约 mock（可配置 found / not_found）", () => {
  it("登记的事实 → found + 登记的 digest", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) },
    ]);
    const lookup = await resolver.lookupDigest("run_journal", "fact-1");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.value).toEqual({ status: "found", sha256_digest: "a".repeat(64) });
  });

  it("未登记的事实 → not_found（缺失可配置）", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) },
    ]);
    const lookup = await resolver.lookupDigest("run_journal", "fact-404");
    expect(lookup.ok).toBe(true);
    if (lookup.ok) expect(lookup.value).toEqual({ status: "not_found" });
  });

  it("register / unregister 可动态变更事实状态（模拟内核侧事实演进）", async () => {
    const resolver = new MockDigestResolver();
    resolver.register("run_journal", "fact-1", "a".repeat(64));
    expect((await resolver.lookupDigest("run_journal", "fact-1")).ok).toBe(true);

    resolver.register("run_journal", "fact-1", "b".repeat(64)); // digest 演进（覆盖）
    const updated = await resolver.lookupDigest("run_journal", "fact-1");
    if (updated.ok && updated.value.status === "found") expect(updated.value.sha256_digest).toBe("b".repeat(64));
    else expect.fail("登记后应 found");

    resolver.unregister("run_journal", "fact-1"); // 事实消失
    const gone = await resolver.lookupDigest("run_journal", "fact-1");
    if (gone.ok) expect(gone.value).toEqual({ status: "not_found" });
    else expect.fail("查询不应失败");
  });

  it("同一 fact_id 在不同 journal_type 下互不串扰", async () => {
    const resolver = MockDigestResolver.withDigests([
      { journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) },
    ]);
    const other = await resolver.lookupDigest("gate_journal", "fact-1");
    if (other.ok) expect(other.value).toEqual({ status: "not_found" });
    else expect.fail("查询不应失败");
  });
});
