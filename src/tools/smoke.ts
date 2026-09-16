/**
 * S3 手工冒烟命令（任务书：每个 slice 一条手工冒烟命令）。
 *
 * 对契约 mock 对端全流程演示（契约 v2 审批链键模型）：注册表面 → 无预录调用 admit_data →
 * blocked(approval_missing, exit 78 锚点) → 账本预录 → admit_data 执行成功 → 账本一次性消费
 * （重复调用 → blocked）→ gate advance（证据已准入 → pass）→ fact_scan / workspace_status（免审批只读）。
 *
 * 用法（仓库根目录）：
 *   npm run smoke:s3
 *
 * 退出码：全部通过 = 0；任一步失败 = 1（审批 block 预期步骤除外，按断言判定）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AtfBridgeConnection } from "../bridge/index.js";
import { ToolExecutor, ToolRegistry, resolveHeadlessExitCode } from "../core/tools/index.js";
import { approvalParamsDigest, type ScopeRef } from "../core/tools/approvalKey.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

const SCOPE_REF: ScopeRef = { project_id: "smoke-s3", scope_type: "run", scope_id: "smoke-s3-run", scope_mode: "headless" };

let failed = false;
const step = (label: string, pass: boolean, detail?: string): void => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!pass) failed = true;
};

const smoke = async (): Promise<void> => {
  console.log(`[1] spawn 契约 mock 对端（含 MockLedger 与 4 工具方法面）: ${mockPath}`);
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockPath] });
  if (!spawned.ok) {
    console.error("spawn/握手失败:", JSON.stringify(spawned.error, null, 2));
    process.exitCode = 1;
    return;
  }
  const connection = spawned.value;
  try {
    const executor = new ToolExecutor(connection, ToolRegistry.createDefault(), SCOPE_REF);

    console.log("[2] 无预录调用 atf_admit_data → 期望 blocked(approval_missing, exit 78)");
    const params = { dataset_id: "ds-001" };
    const noApproval = await executor.execute("atf_admit_data", params);
    step(
      "无预录 → blocked",
      noApproval.kind === "blocked" && noApproval.block.reason === "approval_missing" && noApproval.block.exit_code === 78,
      `exit=${String(noApproval.kind === "blocked" ? resolveHeadlessExitCode(noApproval) : "?")}`,
    );

    console.log("[3] 账本预录（scope_ref + 审计辅助键）→ admit_data 执行成功（canonical 校验通过）");
    const recorded = await connection.request("ledger_record", {
      scope_ref: SCOPE_REF,
      tool: "atf_admit_data",
      params_digest: approvalParamsDigest(params),
    });
    step("预录 ledger_record", recorded.ok, recorded.ok ? JSON.stringify(recorded.value) : undefined);
    const executed = await executor.execute("atf_admit_data", params);
    step(
      "admit_data 执行成功",
      executed.kind === "executed",
      executed.kind === "executed" ? `fact=${JSON.stringify((executed.result as { fact_id?: string }).fact_id)}` : JSON.stringify(executed),
    );

    console.log("[4] 重复调用同 request → 账本已消费 → blocked（一次性消费语义）");
    const replay = await executor.execute("atf_admit_data", params);
    step("重复调用 → blocked(approval_missing)", replay.kind === "blocked" && replay.block.reason === "approval_missing");

    console.log("[5] atf_gate advance：预录 gate 审批（证据已准入）→ pass");
    const gateParams = { gate: "G2", action: "advance" };
    const gateRecorded = await connection.request("ledger_record", {
      scope_ref: SCOPE_REF,
      tool: "atf_gate",
      params_digest: approvalParamsDigest(gateParams),
    });
    step("预录 atf_gate 审批", gateRecorded.ok);
    const gate = await executor.execute("atf_gate", gateParams);
    step(
      "gate G2 pass",
      gate.kind === "executed" && (gate.result as { status?: string }).status === "pass",
      gate.kind === "executed" ? JSON.stringify(gate.result) : JSON.stringify(gate),
    );

    console.log("[6] 只读工具免审批：fact_scan / workspace_status");
    const scan = await executor.execute("atf_fact_scan", {});
    step(
      "fact_scan count=1",
      scan.kind === "executed" && (scan.result as { count?: number }).count === 1,
    );
    const status = await executor.execute("atf_workspace_status", {});
    step(
      "workspace_status admitted_count=1 且含 scope_ref",
      status.kind === "executed" &&
        (status.result as { admitted_count?: number }).admitted_count === 1 &&
        (status.result as { scope_ref?: { scope_id?: string } }).scope_ref?.scope_id === "mock-run-1",
    );
  } finally {
    const closed = await connection.close();
    step("优雅关闭", closed.ok && closed.value.exitCode === 0);
  }

  if (failed) process.exitCode = 1;
  else console.log("S3 冒烟通过 ✓");
};

await smoke();
