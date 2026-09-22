/**
 * 批 3「创作执行面」runner 级用例（§一/§三）：工作区工具经 runner 全管线——
 * 判据：执行类审批链（headless 无预录 = exit 78；账本预录 = CAS 消费放行）／工具事件落账
 * （tool/call＋tool/result 入 append-only 流）／atf_launch_execute 受控执行点（放行记录落
 * 内核账本径→launch.sh 执行→state.json 回填→run 事实承载）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { ScenarioRunner } from "../../src/core/run/index.js";
import { ToolRegistry, WORKSPACE_TOOL_HANDLERS, type LocalToolHost } from "../../src/core/tools/index.js";
import { findPython3 } from "../../src/core/workspace/index.js";
import type { ToolResultPayload } from "../../src/core/run/index.js";
import type { LlmDecision, LlmProvider, Scenario } from "../../src/llm/index.js";
import type { LlmContextEvent } from "../../src/core/session/index.js";

const mockPath = new URL("../../tests/fixtures/mock_atf.mjs", import.meta.url).pathname ?? "tests/fixtures/mock_atf.mjs";
const python = findPython3();

/** 桩内核：提供 --record-training-release 形态的 stub 脚本（写 $HOME 账本文件，stdout JSON）。 */
const makeStubKernel = (): string => {
  const kernelDir = mkdtempSync(join(tmpdir(), "atf-b3-kernel-"));
  const scripts = join(kernelDir, "skills", "atf-prepare-training", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "generate_train_launch.py"), [
    "#!/usr/bin/env python3",
    "import json, os, sys, hashlib",
    "args = sys.argv[1:]",
    "cfg = args[args.index('--config') + 1]",
    "sha = hashlib.sha256(open(cfg, 'rb').read()).hexdigest()",
    "ledger = os.path.join(os.environ.get('HOME', '/tmp'), '.atf-b3-training-release.jsonl')",
    "os.makedirs(os.path.dirname(ledger), exist_ok=True)",
    "already = os.path.isfile(ledger) and sha in open(ledger).read()",
    "with open(ledger, 'a') as fh:",
    "    fh.write(json.dumps({'subject_sha256': sha, 'decision': 'approved'}) + '\\n')",
    "print(json.dumps({'result': 'already_recorded' if already else 'recorded', 'subject_sha256': sha}))",
    "",
  ].join("\n"));
  return kernelDir;
};

interface Hosts {
  runsRoot: string;
  kernelDir: string;
  home: string;
  host: LocalToolHost;
}

const makeHosts = (): Hosts => {
  const runsRoot = mkdtempSync(join(tmpdir(), "atf-b3-runs-"));
  const kernelDir = makeStubKernel();
  const home = mkdtempSync(join(tmpdir(), "atf-b3-home-"));
  const host: LocalToolHost = {
    scratchDir: "", // runId 定后回填
    kernelDir,
    home,
    baseEnv: { ATF_SKILLS_AUTO_INSTALL: "0" },
    pythonPath: python,
    launchWaitMs: 15_000,
  };
  return { runsRoot, kernelDir, home, host };
};

const scenarioOf = (runId: string, instruction: string, ledger: Array<{ tool: string; params: Record<string, unknown> }> = []): Scenario => ({
  scenario_id: "b3-workspace",
  version: 1,
  provider: "faux" as const,
  description: "批3",
  branches: {
    main: {
      branch_id: "main",
      run_id: runId,
      trigger_instruction: instruction,
      purpose: "b3",
      setup: { ledger },
      steps: [],
      expect: { outcome: "completed" as const, exit_code: 0 as const },
    },
  },
});

const scriptedProvider = (decisions: LlmDecision[], seen: Array<readonly LlmContextEvent[]>): LlmProvider => {
  let index = 0;
  return {
    providerId: "b3-stub-model",
    decide: async (context) => {
      seen.push(context);
      const next = decisions[index];
      index += 1;
      return ok(next ?? { type: "final_answer", text: "收口。" });
    },
  };
};

const toolResultsOf = (events: readonly LlmContextEvent[], tool: string): Array<Extract<ToolResultPayload, { ok: true }>> => {
  const out: Array<Extract<ToolResultPayload, { ok: true }>> = [];
  for (const event of events) {
    if (event.type !== "tool/result") continue;
    const payload = event.payload as ToolResultPayload;
    if (payload.tool === tool && payload.ok === true) out.push(payload);
  }
  return out;
};

