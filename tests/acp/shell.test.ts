/**
 * ACP 外壳 E2E（L1 门 2 T04）：RpcPeer 客户端桩 ↔ AcpShell 双向互连（PassThrough）。
 * 覆盖：initialize 轴三协商＋能力声明（D7 无 fs/terminal）／授权闭环（allow_once 真执行
 * ＋D4 留痕）／D5 非法 optionId fail-closed／VERIFY 4 只读链零人工／session/cancel 折算
 * 挂起（非否决）＋续答 resume／session/load 重放重建（INV-A）＋跨进程续答。
 */
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ok } from "../../src/bridge/index.js";
import { type LlmDecision, type LlmProvider, type ResolvedLlmProviderConfig } from "../../src/llm/index.js";
import { RpcPeer, type RpcHandlerOutcome } from "../../src/rpc/index.js";
import { AcpShell } from "../../src/acp/shell.js";
import { ACP_METHODS, type AcpSessionUpdate } from "../../src/acp/index.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const mockPath = join(repoRoot, "tests", "fixtures", "mock_atf.mjs");

/** 保留字段最小的假 provider 配置（外壳只读 model 与透传给工厂）。 */
const fakeConfig = {
  provider_id: "fake",
  model: "fake-model-acp",
} as unknown as ResolvedLlmProviderConfig;

type PermissionPolicy = (params: { sessionId: string; toolCall: { toolCallId: string }; options: readonly { optionId: string; kind: string }[] }) =>
  | { kind: "outcome"; outcome: unknown }
  | { kind: "cancel-then-outcome"; outcome: unknown };

class TestAcpClient {
  public readonly updates: Array<{ sessionId: string; update: AcpSessionUpdate }> = [];
  public readonly permissionRequests: Array<{ sessionId: string; toolCallId: string; options: readonly { optionId: string; kind: string }[] }> = [];
  public policy: PermissionPolicy = () => ({ kind: "outcome", outcome: { outcome: "selected", optionId: "allow_once" } });

  public readonly peer: RpcPeer;

