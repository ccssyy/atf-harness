/**
 * 批㊶Q增补三 测试锚——段3 run 单根多桶布局（runs/<工作区>/<run_id>＋存量平铺兼容）／
 * 段1 放行账本单源收口（启动校验＋审计注释＋tmux env 前缀）／段4.2 pending 存量清理扫描。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bucketedRunEntries,
  flatRunDirNames,
  isValidRunId,
  resolveRunDir,
  sessionWorkspaceSlug,
  slugForWorkspaceCwd,
  sweepAnsweredPendings,
} from "../../src/core/workspace/runLayout.js";
import { appendSegmentFact } from "../../src/core/workspace/segmentFacts.js";
import { appendBinding } from "../../src/core/workspace/runFacts.js";
import {
  isV3RunTree,
  resolveRunFile,
  resolveRunSubdir,
  RUN_LAYOUT_V3,
  runLayoutVersionOf,
} from "../../src/core/workspace/runSubdirs.js";
import {
  appendLedgerAuditComment,
  checkApprovalLedgerStartup,
  homeLedgerPathOf,
  LEDGER_AUDIT_MARKER,
  ledgerEnvPrefixForShell,
  shellSingleQuoted,
} from "../../src/core/workspace/approvalLedger.js";

const tempRoots: string[] = [];
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "zz3-layout-test-"));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("批㊶Q增补三 段3——工作区桶名（slug）推导", () => {
  it("cwd basename 入桶名；非法字符折 '_'；空/缺 → null（不归属）", () => {
    expect(slugForWorkspaceCwd("/data/chris/docops/tasks/ci_smoke")).toBe("ci_smoke");
    // 非 ASCII 桶名折 '_' 后不满足合法形态 → null（不归属，fail-closed 回平铺）
    expect(slugForWorkspaceCwd("/home/u/我的 工作区/")).toBeNull();
    expect(slugForWorkspaceCwd("")).toBeNull();
    expect(slugForWorkspaceCwd(undefined)).toBeNull();
    expect(slugForWorkspaceCwd("/")).toBeNull();
  });
  it("exec.agent.session.header.cwd 锚（vendor tool-bash 同源）——取不到如实 null", () => {
    const exec = { agent: { session: { header: { cwd: "/data/chris/docops/tasks/ci_smoke" }, id: "s1" } } };
    expect(sessionWorkspaceSlug(exec)).toBe("ci_smoke");
    expect(sessionWorkspaceSlug({ agent: { session: { id: "s1" } } })).toBeNull();
    expect(sessionWorkspaceSlug({})).toBeNull();
    expect(sessionWorkspaceSlug(undefined)).toBeNull();
  });
  it("run_id 合法形态（穿越面拒）", () => {
    expect(isValidRunId("cr_r3")).toBe(true);
    expect(isValidRunId("run-docops-20261011")).toBe(true);
    expect(isValidRunId("..")).toBe(false);
    expect(isValidRunId("a/b")).toBe(false);
    expect(isValidRunId("")).toBe(false);
  });
});

describe("批㊶Q增补三 段3——resolveRunDir 双形态解析（存量平铺原地保留＋新 run 入桶）", () => {
  it("① 平铺在场优先（存量兼容——不迁移）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cr_r1"), { recursive: true });
    expect(resolveRunDir(root, "cr_r1", { workspace: "ci_smoke" })).toBe(join(root, "cr_r1"));
  });
  it("② 平铺缺＋桶内在场 → 桶（指定桶优先）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ci_smoke", "cr_r3"), { recursive: true });
    mkdirSync(join(root, "br_ws", "cr_r3"), { recursive: true });
    expect(resolveRunDir(root, "cr_r3", { workspace: "ci_smoke" })).toBe(join(root, "ci_smoke", "cr_r3"));
    // 无桶提示：多桶同名 run 落字典序首桶（确定性——readdir 序不依赖）
    expect(resolveRunDir(root, "cr_r3")).toBe(join(root, "br_ws", "cr_r3"));
  });
  it("③ 两缺新建：有工作区归属 → runs/<桶>/<run_id>；无归属/系统级 default → 平铺", () => {
    const root = tempRoot();
    expect(resolveRunDir(root, "cr_r3", { workspace: "ci_smoke" })).toBe(join(root, "ci_smoke", "cr_r3"));
    expect(resolveRunDir(root, "cr_r3")).toBe(join(root, "cr_r3"));
    expect(resolveRunDir(root, "cr_r3", { workspace: null })).toBe(join(root, "cr_r3"));
    expect(resolveRunDir(root, "default", { workspace: "ci_smoke" })).toBe(join(root, "default"));
  });
  it("非法 runId 原样平铺拼接（行为兼容，不扫描）", () => {
    const root = tempRoot();
    expect(resolveRunDir(root, "../escape")).toBe(join(root, "../escape"));
  });
  it("双层清单：平铺名清单＋分桶条目（workspace/runId/dir）", () => {
    const root = tempRoot();
    mkdirSync(join(root, "cr_flat"), { recursive: true });
    mkdirSync(join(root, "ci_smoke", "cr_r3"), { recursive: true });
    mkdirSync(join(root, ".hidden", "x"), { recursive: true });
    expect(flatRunDirNames(root).sort()).toEqual(["ci_smoke", "cr_flat"]);
    const bucketed = bucketedRunEntries(root).filter((e) => e.runId === "cr_r3");
    expect(bucketed).toEqual([{ workspace: "ci_smoke", runId: "cr_r3", dir: join(root, "ci_smoke", "cr_r3") }]);
  });
});

describe("批㊶Q增补三 段4.2——pending-confirm 存量清理扫描（完成即删含存量；等待中不动）", () => {
  const seedPending = (root: string, runId: string, kind: string, done: boolean, kind2: "snapshot" | "segment"): void => {
    const dir = join(root, runId, "webui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pending-confirm.json"), JSON.stringify({ kind, run_id: runId }) + "\n");
    if (!done) return;
    if (kind2 === "snapshot") writeFileSync(join(dir, "config-snapshot.json"), "{}\n");
    else appendSegmentFact(join(root, runId), "publish", "test");
  };
  it("config_confirm＋快照在场（cr_r2 形态）→ 清；config_confirm 无快照（等待中）→ 不动", () => {
    const root = tempRoot();
    seedPending(root, "cr_r2", "config_confirm", true, "snapshot");
    seedPending(root, "cr_wait", "config_confirm", false, "snapshot");
    const swept = sweepAnsweredPendings(root);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toContain(join("cr_r2", "webui", "pending-confirm.json"));
    expect(existsSync(join(root, "cr_r2", "webui", "pending-confirm.json"))).toBe(false);
    expect(readdirSync(join(root, "cr_r2", "webui")).some((f) => f.startsWith("pending-confirm.json.answered."))).toBe(true);
    expect(existsSync(join(root, "cr_wait", "webui", "pending-confirm.json"))).toBe(true);
  });
  it("publish_confirm＋publish 段事实在场 → 清；无段事实 → 不动；坏 JSON 不动；分桶 run 同样覆盖", () => {
    const root = tempRoot();
    seedPending(root, "pub_done", "publish_confirm", true, "segment");
    seedPending(root, "pub_wait", "publish_confirm", false, "segment");
    const bucketDir = join(root, "ci_smoke", "cr_bucket", "webui");
    mkdirSync(bucketDir, { recursive: true });
    writeFileSync(join(bucketDir, "pending-confirm.json"), JSON.stringify({ kind: "config_confirm" }) + "\n");
    writeFileSync(join(root, "ci_smoke", "cr_bucket", "webui", "config-snapshot.json"), "{}\n");
    mkdirSync(join(root, "bad", "webui"), { recursive: true });
    writeFileSync(join(root, "bad", "webui", "pending-confirm.json"), "not-json{");
    const swept = sweepAnsweredPendings(root);
    expect(swept).toHaveLength(2);
    expect(existsSync(join(root, "pub_done", "webui", "pending-confirm.json"))).toBe(false);
    expect(existsSync(join(root, "pub_wait", "webui", "pending-confirm.json"))).toBe(true);
    expect(existsSync(join(bucketDir, "pending-confirm.json"))).toBe(false);
    expect(existsSync(join(root, "bad", "webui", "pending-confirm.json"))).toBe(true);
  });
});

describe("批㊶Q增补三 段1②——放行账本启动校验（fail-fast／双轴告警）", () => {
  it("env 显式配置：目录供给后可写 → dirWritable；与 $HOME 推导不一致 → mismatch＋两路径明示", () => {
    const home = tempRoot();
    const ledger = join(tempRoot(), "ledger-axes", "training-release.jsonl");
    const check = checkApprovalLedgerStartup({ HOME: home, ATF_APPROVAL_LEDGER: ledger });
    expect(check.envPath).toBe(ledger);
    expect(check.homePath).toBe(homeLedgerPathOf(home));
    expect(check.dirWritable).toBe(true);
    expect(check.mismatch).toBe(true);
    expect(check.message).toContain(ledger);
    expect(check.message).toContain(homeLedgerPathOf(home));
    expect(existsSync(join(ledger, ".."))).toBe(true);
  });
  it("env 与 $HOME 推导一致（尾斜杠等价）→ mismatch=false", () => {
    const home = tempRoot();
    const check = checkApprovalLedgerStartup({ HOME: home, ATF_APPROVAL_LEDGER: homeLedgerPathOf(home) + "/" });
    expect(check.mismatch).toBe(false);
    expect(check.message).toContain("一致");
  });
  it("env 缺省回退位：不建目录不阻塞（dirWritable=true），message 如实标注回退", () => {
    const home = tempRoot();
    const check = checkApprovalLedgerStartup({ HOME: home });
    expect(check.envPath).toBeNull();
    expect(check.mismatch).toBe(false);
    expect(check.dirWritable).toBe(true);
    expect(check.effectivePath).toBe(homeLedgerPathOf(home));
    expect(existsSync(homeLedgerPathOf(home))).toBe(false);
    expect(check.message).toContain("回退");
  });
  it("env 配置而目录不可写（父位是文件）→ dirWritable=false（fail-fast 裁决面）", () => {
    const home = tempRoot();
    const blocker = join(home, "blocker");
    writeFileSync(blocker, "not-a-dir");
    const check = checkApprovalLedgerStartup({ HOME: home, ATF_APPROVAL_LEDGER: join(blocker, "sub", "training-release.jsonl") });
    expect(check.dirWritable).toBe(false);
  });
});

describe("批㊶Q增补三 段1③——train.sh 生成面审计注释（幂等）＋tmux env 前缀", () => {
  it("审计注释：追加生效路径一行；二次调用幂等不再追加", () => {
    const root = tempRoot();
    const trainSh = join(root, "train.sh");
    const env = { HOME: root, ATF_APPROVAL_LEDGER: "/abs/ledger/training-release.jsonl" };
    writeFileSync(trainSh, "#!/usr/bin/env bash\nexec echo train\n");
    // 批甲-BUILD T3：返回结构化 outcome——写成功＝appended+零噪音（warning null）
    expect(appendLedgerAuditComment(trainSh, env)).toEqual({ appended: true, warning: null });
    const once = readFileSync(trainSh, "utf8");
    expect(once).toContain(LEDGER_AUDIT_MARKER);
    expect(once).toContain("/abs/ledger/training-release.jsonl");
    expect(once).toContain("${ATF_APPROVAL_LEDGER:-$HOME/.atf/approval-ledger/training-release.jsonl}");
    // 幂等跳过＝零噪音（warning null——告警只属写失败）
    expect(appendLedgerAuditComment(trainSh, env)).toEqual({ appended: false, warning: null });
    expect(readFileSync(trainSh, "utf8")).toBe(once);
  });
  it("审计注释写失败注入→告警在场（含账本路径与失败原因）；文件缺席→零噪音（T3 锚）", () => {
    const root = tempRoot();
    const env = { HOME: root, ATF_APPROVAL_LEDGER: "/abs/ledger/training-release.jsonl" };
    // 写失败注入：train.sh 传目录路径——existsSync 在场而 readFileSync EISDIR，fail-open 捕获后告警
    const outcome = appendLedgerAuditComment(root, env);
    expect(outcome.appended).toBe(false);
    expect(outcome.warning).not.toBeNull();
    expect(outcome.warning).toContain("/abs/ledger/training-release.jsonl");
    expect(outcome.warning).toContain("fail-open");
    expect(outcome.warning).toContain("原因=");
    // 文件缺席＝非失败（调用方语义：脚本未生成），零噪音
    expect(appendLedgerAuditComment(join(root, "absent.sh"), env)).toEqual({ appended: false, warning: null });
  });
  it("shell 单引号转义＋env 前缀（未设＝空串）", () => {
    expect(shellSingleQuoted("/a/b'c")).toBe("'/a/b'\\''c'");
    expect(ledgerEnvPrefixForShell({})).toBe("");
    const prefix = ledgerEnvPrefixForShell({ ATF_APPROVAL_LEDGER: "/abs/ledger.jsonl" });
    expect(prefix).toBe("env ATF_APPROVAL_LEDGER='/abs/ledger.jsonl' ");
    expect(ledgerEnvPrefixForShell({ ATF_APPROVAL_LEDGER: "/a/b'c" })).toBe("env ATF_APPROVAL_LEDGER='/a/b'\\''c' ");
  });
});

describe("批㊶Q增补三 段1②——atf-tools apply 启动面（fail-fast 裁决落地；boot 日志同源）", () => {
  const baseConfig = {
    runsRoot: "/tmp/ledger-boot-runs",
    kernelDir: "/data/sam/ATF-Harness/.atf-pinned",
    execHome: "/tmp/ledger-boot-exec-home",
    logDir: "/tmp/ledger-boot-logs",
    bridgeCommand: "node /data/sam/ATF-Harness/tests/fixtures/mock_atf.mjs",
    pipelineCommand: "node /data/sam/ATF-Harness/tests/fixtures/mock_pipeline.mjs",
    pipelineTimeoutMs: 120_000,
  };
  const ctxStub = { tools: { register: (): void => {} }, get: (): undefined => undefined, effect: (): void => {} };
  it("env 配置而目录不可写 → apply 抛错拒绝启动（fail-fast）", async () => {
    const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs");
    const home = mk(join(tmpdir(), "ledger-apply-"));
    const blocker = join(home, "blocker");
    wf(blocker, "not-a-dir");
    const { apply } = await import("../../packages/extensions/atf-tools/src/index.js");
    const saved = process.env["ATF_APPROVAL_LEDGER"];
    const savedHome = process.env["HOME"];
    process.env["ATF_APPROVAL_LEDGER"] = join(blocker, "sub", "training-release.jsonl");
    try {
      expect(() => apply(ctxStub, baseConfig)).toThrow(/放行账本目录不可写/);
    } finally {
      if (saved === undefined) delete process.env["ATF_APPROVAL_LEDGER"]; else process.env["ATF_APPROVAL_LEDGER"] = saved;
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
    }
  });
  it("env 缺省回退位 → apply 正常完成（不阻塞；GPU 排队旁路 env 已由文件头设置）", async () => {
    const { apply } = await import("../../packages/extensions/atf-tools/src/index.js");
    const saved = process.env["ATF_APPROVAL_LEDGER"];
    delete process.env["ATF_APPROVAL_LEDGER"];
    try {
      expect(() => apply(ctxStub, baseConfig)).not.toThrow();
    } finally {
      if (saved !== undefined) process.env["ATF_APPROVAL_LEDGER"] = saved;
    }
  });
});

// ─────────────────────────────────────────────── D49：run 解析 canonical 优先

describe("D49——resolveRunDir canonical 优先（注册工作区 run.json 合法 → canonical；无 run.json → legacy）", () => {
  it("两树同 run → canonical（run.json 在场合法即命中，先于平铺）", () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const ws = join(root, "ws-a");
    mkdirSync(join(runsRoot, "r1"), { recursive: true }); // 平铺（legacy 镜像）
    const canonical = join(ws, "workspace", "runs", "r1");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "run.json"), JSON.stringify({ layout_version: "RunLayout/v1" }), "utf8");
    expect(resolveRunDir(runsRoot, "r1", { canonicalRoots: [ws] })).toBe(canonical);
  });
  it("canonical 无 run.json → legacy（回落平铺在场面）", () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const ws = join(root, "ws-a");
    const flat = join(runsRoot, "r1");
    mkdirSync(flat, { recursive: true });
    mkdirSync(join(ws, "workspace", "runs", "r1"), { recursive: true }); // 目录在但无 run.json
    expect(resolveRunDir(runsRoot, "r1", { canonicalRoots: [ws] })).toBe(flat);
  });
  it("canonical run.json 坏 JSON → 不命中（fail-closed 回落平铺）", () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const ws = join(root, "ws-a");
    const flat = join(runsRoot, "r1");
    mkdirSync(flat, { recursive: true });
    const canonical = join(ws, "workspace", "runs", "r1");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "run.json"), "{not json", "utf8");
    expect(resolveRunDir(runsRoot, "r1", { canonicalRoots: [ws] })).toBe(flat);
  });
  it("多注册根逐根查（第一根缺、第二根命中）；canonicalRoots 缺省＝既有行为零变化", () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const wsA = join(root, "ws-a");
    const wsB = join(root, "ws-b");
    const flat = join(runsRoot, "r1");
    mkdirSync(flat, { recursive: true });
    const canonical = join(wsB, "workspace", "runs", "r1");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "run.json"), "{}", "utf8");
    expect(resolveRunDir(runsRoot, "r1", { canonicalRoots: [wsA, wsB] })).toBe(canonical);
    expect(resolveRunDir(runsRoot, "r1")).toBe(flat); // 无种子＝不查 canonical
  });
  it("training/evaluate 写面单源：resolveToolRun 显式 run_id → canonical 目录（join 写面随之落 canonical——legacy 零新增）", async () => {
    const root = tempRoot();
    const runsRoot = join(root, "runs");
    const ws = join(root, "ws-a");
    const flat = join(runsRoot, "r1");
    mkdirSync(flat, { recursive: true });
    const canonical = join(ws, "workspace", "runs", "r1");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "run.json"), "{}", "utf8");
    const { resolveToolRun } = await import("../../packages/extensions/atf-tools/src/trainingFace.js");
    const resolution = resolveToolRun(runsRoot, {}, "r1", [ws]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.runDir).toBe(canonical);
      // 写面拼接（training/eval 段落点）随 runDir 单源——canonical 在场即全落 canonical
      expect(join(resolution.runDir, "training")).toBe(join(canonical, "training"));
      expect(existsSync(join(flat, "training"))).toBe(false); // legacy 树零新增
    }
  });
});

// ══ RunLayout/v3 写侧落名（写侧只认 run.json 声明的闭集；读侧才允许回退）══
//
// 背景（真实事故链）：v3 run 内部若意外存在 v2 名目录（webui/ 之类），旧实现是
// 「v3 名存在→v3；否则 v2 名存在→v2」，于是会优先把产物写进那个**未声明**的 v2 名目录
// ——skills 侧 check_run_layout 的 layout_undeclared_dir 是失败级（一次写就永远红）。
// 现约定：run.json 明示 RunLayout/v3 → 落名恒取 v3 名；非 v3（v2/v1/无 manifest/
// 读不到或读坏 run.json）→ 沿用 v2 名（不认识的 run 不动它）。

const v3Run = (dirs: string[] = [...RUN_LAYOUT_V3]): string => {
  const runDir = tempRoot();
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ layout_version: "RunLayout/v3", workspace_id: "w", run_id: "r", experiment_id: "e", created_at: "2026-10-27T00:00:00Z", dirs }, null, 1),
    "utf8",
  );
  return runDir;
};
/** run 根一级目录名（排序；run.json 是文件不计入）。 */
const topDirsOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

