/**
 * 审批拦截退役后的 before_tool hook（ADR-0022：去拦截留留账）。
 *
 * 原授权拦截链（账本轨 ledger_query/consume、scope_ref fail-closed、approval_missing
 * 78 终局、denial 升级终止、GateLock 账本临界区锁）随 ADR-0022 退役；本 hook 保留：
 *   ① 工具面收敛护栏：未注册工具 fail-closed 拦截（与审批无关的收敛不变量）；
 *   ② 业务确认卡轨：requiresUserConfirmationOf true 的工具经 surface 出卡等待真人
 *      应答——granted 放行／denied 结构化回填（非终局）／suspended/aborted 终态
 *      （75/79——确认卡超时非否决/人中止）；无 surface（headless 无人值守）＝直通
 *      留痕（stderr 通报），不再 fail-closed（D284 语义退役）；
 *   ③ 审计留痕：内存数组（进程内消费面）＋ session approval_audit custom entry
 *      （best-effort fail-open，见 approvalAudit.ts）。
 * 只读/链内推进（requiresUserConfirmationOf false）一律直通（留痕义务在消费点）。
 */
import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { requiresUserConfirmationOf } from "../core/tools/index.js";
import type { AtfAgentToolDeps } from "./atfAgentTools.js";
import { toolDefinitionFor } from "./atfAgentTools.js";
import { surfaceVerdictToAudit, type ApprovalSurface } from "./approvalSurface.js";
import { buildApprovalAuditStreamEntry, type ApprovalAuditSource, type ApprovalAuditStream } from "./approvalAudit.js";

export interface ApprovalAuditEntry {
  tool: string;
  verdict:
    | "allow_readonly"
    | "allow_surface"
    | "blocked_unknown_tool"
    | "blocked_track_failed"
    | "denied"
    | "suspended"
    | "aborted";
  /** requiresUserConfirmationOf 判定（true = 须业务确认卡；false = 直通）。 */
  requiresApproval: boolean;
  detail?: unknown;
}

export interface ApprovalHookDeps extends AtfAgentToolDeps {
  /** 审计数组（调用方持有；测试断言）。 */
  audit: ApprovalAuditEntry[];
  /** 确认卡 surface——缺省无＝headless 直通留痕（ADR-0022）。 */
  surface?: ApprovalSurface;
  /** 豁免面（装配期本地工具——如 dispatch_training_subtask：派发动作免确认，
   *  治理点在子任务内写动作过同一确认卡轨）。 */
  exemptTools?: readonly string[];
  /** 确认卡裁定留痕入流（best-effort fail-open）。缺省不注入＝纯内存留痕。 */
  auditStream?: ApprovalAuditStream;
}

/** 终态拦截结果（terminate = run 级终止：确认卡 suspended/aborted 的库内映射）。 */
const block = (reason: string): BeforeToolCallResult => ({ block: true, reason, terminate: true });

/** 组装 beforeToolCall hook（Agent 构造参数 beforeToolCall 直用）。 */
export const createApprovalBeforeToolCall = (deps: ApprovalHookDeps) => {
  return async (context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const toolName = context.toolCall.name;
    const params = context.args;
    if ((deps.exemptTools ?? []).includes(toolName)) {
      deps.audit.push({ tool: toolName, verdict: "allow_readonly", requiresApproval: false, detail: { why: "装配期本地工具（豁免面）" } });
      return undefined;
    }
    // 全 face 查找单点：未注册工具 fail-closed（工具面收敛护栏，与审批无关）
    const definition = toolDefinitionFor(toolName);
    if (definition === undefined) {
      deps.audit.push({ tool: toolName, verdict: "blocked_unknown_tool", requiresApproval: true, detail: { why: "工具面收敛（fail-closed）" } });
      return block(`未注册工具（工具面收敛，fail-closed）: ${toolName}`);
    }
    const requiresApproval = requiresUserConfirmationOf(definition, params);
    if (!requiresApproval) {
      deps.audit.push({ tool: toolName, verdict: "allow_readonly", requiresApproval: false });
      return undefined; // 直通（只读/链内推进——留痕义务在消费点）
    }

    // ---- 业务确认卡轨（ADR-0022 后唯一闸：真人应答，非授权拦截）----
    const emitAudit = async (verdict: ApprovalAuditEntry["verdict"], source: ApprovalAuditSource): Promise<void> => {
      if (deps.auditStream === undefined) return;
      try {
        await deps.auditStream.write(buildApprovalAuditStreamEntry(`${toolName}:${Date.now()}`, verdict, source));
      } catch {
        /* fail-open：注入面异常亦不阻断（approvalAudit.ts 文件头语义） */
      }
    };
    if (deps.surface === undefined) {
      // headless 无人值守：确认卡无人可出——直通留痕（D284 fail-closed 语义退役）
      deps.audit.push({ tool: toolName, verdict: "allow_surface", requiresApproval: true, detail: { why: "headless 直通留痕（无 surface）" } });
      await emitAudit("allow_surface", "surface");
      process.stderr.write(`[atf-approval] ${toolName} 确认卡无人可出——直通留痕（ADR-0022）\n`);
      return undefined;
    }
    let verdict: Awaited<ReturnType<ApprovalSurface["ask"]>>;
    try {
      verdict = await deps.surface.ask({ tool: toolName, params_digest: "", audit_key: `${toolName}:${Date.now()}` });
    } catch {
      deps.audit.push({ tool: toolName, verdict: "blocked_track_failed", requiresApproval: true, detail: { why: "surface 故障" } });
      await emitAudit("blocked_track_failed", "surface");
      return { block: true, reason: `确认卡 surface 故障——fail-closed 不放行: ${toolName}` };
    }
    deps.audit.push({ tool: toolName, verdict: surfaceVerdictToAudit(verdict), requiresApproval: true, detail: { why: "确认卡应答" } });
    await emitAudit(surfaceVerdictToAudit(verdict), "surface");
    if (verdict.kind === "denied") {
      // 否决＝结构化回填非终局（模型可换路径）
      return { block: true, reason: `操作员否决（denied）: ${toolName}——请如实转述并停止该路径` };
    }
    if (verdict.kind === "suspended" || verdict.kind === "aborted") {
      // 挂起（75）/中止（79）＝run 级终局（确认卡语义的库内映射）
      return block(
        verdict.kind === "suspended"
          ? `确认卡挂起（suspended）：操作员未决——run 以 exit 75 收口（超时/未决非否决）: ${toolName}`
          : `确认卡中止（aborted）：操作员中止——run 以 exit 79 收口: ${toolName}`,
      );
    }
    return undefined; // granted：确认卡放行 → 工具执行
  };
};
