/**
 * 丙 v1（批 P＋批 P 增补）——ATF KIE Training Agent headless CLI（唯一产品入口；pi-tui
 * 三期并入）。
 *
 * 装配（assembleV1Agent 单点；批 P 增补 A/B 清单接线）：
 *   A1 九工具经桥／A2 审批账本闸＋问答轨四 verdict（确认卡 surface；75/79）／
 *   A3 EvidenceEvent 镜像／A4 TEM 检索注入／A5 headless CLI／A6 GLM 目录参数化
 *   （--llm config 走 HarnessLlmConfig/v3 两层清单）；B1 steering/followUp 双队列／
 *   B2 abort/waitForIdle/reset 生命周期（Agent 内建，句柄暴露）／B3 compaction
 *   （transformContext 折叠）／B4 hook 注册面 8 名／B5 skills/templates 系统提示 sections／
 *   B6 审批窗口输入缓冲（B1 队列承载——surface pending 期间 steer 入队不丢弃）。
 *
 * 模型面（红线：真实 Provider 调用需 owner 另批）：
 *   --llm faux:<script.json>   脚本化 faux（测试/演示；零网络）
 *   --llm deepseek             env 直配（ATF_V1_REAL_LLM_AUTHORIZED=1＋DEEPSEEK_API_KEY）
 *   --llm config               HarnessLlmConfig/v3 两层清单（ATF_LLM_CONFIG；provider 目录
 *                              参数化——GLM/DeepSeek 同路径；批 P 增补 §一）
 *
 * 退出码（ADR-07 锚不挪用）：0=completed；78=approval_missing；75=suspended（未决非否决）；
 * 79=aborted（人中止）；1=预算耗尽/故障。
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Agent, BACKGROUND_CONTEXT, type AgentEvent, type AgentMessage, type QueueMode } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TranscriptContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AtfBridgeConnection } from "../bridge/connection.js";
import { deriveAtfCommand } from "../bridge/atfCommand.js";
import { HARNESS_SYSTEM_PROMPT } from "../llm/systemPrompt.js";
import { loadLlmProviderConfig, type ResolvedLlmProviderConfig } from "../llm/providerConfig.js";
import { buildAtfAgentTools, type SpikeBridgeTransport } from "./atfAgentTools.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "./approvalHook.js";
import { createInteractiveApprovalSurface, type ApprovalSurface } from "./approvalSurface.js";
import { createBudgetFinishTurn, maxTurnsFromEnv, resolveV1ExitCode, type V1RunOutcome } from "./budget.js";
import { createProviderStreamFn } from "./providerStreamFn.js";
import { createScriptedStreamFn, loadFauxScript } from "./fauxScript.js";
import { createHookRegistry, prepareRequestViaHook, wireEventHooks, V1_HOOK_NAMES, type V1HookRegistry } from "./hooks.js";
import { createJsonlSessionRepo, type SessionLike } from "./sessionMirror.js";
import { createTemAfterToolMirror, createTemTransformContext } from "./tem/retrieval.js";
import { envFingerprint, scanEvidenceEvents } from "./tem/evidence.js";
import { ensureTemBranch, writeExperienceCase } from "./tem/store.js";
import { buildSkillsSystemSuffix, createCompactionTransform } from "./agentCapabilities.js";

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface CliArgs {
  instruction: string;
  peer: "mock" | "real";
  wsRoot?: string;
  sessionsRoot?: string;
  llm: { kind: "faux"; scriptPath: string } | { kind: "deepseek" } | { kind: "config" };
  maxTurns?: number;
  approval: "headless" | "interactive";
  approvalTimeoutMs: number;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  skillsDir?: string;
  contextTokens: number;
  keepRecentTokens: number;
}

export const parseCliArgs = (argv: readonly string[]): CliArgs | { error: string } => {
  let instruction: string | undefined;
  let peer: "mock" | "real" = "mock";
  let wsRoot: string | undefined;
  let sessionsRoot: string | undefined;
  let llm: CliArgs["llm"] | undefined;
  let maxTurns: number | undefined;
  let approval: "headless" | "interactive" = "headless";
  let approvalTimeoutMs = 120_000;
  let steeringMode: QueueMode = "all";
  let followUpMode: QueueMode = "all";
  let skillsDir: string | undefined;
  let contextTokens = 24_000;
  let keepRecentTokens = 8_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (): string => {
      i += 1;
      return argv[i] as string;
    };
    const takeQueueMode = (flag: string): QueueMode | { error: string } => {
      const value = take();
      if (value !== "all" && value !== "one-at-a-time") return { error: `${flag} 非法: ${value}（all | one-at-a-time）` };
      return value;
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
        if (value === "deepseek" || value === "config") llm = { kind: value };
        else if (value.startsWith("faux:")) llm = { kind: "faux", scriptPath: value.slice("faux:".length) };
        else return { error: `--llm 非法: ${value}（faux:<script.json> | deepseek | config）` };
        break;
      }
      case "--max-turns": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1) return { error: "--max-turns 须为正整数" };
        maxTurns = value;
        break;
      }
      case "--approval": {
        const value = take();
        if (value !== "headless" && value !== "interactive") return { error: `--approval 非法: ${value}（headless | interactive）` };
        approval = value;
        break;
      }
      case "--approval-timeout-ms": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1) return { error: "--approval-timeout-ms 须为正整数" };
        approvalTimeoutMs = value;
        break;
      }
      case "--steering-mode": {
        const parsed = takeQueueMode("--steering-mode");
        if (typeof parsed !== "string") return parsed;
        steeringMode = parsed;
        break;
      }
      case "--follow-up-mode": {
        const parsed = takeQueueMode("--follow-up-mode");
        if (typeof parsed !== "string") return parsed;
        followUpMode = parsed;
        break;
      }
      case "--skills-dir":
        skillsDir = take();
        break;
      case "--context-tokens": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 100) return { error: "--context-tokens 须为 ≥100 的整数" };
        contextTokens = value;
        break;
      }
      case "--keep-recent-tokens": {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 100) return { error: "--keep-recent-tokens 须为 ≥100 的整数" };
        keepRecentTokens = value;
        break;
      }
      default:
        return { error: `未知参数: ${arg ?? "(空)"}` };
    }
  }
  if (instruction === undefined || instruction.trim() === "") return { error: "--instruction 必填（非空）" };
  if (llm === undefined) return { error: "--llm 必填（faux:<script.json> | deepseek | config；真实调用须 owner 另批授权——env ATF_V1_REAL_LLM_AUTHORIZED=1）" };
  return { instruction, peer, wsRoot, sessionsRoot, llm, maxTurns, approval, approvalTimeoutMs, steeringMode, followUpMode, skillsDir, contextTokens, keepRecentTokens };
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

  // ---- 模型面选择（红线门控；批 P 增补 §一：provider 目录参数化）----
  let scripted: AssistantMessage[] | undefined;
  let resolvedConfig: ResolvedLlmProviderConfig | undefined;
  if (args.llm.kind === "faux") {
    try {
      scripted = await loadFauxScript(args.llm.scriptPath);
    } catch (cause) {
      err(`[v1] faux 脚本加载失败（fail-closed）: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  } else if (args.llm.kind === "deepseek") {
    const authorized = env["ATF_V1_REAL_LLM_AUTHORIZED"] === "1" || env["ATF_V1_DEEPSEEK_AUTHORIZED"] === "1";
    const apiKey = env["DEEPSEEK_API_KEY"]?.trim() ?? "";
    if (!authorized || apiKey === "") {
      err("[v1] 真实 DeepSeek 调用未授权（fail-closed）：需 owner 另批授权（env ATF_V1_REAL_LLM_AUTHORIZED=1）且配置 DEEPSEEK_API_KEY——本批红线：真实 Provider 调用按需另批");
      return 1;
    }
  } else {
    const authorized = env["ATF_V1_REAL_LLM_AUTHORIZED"] === "1" || env["ATF_V1_DEEPSEEK_AUTHORIZED"] === "1";
    if (!authorized || env["ATF_LLM_CONFIG"]?.trim() === "" || env["ATF_LLM_CONFIG"] === undefined) {
      err("[v1] 真实模型调用未授权（fail-closed）：需 owner 另批授权（env ATF_V1_REAL_LLM_AUTHORIZED=1）且设置 ATF_LLM_CONFIG（HarnessLlmConfig/v3；provider 目录参数化——批 P 增补 §一）");
      return 1;
    }
    const resolved = await loadLlmProviderConfig(env);
    if (!resolved.ok) {
      err(`[v1] LLM 配置解析失败（fail-closed）: ${resolved.error.message}`);
      return 1;
    }
    resolvedConfig = resolved.value;
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

  try {
    return await runV1Headless({
      bridge,
      sessionsRoot,
      instruction: args.instruction,
      maxTurns,
      ...(scripted !== undefined ? { scripted } : {}),
      providerConfig:
        args.llm.kind === "deepseek"
          ? {
              provider_id: "deepseek",
              model: env["DEEPSEEK_MODEL"]?.trim() || "deepseek-flash",
              base_url: env["DEEPSEEK_BASE_URL"]?.trim() || "https://api.deepseek.com",
              api_key: env["DEEPSEEK_API_KEY"]?.trim() ?? "",
            }
          : resolvedConfig !== undefined
            ? { provider_id: resolvedConfig.provider_id, model: resolvedConfig.model, base_url: resolvedConfig.base_url, api_key: resolvedConfig.api_key }
            : undefined,
      bindRunId,
      approval: args.approval === "interactive" ? { kind: "interactive", timeoutMs: args.approvalTimeoutMs } : { kind: "headless" },
      steeringMode: args.steeringMode,
      followUpMode: args.followUpMode,
      skillsDir: args.skillsDir,
      contextTokens: args.contextTokens,
      keepRecentTokens: args.keepRecentTokens,
      out,
      err,
    });
  } finally {
    await spawned.value.close({ timeoutMs: 5_000 }).catch(() => undefined);
  }
};

// ---------------------------------------------------------------- v1 装配单点

export interface AssembleV1Deps {
  bridge: SpikeBridgeTransport;
  session: SessionLike;
  maxTurns: number;
  streamFn: (model: never, context: TranscriptContext, options?: SimpleStreamOptions) => unknown;
  modelTag: string;
  approval: { kind: "headless" } | { kind: "interactive"; timeoutMs: number } | { kind: "surface"; surface: ApprovalSurface };
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  systemSuffix?: string;
  contextTokens: number;
  keepRecentTokens: number;
}

export interface AssembledV1Agent {
  agent: Agent;
  audit: ApprovalAuditEntry[];
  outcomeBox: { current: V1RunOutcome | undefined };
  scopeRefBox: { current: import("../core/tools/approvalKey.js").ScopeRef | undefined };
  registry: V1HookRegistry;
  events: AgentEvent[];
  runId: () => string | null;
}

/** v1 Agent 装配单点（批 P 增补 A/B 清单全部接线；B2 生命周期＝句柄上的 Agent 内建方法）。 */
export const assembleV1Agent = (deps: AssembleV1Deps): AssembledV1Agent => {
  const scopeRefBox: { current: import("../core/tools/approvalKey.js").ScopeRef | undefined } = { current: undefined };
  const audit: ApprovalAuditEntry[] = [];
  const outcomeBox: { current: V1RunOutcome | undefined } = { current: undefined };
  const events: AgentEvent[] = [];
  const tools = buildAtfAgentTools({ bridge: deps.bridge, scopeRefBox });
  const registry = createHookRegistry();

  const runId = (): string | null => scopeRefBox.current?.scope_id ?? null;
  const surface: ApprovalSurface | undefined =
    deps.approval.kind === "surface"
      ? deps.approval.surface
      : deps.approval.kind === "interactive"
        ? createInteractiveApprovalSurface({ timeoutMs: deps.approval.timeoutMs })
        : undefined;

  // B4：hook 注册面 8 名实际注册（缺省观测体；调用方可经 registry.register 追加）——
  // before_run（prompt 前）／before_drive（agent_start）／before_run_end（agent_end）／
  // transform_context（链所有权在下方组合 transform）／before_request（prepareRequest 桥）／
  // before_payload／after_response（Agent onPayload/onResponse 缝）／before_compaction（折叠闸）。
  for (const name of V1_HOOK_NAMES) {
    registry.register(name, () => undefined);
  }
  const compactionTransform = createCompactionTransform({
    contextTokenLimit: deps.contextTokens,
    keepRecentTokens: deps.keepRecentTokens,
    registry,
  });
  const temTransform = createTemTransformContext({ session: deps.session });
  const transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const compacted = await compactionTransform(messages);
    const injected = await temTransform(compacted);
    await registry.invoke("transform_context", { messages: injected.length });
    return injected;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: deps.systemSuffix !== undefined ? `${HARNESS_SYSTEM_PROMPT}\n${deps.systemSuffix}` : HARNESS_SYSTEM_PROMPT,
      tools,
    },
    streamFn: deps.streamFn as never,
    beforeToolCall: createApprovalBeforeToolCall({ bridge: deps.bridge, scopeRefBox, audit, ...(surface !== undefined ? { surface } : {}) }),
    afterToolCall: createTemAfterToolMirror({ session: deps.session, runId, model: envFingerprint(deps.modelTag).model }),
    transformContext,
    prepareRequest: prepareRequestViaHook(registry),
    onPayload: (payload: unknown) => {
      void registry.invoke("before_payload", { bytes: JSON.stringify(payload ?? {}).length });
    },
    onResponse: (message: unknown) => {
      void registry.invoke("after_response", { stopReason: (message as { stopReason?: string }).stopReason ?? null });
    },
    finishTurn: createBudgetFinishTurn({ maxTurns: deps.maxTurns, outcomeBox }),
    steeringMode: deps.steeringMode,
    followUpMode: deps.followUpMode,
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    events.push(event);
  });
  wireEventHooks((listener) => agent.subscribe(listener), registry);

  return { agent, audit, outcomeBox, scopeRefBox, registry, events, runId };
};

