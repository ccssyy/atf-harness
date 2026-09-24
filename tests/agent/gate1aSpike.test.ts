/**
 * 门 1a spike 测试（批 P；裁定《ATF-Harness_裁定_方案丙立项与批P授权_20260924.md》停止点）。
 *
 * 锚定面（对端 = 契约 mock 内核子进程；模型面 = faux streamFn，零真实 Provider 调用）：
 *   ① 三类决策走通：assistant 文本＋tool_calls 同消息 → tool_call（atf_workspace_status
 *      经 stdio 桥执行、canonical 过）→ final_answer；
 *   ② 审批 before_tool hook——拒径：approval_missing（账本空）拦截＋run 级终止
 *      （headless exit 78 锚语义的库内映射；atf_gate 零触桥执行面）；
 *   ③ 审批 before_tool hook——放行径＋一次性：账本预录 → 查询命中 → consume →
 *      atf_gate 真执行；事后账本无可消费记录；
 *   ④ 孤儿/续跑：session 树注入崩溃半边 → detectOrphanTip → 库 continue() 内建拒绝 →
 *      fork 到最后完整边 → 重建转录 → continue() 续跑收口；
 *   ⑤ TEM 镜像点：afterToolCall → tem/evidence_event custom entry 落库；
 *   ⑥ DeepSeek streamFn 装配形态（一期 wire 经验载体；不触网）。
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import {
  createDeepSeekStreamFn,
  createFauxStreamFn,
  fauxFinalAnswer,
  fauxMessageWithToolCalls,
  runGate1aSpike,
} from "../../src/agent/index.js";
import { assembleDeepSeekModel } from "../../src/agent/deepseekStreamFn.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
const track = (connection: AtfBridgeConnection): AtfBridgeConnection => {
  openConnections.push(connection);
  return connection;
};

afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const runSpike = async (): Promise<Awaited<ReturnType<typeof runGate1aSpike>>> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok, spawned.ok ? "" : JSON.stringify(spawned.error)).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  const connection = track(spawned.value);
  const sessionsRoot = await mkdtemp(join(tmpdir(), "atf-spike-test-"));
  return runGate1aSpike({ bridge: connection, sessionsRoot });
};

describe("门 1a spike（批 P：pi-agent-core Agent＋桥接单工具＋审批 hook）", () => {
  it("① 三类决策走通：message＋tool_calls / tool_call（经桥）/ final_answer", async () => {
    const { checks, events } = await runSpike();
    expect(checks["scenario_a_three_decisions"]).toEqual({
      message_final_answer: true,
      tool_call_executed: true,
      text_with_tool_calls: true,
    });
    // 经桥执行的 workspace_status 结果进了工具结果（canonical 过——mock run 绑定态）
    const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "atf_workspace_status");
    expect(toolEnd !== undefined && toolEnd.type === "tool_execution_end" && !toolEnd.isError).toBe(true);
    expect(
      toolEnd !== undefined && toolEnd.type === "tool_execution_end" && (toolEnd.result as { details?: { run_id?: string } }).details?.run_id,
    ).toBe("mock-run-1");
  });

  it("② 审批拒径：approval_missing 拦截＋run 终止；atf_gate 零触桥执行面", async () => {
    const { approvalAudit } = await runSpike();
    const deny = approvalAudit.find((entry) => entry.verdict === "blocked_approval_missing");
    expect(deny).toBeDefined();
    expect(deny?.tool).toBe("atf_gate");
    expect(deny?.requiresApproval).toBe(true);
  });

  it("③ 审批放行径＋一次性消费：预录 → consume → 真执行；事后账本空", async () => {
    const { approvalAudit, checks } = await runSpike();
    const allow = approvalAudit.find((entry) => entry.verdict === "allow_ledger");
    expect(allow).toBeDefined();
    expect(allow?.tool).toBe("atf_gate");
    expect(checks["scenario_c_allowed"]).toBe(true);
    expect(checks["scenario_c_one_shot"]).toBe(true);
  });

  it("④ 孤儿/续跑：孤儿检测 → 库级拒绝 → fork 恢复 → continue() 续跑收口", async () => {
    const { checks } = await runSpike();
    expect(checks["scenario_d_orphan_detected"]).toMatchObject({ orphan: true });
    expect(checks["scenario_d_continue_refusal"]).toContain("assistant");
    expect(checks["scenario_e_recovered_tail_role"]).toBe("user");
    expect(checks["scenario_e_resumed_events"]).toBeGreaterThan(0);
    expect(checks["scenario_e_resumed_final"]).toContain("孤儿恢复成功");
  });

  it("⑤ TEM 镜像点：afterToolCall → tem/evidence_event 落 JSONL session（文件持久化）", async () => {
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    const connection = track(spawned.value);
    const sessionsRoot = await mkdtemp(join(tmpdir(), "atf-spike-tem-"));
    await runGate1aSpike({ bridge: connection, sessionsRoot });
    const files = await readdir(sessionsRoot, { recursive: true });
    const jsonl = files.filter((name) => name.endsWith(".jsonl"));
    expect(jsonl.length).toBeGreaterThan(0);
    const raw = await readFile(join(sessionsRoot, jsonl[0] as string), "utf8");
    expect(raw).toContain("tem/evidence_event");
    expect(raw).toContain("atf_workspace_status");
  });
});

describe("DeepSeek streamFn 装配（一期 wire 经验载体；零网络）", () => {
  it("⑥ 目录命中＋baseUrl 覆盖（R4 配置保真）；目录未命中 fail-closed", () => {
    const { model } = createDeepSeekStreamFn({ model: "deepseek-flash", base_url: "https://api.deepseek.com", api_key: "" });
    expect(model.provider).toBe("deepseek");
    expect(model.id).toBe("deepseek-flash");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("https://api.deepseek.com");
    expect(() => assembleDeepSeekModel({ model: "no-such-model", base_url: "https://x", api_key: "" })).toThrow(/fail-closed/);
  });

  it("faux streamFn：脚本按序弹出；耗尽 = error 停止原因（fail-closed 不编造）", async () => {
    const streamFn = createFauxStreamFn([fauxFinalAnswer("ok"), fauxMessageWithToolCalls("", [])]);
    expect(streamFn.issued).toBe(0);
    const first = await streamFn({} as never, { messages: [] } as never);
    for await (const event of first) {
      if (event.type === "done") {
        expect(event.reason).toBe("stop");
        break;
      }
    }
    expect(streamFn.issued).toBe(1);
    const third = await streamFn({} as never, { messages: [] } as never);
    for await (const event of third) {
      if (event.type === "error") {
        expect(event.error.stopReason).toBe("error");
        expect(event.error.errorMessage).toContain("faux 脚本耗尽");
        break;
      }
    }
    expect(streamFn.issued).toBe(2);
    expect(fauxFinalAnswer("x").stopReason).toBe("stop");
  });
});
