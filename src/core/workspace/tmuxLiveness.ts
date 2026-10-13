/**
 * 批㊶-L L-1——训练会话 liveness 权威面（单源）；批㊶-ISO E1——会话命名域单源化。
 *
 * 会话名解析单源＝resolveSessionName(base)＝ATF_TMUX_SESSION_PREFIX（env）＋ base：
 * dev/uat 两实例在同一容器默认 tmux socket 上靠前缀划分命名域，会话名互不命中
 * （kill/枚举失去跨域目标——20261011/20261012 两次同型误杀事故的结构根源在此收口）。
 * 前缀 env 未设置时 kill/枚举/探测一律 fail-closed 拒绝（B4 语义 {ok:false,reason,guidance}，
 * guidance 随 status 面错误回流可见）；launch（new-session）不受 fail-closed 限制
 * （resolveLaunchSessionName：前缀在则带前缀，未设回退裸 base——存量语义）。
 *
 * 命令构造单源＝tmuxCommand(sub)：D2① 测试面经 ATF_TMUX_TEST_SOCKET 注入 `-L`（仅认
 * atf-test-* 值——生产路径不可能被指到业务 socket）；生产无 env＝默认 socket。
 * trainingFace/oomFallback/atf-ui server 的全部 tmux 调用经本模块（结构锚防回潮）。
 * 探测异常（tmux 不可用）＝present:false——调用方 fail-closed 回落 mtime 新鲜窗口判据
 * （atf-ui scanRunDir 批㊶-L 终结判定）。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const TRAINING_TMUX_SESSION = "atf-training-run";
/** 评估编排会话（atf_evaluate ⑥ tmux 后台）——同属命名域（dev/uat 评估编排同型冲突面）。 */
export const EVAL_ORCH_TMUX_SESSION = "atf-eval-orch";

export const TMUX_SESSION_PREFIX_ENV = "ATF_TMUX_SESSION_PREFIX";
/** D2① 测试专用 socket 注入 env——仅认 atf-test-* 值（见 tmuxSocketFlag）。 */
export const TMUX_TEST_SOCKET_ENV = "ATF_TMUX_TEST_SOCKET";

const prefixFromEnv = (): string => (process.env[TMUX_SESSION_PREFIX_ENV] ?? "").trim();

/** 会话名解析结果（B4 语义——拒绝带 reason＋guidance）。 */
export type SessionNameResolution =
  | { ok: true; session: string }
  | { ok: false; reason: string; guidance: string };

/** E1 单源：会话名＝ATF_TMUX_SESSION_PREFIX＋base。前缀未设→ok:false（kill/枚举/探测
 *  fail-closed——禁止触碰默认 socket 会话）；launch 域不走本函数（resolveLaunchSessionName）。 */
export const resolveSessionName = (base: string): SessionNameResolution => {
  const prefix = prefixFromEnv();
  if (prefix === "") {
    return {
      ok: false,
      reason: `session_prefix_unset:${TMUX_SESSION_PREFIX_ENV}`,
      guidance: `该环境未配置 ${TMUX_SESSION_PREFIX_ENV}，禁止触碰默认 socket 会话——在实例 env（deploy/instances/ 下 dev.env/uat.env）配置会话前缀（如 dev-/uat-）后重启实例`,
    };
  }
  return { ok: true, session: `${prefix}${base}` };
};

/** launch 域解析（new-session 及其同目标 pre-kill——目标名即本进程将要创建的会话，天然不跨域）：
 *  前缀在则带前缀；未设回退裸 base（启动不受 fail-closed 限制——指令 E1.2）。 */
export const resolveLaunchSessionName = (base: string): string => {
  const prefix = prefixFromEnv();
  return prefix === "" ? base : `${prefix}${base}`;
};

