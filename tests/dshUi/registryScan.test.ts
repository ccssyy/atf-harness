/**
 * A2 案 a／A3 测试锚——atf-ui 扫描面视野枚举＋训练段两态。
 *
 * 案 a（owner 2026-10-17 19:05 裁定）：扫描面＝runsRoot（现形态不变）∪ 注册工作区实验树
 * （records[].path＋/experiments/<x>/runs/<id>）。硬约束：仅 exists===true 记录入列；
 * 只读（零写入零建目录）；目录缺失/权限失败静默跳过；标注＝注册记录 title；additive
 * workspace_source 两键闭集投影（adapter 白名单同批）。
 * H2.1 rev2（D37+D38）语义：枚举序 registry 三档候选根（canonical 优先）→ flat →
 * bucket；去重双键 realpath＋claimKey (workspace,runId)——registry/canonical 先 claim，
 * flat/bucket 同键后到跳过（旧「分桶来源优先」由 rev2 canonical 优先取代）；runs 根
 * 一级条目先过四类预检分类（valid/legacy/bucket 照常、unregistered_entry 与
 * artifact_outside_layout 隔离＋结构化告警）。
 * 桶判定 owner 裁决收紧（rev2 第二批）：合格 run 子目录＝run.json ∨ webui/segments.json
 * ∨ stage-register.summary.json ∨ ≥2 个 RUN_MARKER_RELS 命中；孤立 launch_manifest.json
 * 单命中不合格（cr_r2/launch 假阳性根源）——幻影防回潮锚与 H21 夹具双保全，单源谓词
 * isQualifyingRunChild（hasRunChildDirs 与四向分类规则 2 共用）。
 * A3：训练段两态——progress 初帧 fresh＝启动早期确定性活跃信号（training.active）；
 * 进程确定性消失（tmux 取证面在且本 run 无命中）∧ 无完成锚 → 段显式 failed；
 * 取证面缺席不猜（pending）。S3 前缀闭包语义不动（done 恒为前缀）。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyRunRootEntries, enumerateRunEntries, hasRunChildDirs, isQualifyingRunChild, scanRuns, scanRunDir, scanRunDirAt, type ScanLiveness } from "../../packages/extensions/atf-ui/src/server.js";
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
    // 平铺夹具用顶层文件标记（stage-register.summary.json）——launch/launch_manifest.json
    // 形态的 launch/ 子目录会命中裸 launch_manifest.json 标记而被 rev2 D37 判桶（见 rev2 组头注）
    seedRun(join(root, "flat-run"), ["stage-register.summary.json"]);
    seedRun(join(root, "ws-a", "run-bucketed"), ["stage-register.summary.json"]);
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

  it("重叠去重：symlink 镜像不作 run 根（Dirent.isDirectory 不跟随——规范 2.2-5 同向），桶侧 run 正常收录一次", () => {
    const root = tempRoot();
    // 夹具用顶层文件标记——launch/launch_manifest.json 形态会被 rev2 D37 判桶（见 rev2 组头注）
    seedRun(join(root, "ws-a", "run-bucketed"), ["stage-register.summary.json"]);
    const regws = tempRoot();
    seedRun(join(regws, "experiments", "exp1", "runs", "reg-run"));
    // 注册树侧符号链接指向分桶 run——symlink 不进候选清单（Dirent 不跟随），
    // 镜像名不出现第二次；桶侧真身正常收录（rev2 语义下同 realpath 双通道去重
    // 由 rev2 组「同 realpath 双通道」锚承担）
    mkdirSync(join(regws, "experiments", "exp2", "runs"), { recursive: true });
    symlinkSync(join(root, "ws-a", "run-bucketed"), join(regws, "experiments", "exp2", "runs", "mirrored-run"), "dir");
    const scans = scanRuns(root, undefined, [{ path: regws, title: "注册甲" }]);
    expect(scans.filter((s) => s.run_id === "run-bucketed")).toHaveLength(1);
    expect(scans.filter((s) => s.run_id === "mirrored-run")).toHaveLength(0);
    const bucketed = scans.filter((s) => s.run_id === "run-bucketed");
    expect(bucketed[0]).toMatchObject({ workspace: "ws-a", workspace_source: "bucket" });
  });

  it("平铺 run 注册表前缀归属：记录 path 为 run 目录祖先 → 标注 title；分桶条目不受前缀改写", () => {
    const outer = tempRoot();
    const root = join(outer, "runs");
    mkdirSync(root, { recursive: true });
    // 夹具充实（裁决授权）：真实 run 形态（身份锚/多标记）——孤立 launch_manifest.json
    // 形态在收紧判据下不再是合格 run 子目录证据，且会触发 unregistered 告警噪音
    seedRun(join(root, "flat-run"), ["stage-register.summary.json"]);
    seedRun(join(root, "ws-a", "run-bucketed"), ["webui/segments.json", "prep/iteration-config.json"]);
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

  it("完成锚在场仍 done（failed 不越序）；训练活跃在独立卡数据源呈现（D96：不占段灯）", () => {
    const root = tempRoot();
    seedRun(join(root, "run-done"), ["launch/train.sh", "training/all_results.json"]);
    const doneScan = scanRunDir(root, "run-done", livenessWith({ "run-done": false }));
    expect(doneScan.segments.training).toBe(true);
    // 活跃重跑：完成锚＋progress fresh → training.active（独立训练卡数据源，原 adapter 活跃优先语义保留）
    writeProgress(join(root, "run-done"), { round: 2, updated_at: new Date().toISOString() });
    const activeScan = scanRunDir(root, "run-done", livenessWith({}));
    expect(activeScan.training.active).toBe(true);
    const monitor = buildMonitorSnapshot([activeScan], { offline: true });
    // D96：training 键不在段灯面（八灯＝内核八段），活跃由 run.training.active 承载
    expect((monitor.runs[0]?.segments ?? []).find((s) => s.key === "training")).toBeUndefined();
    expect(monitor.runs[0]?.training.active).toBe(true);
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
    // 夹具用顶层文件标记——launch/launch_manifest.json 形态会被 rev2 D37 判桶（见 rev2 组头注）
    seedRun(join(root, "ws-a", "run-bucketed"), ["stage-register.summary.json"]);
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
  it("①只有 stage summary 无 segments → 段 done（exit 0 映射单源；D96 恒等键——family_split→family_split／experiment_setup→experiment_setup；training/evaluate 无映射不点灯）", () => {
    const root = tempRoot();
    const dir = join(root, "k-direct");
    // 内核直跑形态：七段 summary 在 run 顶层，无 webui/（无 segments.json/binding.json）
    for (const stage of ["register", "label_qc", "experiment_setup", "candidate_build", "publish", "family_split", "admission"]) {
      seedStageSummary(dir, "k-direct", stage, 0);
    }
    const scan = scanRunDirAt(dir, "k-direct");
    expect(scan.segments.register).toBe(true);
    expect(scan.segments.label_qc).toBe(true);
    expect(scan.segments.experiment_setup).toBe(true);
    expect(scan.segments.publish).toBe(true);
    expect(scan.segments.family_split).toBe(true);
    expect(scan.segments.admission).toBe(true);
    expect(scan.segments.candidate_build).toBe(true); // D96 恒等键入段序闭包（candidate 老键退役）
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
    // 夹具充实（裁决授权）：run-b1 补身份锚——孤立 launch_manifest.json 单标记在收紧
    // 判据下不再是合格 run 子目录证据（ws-d3 会被误分 unregistered_entry 产生告警噪音）
    seedRun(join(root, "ws-d3", "run-b1"), ["webui/segments.json"]);
    const runs = scanRuns(root);
    expect(runs[0]?.workspace).toBe("ws-d3");
    expect(runs[0]?.workspace_source).toBe("bucket");
  });

  it("⑤平铺无 binding → workspace null 但渲染可见；有 binding → 注册表 sessionIds 反查归属", () => {
    const root = tempRoot();
    // 夹具用顶层文件标记——launch/launch_manifest.json 形态会被 rev2 D37 判桶（见 rev2 组头注）
    seedRun(join(root, "plain-no-bind"), ["stage-register.summary.json"]);
    const regws = tempRoot();
    seedRun(join(root, "flat-bound"), ["stage-register.summary.json"]);
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

/** H2.1 rev2（D37+D38）夹具——runs 根条目身份形态种子。 */
const seedVariantPollution = (dir: string): void => {
  // 测试侧污染形态：prep/variants/variants_report.json（RUN_MARKER_RELS 命中 "prep"）
  mkdirSync(join(dir, "prep", "variants"), { recursive: true });
  writeFileSync(join(dir, "prep", "variants", "variants_report.json"), "{}\n", "utf8");
};

