/**
 * D112 训练互斥守卫——探测式训练锁（指令《ATF_指令_可用性U1_训练评估全链_20261024》H-2）。
 *
 * 事故形态（B7 缺陷⑪实锚，2026-10-24 12:58）：另一会话跑 `npx vitest run tests/dshTools`，
 * trainingFace start 链用例的端口门禁（probePortOccupant→terminateOccupant）把真训练
 * （llamafactory-cli train/torchrun，setsid 脱离进程，PPID 1）当残留占用者 SIGTERM。
 * 跨会话真训/测试互斥此前零守卫——本模块是收口。
 *
 * 锁语义（探测式快照，非持久锁文件）：
 * - **谁持有**：运行中的真训练。判据两路（任一命中即 held）：
 *   ① 进程表——非 /tmp 路径的 train.sh／torchrun／llamafactory 训练进程（真训练的
 *      run 树在 workspace/exec-home，绝不在 /tmp；本仓一切测试夹具都在 /tmp mkdtemp——
 *      /tmp 排除即「夹具不算真训练」的负判据）；
 *   ② 默认 tmux socket 会话名含 atf-training-run-／atf-eval-（真训练/评估编排域会话；
 *      测试会话在独立 atf-test-* socket 上，裸 `tmux ls` 不可见）。
 * - **何时释放**：训练结束（进程退出/tmux 会话消亡）即自动消失——探测是实时快照，
 *   每次调用重探，无状态文件，无「释放动作」。
 * - **误判如何恢复**：无残留状态可清理。误报（夹具被判真训）仅导致用例 skip（保守方向，
 *   零杀伤）；漏报（真训形态不在词表）等同守卫生效前现状，不新增风险。
 * - 挂载形态：杀伤面 describe 顶部 `beforeEach((ctx) => guardTrainingLock(ctx))`——
 *   每用例执行前实时探测（覆盖「测试先跑、训练中途启动」窗口），held 即逐用例 skip
 *   （skip 消息带探测锚，vitest 5 语义：skipped 不算 failed）。
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface ProcSnapshot {
  pid: number;
  cmdline: string;
}

export interface TrainingLockState {
  held: boolean;
  anchors: string[];
}

/** 真训练进程正判据（词表单源）：torchrun／llamafactory 训练／train.sh 执行。 */
const TRAINING_PROC_PATTERN = /torchrun|llamafactory-cli\s+train|(?:^|[\s/])train\.sh(?:\s|$)/;
/** 真训练/评估编排 tmux 会话名判据（作用域基名模板与 tmuxLiveness 同源）。 */
const TRAINING_SESSION_PATTERN = /atf-(?:training-run|eval)-/;

/**
 * 锁判定纯函数（单测注入面）：procs＝进程表快照，tmuxSessions＝默认 socket 会话名，
 * selfPid＝探测方自身 pid（自检排除）。
 */
export const judgeTrainingLock = (
  procs: readonly ProcSnapshot[],
  tmuxSessions: readonly string[],
  selfPid: number,
): TrainingLockState => {
  const anchors: string[] = [];
  for (const proc of procs) {
    if (proc.pid === selfPid || proc.cmdline === "") continue;
    if (proc.cmdline.includes("/tmp/")) continue; // 夹具负判据（/tmp 路径＝测试夹具，非真训练）
    if (TRAINING_PROC_PATTERN.test(proc.cmdline)) {
      anchors.push(`proc:${proc.pid}:${proc.cmdline.slice(0, 120)}`);
    }
  }
  for (const session of tmuxSessions) {
    const name = session.trim();
    if (name !== "" && TRAINING_SESSION_PATTERN.test(name)) anchors.push(`tmux:${name}`);
  }
  return { held: anchors.length > 0, anchors };
};

/** 进程表快照（扫 /proc 数字目录读 cmdline；不可读目录跳过——进程可能已退出）。 */
const scanProcSnapshots = (): ProcSnapshot[] => {
  const snapshots: ProcSnapshot[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return snapshots;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      snapshots.push({ pid: Number(entry), cmdline });
    } catch {
      // 已退出/不可读＝跳过
    }
  }
  return snapshots;
};

/** 默认 socket tmux 会话名（裸 `tmux ls`——无 -L 即默认 socket；输出行 `name: N windows
 *  (created ...)`，取冒号前段；无服务端＝空。测试会话在独立 atf-test-* socket 上，不入列）。 */
const listDefaultTmuxSessions = (): string[] => {
  try {
    return execSync("tmux ls 2>/dev/null", { encoding: "utf8" })
      .split("\n")
      .map((line) => line.split(":")[0] ?? line);
  } catch {
    return [];
  }
};

/** 真探测（实时快照——每次调用重探，无缓存）。 */
export const detectLiveTraining = (): TrainingLockState =>
  judgeTrainingLock(scanProcSnapshots(), listDefaultTmuxSessions(), process.pid);

/**
 * 守卫挂载 helper（杀伤面 describe 顶部）：
 * `beforeEach((ctx) => guardTrainingLock(ctx))`——真训练在跑即逐用例 skip（消息带锚）。
 */
export const guardTrainingLock = (ctx: { skip: (reason?: string) => void }): void => {
  const lock = detectLiveTraining();
  if (lock.held) {
    ctx.skip(
      `D112 训练锁 held（真训练在跑，真杀类用例跳过）——锚：${lock.anchors.slice(0, 3).join("；")}` +
        "；探测式快照无残留锁文件，训练结束自动恢复",
    );
  }
};
