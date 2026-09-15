/**
 * FactScanResolver——DigestResolver 的 run 层实现（owner 口径 #3：
 * "ATF 侧 run journal 有对应事实"本阶段由 mock 对端进程内状态承载，
 * 真实对端待内核能力落地 re-pin 后接入——与 S1/S2/S3 同口径）。
 *
 * 以严格 4 工具面内的 atf_fact_scan（只读、免审批；契约 v2 起由 v1 证据面扫描方法改名，
 * 数组字段 surface → facts）为查询通道：
 * lookupDigest = 扫描当前 run 可被引用的事实索引 → 命中返回其 digest，未命中 not_found，
 * 桥接/对端故障 → err（会话层语义：不落盘、不标记、不猜测）。
 */
import { err, ok, type Result } from "../../bridge/index.js";
import { TOOL_DEFINITIONS, validateCanonicalOutput, type SchemaNode } from "../tools/index.js";
import { sessionError, type DigestLookup, type DigestResolver, type SessionError } from "../session/index.js";

// 契约 4 工具面的 atf_fact_scan canonical output（缺失即工具定义漂移，启动即失败——fail-closed）
const FACT_SCAN_CANONICAL: SchemaNode = (() => {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === "atf_fact_scan");
  if (definition === undefined) throw new Error("契约 4 工具面缺少 atf_fact_scan（工具定义漂移）");
  return definition.canonical_output;
})();

interface FactEntry {
  journal_type: string;
  fact_id: string;
  sha256_digest: string;
}

export class FactScanResolver implements DigestResolver {
  /** runId：编排层口径（契约 v2 方法面补登 2026-09-13）——run 开始即显式定位，
   *  以显式 params.run_id 调用（显式 run_id 优先于会话绑定，方法无隐式依赖）。 */
  public constructor(
    private readonly connection: FactScanTransport,
    private readonly runId: string,
  ) {}

  public async lookupDigest(journalType: string, factId: string): Promise<Result<DigestLookup, SessionError>> {
    const response = await this.connection.request("atf_fact_scan", { run_id: this.runId });
    if (!response.ok) {
      return err(
        sessionError("resolver_failure", `digest 查询失败（${journalType}/${factId}）: atf_fact_scan 桥接失败（${response.error.code}）`, {
          bridge: response.error,
        }),
      );
    }
    // canonical 校验与工具执行管线同口径（复用契约登记的 atf_fact_scan canonical output）
    const canonical = validateCanonicalOutput("atf_fact_scan", FACT_SCAN_CANONICAL, response.value);
    if (!canonical.ok) {
      return err(sessionError("resolver_failure", `digest 查询失败: ${canonical.error.message}`, { tool: "atf_fact_scan" }));
    }
    const facts = (response.value as { facts: FactEntry[] }).facts;
    const hit = facts.find((entry) => entry.journal_type === journalType && entry.fact_id === factId);
    if (hit === undefined) return ok({ status: "not_found" });
    return ok({ status: "found", sha256_digest: hit.sha256_digest });
  }
}

/** 桥接最小面（AtfBridgeConnection 结构满足；测试可用桩注入）。 */
export interface FactScanTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; detail?: unknown } }>;
}
