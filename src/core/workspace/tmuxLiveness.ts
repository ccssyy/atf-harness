/**
 * 批㊶-L L-1——训练会话 liveness 权威面（单源）。
 *
 * 会话名单源常量与探测实现同款语义（tmux has-session -t）；trainingFace 的 tmuxHas
 * 委托本实现（注释互指）。探测异常（tmux 不可用）＝false——调用方 fail-closed 回落
 * mtime 新鲜窗口判据（atf-ui scanRunDir 批㊶-L 终结判定）。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
 *  atf-dsh/atf-dsh-tongshi/atf-m12/atf-v078…；tmux 不可用＝false fail-closed）。
 *  ⚠ 批㊶-O O-1 撤销此判据在 training.active 的使用（泛匹配假阳性）——保留函数仅供
 *  诊断面调用；training.active 的 tmux 判据一律改走 tmuxTrainingEvidenceFor（绑 run 取证）。 */
export const tmuxTrainingFamilyPresent = (): boolean => {
  try {
    const out = execSync("tmux list-sessions -F '#S' 2>/dev/null", { encoding: "utf8" });
    return out.split("\n").some((name) => name.trim().startsWith("atf-"));
  } catch {
    return false;
  }
};

/** 批㊶-O O-1：枚举 atf-* 会话及其 pane 进程 cmdline（含子进程）。
 *  返回 [{session, cmdline}]——cmdline 为 pane 主进程＋直接子进程拼接（训练 python 常为
 *  tmux pane shell 的子进程）。tmux 不可用＝空数组（fail-closed）。 */
export const listTrainingSessionCmdlines = (): Array<{ session: string; cmdline: string }> => {
  try {
    const out = execSync("tmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null", { encoding: "utf8" });
    const result: Array<{ session: string; cmdline: string }> = [];
    const seen = new Set<string>();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const spaceAt = trimmed.indexOf(" ");
      if (spaceAt <= 0) continue;
      const session = trimmed.slice(0, spaceAt);
      if (!session.startsWith("atf-")) continue;
      const panePid = trimmed.slice(spaceAt + 1).trim();
      if (!/^\d+$/.test(panePid)) continue;
      if (seen.has(session)) continue;
      seen.add(session);
      const cmdlines: string[] = [];
      const collect = (pid: string): void => {
        try {
          const buf = readFileSync(`/proc/${pid}/cmdline`);
          cmdlines.push(buf.toString("utf8").replace(/\0/g, " ").trim());
          const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
          for (const child of children.split(/\s+/).filter((c) => c !== "")) collect(child);
        } catch {
          // 进程不可读（已退出/权限）＝跳过
        }
      };
      collect(panePid);
      result.push({ session, cmdline: cmdlines.join(" \n ") });
    }
    return result;
  } catch {
    return [];
  }
};

/** 批㊶-O O-1：绑 run 取证——任一 atf-* 会话进程链 cmdline 含本 run_id 方判定该 run 训练会话在场。
 *  取证异常/无匹配＝false（调用方回落 mtime 新鲜窗口单判据）。只读（不 kill 不改）。 */
export const tmuxTrainingEvidenceFor = (runId: string): boolean => {
  if (runId === "") return false;
  return listTrainingSessionCmdlines().some((entry) => entry.cmdline.includes(runId));
};