describe("RunLayout/v3 写侧落名——v3 树不写 v2 名（声明闭集单源）", () => {
  it("① v3 树 + 预置空 webui/：webui 落 runtime/webui（不被 v2 名目录改道），且 webui/ 永不被写", () => {
    const runDir = v3Run();
    mkdirSync(join(runDir, "webui"), { recursive: true }); // 残留的 v2 名目录
    expect(isV3RunTree(runDir)).toBe(true);
    expect(resolveRunSubdir(runDir, "webui")).toBe(join(runDir, "runtime", "webui"));
    expect(resolveRunFile(runDir, "webui/config-snapshot.json")).toBe(join(runDir, "runtime", "webui", "config-snapshot.json"));

    appendSegmentFact(runDir, "register", "atf_admit_data");
    expect(existsSync(join(runDir, "runtime", "webui", "segments.json"))).toBe(true);
    expect(readdirSync(join(runDir, "webui"))).toEqual([]); // 残留目录保持空——没被写进去
  });

  it("② v3 树：prep 落 data（不是 prep）；data/ 已在场时不新增 prep/", () => {
    const runDir = v3Run();
    mkdirSync(join(runDir, "data"), { recursive: true });
    expect(resolveRunSubdir(runDir, "prep")).toBe(join(runDir, "data"));
    expect(resolveRunSubdir(runDir, "prep/variants")).toBe(join(runDir, "data", "variants"));
    expect(resolveRunFile(runDir, "prep/iteration-config/iteration-config.json")).toBe(join(runDir, "config", "iteration-config", "iteration-config.json"));
    appendSegmentFact(runDir, "training_prep", "atf_pipeline_stage");
    expect(existsSync(join(runDir, "prep"))).toBe(false); // 未声明目录零新增
  });

  it("③ v2 树（webui/＋prep/ 已在场）：沿用 v2 名，不新增 runtime/（存量不迁移）", () => {
    const runDir = tempRoot();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ layout_version: "RunLayout/v2", dirs: ["webui", "prep"] }), "utf8");
    mkdirSync(join(runDir, "webui"), { recursive: true });
    mkdirSync(join(runDir, "prep"), { recursive: true });
    expect(isV3RunTree(runDir)).toBe(false);
    expect(resolveRunSubdir(runDir, "webui")).toBe(join(runDir, "webui"));
    expect(resolveRunSubdir(runDir, "prep")).toBe(join(runDir, "prep"));
    appendSegmentFact(runDir, "register", "atf_admit_data");
    expect(existsSync(join(runDir, "runtime"))).toBe(false);
    expect(existsSync(join(runDir, "webui", "segments.json"))).toBe(true);
  });

  it("④ 无 run.json（legacy）：落 v2 名", () => {
    const runDir = tempRoot();
    expect(runLayoutVersionOf(runDir)).toBeNull();
    expect(resolveRunSubdir(runDir, "webui")).toBe(join(runDir, "webui"));
  });

  it("⑤ run.json 在场但缺 layout_version：非 v3 → 落 v2 名（真机畸形样本同形态）", () => {
    const runDir = tempRoot();
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ run_id: "x", dirs: [] }), "utf8");
    expect(isV3RunTree(runDir)).toBe(false);
    expect(resolveRunSubdir(runDir, "webui")).toBe(join(runDir, "webui"));
    expect(resolveRunSubdir(runDir, "prep")).toBe(join(runDir, "prep"));
  });

  it("⑥ run.json 坏（非法 JSON）：fail-open 当非 v3 → 落 v2 名，且不抛错（读取失败不得打断写入）", () => {
    const runDir = tempRoot();
    writeFileSync(join(runDir, "run.json"), "{ this is not json", "utf8");
    expect(() => runLayoutVersionOf(runDir)).not.toThrow();
    expect(runLayoutVersionOf(runDir)).toBeNull();
    expect(() => resolveRunSubdir(runDir, "webui")).not.toThrow();
    expect(resolveRunSubdir(runDir, "webui")).toBe(join(runDir, "webui"));
  });

  it("⑦ 空 v3 树真写（段事实＋绑定＋快照）：顶层只多出 runtime/，且每个新目录都在 run.json.dirs 声明内", () => {
    // 前提是「空树」（只有 run.json）：新增集合才有意义地等于 ["runtime"]。
    // 满骨架树（create_run 产出）见 ⑧——那里 runtime/ 早已建好，新增集合应为空集。
    const declared = new Set(RUN_LAYOUT_V3);
    const runDir = v3Run();
    const before = new Set(topDirsOf(runDir));
    appendSegmentFact(runDir, "register", "atf_admit_data");
    appendBinding(runDir, "sess-v3");
    const snap = resolveRunFile(runDir, "webui/config-snapshot.json");
    mkdirSync(join(runDir, "runtime", "webui"), { recursive: true });
    writeFileSync(snap, JSON.stringify({ confirmed: { max_total_tokens: "9000" } }), "utf8");

    const added = topDirsOf(runDir).filter((name) => !before.has(name));
    expect(added).toEqual(["runtime"]); // 只多出 runtime/（v3 声明内），没有 webui/ prep/ 之类
    for (const name of added) expect(declared.has(name), name).toBe(true);
    expect(existsSync(join(runDir, "runtime", "webui", "segments.json"))).toBe(true);
    expect(existsSync(join(runDir, "runtime", "webui", "binding.json"))).toBe(true);
    expect(existsSync(join(runDir, "runtime", "webui", "config-snapshot.json"))).toBe(true);
    expect(existsSync(join(runDir, "webui"))).toBe(false);
  });

  it("⑧ 满骨架 v3 树（create_run 产出形态）真写：顶层新增集合为空集（runtime/ 早已建好），只落声明内路径", () => {
    // 真机 v3 run 就是这种形态（实测 /tmp/v3s/ws/experiments/20261027-adhoc/v3s-01：
    // 9 类顶层齐、runtime/{loop,webui} 已在）。此处若沿用 ⑦ 的「等值 [runtime]」会假红，
    // 故断言改为「新增集合 ⊆ 声明闭集」＋「本次写入确实落在 runtime/webui 内」。
    const declared = new Set(RUN_LAYOUT_V3);
    const runDir = v3Run();
    for (const rel of RUN_LAYOUT_V3) mkdirSync(join(runDir, rel), { recursive: true }); // 满骨架
    const before = new Set(topDirsOf(runDir));

    appendSegmentFact(runDir, "register", "atf_admit_data");
    appendBinding(runDir, "sess-v3");
    expect(resolveRunFile(runDir, "webui/config-snapshot.json")).toBe(join(runDir, "runtime", "webui", "config-snapshot.json"));

    const added = topDirsOf(runDir).filter((name) => !before.has(name));
    expect(added).toEqual([]); // 满骨架树上不该冒出任何新顶层目录
    for (const name of added) expect(declared.has(name), name).toBe(true); // 不变式：新增只可能在声明闭集内
    expect(existsSync(join(runDir, "runtime", "webui", "segments.json"))).toBe(true);
    expect(existsSync(join(runDir, "webui"))).toBe(false);
    expect(existsSync(join(runDir, "prep"))).toBe(false);
  });
});

