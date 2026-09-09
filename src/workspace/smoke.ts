/**
 * S4 手工冒烟命令（任务书：每个 slice 一条手工冒烟命令）。
 *
 * 全流程演示（不触内核、不触网络）：run 目录结构 v0 + provenance 四元组 →
 * T0 产物 + 复现命令登记 → 晋升闸 A（promoted + sha 登记）→ 幂等拒绝 →
 * 不可复现拒绝 → 铁律一（scratch 引用拒绝 / 合法引用放行）→ T2 只读状态。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:s4
 *
 * 退出码：全部通过 = 0；任一步失败 = 1。
 */
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockDigestResolver } from "../session/index.js";
import {
  GuardedSessionLog,
  RunWorkspace,
  promoteArtifact,
  sha256Hex,
  T0_REF_FORBIDDEN,
  type WorkspaceStatus,
} from "./index.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const runDir = join(repoRoot, "tmp", "runs", "smoke-s4");

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = "a".repeat(64);

let failed = false;
const step = (label: string, pass: boolean, detail?: string): void => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failed = true;
};

const ANALYSIS_CONTENT = "S4 冒烟分析产物：确定性输出（字节级可复现）\n";
const REPRODUCE_COMMAND = ["node", "-e", `process.stdout.write(${JSON.stringify(ANALYSIS_CONTENT)})`];

const smoke = async (): Promise<void> => {
  console.log(`[1] 清理并创建 run 工作区: ${runDir}`);
  await rm(runDir, { recursive: true, force: true });
  const created = await RunWorkspace.create(runDir, {
    run_id: "smoke-s4",
    trigger_instruction: "S4 手工冒烟：三层工作区与晋升闸 A",
    model_id: "faux", // owner 口径 #2：冒烟阶段 model_id = "faux"
  });
  step("run 目录结构 v0 + provenance 四元组", created.ok);
  if (!created.ok) {
    console.error(JSON.stringify(created.error, null, 2));
    process.exitCode = 1;
    return;
  }
  const ws = created.value;
  const provenance = JSON.parse(await readFile(join(ws.scratchDir, "provenance.json"), "utf8")) as Record<string, unknown>;
  step(
    "provenance.json 四元组（model_id=faux）",
    provenance["run_id"] === "smoke-s4" &&
      provenance["model_id"] === "faux" &&
      typeof provenance["trigger_instruction"] === "string" &&
      typeof provenance["created_at"] === "string",
  );

  console.log("[2] T0 产物 + 复现命令登记 → 晋升闸 A");
  const written = await ws.scratchWrite("analysis.md", ANALYSIS_CONTENT);
  step("scratch 写入", written.ok);
  const registered = await ws.registerReproduce("analysis.md", REPRODUCE_COMMAND);
  step("复现命令登记于产物元数据", registered.ok);
  const promoted = await promoteArtifact(ws, "analysis.md");
  const promotedOk =
    promoted.ok && promoted.value.kind === "promoted" && HEX64.test(promoted.value.artifact.sha256);
  step(
    "promote → promoted + sha256 登记",
    promotedOk,
    promoted.ok && promoted.value.kind === "promoted"
      ? `sha256=${promoted.value.artifact.sha256.slice(0, 12)}…`
      : JSON.stringify(promoted),
  );
  if (promoted.ok && promoted.value.kind === "promoted") {
    const artifactBytes = await readFile(join(ws.artifactsDir, "analysis.md"));
    step(
      "artifacts/analysis.md 字节与源一致且 catalog 已登记",
      sha256Hex(artifactBytes) === promoted.value.artifact.sha256,
    );
  }

  console.log("[3] 二次 promote 同源 → 幂等拒绝（已有 Artifact 不覆盖）");
  const replay = await promoteArtifact(ws, "analysis.md");
  step(
    "二次 promote → blocked(already_promoted)",
    replay.ok && replay.value.kind === "blocked" && replay.value.block.reason === "already_promoted",
  );

  console.log("[4] 不可复现产物 → 可复现闸拒绝");
  const flakyContent = `nondeterministic:${String(Date.now())}\n`;
  await ws.scratchWrite("flaky.md", flakyContent);
  await ws.registerReproduce("flaky.md", ["node", "-e", "process.stdout.write('nondeterministic:' + Date.now() + '\\n')"]);
  const flaky = await promoteArtifact(ws, "flaky.md");
  step(
    "flaky.md → blocked(not_reproducible)",
    flaky.ok && flaky.value.kind === "blocked" && flaky.value.block.reason === "not_reproducible",
  );

  console.log("[5] 铁律一：scratch 引用拒绝（GuardedSessionLog 包装 S2 会话校验入口）");
  const inner = MockDigestResolver.withDigests([
    { journal_type: "run_journal", fact_id: "fact-ds-001", sha256_digest: DIGEST },
  ]);
  const guarded = await GuardedSessionLog.create(ws.sessionLogPath, inner, ws.scratchDir);
  step("GuardedSessionLog 挂载", guarded.ok);
  if (!guarded.ok) {
    process.exitCode = 1;
    return;
  }
  const session = guarded.value;
  const t0Attempt = await session.append({
    type: "tool/result",
    payload: { summary: "试图引用 T0 产物作为证据" },
    domain_refs: [{ journal_type: "workspace_artifact", fact_id: "scratch/analysis.md", sha256_digest: DIGEST }],
  });
  step(
    "scratch 引用 → rejected(t0_ref_forbidden)，事件不落盘",
    t0Attempt.ok && t0Attempt.value.status === "rejected" && t0Attempt.value.block.reason === T0_REF_FORBIDDEN,
  );
  const legit = await session.append({
    type: "tool/result",
    payload: { summary: "引用已晋升的领域事实" },
    domain_refs: [{ journal_type: "run_journal", fact_id: "fact-ds-001", sha256_digest: DIGEST }],
  });
  step("合法引用 → 正常落盘（S2 语义零改动）", legit.ok && legit.value.status === "appended");

  console.log("[6] 工作区状态（T2 contracts 只读展示）");
  const status = await ws.status();
  if (status.ok) {
    const s: WorkspaceStatus = status.value;
    step(
      "status：scratch=5 / artifacts catalog=1 file=1 / contracts 只读存在 / session_log 存在",
      s.run_id === "smoke-s4" &&
        s.scratch.entry_count === 5 && // provenance + analysis.md + flaky.md + 两个 .meta.json
        s.artifacts.catalog_count === 1 &&
        s.artifacts.file_count === 1 && // file_count 不含 catalog.json（登记簿非产物）
        s.contracts.exists &&
        s.session_log.exists,
      JSON.stringify(s),
    );
  } else {
    step("status 查询", false, JSON.stringify(status.error));
  }

  if (failed) process.exitCode = 1;
  else console.log("S4 冒烟通过 ✓");
};

await smoke();
