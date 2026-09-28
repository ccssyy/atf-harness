/**
 * F8-B2（批② 20260928，指令 1eb91324）——turn 终局后的 TUI 交互续跑判定（纯函数可测锚）。
 *
 * 缺陷（走查 v078 实锚）：turn 失败/收口后输入态不复位——TUI 主循环对 failed／aborted 族
 * 一律 break 退出，pty 侧表现为"输入回显不提交、仅重启可解"。修法：TTY 交互下
 * completed／turn_failed／failed／aborted 四类 turn 级终局一律回到新指令循环（输入态经
 * rl.resume 可靠复位，连续两轮失败 turn 不再卡死输入）；suspended／approval_missing／
 * session_rejected 保留退出语义（恢复通道指引：CLI resume／引用修正，续跑不经本进程）。
 * 非 TTY（冒烟/headless）恒退出——既有退出码语义零变化。
 */
import type { BranchOutcome } from "../core/run/index.js";

const INTERACTIVE_CONTINUE_KINDS: readonly BranchOutcome["kind"][] = ["completed", "turn_failed", "failed", "aborted"];

export const continuesInteractive = (outcomeKind: BranchOutcome["kind"], isTTY: boolean): boolean =>
  isTTY && (INTERACTIVE_CONTINUE_KINDS as readonly string[]).includes(outcomeKind);