export interface V1HeadlessDeps {
  bridge: SpikeBridgeTransport;
  sessionsRoot: string;
  instruction: string;
  maxTurns: number;
  /** faux 脚本（与真实 provider 二选一；调用方已做红线门控）。 */
  scripted?: AssistantMessage[];
  providerConfig?: { provider_id: string; model: string; base_url: string; api_key: string };
  bindRunId?: string;
  approval: { kind: "headless" } | { kind: "interactive"; timeoutMs: number } | { kind: "surface"; surface: ApprovalSurface };
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  skillsDir?: string;
  contextTokens: number;
  keepRecentTokens: number;
  /** 装配后、prompt 前的注册缝（测试/扩展注册 hook；B4 面）。 */
  registerHooks?: (registry: V1HookRegistry) => void;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** v1 headless 单 run（装配方；测试直用）。返回退出码。 */
export const runV1Headless = async (deps: V1HeadlessDeps): Promise<number> => {
  const repo = createJsonlSessionRepo(deps.sessionsRoot);
  const session = await repo.create({ cwd: deps.sessionsRoot }, BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  const modelTag = deps.providerConfig?.model ?? "faux-script";

  const streamFn =
    deps.scripted !== undefined
      ? createScriptedStreamFn(deps.scripted)
      : createProviderStreamFn(deps.providerConfig as { provider_id: string; model: string; base_url: string; api_key: string }).streamFn;

  const systemSuffix = deps.skillsDir !== undefined ? await buildSkillsSystemSuffix(deps.skillsDir) : undefined;
  const assembled = assembleV1Agent({
    bridge: deps.bridge,
    session,
    maxTurns: deps.maxTurns,
    streamFn,
    modelTag,
    approval: deps.approval,
    steeringMode: deps.steeringMode,
    followUpMode: deps.followUpMode,
    ...(systemSuffix !== undefined ? { systemSuffix } : {}),
    contextTokens: deps.contextTokens,
    keepRecentTokens: deps.keepRecentTokens,
  });
  const { agent, audit, outcomeBox, scopeRefBox, registry } = assembled;
  deps.registerHooks?.(registry);

  await registry.invoke("before_run", { instruction: deps.instruction });
  let failure: string | undefined;
  try {
    await agent.prompt(deps.instruction);
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }

  // ---- 终局判定（闭集；次序＝人中止/挂起/审批缺失 优先于 预算/故障——ADR-07 锚语义）----
  const lastAssistant = lastAssistantMessage(agent.state.messages);
  const hasFinalAnswer = lastAssistant !== undefined && !lastAssistant.content.some((block) => block.type === "toolCall");
  let outcome: V1RunOutcome;
  const terminalAudit = [...audit].reverse().find((entry) => ["aborted", "suspended", "blocked_approval_missing"].includes(entry.verdict));
  if (terminalAudit !== undefined && !hasFinalAnswer) {
    outcome =
      terminalAudit.verdict === "aborted"
        ? { kind: "aborted", tool: terminalAudit.tool, reason: "操作员中止（确认卡 abort）" }
        : terminalAudit.verdict === "suspended"
          ? { kind: "suspended", tool: terminalAudit.tool, reason: "操作员未决——超时非否决（75）" }
          : { kind: "approval_missing", tool: terminalAudit.tool, reason: "审批缺失：账本无可消费记录（headless exit 78 锚语义）" };
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
    case "suspended":
      deps.err(`[v1] 终局 suspended（exit 75）：tool=${outcome.tool}——${outcome.reason}`);
      break;
    case "aborted":
      deps.err(`[v1] 终局 aborted（exit 79）：tool=${outcome.tool}——${outcome.reason}`);
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
