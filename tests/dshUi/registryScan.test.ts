/**
 * A2 案 a／A3 测试锚——atf-ui 扫描面视野枚举＋训练段两态。
 *
 * 案 a（owner 2026-10-17 19:05 裁定）：扫描面＝runsRoot（现形态不变）∪ 注册工作区实验树
 * （records[].path＋/experiments/<x>/runs/<id>）。硬约束：仅 exists===true 记录入列；
 * 只读（零写入零建目录）；目录缺失/权限失败静默跳过；去重按 realpath（分桶来源优先，
 * workspace_source=bucket 不因注册表命中改写）；标注＝注册记录 title；additive
 * workspace_source 两键闭集投影（adapter 白名单同批）。
 * A3：训练段两态——progress 初帧 fresh＝启动早期确定性活跃信号（training.active）；
 * 进程确定性消失（tmux 取证面在且本 run 无命中）∧ 无完成锚 → 段显式 failed；
 * 取证面缺席不猜（pending）。S3 前缀闭包语义不动（done 恒为前缀）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateRunEntries, scanRuns, scanRunDir, scanRunDirAt, type ScanLiveness } from "../../packages/extensions/atf-ui/src/server.js";
import { buildMonitorSnapshot } from "../../packages/extensions/atf-ui/src/snapshot.js";
import { writeProgress, appendBinding } from "../../src/core/workspace/runFacts.js";
import { appendSegmentFact } from "../../src/core/workspace/segmentFacts.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "a2-registry-scan-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** run 目录特征（launch_manifest——looksLikeRun 收录判据之一）。 */
const seedRun = (dir: string, rels: ReadonlyArray<string> = ["launch/launch_manifest.json"]): void => {
  for (const rel of rels) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "{}\n", "utf8");
  }
};

describe("A2 案 a——扫描面视野枚举", () => {
  it("注册实验树 run 入视野（标注＝记录 title，workspace_source=registry）；runsRoot 分桶/平铺照旧", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const registryWorkspaces = [{ path: regws, title: "注册甲" }];
    const scans = scanRuns(root, undefined, registryWorkspaces);
    const byId = new Map(scans.map((s) => [s.run_id, s]));
    expect(byId.get("flat-run")).toMatchObject({ workspace: null, workspace_source: "bucket" });
    expect(byId.get("run-bucketed")).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
    expect(byId.get("reg-run")).toMatchObject({ workspace: "注册甲", workspace_source: "registry" });
  });

  it("未注册目录不进视野（负例必测）；exists=false 记录不入列（目录缺失静默跳过）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    // 未注册目录（不进 seeds 清单——注册表判定之外，扫描面不可见）
    const otherws = tempRoot();
    seedRun(join(otherws, "experiments", "exp1", "runs", "hidden-run"));
    const missing = join(root, "no-such-ws");
    const scans = scanRuns(root, undefined, [
      { path: regws, title: "注册甲" },
      { path: missing, title: "目录丢失" },
    ]);
    const ids = scans.map((s) => s.run_id);
    expect(ids).toContain("reg-run");
    expect(ids).not.toContain("hidden-run");
    expect(scans.every((s) => s.run_id !== "no-such-ws")).toBe(true);
  });

  it("重叠去重按 realpath：分桶来源优先（同一 run 两侧在场只出现一次，bucket 标注不改写）", () => {
    const root = tempRoot();
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    // 注册树侧符号链接指向分桶 run（realpath 同源）——桶通道先枚举先占位，registry 通道跳过
    mkdirSync(join(regws, "experiments", "exp2", "runs"), { recursive: true });
    symlinkSync(join(root, "ws-a", "run-bucketed"), join(regws, "experiments", "exp2", "runs", "mirrored-run"), "dir");
    const scans = scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    expect(scans.filter((s) => s.run_id === "run-bucketed")).toHaveLength(1);
    // 镜像名＝同一 realpath（分桶已占位）——registry 通道跳过，不出现第二次也不改写标注
    expect(scans.filter((s) => s.run_id === "mirrored-run")).toHaveLength(0);
    const bucketed = scans.filter((s) => s.run_id === "run-bucketed");
    expect(bucketed[0]).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
  });

  it("平铺 run 注册表前缀归属：记录 path 为 run 目录祖先 → 标注 title；分桶条目不受前缀改写", () => {
    const outer = tempRoot();
    const root = join(outer, "runs");
    mkdirSync(root, { recursive: true });
    seedRun(join(root, "flat-run"));
    seedRun(join(root, "ws-a", "run-bucketed"));
    const scans = scanRuns(root, undefined, [{ path: outer, title: "外层工作区" }]);
    const byId = new Map(scans.map((s) => [s.run_id, s]));
    expect(byId.get("flat-run")).toMatchObject({ workspace: "外层工作区", workspace_source: "registry" });
    expect(byId.get("run-bucketed")).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
  });

  it("只读：枚举零写入零建目录（扫描前后目录清单一致）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const snap = (p: string): string => readdirSync(p, { withFileTypes: true }).map((e) => e.name).sort().join(",");
    const before = snap(regws);
    scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    expect(snap(regws)).toBe(before);
    expect(existsSync(join(regws, "webui"))).toBe(false);
  });

  it("枚举与扫描一一对应（同步器 entries 复用契约：runs[i]↔entries[i]）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const registryWorkspaces = [{ path: regws, title: "注册甲" }];
    const entries = enumerateRunEntries(root, registryWorkspaces);
    const scans = scanRuns(root, undefined, registryWorkspaces, entries);
    expect(scans).toHaveLength(entries.length);
    entries.forEach((entry, i) => {
      expect(scans[i]?.run_id).toBe(entry.runId);
      expect(scans[i]?.workspace).toBe(entry.workspace);
    });
  });
});

