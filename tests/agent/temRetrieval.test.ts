/**
 * 门 1b TEM 检索注入测试（批 P；验收：注入用例 ≥3）。
 * transform_context hook（关键词匹配 PoC，embedding 后置）；检索失败/空 = 无记忆运行。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildTemSection,
  createTemTransformContext,
  extractQuerySignals,
  retrieveTemEntries,
  scoreEvidence,
  TEM_SECTION_HEADER,
  tokenize,
} from "../../src/agent/tem/retrieval.js";
import { buildEvidenceEvent, mirrorEvidenceEvent } from "../../src/agent/tem/evidence.js";
import { appendPatternClaim, ensureTemBranch, readPatternClaims, queryMechanisms } from "../../src/agent/tem/store.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const makeSession = async (): Promise<SessionLike> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  const root = await mkdtemp(join(tmpdir(), "tem-inj-"));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  await ensureTemBranch(session);
  return session;
};

const userMessage = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: Date.now() }) as AgentMessage;

describe("门 1b TEM 检索注入（transform_context PoC）", () => {
  it("① 信号提取：用户指令词元＋最近 atf_gate 的 gate 值进查询信号", () => {
    const messages: AgentMessage[] = [
      userMessage("推进 G1 闸门"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "atf_gate", arguments: { gate: "G1", action: "advance" } }],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];
    const signals = extractQuerySignals(messages);
    expect(signals.gate).toBe("G1");
    expect(signals.terms).toContain("g1");
    expect(signals.terms).toContain("atf_gate");
    expect(signals.terms).toContain("推进");
  });

  it("② 打分＋阈值＋配额：关键词命中计数排序，score<1 过滤，top-3 截断", () => {
    const event = buildEvidenceEvent({
      correlationId: "c",
      runId: null,
      tool: "atf_gate",
      ok: false,
      params: {},
      result: { ok: true, gate: "G1", status: "blocked", reason_codes: ["evidence_missing"] },
      model: "m",
      gate: "G1",
    });
    expect(scoreEvidence(event, { terms: ["g1", "atf_gate", "无此词"] })).toBe(2); // g1（gate 字段＋summary）＋atf_gate（tool）
    expect(scoreEvidence(event, { terms: ["不相关"] })).toBe(0); // 阈值过滤
    expect(tokenize("推进 G1，先看历史经验!")).toEqual(expect.arrayContaining(["推进", "g1", "先看历史经验"]));
  });

  it("③ 注入 e2e：镜像库命中 → SystemMessage 临时投影带 [tem:<id>] 来源引用与不折叠标", async () => {
    const session = await makeSession();
    const event = buildEvidenceEvent({
      correlationId: "c-g1",
      runId: "run-his",
      tool: "atf_gate",
      ok: true,
      params: { gate: "G1", action: "advance" },
      result: { ok: true, gate: "G1", status: "pass" },
      model: "faux-spike",
      gate: "G1",
    });
    expect(await mirrorEvidenceEvent(session, event)).not.toBeNull();
    await appendPatternClaim(session, {
      kind: "pattern_claim",
      claim_id: "claim-g1",
      claim: "G1 推进前先查状态面。",
      structural_preconditions: ["scope_ref 已捕获"],
      source_refs: [event.event_id],
    });
    const transformContext = createTemTransformContext({ session });
    const messages: AgentMessage[] = [userMessage("准备推进 G1")];
    const transformed = await transformContext(messages);
    expect(transformed.length).toBe(2); // 注入条目仅在本请求投影（转录不污染）
    expect(messages.length).toBe(1);
    const injected = transformed[1] as { role: string; content: string };
    expect(injected.role).toBe("system");
    expect(injected.content).toContain(TEM_SECTION_HEADER);
    expect(injected.content).toContain(`[tem:${event.event_id}]`);
    expect(injected.content).toContain("[tem:claim-g1]");
    expect(injected.content).toContain("structural_preconditions，不折叠");
    // 独立检索面断言（Mechanism 缝 faux：claim 命中＋来源引用可读回）
    const claims = await readPatternClaims(session);
    expect(claims[0]?.source_refs).toEqual([event.event_id]);
    const mechanisms = await queryMechanisms(session, { terms: ["g1"] });
    expect(mechanisms[0]?.item.claim_id).toBe("claim-g1");
  });

  it("④ 无记忆运行：空库/低相关/检索异常 → 原样返回不注入不阻塞", async () => {
    const emptySession = await makeSession();
    const transformEmpty = createTemTransformContext({ session: emptySession });
    const messages: AgentMessage[] = [userMessage("无关指令")];
    expect(await transformEmpty(messages)).toHaveLength(1); // 空库
    expect(await transformEmpty(messages)).not.toHaveLength(2); // 不注入

    const seeded = await makeSession();
    await mirrorEvidenceEvent(
      seeded,
      buildEvidenceEvent({ correlationId: "c", runId: null, tool: "atf_gate", ok: true, params: {}, result: { ok: true }, model: "m", gate: "G2" }),
    );
    const transformLow = createTemTransformContext({ session: seeded });
    const lowResult = await transformLow([userMessage("完全无关的话题")]); // score=0 全滤
    expect(lowResult).toHaveLength(1);
    expect((lowResult[0] as { role: string }).role).toBe("user");

    const failing = createTemTransformContext({ session: { branch: () => Promise.reject(new Error("boom")) } as unknown as SessionLike });
    await expect(failing([userMessage("推进 G1")])).resolves.toHaveLength(1); // 异常 = 无记忆运行不阻塞
  });

  it("⑤ buildTemSection：空检索 = null（不注空段）", () => {
    expect(buildTemSection({ evidence: [], claims: [] })).toBeNull();
  });
});
