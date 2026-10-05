/**
 * G1 拆解单元④（批㉞H-H3，沿门 1 设计稿「持久性（session.jsonl 读写）」边界）：历史装载读面。
 * resume/continue 的会话流读取＋逐行校验收口（durability 公理：恢复只读本侧事件流——历史由
 * 事实日志重放装载进内存序列，此后 appendEvent 顺序续接）。错误形态保真透传（read 径
 * message＋code／parse 径 ResumeChannelError 原样——runner 折算 RunError 的 detail 逐位不变）。
 * 写面（appendEvent/appendTurnEnd 的预算注入与铁律一折算）深耦合 outcome 收口，保留编排层。
 */
import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "../../bridge/index.js";
import type { SessionEvent } from "../session/index.js";
import { parseSessionStream, type ResumeChannelError } from "./resume.js";

export type RunHistoryError =
  | { kind: "read"; error: { message: string; code?: string } }
  | { kind: "parse"; error: ResumeChannelError };

/** 会话流全文读（文件缺失/不可读 → err(read)；错误对象形状与原 runner 内联形态逐位一致）。 */
export const readSessionLogText = (sessionLogPath: string): Promise<Result<string, { message: string; code?: string }>> =>
  readFile(sessionLogPath, "utf8").then(
    (text) => ok(text),
    (cause: NodeJS.ErrnoException) => err({ message: `会话流读取失败: ${String(cause.message)}`, code: cause.code }),
  );

/** resume/continue 历史装载：读＋校验（fail-closed）→ 既有事件序列（空流合法——continue 的
 *  空流拒绝属编排层前置，不在本单元判定）。 */
export const loadRunHistory = async (sessionLogPath: string): Promise<Result<SessionEvent[], RunHistoryError>> => {
  const text = await readSessionLogText(sessionLogPath);
  if (!text.ok) return err({ kind: "read", error: text.error });
  const parsed = parseSessionStream(text.value);
  if (!parsed.ok) return err({ kind: "parse", error: parsed.error });
  return ok(parsed.value);
};