  public constructor(input: PassThrough, output: PassThrough) {
    this.peer = RpcPeer.create({
      input,
      output,
      onRequest: async (method, params): Promise<RpcHandlerOutcome> => {
        if (method !== ACP_METHODS.sessionRequestPermission) {
          return { ok: false, error: { code: -32601, message: `客户端桩未知方法 ${method}` } };
        }
        const p = params as { sessionId: string; toolCall: { toolCallId: string }; options: readonly { optionId: string; kind: string }[] };
        this.permissionRequests.push({ sessionId: p.sessionId, toolCallId: p.toolCall.toolCallId, options: p.options });
        const policy = this.policy(p);
        if (policy.kind === "cancel-then-outcome") {
          this.peer.notify(ACP_METHODS.sessionCancel, { sessionId: p.sessionId });
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return { ok: true, result: policy.outcome };
      },
      onNotification: (method, params) => {
        if (method !== ACP_METHODS.sessionUpdate) return;
        const p = params as { sessionId: string; update: AcpSessionUpdate };
        this.updates.push({ sessionId: p.sessionId, update: p.update });
      },
    });
  }
}

interface DecisionQueue extends Array<LlmDecision> {
  cursor?: number;
}

interface Fixture {
  client: TestAcpClient;
  queue: DecisionQueue;
  runsRoot: string;
  close: () => void;
}

const setupFixture = async (existingRunsRoot?: string): Promise<Fixture> => {
  const runsRoot = existingRunsRoot ?? (await mkdtemp(join(tmpdir(), "acp-shell-test-")));
  const clientToShell = new PassThrough();
  const shellToClient = new PassThrough();
  const client = new TestAcpClient(shellToClient, clientToShell);
  const queue: DecisionQueue = [];
  let shellPeerRef: RpcPeer | undefined;
  const shell = new AcpShell({
    peer: {
      request: async (method, params) => {
        const peer = shellPeerRef;
        if (peer === undefined) return { ok: false, error: { code: -32000, message: "传输面未就绪" } };
        return await peer.request(method, params);
      },
      notify: (method, params) => {
        shellPeerRef?.notify(method, params);
      },
    },
    runsRoot,
    mockCommand: ["node", mockPath],
    providerConfig: fakeConfig,
    providerFactory: (): LlmProvider => {
      // 队列游标跨 prompt 共享（同一 run 的模型会话连续；重派不重复消费脚本）
      let shared = queue.cursor ?? 0;
      return {
        providerId: "fake",
        decide: async () => {
          const decision = queue[shared] ?? null;
          shared += 1;
          queue.cursor = shared;
          return ok(decision);
        },
      };
    },
  });
  const shellPeer = RpcPeer.create({
    input: clientToShell,
    output: shellToClient,
    onRequest: shell.handleRequest,
    onNotification: shell.handleNotification,
  });
  shellPeerRef = shellPeer;
  shellPeer.start();
  client.peer.start();
  return {
    client,
    queue,
    runsRoot,
    close: () => {
      client.peer.close();
      shellPeer.close();
      clientToShell.end();
      shellToClient.end();
    },
  };
};

const rmRoot = async (fixture: Fixture): Promise<void> => {
  fixture.close();
  await rm(fixture.runsRoot, { recursive: true, force: true });
};

const updateList = (client: TestAcpClient): AcpSessionUpdate[] => client.updates.map((entry) => entry.update);

const readStream = async (runsRoot: string, sessionId: string): Promise<Array<Record<string, unknown>>> => {
  const text = await readFile(join(runsRoot, sessionId, "session.jsonl"), "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** 开新会话（断言成功并返回 sessionId）。 */
const newSession = async (client: TestAcpClient): Promise<string> => {
  const outcome = await client.peer.request(ACP_METHODS.sessionNew, {});
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return (outcome.result as { sessionId: string }).sessionId;
};

/** prompt 结果 stopReason 取值（断言成功）。 */
const stopReasonOf = (outcome: RpcHandlerOutcome): string => {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return (outcome.result as { stopReason: string }).stopReason;
};

describe("ACP 外壳 E2E（T04）", () => {
  it("initialize：轴三应答 v1；能力面只声明 loadSession（D7 无 fs/terminal）", async () => {
    const fixture = await setupFixture();
    try {
      const outcome = await fixture.client.peer.request(ACP_METHODS.initialize, { protocolVersion: 2, clientCapabilities: {} });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("unreachable");
      const result = outcome.result as Record<string, unknown>;
      expect(result["protocolVersion"]).toBe(1);
      expect(result["agentCapabilities"]).toEqual({ loadSession: true });
      expect(result["authMethods"]).toEqual([]);
      const capabilities = JSON.stringify(result["agentCapabilities"]);
      expect(capabilities).not.toContain("fs");
      expect(capabilities).not.toContain("terminal");
    } finally {
      await rmRoot(fixture);
    }
  });

  it("授权闭环：allow_once → 真执行；D4 留痕（channel/host_id/requires_human_review）", async () => {
    const fixture = await setupFixture();
    try {
      fixture.queue.push(
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-acp-1" } },
        { type: "final_answer", text: "数据集 ds-acp-1 已准入（宿主放行）。" },
      );
      const sessionId = await newSession(fixture.client);
      const prompt = await fixture.client.peer.request(ACP_METHODS.sessionPrompt, {
        sessionId,
        prompt: [{ type: "text", text: "把数据集 ds-acp-1 准入登记。" }],
      });
      expect(stopReasonOf(prompt)).toBe("end_turn");

      // 授权请求面：恰两选项（D5），无 always
      expect(fixture.client.permissionRequests.length).toBe(1);
      expect(fixture.client.permissionRequests[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);

      // 投影面：tool_call(edit) → pending（等待人工审批）→ in_progress（宿主放行）→ completed + 终答
      const updates = updateList(fixture.client);
      const toolCall = updates.find((update) => update.sessionUpdate === "tool_call");
      expect(toolCall).toMatchObject({ kind: "edit", status: "in_progress" });
      const pendingUpdate = updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "pending");
      expect(pendingUpdate).toBeDefined();
      expect((pendingUpdate as { title: string }).title).toContain("等待人工审批");
      expect(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.status === "in_progress" && (update.title ?? "").includes("宿主已应答放行"))).toBe(true);
      expect(updates.some((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed")).toBe(true);
      expect(updates.some((update) => update.sessionUpdate === "agent_message_chunk" && update.content.text.includes("ds-acp-1"))).toBe(true);

      // 落盘证据（D4 B＋C + 授权闭环真执行）
      const stream = await readStream(fixture.runsRoot, sessionId);
      const granted = stream.find((event) => event["type"] === "approval/response" && (event["payload"] as { verdict?: string }).verdict === "granted");
      expect(granted).toBeDefined();
      const grantedPayload = granted?.["payload"] as Record<string, unknown>;
      expect(grantedPayload["channel"]).toBe("acp");
      expect(grantedPayload["host_id"]).toBe("acp-client");
      expect(grantedPayload["requires_human_review"]).toBe(true);
      expect(grantedPayload["actor"]).toBe("acp-host");
      const call = stream.find((event) => event["type"] === "tool/call" && JSON.stringify(event["payload"]).includes("atf_admit_data"));
      const result = stream.find((event) => event["type"] === "tool/result" && JSON.stringify(event["payload"]).includes('"ok":true'));
      expect(call).toBeDefined();
      expect(result).toBeDefined();
      expect((result?.["payload"] as { call_ref?: number }).call_ref).toBe(call?.["id"]);
    } finally {
      await rmRoot(fixture);
    }
  });

  it("D5 fail-closed：宿主回未提供的 allow_always → 拒绝留痕、动作未执行", async () => {
    const fixture = await setupFixture();
    try {
      fixture.client.policy = () => ({ kind: "outcome", outcome: { outcome: "selected", optionId: "allow_always" } });
      fixture.queue.push(
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-acp-2" } },
        { type: "final_answer", text: "改换路径收束。" },
      );
      const sessionId = await newSession(fixture.client);
      const prompt = await fixture.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "准入 ds-acp-2" }] });
      expect(stopReasonOf(prompt)).toBe("end_turn");

      const stream = await readStream(fixture.runsRoot, sessionId);
      const denied = stream.find((event) => event["type"] === "approval/response" && (event["payload"] as { verdict?: string }).verdict === "denied");
      expect(denied).toBeDefined();
      expect((denied?.["payload"] as { reason?: string }).reason).toContain("非法 optionId");
      const executed = stream.find(
        (event) => event["type"] === "tool/result" && JSON.stringify(event["payload"]).includes('"ok":true') && JSON.stringify(event["payload"]).includes("atf_admit_data"),
      );
      expect(executed).toBeUndefined();
    } finally {
      await rmRoot(fixture);
    }
  });

  it("只读链治理（B7 N1）：ws/scan/gate query 全部免审批零请求直执行", async () => {
    const fixture = await setupFixture();
    try {
      fixture.queue.push(
        { type: "tool_call", tool: "atf_workspace_status", params: {} },
        { type: "tool_call", tool: "atf_fact_scan", params: {} },
        { type: "tool_call", tool: "atf_gate", params: { gate: "g1", action: "query" } },
        { type: "final_answer", text: "只读链完成。" },
      );
      const sessionId = await newSession(fixture.client);
      const prompt = await fixture.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "只读巡检" }] });
      expect(stopReasonOf(prompt)).toBe("end_turn");
      // B7 N1：gate(query) 与 ws/scan 同为免审批——只读链全程零弹窗（VERIFY 4 口径）
      expect(fixture.client.permissionRequests.length).toBe(0);
      const stream = await readStream(fixture.runsRoot, sessionId);
      const statuses = stream
        .filter((event) => event["type"] === "tool/result" && (event["payload"] as { ok?: boolean }).ok === true)
        .map((event) => (event["payload"] as { tool: string }).tool);
      expect(statuses).toEqual(["atf_workspace_status", "atf_fact_scan", "atf_gate"]);
      expect(stream.some((event) => event["type"] === "approval/response")).toBe(false);
    } finally {
      await rmRoot(fixture);
    }
  });

  it("session/cancel → 折算挂起（非否决）；续答 prompt → resume 放行收束", async () => {
    const fixture = await setupFixture();
    try {
      fixture.queue.push(
        { type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-acp-3" } },
        { type: "final_answer", text: "续答后收束。" },
      );
      const sessionId = await newSession(fixture.client);
      // 宿主取消：先发 session/cancel，再对授权请求回 cancelled（官方义务）
      fixture.client.policy = () => ({ kind: "cancel-then-outcome", outcome: { outcome: "cancelled" } });
      const prompt1 = await fixture.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "准入 ds-acp-3" }] });
      expect(stopReasonOf(prompt1)).toBe("cancelled");
      const stream1 = await readStream(fixture.runsRoot, sessionId);
      const suspendedAnswer = stream1.find((event) => event["type"] === "approval/response");
      expect((suspendedAnswer?.["payload"] as { reason?: string }).reason).toContain("会话取消");

      // 续答：宿主 allow_once → resume（granted，channel 留痕）→ 真执行 → 收束
      fixture.client.policy = () => ({ kind: "outcome", outcome: { outcome: "selected", optionId: "allow_once" } });
      const prompt2 = await fixture.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "继续" }] });
      expect(stopReasonOf(prompt2)).toBe("end_turn");
      expect(fixture.client.permissionRequests.length).toBe(2); // 挂起续答重新请求授权
      const stream2 = await readStream(fixture.runsRoot, sessionId);
      const executed = stream2.find((event) => event["type"] === "tool/result" && JSON.stringify(event["payload"]).includes('"ok":true'));
      expect(executed).toBeDefined();
      const resumeGranted = stream2.find((event) => event["type"] === "approval/response" && (event["payload"] as { verdict?: string }).verdict === "granted");
      expect((resumeGranted?.["payload"] as Record<string, unknown>)["channel"]).toBe("acp");
    } finally {
      await rmRoot(fixture);
    }
  });

  it("session/load：重放日志重建 loop 状态（INV-A）；跨进程续答收束", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "acp-load-test-"));
    try {
      let sessionId = "";
      {
        const fixture = await setupFixture(runsRoot);
        fixture.queue.push({ type: "tool_call", tool: "atf_admit_data", params: { dataset_id: "ds-acp-5" } });
        fixture.client.policy = () => ({ kind: "cancel-then-outcome", outcome: { outcome: "cancelled" } });
        sessionId = await newSession(fixture.client);
        await fixture.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "准入 ds-acp-5" }] });
        fixture.close();
      }
      // 新外壳实例（模拟宿主重启 agent 进程）＋同 runsRoot
      const fixture2 = await setupFixture(runsRoot);
      try {
        fixture2.queue.push({ type: "final_answer", text: "跨进程续答后收束。" });
        fixture2.client.policy = () => ({ kind: "outcome", outcome: { outcome: "selected", optionId: "allow_once" } });
        const loaded = await fixture2.client.peer.request(ACP_METHODS.sessionLoad, { sessionId });
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) throw new Error("unreachable");
        const summary = (loaded.result as { _meta: { atf: { loopState: Record<string, unknown> } } })._meta.atf.loopState;
        expect(summary["last_closed_reason"]).toBe("suspended");
        expect(summary["pending_approvals"]).toBe(1);
        const prompt = await fixture2.client.peer.request(ACP_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text: "继续" }] });
        expect(stopReasonOf(prompt)).toBe("end_turn");
        const stream = await readStream(runsRoot, sessionId);
        expect(stream.some((event) => event["type"] === "tool/result" && JSON.stringify(event["payload"]).includes('"ok":true'))).toBe(true);
      } finally {
        fixture2.close();
      }
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});
