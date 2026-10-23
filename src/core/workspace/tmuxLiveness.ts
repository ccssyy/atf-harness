/**
 * 批㊶-L L-1——训练会话 liveness 权威面（单源）；批㊶-ISO E1——会话命名域单源化；
 * 批㊶-P1 S1——会话基名作用域化（run_id 入名）。
 *
 * 会话名解析单源＝resolveSessionName(base)＝ATF_TMUX_SESSION_PREFIX（env）＋ base：
 * dev/uat 两实例在同一容器默认 tmux socket 上靠前缀划分命名域，会话名互不命中
 * （kill/枚举失去跨域目标——20261011/20261012 两次同型误杀事故的结构根源在此收口）。
 * 前缀 env 未设置时 kill/枚举/探测一律 fail-closed 拒绝（B4 语义 {ok:false,reason,guidance}，
 * guidance 随 status 面错误回流可见）；launch（new-session）不受 fail-closed 限制
 * （resolveLaunchSessionName：前缀在则带前缀，未设回退裸 base——存量语义）。
 *
 * 批㊶-P1 S1（D1①）：base 由常量改作用域化基名——训练 `atf-training-run-<run_id>`、
 * 评估 `atf-eval-<run_id>`（run_id 天然唯一——同实例两 run 并发各占各的 tmux 会话，
 * 探测/kill/存活判定互不踩；resolveSessionName 组合逻辑不变，fail-closed 纪律原样）。
 * run_id 经 runScopeSlug 折算进 tmux 合法字符域（tmux 会话名禁 `.`/`:`）；枚举面归属
 * 判定单源＝sessionIsScopedFor（会话名尾段精确对模板——泛 includes 子串假阳性不入）。
 *
 * 命令构造单源＝tmuxCommand(sub)：D2① 测试面经 ATF_TMUX_TEST_SOCKET 注入 `-L`（仅认
 * atf-test-* 值——生产路径不可能被指到业务 socket）；生产无 env＝默认 socket。
 * trainingFace/oomFallback/atf-ui server 的全部 tmux 调用经本模块（结构锚防回潮）。
 * 探测异常（tmux 不可用）＝present:false——调用方 fail-closed 回落 mtime 新鲜窗口判据
 * （atf-ui scanRunDir 批㊶-L 终结判定）。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 批㊶-P1 S1——两类作用域基名模板（grep 实锚：`atf-training-run-`／`atf-eval-`）。 */
export const TRAINING_BASE_PREFIX = "atf-training-run-";
export const EVAL_BASE_PREFIX = "atf-eval-";

/** run_id → tmux 会话名合法段（`A-Za-z0-9_-` 外折 `_`；空串折 `default`——与 exec home
 *  CLI 形态同词表）。折算仅作用于会话名段，绑 run 取证仍按原 run_id 走 cmdline。 */
export const runScopeSlug = (runId: string): string =>
  (runId.trim() === "" ? "default" : runId.trim()).replace(/[^A-Za-z0-9_-]/g, "_");

/** 作用域基名（单源）：训练／评估编排（atf_evaluate ⑥ tmux 后台）各按 run_id 取名。 */
export const trainingSessionBase = (runId: string): string => `${TRAINING_BASE_PREFIX}${runScopeSlug(runId)}`;
export const evalOrchSessionBase = (runId: string): string => `${EVAL_BASE_PREFIX}${runScopeSlug(runId)}`;

/** 枚举面归属判定（单源）：会话名是否即本 run 的作用域会话（两类模板尾段精确对 slug——
 *  `r1` 不误命中 `cr_r1` 的会话；前缀段由枚举域 `${前缀}atf-*` 过滤承担）。 */
export const sessionIsScopedFor = (session: string, runId: string): boolean => {
  const slug = runScopeSlug(runId);
  return session.endsWith(`${TRAINING_BASE_PREFIX}${slug}`) || session.endsWith(`${EVAL_BASE_PREFIX}${slug}`);
};

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

/** 命名域拒绝探测（诊断面——前缀未设＝refused 回流；判定与 resolveSessionName 同源）。
 *  批㊶-P1：基名作用域化后同步器不再有「无 run 的单会话探测」，拒绝语义经此独立出口。 */
export const sessionDomainRefusal = (): { reason: string; guidance: string } | null => {
  const resolved = resolveSessionName(runScopeSlug("liveness-probe"));
  return resolved.ok ? null : { reason: resolved.reason, guidance: resolved.guidance };
};

/** 会话在场探测（has-session 枚举语义域——前缀未设 fail-closed 拒绝，不触碰默认 socket）。
 *  批㊶-P1 S1：base 必传（作用域化后无默认基名——调用方按 run_id 取 trainingSessionBase/
 *  evalOrchSessionBase）。 */
export const probeSession = (base: string): SessionProbe => {
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
export const tmuxHasSession = (base: string): boolean => probeSession(base).present;

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
export const listTrainingSessionCmdlines = (): Array<{ session: string; cmdline: string }> =>
  listDomainSessionCmdlinesOrNull() ?? [];

/** D28：域内会话枚举原始面——命名域未设/tmux 不可用＝null（面缺席），与「探测健康但
 *  域内零会话」可区分（listTrainingSessionCmdlines 既有空数组语义不变，包装本面）。 */
const listDomainSessionCmdlinesOrNull = (): Array<{ session: string; cmdline: string }> | null => {
  const prefix = prefixFromEnv();
  if (prefix === "") return null;
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
    return null;
  }
};

/** D28：绑 run 取证（批量）＋探测可用性——usable=true 仅当命名域已设且 tmux 枚举命令
 *  成功执行（域内零会话≠面缺席）；evidence 判据与 tmuxTrainingEvidenceFor 同源
 *  （进程链 cmdline 含 run_id／作用域会话名尾段精确）。调用方（atf-ui tickOnce）以
 *  usable=true 且本 run 无命中＝无 tmux 面（launch/setsid 既定形态，D73）——活跃由
 *  trainer_log 源新鲜窗口单判（超窗即翻面）；usable=false＝面缺席，回落窗口判据。 */
export const probeTrainingEvidence = (
  runIds: readonly string[],
): { usable: boolean; evidence: Record<string, boolean> } => {
  const evidence: Record<string, boolean> = {};
  const entries = listDomainSessionCmdlinesOrNull();
  if (entries === null) return { usable: false, evidence };
  for (const entry of entries) {
    for (const runId of runIds) {
      if (entry.cmdline.includes(runId) || sessionIsScopedFor(entry.session, runId)) evidence[runId] = true;
    }
  }
  return { usable: true, evidence };
};

/** 批㊶-O O-1：绑 run 取证——本命名域任一会话判定本 run 在场（批㊶-P1 S1 扩充两判据：
 *  ① 会话名即本 run 作用域会话（sessionIsScopedFor——尾段精确对模板＋slug）；
 *  ② 进程链 cmdline 含本 run_id（存量判据——作用域化前的兼容面）。
 *  取证异常/无匹配＝false（调用方回落 mtime 新鲜窗口单判据）。只读（不 kill 不改）。 */
export const tmuxTrainingEvidenceFor = (runId: string): boolean => {
  if (runId === "") return false;
  return listTrainingSessionCmdlines().some(
    (entry) => entry.cmdline.includes(runId) || sessionIsScopedFor(entry.session, runId),
  );
};
