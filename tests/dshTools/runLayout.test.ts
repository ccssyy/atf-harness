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
    expect(appendLedgerAuditComment(trainSh, env)).toBe(true);
    const once = readFileSync(trainSh, "utf8");
    expect(once).toContain(LEDGER_AUDIT_MARKER);
    expect(once).toContain("/abs/ledger/training-release.jsonl");
    expect(once).toContain("${ATF_APPROVAL_LEDGER:-$HOME/.atf/approval-ledger/training-release.jsonl}");
    expect(appendLedgerAuditComment(trainSh, env)).toBe(false);
    expect(readFileSync(trainSh, "utf8")).toBe(once);
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
