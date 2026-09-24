/**
 * 门 1a spike（批 P）——headless 演示入口（丙 v1 headless CLI 的占位骨架）。
 *
 * 用法：
 *   node dist/agent/main.js                        # mock 对端（缺省，零外部依赖）
 *   node dist/agent/main.js --peer real [--ws-root <path>]
 *                                                  # pin 副本真内核（ATF_CLI_PATH 或
 *                                                  # <repo>/.atf-pinned；隔离 HOME；
 *                                                  # ws-root 缺省 = /tmp 临时工作区）
 *
 * 红线：模型循环恒为 faux streamFn（零真实 Provider 调用）；真内核模式下
 * atf_workspace_status / ledger_* 经真 stdio JSONL 桥。进程退出码：0 = 全部检查过；
 * 1 = 任一检查未过（演示进程不做 78 映射——那是 runner headless 的 run 级语义锚，
 * 丙线的 exit code 纪律在门 2 定型）。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AtfBridgeConnection } from "../bridge/connection.js";
import { deriveAtfCommand } from "../bridge/atfCommand.js";
import { runGate1aSpike } from "./spike.js";
import { runGate1bPoc } from "./tem/poc.js";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const temPoc = args.includes("--tem-poc");
  const peerReal = args.includes("--peer") && args[args.indexOf("--peer") + 1] === "real";
  const wsRootIndex = args.indexOf("--ws-root");
  const wsRoot = wsRootIndex >= 0 ? args[wsRootIndex + 1] : undefined;

  let spawnDescriptor: { argv: string[]; cwd: string; env: Record<string, string> };
  let sessionsRoot: string;
  let bindRunId: string | undefined;
  if (peerReal) {
    const envKernel = process.env["ATF_CLI_PATH"]?.trim();
    const kernelDir = envKernel !== undefined && envKernel !== "" ? envKernel : join(repoRoot, ".atf-pinned");
    const home = await mkdtemp(join(tmpdir(), "atf-spike-home-"));
    const wsRootResolved = wsRoot ?? (await mkdtemp(join(tmpdir(), "atf-spike-ws-")));
    // 预置（TUI 真对端同序）：atf init（幂等）→ 建 run 骨架目录（内核 run 存在性 =
    // <ws>/runs/<run_id> 目录，fail-closed 不猜测）→ serve 后 bind_run。
    const initInvocation = deriveAtfCommand(kernelDir, ["init", "--workspace-root", wsRootResolved]);
    await execFileAsync(initInvocation.command, initInvocation.args, {
      cwd: initInvocation.cwd,
      env: { ...process.env, ...initInvocation.env, HOME: home, ATF_WORKSPACE_ROOT: wsRootResolved },
    });
    bindRunId = `spike-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await mkdir(join(wsRootResolved, "runs", bindRunId), { recursive: true });
    const invocation = deriveAtfCommand(kernelDir, ["serve"]);
    spawnDescriptor = {
      argv: [invocation.command, ...invocation.args],
      cwd: invocation.cwd,
      env: { ...invocation.env, HOME: home, ATF_WORKSPACE_ROOT: wsRootResolved },
    };
    sessionsRoot = await mkdtemp(join(tmpdir(), "atf-spike-sessions-"));
    console.log(`[spike] 对端=real（pin 副本 ${kernelDir}；run=${bindRunId}）；session 根=${sessionsRoot}`);
  } else {
    const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
    spawnDescriptor = { argv: ["node", mockPath], cwd: repoRoot, env: {} };
    sessionsRoot = await mkdtemp(join(tmpdir(), "atf-spike-sessions-"));
    console.log(`[spike] 对端=mock（${mockPath}）；session 根=${sessionsRoot}`);
  }

  const spawned = await AtfBridgeConnection.spawn({
    command: spawnDescriptor.argv,
    cwd: spawnDescriptor.cwd,
    env: spawnDescriptor.env,
  });
  if (!spawned.ok) {
    console.error(`[spike] 桥接 spawn/握手失败: ${spawned.error.message}`);
    return 1;
  }
  const bridge = spawned.value;
  console.log(`[spike] 握手成功：kernel ${bridge.version?.version}（contract_version=${String(bridge.version?.contract_version)}）`);

  if (bindRunId !== undefined) {
    const bound = await bridge.request("atf.bind_run", { run_id: bindRunId });
    if (!bound.ok) {
      console.error(`[spike] bind_run 失败（fail-closed）: ${bound.error.message}`);
      await bridge.close({ timeoutMs: 5_000 }).catch(() => undefined);
      return 1;
    }
    console.log(`[spike] 会话已绑定 run=${bindRunId}`);
  }

  try {
    if (temPoc) {
      const poc = await runGate1bPoc({ bridge, sessionsRoot });
      console.log("\n[tem-poc] 门 1b 检索注入 PoC：");
      console.log(`  run A EvidenceEvent 镜像数 = ${String(poc.run_a_evidence_count)}`);
      console.log(`  run A ExperienceCase 落库 = ${poc.run_a_case !== undefined ? `✅（${poc.run_a_case.case_id}，证据 ${String(poc.run_a_case.evidence_event_ids.length)} 条）` : "❌"}`);
      console.log(`  PatternClaim 写入 = ${poc.claim_written ? "✅" : "❌"}`);
      console.log(`  run B 注入 section 到达 provider 请求面 = ${poc.run_b_injected_section !== null ? "✅" : "❌"}`);
      if (poc.run_b_injected_section !== null) console.log(`\n  ---- 注入内容 ----\n${poc.run_b_injected_section}\n  ----`);
      console.log(`  run B 事件数 = ${String(poc.run_b_events)}`);
      console.log(`\n[tem-poc] ${poc.all_passed ? "门 1b PoC 全部走通" : "存在未过检查（见上）"}`);
      return poc.all_passed ? 0 : 1;
    }
    const result = await runGate1aSpike({ bridge, sessionsRoot });
    console.log("\n[spike] 场景检查：");
    let allPassed = true;
    for (const [name, value] of Object.entries(result.checks)) {
      const passed = checksPass(name, value);
      allPassed &&= passed;
      console.log(`  ${passed ? "✅" : "❌"} ${name} = ${JSON.stringify(value)}`);
    }
    console.log("\n[spike] 审批闸审计：");
    for (const entry of result.approvalAudit) {
      console.log(`  ${entry.tool} → ${entry.verdict}${entry.detail !== undefined ? ` (${JSON.stringify(entry.detail)})` : ""}`);
    }
    console.log(`\n[spike] ${allPassed ? "门 1a 最小链全部走通" : "存在未过检查（见上）"}`);
    return allPassed ? 0 : 1;
  } finally {
    await bridge.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
};

const POSITIVE_CHECKS = new Set([
  "scenario_d_orphan_detected",
  "scenario_d_continue_refusal",
]);

const checksPass = (name: string, value: unknown): boolean => {
  if (name.startsWith("scenario_a_three_decisions") && typeof value === "object" && value !== null) {
    return Object.values(value).every((entry) => entry === true);
  }
  if (name === "scenario_e_resumed_final" || name === "scenario_d_continue_refusal") return typeof value === "string" && value !== "";
  if (name === "scenario_e_recovered_tail_role") return value === "user";
  if (name === "scenario_e_resumed_events") return typeof value === "number" && value > 0;
  if (name === "scenario_e_recovered_transcript_roles") return Array.isArray(value) && value.length > 0;
  if (POSITIVE_CHECKS.has(name)) {
    if (typeof value === "boolean") return value === true;
    if (typeof value === "object" && value !== null) return "orphan" in value && (value as { orphan?: boolean }).orphan === true;
  }
  return value === true;
};

process.exitCode = await main();
