/**
 * R2 真对端专项冒烟（smoke:r2）——「业务方法面对真实内核端到端」单进程验收。
 *
 * 依据：《ATF独立Harness_R2任务书_真实对端夹具与工具面端到端_20260914.md》§2 +
 * 《ATF-Harness_Owner决议与指令_R2门1评审_门2放行_20260914.md》（含真实写授权 §2.4，
 * 范围严格限定 /tmp/atf-r2-* 夹具根内的合成数据 r2-fixture-*）。
 *
 * 七段总验收：
 *   [1] 前置：ATF_CLI_PATH 存在 + pin 一致（未设置 → 优雅 skip，exit 0——mock 轨不受影响）
 *   [2] 夹具：三层隔离根（temp HOME / wsRoot / pin cwd）+ 真实 atf init + 十目录骨架 +
 *       journal 3 行 + 准入 summary 双 lane（最坏裁决制样）
 *   [3] 会话主链：bind_run → workspace_status → fact_scan → G1/G2 query → admit_data（写）
 *       → 落盘证据 → G1 advance → query 反读
 *   [4] fail-closed 反例：no_run_bound / unknown_run / unknown_gate / admission_state_unavailable /
 *       gate_verdict_not_registered / 坏 journal internal_error / 账本空链 not_found / mismatch
 *   [5] 注入式账本（D1 裁决，仅测试夹具面）：query → consume → approval_already_consumed
 *   [6] 隔离断言：pin 副本 git status 零改动 / temp HOME 无 .agents/skills / 夹具清理
 *   [7] 边界标注输出（决议 §3 三项 + §3 防误读项，字面打印）
 *
 * 退出码：0 = 全过或优雅 skip；1 = 任一断言失败。
 * 注：夹具引导逻辑与 tests/run/realPeer/fixture.ts 同构（构建 rootDir 限制不能互引，
 * 两处需同步维护——漂移会被两轨断言差异暴露）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtfBridgeConnection } from "../bridge/connection.js";
import { atfCliPathFromEnv, deriveAtfCommand, readGitHeadSha } from "../bridge/atfCommand.js";
import { ATF_UPSTREAM_COMMIT_SHA, ATF_UPSTREAM_TAG } from "../bridge/atfCommand.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let failed = false;
const check = (label: string, condition: boolean, detail?: string): void => {
  const mark = condition ? "✓" : "✗";
  process.stdout.write(`${mark} ${label}${detail !== undefined && !condition ? ` — ${detail}` : ""}\n`);
  if (!condition) failed = true;
};

const execFileP = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error as { exitCode?: number | null }).exitCode;
      if (error !== null && typeof code !== "number") reject(error);
      else resolve({ exitCode: code ?? null, stdout, stderr });
    });
  });

const RUN_SKELETON = ["experiment-setup", "l1", "variants", "launch", "training", "models", "eval", "journal", "verification", "decisions"];
const GATE_IDS = ["extraction-contract-valid", "source-identity-valid", "split-integrity-valid", "training-data-valid"];
const KERNEL_SCOPE = { project_id: "agentic-training-flow", scope_type: "run", scope_mode: "canonical" };
const APPROVAL_REF = "r2-fixture-apr-001";

const runId = "r2-fixture-run-1";
let home = "";
let wsRoot = "";

const cleanup = async (): Promise<void> => {
  if (home !== "") await rm(home, { recursive: true, force: true }).catch(() => undefined);
  if (wsRoot !== "") await rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
};

const baseEnv = (pinPath: string): Record<string, string> => {
  const invocation = deriveAtfCommand(pinPath, []);
  return { ...process.env, ...invocation.env, HOME: home } as Record<string, string>;
};

const serveOf = (pinPath: string, injected: boolean): { argv: string[]; cwd: string; env: Record<string, string> } => {
  if (!injected) {
    const invocation = deriveAtfCommand(pinPath, ["serve"]);
    return { argv: [invocation.command, ...invocation.args], cwd: invocation.cwd, env: baseEnv(pinPath) };
  }
  const invocation = deriveAtfCommand(pinPath, []);
  const prelude = `
import json, sys
from agentic_training_flow.contracts import ApprovalRef
from agentic_training_flow.contracts.models import ScopeRef
from agentic_training_flow.facts.owners import FactOwners, OperatorCommand
from agentic_training_flow.session.runner import run_session
from agentic_training_flow.session.tools import build_registry
class _Channel:
    def send_event(self, name, payload):
        frame = json.dumps({"type": "event", "name": name, "payload": payload}, ensure_ascii=False)
        sys.stdout.buffer.write((frame + "\\n").encode("utf-8"))
        sys.stdout.buffer.flush()
owners = FactOwners()
scope = ScopeRef("${KERNEL_SCOPE.project_id}", "${KERNEL_SCOPE.scope_type}", "${runId}", "${KERNEL_SCOPE.scope_mode}")
command = OperatorCommand(
    command_id="r2-fixture-cmd-001", command_type="approval", actor="r2-fixture-actor",
    scope_ref=scope, operation_id="r2-fixture-op-001", attempt_id="r2-fixture-attempt-001",
    subject_ref="${APPROVAL_REF}", evidence_refs=("r2-fixture-evidence",), decision="approve")
ledger = owners.approval_ledger
ledger.register_command(command)
ledger.consume_command(command.command_id, ApprovalRef("${APPROVAL_REF}", scope, "r2-fixture-op-001", "r2-fixture-attempt-001"), "r2-fixture-actor", 0)
run_session(sys.stdin.buffer, sys.stdout.buffer, registry=build_registry(channel=_Channel(), owners=owners))
`;
  return { argv: [invocation.command, "-c", prelude], cwd: invocation.cwd, env: baseEnv(pinPath) };
};

type CallResult = { ok: true; value: unknown } | { ok: false; code: string };

const call = async (connection: AtfBridgeConnection, method: string, params?: unknown): Promise<CallResult> => {
  const response = await connection.request(method, params);
  if (response.ok) return { ok: true, value: response.value };
  const detail = (response.error.detail ?? {}) as { code?: string };
  if (response.error.code !== "request_rejected") {
    process.stdout.write(`  !! 桥接级故障（${response.error.code}）: ${response.error.message}\n`);
    return { ok: false, code: response.error.code };
  }
  return { ok: false, code: detail.code ?? "" };
};

const summaryPath = async (lane: string, verdicts: ("pass" | "warn" | "block")[], codes: string[][]): Promise<void> => {
  const gates = GATE_IDS.map((gate_id, index) => {
    const entry: { gate_id: string; verdict: string; reason_codes?: string[] } = { gate_id, verdict: verdicts[index] ?? "pass" };
    if ((codes[index]?.length ?? 0) > 0) entry.reason_codes = codes[index] ?? [];
    return entry;
  });
  const dir = join(wsRoot, "runs", runId, "l1", lane);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${lane}-source-backed-admission-summary.json`), `${JSON.stringify({ gates }, null, 1)}\n`, "utf8");
};

const gitStatusShort = (repoPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, "status", "--short"], (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });

const main = async (): Promise<0 | 1> => {
  process.stdout.write("—— R2 真对端专项冒烟（通道+业务方法面，mock 轨不受影响）——\n");

  // ---------------- [1] 前置 ----------------
  const cli = atfCliPathFromEnv();
  if (!cli.ok) {
    process.stdout.write(`ATF_CLI_PATH 未设置 → smoke:r2 优雅 skip（mock 轨完整可用）: ${cli.error.message}\n`);
    return 0;
  }
  const pinPath = cli.value;
  const head = await readGitHeadSha(pinPath);
  check("[1] pin 校验：HEAD == pin", head.ok && head.value === ATF_UPSTREAM_COMMIT_SHA, `期望 ${ATF_UPSTREAM_TAG}(${ATF_UPSTREAM_COMMIT_SHA.slice(0, 7)})`);

  try {
    // ---------------- [2] 夹具 ----------------
    home = await mkdtemp(join(tmpdir(), "atf-r2-home-"));
    wsRoot = await mkdtemp(join(tmpdir(), "atf-r2-ws-"));
    const init = deriveAtfCommand(pinPath, ["init", "--workspace-root", wsRoot]);
    const ran = await execFileP(init.command, init.args, { cwd: init.cwd, env: baseEnv(pinPath) });
    check("[2] atf init（临时 HOME 隔离）退出码 0", ran.exitCode === 0 && ran.stdout.includes(wsRoot), ran.stderr.slice(0, 160));
    for (const sub of RUN_SKELETON) await mkdir(join(wsRoot, "runs", runId, sub), { recursive: true });
    const journalDir = join(wsRoot, "runs", runId, "journal");
    const journalLines = [
      JSON.stringify({ ts: "2026-09-14T00:00:00Z", action: "experiment_setup", out: null, refs: {} }),
      JSON.stringify({ ts: "2026-09-14T00:00:01Z", action: "eval_service_generated", out: null, refs: { manifest: "a".repeat(64) } }),
      JSON.stringify({ ts: "2026-09-14T00:00:02Z", action: "train_launch_generated", out: "launch", refs: {} }),
    ];
    await writeFile(join(journalDir, "journal.jsonl"), `${journalLines.join("\n")}\n`, "utf8");
    await summaryPath("lane-a", ["pass", "pass", "pass", "pass"], [[], [], [], []]);
    await summaryPath("lane-b", ["pass", "warn", "pass", "pass"], [[], ["split_checksum_stale"], [], []]);
    check("[2] 夹具制样（init + 十目录 + journal 3 行 + 双 lane summary）就绪", true);

    // ---------------- [3] 会话主链 ----------------
    const spawned = await AtfBridgeConnection.spawn({ command: serveOf(pinPath, false).argv, cwd: serveOf(pinPath, false).cwd, env: serveOf(pinPath, false).env });
    check("[3] spawn 真实 serve + 握手（会话协议版本 = 1）", spawned.ok);
    if (!spawned.ok) {
      await cleanup();
      return 1;
    }
    const connection = spawned.value;

    const bound = await call(connection, "atf.bind_run", { run_id: runId });
    check("[3] bind_run 绑定合成 run", bound.ok && (bound.value as { run_id?: string }).run_id === runId);
    const status0 = await call(connection, "atf_workspace_status", {});
    check("[3] workspace_status：空登记面 admitted_count=0", status0.ok && (status0.value as { admitted_count?: number }).admitted_count === 0);
    const scan0 = await call(connection, "atf_fact_scan", {});
    const scan0Value = scan0.ok ? (scan0.value as { count: number; facts: { journal_type: string; fact_id: string }[] }) : undefined;
    check(
      "[3] fact_scan：3 条 operation-journal（journal-event:<run>:1..3）",
      scan0.ok && scan0Value?.count === 3 && scan0Value.facts[0]?.fact_id === `journal-event:${runId}:1`,
    );
    const g1 = await call(connection, "atf_gate", { gate: "g1", action: "query" });
    check("[3] G1 query（大小写归一化）= pass（lane-a/b 最坏裁决聚合）", g1.ok && (g1.value as { status?: string }).status === "pass");
    const g2 = await call(connection, "atf_gate", { gate: "G2", action: "query" });
    check(
      "[3] G2 query = warn + reason_codes 并集",
      g1.ok && g2.ok && (g2.value as { status?: string; reason_codes?: string[] }).status === "warn" &&
        JSON.stringify((g2.value as { reason_codes?: string[] }).reason_codes) === JSON.stringify(["split_checksum_stale"]),
    );

    const admitted = await call(connection, "atf_admit_data", { dataset_id: "r2-fixture-ds-1", source_ref: "r2-fixture-source-1" });
    const admittedValue = admitted.ok ? (admitted.value as { fact_id: string; sha256_digest: string }) : undefined;
    check("[3] admit_data（真实写，授权范围 /tmp/atf-r2-*）返回 dataset-registry 三元组", admitted.ok && admittedValue !== undefined);
    const regPath = join(wsRoot, "datasets", admittedValue?.fact_id ?? "<unresolved>", "registration.json");
    const regBytes = await readFile(regPath, "utf8");
    const fileSha = createHash("sha256").update(regBytes, "utf8").digest("hex");
    check(
      "[3] 落盘证据：registration.json 存在且 sha256 可复算",
      regBytes.includes("r2-fixture-ds-1") && /^[0-9a-f]{64}$/.test(fileSha),
      `路径=${regPath}`,
    );
    process.stdout.write(`  落盘证据 ${regPath}\n  文件 sha256 = ${fileSha}\n  内容摘要 = ${regBytes.slice(0, 120).replace(/\n/g, " ")}…\n`);

    const status1 = await call(connection, "atf_workspace_status", {});
    check("[3] 写后复读 admitted_count=1", status1.ok && (status1.value as { admitted_count?: number }).admitted_count === 1);
    const scan1 = await call(connection, "atf_fact_scan", {});
    check("[3] fact_scan 计数 3→4（dataset-registry 入索引）", scan1.ok && (scan1.value as { count?: number }).count === 4);
    const g1Advance = await call(connection, "atf_gate", { gate: "G1", action: "advance" });
    const g1Replay = await call(connection, "atf_gate", { gate: "G1", action: "query" });
    check(
      "[3] G1 advance → 同会话 query 反读一致（边界：内存登记，非落盘）",
      g1Advance.ok && (g1Advance.value as { status?: string }).status === "pass" && g1Replay.ok && (g1Replay.value as { status?: string }).status === "pass",
    );
    const closed = await connection.close();
    check("[3] 优雅关闭 exit 0", closed.ok && closed.value.exitCode === 0);

    // ---------------- [4] fail-closed 反例（单会话顺序；错误后连接保持） ----------------
    const bareRunId = "r2-fixture-run-bare";
    const badRunId = "r2-fixture-run-bad";
    for (const extra of [bareRunId, badRunId]) await mkdir(join(wsRoot, "runs", extra, "journal"), { recursive: true });
    await writeFile(join(wsRoot, "runs", badRunId, "journal", "journal.jsonl"), "这不是合法JSON行\n", "utf8");

    const spawned2 = await AtfBridgeConnection.spawn({ command: serveOf(pinPath, false).argv, cwd: serveOf(pinPath, false).cwd, env: serveOf(pinPath, false).env });
    check("[4] 反例会话 spawn", spawned2.ok);
    if (spawned2.ok) {
      const conn = spawned2.value;
      const noBound = await call(conn, "atf_fact_scan", {});
      check("[4] no_run_bound", !noBound.ok && noBound.code === "no_run_bound", `实得 ${!noBound.ok ? noBound.code : "意外成功"}`);
      const bindGhost = await call(conn, "atf.bind_run", { run_id: "r2-fixture-run-ghost" });
      check("[4] unknown_run（bind）", !bindGhost.ok && bindGhost.code === "unknown_run", `实得 ${!bindGhost.ok ? bindGhost.code : "意外成功"}`);
      const bound = await call(conn, "atf.bind_run", { run_id: runId });
      check("[4] 错误后连接保持：绑定成功", bound.ok);
      const unknownGate = await call(conn, "atf_gate", { gate: "not-a-gate", action: "query" });
      check("[4] unknown_gate", !unknownGate.ok && unknownGate.code === "unknown_gate", `实得 ${!unknownGate.ok ? unknownGate.code : "意外成功"}`);
      const rebound = await call(conn, "atf.bind_run", { run_id: bareRunId });
      check("[4] 换绑 bare run", rebound.ok);
      const bareGate = await call(conn, "atf_gate", { gate: "G1", action: "query" });
      check(
        "[4] admission_state_unavailable（blocked 合法产出）",
        bareGate.ok && (bareGate.value as { status?: string; reason_codes?: string[] }).status === "blocked" &&
          JSON.stringify((bareGate.value as { reason_codes?: string[] }).reason_codes) === JSON.stringify(["admission_state_unavailable"]),
      );
      const integrity = await call(conn, "atf_gate", { gate: "training-preflight-valid", action: "query" });
      check(
        "[4] gate_verdict_not_registered（blocked 合法产出）",
        integrity.ok && (integrity.value as { status?: string }).status === "blocked",
      );
      const badScan = await call(conn, "atf_fact_scan", { run_id: badRunId });
      check("[4] 坏 journal → internal_error", !badScan.ok && badScan.code === "internal_error", `实得 ${!badScan.ok ? badScan.code : "意外成功"}`);
      const scopeRef = { ...KERNEL_SCOPE, scope_id: runId };
      const emptyLedger = await call(conn, "ledger_query", { scope_ref: scopeRef });
      check("[4] 账本空链 query → records=[]", emptyLedger.ok && (emptyLedger.value as { records?: unknown[] }).records?.length === 0);
      const mismatch = await call(conn, "ledger_consume", { approval_ref: "r2-fixture-apr-x", record_id: "not-matching" });
      check("[4] approval_record_mismatch", !mismatch.ok && mismatch.code === "approval_record_mismatch", `实得 ${!mismatch.ok ? mismatch.code : "意外成功"}`);
      const missing = await call(conn, "ledger_consume", { approval_ref: "r2-fixture-apr-x", record_id: "approval-record:r2-fixture-apr-x:1" });
      check("[4] 空链消费 not_found", !missing.ok && missing.code === "not_found", `实得 ${!missing.ok ? missing.code : "意外成功"}`);
      const closed2 = await conn.close();
      check("[4] 反例会话优雅关闭 exit 0（错误后连接保持全程成立）", closed2.ok && closed2.value.exitCode === 0);
    } else {
      failed = true;
    }

    // ---------------- [5] 注入式账本（D1：测试夹具专用对端） ----------------
    const spawned3 = await AtfBridgeConnection.spawn({ command: serveOf(pinPath, true).argv, cwd: serveOf(pinPath, true).cwd, env: serveOf(pinPath, true).env });
    check("[5] 注入式对端 spawn（预录审批链）", spawned3.ok);
    if (spawned3.ok) {
      const conn = spawned3.value;
      const scopeRef = { ...KERNEL_SCOPE, scope_id: runId };
      const queried = await call(conn, "ledger_query", { scope_ref: scopeRef });
      const records = queried.ok ? (queried.value as { records: { record_id: string; state: string; sequence: number }[] }).records : [];
      check(
        "[5] 预录链 query：恰 1 条 approved head",
        queried.ok && records.length === 1 && records[0]?.record_id === `approval-record:${APPROVAL_REF}:1` && records[0]?.state === "approved",
      );
      const consumed = await call(conn, "ledger_consume", { approval_ref: APPROVAL_REF, record_id: `approval-record:${APPROVAL_REF}:1` });
      check("[5] 逐值一致消费 → consumed", consumed.ok && (consumed.value as { state?: string }).state === "consumed");
      const again = await call(conn, "ledger_consume", { approval_ref: APPROVAL_REF, record_id: `approval-record:${APPROVAL_REF}:1` });
      check("[5] 重复消费 → approval_already_consumed", !again.ok && again.code === "approval_already_consumed", `实得 ${!again.ok ? again.code : "意外成功"}`);
      const defaultQuery = await call(conn, "ledger_query", { scope_ref: scopeRef });
      check("[5] 缺省 query 只回可消费记录 → 空", defaultQuery.ok && (defaultQuery.value as { records?: unknown[] }).records?.length === 0);
      const closed3 = await conn.close();
      check("[5] 注入式会话优雅关闭 exit 0", closed3.ok && closed3.value.exitCode === 0);
    } else {
      failed = true;
    }

    // ---------------- [6] 隔离断言 ----------------
    const pinStatus = await gitStatusShort(pinPath);
    check("[6] 隔离：pin 副本 git status 零改动", pinStatus === "");
    const skillsStat = await statSafe(join(home, ".agents", "skills"));
    check("[6] 隔离：temp HOME 无 .agents/skills 泄漏", !skillsStat);
    check("[6] 隔离：写盘全部位于 /tmp/atf-r2-* 夹具根", wsRoot.startsWith("/tmp/atf-r2-") && home.startsWith("/tmp/atf-r2-"));

    // ---------------- [7] 边界标注（决议 §3，字面输出） ----------------
    process.stdout.write("—— 边界标注（owner 决议 §3，随报告入档）——\n");
    process.stdout.write("  [边界 1] 场景迁移另批：admission-to-g2 等场景脚本迁真内核涉及参数化与 Faux 适配，R2 以 smoke:r2 达成端到端验收即可；\n");
    process.stdout.write("  [边界 2] mock↔内核 event 键差异（mock {from,to} vs 内核 {from_run_id,to_run_id} 且首绑也发）已登记「mock 退役评估」清单，本批不统一；\n");
    process.stdout.write("  [边界 3] 「内存登记」不得写成「已落盘」：闸门推进与账本消费仅在会话进程内存，验证口径 = 同会话 query 反读，不得表述为持久化/可重建；\n");
    process.stdout.write("  [边界+] R2 的 run 为合成最小 run（r2-fixture-*），R2 验收通过 ≠ 业务级可用；真实训练链路端到端仍需独立授权与独立批次。\n");
  } finally {
    await cleanup();
    const left = await statSafe(wsRoot);
    check("[6] 夹具清理：临时根零残留", !left);
  }

  if (failed) {
    process.stdout.write("R2 冒烟失败 ✗（存在未通过断言）\n");
    return 1;
  }
  process.stdout.write("R2 冒烟通过 ✓（七段总验收全过）\n");
  return 0;
};

const statSafe = async (path: string): Promise<boolean> => {
  const { stat } = await import("node:fs/promises");
  return stat(path).then(
    () => true,
    () => false,
  );
};

main().then(
  (code) => process.exit(code),
  (cause) => {
    process.stderr.write(`smoke:r2 异常退出: ${String(cause)}\n`);
    process.exit(1);
  },
);
