import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { MockDigestResolver, SessionLog } from "../../src/session/index.js";
import {
  createApprovalTrackHandler,
  readStreamMaxId,
  type ApprovalStubResponse,
} from "../../src/run/index.js";
import { ToolExecutor, ToolRegistry, type ApprovalTrackVerdict, type BridgeTransport } from "../../src/tools/index.js";
import type { SessionEvent } from "../../src/session/index.js";

/**
 * P2-S2 问答轨编排器测试(handler 级,决议 §3 验收:R1 resume 可执行性 / R2 持久化前置 /
 * 六类分支 / 拒绝循环 / supersedes 演化链 / 凭据 fails-closed)。
 */

const resolver = MockDigestResolver.withDigests([]);
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "atf-s2-track-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

interface Harness {
  handler: ReturnType<typeof createApprovalTrackHandler>;
  events: SessionEvent[];
  session: SessionLog;
  watermark: () => number;
  flushCalls: () => number;
  setFlushFail: (message: string | null) => void;
  /** 追加一条 tool/call 事件并返回其 id(供 handler 的 tool_call_id 引用) */
  appendCall: () => Promise<number>;
}

const makeHarness = async (stub: (input: { round: number; attempt: number }) => Promise<ApprovalStubResponse>, seed?: (append: (input: Parameters<SessionLog["append"]>[0]) => Promise<void>) => Promise<void>): Promise<Harness> => {
  const path = join(workDir, "session.jsonl");
  const created = await SessionLog.create(path, resolver);
  if (!created.ok) throw new Error("unreachable");
  const session = created.value;

  const events: SessionEvent[] = [];
  const append = async (input: Parameters<SessionLog["append"]>[0]): Promise<void> => {
    const appended = await session.append(input);
    if (!appended.ok) throw new Error(`种子落盘失败: ${appended.error.message}`);
    events.push(appended.value.event);
  };
  if (seed === undefined) {
    // 默认预置一条 tool/call(id 1),handler 的 tool_call_id 由此可回溯
    await append({ type: "tool/call", payload: { tool: "atf_admit_data", params: { dataset_id: "ds-1" } } });
  } else {
    await seed(append);
  }

  const recoveryWatermark = await readStreamMaxId(() =>
    readFile(path, "utf8").then(
      (text) => text,
      () => "",
    ),
  );
  let flushCalls = 0;
  let flushFail: string | null = null;
  const handler = createApprovalTrackHandler({
    appendEvent: async (input) => {
      const appended = await session.append(input);
      if (!appended.ok) return null;
      if (appended.value.status === "appended") events.push(appended.value.event);
      return appended.value.event;
    },
    events,
    flush: async () => {
      flushCalls += 1;
      return flushFail === null ? { ok: true } : { ok: false, message: flushFail };
    },
    recoveryWatermark,
    stub: (input) => stub(input),
  });
  return {
    handler,
    events,
    session,
    watermark: () => recoveryWatermark,
    flushCalls: () => flushCalls,
    setFlushFail: (message) => {
      flushFail = message;
    },
    appendCall: async () => {
      await append({ type: "tool/call", payload: { tool: "atf_admit_data", params: { dataset_id: "ds-1" } } });
      return (events[events.length - 1] as SessionEvent).id;
    },
  };
};

/** 桩脚本:按序出应答,耗尽后恒 timeout。 */
const scriptStub = (responses: ApprovalStubResponse[]) => {
  let i = 0;
  return async (): Promise<ApprovalStubResponse> => {
    const next = responses[i];
    i += 1;
    return next ?? { verdict: "timeout" };
  };
};

const call = (h: Harness, toolCallId = 1) =>
  h.handler({ tool: "atf_admit_data", params: { dataset_id: "ds-1" }, approval_key: "k-admit-ds1", tool_call_id: toolCallId });

describe("granted——放行与持久化前置(R2)", () => {
  it("首次 granted:落 request/response,放行前 flush 被调用(R2)", async () => {
    const h = await makeHarness(scriptStub([{ verdict: "granted", actor: "stub-host" }]));
    const verdict = await call(h);
    expect(verdict.kind).toBe("granted");
    expect(h.flushCalls()).toBe(1);
    const types = h.events.map((event) => event.type);
    expect(types).toEqual(["tool/call", "approval/request", "approval/response"]); // 首条 tool/call 为预置种子
    expect(h.events[1]?.payload).toMatchObject({ approval_session_id: "aps-1", attempt: 1, tool: "atf_admit_data" });
    expect(h.events[2]?.payload).toMatchObject({ verdict: "granted", actor: "stub-host", request_event_ref: h.events[1]?.id });
  });

  it("flush 失败 → 不放行(credential_persist_failed,fail-closed)", async () => {
    const h = await makeHarness(scriptStub([{ verdict: "granted" }]));
    h.setFlushFail("注入:刷盘失败");
    const verdict = await call(h);
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind !== "blocked") return;
    expect(verdict.block.reason).toBe("credential_persist_failed");
    // 未产生可放行状态:再次调用(重入)仍不得执行
    const again = await call(h);
    expect(again.kind).toBe("blocked");
  });
});

