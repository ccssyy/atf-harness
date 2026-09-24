/**
 * 门 1b（批 P）——TEM 层一：EvidenceEvent 镜像（after_tool hook 自动，K4 事实事件投影）。
 *
 * 设计依据：《ATF-Harness_门1b设计_TEM到pi存储映射_20260924.md》§二（字段集 v1）＋
 * 《ATF-TEM_接入设计_双消费者_20260914》三纪律（单一对象模型/同 run 单一写入者/KB 投影）
 * ＋§3.1 失败语义（镜像失败不阻塞 run 收尾）。
 *
 * 存储：pi session custom entry（customType="tem/evidence_event"，append-only 事实层）。
 * 层级澄清：本镜像层 ≠ TEM 服务提交层 EvidenceEvent（后者待 TEM API，接口级设计 §5）。
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import { ATF_UPSTREAM_TAG } from "../../bridge/atfCommand.js";
import { stableStringify } from "../../core/tools/approvalKey.js";
import { ensureMainBranch, type SessionLike } from "../sessionMirror.js";

const context: Context = BACKGROUND_CONTEXT;

/** customType（session 树内 TEM 事实层命名空间）。 */
export const EVIDENCE_CUSTOM_TYPE = "tem/evidence_event";

/** 镜像层 EvidenceEvent（字段集 v1——设计文档 §二；冲突以 TEM 侧对象模型为准）。 */
export interface EvidenceEvent {
  kind: "evidence_event";
  event_id: string;
  correlation_id: string;
  run_id: string | null;
  ts: string;
  tool: string;
  ok: boolean;
  params_digest: string;
  result_summary: string;
  fact_ref?: { journal_type: string; fact_id: string; sha256_digest: string };
  gate?: string;
  env_fingerprint: { model: string; kernel_pin: string };
}

/** 摘要截断上限（chars；canonical 面无凭据——脱敏红线天然满足，截断只为体量）。 */
export const RESULT_SUMMARY_CAP_CHARS = 200;

/** 环境指纹（模型标识由装配方传入；内核 pin 取 bridge 契约镜像常量）。 */
export const envFingerprint = (model: string): { model: string; kernel_pin: string } => ({
  model,
  kernel_pin: ATF_UPSTREAM_TAG,
});

/** params 摘要（stableStringify 同源；sha256 前 16 hex）。 */
export const evidenceParamsDigest = (params: unknown): string =>
  createHash("sha256").update(stableStringify(params)).digest("hex").slice(0, 16);

/** K4 三元组捕获：canonical 结果含 fact_id＋sha256_digest（可含 journal_type）时提取。 */
export const captureFactRef = (result: unknown): EvidenceEvent["fact_ref"] => {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const factId = record["fact_id"];
  const digest = record["sha256_digest"];
  if (typeof factId !== "string" || factId === "" || typeof digest !== "string" || digest === "") return undefined;
  return {
    journal_type: typeof record["journal_type"] === "string" ? (record["journal_type"] as string) : "unknown",
    fact_id: factId,
    sha256_digest: digest,
  };
};

export interface BuildEvidenceEventInput {
  correlationId: string;
  runId: string | null;
  tool: string;
  ok: boolean;
  params: unknown;
  result: unknown;
  model: string;
  gate?: string;
  ts?: Date;
}

/** 组装镜像层 EvidenceEvent（纯函数；result_summary = canonical JSON 截断）。 */
export const buildEvidenceEvent = (input: BuildEvidenceEventInput): EvidenceEvent => {
  let resultSummary: string;
  try {
    resultSummary = (JSON.stringify(input.result) ?? "null").slice(0, RESULT_SUMMARY_CAP_CHARS);
  } catch {
    resultSummary = "<unserializable>";
  }
  const factRef = captureFactRef(input.result);
  return {
    kind: "evidence_event",
    event_id: uuidv7(),
    correlation_id: input.correlationId,
    run_id: input.runId,
    ts: (input.ts ?? new Date()).toISOString(),
    tool: input.tool,
    ok: input.ok,
    params_digest: evidenceParamsDigest(input.params),
    result_summary: resultSummary,
    ...(factRef !== undefined ? { fact_ref: factRef } : {}),
    ...(input.gate !== undefined ? { gate: input.gate } : {}),
    env_fingerprint: envFingerprint(input.model),
  };
};

/** 镜像：EvidenceEvent → session custom entry（追加；失败不反压主链——返回 null 交调用方记 stderr）。 */
export const mirrorEvidenceEvent = async (session: SessionLike, event: EvidenceEvent): Promise<string | null> => {
  try {
    const branch = await ensureMainBranch(session);
    return await branch.appendCustomEntry(EVIDENCE_CUSTOM_TYPE, event as never, context);
  } catch {
    return null; // 失败语义：不阻塞 run 收尾（接入设计 §3.1 同型；调用方记 stderr）
  }
};

/** 扫描当前 session 的全部 EvidenceEvent（时间升序；读取失败 = 空集合——无记忆运行）。 */
export const scanEvidenceEvents = async (session: SessionLike): Promise<EvidenceEvent[]> => {
  try {
    const branch = await session.branch("main", context);
    if (branch === undefined) return [];
    const entries = await branch.findEntries(
      { type: "custom", customType: EVIDENCE_CUSTOM_TYPE, order: "oldestFirst" },
      context,
    );
    return entries
      .map((entry) => (entry as { data?: unknown }).data)
      .filter((data): data is EvidenceEvent => typeof data === "object" && data !== null && (data as EvidenceEvent).kind === "evidence_event");
  } catch {
    return [];
  }
};
