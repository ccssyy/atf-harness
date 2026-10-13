// 批㊶-S3 窗口B S-B1/S-B2——评估就绪进度账读面＋通知投影＋段序守卫豁免。
//
// - 读账（内核编排 orch/progress.jsonl append-only 四态账）：解析闭集/坏行降级/最新轮选择；
// - 阶段流转推导：相邻同相折叠（三跳/失败一跳）、append-only 重放稳定；
// - 可评估一跳（D4①）：复用段事实轨判据（training 完成事实＋完成产物锚＋evaluate 未发起）；
// - monitor.json 投影白名单（三同步：键面闭集＋摘要化＋投影用例）；
// - 段序守卫豁免（S-B2 根因修复②）：事实轨/收尾段完成锚不被级联抑制（真机 done=0/8 根因）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvalNoticeFaces,
  derivePhaseTransitions,
  deriveTrainableNotice,
  EVAL_PHASES,
  evaluateFactPresent,
  latestEvalRoundDir,
  parseEvalProgressLine,
  readEvalProgressLedger,
  trainingDoneAnchored,
  type EvalProgressRow,
} from "../../src/core/workspace/evalProgressTrack.js";
import { appendSegmentFact, readSegmentFacts } from "../../src/core/workspace/segmentFacts.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "atf-evaltrack-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const writeLedger = (runDir: string, rows: Array<object>, round = "1-20261013"): void => {
  const dir = join(runDir, "eval", round, "orch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "progress.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
};

const row = (ts: string, phase: string, detail: string, elapsed_s: number): EvalProgressRow => ({ ts, phase, detail, elapsed_s });

describe("批㊶-S3 S-B1 账行解析（progress.jsonl 单行——键面闭集/坏行降级）", () => {
  it("合法行解析：四键收窄，缺 detail/elapsed 按缺省", () => {
    expect(parseEvalProgressLine('{"ts":"2026-10-13T21:22:47+0800","phase":"launching","detail":"服务启动/等待就绪中","elapsed_s":0}'))
      .toEqual({ ts: "2026-10-13T21:22:47+0800", phase: "launching", detail: "服务启动/等待就绪中", elapsed_s: 0 });
    expect(parseEvalProgressLine('{"ts":"t","phase":"ready"}')).toEqual({ ts: "t", phase: "ready", detail: "", elapsed_s: 0 });
  });
  it("坏行如实 null：非 JSON/空行/缺 ts/缺 phase/非对象", () => {
    expect(parseEvalProgressLine("not json")).toBeNull();
    expect(parseEvalProgressLine("")).toBeNull();
    expect(parseEvalProgressLine('{"phase":"ready"}')).toBeNull();
    expect(parseEvalProgressLine('{"ts":"t"}')).toBeNull();
    expect(parseEvalProgressLine("[1,2]")).toBeNull();
    expect(parseEvalProgressLine('{"ts":"t","phase":"ready","detail":1,"elapsed_s":"x"}')).toEqual({ ts: "t", phase: "ready", detail: "", elapsed_s: 0 });
  });
  it("四态闭集常量与内核契约一致", () => {
    expect(EVAL_PHASES).toEqual(["launching", "initializing", "ready", "failed"]);
  });
});

describe("批㊶-S3 S-B1 读账与流转推导（append-only 重放稳定）", () => {
  it("最新轮选择：eval/<N-日期> 取 N 最大", () => {
    const runDir = tempRoot();
    writeLedger(runDir, [row("t1", "launching", "a", 0)], "2-20261013");
    writeLedger(runDir, [row("t0", "ready", "old", 9)], "1-20261012");
    expect(latestEvalRoundDir(runDir)?.split(/[\\/]/).pop()).toBe("2-20261013");
    expect(readEvalProgressLedger(runDir)?.round).toBe("2-20261013");
    expect(readEvalProgressLedger(runDir)?.rows).toHaveLength(1);
  });
  it("无 eval 目录 → null；空账 → 零行（如实降级）", () => {
    const runDir = tempRoot();
    mkdirSync(runDir, { recursive: true });
    expect(readEvalProgressLedger(runDir)).toBeNull();
    writeLedger(runDir, []);
    const ledger = readEvalProgressLedger(runDir);
    expect(ledger).not.toBeNull();
    expect(ledger?.rows).toHaveLength(0);
  });
  it("三跳流转：launching→initializing→ready，相邻同相折叠（initializing 多轮取末行 detail/elapsed）", () => {
    const rows = [
      row("2026-10-13T21:21:48+0800", "launching", "服务启动/等待就绪中,探活未过", 0),
      row("2026-10-13T21:21:58+0800", "initializing", "探活未过,编排所启服务进程存活", 10),
      row("2026-10-13T21:22:08+0800", "initializing", "探活未过,编排所启服务进程存活", 20),
      row("2026-10-13T21:22:18+0800", "ready", "health 探测通过", 30),
    ];
    const hops = derivePhaseTransitions("1-20261013", rows);
    expect(hops.map((h) => h.phase)).toEqual(["launching", "initializing", "ready"]);
    expect(hops[1]?.elapsed_s).toBe(20);
    expect(hops[2]?.detail).toBe("health 探测通过");
    expect(hops[0]?.id).toBe("1-20261013:launching:2026-10-13T21:21:48+0800");
  });
  it("失败一跳：启动后进程退出→failed 单跳；同账重放 id 稳定（幂等）", () => {
    const rows = [
      row("t1", "launching", "启动", 0),
      row("t2", "failed", "编排所启服务进程已退出且探活未过", 0),
    ];
    const hops = derivePhaseTransitions("r", rows);
    expect(hops.map((h) => h.phase)).toEqual(["launching", "failed"]);
    expect(derivePhaseTransitions("r", rows)).toEqual(hops);
  });
});

describe("批㊶-S3 S-B1 可评估一跳（D4①——复用段事实轨判据）", () => {
  it("training 完成事实＋完成产物锚＋evaluate 未发起 → trainable 通知（id 含事实时间戳）", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x", "utf8");
    appendSegmentFact(runDir, "training", "atf_run_training", "2026-10-13T10:00:00.000Z");
    const facts = readSegmentFacts(runDir);
    const notice = deriveTrainableNotice(runDir, facts, { trainingDone: trainingDoneAnchored(runDir), evaluateDone: evaluateFactPresent(facts) });
    expect(notice).toEqual({ id: "trainable:2026-10-13T10:00:00.000Z", kind: "trainable", at: "2026-10-13T10:00:00.000Z" });
  });
  it("evaluate 事实在位（已发起评估）→ 不再通知；无 training 事实 → null；锚在事实缺 → null（不造判据）", () => {
    const runDir = tempRoot();
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "all_results.json"), "{}", "utf8");
    appendSegmentFact(runDir, "training", "atf_run_training");
    appendSegmentFact(runDir, "evaluate", "atf_evaluate");
    const facts = readSegmentFacts(runDir);
    expect(deriveTrainableNotice(runDir, facts, { trainingDone: true, evaluateDone: evaluateFactPresent(facts) })).toBeNull();
    expect(deriveTrainableNotice(runDir, [], { trainingDone: true, evaluateDone: false })).toBeNull();
    expect(deriveTrainableNotice(runDir, [], { trainingDone: false, evaluateDone: false })).toBeNull();
  });
});

