import { beforeEach, describe, expect, it } from "vitest";
import {
  findExistingCredential,
  resolveCredentialState,
  type CredentialRef,
} from "../../src/tools/index.js";
import { type SessionEvent, type SessionEventType } from "../../src/session/index.js";

/**
 * P2-S2 凭据判定纯函数测试(设计 v1.1 §2 / 门 2 A1–A2):
 * 四值判定、A1 悬空 call_ref 反例、A2 水位线取值后固定性。
 */

let seq = 0;
const ev = (type: SessionEventType, payload: unknown): SessionEvent => ({
  id: ++seq,
  ts: "2026-09-11T00:00:00.000Z",
  type,
  payload,
  projection: { evidence_event: null },
});

beforeEach(() => {
  seq = 0;
});

/** 标准审批链:call(id1) → request(id2, tool_call_id=1) → granted(id3, ref=2)。 */
const seedApproval = (): SessionEvent[] => {
  const call = ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-1" } });
  const request = ev("approval/request", {
    approval_session_id: "aps-1",
    tool_call_id: call.id, // 显式配对:tool_call_id 恒为真实 call 事件 id
    tool: "atf_admit_data",
    params: { dataset_id: "ds-1" },
    approval_key: "k1",
    attempt: 1,
  });
  const response = ev("approval/response", { approval_session_id: "aps-1", request_event_ref: request.id, verdict: "granted", actor: "stub-host" });
  return [call, request, response];
};

const CRED: CredentialRef = { approval_session_id: "aps-1", request_event_ref: 2 };

describe("resolveCredentialState——四值判定", () => {
  it("consumed:存在 call_ref 精确配对的 tool/result(无论 ok 真假)", () => {
    const okEvents = [...seedApproval(), ev("tool/result", { tool: "atf_admit_data", ok: true, call_ref: 1 })];
    expect(resolveCredentialState(okEvents, CRED, { recoveryWatermark: 0 })).toBe("consumed");

    const base = seedApproval();
    const cred: CredentialRef = { approval_session_id: "aps-1", request_event_ref: base[1]?.id ?? 0 };
    const failedResult = [...base, ev("tool/result", { tool: "atf_admit_data", ok: false, reason: "x", call_ref: base[0]?.id ?? 0 })];
    expect(resolveCredentialState(failedResult, cred, { recoveryWatermark: 0 })).toBe("consumed"); // 调用尝试即消费
  });

  it("available:无结果且 granted.id > 水位线(resume(answer) 新注入路径)", () => {
    const events = seedApproval();
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 2 })).toBe("available");
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 0 })).toBe("available");
  });

  it("indeterminate:无结果且 granted.id ≤ 水位线(旧遗留,执行可能已发生)", () => {
    const events = seedApproval(); // granted.id = 3
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 3 })).toBe("indeterminate");
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 99 })).toBe("indeterminate");
  });

  it("invalid:granted 缺失 / request 断链 / tool_call 断链 / granted 多条(审计歧义)", () => {
    expect(resolveCredentialState([], CRED, { recoveryWatermark: 0 })).toBe("invalid");
    // request 指向不存在的 tool/call
    const brokenCall = [ev("user/message", {}), ev("approval/request", { approval_session_id: "aps-1", tool_call_id: 42 }), ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub" })];
    expect(resolveCredentialState(brokenCall, { approval_session_id: "aps-1", request_event_ref: 2 }, { recoveryWatermark: 0 })).toBe("invalid");
    // 同一 request 两条 granted
    const duplicated = [...seedApproval(), ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-2" })];
    expect(resolveCredentialState(duplicated, CRED, { recoveryWatermark: 0 })).toBe("invalid");
  });
});

