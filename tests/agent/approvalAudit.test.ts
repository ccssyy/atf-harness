/**
 * 批㊳ 段 1.1 测试——审批留痕入流（丙线欠账③；approval_audit custom entry）。
 * 对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用）。
 * 锚：①留痕入流（全链装配→session 流可回扫＋JSONL 落盘）／②写失败不阻断审批流
 * （fail-open＋stderr 记录）／③字段闭集（proposal key／verdict／时间戳／来源）。
 */
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import { assembleV1Agent } from "../../src/agent/cli.js";
import { createApprovalBeforeToolCall, type ApprovalAuditEntry } from "../../src/agent/approvalHook.js";
import {
  buildApprovalAuditStreamEntry,
  createSessionApprovalAuditStream,
  scanApprovalAudit,
  APPROVAL_AUDIT_CUSTOM_TYPE,
  type ApprovalAuditStreamEntry,
} from "../../src/agent/approvalAudit.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";
import { createFauxStreamFn, fauxFinalAnswer, fauxMessageWithToolCalls } from "../../src/agent/fauxStream.js";
import { ensureTemBranch } from "../../src/agent/tem/store.js";
import { approvalKeyFor } from "../../src/core/tools/approvalKey.js";
import type { ApprovalSurface } from "../../src/agent/approvalSurface.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
  vi.restoreAllMocks();
});

const spawnMock = async (): Promise<AtfBridgeConnection> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  return spawned.value;
};

const makeSession = async (tag = "audit-"): Promise<SessionLike> => {
  const root = await mkdtemp(join(tmpdir(), tag));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

const grantedSurface: ApprovalSurface = { ask: async () => ({ kind: "granted" }) as never };

const writeParams = { path: "notes/a.txt", content: "hello" };

describe("批㊳ 1.1 · 审批留痕入流（approval_audit custom entry）", () => {
  it("① 留痕入流：过闸判定同步落 session 流——scanApprovalAudit 回扫＋JSONL 落盘持久（欠账③闭合）", async () => {
    const bridge = await spawnMock();
    const root = await mkdtemp(join(tmpdir(), "audit-e2e-"));
    const scratch = join(root, "scratch");
    await mkdir(scratch, { recursive: true });
    const session = await makeSession("audit-e2e-s-");
    const script = [
      fauxMessageWithToolCalls("写入运行笔记。", [{ id: "w1", name: "atf_write", arguments: writeParams }]),
      fauxFinalAnswer("已写入（经确认卡放行）。"),
    ];
    const s = assembleV1Agent({
      bridge,
      session,
      maxTurns: 8,
      modelTag: "faux-audit",
      approval: { kind: "surface", surface: grantedSurface },
      steeringMode: "all",
      followUpMode: "all",
      contextTokens: 24_000,
      keepRecentTokens: 8_000,
      streamFn: createFauxStreamFn(script),
      fileTools: { roots: [scratch] },
    });
    s.scopeRefBox.current = { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-1", scope_mode: "headless" } as never;
    await s.agent.prompt("写入运行笔记。");
    expect(s.audit.some((entry) => entry.verdict === "allow_surface_ledger")).toBe(true); // 判定本身在位
    // 留痕入流：session 流可回扫（assembly 自动接线——过闸判定与留痕同步落盘）
    const streamed = await scanApprovalAudit(session);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.verdict).toBe("allow_surface_ledger");
    expect(streamed[0]?.source).toBe("surface");
    expect(streamed[0]?.proposal_key).toBe(approvalKeyFor("atf_write", writeParams).params_digest); // atf_write 非脚本类＝key 即 params_digest
    // JSONL 落盘持久（崩溃后转录可回溯——审计面闭合的落点）
    const { dirname } = await import("node:path");
    const sessionDir = dirname((session as unknown as { metadata: { path: string } }).metadata.path);
    const files = await readdir(sessionDir, { recursive: true });
    const jsonl = files.find((name) => name.endsWith(".jsonl")) as string;
    const raw = await readFile(join(sessionDir, jsonl), "utf8");
    expect(raw).toContain(APPROVAL_AUDIT_CUSTOM_TYPE);
    expect(raw).toContain(streamed[0]?.proposal_key ?? "");
  });

  it("② 写失败不阻断审批流（fail-open）：注入面抛错／session 写失败——判定照常、stderr 记录、无异常透出", async () => {
    const bridge = await spawnMock();
    const scopeRefBox = { current: { project_id: "mock-project", scope_type: "run", scope_id: "mock-run-2", scope_mode: "headless" } as never };
    const ctx = {
      toolCall: { id: "t1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } },
      args: { gate: "G1", action: "advance" },
    } as unknown as Parameters<ReturnType<typeof createApprovalBeforeToolCall>>[0];
    // 注入面抛错：hook 不透出异常，surface granted 照常放行（预录→消费）
    const throwing: ApprovalAuditEntry[] = [];
    const grantedWithThrowingStream = await createApprovalBeforeToolCall({
      bridge,
      scopeRefBox,
      audit: throwing,
      surface: grantedSurface,
      auditStream: { write: async () => { throw new Error("disk full"); } },
    })(ctx);
    expect(grantedWithThrowingStream).toBeUndefined(); // 放行不受留痕失败影响
    expect(throwing.at(-1)?.verdict).toBe("allow_surface_ledger"); // 内存留痕照常
    // 标准装配流（session 写失败）：write 返回 false＋stderr 记录（best-effort 登记）
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const brokenStream = createSessionApprovalAuditStream({
      branch: async () => ({ appendCustomEntry: async () => { throw new Error("ENOENT"); } }),
    } as never);
    expect(await brokenStream.write(buildApprovalAuditStreamEntry("k", "blocked_denied", "surface"))).toBe(false);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("审批留痕入流失败");
    expect(String(stderr.mock.calls[0]?.[0])).toContain("fail-open");
  });

  it("③ 字段闭集：留痕条目恰为 proposal key／verdict／时间戳／来源四字段（ts 可解析；来源闭集 surface|ledger）", () => {
    const entry = buildApprovalAuditStreamEntry("key-1", "blocked_denied", "surface", new Date("2026-10-06T02:40:00.000Z"));
    expect(Object.keys(entry).sort()).toEqual(["proposal_key", "source", "ts", "verdict"].sort());
    const round: ApprovalAuditStreamEntry = { ...entry };
    expect(round.proposal_key).toBe("key-1");
    expect(round.verdict).toBe("blocked_denied");
    expect(round.ts).toBe("2026-10-06T02:40:00.000Z");
    expect(round.source).toBe("surface");
    expect(Number.isNaN(Date.parse(round.ts))).toBe(false);
    for (const source of ["surface", "ledger"] as const) {
      expect(buildApprovalAuditStreamEntry("k", "allow_ledger", source).source).toBe(source);
    }
  });
});