/** D2① 测试 socket 注入（`-L <sock> `）：env 仅认 atf-test- 前缀值，生产无 env＝空串（默认 socket）。 */
export const tmuxSocketFlag = (): string => {
  const sock = (process.env[TMUX_TEST_SOCKET_ENV] ?? "").trim();
  return /^atf-test-[A-Za-z0-9._-]+$/.test(sock) ? `-L ${sock} ` : "";
};

/** tmux 命令单源构造——生产面全部 tmux 调用经此（测试 socket 注入点同源；结构锚防裸命令回潮）。 */
export const tmuxCommand = (sub: string): string => `tmux ${tmuxSocketFlag()}${sub}`;

/** 探测结果：present:false 时 refused 非 null＝命名域拒绝（调用方回流 status 面 guidance）；
 *  refused:null＝tmux 不在场/不可用（回落 mtime 窗口判据）。 */
export interface SessionProbe {
  present: boolean;
  refused: Extract<SessionNameResolution, { ok: false }> | null;
}

/** 会话在场探测（has-session 枚举语义域——前缀未设 fail-closed 拒绝，不触碰默认 socket）。 */
export const probeSession = (base: string = TRAINING_TMUX_SESSION): SessionProbe => {
  const resolved = resolveSessionName(base);
  if (!resolved.ok) return { present: false, refused: resolved };
  try {
    execSync(tmuxCommand(`has-session -t ${resolved.session} 2>/dev/null`));
    return { present: true, refused: null };
  } catch {
    return { present: false, refused: null };
  }
};

/** 布尔便捷面（ refused 语义折叠为 false——探测不可用＝不在场，调用方回落 mtime）。 */
export const tmuxHasSession = (base: string = TRAINING_TMUX_SESSION): boolean => probeSession(base).present;

/** 批㊶-N N-2：tmux 训练会话族判定——本命名域内 `${前缀}atf-` 任一会话在场即 true
 *  （实况会话族＝训练/评估编排两族；前缀未设＝false fail-closed；tmux 不可用＝false）。
 *  ⚠ 批㊶-O O-1 撤销此判据在 training.active 的使用（泛匹配假阳性）——保留函数仅供
 *  诊断面调用；training.active 的 tmux 判据一律改走 tmuxTrainingEvidenceFor（绑 run 取证）。 */
export const tmuxTrainingFamilyPresent = (): boolean => {
  const prefix = prefixFromEnv();
  if (prefix === "") return false;
  try {
    const out = execSync(tmuxCommand("list-sessions -F '#S' 2>/dev/null"), { encoding: "utf8" });
    return out.split("\n").some((name) => name.trim().startsWith(`${prefix}atf-`));
  } catch {
    return false;
  }
};

/** 批㊶-O O-1：枚举本命名域内 `${前缀}atf-*` 会话及其 pane 进程 cmdline（含子进程）。
 *  前缀未设＝空数组（枚举 fail-closed）；tmux 不可用＝空数组。跨域会话（他前缀/裸名）不可见。 */
export const listTrainingSessionCmdlines = (): Array<{ session: string; cmdline: string }> => {
  const prefix = prefixFromEnv();
  if (prefix === "") return [];
  try {
    const out = execSync(tmuxCommand("list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null"), { encoding: "utf8" });
    const result: Array<{ session: string; cmdline: string }> = [];
    const seen = new Set<string>();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const spaceAt = trimmed.indexOf(" ");
      if (spaceAt <= 0) continue;
      const session = trimmed.slice(0, spaceAt);
      if (!session.startsWith(`${prefix}atf-`)) continue;
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

/** 批㊶-O O-1：绑 run 取证——本命名域任一会话进程链 cmdline 含本 run_id 方判定该 run 训练会话在场。
 *  取证异常/无匹配＝false（调用方回落 mtime 新鲜窗口单判据）。只读（不 kill 不改）。 */
export const tmuxTrainingEvidenceFor = (runId: string): boolean => {
  if (runId === "") return false;
  return listTrainingSessionCmdlines().some((entry) => entry.cmdline.includes(runId));
};
