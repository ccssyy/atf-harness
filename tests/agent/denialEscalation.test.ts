/**
 * 批㊳ 段 1.2 测试——denial 升级判定（丙线欠账①；同 proposalApprovalKey denied≥2 →
 * 终局 aborted exit 79）。对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用）。
 * 锚：①两次同提案 denied → terminate 终局 aborted（exit 79；回填注明「同一提案多次被拒，
 * 已终止」）／②单次 denied 非终局正常回流（模型可换路径继续，run 不终止）。
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { assembleV1Agent, runV1Headless } from "../../src/agent/cli.js";
import { DENIAL_ESCALATION_LIMIT } from "../../src/agent/approvalHook.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "../../src/agent/fauxStream.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";
import type { ApprovalSurface } from "../../src/agent/approvalSurface.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const spawnMock = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

const makeSession = async (tag = "deny-"): Promise<SessionLike> => {
  const root = await mkdtemp(join(tmpdir(), tag));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

const deniedSurface: ApprovalSurface = { ask: async () => ({ kind: "denied" }) as never };

const writeParams = { path: "notes/a.txt", content: "hello" };

describe("批㊳ 1.2 · denial 升级判定（同提案 denied≥2 → aborted 79）", () => {
  it("① 两次同提案 denied → 终局 aborted：第二次否决升级 terminate（回填注明「同一提案多次被拒，已终止」），run exit 79", async () => {
    expect(DENIAL_ESCALATION_LIMIT).toBe(2); // 阈值锚（决议口径：≥2 升级）
    const bridge = await spawnMock();
    const root = await mkdtemp(join(tmpdir(), "deny-esc-"));
    const scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    const session = await makeSession("deny-esc-s-");
    const script = [
      fauxMessageWithToolCalls("查状态。", [{ id: "s1", name: "atf_workspace_status", arguments: {} }]),
      fauxMessageWithToolCalls("写入笔记（第一次）。", [{ id: "w1", name: "atf_write", arguments: writeParams }]),
      fauxMessageWithToolCalls("再试同一写入。", [{ id: "w2", name: "atf_write", arguments: writeParams }]),
      fauxFinalAnswer("不应到达（升级终止）"),
    ];
    const s = assembleV1Agent({
      bridge,
      session,
      maxTurns: 8,
      modelTag: "faux-deny",
      approval: { kind: "surface", surface: deniedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(script),
      fileTools: { roots: [scratch] },
    });
    await s.agent.prompt("写入笔记。");
    // 两次 blocked_denied 留痕在位；第二次升级 aborted（detail 注明 denial_escalation）
    const denied = s.audit.filter((entry) => entry.verdict === "blocked_denied");
    expect(denied).toHaveLength(2);
    const escalated = s.audit.find((entry) => entry.verdict === "aborted");
    expect(escalated?.tool).toBe("atf_write");
    expect((escalated?.detail as { why?: string; denial_count?: number } | undefined)?.why).toBe("denial_escalation");
    expect((escalated?.detail as { denial_count?: number } | undefined)?.denial_count).toBe(2);
    // 回填文本（结构化 toolResult 给模型面）：注明「同一提案多次被拒，已终止」
    const secondEnd = s.events
      .filter((event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "atf_write")
      .at(-1) as { result?: { content?: Array<{ text?: string }> } } | undefined;
    expect(JSON.stringify(secondEnd?.result ?? "")).toContain("同一提案多次被拒，已终止");
    // run 级终局：runV1Headless 同场景 exit 79（aborted 锚不挪用）
    const errLines: string[] = [];
    const exit = await runV1Headless({
      bridge: await spawnMock(),
      sessionsRoot: await mkdtemp(join(tmpdir(), "deny-esc-e2e-")),
      instruction: "写入笔记",
      maxTurns: 8,
      scripted: script,
      approval: { kind: "surface", surface: deniedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      out: () => undefined,
      err: (line) => errLines.push(line),
    });
    expect(exit).toBe(79);
    expect(errLines.join("\n")).toContain("终局 aborted（exit 79）");
  });

  it("② 单次 denied 非终局：结构化回填不终止（terminate 未置位），模型换路径继续 → run 正常收口 exit 0", async () => {
    const bridge = await spawnMock();
    const root = await mkdtemp(join(tmpdir(), "deny-once-"));
    const scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    const script = [
      fauxMessageWithToolCalls("查状态。", [{ id: "s1", name: "atf_workspace_status", arguments: {} }]),
      fauxMessageWithToolCalls("写入被拒后改道。", [{ id: "w1", name: "atf_write", arguments: writeParams }]),
      fauxFinalAnswer("写入被操作员否决——已如实转述并改用只读路径汇总。"),
    ];
    const out: string[] = [];
    const exit = await runV1Headless({
      bridge,
      sessionsRoot: root,
      instruction: "尝试写入",
      maxTurns: 8,
      scripted: script,
      approval: { kind: "surface", surface: deniedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      out: (line) => out.push(line),
      err: () => undefined,
    });
    expect(exit).toBe(0); // 单次否决＝非终局，正常回流收口
    expect(out.join("\n")).toContain("改用只读路径");
  });
});
