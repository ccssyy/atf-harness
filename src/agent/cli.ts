/**
 * 丙 v1（批 P）——ATF KIE Training Agent headless CLI（唯一产品入口；pi-tui 三期并入）。
 *
 * 装配（单 run）：pi-agent-core Agent＋九工具全挂接（经桥）＋审批 before_tool hook
 * （账本闸，headless fail-closed）＋TEM 镜像/注入（门 1b 面）＋预算 finishTurn
 * （ATF_LOOP_MAX_TURNS，缺省 8）＋JSONL session 镜像与 Case 收尾落库。
 *
 * 模型面（红线：真实 Provider 调用需 owner 另批）：
 *   --llm faux:<script.json>   脚本化 faux（测试/演示；零网络）
 *   --llm deepseek             真实 DeepSeek——双门控：显式旗标＋env ATF_V1_DEEPSEEK_AUTHORIZED=1
 *                              （另批授权的技术编码）＋DEEPSEEK_API_KEY；缺一 fail-closed 拒启。
 *
 * 退出码（v1 口径，ADR-07 锚不挪用）：0=completed；78=approval_missing；1=预算耗尽/故障
 * （75/79 预留问答轨）。
 *
 * 用法：
 *   node dist/agent/cli.js --instruction "<指令>" [--peer mock|real] [--ws-root <path>]
 *        [--sessions-root <dir>] [--llm faux:<script.json>|deepseek] [--max-turns <n>]
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Agent, BACKGROUND_CONTEXT, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AtfBridgeConnection } from "../bridge/connection.js";
import { deriveAtfCommand } from "../bridge/atfCommand.js";
import { HARNESS_SYSTEM_PROMPT } from "../llm/systemPrompt.js";
import { buildAtfAgentTools, type SpikeBridgeTransport } from "./atfAgentTools.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "./approvalHook.js";
import { createBudgetFinishTurn, maxTurnsFromEnv, resolveV1ExitCode, type V1RunOutcome } from "./budget.js";
import { createDeepSeekStreamFn } from "./deepseekStreamFn.js";
import { createScriptedStreamFn, loadFauxScript } from "./fauxScript.js";
import { scanEvidenceEvents } from "./tem/evidence.js";
import type { ScopeRef } from "../core/tools/approvalKey.js";
import { createJsonlSessionRepo } from "./sessionMirror.js";
import { createTemAfterToolMirror, createTemTransformContext } from "./tem/retrieval.js";
import { envFingerprint } from "./tem/evidence.js";
import { ensureTemBranch, writeExperienceCase } from "./tem/store.js";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface CliArgs {
  instruction: string;
  peer: "mock" | "real";
  wsRoot?: string;
  sessionsRoot?: string;
  llm: { kind: "faux"; scriptPath: string } | { kind: "deepseek" };
  maxTurns?: number;
}

export const parseCliArgs = (argv: readonly string[]): CliArgs | { error: string } => {
  let instruction: string | undefined;
  let peer: "mock" | "real" = "mock";
  let wsRoot: string | undefined;
  let sessionsRoot: string | undefined;
  let llm: CliArgs["llm"] | undefined;
  let maxTurns: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (): string => {
      i += 1;
      return argv[i] as string;
    };
    switch (arg) {
      case "--instruction":
        instruction = take();
        break;
      case "--peer":
        peer = take() === "real" ? "real" : "mock";
        break;
      case "--ws-root":
        wsRoot = take();
        break;
      case "--sessions-root":
        sessionsRoot = take();
        break;
      case "--llm": {
        const value = take();
        if (value === "deepseek") llm = { kind: "deepseek" };
        else if (value.startsWith("faux:")) llm = { kind: "faux", scriptPath: value.slice("faux:".length) };
        else return { error: `--llm 非法: ${value}（faux:<script.json> | deepseek）` };
        break;
      }
      case "--max-turns": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1) return { error: "--max-turns 须为正整数" };
        maxTurns = value;
        break;
      }
      default:
        return { error: `未知参数: ${arg ?? "(空)"}` };
    }
  }
  if (instruction === undefined || instruction.trim() === "") return { error: "--instruction 必填（非空）" };
  if (llm === undefined) return { error: "--llm 必填（faux:<script.json> | deepseek；真实调用须 owner 另批授权——env ATF_V1_DEEPSEEK_AUTHORIZED=1）" };
  return { instruction, peer, wsRoot, sessionsRoot, llm, maxTurns };
};

export interface CliDeps {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** headless run（单一出口返回退出码；永不 throw）。 */
export const runCli = async (deps: CliDeps): Promise<number> => {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const parsed = parseCliArgs(deps.argv);
  if ("error" in parsed) {
    err(`[v1] 参数错误: ${parsed.error}`);
    return 1;
  }
  const args: CliArgs = parsed;
  const maxTurns = args.maxTurns ?? maxTurnsFromEnv(env);

  // ---- 模型面选择（红线门控）----
  let scripted: AssistantMessage[] | undefined;
  if (args.llm.kind === "faux") {
    try {
      scripted = await loadFauxScript(args.llm.scriptPath);
    } catch (cause) {
      err(`[v1] faux 脚本加载失败（fail-closed）: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  } else {
    const authorized = env["ATF_V1_DEEPSEEK_AUTHORIZED"] === "1";
    const apiKey = env["DEEPSEEK_API_KEY"]?.trim() ?? "";
    if (!authorized || apiKey === "") {
      err("[v1] 真实 DeepSeek 调用未授权（fail-closed）：需 owner 另批授权（env ATF_V1_DEEPSEEK_AUTHORIZED=1）且配置 DEEPSEEK_API_KEY——本批红线：真实 Provider 调用按需另批");
      return 1;
    }
  }

  // ---- 桥接对端装配 ----
  let spawnDescriptor: { argv: string[]; cwd: string; env: Record<string, string> };
  let bindRunId: string | undefined;
  const sessionsRoot = args.sessionsRoot ?? (await mkdtemp(join(tmpdir(), "atf-v1-sessions-")));
  if (args.peer === "real") {
    const envKernel = env["ATF_CLI_PATH"]?.trim();
    const kernelDir = envKernel !== undefined && envKernel !== "" ? envKernel : join(repoRoot, ".atf-pinned");
    const home = await mkdtemp(join(tmpdir(), "atf-v1-home-"));
    const wsRootResolved = args.wsRoot ?? (await mkdtemp(join(tmpdir(), "atf-v1-ws-")));
    const initInvocation = deriveAtfCommand(kernelDir, ["init", "--workspace-root", wsRootResolved]);
    await execFileAsync(initInvocation.command, initInvocation.args, {
      cwd: initInvocation.cwd,
      env: { ...env, ...initInvocation.env, HOME: home, ATF_WORKSPACE_ROOT: wsRootResolved },
    });
    bindRunId = `v1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await mkdir(join(wsRootResolved, "runs", bindRunId), { recursive: true });
    const invocation = deriveAtfCommand(kernelDir, ["serve"]);
    spawnDescriptor = {
      argv: [invocation.command, ...invocation.args],
      cwd: invocation.cwd,
      env: { ...invocation.env, HOME: home, ATF_WORKSPACE_ROOT: wsRootResolved },
    };
    out(`[v1] 对端=real（pin 副本 ${kernelDir}；run=${bindRunId}）；session 根=${sessionsRoot}`);
  } else {
    const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");
    spawnDescriptor = { argv: ["node", mockPath], cwd: repoRoot, env: {} };
    out(`[v1] 对端=mock；session 根=${sessionsRoot}`);
  }

  const spawned = await AtfBridgeConnection.spawn({
    command: spawnDescriptor.argv,
    cwd: spawnDescriptor.cwd,
    env: spawnDescriptor.env,
  });
  if (!spawned.ok) {
    err(`[v1] 桥接 spawn/握手失败: ${spawned.error.message}`);
    return 1;
  }
  const bridge: SpikeBridgeTransport = spawned.value;
  out(`[v1] 握手成功：kernel ${spawned.value.version?.version}（contract_version=${String(spawned.value.version?.contract_version)}）`);
  if (bindRunId !== undefined) {
    const bound = await bridge.request("atf.bind_run", { run_id: bindRunId });
    if (!bound.ok) {
      err(`[v1] bind_run 失败（fail-closed）: ${bound.error.message}`);
      await spawned.value.close({ timeoutMs: 5_000 }).catch(() => undefined);
      return 1;
    }
  }

  // ---- Agent 装配（九工具＋审批闸＋TEM＋预算）----
  try {
    const exitCode = await runV1Headless({
      bridge,
      sessionsRoot,
      instruction: args.instruction,
      maxTurns,
      scripted,
      deepseek:
        args.llm.kind === "deepseek"
          ? {
              model: env["DEEPSEEK_MODEL"]?.trim() || "deepseek-flash",
              base_url: env["DEEPSEEK_BASE_URL"]?.trim() || "https://api.deepseek.com",
              api_key: env["DEEPSEEK_API_KEY"]?.trim() ?? "",
            }
          : undefined,
      bindRunId,
      out,
      err,
    });
    return exitCode;
  } finally {
    await spawned.value.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
};

export interface V1HeadlessDeps {
  bridge: SpikeBridgeTransport;
  sessionsRoot: string;
  instruction: string;
  maxTurns: number;
  /** faux 脚本（与 deepseek 二选一；调用方已做红线门控）。 */
  scripted?: AssistantMessage[];
  deepseek?: { model: string; base_url: string; api_key: string };
  bindRunId?: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** v1 headless 单 run（装配方；测试直用）。返回退出码。 */
export const runV1Headless = async (deps: V1HeadlessDeps): Promise<number> => {
  const repo = createJsonlSessionRepo(deps.sessionsRoot);
  const session = await repo.create({ cwd: deps.sessionsRoot }, BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  const scopeRefBox: { current: ScopeRef | undefined } = { current: undefined };
  const audit: ApprovalAuditEntry[] = [];
  const outcomeBox: { current: V1RunOutcome | undefined } = { current: undefined };
  const tools = buildAtfAgentTools({ bridge: deps.bridge, scopeRefBox });
  const modelTag = deps.deepseek?.model ?? "faux-script";

  const streamFn =
    deps.scripted !== undefined
      ? createScriptedStreamFn(deps.scripted)
      : createDeepSeekStreamFn(deps.deepseek as { model: string; base_url: string; api_key: string }).streamFn;

  const agent = new Agent({
    initialState: { systemPrompt: HARNESS_SYSTEM_PROMPT, tools },
    streamFn,
    beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox, audit }),
    afterToolCall: createTemAfterToolMirror({
      session,
      runId: () => scopeRefBox.current?.scope_id ?? null,
      model: envFingerprint(modelTag).model,
    }),
    transformContext: createTemTransformContext({ session }),
    finishTurn: createBudgetFinishTurn({ maxTurns: deps.maxTurns, outcomeBox }),
    toolExecution: "sequential",
  });

  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });

  let failure: string | undefined;
  try {
    await agent.prompt(deps.instruction);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  // ---- 终局判定（闭集；审批 78 优先于预算/故障——ADR-07 锚语义）----
  const approvalMissing = [...audit].reverse().find((entry) => entry.verdict === "blocked_approval_missing");
  const lastAssistant = lastAssistantMessage(agent.state.messages);
  const hasFinalAnswer = lastAssistant !== undefined && !lastAssistant.content.some((block) => block.type === "toolCall");
  let outcome: V1RunOutcome;
  if (approvalMissing !== undefined && !hasFinalAnswer) {
    outcome = { kind: "approval_missing", tool: approvalMissing.tool, reason: "审批缺失：账本无可消费记录（headless exit 78 锚语义）" };
  } else if (outcomeBox.current !== undefined) {
    outcome = outcomeBox.current;
  } else if (failure !== undefined) {
    outcome = { kind: "failed", error: failure };
  } else if (hasFinalAnswer) {
    outcome = { kind: "completed" };
  } else {
    outcome = { kind: "failed", error: agent.state.errorMessage ?? "run 未达终局（无 final_answer；faux 脚本耗尽或循环异常收尾）" };
  }

  // ---- TEM Case 收尾落库（写闸；outcome 闭集 v1；失败不阻塞退出码——§3.1 语义）----
  const runId = scopeRefBox.current?.scope_id ?? deps.bindRunId ?? "unknown-run";
  const evidenceIds = (await scanEvidenceEvents(session)).map((event) => event.event_id);
  const modelCalls = agent.state.messages.filter((message) => (message as { role?: string }).role === "assistant").length;
  try {
    await writeExperienceCase(session, {
      kind: "experience_case",
      case_id: `case-${runId}`,
      run_id: runId,
      closed_at: new Date().toISOString(),
      outcome: outcome.kind,
      evidence_event_ids: evidenceIds,
      cost: { model_calls: modelCalls },
      env_fingerprint: envFingerprint(modelTag),
    });
  } catch {
    /* 收尾落库失败不阻塞退出码（TEM 接入设计 §3.1 失败语义） */
  }

  await session.close(BACKGROUND_CONTEXT);

  // ---- 输出与退出码 ----
  switch (outcome.kind) {
    case "completed": {
      const text = (lastAssistant as AssistantMessage).content
        .filter((block) => block.type === "text")
        .map((block) => (block as { text: string }).text)
        .join("");
      deps.out(text);
      break;
    }
    case "approval_missing":
      deps.err(`[v1] 终局 approval_missing（exit 78）：tool=${outcome.tool}——${outcome.reason}`);
      break;
    case "budget_exhausted":
      deps.err(`[v1] 终局 budget_exhausted（exit 1）：turns=${String(outcome.turns_used)}/${String(outcome.max_turns)}（ATF_LOOP_MAX_TURNS 可配）`);
      break;
    case "failed":
      deps.err(`[v1] 终局 failed（exit 1）：${outcome.error}`);
      break;
  }
  return resolveV1ExitCode(outcome);
};

const lastAssistantMessage = (messages: readonly AgentMessage[]): AssistantMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string };
    if (message?.role === "assistant") return messages[index] as AssistantMessage;
  }
  return undefined;
};

// 直跑入口（import 不触发——测试经 runCli 直调）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}