describe("A3——训练段两态（初帧活跃＋进程消失不悬空）", () => {
  const livenessWith = (trainingEvidence: Record<string, boolean>, freshWindowMs = 120_000, nowMs = Date.now()): ScanLiveness => ({
    trainingEvidence,
    freshWindowMs,
    nowMs,
  });

  it("启动早期：progress 初帧 fresh（round=0）→ training.active=true（无 loss-series 也有确定性信号）", () => {
    const root = tempRoot();
    seedRun(join(root, "run-t"));
    writeProgress(join(root, "run-t"), { round: 0, total_rounds: 3, updated_at: new Date().toISOString() });
    const scan = scanRunDir(root, "run-t", livenessWith({ "run-t": false }));
    expect(scan.training.active).toBe(true);
    expect(scan.training.progress?.round).toBe(0);
  });

  it("进程消失：启动证据在场 ∧ 取证面无命中 ∧ 初帧 stale ∧ 无完成锚 → 训练段 failed", () => {
    const root = tempRoot();
    seedRun(join(root, "run-f"), ["launch/train.sh"]);
    writeProgress(join(root, "run-f"), { round: 0, updated_at: new Date(Date.now() - 3_600_000).toISOString() });
    const scan = scanRunDir(root, "run-f", livenessWith({ "run-f": false }));
    expect(scan.training.active).toBe(false);
    expect(scan.segments.training).toBe("failed");
  });

  it("A3.1 负例：仅 launch/train.sh（备料未启动）+ 取证面无命中 → 训练段 pending（不得 failed）", () => {
    const root = tempRoot();
    seedRun(join(root, "run-ready"), ["launch/train.sh"]);
    const scan = scanRunDir(root, "run-ready", livenessWith({ "run-ready": false }));
    expect(scan.segments.training).toBe(false);
    expect(scan.training.active).toBe(false);
  });

  it("A3.1 曾启动②：launch/train.sh＋段事实 training（未写 progress，stale 形态）→ failed", () => {
    const root = tempRoot();
    seedRun(join(root, "run-fact"), ["launch/train.sh"]);
    appendSegmentFact(join(root, "run-fact"), "training", "atf_run_training");
    const scan = scanRunDir(root, "run-fact", livenessWith({ "run-fact": false }));
    expect(scan.segments.training).toBe("failed");
  });

  it("A3.1 曾启动③：launch/train.sh＋trainer_state.json（无 progress 无段事实）→ failed", () => {
    const root = tempRoot();
    seedRun(join(root, "run-tstate"), ["launch/train.sh", "training/trainer_state.json"]);
    const scan = scanRunDir(root, "run-tstate", livenessWith({ "run-tstate": false }));
    expect(scan.segments.training).toBe("failed");
  });

  it("取证面缺席不猜：同 stale 形态但 liveness 无 trainingEvidence → 段 pending（不造 failed）", () => {
    const root = tempRoot();
    seedRun(join(root, "run-p"), ["launch/train.sh"]);
    writeProgress(join(root, "run-p"), { round: 0, updated_at: new Date(Date.now() - 3_600_000).toISOString() });
    const scan = scanRunDir(root, "run-p", undefined);
    expect(scan.segments.training).toBe(false);
  });

  it("完成锚在场仍 done（failed 不越序）；训练活跃期证据不入前缀（S3 语义不动）", () => {
    const root = tempRoot();
    seedRun(join(root, "run-done"), ["launch/train.sh", "training/all_results.json"]);
    const doneScan = scanRunDir(root, "run-done", livenessWith({ "run-done": false }));
    expect(doneScan.segments.training).toBe(true);
    // 活跃重跑：完成锚＋progress fresh → active 显示（adapter 训练段活跃优先）＋段事实 done 不冻结
    writeProgress(join(root, "run-done"), { round: 2, updated_at: new Date().toISOString() });
    const activeScan = scanRunDir(root, "run-done", livenessWith({}));
    expect(activeScan.training.active).toBe(true);
    const monitor = buildMonitorSnapshot([activeScan], { offline: true });
    const training = (monitor.runs[0]?.segments ?? []).find((s) => s.key === "training");
    expect(training?.status).toBe("active");
  });

  it("scanRunDirAt：绝对目录变体（注册树形态）与 scanRunDir 同构返回", () => {
    const root = tempRoot();
    seedRun(join(root, "run-a"));
    const direct = scanRunDirAt(join(root, "run-a"), "run-a", undefined, "注册甲", "registry");
    expect(direct).toMatchObject({ run_id: "run-a", workspace: "注册甲", workspace_source: "registry" });
  });
});

