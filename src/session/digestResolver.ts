/**
 * DigestResolver——domain_refs digest 校验的对端注入口（owner 口径 #1）。
 *
 * 任务书 S2-2 所述"引用前向 ATF 查询该 fact 的当前 digest"，本阶段由本接口承载：
 * 真实对端 = 内核 fact digest 查询能力（尚未落地，按 owner 决议 ②1 同口径在 ATF 仓排队，
 * 不阻塞、不插队）；S2 提供契约 mock 实现，内核落地 re-pin 后接入真实实现。
 */
import { type Result } from "../bridge/index.js";
import { type SessionError } from "./errors.js";

/** 单次 digest 查询结果。 */
export type DigestLookup =
  | { status: "found"; sha256_digest: string }
  | { status: "not_found" };

export interface DigestResolver {
  /**
   * 查询某领域事实的当前 digest。
   * - ok(found)   —— 事实存在，返回其当前 digest
   * - ok(not_found) —— 事实不存在（引用失效的一种）
   * - err         —— 查询基础设施自身失败：调用方不落盘、不标记、不猜测
   */
  lookupDigest(journalType: string, factId: string): Promise<Result<DigestLookup, SessionError>>;
}

/**
 * 契约 mock 实现（可配置返回指定 digest / 缺失——owner 口径 #1）。
 * 登记表内的事实返回 found + 登记的 digest；未登记一律 not_found。
 * 查询永不失败（无故障注入需求时）；需要"查询基础设施失败"反例的测试
 * 自行提供内联 resolver 即可，本实现保持最简。
 */
export class MockDigestResolver implements DigestResolver {
  private readonly entries = new Map<string, string>();

  /** 以登记表构造：key = `${journal_type}::${fact_id}`。 */
  public static withDigests(
    entries: ReadonlyArray<{ journal_type: string; fact_id: string; sha256_digest: string }>,
  ): MockDigestResolver {
    const resolver = new MockDigestResolver();
    for (const entry of entries) resolver.register(entry.journal_type, entry.fact_id, entry.sha256_digest);
    return resolver;
  }

  /** 登记（或覆盖）一条事实的当前 digest——模拟内核侧事实状态。 */
  public register(journalType: string, factId: string, sha256Digest: string): void {
    this.entries.set(MockDigestResolver.key(journalType, factId), sha256Digest);
  }

  /** 注销一条事实——模拟事实从内核消失（后续查询 not_found）。 */
  public unregister(journalType: string, factId: string): void {
    this.entries.delete(MockDigestResolver.key(journalType, factId));
  }

  public async lookupDigest(journalType: string, factId: string): Promise<Result<DigestLookup, never>> {
    const digest = this.entries.get(MockDigestResolver.key(journalType, factId));
    if (digest === undefined) return { ok: true, value: { status: "not_found" } };
    return { ok: true, value: { status: "found", sha256_digest: digest } };
  }

  private static key(journalType: string, factId: string): string {
    return `${journalType}::${factId}`;
  }
}
