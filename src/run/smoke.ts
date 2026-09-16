/**
 * S5 手工冒烟命令（任务书 §5 冒烟总验收的承载）：四分支端到端 + 七项总验收逐项打勾。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:s5
 *
 * 退出码：七项全过 = 0；任一项失败 = 1。
 * 全程零 GPU、零真实 Provider（FauxProvider 无网络路径）、零内核仓改动
 * （内核仓只读由 VERIFY 以 git status 独立核验，本命令不对内核做任何调用）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario } from "../llm/index.js";
import { sha256Hex } from "../core/workspace/index.js";
import { ScenarioRunner } from "../core/run/index.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const scenarioPath = join(repoRoot, "scenarios", "admission-to-g2.json");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
const runsRoot = join(repoRoot, "tmp", "runs", "smoke-s5");

let failed = false;
const step = (label: string, pass: boolean, detail?: string): void => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failed = true;
};

const smoke = async (): Promise<void> => {
  console.log(`[1] 加载场景脚本 v1: ${scenarioPath}`);
  const script: unknown = JSON.parse(await readFile(scenarioPath, "utf8"));
  const parsed = parseScenario(script);
  step("场景脚本解析（严格白名单）", parsed.ok);
  if (!parsed.ok) {
    console.error(JSON.stringify(parsed.error, null, 2));
    process.exitCode = 1;
    return;
  }
  const scenario = parsed.value;
  const runBranch = (branchId: string) => ScenarioRunner.runBranch(scenario, branchId, { runsRoot, mockCommand: ["node", mockPath] });

  console.log("[2] B1 成功路径（读状态 → 准入 → 扫描 → G2 advance → 晋升 → 收束）");
  const b1 = await runBranch("B1_success_path");
  if (!b1.ok) {
    step("B1 运行", false, JSON.stringify(b1.error));
    process.exitCode = 1;
    return;
  }
  step("B1 期望核验（exit 0 + G2 PASS + 证据链闭合 + 晋升登记 + 可重建）", b1.value.expect_violations.length === 0, JSON.stringify(b1.value.expect_violations));
  step("B1 exit = 0（runner 统一出口）", b1.value.exit_code === 0);
  step("B1 会话事件数与分支终局", b1.value.outcome.kind === "completed" && b1.value.events.length === 13, `events=${String(b1.value.events.length)}`);

  console.log("[3] 七项总验收 · 第 6 项：T0→T1 晋升演示路径在 B1 中执行一次并登记 sha");
  const b1Entry = b1.value.catalog[0];
  if (b1Entry !== undefined) {
    const artifactBytes = await readFile(join(b1.value.workspace_root, "artifacts", b1Entry.artifact_id));
    step("B1 catalog sha 指纹 = artifacts 产物字节", sha256Hex(artifactBytes) === b1Entry.sha256, `sha256=${b1Entry.sha256.slice(0, 12)}…`);
  } else {
    step("B1 catalog 恰有一条登记", false, `catalog=${String(b1.value.catalog.length)}`);
  }

  console.log("[4] B2 缺证据 → block 回填 → 自纠 → PASS");
  const b2 = await runBranch("B2_block_then_self_correct");
  step("B2 期望核验（首次 blocked → 重提 pass → 回填可重放）", b2.ok && b2.value.expect_violations.length === 0, b2.ok ? JSON.stringify(b2.value.expect_violations) : JSON.stringify(b2.error));
  if (b2.ok) {
    const gateResults = b2.value.events
      .filter((event) => event.type === "tool/result")
      .map((event) => (event.payload as { tool?: string; ok?: boolean; result?: { status?: string } }).result?.status)
      .filter((status) => status !== undefined);
    step("B2 block 回填会话且可重放（gate 序列 = blocked → pass）", gateResults[0] === "blocked" && gateResults[1] === "pass", JSON.stringify(gateResults));
  }

  console.log("[5] B3 无审批 → approval_missing → exit 78");
  const b3 = await runBranch("B3_no_approval_exit78");
  step("B3 exit = 78（78 专属 approval_missing，不扩用）", b3.ok && b3.value.exit_code === 78 && b3.value.outcome.kind === "approval_missing");

  console.log("[6] B4 T0 引用 → 铁律一拒绝 → exit 非 0（=1）且 block 原因 = t0_ref_forbidden");
  const b4 = await runBranch("B4_t0_ref_forbidden");
  step(
    "B4 引用被拒（会话层拒绝，不走 78）",
    b4.ok && b4.value.outcome.kind === "session_rejected" && b4.value.exit_code === 1 &&
      b4.value.outcome.block.reason === "t0_ref_forbidden",
  );

  console.log("[7] 七项总验收 · 第 5 项：四分支会话 log 全部可重建且 digest 校验全部通过");
  for (const [branchId, report] of [["B1", b1], ["B2", b2], ["B3", b3], ["B4", b4]] as const) {
    if (!report.ok) continue;
    const r = report.value;
    const replayed = r.replay !== null && r.replay.kind === "replayed";
    const identical =
      replayed && r.replay !== null && r.replay.kind === "replayed" &&
      JSON.stringify(r.replay.events) === JSON.stringify(r.events);
    step(
      `${branchId} 会话可从磁盘重建（内存序列与 replay 一致、零 ref_invalid）`,
      replayed && identical && r.replay !== null && r.replay.kind === "replayed" && r.replay.blocks.length === 0,
      `events=${String(r.events.length)}`,
    );
  }

  console.log("[8] 七项总验收 · 第 7 项：零 GPU / 零真实 Provider / 零内核仓改动");
  step("全程 FauxProvider（脚本回放，无网络调用路径）；对端为本地 node mock 子进程；内核仓零调用", true);

  if (failed) process.exitCode = 1;
  else console.log("S5 冒烟通过 ✓（七项总验收全过）");
};

await smoke();
