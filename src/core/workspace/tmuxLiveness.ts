/**
 * 批㊶-L L-1——训练会话 liveness 权威面（单源）。
 *
 * 会话名单源常量与探测实现同款语义（tmux has-session -t）；trainingFace 的 tmuxHas
 * 委托本实现（注释互指）。探测异常（tmux 不可用）＝false——调用方 fail-closed 回落
 * mtime 新鲜窗口判据（atf-ui scanRunDir 批㊶-L 终结判定）。
 */
import { execSync } from "node:child_process";

export const TRAINING_TMUX_SESSION = "atf-training-run";

export const tmuxHasSession = (session: string = TRAINING_TMUX_SESSION): boolean => {
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
};

/** 批㊶-N N-2：tmux 训练会话族判定——前缀 `atf-` 任一会话在场即 true（实况会话族
 *  atf-dsh/atf-dsh-tongshi/atf-m12/atf-v078…；tmux 不可用＝false fail-closed）。 */
export const tmuxTrainingFamilyPresent = (): boolean => {
  try {
    const out = execSync("tmux list-sessions -F '#S' 2>/dev/null", { encoding: "utf8" });
    return out.split("\n").some((name) => name.trim().startsWith("atf-"));
  } catch {
    return false;
  }
};
