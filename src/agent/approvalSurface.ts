/**
 * 丙 v1 批 P 增补 §二 A2——审批问答轨确认卡 surface（四 verdict：granted/denied/
 * suspended/aborted）。
 *
 * runner 语义对齐（P2-S2 问答轨）：granted=放行（持久化前置＝经账本 ledger_record 预录，
 * 消费仍走账本一次性语义）；denied=否决（结构化回填非终局，模型可换路径）；
 * suspended=挂起（超时/输入关闭非否决——75 留痕）；aborted=人中止（79）。
 * headless 缺省无 surface＝approval_missing fail-closed（78），ADR-07 不挪用。
 */
import { EventEmitter } from "node:events";
import { contentDigestPrefix } from "../core/tools/index.js";
import { type ApprovalAuditEntry } from "./approvalHook.js";

export type ApprovalSurfaceVerdict =
  | { kind: "granted" }
  | { kind: "denied" }
  | { kind: "suspended" }
  | { kind: "aborted" };

export interface ApprovalRequestInfo {
  tool: string;
  params_digest: string;
  audit_key: string;
  /** F5 4.2：内容摘要（脚本类提案；同路径重写 → key 变化，卡面附前缀可辨） */
  content_digest?: string;
}

export interface ApprovalSurface {
  ask(info: ApprovalRequestInfo): Promise<ApprovalSurfaceVerdict>;
}

/** verdict → 审计留痕词（approvalHook 审计面共用）。 */
export const surfaceVerdictToAudit = (verdict: ApprovalSurfaceVerdict): ApprovalAuditEntry["verdict"] => {
  switch (verdict.kind) {
    case "granted":
      return "allow_surface_ledger";
    case "denied":
      return "blocked_denied";
    case "suspended":
      return "suspended";
    case "aborted":
      return "aborted";
  }
};

const VERDICT_ALIASES: Readonly<Record<string, ApprovalSurfaceVerdict["kind"]>> = {
  allow: "granted",
  yes: "granted",
  grant: "granted",
  deny: "denied",
  no: "denied",
  suspend: "suspended",
  wait: "suspended",
  abort: "aborted",
  cancel: "aborted",
};

/** 交互确认卡 surface：stdout 出卡、stdin 读一行裁定；超时/流关闭/无法解析 → suspended
 *  （未决非否决，fail-保守不猜授权）。 */
export const createInteractiveApprovalSurface = (opts?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
}): ApprovalSurface => {
  const input = (opts?.input ?? process.stdin) as unknown as EventEmitter & { removeListener: EventEmitter["removeListener"] };
  const output = opts?.output ?? process.stdout;
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  return {
    ask: (info: ApprovalRequestInfo): Promise<ApprovalSurfaceVerdict> =>
      new Promise<ApprovalSurfaceVerdict>((resolve) => {
        const card = [
          "┌── 审批确认卡（写动作需人工裁定）──────────────",
          `│ 工具: ${info.tool}`,
          `│ 参数摘要: ${info.params_digest}`,
          ...(info.content_digest !== undefined ? [`│ 内容摘要: ${contentDigestPrefix(info.content_digest) ?? info.content_digest}（提案引用脚本内容 sha256 前缀——同路径重写后本卡可辨）`] : []),
          `│ 审批键: ${info.audit_key}`,
          "│ 裁定: allow(放行) / deny(否决) / suspend(挂起) / abort(中止)",
          "└──────────────────────────────────────",
        ].join("\n");
        output.write(`${card}\n> `);
        const timer = setTimeout(() => {
          cleanup();
          output.write("\n[审批未决——超时非否决，run 挂起（75）]\n");
          resolve({ kind: "suspended" });
        }, timeoutMs);
        timer.unref?.();
        const onData = (buffer: string | Buffer): void => {
          const line = String(buffer).trim().toLowerCase();
          const kind = VERDICT_ALIASES[line];
          if (kind === undefined) {
            output.write("[输入未解析——未决非否决，run 挂起（75）]\n");
            cleanup();
            resolve({ kind: "suspended" });
            return;
          }
          cleanup();
          resolve({ kind } as ApprovalSurfaceVerdict);
        };
        const onEnd = (): void => {
          cleanup();
          resolve({ kind: "suspended" });
        };
        const onError = (): void => {
          cleanup();
          resolve({ kind: "suspended" });
        };
        const cleanup = (): void => {
          clearTimeout(timer);
          input.removeListener("data", onData);
          input.removeListener("end", onEnd);
          input.removeListener("error", onError);
        };
        input.on("data", onData as (...args: unknown[]) => void);
        input.on("end", onEnd);
        input.on("error", onError);
      }),
  };
};
