/**
 * SurfaceScanResolver——DigestResolver 的 run 层实现（owner 口径 #3：
 * "ATF 侧 run journal 有对应事实"本阶段由 mock 对端进程内状态承载，
 * 真实对端待内核能力落地 re-pin 后接入——与 S1/S2/S3 同口径）。
 *
 * 以严格 4 工具面内的 atf_surface_scan（只读、免审批）为查询通道：
 * lookupDigest = 扫描当前 run 已登记事实 → 命中返回其 digest，未命中 not_found，
 * 桥接/对端故障 → err（会话层语义：不落盘、不标记、不猜测）。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { TOOL_DEFINITIONS, validateCanonicalOutput, type SchemaNode } from "../tools/index.js";
import { sessionError, type DigestLookup, type DigestResolver, type SessionError } from "../session/index.js";

// 契约 4 工具面的 atf_surface_scan canonical output（缺失即工具定义漂移，启动即失败——fail-closed）
const SURFACE_SCAN_CANONICAL: SchemaNode = (() => {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === "atf_surface_scan");
  if (definition === undefined) throw new Error("契约 4 工具面缺少 atf_surface_scan（工具定义漂移）");
  return definition.canonical_output;
})();

interface SurfaceEntry {
  journal_type: string;
  fact_id: string;
  sha256_digest: string;
}

export class SurfaceScanResolver implements DigestResolver {
  public constructor(private readonly connection: SurfaceScanTransport) {}

  public async lookupDigest(journalType: string, factId: string): Promise<Result<DigestLookup, SessionError>> {
    const response = await this.connection.request("atf_surface_scan", {});
    if (!response.ok) {
      return err(
        sessionError("resolver_failure", `digest 查询失败（${journalType}/${factId}）: atf_surface_scan 桥接失败（${response.error.code}）`, {
          bridge: response.error,
        }),
      );
    }
    // canonical 校验与工具执行管线同口径（复用契约登记的 atf_surface_scan canonical output）
    const canonical = validateCanonicalOutput("atf_surface_scan", SURFACE_SCAN_CANONICAL, response.value);
    if (!canonical.ok) {
      return err(sessionError("resolver_failure", `digest 查询失败: ${canonical.error.message}`, { tool: "atf_surface_scan" }));
    }
    const surface = (response.value as { surface: SurfaceEntry[] }).surface;
    const hit = surface.find((entry) => entry.journal_type === journalType && entry.fact_id === factId);
    if (hit === undefined) return ok({ status: "not_found" });
    return ok({ status: "found", sha256_digest: hit.sha256_digest });
  }
}

/** 桥接最小面（AtfBridgeConnection 结构满足；测试可用桩注入）。 */
export interface SurfaceScanTransport {
  request(method: string, params?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; detail?: unknown } }>;
}