describe("批 3 §一：执行类审批链（runner 全管线）", () => {
  it("无预录无问答轨 → atf_scratch_exec blocked approval_missing（exit 78，fail-closed 不执行）", { timeout: 60_000 }, async () => {
    const env = makeHosts();
    try {
      const runId = `b3-exec-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      const seen: LlmContextEvent[][] = [];
      const argv = ["python3", "-c", "print('should-not-run')"];
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "执行脚本"), "main", {
        runsRoot: env.runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: scriptedProvider([
          { type: "tool_call", tool: "atf_scratch_exec", params: { argv } },
        ], seen),
        toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("approval_missing");
      expect(ran.value.exit_code).toBe(78);
      // 未获授权 → 命令未执行（scratch 无 .tmp 执行痕迹以外的产物；关键是无 tool/result ok:true）
      expect(toolResultsOf(seen[0] ?? [], "atf_scratch_exec")).toHaveLength(0);
    } finally {
      rmSync(env.runsRoot, { recursive: true, force: true });
      rmSync(env.kernelDir, { recursive: true, force: true });
      rmSync(env.home, { recursive: true, force: true });
    }
  });

  it("账本预录 → CAS 消费放行 → 执行成功＋工具事件落账（tool/call＋tool/result 入流）", { timeout: 60_000 }, async () => {
    const env = makeHosts();
    try {
      const runId = `b3-exec-ok-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      const seen: LlmContextEvent[][] = [];
      const argv = ["python3", "-c", "print('b3-executed')"];
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "执行脚本", [{ tool: "atf_scratch_exec", params: { argv } }]), "main", {
        runsRoot: env.runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: scriptedProvider([
          { type: "tool_call", tool: "atf_scratch_exec", params: { argv } },
        ], seen),
        toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("completed");
      const results = toolResultsOf(ran.value.events, "atf_scratch_exec");
      expect(results).toHaveLength(1);
      const result = results[0]?.result as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      expect(result["stdout"]).toContain("b3-executed");
      // 落账：tool/call 与 tool/result 事件都在 append-only 流
      expect(ran.value.events.some((event) => event.type === "tool/call" && (event.payload as { tool?: string }).tool === "atf_scratch_exec")).toBe(true);
      expect(ran.value.events.some((event) => event.type === "tool/result")).toBe(true);
    } finally {
      rmSync(env.runsRoot, { recursive: true, force: true });
      rmSync(env.kernelDir, { recursive: true, force: true });
      rmSync(env.home, { recursive: true, force: true });
    }
  });

  it("argv[0] 白名单外（shell）→ rejected 回填（非终局；模型可换路径）", { timeout: 60_000 }, async () => {
    const env = makeHosts();
    try {
      const runId = `b3-exec-shell-${randomUUID()}`;
      env.host.scratchDir = join(env.runsRoot, runId, "scratch");
      const argv = ["bash", "-c", "echo no"];
      const seen: LlmContextEvent[][] = [];
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "执行 shell", [{ tool: "atf_scratch_exec", params: { argv } }]), "main", {
        runsRoot: env.runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: scriptedProvider([
          { type: "tool_call", tool: "atf_scratch_exec", params: { argv } },
          { type: "final_answer", text: "已被拒，如实转述。" },
        ], seen),
        toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("completed");
      const rejected = ran.value.events.find((event) =>
        event.type === "tool/result" && (event.payload as { tool?: string; ok?: boolean }).tool === "atf_scratch_exec" &&
        (event.payload as { ok?: boolean }).ok === false);
      expect(rejected).toBeDefined();
      expect(((rejected?.payload as { reason?: string }).reason)).toBe("argv0_not_allowed");
    } finally {
      rmSync(env.runsRoot, { recursive: true, force: true });
      rmSync(env.kernelDir, { recursive: true, force: true });
      rmSync(env.home, { recursive: true, force: true });
    }
  });
});