describe("批㊶-S3 S-B1 通知面组装（buildEvalNoticeFaces——投影白名单）", () => {
  it("账＋事实齐备：progress 五键闭集＋notices 含流转跳与 trainable（键面白名单——摘要化无路径面）", () => {
    const runDir = tempRoot();
    writeLedger(runDir, [
      row("a1", "launching", "启动", 0),
      row("a2", "ready", "health 探测通过", 30),
    ]);
    mkdirSync(join(runDir, "training"), { recursive: true });
    writeFileSync(join(runDir, "training", "adapter_model.safetensors"), "x", "utf8");
    appendSegmentFact(runDir, "training", "atf_run_training", "b1");
    const faces = buildEvalNoticeFaces(runDir);
    expect(Object.keys(faces.progress ?? {}).sort()).toEqual(["detail", "elapsed_s", "phase", "round", "updated_at"]);
    expect(faces.progress).toMatchObject({ round: "1-20261013", phase: "ready", detail: "health 探测通过", elapsed_s: 30 });
    expect(faces.notices.map((n) => (n as { phase?: string }).phase ?? (n as { kind?: string }).kind)).toEqual(["launching", "ready", "trainable"]);
    for (const n of faces.notices) {
      expect(Object.keys(n).every((k) => ["id", "round", "phase", "detail", "elapsed_s", "at", "kind"].includes(k))).toBe(true);
    }
  });
  it("无账无可评估跳：progress null＋notices 空（如实无通知）", () => {
    const runDir = tempRoot();
    mkdirSync(runDir, { recursive: true });
    expect(buildEvalNoticeFaces(runDir)).toEqual({ progress: null, notices: [] });
  });
});
