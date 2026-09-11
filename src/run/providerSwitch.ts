/**
 * provider 热切换编排原语（P2-S3，任务书 §4 设计要求 2 / 启动决议口径 #4–#8 / ADR-09
 * §1.4 C9——B 自管基线，切换由场景脚本 segments 段声明，S3 不实现宿主注入）。
 *
 * 三条硬规则（决议口径）：
 * - 边界（#5）：仅 turn 边界合法（无 open turn）；越界 → 结构化 block
 *   provider_switch_out_of_boundary（exit 1，非终局）且不落 switch 事件；
 * - digest 连续性（#6）：切换落盘前后复跑 digest 校验（等价断言：ref_invalid 为零 +
 *   resolver 可用）；失败 → 不落 switch 事件 + block provider_switch_digest_broken；
 * - 原子性（#7）：switch 事件落盘成功且新 provider 生效，要么完全不切，无半生效态。
 *
 * 红线：凭据与端点不进载荷明文（载荷只到 provider_id 粒度，ADR-09 §1.4）。
 */
import { err, ok, type Result } from "../bridge/index.js";
import { type DigestResolver, type SessionEvent } from "../session/index.js";

/** provider/switch 事件载荷（决议口径 #4 定死形态）。 */
export interface ProviderSwitchPayload {
  from: { provider_id: string };
  to: { provider_id: string };
  /** turn_index = 被本切换关闭的 turn 序号（1 起，边界位于该 turn 之后）；after_event_id = 落盘前流内最后事件 id */
  boundary: { turn_index: number; after_event_id: number };
  reason?: string;
}

/** 切换 block 原因面（非终局 = 模型/策略可继续；均不落 switch 事件）。
 *  provider_switch_unknown_provider 为预拍口径未覆盖的注册表未命中防御路径（fail-closed）。 */
export type ProviderSwitchBlockReason =
  | "provider_switch_out_of_boundary"
  | "provider_switch_digest_broken"
  | "provider_switch_unknown_provider";

export interface ProviderSwitchBlock {
  reason: ProviderSwitchBlockReason;
  message: string;
  detail?: unknown;
}

/** 边界判据（口径 #5）：仅 turn 边界合法（无 open turn）。返回 null = 合法。 */
export const checkSwitchBoundary = (turnOpen: boolean, detail?: unknown): ProviderSwitchBlock | null => {
  if (!turnOpen) return null;
  return {
    reason: "provider_switch_out_of_boundary",
    message: "provider 切换越界：仅 turn 边界可切换（turn 内 / 无 turn 上下文一律拒绝），不落 switch 事件",
    ...(detail !== undefined ? { detail } : {}),
  };
};

/**
 * digest 连续性复核（口径 #6）：对流内全部事件复跑 digest 校验——
 * ① ref_invalid 标记必须为零；② 逐条引用经 resolver 复核（found + digest 一致）；
 * ③ resolver 查询自身失败 = 断裂（基础设施故障不放行切换）。stage 仅用于归因（pre/post）。
 */
export const verifyDigestContinuity = async (
  events: readonly SessionEvent[],
  resolver: DigestResolver,
  stage: "pre" | "post",
): Promise<Result<{ checked_refs: number }, ProviderSwitchBlock>> => {
  let checkedRefs = 0;
  for (const event of events) {
    if (event.ref_invalid !== undefined && event.ref_invalid.length > 0) {
      return err({
        reason: "provider_switch_digest_broken",
        message: `digest 连续性复核失败（${stage}）：流内事件 ${String(event.id)} 携带 ref_invalid 标记——${stage === "pre" ? "不落 switch 事件、不放行切换" : "切换后流不可信"}`,
        detail: { event_id: event.id, ref_invalid: event.ref_invalid },
      });
    }
    for (const ref of event.domain_refs ?? []) {
      checkedRefs += 1;
      const lookup = await resolver.lookupDigest(ref.journal_type, ref.fact_id);
      if (!lookup.ok) {
        return err({
          reason: "provider_switch_digest_broken",
          message: `digest 连续性复核失败（${stage}）：resolver 查询失败（${ref.journal_type}/${ref.fact_id}）——不放行切换`,
          detail: { ref, cause: lookup.error },
        });
      }
      if (lookup.value.status === "found" && lookup.value.sha256_digest === ref.sha256_digest) continue;
      return err({
        reason: "provider_switch_digest_broken",
        message: `digest 连续性复核失败（${stage}）：引用 ${ref.journal_type}/${ref.fact_id} ${lookup.value.status === "found" ? "digest 不一致" : "事实不存在"}——${stage === "pre" ? "不落 switch 事件、不放行切换" : "切换后流不可信"}`,
        detail: { ref, status: lookup.value.status },
      });
    }
  }
  return ok({ checked_refs: checkedRefs });
};

/** 构造 provider/switch 载荷（口径 #4 定死形态；reason 仅在声明时携带）。 */
export const buildSwitchPayload = (
  from: string,
  to: string,
  turnIndex: number,
  afterEventId: number,
  reason?: string,
): ProviderSwitchPayload => ({
  from: { provider_id: from },
  to: { provider_id: to },
  boundary: { turn_index: turnIndex, after_event_id: afterEventId },
  ...(reason !== undefined ? { reason } : {}),
});