describe("H2.1 rev2（D37+D38）——runs 根四类身份分类与注册工作区 run 根", () => {
  it("D37 桶容器：prep 污染不使容器成 run，也不妨碍桶识别（只枚举 run-x，容器不进列表）", () => {
    const root = tempRoot();
    seedVariantPollution(join(root, "bucket"));
    seedRun(join(root, "bucket", "run-x"), ["webui/segments.json"]);
    const entries = enumerateRunEntries(root);
    const ids = entries.map((e) => e.runId);
    expect(ids).toContain("run-x");
    expect(ids).not.toContain("bucket");
    expect(ids).not.toContain("prep");
    expect(entries.find((e) => e.runId === "run-x")).toMatchObject({
      dir: join(root, "bucket", "run-x"),
      workspace: "bucket",
      workspaceSource: "bucket",
    });
    expect(hasRunChildDirs(join(root, "bucket"))).toBe(true);
  });

  it("unregistered_entry：无 run.json、无 run 子目录、无标记 → 隔离不进列表＋结构化告警（路径＋原因）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "solo", "foo"), { recursive: true }); // bucket/foo 形态：无任何标记
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = enumerateRunEntries(root);
      expect(entries.map((e) => e.runId)).not.toContain("solo");
      const lines = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("solo"));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toContain("unregistered_entry");
      expect(lines[0]).toContain(join(root, "solo"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("D38 canonical 优先：注册工作区 workspace/runs 与 runsRoot 别名树同名 run 只出一条且指向 canonical", () => {
    const root = tempRoot();
    const regws = tempRoot();
    // canonical：<ws>/workspace/runs/run-x（prep/iteration-config/trainer_log.jsonl）
    mkdirSync(join(regws, "workspace", "runs", "run-x", "prep", "iteration-config"), { recursive: true });
    writeFileSync(
      join(regws, "workspace", "runs", "run-x", "prep", "iteration-config", "trainer_log.jsonl"),
      `${JSON.stringify({ current_steps: 1, total_steps: 10, percentage: 10 })}\n`,
      "utf8",
    );
    // 别名树：runsRoot 下同名桶 run-x（prep+eval 双标记——对偶真实 qc-02 别名树形态；
    // 收紧判据下单标记 eval 不再是合格 run 子目录证据，alias-ws 会被误分 unregistered）
    mkdirSync(join(root, "alias-ws", "run-x", "eval", "1-20261021"), { recursive: true });
    writeFileSync(join(root, "alias-ws", "run-x", "eval", "1-20261021", "metrics_summary.json"), "{}\n", "utf8");
    mkdirSync(join(root, "alias-ws", "run-x", "prep", "variants"), { recursive: true });
    writeFileSync(join(root, "alias-ws", "run-x", "prep", "variants", "variants_report.json"), "{}\n", "utf8");
    const registryWorkspaces = [{ path: regws, title: "alias-ws" }]; // title 与别名桶目录名同串
    const entries = enumerateRunEntries(root, registryWorkspaces);
    const hits = entries.filter((e) => e.runId === "run-x");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      dir: join(regws, "workspace", "runs", "run-x"), // canonical 胜出
      workspace: "alias-ws",
      workspaceSource: "registry",
    });
    expect(scanRuns(root, undefined, registryWorkspaces).filter((s) => s.run_id === "run-x")).toHaveLength(1);
  });

  it("D38 三档候选根：旧布局 <ws>/runs 与历史实验树可枚举；同 runId 跨档 canonical 优先不重复", () => {
    const root = tempRoot();
    const ws1 = tempRoot();
    seedRun(join(ws1, "runs", "run-y")); // ②旧布局
    const ws2 = tempRoot();
    seedRun(join(ws2, "workspace", "runs", "run-z")); // ①canonical
    seedRun(join(ws2, "experiments", "e1", "runs", "run-z")); // ③历史实验树（同名同工作区）
    const entries = enumerateRunEntries(root, [
      { path: ws1, title: "旧布局工作区" },
      { path: ws2, title: "实验树工作区" },
    ]);
    const y = entries.filter((e) => e.runId === "run-y");
    expect(y).toHaveLength(1);
    expect(y[0]).toMatchObject({ dir: join(ws1, "runs", "run-y"), workspace: "旧布局工作区", workspaceSource: "registry" });
    const z = entries.filter((e) => e.runId === "run-z");
    expect(z).toHaveLength(1); // 同 (workspace,runId) 跨档去重
    expect(z[0]?.dir).toBe(join(ws2, "workspace", "runs", "run-z")); // canonical 档先 claim 胜出
  });

  it("legacy run（qc-02 形态：RUN_MARKER_RELS 标记、无 run.json）可见", () => {
    const root = tempRoot();
    const dir = join(root, "run-qc02-legacy");
    mkdirSync(join(dir, "eval", "1-20261021"), { recursive: true });
    writeFileSync(join(dir, "eval", "1-20261021", "metrics_summary.json"), "{}\n", "utf8");
    mkdirSync(join(dir, "prep", "variants"), { recursive: true });
    writeFileSync(join(dir, "prep", "variants", "variants_report.json"), "{}\n", "utf8");
    const entries = enumerateRunEntries(root);
    const hit = entries.find((e) => e.runId === "run-qc02-legacy");
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ dir, workspace: null, workspaceSource: "bucket" });
  });

  it("artifact_outside_layout：run.json.dirs 清单外顶层目录 → 不进列表＋告警；合规 valid run 不误伤", () => {
    const root = tempRoot();
    // 合规 valid run：dirs 声明与顶层目录一致 → 进列表
    mkdirSync(join(root, "run-clean", "webui"), { recursive: true });
    mkdirSync(join(root, "run-clean", "prep"), { recursive: true });
    writeFileSync(
      join(root, "run-clean", "run.json"),
      `${JSON.stringify({ workspace_id: "w", run_id: "run-clean", layout_version: "RunLayout/v1", dirs: ["webui", "prep"] })}\n`,
      "utf8",
    );
    // 违规 valid run：顶层 rogue/ 不在 dirs 声明 → 隔离＋告警
    mkdirSync(join(root, "run-dirty", "webui"), { recursive: true });
    mkdirSync(join(root, "run-dirty", "rogue"), { recursive: true });
    writeFileSync(
      join(root, "run-dirty", "run.json"),
      `${JSON.stringify({ workspace_id: "w", run_id: "run-dirty", layout_version: "RunLayout/v1", dirs: ["webui"] })}\n`,
      "utf8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = enumerateRunEntries(root);
      const ids = entries.map((e) => e.runId);
      expect(ids).toContain("run-clean");
      expect(ids).not.toContain("run-dirty");
      const lines = warnSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("run-dirty"));
      expect(lines.some((l) => l.includes("artifact_outside_layout"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("同 realpath 双通道去重：注册工作区旧布局档与 runsRoot 平铺同一目录只出一次（registry 先登记）", () => {
    const outer = tempRoot();
    const root = join(outer, "runs");
    mkdirSync(root, { recursive: true });
    seedRun(join(root, "flat-run"), ["stage-register.summary.json"]); // 同一目录：registry 档② 与 flat 通道同 realpath
    const entries = enumerateRunEntries(root, [{ path: outer, title: "注册甲" }]);
    const hits = entries.filter((e) => e.runId === "flat-run");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ dir: join(root, "flat-run"), workspace: "注册甲", workspaceSource: "registry" });
  });

  it("桶判定收紧负锚：孤立 launch_manifest.json 单命中不是合格 run 子目录（cr_r2/launch 假阳性不复活）", () => {
    const root = tempRoot();
    // 宿主 run：launch/launch_manifest.json（父 run 标记落在 launch/ 内）＋顶层身份锚
    const host = join(root, "run-host");
    seedRun(host, ["launch/launch_manifest.json", "webui/config-snapshot.json"]);
    // 子目录 launch 仅命中孤立 manifest（1 个标记）——不合格 → 宿主保持 legacy，不判桶
    const byName = new Map(classifyRunRootEntries(root).map((c) => [c.name, c]));
    expect(byName.get("run-host")).toMatchObject({ kind: "legacy_run", artifactOutsideLayout: false, reason: null });
    expect(hasRunChildDirs(host)).toBe(false);
    expect(isQualifyingRunChild(join(host, "launch"))).toBe(false);
    // 对照：同形态补段事实身份锚 → 合格（锚 2）
    mkdirSync(join(host, "launch", "webui"), { recursive: true });
    writeFileSync(join(host, "launch", "webui", "segments.json"), "{}\n", "utf8");
    expect(isQualifyingRunChild(join(host, "launch"))).toBe(true);
    expect(hasRunChildDirs(host)).toBe(true);
  });

  it("纯函数面：classifyRunRootEntries 四类判定＋hasRunChildDirs（不按目录名特判——prep 只是标记实例）", () => {    const root = tempRoot();
    seedVariantPollution(join(root, "bkt")); // 容器仅 prep 污染
    seedRun(join(root, "bkt", "run-x"), ["webui/segments.json"]); // ＋真 run 子目录
    mkdirSync(join(root, "lone", "foo"), { recursive: true }); // 无任何标记
    // 顶层文件标记（launch/launch_manifest.json 形态的 launch/ 子目录会命中裸标记被判桶）
    seedRun(join(root, "legacy-run"), ["stage-register.summary.json"]); // 旧 run：标记、无 run.json
    mkdirSync(join(root, "vr", "webui"), { recursive: true });
    writeFileSync(
      join(root, "vr", "run.json"),
      `${JSON.stringify({ workspace_id: "w", run_id: "vr", layout_version: "RunLayout/v1", dirs: ["webui"] })}\n`,
      "utf8",
    );
    const byName = new Map(classifyRunRootEntries(root).map((c) => [c.name, c]));
    expect(byName.get("bkt")).toMatchObject({ kind: "bucket", artifactOutsideLayout: false, reason: null });
    expect(byName.get("lone")?.kind).toBe("unregistered_entry");
    expect(byName.get("lone")?.reason).toContain("no run.json");
    expect(byName.get("legacy-run")).toMatchObject({ kind: "legacy_run", artifactOutsideLayout: false, reason: null });
    expect(byName.get("vr")).toMatchObject({ kind: "valid_run", artifactOutsideLayout: false, reason: null });
    expect(hasRunChildDirs(join(root, "bkt"))).toBe(true);
    expect(hasRunChildDirs(join(root, "legacy-run"))).toBe(false);
    expect(hasRunChildDirs(join(root, "lone"))).toBe(false);
  });
});
