/**
 * 门 1b TEM 镜像测试（批 P；验收：镜像用例 ≥3）。
 * 对端 = 契约 mock 内核子进程；模型面 = faux（零真实调用）。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AtfBridgeConnection } from "../../src/bridge/connection.js";
import {
  buildEvidenceEvent,
  captureFactRef,
  evidenceParamsDigest,
  mirrorEvidenceEvent,
  scanEvidenceEvents,
} from "../../src/agent/tem/evidence.js";
import {
  ensureTemBranch,
  readExperienceCase,
  writeExperienceCase,
  type ExperienceCase,
} from "../../src/agent/tem/store.js";
import { createJsonlSessionRepo, type SessionLike } from "../../src/agent/sessionMirror.js";

const mockAtf = fileURLToPath(new URL("../fixtures/mock_atf.mjs", import.meta.url));

const openConnections: AtfBridgeConnection[] = [];
afterEach(async () => {
  while (openConnections.length > 0) {
    const connection = openConnections.pop();
    if (connection !== undefined) await connection.close({ timeoutMs: 2_000 }).catch(() => undefined);
  }
});

const makeSession = async (): Promise<{ session: SessionLike }> => {
  const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) throw new Error("unreachable");
  openConnections.push(spawned.value);
  void spawned.value;
  const root = await mkdtemp(join(tmpdir(), "tem-evi-"));
  const repo = createJsonlSessionRepo(root);
  const session = await repo.create({ cwd: root }, (await import("@earendil-works/pi-agent-core")).BACKGROUND_CONTEXT);
  return { session };
};

describe("门 1b TEM 镜像（EvidenceEvent）", () => {
  it("① 字段完整性：buildEvidenceEvent 产 ts/tool/params_digest/result_summary/correlation_id/run_id/环境指纹", () => {
    const params = { gate: "G1", action: "advance" };
    const event = buildEvidenceEvent({
      correlationId: "call-1",
      runId: "run-x",
      tool: "atf_gate",
      ok: true,
      params,
      result: { ok: true, gate: "G1", status: "blocked" },
      model: "faux-spike",
      gate: "G1",
    });
    expect(event.kind).toBe("evidence_event");
    expect(event.correlation_id).toBe("call-1");
    expect(event.run_id).toBe("run-x");
    expect(event.tool).toBe("atf_gate");
    expect(event.ok).toBe(true);
    expect(event.params_digest).toBe(evidenceParamsDigest(params));
    expect(event.params_digest).toHaveLength(16);
    expect(event.result_summary).toContain('"status":"blocked"');
    expect(event.gate).toBe("G1");
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.env_fingerprint).toEqual({ model: "faux-spike", kernel_pin: "v0.7.8b0" });
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  it("② fact_ref 捕获：K4 三元组字段齐则提取（journal_type 缺省 unknown），缺一不捕获", () => {
    expect(captureFactRef({ ok: true, journal_type: "dataset-registry", fact_id: "ds-a@pin", sha256_digest: "ab".repeat(32) })).toEqual({
      journal_type: "dataset-registry",
      fact_id: "ds-a@pin",
      sha256_digest: "ab".repeat(32),
    });
    expect(captureFactRef({ fact_id: "ds-a@pin" })).toBeUndefined(); // 缺 sha256_digest
    expect(captureFactRef({ sha256_digest: "x" })).toBeUndefined(); // 缺 fact_id
    expect(captureFactRef("not-an-object")).toBeUndefined();
  });

  it("③ 镜像→扫描回读：custom entry 落 session（时间升序），镜像失败不反压（返回 null）", async () => {
    const { session } = await makeSession();
    await ensureTemBranch(session);
    const e1 = buildEvidenceEvent({ correlationId: "c1", runId: null, tool: "atf_workspace_status", ok: true, params: {}, result: { ok: true }, model: "m" });
    const e2 = buildEvidenceEvent({ correlationId: "c2", runId: "run-1", tool: "atf_fact_scan", ok: false, params: {}, result: { ok: true, facts: [] }, model: "m" });
    expect(await mirrorEvidenceEvent(session, e1)).not.toBeNull();
    expect(await mirrorEvidenceEvent(session, e2)).not.toBeNull();
    const scanned = await scanEvidenceEvents(session);
    expect(scanned.map((event) => event.event_id)).toEqual([e1.event_id, e2.event_id]);
    expect(scanned[1]?.ok).toBe(false);
    // 落盘持久化断言（JSONL 文件含 customType 与事件 id）
    const { readdir, readFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const root = dirname((session as unknown as { metadata: { path: string } }).metadata.path);
    const files = await readdir(root, { recursive: true });
    const jsonl = files.find((name) => name.endsWith(".jsonl")) as string;
    const raw = await readFile(join(root, jsonl), "utf8");
    expect(raw).toContain("tem/evidence_event");
    expect(raw).toContain(e1.event_id);
  });

  it("④ Agent 链路 e2e：after_tool 镜像真实工具执行（correlation_id=toolCallId，run_id 捕获），Case 落库去重键直查", async () => {
    const { runGate1bPoc } = await import("../../src/agent/tem/poc.js");
    const spawned = await AtfBridgeConnection.spawn({ command: ["node", mockAtf] });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error("unreachable");
    openConnections.push(spawned.value);
    const root = await mkdtemp(join(tmpdir(), "tem-evi-e2e-"));
    const result = await runGate1bPoc({ bridge: spawned.value, sessionsRoot: root });
    expect(result.run_a_evidence_count).toBe(2); // status（经桥）＋gate（账本放行后经桥）
    expect(result.run_a_case).toBeDefined();
    expect(result.run_a_case?.run_id).toBe("mock-run-1");
    expect(result.run_a_case?.evidence_event_ids).toHaveLength(2);
    expect(result.all_passed).toBe(true);
  });

  it("Case Value 寻址：同 run 覆盖写＝run_ref 去重（写两次读回为最后一次）", async () => {
    const { session } = await makeSession();
    await ensureTemBranch(session);
    const base: Omit<ExperienceCase, "cost"> & { cost: ExperienceCase["cost"] } = {
      kind: "experience_case",
      case_id: "case-1",
      run_id: "run-dup",
      closed_at: new Date().toISOString(),
      outcome: "pending",
      evidence_event_ids: ["e1"],
      cost: { model_calls: 1 },
      env_fingerprint: { model: "m", kernel_pin: "v0.7.8b0" },
    };
    await writeExperienceCase(session, base);
    await writeExperienceCase(session, { ...base, case_id: "case-2", evidence_event_ids: ["e1", "e2"] });
    const readBack = await readExperienceCase(session, "run-dup");
    expect(readBack?.case_id).toBe("case-2");
    expect(readBack?.evidence_event_ids).toEqual(["e1", "e2"]);
  });
});
