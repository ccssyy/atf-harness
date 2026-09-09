import { describe, expect, it } from "vitest";
import { err } from "../../src/bridge/index.js";
import { SurfaceScanResolver, type SurfaceScanTransport } from "../../src/run/index.js";

/**
 * S5 SurfaceScanResolver 测试（owner 口径 #3：digest 查询经 mock 对端 atf_surface_scan 承载）。
 */

const OK_SURFACE = {
  ok: true,
  value: {
    ok: true,
    count: 1,
    surface: [{ journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) }],
  },
};

const transport = (outcome: unknown): SurfaceScanTransport => ({
  request: async () => outcome as Awaited<ReturnType<SurfaceScanTransport["request"]>>,
});

describe("S5 SurfaceScanResolver", () => {
  it("命中 → found + digest；未命中 → not_found（经严格 4 工具面 atf_surface_scan 查询）", async () => {
    const resolver = new SurfaceScanResolver(transport(OK_SURFACE));

    const hit = await resolver.lookupDigest("run_journal", "fact-1");
    expect(hit).toEqual({ ok: true, value: { status: "found", sha256_digest: "a".repeat(64) } });

    const miss = await resolver.lookupDigest("run_journal", "fact-404");
    expect(miss).toEqual({ ok: true, value: { status: "not_found" } });
  });

  it("对端 canonical 破损 → err(resolver_failure)（不猜测）", async () => {
    const resolver = new SurfaceScanResolver(
      transport({ ok: true, value: { ok: true, count: 1, surface: [{ journal_type: "run_journal", fact_id: "fact-1" }] } }),
    );
    const broken = await resolver.lookupDigest("run_journal", "fact-1");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.code).toBe("resolver_failure");
  });

  it("桥接故障 → err(resolver_failure)（会话层语义：不落盘、不标记、不猜测）", async () => {
    const resolver = new SurfaceScanResolver({
      request: async () => err({ code: "closed", message: "连接尚未就绪" }),
    });
    const failed = await resolver.lookupDigest("run_journal", "fact-1");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("resolver_failure");
  });
});
