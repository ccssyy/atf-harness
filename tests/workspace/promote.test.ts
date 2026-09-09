import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RunWorkspace, promoteArtifact, sha256Hex } from "../../src/workspace/index.js";

/**
 * S4 晋升闸 A 测试（任务书 §4.3 验收 + owner 口径 #3/#6）。
 * 复现命令 = 产物元数据 sidecar 登记的 argv 数组，由 harness 侧子进程执行
 * （mock 脚本产物，不调用真实内核）；stdout 字节 sha256 与源产物比对。
 */

const runsRoot = join(fileURLToPath(new URL("../..", import.meta.url)), "tmp", "runs");

const opened: string[] = [];
const makeWorkspace = async () => {
  const dir = join(runsRoot, `test-${randomUUID()}`);
  opened.push(dir);
  const created = await RunWorkspace.create(dir, {
    run_id: "run-promote-1",
    trigger_instruction: "S4 晋升闸测试",
    model_id: "faux",
  });
  expect(created.ok, created.ok ? "" : JSON.stringify(created.error)).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  return created.value;
};

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const STABLE_CONTENT = "G2 准入分析报告 v1：确定性内容，字节级可复现\n";
const STABLE_COMMAND = ["node", "-e", `process.stdout.write(${JSON.stringify(STABLE_CONTENT)})`];

const registerStableArtifact = async (ws: Awaited<ReturnType<typeof makeWorkspace>>, name = "analysis.md") => {
  await ws.scratchWrite(name, STABLE_CONTENT);
  const registered = await ws.registerReproduce(name, STABLE_COMMAND);
  expect(registered.ok).toBe(true);
};

describe("S4 验收（晋升正例）——T0 产物 → promote → artifacts 出现 + sha 登记 → 二次 promote → 幂等拒绝", () => {
  it("全生命周期：promoted + catalog sha 指纹 + 产物字节落位 + 二次 blocked(already_promoted) 且产物不变", async () => {
    const ws = await makeWorkspace();
    await registerStableArtifact(ws);

    const first = await promoteArtifact(ws, "analysis.md");
    expect(first.ok, !first.ok ? JSON.stringify(first.error) : "").toBe(true);
    if (!first.ok || first.value.kind !== "promoted") return;
    const entry = first.value.artifact;
    expect(entry.artifact_id).toBe("analysis.md");
    expect(entry.source).toBe("scratch/analysis.md");
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.bytes).toBe(Buffer.byteLength(STABLE_CONTENT, "utf8"));
    expect(Number.isNaN(Date.parse(entry.promoted_at))).toBe(false);
    expect(entry.reproduce.command).toEqual(STABLE_COMMAND);

    // artifacts 出现且字节与源一致，sha256 与文件字节吻合
    const artifactBytes = await readFile(join(ws.artifactsDir, "analysis.md"));
    expect(artifactBytes.toString("utf8")).toBe(STABLE_CONTENT);
    expect(sha256Hex(artifactBytes)).toBe(entry.sha256);

    // catalog.json 登记在案（owner 口径 #6：JSON 清单承载）
    const catalog = JSON.parse(await readFile(join(ws.artifactsDir, "catalog.json"), "utf8")) as {
      schema_version: number;
      artifacts: { artifact_id: string; sha256: string }[];
    };
    expect(catalog.schema_version).toBe(0);
    expect(catalog.artifacts).toHaveLength(1);
    expect(catalog.artifacts[0]?.artifact_id).toBe("analysis.md");
    expect(catalog.artifacts[0]?.sha256).toBe(entry.sha256);

    // 二次 promote 同源 → 幂等拒绝，已有 Artifact 不覆盖
    const bytesBefore = await readFile(join(ws.artifactsDir, "analysis.md"));
    const replay = await promoteArtifact(ws, "analysis.md");
    expect(replay.ok).toBe(true);
    if (replay.ok && replay.value.kind === "blocked") {
      expect(replay.value.block.reason).toBe("already_promoted");
      expect(replay.value.block.source).toBe("analysis.md");
    }
    const catalogAfter = JSON.parse(await readFile(join(ws.artifactsDir, "catalog.json"), "utf8")) as {
      artifacts: unknown[];
    };
    expect(catalogAfter.artifacts).toHaveLength(1);
    await expect(readFile(join(ws.artifactsDir, "analysis.md"))).resolves.toEqual(bytesBefore);
  });

  it("嵌套路径产物：scratch 子目录产物晋升后保持相对布局", async () => {
    const ws = await makeWorkspace();
    await ws.scratchWrite("reports/deep/note.md", STABLE_CONTENT);
    await ws.registerReproduce("reports/deep/note.md", STABLE_COMMAND);

    const outcome = await promoteArtifact(ws, "reports/deep/note.md");
    expect(outcome.ok && outcome.value.kind === "promoted").toBe(true);
    await expect(readFile(join(ws.artifactsDir, "reports/deep/note.md"), "utf8")).resolves.toBe(STABLE_CONTENT);
  });
});

