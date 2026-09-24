/**
 * 丙 v1 测试（批 P）：九工具全挂接／点号方法映射／审批 hook 全 face／预算护栏／headless
 * CLI e2e（退出码 0/78/1）。对端 = 契约 mock 内核子进程；模型面 = faux 脚本（零真实调用）。
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { TOOL_NAMES } from "../../src/core/tools/index.js";
import { buildAtfAgentTools, type SpikeBridgeTransport } from "../../src/agent/atfAgentTools.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "../../src/agent/approvalHook.js";
import { createBudgetFinishTurn, maxTurnsFromEnv, resolveV1ExitCode } from "../../src/agent/budget.js";
import { parseFauxScript } from "../../src/agent/fauxScript.js";
import { parseCliArgs, runCli, runV1Headless } from "../../src/agent/cli.js";
import type { AgentMessage, AgentTurnContext } from "@earendil-works/pi-agent-core";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const spawnMock = async (): Promise<SpikeBridgeTransport> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

describe("丙 v1：九工具全挂接与点号方法映射", () => {
  it("① 全 face 装配：九工具、名字面 = TOOL_NAMES；按 names 过滤（spike 双工具）", async () => {
    const bridge = await spawnMock();
    const tools = buildAtfAgentTools({ bridge, scopeRefBox: { current: undefined } });
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(9);
    const filtered = buildAtfAgentTools({ bridge, scopeRefBox: { current: undefined } }, { names: ["atf_workspace_status"] });
    expect(filtered.map((tool) => tool.name)).toEqual(["atf_workspace_status"]);
  });

  it("② 点号方法映射：五个点号 RPC 方法经适配层正确映射（桥面捕获）", async () => {
    const seen: string[] = [];
    const stubBridge: SpikeBridgeTransport = {
      request: async (method) => {
        seen.push(method);
        if (method === "atf_preparation.propose") {
          return { ok: true, value: { ok: true, dataset_id: "ds", pin: "p", fact_id: "f", stage: "split_confirmation", cluster_material: "absent", explanation: {}, human_summary: {} } };
        }
        return { ok: false, error: { code: "request_rejected", message: "x", detail: { code: "dataset_not_registered" } } } as never;
      },
    };
    const tools = buildAtfAgentTools({ bridge: stubBridge, scopeRefBox: { current: undefined } });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await (byName.get("atf_preparation_propose") as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("t", { dataset_id: "ds" });
    await (byName.get("atf_data_admission_request") as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("t", { dataset_id: "ds" });
    await (byName.get("atf_label_qc_inspect") as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("t", { dataset_id: "ds" });
    expect(seen).toEqual(["atf_preparation.propose", "atf_data_admission.request", "atf_label_qc.inspect"]);
  });

  it("③ 审批 hook 全 face：写类（admit_data）无 scope_ref 拦截；只读（fact_scan）直通", async () => {
    const bridge = await spawnMock();
    const audit: ApprovalAuditEntry[] = [];
    const hook = createApprovalBeforeToolCall({ bridge, scopeRefBox: { current: undefined }, audit });
    const blocked = await hook({
      toolCall: { id: "t1", name: "atf_admit_data", arguments: { dataset_id: "ds-x", source_ref: "s" } },
      args: { dataset_id: "ds-x", source_ref: "s" },
    } as unknown as Parameters<typeof hook>[0]);
    expect(blocked?.block).toBe(true);
    expect(audit[0]?.verdict).toBe("blocked_scope_ref_missing");
    const allowed = await hook({
      toolCall: { id: "t2", name: "atf_fact_scan", arguments: {} },
      args: {},
    } as unknown as Parameters<typeof hook>[0]);
    expect(allowed).toBeUndefined(); // 只读直通
    expect(audit[1]?.verdict).toBe("allow_readonly");
  });
});

describe("丙 v1：预算护栏（finishTurn hook 化）", () => {
  it("④ env 解析：正整数生效，未设/空/非法 fail-closed 回退 8", () => {
    expect(maxTurnsFromEnv({} as NodeJS.ProcessEnv)).toBe(8);
    expect(maxTurnsFromEnv({ ATF_LOOP_MAX_TURNS: "" } as NodeJS.ProcessEnv)).toBe(8);
    expect(maxTurnsFromEnv({ ATF_LOOP_MAX_TURNS: "abc" } as NodeJS.ProcessEnv)).toBe(8);
    expect(maxTurnsFromEnv({ ATF_LOOP_MAX_TURNS: "0" } as NodeJS.ProcessEnv)).toBe(8);
    expect(maxTurnsFromEnv({ ATF_LOOP_MAX_TURNS: "3" } as NodeJS.ProcessEnv)).toBe(3);
  });

  it("⑤ finishTurn 计数：带工具调用 turn 达上限 → end＋budget_exhausted；收束 turn 不拦", () => {
    const outcomeBox: { current: Parameters<ReturnType<typeof createBudgetFinishTurn>> extends never ? never : import("../../src/agent/budget.js").V1RunOutcome | undefined } = { current: undefined };
    const finishTurn = createBudgetFinishTurn({ maxTurns: 2, outcomeBox });
    const makeTurn = (assistantCount: number, withToolCalls: boolean): AgentTurnContext =>
      ({
        message: {
          role: "assistant",
          content: withToolCalls ? [{ type: "toolCall", id: "t", name: "atf_fact_scan", arguments: {} }] : [{ type: "text", text: "done" }],
        },
        toolResults: [],
        context: {
          messages: Array.from({ length: assistantCount }, () => ({ role: "assistant", content: [] }) as unknown as AgentMessage),
        },
        newMessages: [],
      }) as unknown as AgentTurnContext;
    expect(finishTurn(makeTurn(1, true))).toBeUndefined(); // turn 1/2 — 继续
    const decision = finishTurn(makeTurn(2, true));
    expect(decision).toEqual({ action: "end" }); // turn 2/2 达上限 → 终止
    expect(outcomeBox.current).toMatchObject({ kind: "budget_exhausted", turns_used: 2, max_turns: 2 });
    expect(finishTurn(makeTurn(3, false))).toBeUndefined(); // 收束 turn 不拦（防御：预算已触发后不再可达）
  });

  it("⑥ 退出码映射：0/78/1 单一出口", () => {
    expect(resolveV1ExitCode({ kind: "completed" })).toBe(0);
    expect(resolveV1ExitCode({ kind: "approval_missing", tool: "atf_gate", reason: "x" })).toBe(78);
    expect(resolveV1ExitCode({ kind: "budget_exhausted", turns_used: 8, max_turns: 8 })).toBe(1);
    expect(resolveV1ExitCode({ kind: "failed", error: "x" })).toBe(1);
  });
});

describe("丙 v1：headless CLI e2e（mock 对端＋faux 脚本）", () => {
  const writeScript = async (steps: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "v1-cli-"));
    const path = join(dir, "script.json");
    await writeFile(path, steps, "utf8");
    return path;
  };

  it("⑦ completed：status 经桥 → final_answer，exit 0，stdout 承载 final", async () => {
    const bridge = await spawnMock();
    const script = await writeScript(JSON.stringify([
      { text: "先查状态。", toolCalls: [{ id: "c1", name: "atf_workspace_status", arguments: {} }] },
      { final: "工作区就绪：0 批已登记，可开始准入。" },
    ]));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli({
      argv: ["--instruction", "查询工作区状态", "--llm", `faux:${script}`, "--sessions-root", await mkdtemp(join(tmpdir(), "v1-s-"))],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    void bridge;
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("工作区就绪");
  });

  it("⑧ approval_missing：status 取 scope_ref → gate advance 无预录 → 拦截终止，exit 78（ADR-07 锚）", async () => {
    const bridge = await spawnMock();
    void bridge;
    const script = await writeScript(JSON.stringify([
      { text: "先查状态。", toolCalls: [{ id: "c1", name: "atf_workspace_status", arguments: {} }] },
      { text: "推进 G1。", toolCalls: [{ id: "c2", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }] },
      { final: "不应到达" },
    ]));
    const err: string[] = [];
    const code = await runCli({
      argv: ["--instruction", "推进 G1", "--llm", `faux:${script}`, "--sessions-root", await mkdtemp(join(tmpdir(), "v1-s-"))],
      out: () => undefined,
      err: (line) => err.push(line),
    });
    expect(code).toBe(78);
    expect(err.join("\n")).toContain("approval_missing");
  });

  it("⑨ budget_exhausted：max-turns=1 且首 turn 带工具调用 → 收口 exit 1", async () => {
    const bridge = await spawnMock();
    void bridge;
    const script = await writeScript(JSON.stringify([
      { text: "先查状态。", toolCalls: [{ id: "c1", name: "atf_workspace_status", arguments: {} }] },
      { final: "不应到达" },
    ]));
    const err: string[] = [];
    const code = await runCli({
      argv: ["--instruction", "查询状态", "--llm", `faux:${script}`, "--max-turns", "1", "--sessions-root", await mkdtemp(join(tmpdir(), "v1-s-"))],
      out: () => undefined,
      err: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("budget_exhausted");
  });

  it("⑩ 真实调用门控：--llm deepseek 未授权 → fail-closed 拒启（exit 1）", async () => {
    const code = await runCli({
      argv: ["--instruction", "x", "--llm", "deepseek"],
      env: {} as NodeJS.ProcessEnv,
      out: () => undefined,
      err: () => undefined,
    });
    expect(code).toBe(1);
  });

  it("⑪ 参数面：--instruction 缺失/--llm 缺失/未知参数 fail-closed", () => {
    expect(parseCliArgs([])).toHaveProperty("error");
    expect(parseCliArgs(["--instruction", "x"])).toHaveProperty("error");
    expect(parseCliArgs(["--instruction", "x", "--llm", "bogus"])).toHaveProperty("error");
    expect(parseCliArgs(["--instruction", "x", "--llm", "faux:/tmp/s.json", "--wat"])).toHaveProperty("error");
    const ok = parseCliArgs(["--instruction", "x", "--llm", "faux:/tmp/s.json"]);
    expect(ok).toMatchObject({ instruction: "x", peer: "mock" });
  });

  it("⑫ faux 脚本解析：final 形/toolCalls 形/非法形态 fail-closed", () => {
    const parsed = parseFauxScript(JSON.stringify([
      { text: "t", toolCalls: [{ id: "c", name: "atf_fact_scan", arguments: {} }] },
      { final: "done" },
    ]));
    expect(parsed).toHaveLength(2);
    expect(() => parseFauxScript(JSON.stringify([{ text: "无工具无收束" }]))).toThrow(/fail-closed/);
    expect(() => parseFauxScript('{"not":"array"}')).toThrow(/数组/);
  });
});