describe("A2 投影面——adapter 白名单＋摘要化", () => {
  it("buildMonitorSnapshot：workspace_source additive 投影（registry/bucket 两键闭集）", () => {
    const root = tempRoot();
    seedRun(join(root, "ws-a", "run-bucketed"));
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const scans = scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    const monitor = buildMonitorSnapshot(scans, { offline: true });
    const byId = new Map(monitor.runs.map((r) => [r.run_id, r]));
    expect(byId.get("reg-run")?.workspace_source).toBe("registry");
    expect(byId.get("run-bucketed")?.workspace_source).toBe("bucket");
    expect(["bucket", "registry"].includes(String(byId.get("reg-run")?.workspace_source))).toBe(true);
  });

  it("摘要化：快照 run 载荷零注册表绝对路径（title 非 path——路径面不入投影）", () => {
    const root = tempRoot();
    seedRun(join(root, "flat-run"));
    const regws = join(tempRoot(), "reg-ws-root-7f3a");
    mkdirSync(regws, { recursive: true });
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    const monitor = buildMonitorSnapshot(scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]), { offline: true });
    expect(JSON.stringify(monitor.runs)).not.toContain("reg-ws-root-7f3a");
    expect(JSON.stringify(monitor.runs)).toContain("注册甲");
  });
});

/** D3/D4——内核段摘要种子（顶层 run_id/stage/exit_code 三键；对账字段可覆写）。 */
const seedStageSummary = (
  dir: string,
  runId: string,
  stage: string,
  exitCode: number,
  opts?: { runIdOverride?: string; stageOverride?: string },
): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `stage-${stage}.summary.json`),
    `${JSON.stringify({ run_id: opts?.runIdOverride ?? runId, stage: opts?.stageOverride ?? stage, exit_code: exitCode, mode: "stage" })}\n`,
    "utf8",
  );
};

