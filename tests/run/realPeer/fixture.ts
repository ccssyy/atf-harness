import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { type AtfBridgeConnection } from "../../../src/bridge/connection.js";
import { atfCliPathFromEnv, deriveAtfCommand } from "../../../src/bridge/atfCommand.js";

/**
 * R2 真实对端夹具（门 1 设计 §1/§3/§4 落地；《ATF-Harness_Owner决议与指令_R2门1评审_门2放行_20260914.md》）。
 *
 * 三层隔离根（全部 mkdtemp，路径前缀 /tmp/atf-r2-*——真实写授权边界，越界即违规）：
 *   <home>   子进程 HOME（~/.atf 配置根、技能目录的隔离兜底）
 *   <wsRoot> workspace root（真实 `atf init` 装机；runs/、datasets/）
 *   pin 副本  cwd（ATF_CLI_PATH，只读；全程 git status 零改动断言由调用方/冒烟承担）
 *
 * 合成数据纪律：run_id/数据集/操作者等一律 `r2-fixture-*` 标识，零真实业务内容。
 *
 * 注入式对端（D1 裁决，仅限测试夹具，不得进入 src/ 生产路径）：injectedServeCommand
 * 以 `python3 -c` 包装 run_session + build_registry(owners=预录 FactOwners)——
 * 与 derive_command 同源注入（PYTHONPATH/PYTHONDONTWRITEBYTECODE/ATF_SKILLS_AUTO_INSTALL）。
 */

/** 内核 run 十目录骨架（RUN_SKELETON 常量的 TS 镜像；漂移由 bind_run 断言报警）。 */
export const RUN_SKELETON = [
  "experiment-setup",
  "l1",
  "variants",
  "launch",
  "training",
  "models",
  "eval",
  "journal",
  "verification",
  "decisions",
] as const;

/** G1–G4 对应的四组准入 GateId（内核 ADMISSION_GATE_IDS 固定顺序）。 */
export const ADMISSION_GATE_IDS = [
  "extraction-contract-valid",
  "source-identity-valid",
  "split-integrity-valid",
  "training-data-valid",
] as const;

/** 内核 scope 投影常量（_scope_projection；ledger 预录的 scope_ref 须逐字段一致）。 */
export const KERNEL_SCOPE = {
  project_id: "agentic-training-flow",
  scope_type: "run",
  scope_mode: "canonical",
} as const;

export interface RealPeerFixture {
  /** 子进程 HOME（临时） */
  home: string;
  /** workspace root（临时） */
  wsRoot: string;
  /** 合成 run 标识 */
  runId: string;
  /** pin 副本路径（ATF_CLI_PATH） */
  pinPath: string;
  /** 真实对端 spawn 面（serve），隔离 env 单点产出（argv 形态直配 BridgeSpawnOptions）。 */
  serveSpawn(): { argv: string[]; cwd: string; env: Record<string, string> };
  /** 注入式对端 spawn 面（D1：预录审批链；仅测试夹具用） */
  injectedServeSpawn(): { argv: string[]; cwd: string; env: Record<string, string> };
  cleanup(): Promise<void>;
}

const execFileP = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      const code = (error as { exitCode?: number | null }).exitCode;
      if (typeof code === "number") {
        resolve({ exitCode: code, stdout, stderr });
        return;
      }
      reject(error);
    });
  });

/** ATF_CLI_PATH 就绪判定（未设置 → 真对端组整体跳过；mock 轨不受影响）。 */
export const realPeerCliPath = (): { ok: true; path: string } | { ok: false; reason: string } => {
  const cli = atfCliPathFromEnv();
  return cli.ok ? { ok: true, path: cli.value } : { ok: false, reason: cli.error.message };
};

/** 建夹具：真实 `atf init` 装机 + 直建十目录骨架（门 1 §1 混合取舍）。失败即清理，不留残根。 */
export const createRealPeerFixture = async (runId = `r2-fixture-run-1`): Promise<RealPeerFixture> => {
  const cli = realPeerCliPath();
  if (!cli.ok) throw new Error(`真实对端夹具不可用: ${cli.reason}`);
  const pinPath = cli.path;
  const home = await mkdtemp(join(tmpdir(), "atf-r2-home-"));
  const wsRoot = await mkdtemp(join(tmpdir(), "atf-r2-ws-"));
  const baseEnv = (): Record<string, string> => {
    const invocation = deriveAtfCommand(pinPath, []);
    return { ...process.env, ...invocation.env, HOME: home } as Record<string, string>;
  };
  const cleanup = async (): Promise<void> => {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    await rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const init = deriveAtfCommand(pinPath, ["init", "--workspace-root", wsRoot]);
    const ran = await execFileP(init.command, init.args, { cwd: init.cwd, env: baseEnv() });
    if (ran.exitCode !== 0) throw new Error(`atf init 失败(exit=${String(ran.exitCode)}): ${ran.stderr.slice(0, 200)}`);
    if (!ran.stdout.includes(wsRoot)) throw new Error(`atf init 输出未确认 workspace_root: ${ran.stdout.slice(0, 200)}`);
    for (const sub of RUN_SKELETON) {
      await mkdir(join(wsRoot, "runs", runId, sub), { recursive: true });
    }
  } catch (cause) {
    await cleanup();
    throw cause;
  }
  return {
    home,
    wsRoot,
    runId,
    pinPath,
    serveSpawn: () => {
      const invocation = deriveAtfCommand(pinPath, ["serve"]);
      // K-Gap-2 接线批（2026-09-21）：serve 需知工作区根（TUI descriptor 同款）——
      // 相对形态的 source_root/split_root 依此解析；缺失时登记面相对路径不可解析。
      return { argv: [invocation.command, ...invocation.args], cwd: invocation.cwd, env: { ...baseEnv(), ATF_WORKSPACE_ROOT: wsRoot } };
    },
    injectedServeSpawn: () => {
      const invocation = deriveAtfCommand(pinPath, []);
      return {
        argv: [invocation.command, "-c", ledgerPrelude(runId)],
        cwd: invocation.cwd,
        env: baseEnv(),
      };
    },
    cleanup,
  };
};

