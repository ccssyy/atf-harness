/**
 * D112 训练互斥守卫自测（指令《ATF_指令_可用性U1_训练评估全链_20261024》H-2）：
 * judgeTrainingLock 纯函数注入面（真训练三形态命中／夹具 /tmp 排除／tmux 域命中／
 * 自身排除／空源不误报）＋ detectLiveTraining 真探测 smoke（当前进程表形态合法回落）。
 * 锁语义（谁持有/何时释放/误判恢复）见 tests/fixtures/trainingLock.ts 头注。
 */
import { describe, expect, it } from "vitest";
import { detectLiveTraining, judgeTrainingLock, type ProcSnapshot } from "../fixtures/trainingLock.js";

const SELF = 1;

describe("D112 训练锁判定（judgeTrainingLock 注入面）", () => {
  it("真训练进程三形态命中：torchrun／llamafactory-cli train／train.sh（非 /tmp 路径）", () => {
    const procs: ProcSnapshot[] = [
      { pid: 101, cmdline: "torchrun --nproc_per_node=1 train.py" },
      { pid: 102, cmdline: "python3 -m llamafactory-cli train --bf16" },
      { pid: 103, cmdline: "bash /data/atf/dev/runs/ws/r1/launch/train.sh" },
    ];
    const verdict = judgeTrainingLock(procs, [], SELF);
    expect(verdict.held).toBe(true);
    expect(verdict.anchors).toHaveLength(3);
    expect(verdict.anchors[0]).toContain("proc:101");
  });

  it("夹具负判据：/tmp 路径的 train.sh/torchrun 残留桩不算真训练（本仓夹具全在 /tmp mkdtemp）", () => {
    const procs: ProcSnapshot[] = [
      { pid: 201, cmdline: "bash /tmp/m2dot75-test-abc/train.sh" },
      { pid: 202, cmdline: "node /tmp/m2dot75-test-abc/torchrun-residue-stub.js" },
      { pid: 203, cmdline: "bash /tmp/dot3-smoke-xyz/train.sh" },
    ];
    expect(judgeTrainingLock(procs, [], SELF).held).toBe(false);
  });

  it("tmux 默认 socket 会话域命中：atf-training-run-<run>／atf-eval-<run>（含实例前缀形态）", () => {
    for (const session of ["atf-training-run-r1", "dev-atf-training-run-b7-swb-r1", "uat-atf-eval-r2", "dev-atf-training-run-default"]) {
      const verdict = judgeTrainingLock([], [session], SELF);
      expect(verdict.held, session).toBe(true);
      expect(verdict.anchors[0], session).toContain(`tmux:${session}`);
    }
  });

  it("无关进程与无关键会话不误报；探测方自身 pid 排除（vitest 进程 cmdline 不在词表）", () => {
    const procs: ProcSnapshot[] = [
      { pid: SELF, cmdline: "bash /data/runs/r1/launch/train.sh" }, // 自身 pid——排除
      { pid: 301, cmdline: "node /data/sam/ATF-Harness/node_modules/.bin/vitest run tests/dshTools" },
      { pid: 302, cmdline: "tmux -L atf-test-abc new-session -d bash /tmp/x/train.sh" }, // /tmp 夹具
    ];
    // 默认 socket 上的实例常驻会话（atf-dsh/atf-m12 等）与编辑器会话不命中；测试会话在
    // 独立 atf-test-* socket 上，不出现在默认 socket 枚举面（判据 B 的输入域）
    const verdict = judgeTrainingLock(procs, ["atf-dsh", "atf-m12", "my-editor"], SELF);
    expect(verdict.held).toBe(false);
  });

  it("空源不误报（无真训环境＝held false——守卫静默放行常态）", () => {
    const verdict = judgeTrainingLock([], [], SELF);
    expect(verdict).toEqual({ held: false, anchors: [] });
  });

  it("detectLiveTraining 真探测 smoke：返回结构合法；当前无真训环境 held=false", () => {
    const verdict = detectLiveTraining();
    expect(typeof verdict.held).toBe("boolean");
    expect(Array.isArray(verdict.anchors)).toBe(true);
    // 当前进程表/tmux 快照下无真训练（本用例跑在测试态）——held 应为 false；
    // 若真有训练在跑（他会话），held=true 属守卫正确行为而非本用例失败
    if (!verdict.held) expect(verdict.anchors).toHaveLength(0);
  });
});