describe("R1——resume 可执行性(恢复后注入 granted 不被窗口策略误杀)", () => {
  const seedSuspended = async (append: (input: Parameters<SessionLog["append"]>[0]) => Promise<void>): Promise<void> => {
    // 挂起时点流:call(1) → request(2) → response(timeout, harness)(3)
    await append({ type: "tool/call", payload: { tool: "atf_admit_data", params: { dataset_id: "ds-1" } } });
    await append({
      type: "approval/request",
      payload: { approval_session_id: "aps-1", tool_call_id: 1, tool: "atf_admit_data", params: { dataset_id: "ds-1" }, approval_key: "k-admit-ds1", attempt: 1 },
    });
    await append({ type: "approval/response", payload: { approval_session_id: "aps-1", request_event_ref: 2, verdict: "timeout", actor: "harness" } });
  };

  it("恢复后 resume(answer) 注入 granted(id > 水位线)→ 判 available 放行,不重复问询", async () => {
    const h = await makeHarness(async () => {
      throw new Error("恢复放行路径不得再问询桩对端");
    }, seedSuspended);
    // resume(answer):应答注入落盘(事件 id 4 > 水位线)——并同步 run 层内存序列(模拟 append 包装)
    const injected = await h.session.append({
      type: "approval/response",
      payload: { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-host" },
    });
    expect(injected.ok).toBe(true);
    if (injected.ok && injected.value.status === "appended") h.events.push(injected.value.event);
    expect(h.watermark()).toBe(3); // A2:水位线固定于恢复时刻

    const verdict = await call(h);
    expect(verdict.kind).toBe("granted"); // available → 放行
    const requestCount = h.events.filter((event) => event.type === "approval/request").length;
    expect(requestCount).toBe(1); // 未发新 request
  });

  it("旧遗留 granted(id ≤ 水位线)→ indeterminate 终态:exit 语义 1 + 五字段上报材料", async () => {
    const h = await makeHarness(scriptStub([{ verdict: "granted" }]), async (append) => {
      await append({ type: "tool/call", payload: { tool: "atf_admit_data", params: { dataset_id: "ds-1" } } });
      await append({
        type: "approval/request",
        payload: { approval_session_id: "aps-1", tool_call_id: 1, tool: "atf_admit_data", params: { dataset_id: "ds-1" }, approval_key: "k-admit-ds1", attempt: 1 },
      });
      await append({ type: "approval/response", payload: { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-host" } });
    });
    const verdict = await call(h);
    expect(verdict.kind).toBe("blocked");
    if (verdict.kind !== "blocked") return;
    expect(verdict.block.reason).toBe("credential_indeterminate");
    expect(verdict.block.exit_code).toBe(1);
    const detail = verdict.block.detail as { credential: { approval_session_id: string }; approval_key: string; window: { granted_id: number; watermark: number } };
    expect(detail.credential.approval_session_id).toBe("aps-1");
    expect(detail.approval_key).toBe("k-admit-ds1");
    expect(detail.window).toEqual({ granted_id: 3, watermark: 3 });
  });
});

describe("denied / 拒绝循环升级(阈值 2,第 3 次提案触发)", () => {
  it("两次 denied 后重提:第 3 次提案升级 aborted(denial_loop),不落伪造应答", async () => {
    const responses: ApprovalStubResponse[] = [
      { verdict: "denied", reason: "参数不全" },
      { verdict: "denied", reason: "仍不全" },
    ];
    const h = await makeHarness(scriptStub(responses));
    const first = await call(h);
    expect(first.kind).toBe("denied");
    const second = await call(h);
    expect(second.kind).toBe("denied");
    const third = await call(h);
    expect(third.kind).toBe("aborted");
    if (third.kind !== "aborted") return;
    expect(third.block.reason).toBe("approval_aborted");
    expect(third.block.exit_code).toBe(79);
    expect(third.block.message).toContain("拒绝循环升级");
    // 第 3 次提案未落 request(只有前两次的 2 条 request)
    expect(h.events.filter((event) => event.type === "approval/request")).toHaveLength(2);
  });
});

describe("advised——重提案与 supersedes 演化链", () => {
  it("advised → reproposal(非终局);重提案 request 带 supersedes;granted 后链可审计", async () => {
    const h = await makeHarness(
      scriptStub([
        { verdict: "advised", actor: "stub-host", advice_text: "dataset_id 请用正式编号" },
        { verdict: "granted", actor: "stub-host" },
      ]),
    );
    const first = await call(h);
    expect(first.kind).toBe("reproposal");
    if (first.kind !== "reproposal") return;
    expect((first.block.detail as { advice_text: string }).advice_text).toContain("正式编号");

    // 模型重新提案(同 proposal key,新 tool_call_id)
    const call2 = await h.appendCall();
    const second = await h.handler({ tool: "atf_admit_data", params: { dataset_id: "ds-1" }, approval_key: "k-admit-ds1", tool_call_id: call2 });
    expect(second.kind).toBe("granted");

    const requests = h.events.filter((event) => event.type === "approval/request");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.payload).toMatchObject({ attempt: 1 });
    expect(requests[0]?.payload).not.toHaveProperty("supersedes");
    expect(requests[1]?.payload).toMatchObject({ attempt: 2, supersedes: requests[0]?.id }); // 演化链
    // 意见原文在 response 中必留(可回答「最终执行基于哪条意见」)
    const advised = h.events.find((event) => event.type === "approval/response" && (event.payload as { verdict?: string }).verdict === "advised");
    expect((advised?.payload as { advice_text?: string }).advice_text).toContain("正式编号");
  });
});

describe("clarification——同会话多轮往返", () => {
  it("clarification 轮:同 session 重发 request(attempt 不变、无 supersedes),次轮 granted", async () => {
    const h = await makeHarness(
      scriptStub([
        { verdict: "clarification", actor: "stub-host", question: "数据来源是什么?" },
        { verdict: "granted", actor: "stub-host" },
      ]),
    );
    const verdict = await call(h);
    expect(verdict.kind).toBe("granted");
    const requests = h.events.filter((event) => event.type === "approval/request");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.payload).toMatchObject({ approval_session_id: "aps-1", attempt: 1 });
    expect(requests[1]?.payload).toMatchObject({ approval_session_id: "aps-1", attempt: 1 }); // 非拒绝重提,attempt 不变
    expect(requests[1]?.payload).not.toHaveProperty("supersedes");
    const granted = h.events.filter((event) => event.type === "approval/response" && (event.payload as { verdict?: string }).verdict === "granted");
    expect(granted).toHaveLength(1);
    expect((granted[0]?.payload as { request_event_ref?: number }).request_event_ref).toBe(requests[1]?.id); // 应答配对最后一轮
  });
});

describe("timeout——suspended(75,超时非否决)", () => {
  it("timeout:verdict=timeout + actor=harness 落盘 → suspended", async () => {
    const h = await makeHarness(scriptStub([{ verdict: "timeout" }]));
    const verdict = await call(h);
    expect(verdict.kind).toBe("suspended");
    if (verdict.kind !== "suspended") return;
    expect(verdict.block.reason).toBe("approval_timeout");
    expect(verdict.block.exit_code).toBe(75);
    const response = h.events.find((event) => event.type === "approval/response");
    expect(response?.payload).toMatchObject({ verdict: "timeout", actor: "harness" });
  });
});

describe("放行执行(经 executor 的Granted→执行链,R1「放行执行」实证)", () => {
  it("handler granted 后 executor 对真实桥接面执行工具(mock transport)", async () => {
    const h = await makeHarness(scriptStub([{ verdict: "granted" }]));
    const transport: BridgeTransport = {
      request: async (method, params) => {
        if (method === "ledger_query") return ok({ ok: true, entries: [] });
        if (method === "atf_admit_data") return ok({ ok: true, journal_type: "run_journal", fact_id: "fact-1", sha256_digest: "a".repeat(64) });
        return ok({ ok: true, result: params });
      },
    };
    const executor = new ToolExecutor(transport, ToolRegistry.createDefault());
    const gate = { handler: (input: { tool: string; params: unknown; approval_key: string }) => h.handler({ ...input, tool_call_id: 1 }) };
    const outcome = await executor.execute("atf_admit_data", { dataset_id: "ds-1" }, gate);
    expect(outcome.kind).toBe("executed"); // granted → 放行 → 执行
  });
});