/**
 * journal 追加（内核 journal_append 行格式：canonical JSON，键序 ts/action/out/refs）。
 * 仅供夹具制样；真实产线 journal 由内核生成件自写。
 */
export const appendJournalEvent = async (
  wsRoot: string,
  runId: string,
  event: { action: string; out?: string; refs?: Record<string, string> },
): Promise<void> => {
  const line = JSON.stringify({
    ts: "2026-09-14T00:00:00Z",
    action: event.action,
    out: event.out ?? null,
    refs: event.refs ?? {},
  });
  const dir = join(wsRoot, "runs", runId, "journal");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "journal.jsonl"), `${line}\n`, { encoding: "utf8", flag: "a" });
};

/** 向 journal 追加任意坏行（internal_error 反例制样）。 */
export const appendJournalBadLine = async (wsRoot: string, runId: string): Promise<void> => {
  const dir = join(wsRoot, "runs", runId, "journal");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "journal.jsonl"), "这不是合法JSON行\n", { encoding: "utf8", flag: "a" });
};

/**
 * 准入 summary 制样（内核 _ADMISSION_SUMMARY_GLOB 形态：l1/<lane>/<lane>-source-backed-admission-summary.json，
 * gates 数组恰 4 项、按 ADMISSION_GATE_IDS 固定顺序，verdict ∈ pass/warn/block）。
 * verdicts: 长度 4 的裁决数组；reasonCodes: 与裁决同长的可选原因码数组（block/warn 须给，否则内核拒登记）。
 */
export const writeAdmissionSummary = async (
  wsRoot: string,
  runId: string,
  lane: string,
  verdicts: readonly ("pass" | "warn" | "block")[],
  reasonCodes: readonly (readonly string[])[] = [],
): Promise<string> => {
  if (verdicts.length !== ADMISSION_GATE_IDS.length) throw new Error("summary 制样须恰 4 项裁决");
  const gates = ADMISSION_GATE_IDS.map((gate_id, index) => {
    const entry: { gate_id: string; verdict: string; reason_codes?: string[] } = { gate_id, verdict: verdicts[index] ?? "pass" };
    const codes = reasonCodes[index];
    if (codes !== undefined && codes.length > 0) entry.reason_codes = [...codes];
    return entry;
  });
  const dir = join(wsRoot, "runs", runId, "l1", lane);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${lane}-source-backed-admission-summary.json`);
  await writeFile(path, `${JSON.stringify({ gates }, null, 1)}\n`, "utf8");
  return path;
};

/**
 * 注入式对端预录脚本（D1）：register_command + consume_command 形成 sequence=1 的
 * approved head（record_id = approval-record:r2-fixture-apr-001:1），随后进入 run_session。
 * 通道最小实现：bind_run 留痕 event 以合法 event 帧写出（本夹具账本组不绑定 run，留作通用性）。
 */
const ledgerPrelude = (runId: string): string => `
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
    subject_ref="r2-fixture-apr-001", evidence_refs=("r2-fixture-evidence",), decision="approve")
ledger = owners.approval_ledger
ledger.register_command(command)
ledger.consume_command(
    command.command_id,
    ApprovalRef("r2-fixture-apr-001", scope, "r2-fixture-op-001", "r2-fixture-attempt-001"),
    "r2-fixture-actor", 0)
run_session(sys.stdin.buffer, sys.stdout.buffer, registry=build_registry(channel=_Channel(), owners=owners))
`;

/** 注入式对端的预录链身份常量（与 ledgerPrelude 逐字一致；断言用）。 */
export const INJECTED_LEDGER = {
  approvalRef: "r2-fixture-apr-001",
  headRecordId: "r2-fixture-apr-001:1",
} as const;

// ------------------------------------------------------------------
// 组内共享断言工具（两个测试文件共用；不经测试文件互相 import——防 describe 重放）
// ------------------------------------------------------------------

/** 线缆错误码提取：对端 error response 折算为 err(request_rejected)，detail.code 承载原码。 */
export const wireCode = (rejected: { ok: false; error: { code: string; detail?: unknown } }): string => {
  expect(rejected.error.code).toBe("request_rejected");
  return ((rejected.error.detail ?? {}) as { code?: string }).code ?? "";
};

export type BridgeCallResult = { ok: true; value: unknown } | { ok: false; error: { code: string; detail?: unknown } };

/** 连接请求的断言友好形态（错误响应只留线缆码与 detail）。 */
export const request = async (connection: AtfBridgeConnection, method: string, params?: unknown): Promise<BridgeCallResult> => {
  const response = await connection.request(method, params);
  return response.ok ? response : { ok: false, error: { code: wireCode(response), detail: response.error.detail } };
};

const gitStatusShort = (repoPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", repoPath, "status", "--short"], (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });

/** 隔离断言（门 1 §4）：pin 副本零改动；temp HOME 无 .agents/skills 泄漏。 */
export const assertIsolation = async (fixture: RealPeerFixture): Promise<void> => {
  await expect(gitStatusShort(fixture.pinPath), "pin 副本零改动").resolves.toBe("");
  const { stat } = await import("node:fs/promises");
  const skillsLeaked = await stat(join(fixture.home, ".agents", "skills")).then(
    () => true,
    () => false,
  );
  expect(skillsLeaked, "temp HOME 不得出现 .agents/skills（技能自举须关闭）").toBe(false);
};