describe("S4 验收（复现反例）——产物内容在两次执行间变化 → 可复现校验失败 → block", () => {
  it("复现输出 hash 不一致 → blocked(not_reproducible)，artifacts 与 catalog 零写入", async () => {
    const ws = await makeWorkspace();
    const flaky = `波动内容:${String(Math.random())}\n`;
    await ws.scratchWrite("flaky.md", flaky);
    await ws.registerReproduce("flaky.md", ["node", "-e", "process.stdout.write('波动内容:' + Math.random() + '\\n')"]);

    const outcome = await promoteArtifact(ws, "flaky.md");
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.value.kind === "blocked") {
      expect(outcome.value.block.reason).toBe("not_reproducible");
      expect(outcome.value.block.detail).toMatchObject({ expected_sha256: expect.any(String), actual_sha256: expect.any(String) });
    }
    // 负例不留痕：catalog 无登记、artifacts 无文件
    const status = await ws.status();
    expect(status.ok && status.value.artifacts.catalog_count === 0 && status.value.artifacts.file_count === 0).toBe(true);
  });

  it("复现命令退出码非 0 → blocked(not_reproducible)（闸门裁决）；spawn 失败 → err(reproduce_failure)（基础设施故障，不猜测）", async () => {
    const ws = await makeWorkspace();

    await ws.scratchWrite("crash.md", STABLE_CONTENT);
    await ws.registerReproduce("crash.md", ["node", "-e", "process.stderr.write('boom'); process.exit(3)"]);
    const crashed = await promoteArtifact(ws, "crash.md");
    expect(crashed.ok && crashed.value.kind === "blocked" && crashed.value.block.reason === "not_reproducible").toBe(true);
    if (crashed.ok && crashed.value.kind === "blocked") {
      expect((crashed.value.block.detail as { exit_code?: number }).exit_code).toBe(3);
    }

    await ws.scratchWrite("ghost-cmd.md", STABLE_CONTENT);
    await ws.registerReproduce("ghost-cmd.md", ["definitely-not-a-binary-xyz"]);
    const infra = await promoteArtifact(ws, "ghost-cmd.md");
    expect(infra.ok).toBe(false);
    if (!infra.ok) expect(infra.error.code).toBe("reproduce_failure");
  });

  it("复现命令超时 → err(reproduce_failure)（可注入超时覆盖，不猜测可复现性）", async () => {
    const ws = await makeWorkspace();
    await ws.scratchWrite("slow.md", STABLE_CONTENT);
    await ws.registerReproduce("slow.md", ["node", "-e", "setTimeout(() => {}, 60_000)"]);

    const outcome = await promoteArtifact(ws, "slow.md", { timeoutMs: 200 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("reproduce_failure");
  });
});

describe("S4 补充语义——一致性 fail-closed 与输入守卫", () => {
  it("catalog 已登记但产物文件被删 → err(corrupt_catalog)（登记/文件失配）", async () => {
    const ws = await makeWorkspace();
    await registerStableArtifact(ws);
    const first = await promoteArtifact(ws, "analysis.md");
    expect(first.ok && first.value.kind === "promoted").toBe(true);

    await rm(join(ws.artifactsDir, "analysis.md"));
    const outcome = await promoteArtifact(ws, "analysis.md");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("corrupt_catalog");
  });

  it("artifacts/ 存在未登记同名文件 → err(corrupt_catalog)（不覆盖不吸收）", async () => {
    const ws = await makeWorkspace();
    await writeFile(join(ws.artifactsDir, "ghost.md"), "来路不明的内容\n");
    await ws.scratchWrite("ghost.md", STABLE_CONTENT);
    await ws.registerReproduce("ghost.md", STABLE_COMMAND);

    const outcome = await promoteArtifact(ws, "ghost.md");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("corrupt_catalog");
  });

  it("元数据缺失 / 元数据与源不符 / 路径越界 → err(invalid_input)", async () => {
    const ws = await makeWorkspace();

    await ws.scratchWrite("unregistered.md", STABLE_CONTENT);
    const noMeta = await promoteArtifact(ws, "unregistered.md");
    expect(noMeta.ok).toBe(false);
    if (!noMeta.ok) expect(noMeta.error.code).toBe("invalid_input");

    await ws.scratchWrite("swapped.md", STABLE_CONTENT);
    // 手写一份与源不符的 sidecar（模拟元数据被篡改）：artifact 字段指向别的产物
    await writeFile(
      join(ws.scratchDir, "swapped.md.meta.json"),
      JSON.stringify({ artifact: "other.md", reproduce: { command: STABLE_COMMAND }, registered_at: "2026-09-09T00:00:00Z" }, null, 2),
      "utf8",
    );
    const swapped = await promoteArtifact(ws, "swapped.md");
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.error.code).toBe("invalid_input");

    const escape = await promoteArtifact(ws, "../escape.md");
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error.code).toBe("invalid_input");
  });
});