// ── 验收附录：跨仓双向对账（harness 写 → 内核审计），发包/回归时手工跑一次 ──
//
// 上述 7 条是「函数返回什么」；这份附录是「写完的东西经得起审计」。两者都要，缺一不可
// （单测能证明落名对，但证明不了"有没有多写"）。
//
//   WS=$(mktemp -d); mkdir -p "$WS/experiments/e1/run-v3"
//   # run.json 六键 + RUN_LAYOUT_V3 的 dirs（与内核 _RUN_JSON_KEYS 同口径）
//   # 用 harness helper 真写：appendSegmentFact / appendBinding / resolveRunFile(webui/config-snapshot.json)
//   # 期望 run 顶层 = run.json, runtime        ← 不得出现 webui/
//
//   python3 <kernel>/src/agentic_training_flow/_skills_pack/atf-audit-run/scripts/check_run_layout.py \
//     --workspace-root "$WS"
//   期望：layout_scanned {"RunLayout/v3": 1} / findings [] / verdict pass
//
// 阴性对照（证明审计真能抓，不是永远 pass）：
//   mkdir -p "$WS/experiments/e1/run-v3/webui"      # 手工塞一个未声明目录
//   期望：findings ["layout_undeclared_dir:run-v3:webui(...)"] / verdict fail
//   删掉后回 pass。
//
// 实测记录（2026-10-27，A800_5005）：
//   ① 存量：全机 RunLayout/v3 run = 0（os.walk，相对扫描根 MAXDEPTH≥8 饱和口径；
//      run.json=22 / legacy=37 / 总 59，两方独立复现）。
//   ② 另有**本轮新建的验证 run**（不在①的存量普查口径内；数据同样是假的）：
//      /tmp/v3s/ws  (dev:ino=116:247792136)，内核 create_run + register 真落位
//      （9 类顶层、config/ 4 件、data/ 7 件、runtime/{loop,webui} 在位）。
//      check_run_layout → layout_scanned {"RunLayout/v3":1} / findings [] / pass
//      （run.json docs=[{doc_type:pl, lane_suffix:all}] 与 stage/stage-register.pl.summary.json
//      对得上，否则会报 layout_docs_registry_mismatch）；
//      harness helper 对该树解析：webui→runtime/webui、loop→runtime/loop、prep→data、
//      experiment-setup→config/experiment-setup，全部落在 run.json.dirs 声明内。
//      ⚠ 措辞纪律：不得写成「v3 有 1 个真机 run」——①才是存量普查口径（=0），
//      ②是现造的验证件，混写会让人误判线上迁移进度。
//   ③ 合成样本对账：写后 pass、手工塞 webui/ 后 fail、删掉回 pass——三方对上。
//   （②是唯一非合成数据来源的样本，但数据内容仍是假数据——引用时两句话一起写。）