describe("A1——call_ref 精确配对(悬空/错配不构成消费事实)", () => {
  it("call_ref 指向不存在的 call 事件 → 不构成消费 → 按水位线判定", () => {
    const events = [...seedApproval(), ev("tool/result", { tool: "atf_admit_data", ok: true, call_ref: 999 })];
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 0 })).toBe("available");
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 99 })).toBe("indeterminate");
  });

  it("call_ref 指向非 tool/call 事件 → 不构成消费事实", () => {
    const events = [...seedApproval(), ev("tool/result", { tool: "atf_admit_data", ok: true, call_ref: 2 })]; // 2 = request
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 0 })).toBe("available");
  });

  it("call_ref 指向另一条真实 call(错配)→ 不消费本凭据;该结果属于另一凭据", () => {
    const events: SessionEvent[] = [
      ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-1" } }), // id 1
      ev("approval/request", { approval_session_id: "aps-1", tool_call_id: 1, tool: "atf_admit_data", approval_key: "k1", attempt: 1 }), // id 2
      ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-host" }), // id 3
      ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-2" } }), // id 4(另一次调用)
      ev("tool/result", { tool: "atf_admit_data", ok: true, call_ref: 4 }), // 结果属于 call 4
    ];
    expect(resolveCredentialState(events, CRED, { recoveryWatermark: 0 })).toBe("available"); // call 1 无结果
    const other: CredentialRef = { approval_session_id: "aps-1", request_event_ref: 2 };
    expect(resolveCredentialState(events, other, { recoveryWatermark: 0 })).toBe("available");
  });
});

describe("A2——水位线取值后固定(恢复后继续 append,判定不漂移)", () => {
  it("真 resume 流:timeout 挂起(wm 固定)→ resume(answer) 注入 granted(id > wm)→ available;旧凭据判定不漂移", () => {
    // 挂起时点流:call(1) → request(2) → response(timeout, actor=harness)(3);恢复水位线 = 3
    const suspended: SessionEvent[] = [
      ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-1" } }),
      ev("approval/request", { approval_session_id: "aps-1", tool_call_id: 1, tool: "atf_admit_data", approval_key: "k1", attempt: 1 }),
      ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "timeout", actor: "harness" }),
    ];
    const watermark = 3;
    // 挂起态无 granted:凭据尚不存在(indeterminate/consumed 均不适用,判定 = invalid 即「无凭据」)
    expect(resolveCredentialState(suspended, CRED, { recoveryWatermark: watermark })).toBe("invalid");

    // resume(answer) 注入 granted(事件 id 4 > 水位线,指向同一悬空 request)→ available,放行执行
    const afterResume = [...suspended, ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-host" })];
    expect(resolveCredentialState(afterResume, CRED, { recoveryWatermark: watermark })).toBe("available");

    // 水位线固定:恢复后继续 append(执行结果落盘),旧判定不漂移——granted 仍 available,直至结果落盘翻转为 consumed
    const withResult = [...afterResume, ev("tool/result", { tool: "atf_admit_data", ok: true, call_ref: 1 })];
    expect(resolveCredentialState(withResult, CRED, { recoveryWatermark: watermark })).toBe("consumed");
  });

  it("异常双 granted(审计歧义)→ 保守判 invalid,绝不放行", () => {
    const duplicated = [...seedApproval(), ev("approval/response", { approval_session_id: "aps-1", request_event_ref: 2, verdict: "granted", actor: "stub-2" })];
    expect(resolveCredentialState(duplicated, CRED, { recoveryWatermark: 0 })).toBe("invalid");
  });

  it("新提案新 granted 形态(恢复后模型重新提案):新链 id 均高于水位线 → available;旧悬空凭据不漂移", () => {
    const events = seedApproval(); // granted.id = 3
    const watermark = 3;
    const resumeInjected: SessionEvent[] = [
      ...events,
      ev("tool/call", { tool: "atf_admit_data", params: { dataset_id: "ds-1" } }), // id 4
      ev("approval/request", { approval_session_id: "aps-2", tool_call_id: 4, tool: "atf_admit_data", approval_key: "k1", attempt: 1 }), // id 5
      ev("approval/response", { approval_session_id: "aps-2", request_event_ref: 5, verdict: "granted", actor: "stub-host" }), // id 6
    ];
    expect(resolveCredentialState(resumeInjected, { approval_session_id: "aps-2", request_event_ref: 5 }, { recoveryWatermark: watermark })).toBe("available");
    expect(resolveCredentialState(resumeInjected, CRED, { recoveryWatermark: watermark })).toBe("indeterminate");
  });

  it("findExistingCredential:按 tool_call_id 定位既有凭据;无 request 或无 granted → null", () => {
    const events = seedApproval();
    expect(findExistingCredential(events, 1)).toEqual(CRED);
    expect(findExistingCredential(events, 2)).toBeNull(); // id 2 是 request 不是 call
    const onlyCall: SessionEvent[] = [seedApproval()[0] as SessionEvent];
    expect(findExistingCredential(onlyCall, 1)).toBeNull(); // 无审批链
  });
});