describe("批 3 §三：atf_launch_execute 受控执行点", () => {
  it("预录放行 → 放行记录落内核账本径 → launch.sh 执行 → state.json 回填＋run 事实承载", { timeout: 60_000 }, async () => {
    const env = makeHosts();
    try {
      const runId = `b3-launch-${randomUUID()}`;
      const scratchDir = join(env.runsRoot, runId, "scratch");
      // fresh:false——工作区产物先行就位（launch 链检测与执行的前提形态）
      mkdirSync(join(scratchDir, "prep", "launch"), { recursive: true });
      mkdirSync(join(scratchDir, "out"), { recursive: true });
      const configAbs = join(scratchDir, "prep", "iteration-config.json");
      writeFileSync(configAbs, JSON.stringify({ schema_version: "IterationConfig/v1", run_id: runId }));
      const configSha = createHash("sha256").update(readFileSync(configAbs)).digest("hex");
      writeFileSync(join(scratchDir, "prep", "launch", "launch_manifest.json"), JSON.stringify({ run_id: runId, iteration_config_sha256: configSha, global_batch: 16, nnodes: 1 }));
      const launchShAbs = join(scratchDir, "out", "launch.sh");
      writeFileSync(launchShAbs, [
        "#!/usr/bin/env bash",
        'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
        'mkdir -p "$SCRIPT_DIR/launch"',
        "sleep 0.2",
        'cat > "$SCRIPT_DIR/launch/state.json" <<EOF',
        '{"state": "started", "run_token": "stub", "pid": 4321, "log": "stub.log", "launcher_count": 1, "effect_started": true}',
        "EOF",
        'echo "started pid=4321"',
        "",
      ].join("\n"));
      env.host.scratchDir = scratchDir;

      const params = { launch_sh: "out/launch.sh", config: "prep/iteration-config.json" };
      const seen: LlmContextEvent[][] = [];
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "放行启动", [{ tool: "atf_launch_execute", params }]), "main", {
        runsRoot: env.runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: scriptedProvider([
          { type: "tool_call", tool: "atf_launch_execute", params },
        ], seen),
        toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
        fresh: false,
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("completed");
      const results = toolResultsOf(ran.value.events, "atf_launch_execute");
      expect(results).toHaveLength(1);
      const result = results[0]?.result as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      expect(result["release_recorded"]).toBe(true);
      expect(result["release_result"]).toBe("recorded");
      expect(result["state"]).toBe("started");
      expect(result["effect_started"]).toBe(true);
      expect(typeof result["log_path"]).toBe("string");
      // 放行记录真实落内核账本径（stub 脚本按 $HOME 写）
      expect(existsSync(join(env.home, ".atf-b3-training-release.jsonl"))).toBe(true);
      // state.json 收据在 launch.sh 旁（内核收据语义）
      expect(existsSync(join(scratchDir, "out", "launch", "state.json"))).toBe(true);
    } finally {
      rmSync(env.runsRoot, { recursive: true, force: true });
      rmSync(env.kernelDir, { recursive: true, force: true });
      rmSync(env.home, { recursive: true, force: true });
    }
  });

  it("config 与 manifest sha 不一致 → rejected(launch_config_mismatch)，不执行不放行", { timeout: 60_000 }, async () => {
    const env = makeHosts();
    try {
      const runId = `b3-launch-mix-${randomUUID()}`;
      const scratchDir = join(env.runsRoot, runId, "scratch");
      mkdirSync(join(scratchDir, "prep", "launch"), { recursive: true });
      mkdirSync(join(scratchDir, "out"), { recursive: true });
      writeFileSync(join(scratchDir, "prep", "iteration-config.json"), JSON.stringify({ schema_version: "IterationConfig/v1", run_id: runId }));
      // manifest 在真实 TRAIN_DIR（内容 sha 与 config 不同 → 放行对拍必须拒）
      writeFileSync(join(scratchDir, "prep", "launch", "launch_manifest.json"), JSON.stringify({ run_id: runId, iteration_config_sha256: "f".repeat(64) }));
      writeFileSync(join(scratchDir, "out", "launch.sh"), `#!/usr/bin/env bash\nTRAIN_DIR='${join(scratchDir, "prep", "launch")}'\nexit 0\n`);
      env.host.scratchDir = scratchDir;

      const params = { launch_sh: "out/launch.sh", config: "prep/iteration-config.json" };
      const ran = await ScenarioRunner.runBranch(scenarioOf(runId, "放行启动", [{ tool: "atf_launch_execute", params }]), "main", {
        runsRoot: env.runsRoot,
        mockCommand: ["node", mockPath],
        modelProvider: scriptedProvider([
          { type: "tool_call", tool: "atf_launch_execute", params },
          { type: "final_answer", text: "对拍不一致，如实转述。" },
        ], []),
        toolFace: { registry: ToolRegistry.createWithWorkspaceTools(), local: { handlers: WORKSPACE_TOOL_HANDLERS, host: env.host } },
        fresh: false,
      });
      expect(ran.ok).toBe(true);
      if (!ran.ok) throw new Error("unreachable");
      expect(ran.value.outcome.kind).toBe("completed");
      const rejected = ran.value.events.find((event) =>
        event.type === "tool/result" && (event.payload as { tool?: string; ok?: boolean }).tool === "atf_launch_execute" &&
        (event.payload as { ok?: boolean }).ok === false);
      expect(rejected).toBeDefined();
      expect((rejected?.payload as { reason?: string }).reason).toBe("launch_config_mismatch");
      // 未放行：账本文件不存在
      expect(existsSync(join(env.home, ".atf-b3-training-release.jsonl"))).toBe(false);
    } finally {
      rmSync(env.runsRoot, { recursive: true, force: true });
      rmSync(env.kernelDir, { recursive: true, force: true });
      rmSync(env.home, { recursive: true, force: true });
    }
  });
});