describe("D3/D4——状态面以盘上事实为准（段摘要兜底源＋workspace 归属＋trainer_log 活跃＋state_reason）", () => {
  it("①只有 stage summary 无 segments → 段 done（exit 0 映射单源；family_split→split／experiment_setup→experiment_config；training/evaluate 无映射不点灯）", () => {
    const root = tempRoot();
    const dir = join(root, "k-direct");
    // 内核直跑形态：七段 summary 在 run 顶层，无 webui/（无 segments.json/binding.json）
    for (const stage of ["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission"]) {
      seedStageSummary(dir, "k-direct", stage, 0);
    }
    const scan = scanRunDirAt(dir, "k-direct");
    expect(scan.segments.register).toBe(true);
    expect(scan.segments.label_qc).toBe(true);
    expect(scan.segments.experiment_config).toBe(true);
    expect(scan.segments.publish).toBe(true);
    expect(scan.segments.split).toBe(true);
    expect(scan.segments.admission).toBe(true);
    expect(scan.segments.candidate).toBe(true); // candidate_build→candidate 键（非段序闭包面）
    expect(scan.segments.training).toBe(false); // 无内核段映射至 training/evaluate——完成语义不动
    expect(scan.segments.evaluate).toBe(false);
  });

  it("②只有 segments.json → done（事实轨源独立成立；无 summary 无锚）", () => {
    const root = tempRoot();
    const dir = join(root, "tool-path");
    seedRun(dir, ["prep/placeholder"]); // 收录标记非段锚
    appendSegmentFact(dir, "register", "atf_admit_data");
    const scan = scanRunDirAt(dir, "tool-path");
    expect(scan.segments.register).toBe(true);
  });

  it("③陈旧 summary 不采纳：run_id 不符／exit≠0／stage 键对账不符三态", () => {
    const root = tempRoot();
    const dir = join(root, "k-stale");
    seedStageSummary(dir, "k-stale", "register", 0, { runIdOverride: "OTHER-RUN" });
    seedStageSummary(dir, "k-stale", "label_qc", 2);
    seedStageSummary(dir, "k-stale", "publish", 0, { stageOverride: "family_split" });
    const scan = scanRunDirAt(dir, "k-stale");
    expect(scan.segments.register).toBe(false);
    expect(scan.segments.label_qc).toBe(false);
    expect(scan.segments.publish).toBe(false);
  });

  it("④桶形态 workspace 正确（桶名直取；source=bucket）", () => {
    const root = tempRoot();
    seedRun(join(root, "ws-d3", "run-b1"));
    const runs = scanRuns(root);
    expect(runs[0]?.workspace).toBe("ws-d3");
    expect(runs[0]?.workspace_source).toBe("bucket");
  });

  it("⑤平铺无 binding → workspace null 但渲染可见；有 binding → 注册表 sessionIds 反查归属", () => {
    const root = tempRoot();
    seedRun(join(root, "plain-no-bind"));
    const regws = tempRoot();
    seedRun(join(root, "flat-bound"));
    appendBinding(join(root, "flat-bound"), "session-d3-xyz");
    const scans = scanRuns(root, undefined, [{ path: regws, title: "ws-by-session", sessionIds: ["session-d3-xyz"] }]);
    const byId = new Map(scans.map((r) => [r.run_id, r]));
    expect(byId.get("plain-no-bind")?.workspace).toBeNull();
    expect(byId.get("flat-bound")?.workspace).toBe("ws-by-session");
    expect(byId.get("flat-bound")?.workspace_source).toBe("registry");
    // 渲染侧兜底：workspace null 的 run 仍在 monitor 快照内可见（不依赖 bound_sessions）
    const monitor = buildMonitorSnapshot(scans, { offline: true });
    expect(monitor.runs.some((r) => r.run_id === "plain-no-bind")).toBe(true);
  });

  it("⑥trainer_log 活跃证据 → training.active=true（段不入前缀）；过窗转 false", () => {
    const root = tempRoot();
    const dir = join(root, "t-live");
    seedRun(dir, ["launch/launch_manifest.json"]);
    mkdirSync(join(dir, "training"), { recursive: true });
    writeFileSync(join(dir, "training", "trainer_log.jsonl"), `${JSON.stringify({ current_steps: 3, total_steps: 100, percentage: 3 })}\n`, "utf8");
    const live = scanRunDirAt(dir, "t-live", undefined);
    expect(live.training.active).toBe(true);
    expect(live.segments.training).toBe(false); // 活跃期证据不入前缀（S3）
    const stale = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "training", "trainer_log.jsonl"), stale, stale);
    const dead = scanRunDirAt(dir, "t-live", undefined);
    expect(dead.training.active).toBe(false);
  });

  it("state 面：裸 run（无生命周期锚）→ pending＋state_reason=no_on_disk_evidence；级联命中 → 原值＋reason null；快照 additive 透传", () => {
    const root = tempRoot();
    const bare = join(root, "bare-run");
    seedRun(bare, ["prep/placeholder"]);
    const bareScan = scanRunDirAt(bare, "bare-run");
    expect(bareScan.state).toBe("pending");
    expect(bareScan.state_reason).toBe("no_on_disk_evidence");
    const reg = join(root, "reg-run");
    seedRun(reg, ["registration.json"]);
    const regScan = scanRunDirAt(reg, "reg-run");
    expect(regScan.state).toBe("registered");
    expect(regScan.state_reason).toBeNull();
    const monitor = buildMonitorSnapshot([bareScan, regScan], { offline: true });
    const byId = new Map(monitor.runs.map((r) => [r.run_id, r]));
    expect(byId.get("bare-run")).toMatchObject({ state: "pending", state_reason: "no_on_disk_evidence" });
    expect(byId.get("reg-run")).toMatchObject({ state: "registered", state_reason: null });
  });
});
